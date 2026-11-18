import type { JsonValue } from "../core/json.ts";
import { AgentError, abortable, errorMessage } from "../core/errors.ts";
import { AgentMemory } from "../memory/agent-memory.ts";
import type { ActionStep, MemoryStep, PlanningStep } from "../memory/steps.ts";
import type { Model } from "../models/model.ts";
import { summarizeSteps } from "../monitoring/run-summary.ts";
import type { RunSummary } from "../monitoring/run-summary.ts";
import { planningPrompt } from "../prompts/templates.ts";
import { ToolRegistry } from "../tools/tool.ts";
import type { Tool } from "../tools/tool.ts";
import { finalAnswerTool } from "../tools/default-tools.ts";

export interface AgentOptions {
  model: Model;
  tools?: readonly Tool[];
  maxSteps?: number;
  planningInterval?: number;
  instructions?: string;
  finalAnswerChecks?: readonly ((answer: JsonValue, memory: AgentMemory) => boolean | Promise<boolean>)[];
}
export interface RunOptions { reset?: boolean; signal?: AbortSignal; timeoutMs?: number }
export interface RunResult {
  status: "success" | "max_steps";
  output: JsonValue;
  steps: readonly MemoryStep[];
  summary: RunSummary;
  durationMs: number;
}

/**
 * Agent 的共享调度层：管理记忆、可选规划、动作预算、步骤输出和退出清理。
 * ToolCallingAgent / CodeAgent 继承本类，只实现一轮“模型决策 → 执行 → 观察”的 act()。
 * 架构及两轮代码执行示例见 docs/ARCHITECTURE.md。
 */
export abstract class MultiStepAgent {
  readonly memory: AgentMemory;
  protected readonly model: Model;
  protected readonly tools: ToolRegistry;
  private readonly options: AgentOptions;
  private busy = false;

  constructor(options: AgentOptions, systemPrompt: string) {
    for (const [name, value] of [["maxSteps", options.maxSteps ?? 6], ["planningInterval", options.planningInterval ?? 1]] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`);
    }
    this.options = options;
    this.model = options.model;
    // 构造 Agent 时注册一次工具，并自动加入提交答案的工具；不是每轮重新注册。
    // protected 属性由子类继承，所以子类可以直接使用 this.tools / this.model。
    this.tools = new ToolRegistry([...(options.tools ?? []), finalAnswerTool]);
    this.memory = new AgentMemory(`${systemPrompt}\n${options.instructions ?? ""}`.trim());
  }

  // 子类修改传入的同一个 step 对象；候选答案通过校验后设置 output / isFinalAnswer。
  protected abstract act(step: ActionStep, signal: AbortSignal): Promise<void>;
  protected resetState(): void {}
  protected async cleanup(): Promise<void> {}
  protected async checkAnswer(answer: JsonValue, signal: AbortSignal): Promise<void> {
    for (const check of this.options.finalAnswerChecks ?? []) {
      if (!await abortable(async () => check(answer, this.memory), signal)) throw new AgentError("最终答案未通过校验，请修正后重新提交");
    }
  }

  /** run 消费 stream，因此两种入口共享预算、错误恢复和记忆语义。 */
  async run(task: string, options: RunOptions = {}): Promise<RunResult> {
    const iterator = this.stream(task, options);
    for (;;) {
      const next = await iterator.next();
      // done=false 时 value 是 yield 的 MemoryStep；done=true 时才是 return 的 RunResult。
      if (next.done) return next.value;
    }
  }

  async *stream(task: string, options: RunOptions = {}): AsyncGenerator<MemoryStep, RunResult> {
    if (this.busy) throw new AgentError("同一个 Agent 不能并发运行");
    if (!task.trim()) throw new TypeError("task 不能为空");
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw new RangeError("timeoutMs 必须是正整数");
    this.busy = true;
    const started = performance.now();
    const firstStep = options.reset === false ? this.memory.steps.length : 0;
    const lifecycle = new AbortController();
    const signals = [lifecycle.signal];
    if (options.signal) signals.push(options.signal);
    if (options.timeoutMs) signals.push(AbortSignal.timeout(options.timeoutMs));
    const signal = AbortSignal.any(signals);
    try {
      signal.throwIfAborted();
      // 默认开启新任务历史；reset:false 保留会话，CodeAgent 的 JSON state 也会保留。
      if (options.reset !== false) { this.memory.reset(); this.resetState(); }
      const taskStep = { kind: "task", task } as const;
      this.memory.append(taskStep);
      // stream 输出完整步骤，不是模型 token 流；yield 后等待调用方请求下一项。
      yield taskStep;
      for (let number = 1; number <= (this.options.maxSteps ?? 6); number++) {
        signal.throwIfAborted();
        // 不配置 planningInterval 就跳过规划；配置 N 时在第 1、1+N、1+2N…轮动作前规划。
        // 规划调用额外请求一次模型，但不单独占用 maxSteps 的动作轮数。
        if (this.options.planningInterval && (number - 1) % this.options.planningInterval === 0) {
          const plan = await this.plan(signal);
          this.memory.append(plan);
          yield structuredClone(plan);
        }
        const actionStarted = performance.now();
        const step: ActionStep = {
          kind: "action", stepNumber: number, messages: [], observations: [], isFinalAnswer: false,
          timing: { startedAt: Date.now(), durationMs: 0 },
        };
        // 模型/网络故障直接上抛；工具及代码错误由 act 写成模型可见的反馈。
        try { await this.act(step, signal); }
        finally {
          // act 抛错也记录这次尝试；若异常继续上抛，后面的 yield 和完成判断不会执行。
          step.timing.durationMs = performance.now() - actionStarted;
          this.memory.append(step);
        }
        yield structuredClone(step);
        // act 可能把初始 false 改为 true；输出 action 后，再单独输出 final 并返回汇总。
        if (step.isFinalAnswer) {
          const output = step.output!; // null 同样是合法最终答案，以标志区分是否结束。
          const finalStep = { kind: "final", output } as const;
          this.memory.append(finalStep);
          yield finalStep;
          return this.result("success", output, firstStep, started);
        }
      }
      // 与 Python 的兜底模型生成不同：预算耗尽不追加调用，也不把猜测标为成功。
      return this.result("max_steps", null, firstStep, started);
    } finally {
      // 正常完成、异常、取消或消费者提前关闭生成器，都进入同一清理入口。
      lifecycle.abort(new AgentError("运行已结束"));
      try { await this.cleanup(); }
      finally { this.busy = false; }
    }
  }

  protected feedback(step: ActionStep, error: unknown): string {
    const text = `Error: ${errorMessage(error)}. Correct the action and try again.`;
    step.error = errorMessage(error);
    step.observations.push(text);
    return text;
  }
  private result(status: RunResult["status"], output: JsonValue, offset: number, started: number): RunResult {
    // 续聊时 memory 包含旧步骤，但本次 RunResult 仅汇总本次运行新增的步骤。
    const steps = this.memory.steps.slice(offset);
    return { status, output, steps, summary: summarizeSteps(steps), durationMs: performance.now() - started };
  }
  private async plan(signal: AbortSignal): Promise<PlanningStep> {
    const started = performance.now();
    const startedAt = Date.now();
    // 读取现有任务与观察来更新计划；这里只生成文字，不在规划请求中执行工具。
    const response = await abortable(() => this.model.generate(
      [...this.memory.toMessages(), { role: "user", content: planningPrompt }], { signal },
    ), signal);
    return {
      kind: "planning", plan: response.message.content,
      messages: [{ role: "assistant", content: response.message.content }, { role: "user", content: "Proceed with the plan." }],
      timing: { startedAt, durationMs: performance.now() - started },
      ...(response.usage ? { usage: response.usage } : {}),
    };
  }
}
