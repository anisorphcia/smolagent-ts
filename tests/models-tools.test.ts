import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAIModel,
  calculatorTool,
  ToolRegistry,
  finalAnswerTool,
  validate,
} from "../src/index.ts";

test("HTTP 适配器转换工具 schema、调用 id、参数和 usage", async () => {
  const model = new OpenAIModel({
    apiKey: "test",
    modelId: "test",
    baseUrl: "https://example.invalid/v1/",
    fetch: async (url, init) => {
      assert.equal(url, "https://example.invalid/v1/chat/completions");
      const body = JSON.parse(init!.body as string);
      assert.equal(body.messages[1].tool_call_id, "call1");
      assert.equal(body.tools[0].function.name, "calculate");
      assert.equal(body.tool_choice, "required");
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call2", function: { name: "final_answer", arguments: '{"answer":42}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
    },
  });
  const response = await model.generate(
    [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call1", name: "calculate", arguments: {} }],
      },
      { role: "tool", content: "42", toolCallId: "call1" },
    ],
    { signal: new AbortController().signal, tools: [calculatorTool] },
  );
  assert.deepEqual(response.message.toolCalls![0]!.arguments, { answer: 42 });
  assert.deepEqual(response.usage, { inputTokens: 5, outputTokens: 2 });
});

test("HTTP 错误和无效响应直接报错", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    new OpenAIModel({
      apiKey: "test",
      modelId: "test",
      fetch: async () => new Response("secret", { status: 429 }),
    }).generate([], { signal }),
    /HTTP 429/,
  );
  await assert.rejects(
    new OpenAIModel({
      apiKey: "test",
      modelId: "test",
      fetch: async () => Response.json({}),
    }).generate([], { signal }),
    /choices/,
  );
});

test("工具拒绝重复名称、额外参数、零除和非 JSON 答案", async () => {
  assert.throws(() => new ToolRegistry([finalAnswerTool, finalAnswerTool]), /重复/);
  const context = { signal: new AbortController().signal };
  await assert.rejects(
    calculatorTool.call({ operation: "add", a: 1, b: 2, extra: 3 }, context),
    /未知参数/,
  );
  await assert.rejects(calculatorTool.call({ operation: "divide", a: 1, b: 0 }, context), /除以零/);
  await assert.rejects(finalAnswerTool.call({ answer: Infinity }, context), /JSON/);
  assert.throws(() => validate({ type: "array", items: { type: "integer" } }, [1, 1.5]), /integer/);
});
