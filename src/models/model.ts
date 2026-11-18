import type { JsonValue } from "../core/json.ts";
import type { ToolDefinition } from "../tools/tool.ts";

export interface ToolCall { id: string; name: string; arguments: JsonValue }
export interface TokenUsage { inputTokens: number; outputTokens: number }
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };
export interface ModelResponse {
  message: Extract<ChatMessage, { role: "assistant" }>;
  usage?: TokenUsage;
}
export interface GenerateOptions {
  signal: AbortSignal;
  tools?: readonly ToolDefinition[];
}
/** Agent 只依赖此接口；供应商的 HTTP 格式留在适配器内部。 */
export interface Model {
  generate(messages: readonly ChatMessage[], options: GenerateOptions): Promise<ModelResponse>;
}
