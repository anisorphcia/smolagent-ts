import { CodeAgent, OpenAIModel } from "../src/index.ts";

const apiKey = process.env.MODEL_API_KEY;
const modelId = process.env.MODEL_ID;
if (!apiKey || !modelId) throw new Error("请在 .env 中设置 MODEL_API_KEY 和 MODEL_ID");
const model = new OpenAIModel({
  apiKey,
  modelId,
  ...(process.env.MODEL_BASE_URL ? { baseUrl: process.env.MODEL_BASE_URL } : {}),
});

const agent = new CodeAgent({
  model,
});
const result = await agent.run("计算 (6 + 7) × 8，保存结果，再在下一步提交答案");
console.log("result", result);
