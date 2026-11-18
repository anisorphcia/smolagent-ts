import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ToolCallingAgent,
  ScriptedModel,
  toolReply,
  textReply,
  calculatorTool,
  managedAgentTool,
} from "../src/index.ts";

test("工具结果进入模型上下文；最终答案和 token 统计正确", async () => {
  const model = new ScriptedModel([
    {
      ...toolReply("calculate", { operation: "multiply", a: 6, b: 7 }),
      usage: { inputTokens: 10, outputTokens: 2 },
    },
    (messages) => {
      assert.equal(messages.at(-1)?.content, "42");
      return {
        ...toolReply("final_answer", { answer: 42 }),
        usage: { inputTokens: 20, outputTokens: 3 },
      };
    },
  ]);
  const result = await new ToolCallingAgent({ model, tools: [calculatorTool] }).run("6 × 7");
  assert.equal(result.status, "success");
  assert.equal(result.output, 42);
  assert.deepEqual(result.summary.usage, { inputTokens: 30, outputTokens: 5 });
  assert.equal(result.summary.actionCount, 2);
});

test("参数校验失败和未知工具都能恢复，并保持消息配对", async () => {
  const model = new ScriptedModel([
    toolReply("missing", {}),
    toolReply("calculate", { operation: "add", a: "6", b: 7 }),
    (messages) => {
      assert.match(messages.at(-1)!.content, /必须是有限/);
      return toolReply("final_answer", { answer: "已修正" });
    },
  ]);
  const result = await new ToolCallingAgent({ model, tools: [calculatorTool] }).run("恢复错误");
  assert.equal(result.output, "已修正");
  assert.equal(result.summary.errorCount, 2);
  for (const step of result.steps) {
    if (step.kind !== "action") continue;
    const assistant = step.messages[0];
    assert.equal(assistant?.role, "assistant");
    const reply = step.messages[1];
    assert.equal(reply?.role, "tool");
    if (assistant?.role === "assistant" && reply?.role === "tool")
      assert.equal(reply.toolCallId, assistant.toolCalls![0]!.id);
  }
});

test("普通文本不结束任务；耗尽预算后不额外请求模型", async () => {
  const model = new ScriptedModel([textReply("答案是42")]);
  const result = await new ToolCallingAgent({ model, maxSteps: 1 }).run("计算");
  assert.equal(result.status, "max_steps");
  assert.equal(result.output, null);
  assert.equal(model.requests.length, 1);
});

test("最终答案检查失败可恢复；null 是合法答案", async () => {
  const result = await new ToolCallingAgent({
    model: new ScriptedModel([
      toolReply("final_answer", { answer: 0 }),
      toolReply("final_answer", { answer: null }),
    ]),
    finalAnswerChecks: [(answer) => answer === null],
  }).run("返回 null");
  assert.equal(result.status, "success");
  assert.equal(result.output, null);
  assert.equal(result.summary.errorCount, 1);
});

test("同一批次包含最终答案时不执行批次中的工具", async () => {
  const calls = [
    toolReply("calculate", { operation: "add", a: 1, b: 2 }),
    toolReply("final_answer", { answer: 3 }),
  ];
  const model = new ScriptedModel([
    {
      message: {
        role: "assistant",
        content: "",
        toolCalls: calls.flatMap((call) => call.message.toolCalls!),
      },
    },
  ]);
  const result = await new ToolCallingAgent({ model, tools: [calculatorTool], maxSteps: 1 }).run(
    "计算",
  );
  assert.equal(result.status, "max_steps");
  const step = result.steps[1];
  assert.equal(step?.kind, "action");
  if (step?.kind === "action")
    assert.equal(step.messages.filter((message) => message.role === "tool").length, 2);
});

test("规划单独记录，stream 和 run 使用同一执行语义", async () => {
  const agent = new ToolCallingAgent({
    model: new ScriptedModel([
      textReply("先直接回答"),
      toolReply("final_answer", { answer: "完成" }),
    ]),
    planningInterval: 1,
  });
  const kinds: string[] = [];
  for await (const step of agent.stream("规划")) kinds.push(step.kind);
  assert.deepEqual(kinds, ["task", "planning", "action", "final"]);
});

test("默认清空记忆；reset:false 保留会话且结果只统计本轮", async () => {
  const model = new ScriptedModel([
    toolReply("final_answer", { answer: "a" }),
    toolReply("final_answer", { answer: "b" }),
    toolReply("final_answer", { answer: "c" }),
  ]);
  const agent = new ToolCallingAgent({ model });
  await agent.run("第一轮");
  const second = await agent.run("第二轮", { reset: false });
  assert.equal(second.summary.actionCount, 1);
  assert.ok(model.requests[1]!.some((message) => message.content === "第一轮"));
  await agent.run("第三轮");
  assert.equal(
    model.requests[2]!.some((message) => message.content === "第一轮"),
    false,
  );
});

test("取消等待模型；拒绝并发且退出后释放 busy", async () => {
  const controller = new AbortController();
  const agent = new ToolCallingAgent({ model: { generate: async () => new Promise(() => {}) } });
  const running = agent.run("一直等待", { signal: controller.signal });
  await assert.rejects(agent.run("并发"), /不能并发/);
  controller.abort(new Error("用户取消"));
  await assert.rejects(running, /用户取消/);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error("再次取消"));
  await assert.rejects(agent.run("新任务", { signal: alreadyAborted.signal }), /再次取消/);
});

test("子 Agent 可作为工具被编排", async () => {
  const child = new ToolCallingAgent({
    model: new ScriptedModel([toolReply("final_answer", { answer: 42 })]),
  });
  const parent = new ToolCallingAgent({
    tools: [managedAgentTool("child", "计算", child)],
    model: new ScriptedModel([
      toolReply("child", { task: "计算" }),
      (messages) => toolReply("final_answer", { answer: JSON.parse(messages.at(-1)!.content) }),
    ]),
  });
  assert.equal((await parent.run("委派任务")).output, 42);
});

test("提前结束 stream 后可重新运行", async () => {
  const agent = new ToolCallingAgent({
    model: new ScriptedModel([toolReply("final_answer", { answer: 1 })]),
  });
  for await (const _step of agent.stream("提前停止")) break;
  assert.equal((await agent.run("重新运行")).output, 1);
});
