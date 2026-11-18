import type { JsonValue } from "../core/json.ts";
import type { ChatMessage, TokenUsage } from "../models/model.ts";
import type { ToolExecution } from "../tools/tool.ts";

export interface Timing {
  startedAt: number;
  durationMs: number;
}
export interface TaskStep {
  kind: "task";
  task: string;
}
export interface PlanningStep {
  kind: "planning";
  plan: string;
  messages: ChatMessage[];
  timing: Timing;
  usage?: TokenUsage;
}
export interface ActionStep {
  kind: "action";
  stepNumber: number;
  messages: ChatMessage[];
  timing: Timing;
  observations: string[];
  isFinalAnswer: boolean;
  code?: string;
  output?: JsonValue;
  error?: string;
  usage?: TokenUsage;
  toolExecutions?: ToolExecution[];
}
export interface FinalAnswerStep {
  kind: "final";
  output: JsonValue;
}
/** 可辨识联合替代 Python dataclass 继承，switch(kind) 即可缩窄类型。 */
export type MemoryStep = TaskStep | PlanningStep | ActionStep | FinalAnswerStep;
