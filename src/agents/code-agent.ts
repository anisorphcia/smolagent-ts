import { abortable } from "../core/errors.ts";
import { jsonText } from "../core/json.ts";
import type { JsonObject } from "../core/json.ts";
import type { CodeExecutor } from "../executors/code-executor.ts";
import { QuickJSExecutor } from "../executors/quickjs-executor.ts";
import type { ActionStep } from "../memory/steps.ts";
import { codePrompt } from "../prompts/templates.ts";
import { MultiStepAgent } from "./multi-step-agent.ts";
import type { AgentOptions } from "./multi-step-agent.ts";

export interface CodeAgentOptions extends AgentOptions { executor?: CodeExecutor }
/** 一轮动作：LLM 生成 JavaScript → 提取代码 → 执行器运行 → 写入日志或错误反馈。 */
export class CodeAgent extends MultiStepAgent {
  // 给执行代码跨轮保存 JSON 值；memory 保存模型可见的执行历史，两者职责不同。
  private state: JsonObject = {};
  private readonly executor: CodeExecutor;
  constructor(options: CodeAgentOptions) {
    // 系统提示词约定“一轮一个 javascript 围栏代码块”、state 和 final_answer 的用法。
    super(options, codePrompt(options.tools ?? []));
    this.executor = options.executor ?? new QuickJSExecutor();
  }
  protected override resetState(): void { this.state = {}; }
  protected async act(step: ActionStep, signal: AbortSignal): Promise<void> {
    // 每轮都重新请求模型；模型/网络错误放在 try 外，让调用方直接收到错误。
    const response = await abortable(() => this.model.generate(this.memory.toMessages(), { signal }), signal);
    step.messages.push(response.message);
    if (response.usage) step.usage = response.usage;
    try {
      // LLM 返回字符串；matchAll 在本地解析它，展开迭代器得到“所有代码块的匹配数组”。
      // (?:javascript|js) 不捕获；([\s\S]*?) 是第一个捕获组，内容是围栏内的纯代码。
      const blocks = [...response.message.content.matchAll(/```(?:javascript|js)\s*\n([\s\S]*?)```/g)];
      if (blocks.length !== 1) throw new Error("每步必须提供一个 javascript 代码块");
      // blocks[0] 是唯一匹配；[0][0] 含围栏，[0][1] 才是交给执行器的代码。
      // ! 只对 TypeScript 做非空断言，不提供运行时校验；上面已经检查了匹配数量。
      const code = blocks[0]![1]!;
      step.code = code;
      const result = await this.executor.execute(code, this.tools, this.state, signal);
      // 成功执行后接回 state；下一轮的新解释器从这里恢复，局部变量不会跨轮保留。
      this.state = result.state;
      step.observations.push(...result.logs);
      if (result.isFinalAnswer) {
        // 执行器捕获了 final_answer(value)；通过 Agent 的答案校验后才通知外层循环结束。
        await this.checkAnswer(result.output, signal);
        step.output = result.output;
        step.isFinalAnswer = true;
      }
      // 这些消息随 ActionStep 进入 memory，下一轮模型才能读到执行观察。
      step.messages.push({ role: "user", content: `Execution observation:\n${result.logs.join("\n")}\n${result.isFinalAnswer ? `Final answer: ${jsonText(result.output)}` : "Action complete. Submit final_answer when ready."}` });
    } catch (error) {
      // 普通解析/执行/答案校验错误转成反馈，允许下一轮修正；取消则继续上抛。
      signal.throwIfAborted();
      step.messages.push({ role: "user", content: this.feedback(step, error) });
    }
  }
}
