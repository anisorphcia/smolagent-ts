import { assertJson, isRecord } from "../core/json.ts";
import type { JsonValue } from "../core/json.ts";
import { abortable, ToolError, errorMessage } from "../core/errors.ts";
import { validate } from "./schema.ts";
import type { Schema } from "./schema.ts";

export interface ToolExecution {
  id: string;
  name: string;
  input: JsonValue;
  output?: JsonValue;
  error?: string;
  callId?: string;
  timing: { startedAt: number; durationMs: number };
}
export type ToolCallEvent =
  { type: "tool_start"; execution: ToolExecution } | { type: "tool_end"; execution: ToolExecution };
export type ToolEventObserver = (event: ToolCallEvent) => void | Promise<void>;
export interface ToolContext {
  signal: AbortSignal;
  onToolEvent?: ToolEventObserver;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Schema;
}
export interface Tool extends ToolDefinition {
  call(input: unknown, context: ToolContext): Promise<JsonValue>;
}

/** 对应 Python Tool + @tool；泛型保留工具内部的参数类型，运行时解析负责外部输入。 */
export function defineTool<Input>(
  options: ToolDefinition & {
    parse: (input: unknown) => Input;
    execute: (input: Input, context: ToolContext) => JsonValue | Promise<JsonValue>;
  },
): Tool {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.name))
    throw new TypeError("工具名称必须是合法标识符");
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    // ToolRegistry.call() 最终调用此方法，再进入创建工具时传入的 options.execute。
    async call(input, context) {
      context.signal.throwIfAborted();
      try {
        // 模型输入是 unknown，TypeScript 类型不能代替运行时校验。
        // 调用链：schema 校验 → parse 转换 → execute 业务逻辑 → JSON 输出校验。
        validate(options.parameters, input);
        const output = await options.execute(options.parse(input), context);
        context.signal.throwIfAborted();
        assertJson(output);
        return output;
      } catch (error) {
        context.signal.throwIfAborted();
        throw new ToolError(`${options.name}: ${errorMessage(error)}`, { cause: error });
      }
    },
  };
}

export function objectInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new TypeError("参数必须是对象");
  return input;
}

/** 按名称保存工具实现：definitions() 提供模型描述，call() 负责宿主侧分发。 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly beforeCall: (() => void) | undefined;
  constructor(tools: readonly Tool[], beforeCall?: () => void) {
    this.beforeCall = beforeCall;
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new ToolError(`重复的工具名称：${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }
  definitions(): ToolDefinition[] {
    // 去掉 call 方法，只把模型可理解的名称、说明和参数结构提供给模型。
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }
  async call(name: string, input: unknown, context: ToolContext): Promise<JsonValue> {
    context.signal.throwIfAborted();
    const started = performance.now();
    const execution: ToolExecution = {
      id: crypto.randomUUID(),
      name,
      input: traceValue(input),
      timing: { startedAt: Date.now(), durationMs: 0 },
    };
    const notify = (type: ToolCallEvent["type"]): void => {
      if (!context.onToolEvent) return;
      // 同步和异步观察器都只接收快照，报错不能改变已发生的业务执行结果。
      try {
        void Promise.resolve(
          context.onToolEvent({ type, execution: structuredClone(execution) }),
        ).catch(() => {});
      } catch {
        /* 观察器错误不进入模型的工具错误反馈。 */
      }
    };
    notify("tool_start");
    try {
      context.signal.throwIfAborted();
      // 执行约束可以拒绝调用，不能放到会吞掉异常的观察器中；必须在副作用前检查。
      this.beforeCall?.();
      const tool = this.tools.get(name);
      if (!tool) throw new ToolError(`未知工具：${name}`);
      const output = await abortable(() => tool.call(input, context), context.signal);
      context.signal.throwIfAborted();
      execution.output = traceValue(output);
      return output;
    } catch (error) {
      execution.error = errorMessage(error);
      throw error;
    } finally {
      execution.timing.durationMs = performance.now() - started;
      notify("tool_end");
    }
  }
}

function traceValue(value: unknown): JsonValue {
  try {
    assertJson(value);
    return structuredClone(value);
  } catch {
    return "[non-JSON value]";
  } // 轨迹采集失败不改变工具本身的输入/输出行为。
}
