import { assertJson, isRecord } from "../core/json.ts";
import { ModelError } from "../core/errors.ts";
import type { ChatMessage, GenerateOptions, Model, ModelResponse, ToolCall } from "./model.ts";

export interface OpenAIModelOptions {
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** 对应 Python OpenAIModel：只做协议转换，不决定 Agent 何时结束。 */
export class OpenAIModel implements Model {
  private readonly options: OpenAIModelOptions;
  constructor(options: OpenAIModelOptions) {
    if (!options.apiKey || !options.modelId) throw new TypeError("需要配置 modelId 和 apiKey");
    if (!Number.isSafeInteger(options.timeoutMs ?? 60_000) || (options.timeoutMs ?? 60_000) <= 0) {
      throw new RangeError("timeoutMs 必须是正整数");
    }
    this.options = options;
  }
  async generate(
    messages: readonly ChatMessage[],
    options: GenerateOptions,
  ): Promise<ModelResponse> {
    // 适配层只负责协议转换与 HTTP：输入统一消息，输出统一 ModelResponse。
    // Agent 总超时/取消与单次模型请求超时，任意一个触发都结束这次等待。
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    ]);
    const body: Record<string, unknown> = {
      model: this.options.modelId,
      messages: messages.map((message) => {
        if (message.role === "tool")
          return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
        if (message.role === "assistant" && message.toolCalls?.length)
          return {
            role: "assistant",
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          };
        return { role: message.role, content: message.content };
      }),
    };
    if (options.tools?.length) {
      body.tools = options.tools.map((tool) => ({ type: "function", function: tool }));
      body.tool_choice = "required";
    }
    // baseUrl 只含公共前缀（如 /api/v3），这里追加具体接口路径；密钥走 Bearer 请求头。
    const response = await (this.options.fetch ?? globalThis.fetch)(
      `${(this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    // 不把响应正文写入错误信息，避免服务端回显请求中的敏感内容。
    if (!response.ok) throw new ModelError(`模型请求失败：HTTP ${response.status}`);
    // 解析工具调用、参数和 usage，避免把供应商的原始响应结构传播到 Agent 循环。
    return parseResponse(await response.json());
  }
}

function parseResponse(data: unknown): ModelResponse {
  if (
    !isRecord(data) ||
    !Array.isArray(data.choices) ||
    !isRecord(data.choices[0]) ||
    !isRecord(data.choices[0].message)
  ) {
    throw new ModelError("模型返回了无效的 choices/message");
  }
  const message = data.choices[0].message;
  if (
    message.content !== null &&
    message.content !== undefined &&
    typeof message.content !== "string"
  ) {
    throw new ModelError("此适配器仅支持文本消息");
  }
  const toolCalls: ToolCall[] = [];
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw new ModelError("tool_calls 必须是数组");
    for (const call of message.tool_calls) {
      if (
        !isRecord(call) ||
        typeof call.id !== "string" ||
        !isRecord(call.function) ||
        typeof call.function.name !== "string"
      ) {
        throw new ModelError("无效的工具调用");
      }
      // 保留格式错误的原始字符串，让工具校验报错并写回观察，供下一步修正。
      let args: unknown = call.function.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          /* 交给工具校验 */
        }
      }
      assertJson(args);
      toolCalls.push({ id: call.id, name: call.function.name, arguments: args });
    }
  }
  const result: ModelResponse = {
    message: { role: "assistant", content: message.content ?? "", toolCalls },
  };
  if (
    isRecord(data.usage) &&
    typeof data.usage.prompt_tokens === "number" &&
    typeof data.usage.completion_tokens === "number"
  ) {
    result.usage = {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    };
  }
  return result;
}
