import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentMemory,
  CodeAgent,
  ScriptedModel,
  ToolCallingAgent,
  calculatorTool,
  textReply,
  toolReply,
} from "../src/index.ts";
import type { ActionStep, ChatMessage } from "../src/index.ts";

function addAction(memory: AgentMemory, number: number, content: string): void {
  const calls = [1, 2].map((index) => ({
    id: `call-${number}-${index}`,
    name: "calculate",
    arguments: { a: number },
  }));
  const step: ActionStep = {
    kind: "action",
    stepNumber: number,
    observations: [content],
    isFinalAnswer: false,
    timing: { startedAt: 0, durationMs: 0 },
    messages: [
      { role: "assistant", content: "", toolCalls: calls },
      ...calls.map((call) => ({ role: "tool" as const, toolCallId: call.id, content })),
    ],
  };
  memory.append(step);
}

function paired(messages: readonly ChatMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? []) pending.add(call.id);
    if (message.role === "tool") {
      assert.ok(pending.has(message.toolCallId));
      pending.delete(message.toolCallId);
    }
  }
  assert.equal(pending.size, 0);
}

test("上下文限额裁剪旧动作，保留完整工具消息组和必要上下文", () => {
  const memory = new AgentMemory("system");
  memory.append({ kind: "task", task: "current task" });
  for (let number = 1; number <= 4; number++)
    addAction(memory, number, "old observation ".repeat(100));
  addAction(memory, 5, "latest observation");
  memory.append({
    kind: "planning",
    plan: "active plan",
    messages: [{ role: "assistant", content: "active plan" }],
    timing: { startedAt: 0, durationMs: 0 },
  });
  const original = memory.toJSON();
  const messages = memory.toMessages({ maxChars: 1200 });
  assert.ok(JSON.stringify(messages).length <= 1200);
  assert.equal(messages[0]?.content, "system");
  assert.ok(messages.some((message) => message.content === "current task"));
  assert.ok(messages.some((message) => message.content === "latest observation"));
  assert.ok(messages.some((message) => message.content === "active plan"));
  assert.ok(messages.some((message) => message.content.startsWith("Earlier context summary")));
  paired(messages);
  assert.equal(memory.toJSON(), original);
});

test("不配置限额时保持原上下文；空间足够时不调用摘要器", () => {
  const memory = new AgentMemory("system");
  memory.append({ kind: "task", task: "task" });
  addAction(memory, 1, "observation");
  const full = memory.toMessages();
  const messages = memory.toMessages({
    maxChars: JSON.stringify(full).length,
    summarize: () => {
      throw new Error("should not summarize");
    },
  });
  assert.deepEqual(messages, full);
  const call = messages.find((message) => message.role === "assistant");
  if (call?.role === "assistant") call.toolCalls![0]!.arguments = null;
  assert.deepEqual(memory.toMessages(), full);
});

test("续聊时旧任务的最新动作可裁剪，不占用当前任务必要上下文", () => {
  const memory = new AgentMemory("system");
  memory.append({ kind: "task", task: "old task" });
  addAction(memory, 1, "old data ".repeat(1000));
  memory.append({ kind: "task", task: "new task" });
  const messages = memory.toMessages({ maxChars: 500 });
  assert.ok(JSON.stringify(messages).length <= 500);
  assert.ok(messages.some((message) => message.content === "new task"));
  paired(messages);
  assert.equal(memory.steps.length, 3);
});

test("只有必要消息能放下时允许省略摘要，不因摘要额外超限", () => {
  const memory = new AgentMemory("system");
  memory.append({ kind: "task", task: "old task ".repeat(100) });
  addAction(memory, 1, "old data ".repeat(100));
  memory.append({ kind: "task", task: "new task" });
  const expected: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "new task" },
  ];
  assert.deepEqual(memory.toMessages({ maxChars: JSON.stringify(expected).length }), expected);
});

test("内置简要记录保留合法的 null、false 和零答案", () => {
  for (const output of [null, false, 0]) {
    const memory = new AgentMemory("system");
    memory.append({ kind: "task", task: "old task" });
    memory.append({
      kind: "action",
      stepNumber: 1,
      messages: [{ role: "assistant", content: "old text ".repeat(1000) }],
      observations: [],
      isFinalAnswer: true,
      output,
      timing: { startedAt: 0, durationMs: 0 },
    });
    memory.append({ kind: "final", output });
    memory.append({ kind: "task", task: "new task" });
    const messages = memory.toMessages({ maxChars: 1000 });
    assert.ok(
      messages.some((message) =>
        message.content.includes(`Latest prior answer: ${JSON.stringify(output)}`),
      ),
    );
  }
});

test("自定义摘要仅调用一次、按 JSON 转义后的大小限额，且不能修改历史", () => {
  const memory = new AgentMemory("system");
  memory.append({ kind: "task", task: "task" });
  addAction(memory, 1, "old data ".repeat(1000));
  addAction(memory, 2, "latest");
  const original = memory.toJSON();
  let calls = 0;
  const messages = memory.toMessages({
    maxChars: 1000,
    summarize(steps) {
      calls++;
      const action = steps.find((step) => step.kind === "action");
      if (action?.kind === "action") action.observations.push("changed");
      return '\n"\\'.repeat(1000);
    },
  });
  assert.equal(calls, 1);
  assert.ok(JSON.stringify(messages).length <= 1000);
  assert.equal(memory.toJSON(), original);
});

test("必要消息过大或非法限额会明确失败，规划附加提示也受限额保护", () => {
  const memory = new AgentMemory("system");
  memory.append({ kind: "task", task: "task" });
  for (const maxChars of [0, -1, 1.5, Infinity])
    assert.throws(() => memory.toMessages({ maxChars }), RangeError);
  assert.throws(() => memory.toMessages({ maxChars: 10 }), /上下文预算不足/);
  assert.throws(
    () =>
      memory.toMessages({ maxChars: 300 }, [
        { role: "user", content: "planning prompt ".repeat(100) },
      ]),
    /上下文预算不足/,
  );
  addAction(memory, 1, "latest ".repeat(1000));
  assert.throws(() => memory.toMessages({ maxChars: 500 }), /上下文预算不足/);
});

test("规划和动作使用同一上下文限额，并保留完整历史", async () => {
  const model = new ScriptedModel([
    textReply("plan-one"),
    toolReply("calculate", { operation: "multiply", a: 6, b: 7 }),
    textReply("plan-two"),
    toolReply("final_answer", { answer: 42 }),
  ]);
  const agent = new ToolCallingAgent({
    model,
    tools: [calculatorTool],
    planningInterval: 1,
    context: { maxChars: 1600 },
  });
  agent.memory.append({ kind: "task", task: "older task" });
  addAction(agent.memory, 1, "old-history-marker ".repeat(1000));
  const result = await agent.run("new task", { reset: false });
  assert.equal(result.output, 42);
  assert.equal(model.requests.length, 4);
  for (const messages of model.requests) {
    assert.ok(JSON.stringify(messages).length <= 1600);
    paired(messages);
  }
  assert.ok(model.requests[1]!.some((message) => message.content === "plan-one"));
  assert.ok(model.requests[3]!.some((message) => message.content === "plan-two"));
  assert.match(agent.memory.toJSON(), /old-history-marker/);
});

test("代码 Agent 裁剪模型历史时仍能跨轮使用 state", async () => {
  const model = new ScriptedModel([
    textReply("```javascript\nstate.result = 104; console.log(state.result);\n```"),
    textReply("```javascript\nfinal_answer(state.result);\n```"),
  ]);
  const agent = new CodeAgent({ model, context: { maxChars: 2000 } });
  agent.memory.append({ kind: "task", task: "older task" });
  addAction(agent.memory, 1, "old data ".repeat(1000));
  const result = await agent.run("save and submit", { reset: false });
  assert.equal(result.output, 104);
  for (const messages of model.requests) assert.ok(JSON.stringify(messages).length <= 2000);
  assert.ok(agent.memory.steps.length > result.steps.length);
});

test("上下文失败发生在模型调用之前，退出后仍能再次执行", async () => {
  const model = new ScriptedModel([toolReply("final_answer", { answer: 42 })]);
  const agent = new ToolCallingAgent({ model, context: { maxChars: 800 } });
  await assert.rejects(agent.run("too large ".repeat(1000)), /上下文预算不足/);
  assert.equal(model.requests.length, 0);
  assert.equal((await agent.run("small task")).output, 42);
});
