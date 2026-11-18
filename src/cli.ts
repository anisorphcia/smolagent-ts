#!/usr/bin/env node
import { ToolCallingAgent } from "./agents/tool-calling-agent.ts";
import { CodeAgent } from "./agents/code-agent.ts";
import { OpenAIModel } from "./models/openai-model.ts";
import { ScriptedModel, textReply, toolReply } from "./models/scripted-model.ts";
import { calculatorTool } from "./tools/default-tools.ts";
import { errorMessage } from "./core/errors.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log('用法：npm run cli -- [--demo] [--code] "任务"\n--demo 离线演示 6 × 7；--code 使用代码 Agent');
    return;
  }
  if (args.some((arg) => arg.startsWith("--") && arg !== "--demo" && arg !== "--code")) throw new Error("未知选项，使用 --help 查看用法");
  const code = args.includes("--code");
  const demo = args.includes("--demo");
  const task = demo ? "计算 6 × 7" : args.filter((arg) => !arg.startsWith("--")).join(" ");
  const model = demo ? new ScriptedModel(code ? [
    textReply('```javascript\nfinal_answer(tools.calculate({operation:"multiply", a:6, b:7}));\n```'),
  ] : [toolReply("calculate", { operation: "multiply", a: 6, b: 7 }), toolReply("final_answer", { answer: 42 })]) : new OpenAIModel({
    apiKey: process.env.MODEL_API_KEY ?? "", modelId: process.env.MODEL_ID ?? "",
    ...(process.env.MODEL_BASE_URL ? { baseUrl: process.env.MODEL_BASE_URL } : {}),
  });
  const agent = code ? new CodeAgent({ model, tools: [calculatorTool] }) : new ToolCallingAgent({ model, tools: [calculatorTool] });
  const result = await agent.run(task, { timeoutMs: 120_000 });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "success") process.exitCode = 1;
}
main().catch((error: unknown) => { console.error(errorMessage(error)); process.exitCode = 1; });
