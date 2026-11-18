import { abortable } from "../core/errors.ts";
import { jsonText } from "../core/json.ts";
import type { ActionStep } from "../memory/steps.ts";
import { toolCallingPrompt } from "../prompts/templates.ts";
import { MultiStepAgent } from "./multi-step-agent.ts";
import type { AgentOptions } from "./multi-step-agent.ts";

/** 一轮动作：LLM 返回结构化 toolCalls → 注册表执行 → 按调用 ID 回传工具结果。 */
export class ToolCallingAgent extends MultiStepAgent {
  constructor(options: AgentOptions) {
    super(options, toolCallingPrompt);
  }
  protected async act(step: ActionStep, signal: AbortSignal): Promise<void> {
    // 模型只接收工具描述和参数 schema，不会直接访问工具实现或执行工具。
    const response = await abortable(
      () =>
        this.model.generate(this.memory.toMessages(), {
          signal,
          tools: this.tools.definitions(),
        }),
      signal,
    );
    step.messages.push(response.message);
    if (response.usage) step.usage = response.usage;
    const calls = response.message.toolCalls ?? [];
    if (calls.length === 0) {
      // 普通文字不代表任务完成；反馈给模型，要求通过 final_answer 显式提交。
      step.messages.push({
        role: "user",
        content: this.feedback(step, new Error("必须调用工具，最终答案请使用 final_answer")),
      });
      return;
    }
    // 按序执行。最终答案必须单独提交，避免一个批次中后续调用继续产生副作用。
    const invalidFinalBatch =
      calls.length > 1 && calls.some((call) => call.name === "final_answer");
    for (const call of calls) {
      let content: string;
      try {
        if (invalidFinalBatch) throw new Error("final_answer 必须单独调用，请先完成其他工具调用");
        const output = await abortable(
          () => this.tools.call(call.name, call.arguments, { signal }),
          signal,
        );
        if (call.name === "final_answer") {
          // 先验收，再修改共享 step；外层 stream() 会读取此标志并退出循环。
          await this.checkAnswer(output, signal);
          step.output = output;
          step.isFinalAnswer = true;
        }
        content = jsonText(output);
        step.observations.push(content);
      } catch (error) {
        // 工具错误仍回传给模型；取消不能作为普通工具错误吞掉。
        signal.throwIfAborted();
        content = this.feedback(step, error);
      }
      // 每个调用都回传对应 id，兼容 Chat Completions 的消息配对要求。
      step.messages.push({ role: "tool", toolCallId: call.id, content });
    }
  }
}
