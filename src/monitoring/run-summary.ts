import type { TokenUsage } from "../models/model.ts";
import type { MemoryStep } from "../memory/steps.ts";

export interface RunSummary { actionCount: number; planningCount: number; errorCount: number; usage: TokenUsage | null }
export function summarizeSteps(steps: readonly MemoryStep[]): RunSummary {
  const calls = steps.filter((step) => step.kind === "action" || step.kind === "planning");
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let complete = true;
  for (const step of calls) {
    if (!step.usage) { complete = false; continue; }
    usage.inputTokens += step.usage.inputTokens;
    usage.outputTokens += step.usage.outputTokens;
  }
  return {
    actionCount: steps.filter((step) => step.kind === "action").length,
    planningCount: steps.filter((step) => step.kind === "planning").length,
    errorCount: steps.filter((step) => step.kind === "action" && step.error !== undefined).length,
    usage: complete ? usage : null,
  };
}
