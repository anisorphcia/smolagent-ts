import type { JsonObject, JsonValue } from "../core/json.ts";
import type { ToolRegistry, ToolEventObserver } from "../tools/tool.ts";

export interface ExecutionResult {
  logs: string[];
  state: JsonObject;
  isFinalAnswer: boolean;
  output: JsonValue;
}
export interface CodeExecutor {
  execute(
    code: string,
    tools: ToolRegistry,
    state: JsonObject,
    signal: AbortSignal,
    onToolEvent?: ToolEventObserver,
  ): Promise<ExecutionResult>;
}
