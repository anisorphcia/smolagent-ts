import { ToolCallingAgent, OpenAIModel, calculatorTool } from "../src/index.ts";

const apiKey = process.env.MODEL_API_KEY;
const modelId = process.env.MODEL_ID;
if (!apiKey || !modelId)
  throw new Error("请在 .env 中设置 MODEL_API_KEY 和 MODEL_ID");
const model = new OpenAIModel({
  apiKey,
  modelId,
  ...(process.env.MODEL_BASE_URL
    ? { baseUrl: process.env.MODEL_BASE_URL }
    : {}),
});
const agent = new ToolCallingAgent({
  model,
  tools: [calculatorTool],
  maxSteps: 5,
});
console.log(await agent.run("用工具计算 (6 + 7) × 8", { timeoutMs: 120_000 }));
