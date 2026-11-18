import { assertJson, isRecord } from "../core/json.ts";
import type { JsonValue } from "../core/json.ts";
import { ToolError, errorMessage } from "../core/errors.ts";
import { validate } from "./schema.ts";
import type { Schema } from "./schema.ts";

export interface ToolContext {
  signal: AbortSignal;
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
  constructor(tools: readonly Tool[]) {
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
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError(`未知工具：${name}`);
    // 这是具体工具对象的 call 方法，不是再次递归调用 ToolRegistry.call。
    return tool.call(input, context);
  }
}
