import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CodeAgent,
  ScriptedModel,
  textReply,
  calculatorTool,
  QuickJSExecutor,
  ToolRegistry,
  defineTool,
} from "../src/index.ts";

const code = (source: string) => textReply(`\`\`\`javascript\n${source}\n\`\`\``);

test("代码 Agent 调用异步宿主工具，通过 state 跨步共享结果", async () => {
  const agent = new CodeAgent({
    tools: [calculatorTool],
    model: new ScriptedModel([
      code(
        'state.result = tools.calculate({operation:"multiply", a:6, b:7}); console.log(state.result);',
      ),
      code("final_answer(state.result);"),
    ]),
  });
  const result = await agent.run("计算");
  assert.equal(result.output, 42);
  assert.equal(result.status, "success");
  assert.equal(result.summary.errorCount, 0);
});

test("解析和代码执行错误进入下一轮观察", async () => {
  const result = await new CodeAgent({
    model: new ScriptedModel([
      textReply("没有代码块"),
      code("throw new Error('bad code');"),
      code("final_answer(null);"),
    ]),
  }).run("恢复");
  assert.equal(result.status, "success");
  assert.equal(result.output, null);
  assert.equal(result.summary.errorCount, 2);
});

test("QuickJS 不暴露 Node 全局对象", async () => {
  const result = await new QuickJSExecutor().execute(
    "final_answer([typeof process, typeof require, typeof fetch]);",
    new ToolRegistry([]),
    {},
    new AbortController().signal,
  );
  assert.deepEqual(result.output, ["undefined", "undefined", "undefined"]);
});

test("CPU 死循环被期限中断", async () => {
  await assert.rejects(
    new QuickJSExecutor({ timeoutMs: 50 }).execute(
      "while(true) {}",
      new ToolRegistry([]),
      {},
      new AbortController().signal,
    ),
  );
});

test("final_answer 后不继续调用工具", async () => {
  let called = false;
  const tool = defineTool({
    name: "touch",
    description: "测试",
    parameters: { type: "object", properties: {} },
    parse: () => null,
    execute: () => {
      called = true;
      return null;
    },
  });
  const result = await new QuickJSExecutor().execute(
    "try { final_answer(42); } catch {} try { tools.touch({}); } catch {}",
    new ToolRegistry([tool]),
    {},
    new AbortController().signal,
  );
  assert.equal(result.output, 42);
  assert.equal(called, false);
});

test("答案被拒绝后仍可修正并重新提交", async () => {
  const result = await new CodeAgent({
    model: new ScriptedModel([code("final_answer(0);"), code("final_answer(42);")]),
    finalAnswerChecks: [(answer) => answer === 42],
  }).run("检查答案");
  assert.equal(result.output, 42);
  assert.equal(result.summary.errorCount, 1);
});
