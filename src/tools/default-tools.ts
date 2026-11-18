import type { JsonValue } from "../core/json.ts";
import { assertJson } from "../core/json.ts";
import { defineTool, objectInput } from "./tool.ts";

export const finalAnswerTool = defineTool({
  name: "final_answer",
  description: "提交最终答案，结束任务。",
  parameters: { type: "object", properties: { answer: {} }, required: ["answer"] },
  parse(input): JsonValue {
    const { answer } = objectInput(input);
    assertJson(answer);
    return answer;
  },
  execute: (answer) => answer,
});

/** 不对模型生成的算式使用 eval；用明确的运算和两个操作数表达计算。 */
export const calculatorTool = defineTool({
  name: "calculate",
  description: "计算两个有限数字，支持 add/subtract/multiply/divide。",
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["operation", "a", "b"],
  },
  parse(input) {
    const args = objectInput(input);
    return { operation: args.operation as string, a: args.a as number, b: args.b as number };
  },
  execute({ operation, a, b }) {
    switch (operation) {
      case "add":
        return a + b;
      case "subtract":
        return a - b;
      case "multiply":
        return a * b;
      case "divide":
        if (b !== 0) return a / b;
        throw new Error("不能除以零");
      default:
        throw new Error("未知运算");
    }
  },
});
