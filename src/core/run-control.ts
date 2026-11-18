import { BudgetExceededError, ModelError } from "./errors.ts";
import type { StopReason } from "./errors.ts";
import type { TokenUsage } from "../models/model.ts";
import type { ActionStep } from "../memory/steps.ts";

export interface RunLimits {
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxRepeatedErrors?: number;
}
export interface BudgetUsage {
  modelCalls: number;
  toolCalls: number;
  tokens: number | null;
}

export function validateRunLimits(limits: RunLimits): void {
  for (const key of ["maxModelCalls", "maxToolCalls", "maxTokens", "maxRepeatedErrors"] as const) {
    const value = limits[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new RangeError(`${key} 必须是正整数`);
  }
}

/** 一次运行的共享控制器：规划和动作共用计数，停止原因一旦确定就不能被代码捕获后清除。 */
export class RunControl {
  private readonly limits: Required<RunLimits>;
  private modelCalls = 0;
  private toolCalls = 0;
  private tokens = 0;
  private usageComplete = true;
  private stopped: StopReason | undefined;
  private lastFailure = "";
  private repeats = 0;

  constructor(limits: RunLimits) {
    validateRunLimits(limits);
    this.limits = {
      maxModelCalls: limits.maxModelCalls ?? Infinity,
      maxToolCalls: limits.maxToolCalls ?? Infinity,
      maxTokens: limits.maxTokens ?? Infinity,
      maxRepeatedErrors: limits.maxRepeatedErrors ?? Infinity,
    };
  }
  private fail(reason: StopReason): never {
    this.stopped ??= reason;
    throw new BudgetExceededError(this.stopped);
  }
  check(): void {
    if (this.stopped) throw new BudgetExceededError(this.stopped);
  }
  checkModelBudget(): void {
    this.check();
    if (this.modelCalls >= this.limits.maxModelCalls) this.fail("max_model_calls");
    if (this.tokens >= this.limits.maxTokens) this.fail("max_tokens");
  }
  beforeModel(): number {
    this.checkModelBudget();
    return ++this.modelCalls;
  }
  beforeTool(): void {
    this.check();
    if (this.toolCalls >= this.limits.maxToolCalls) this.fail("max_tool_calls");
    this.toolCalls++;
  }
  recordUsage(usage?: TokenUsage): void {
    if (!usage) {
      this.usageComplete = false;
      if (Number.isFinite(this.limits.maxTokens)) this.stopped ??= "token_usage_unavailable";
      return;
    }
    const total = this.tokens + usage.inputTokens + usage.outputTokens;
    if (
      ![usage.inputTokens, usage.outputTokens, total].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    ) {
      throw new ModelError("模型返回了无效的 token usage");
    }
    this.tokens = total;
    // 先记下停止原因，允许调用方保存本次模型回复和 usage，再阻止执行后续动作。
    if (this.tokens > this.limits.maxTokens) this.stopped ??= "max_tokens";
  }
  recordModelFailure(): void {
    this.usageComplete = false;
  }
  recordAction(step: ActionStep): void {
    if (!Number.isFinite(this.limits.maxRepeatedErrors)) return;
    if (step.error === undefined) {
      this.lastFailure = "";
      this.repeats = 0;
      return;
    }
    const failure = JSON.stringify(
      canonical({
        error: step.error,
        code: step.code ?? null,
        observations: step.observations,
        calls:
          step.toolExecutions?.map((call) => ({
            name: call.name,
            input: call.input,
            output: call.output ?? null,
            error: call.error ?? null,
          })) ?? [],
      }),
    );
    this.repeats = failure === this.lastFailure ? this.repeats + 1 : 1;
    this.lastFailure = failure;
    if (this.repeats >= this.limits.maxRepeatedErrors) this.fail("repeated_error");
  }
  snapshot(): BudgetUsage {
    return {
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      tokens: this.usageComplete ? this.tokens : null,
    };
  }
}

// 排除调用 ID/耗时等不稳定字段，并将对象键排序，避免仅参数键顺序变化就绕过重复检测。
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
