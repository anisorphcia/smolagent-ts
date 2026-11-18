import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BudgetExceededError,
  CodeAgent,
  OpenAIModel,
  ToolCallingAgent,
  ScriptedModel,
  calculatorTool,
  defineTool,
  managedAgentTool,
  textReply,
  toolReply,
} from "../src/index.ts";
import type { AgentEvent, ChatMessage, ModelResponse } from "../src/index.ts";

const code = (source: string) => textReply(`\`\`\`javascript\n${source}\n\`\`\``);
const withUsage = (reply: ModelResponse, inputTokens: number, outputTokens = 0): ModelResponse => ({
  ...reply,
  usage: { inputTokens, outputTokens },
});

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

test("模型预算包含规划，耗尽后不启动下一轮或空动作", async () => {
  const model = new ScriptedModel([textReply("plan")]);
  const result = await new ToolCallingAgent({ model, planningInterval: 1, maxModelCalls: 1 }).run(
    "task",
  );
  assert.equal(result.status, "budget_exceeded");
  assert.equal(result.stopReason, "max_model_calls");
  assert.equal(result.budget.modelCalls, 1);
  assert.equal(model.requests.length, 1);
  assert.equal(result.summary.actionCount, 0);
});

test("恰好用完模型或 token 预算时，当前动作仍可正常提交答案", async () => {
  const model = new ScriptedModel([withUsage(toolReply("final_answer", { answer: 42 }), 8, 2)]);
  const result = await new ToolCallingAgent({ model, maxModelCalls: 1, maxTokens: 10 }).run("task");
  assert.equal(result.status, "success");
  assert.deepEqual(result.budget, { modelCalls: 1, toolCalls: 1, tokens: 10 });
  assert.equal(result.stopReason, undefined);
});

test("两种 Agent 的超额工具调用都在副作用发生前阻止", async () => {
  for (const strategy of ["tool", "code"]) {
    let touched = 0;
    const tool = defineTool({
      name: "touch",
      description: "counter",
      parameters: { type: "object", properties: {} },
      parse: () => null,
      execute: () => ++touched,
    });
    const model = new ScriptedModel(
      strategy === "code"
        ? [code("tools.touch({}); tools.touch({}); final_answer(0);")]
        : [
            {
              message: {
                role: "assistant",
                content: "",
                toolCalls: [
                  toolReply("touch", {}).message.toolCalls![0]!,
                  toolReply("touch", {}).message.toolCalls![0]!,
                ],
              },
            },
          ],
    );
    const config = { model, tools: [tool], maxToolCalls: 1 };
    const agent = strategy === "code" ? new CodeAgent(config) : new ToolCallingAgent(config);
    const result = await agent.run("task", {
      onEvent: () => {
        throw new Error("observer failed");
      },
    });
    assert.equal(result.status, "budget_exceeded");
    assert.equal(result.stopReason, "max_tool_calls");
    assert.equal(touched, 1);
    assert.equal(result.budget.toolCalls, 1);
    const action = result.steps.find((step) => step.kind === "action");
    assert.equal(action?.kind, "action");
    if (action?.kind === "action") {
      assert.equal(action.toolExecutions?.length, 2);
      assert.equal(action.toolExecutions?.[0]?.output, 1);
      assert.match(action.toolExecutions![1]!.error!, /max_tool_calls/);
    }
    paired(agent.memory.toMessages());
  }
});

test("代码捕获预算错误后也不能继续调用工具或绕过停止原因", async () => {
  let touched = 0;
  const tool = defineTool({
    name: "touch",
    description: "counter",
    parameters: { type: "object", properties: {} },
    parse: () => null,
    execute: () => ++touched,
  });
  const agent = new CodeAgent({
    tools: [tool],
    maxToolCalls: 1,
    model: new ScriptedModel([
      code(
        "tools.touch({}); try { tools.touch({}); } catch {} try { tools.touch({}); } catch {} final_answer(42);",
      ),
    ]),
  });
  const result = await agent.run("task");
  assert.equal(touched, 1);
  assert.equal(result.status, "budget_exceeded");
  assert.equal(result.stopReason, "max_tool_calls");
  assert.equal(
    result.steps.some((step) => step.kind === "final"),
    false,
  );
});

test("自定义执行器即使不转发观察器，使用传入注册表时仍受工具预算限制", async () => {
  let touched = 0;
  const tool = defineTool({
    name: "touch",
    description: "counter",
    parameters: { type: "object", properties: {} },
    parse: () => null,
    execute: () => ++touched,
  });
  const agent = new CodeAgent({
    tools: [tool],
    maxToolCalls: 1,
    model: new ScriptedModel([code("anything")]),
    executor: {
      async execute(_code, tools, state, signal) {
        await tools.call("touch", {}, { signal });
        try {
          await tools.call("touch", {}, { signal });
        } catch {}
        return { logs: [], state, isFinalAnswer: true, output: 42 };
      },
    },
  });
  const result = await agent.run("task");
  assert.equal(touched, 1);
  assert.equal(result.stopReason, "max_tool_calls");
});

test("token 超额后不执行工具，并保存触发限额的回复和 usage", async () => {
  for (const strategy of ["tool", "code"]) {
    const reply =
      strategy === "code" ? code("final_answer(42);") : toolReply("final_answer", { answer: 42 });
    const model = new ScriptedModel([withUsage(reply, 10, 5)]);
    const agent =
      strategy === "code"
        ? new CodeAgent({ model, maxTokens: 10 })
        : new ToolCallingAgent({ model, maxTokens: 10 });
    const result = await agent.run("task");
    assert.equal(result.status, "budget_exceeded");
    assert.equal(result.stopReason, "max_tokens");
    assert.deepEqual(result.budget, { modelCalls: 1, toolCalls: 0, tokens: 15 });
    assert.equal(result.summary.usage?.inputTokens, 10);
    assert.equal(result.summary.usage?.outputTokens, 5);
    const action = result.steps.find((step) => step.kind === "action");
    assert.equal(action?.messages[0]?.role, "assistant");
    paired(agent.memory.toMessages());
  }
});

test("规划超过 token 限额时保留计划与用量，不再执行动作", async () => {
  const model = new ScriptedModel([withUsage(textReply("plan"), 11)]);
  const result = await new ToolCallingAgent({ model, maxTokens: 10, planningInterval: 1 }).run(
    "task",
  );
  assert.equal(result.stopReason, "max_tokens");
  assert.equal(result.budget.tokens, 11);
  assert.equal(result.summary.planningCount, 1);
  assert.equal(result.summary.actionCount, 0);
  assert.equal(result.summary.usage?.inputTokens, 11);
});

test("token 用量跨模型回复累计，达到上限前完成的工具不重复执行", async () => {
  const model = new ScriptedModel([
    withUsage(toolReply("calculate", { operation: "add", a: 1, b: 2 }), 4, 2),
    withUsage(toolReply("final_answer", { answer: 3 }), 4, 2),
  ]);
  const result = await new ToolCallingAgent({ model, tools: [calculatorTool], maxTokens: 10 }).run(
    "task",
  );
  assert.equal(result.stopReason, "max_tokens");
  assert.deepEqual(result.budget, { modelCalls: 2, toolCalls: 1, tokens: 12 });
  assert.deepEqual(result.summary.usage, { inputTokens: 8, outputTokens: 4 });
  paired(result.steps.flatMap((step) => (step.kind === "action" ? step.messages : [])));
});

test("HTTP 内部重试不重复计入逻辑模型调用预算", async () => {
  let requests = 0;
  const model = new OpenAIModel({
    apiKey: "test",
    modelId: "test",
    maxRetries: 1,
    retryBaseMs: 0,
    fetch: async () => {
      if (++requests === 1) return new Response(null, { status: 503 });
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call", function: { name: "final_answer", arguments: '{"answer":42}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    },
  });
  const result = await new ToolCallingAgent({ model, maxModelCalls: 1, maxTokens: 3 }).run("task");
  assert.equal(requests, 2);
  assert.equal(result.status, "success");
  assert.deepEqual(result.budget, { modelCalls: 1, toolCalls: 1, tokens: 3 });
});

test("缺少 usage 时不虚报用量；启用 token 预算时明确停止", async () => {
  const model = () => new ScriptedModel([toolReply("final_answer", { answer: 42 })]);
  const limited = await new ToolCallingAgent({ model: model(), maxTokens: 10 }).run("task");
  assert.equal(limited.stopReason, "token_usage_unavailable");
  assert.equal(limited.budget.tokens, null);
  assert.equal(limited.budget.toolCalls, 0);
  const unrestricted = await new ToolCallingAgent({ model: model() }).run("task");
  assert.equal(unrestricted.status, "success");
  assert.equal(unrestricted.budget.tokens, null);
});

test("无效 token usage 作为模型错误抛出，不能绕过 token 预算", async () => {
  const model = new ScriptedModel([withUsage(toolReply("final_answer", { answer: 42 }), -1)]);
  await assert.rejects(new ToolCallingAgent({ model, maxTokens: 10 }).run("task"), /无效.*usage/);
});

test("连续相同错误按规范化参数识别，调用 ID 和对象键顺序不影响检测", async () => {
  const model = new ScriptedModel([
    toolReply("missing", { a: 1, b: 2 }),
    toolReply("missing", { b: 2, a: 1 }),
  ]);
  const result = await new ToolCallingAgent({ model, maxRepeatedErrors: 2 }).run("task");
  assert.equal(result.status, "stalled");
  assert.equal(result.stopReason, "repeated_error");
  assert.equal(result.summary.actionCount, 2);
  assert.equal(model.requests.length, 2);
});

test("参数改变或中间动作成功时，不误判为连续相同失败", async () => {
  const result = await new ToolCallingAgent({
    tools: [calculatorTool],
    maxRepeatedErrors: 2,
    model: new ScriptedModel([
      toolReply("missing", { a: 1 }),
      toolReply("missing", { a: 2 }),
      toolReply("calculate", { operation: "add", a: 1, b: 2 }),
      toolReply("missing", { a: 2 }),
      toolReply("final_answer", { answer: 42 }),
    ]),
  }).run("task");
  assert.equal(result.status, "success");
});

test("代码 Agent 的重复代码错误也会停止", async () => {
  const model = new ScriptedModel([
    code("throw new Error('same');"),
    code("throw new Error('same');"),
  ]);
  const result = await new CodeAgent({ model, maxRepeatedErrors: 2 }).run("task");
  assert.equal(result.status, "stalled");
  assert.equal(result.stopReason, "repeated_error");
});

test("工具预算拒绝后保留消息配对，续聊预算重新计数", async () => {
  const model = new ScriptedModel([
    toolReply("calculate", { operation: "add", a: 1, b: 2 }),
    toolReply("final_answer", { answer: 3 }),
    toolReply("final_answer", { answer: 42 }),
  ]);
  const agent = new ToolCallingAgent({ model, tools: [calculatorTool], maxToolCalls: 1 });
  assert.equal((await agent.run("first")).stopReason, "max_tool_calls");
  paired(agent.memory.toMessages());
  const next = await agent.run("second", { reset: false });
  assert.equal(next.status, "success");
  assert.deepEqual(next.budget, { modelCalls: 1, toolCalls: 1, tokens: null });
  paired(model.requests.at(-1)!);
});

test("取消继续抛出原始原因，之后可重新运行并使用新的预算", async () => {
  for (const reason of [new Error("cancel"), new BudgetExceededError("max_tokens")]) {
    const controller = new AbortController();
    const agent = new ToolCallingAgent({
      maxModelCalls: 1,
      model: new ScriptedModel([
        () => {
          controller.abort(reason);
          return new Promise<ModelResponse>(() => {});
        },
        toolReply("final_answer", { answer: 42 }),
      ]),
    });
    await assert.rejects(
      agent.run("first", { signal: controller.signal }),
      (error) => error === reason,
    );
    const result = await agent.run("second");
    assert.equal(result.status, "success");
    assert.equal(result.budget.modelCalls, 1);
  }
});

test("预算停止仍输出最后动作，完成的模型事件不因额度停止被标记为请求失败", async () => {
  const events: AgentEvent[] = [];
  const agent = new CodeAgent({
    maxTokens: 1,
    model: new ScriptedModel([withUsage(code("final_answer(42)"), 2)]),
  });
  const iterator = agent.stream("task", {
    onEvent: (event) => {
      events.push(event);
    },
  });
  const kinds: string[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      assert.equal(next.value.status, "budget_exceeded");
      break;
    }
    kinds.push(next.value.kind);
  }
  assert.deepEqual(kinds, ["task", "action"]);
  const end = events.find((event) => event.type === "model_end");
  assert.equal(end?.succeeded, true);
});

test("子 Agent 未完成时回传真实停止原因", async () => {
  const child = new ToolCallingAgent({
    maxModelCalls: 1,
    model: new ScriptedModel([textReply("not a tool")]),
  });
  const tool = managedAgentTool("child", "child", child);
  await assert.rejects(
    tool.call({ task: "task" }, { signal: new AbortController().signal }),
    /max_model_calls/,
  );
});

test("非法运行限额在构造时拒绝", () => {
  for (const key of ["maxModelCalls", "maxToolCalls", "maxTokens", "maxRepeatedErrors"] as const) {
    for (const value of [0, -1, 1.5, Infinity])
      assert.throws(
        () => new ToolCallingAgent({ model: new ScriptedModel([]), [key]: value }),
        RangeError,
      );
  }
});
