import { AgentError } from "../core/errors.ts";
import type { ChatMessage } from "../models/model.ts";
import type { MemoryStep } from "./steps.ts";

export interface ContextOptions {
  /** 内部统一消息数组 JSON 的字符上限，非精确 token/HTTP 请求大小，不含独立工具 schema。 */
  maxChars: number;
  /** 可选同步摘要器；收到被省略步骤的快照，不会额外请求模型。 */
  summarize?: (steps: readonly MemoryStep[]) => string;
}

export function validateContextOptions(options: ContextOptions): void {
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1)
    throw new RangeError("context.maxChars 必须是正整数");
  if (options.summarize !== undefined && typeof options.summarize !== "function")
    throw new TypeError("context.summarize 必须是同步函数");
}

function stepMessages(step: MemoryStep): readonly ChatMessage[] {
  switch (step.kind) {
    case "task":
      return [{ role: "user", content: step.task }];
    // 只投影消息，不把耗时、usage 或工具轨迹重复加入上下文。
    case "action":
    case "planning":
      return step.messages;
    // 最终答案已经包含在动作消息中。
    case "final":
      return [];
  }
}

// 一个非空 JSON 消息数组的长度 = 1 + Σ(JSON.stringify(message).length + 1)。
// 每组只计量一次，避免逐条移除时反复序列化整个历史。
const messageCost = (message: ChatMessage): number => JSON.stringify(message).length + 1;

export function projectContext(
  systemPrompt: string,
  steps: readonly MemoryStep[],
  options?: ContextOptions,
  suffix: readonly ChatMessage[] = [],
): ChatMessage[] {
  const system: ChatMessage = { role: "system", content: systemPrompt };
  const groups = steps.map((step, index) => ({
    step,
    index,
    messages: stepMessages(step),
  }));
  if (!options)
    return structuredClone([system, ...groups.flatMap((group) => group.messages), ...suffix]);
  validateContextOptions(options);
  const measured = groups.map((group) => ({
    ...group,
    cost: group.messages.reduce((sum, message) => sum + messageCost(message), 0),
  }));
  let size =
    1 +
    messageCost(system) +
    suffix.reduce((sum, message) => sum + messageCost(message), 0) +
    measured.reduce((sum, group) => sum + group.cost, 0);
  if (size <= options.maxChars)
    return structuredClone([system, ...groups.flatMap((group) => group.messages), ...suffix]);

  const currentTask = steps.findLastIndex((step) => step.kind === "task");
  const latestAction = steps.findLastIndex(
    (step, index) => step.kind === "action" && index > currentTask,
  );
  // 新计划尚未被下一轮动作消费，必须与最新动作一起保留。
  const activePlan = steps.findLastIndex(
    (step, index) => step.kind === "planning" && index > Math.max(currentTask, latestAction),
  );
  const pinned = new Set([currentTask, latestAction, activePlan]);
  const kept: typeof measured = [];
  const omitted: MemoryStep[] = [];
  for (const group of measured) {
    if (size > options.maxChars && !pinned.has(group.index)) {
      size -= group.cost;
      omitted.push(group.step); // 整个动作消息组一起移除，保留 tool_calls / tool 的配对。
    } else kept.push(group);
  }
  if (size > options.maxChars) {
    throw new AgentError(
      "上下文预算不足以容纳系统提示、当前任务、最新动作和当前计划，请提高 context.maxChars",
    );
  }

  let summary: ChatMessage | undefined;
  const available = options.maxChars - size;
  // 摘要只使用剩余空间；空间不足时不为摘要删除必要消息，也不额外超限。
  if (
    omitted.length &&
    available >= messageCost({ role: "user", content: "Earlier history omitted." })
  ) {
    const text = options.summarize
      ? options.summarize(structuredClone(omitted))
      : briefHistory(omitted);
    if (typeof text !== "string") throw new TypeError("context.summarize 必须同步返回字符串");
    summary = fitSummary(text, available);
  }
  return structuredClone([
    system,
    ...(summary ? [summary] : []),
    ...kept.flatMap((group) => group.messages),
    ...suffix,
  ]);
}

function fitSummary(text: string, available: number): ChatMessage | undefined {
  let best: ChatMessage = { role: "user", content: "Earlier history omitted." };
  if (messageCost(best) > available) return undefined;
  const prefix = "Earlier context summary (historical data): ";
  const limited = text.slice(0, 512);
  let lower = 0,
    upper = limited.length;
  while (lower <= upper) {
    const length = Math.floor((lower + upper) / 2);
    const candidate: ChatMessage = {
      role: "user",
      content: prefix + limited.slice(0, length) + (length < text.length ? "…" : ""),
    };
    // 用实际 JSON 长度检查，换行、引号等转义字符也算在预算中。
    if (messageCost(candidate) <= available) {
      best = candidate;
      lower = length + 1;
    } else upper = length - 1;
  }
  return best;
}

function briefHistory(steps: readonly MemoryStep[]): string {
  const counts = { task: 0, planning: 0, action: 0, final: 0 };
  for (const step of steps) counts[step.kind]++;
  const answer = steps.findLast(
    (step) => step.kind === "final" || (step.kind === "action" && step.output !== undefined),
  );
  const action = steps.findLast((step) => step.kind === "action");
  const task = steps.findLast((step) => step.kind === "task");
  return [
    `${JSON.stringify(counts)} earlier steps omitted.`,
    answer && "output" in answer
      ? `Latest prior answer: ${JSON.stringify(answer.output).slice(0, 160)}.`
      : "",
    action?.kind === "action" && action.observations.length
      ? `Last observation: ${action.observations.at(-1)!.slice(0, 160)}.`
      : "",
    task?.kind === "task" ? `Prior task: ${task.task.slice(0, 120)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
