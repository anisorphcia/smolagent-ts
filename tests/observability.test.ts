import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CodeAgent,
  ScriptedModel,
  ToolCallingAgent,
  ToolRegistry,
  calculatorTool,
  defineTool,
  textReply,
  toolReply,
} from "../src/index.ts";
import type { AgentEvent, ToolCallEvent } from "../src/index.ts";

const code = (source: string) => textReply(`\`\`\`javascript\n${source}\n\`\`\``);

test("代码执行失败后仍保留已经完成的工具调用轨迹", async () => {
  const agent = new CodeAgent({
    tools: [calculatorTool],
    model: new ScriptedModel([
      code('tools.calculate({operation:"add",a:6,b:7}); throw new Error("after tool");'),
      code("final_answer(104);"),
    ]),
  });
  const result = await agent.run("task");
  assert.equal(result.status, "success");
  const step = result.steps[1];
  assert.equal(step?.kind, "action");
  if (step?.kind === "action") {
    assert.equal(step.toolExecutions?.length, 1);
    const execution = step.toolExecutions![0]!;
    assert.equal(execution.name, "calculate");
    assert.deepEqual(execution.input, { operation: "add", a: 6, b: 7 });
    assert.equal(execution.output, 13);
    assert.ok(execution.timing.durationMs >= 0);
    assert.match(step.error!, /after tool/);
  }
});

test("工具调用 Agent 记录未知工具、参数错误和成功提交的对应调用 ID", async () => {
  const replies = [
    toolReply("missing", {}),
    toolReply("calculate", { operation: "add", a: "bad", b: 7 }),
    toolReply("final_answer", { answer: 104 }),
  ];
  const agent = new ToolCallingAgent({
    tools: [calculatorTool],
    model: new ScriptedModel(replies),
  });
  const result = await agent.run("task");
  const actions = result.steps.filter((step) => step.kind === "action");
  for (const [index, action] of actions.entries()) {
    const execution = action.toolExecutions![0]!;
    assert.equal(execution.callId, replies[index]!.message.toolCalls![0]!.id);
    assert.ok(execution.id);
    if (index < 2) assert.ok(execution.error);
    else assert.equal(execution.output, 104);
  }
});

test("模型与工具进度按执行顺序发出，观察器收到独立快照", async () => {
  const events: AgentEvent[] = [];
  const agent = new ToolCallingAgent({
    planningInterval: 1,
    model: new ScriptedModel([
      textReply("plan"),
      toolReply("final_answer", { answer: { value: 104 } }),
    ]),
  });
  const result = await agent.run("task", {
    onEvent: (event) => {
      events.push(event);
      if (event.type === "tool_end") event.execution.output = 0;
    },
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ["model_start", "model_end", "model_start", "model_end", "tool_start", "tool_end"],
  );
  assert.equal(events[0]?.type, "model_start");
  if (events[0]?.type === "model_start") assert.equal(events[0].phase, "planning");
  if (events[2]?.type === "model_start") assert.equal(events[2].phase, "action");
  assert.deepEqual(result.output, { value: 104 });
  const step = result.steps.find((step) => step.kind === "action");
  if (step?.kind === "action") assert.deepEqual(step.toolExecutions![0]!.output, { value: 104 });
  const starts = events.filter((event) => event.type === "tool_start");
  const ends = events.filter((event) => event.type === "tool_end");
  assert.equal(starts[0]!.execution.id, ends[0]!.execution.id);
});

test("观察器同步抛错和异步拒绝都不改变工具执行，也不重复副作用", async () => {
  let calls = 0;
  const tool = defineTool({
    name: "touch",
    description: "counter",
    parameters: { type: "object", properties: {} },
    parse: () => null,
    execute: () => ++calls,
  });
  const events: ToolCallEvent[] = [];
  const output = await new ToolRegistry([tool]).call(
    "touch",
    {},
    {
      signal: new AbortController().signal,
      onToolEvent: (event) => {
        events.push(event);
        if (event.type === "tool_start") throw new Error("observer threw");
        return Promise.reject(new Error("observer rejected"));
      },
    },
  );
  assert.equal(output, 1);
  assert.equal(calls, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool_start", "tool_end"],
  );
  const agent = new ToolCallingAgent({
    model: new ScriptedModel([toolReply("final_answer", { answer: 42 })]),
  });
  assert.equal(
    (
      await agent.run("task", {
        onEvent: async () => {
          throw new Error("observer rejected");
        },
      })
    ).output,
    42,
  );
});

test("模型失败会发出结束事件，后续运行不复用上一次观察器", async () => {
  const events: AgentEvent[] = [];
  const agent = new ToolCallingAgent({
    model: new ScriptedModel([
      () => {
        throw new Error("model failed");
      },
      toolReply("final_answer", { answer: 42 }),
    ]),
  });
  await assert.rejects(
    agent.run("first", {
      onEvent: (event) => {
        events.push(event);
      },
    }),
    /model failed/,
  );
  assert.equal(events[1]?.type, "model_end");
  if (events[1]?.type === "model_end") assert.equal(events[1].succeeded, false);
  const count = events.length;
  assert.equal((await agent.run("second")).output, 42);
  assert.equal(events.length, count);
});

test("取消正在等待的工具会记录失败轨迹，观察器不能改变原始参数", async () => {
  let inputSeen: unknown;
  const controller = new AbortController();
  const reason = new Error("cancel tool");
  const tool = defineTool({
    name: "wait",
    description: "wait",
    parameters: { type: "object", properties: { value: { type: "number" } } },
    parse: (input) => input,
    execute(input) {
      inputSeen = input;
      controller.abort(reason);
      return new Promise<null>(() => {});
    },
  });
  const events: ToolCallEvent[] = [];
  await assert.rejects(
    new ToolRegistry([tool]).call(
      "wait",
      { value: 104 },
      {
        signal: controller.signal,
        onToolEvent: (event) => {
          events.push(event);
          if (event.type === "tool_start") (event.execution.input as { value: number }).value = 0;
        },
      },
    ),
    (error) => error === reason,
  );
  assert.deepEqual(inputSeen, { value: 104 });
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool_start", "tool_end"],
  );
  assert.match(events[1]!.execution.error!, /cancel tool/);
});
