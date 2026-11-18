import type { ChatMessage, GenerateOptions, Model, ModelResponse } from "./model.ts";

export type Script =
  | ModelResponse
  | ((
      messages: readonly ChatMessage[],
      options: GenerateOptions,
    ) => ModelResponse | Promise<ModelResponse>);
/** 无网络的确定性模型，用于学习执行过程和验证错误恢复。 */
export class ScriptedModel implements Model {
  private cursor = 0;
  readonly requests: ChatMessage[][] = [];
  private readonly script: readonly Script[];
  constructor(script: readonly Script[]) {
    this.script = script;
  }
  async generate(
    messages: readonly ChatMessage[],
    options: GenerateOptions,
  ): Promise<ModelResponse> {
    options.signal.throwIfAborted();
    this.requests.push(structuredClone([...messages]));
    const item = this.script[this.cursor++];
    if (!item) throw new Error("ScriptedModel 的预设回复已用完");
    return structuredClone(typeof item === "function" ? await item(messages, options) : item);
  }
}

export const toolReply = (
  name: string,
  args: import("../core/json.ts").JsonValue,
  id = crypto.randomUUID(),
): ModelResponse => ({
  message: { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] },
});
export const textReply = (content: string): ModelResponse => ({
  message: { role: "assistant", content },
});
