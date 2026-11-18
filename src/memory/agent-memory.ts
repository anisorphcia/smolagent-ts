import type { ChatMessage } from "../models/model.ts";
import type { MemoryStep } from "./steps.ts";
import { projectContext } from "./context-window.ts";
import type { ContextOptions } from "./context-window.ts";

/** 步骤是唯一事实来源；模型上下文从步骤投影，避免维护两套状态。 */
export class AgentMemory {
  readonly systemPrompt: string;
  private entries: MemoryStep[] = [];
  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }
  // 读写都复制快照，防止调用方或后续动作改动已经保存的历史。
  get steps(): readonly MemoryStep[] {
    return structuredClone(this.entries);
  }
  append(step: MemoryStep): void {
    this.entries.push(structuredClone(step));
  }
  reset(): void {
    this.entries = [];
  }
  // 将步骤历史转成 LLM 消息；模型不会自动读取 entries，也不会直接读取 CodeAgent.state。
  toMessages(options?: ContextOptions, suffix: readonly ChatMessage[] = []): ChatMessage[] {
    // 只裁剪投影，entries 保留完整事实；规划附加消息也包含在同一预算内。
    return projectContext(this.systemPrompt, this.entries, options, suffix);
  }
  toJSON(): string {
    return JSON.stringify(
      { version: 1, systemPrompt: this.systemPrompt, steps: this.entries },
      null,
      2,
    );
  }
}
