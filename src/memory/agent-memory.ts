import type { ChatMessage } from "../models/model.ts";
import type { MemoryStep } from "./steps.ts";

/** 步骤是唯一事实来源；模型上下文从步骤投影，避免维护两套状态。 */
export class AgentMemory {
  readonly systemPrompt: string;
  private entries: MemoryStep[] = [];
  constructor(systemPrompt: string) { this.systemPrompt = systemPrompt; }
  // 读写都复制快照，防止调用方或后续动作改动已经保存的历史。
  get steps(): readonly MemoryStep[] { return structuredClone(this.entries); }
  append(step: MemoryStep): void { this.entries.push(structuredClone(step)); }
  reset(): void { this.entries = []; }
  // 将步骤历史转成 LLM 消息；模型不会自动读取 entries，也不会直接读取 CodeAgent.state。
  toMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: "system", content: this.systemPrompt }];
    for (const step of this.entries) {
      switch (step.kind) {
        case "task": messages.push({ role: "user", content: step.task }); break;
        // 只取步骤中的 messages；耗时、usage 等监控字段不直接加入模型上下文。
        case "action": case "planning": messages.push(...structuredClone(step.messages)); break;
        // 最终答案已包含在动作消息中，不重复加入上下文。
        case "final": break;
      }
    }
    return messages;
  }
  toJSON(): string { return JSON.stringify({ version: 1, systemPrompt: this.systemPrompt, steps: this.entries }, null, 2); }
}
