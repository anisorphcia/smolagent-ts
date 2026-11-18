import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelError, OpenAIModel } from "../src/index.ts";

const signal = () => new AbortController().signal;
const success = () => Response.json({ choices: [{ message: { content: "ok" } }] });

test("HTTP 错误暴露状态、服务端错误码和 requestId，且脱敏请求内容", async () => {
  const key = "private-api-key";
  const prompt = "private user prompt";
  const model = new OpenAIModel({
    apiKey: key,
    modelId: "test",
    fetch: async () =>
      Response.json(
        {
          error: { code: "AuthenticationError", message: `Invalid ${key}; request=${prompt}` },
        },
        { status: 401, headers: { "x-request-id": "req-123" } },
      ),
  });
  await assert.rejects(
    model.generate([{ role: "user", content: prompt }], { signal: signal() }),
    (error) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "AuthenticationError");
      assert.equal(error.requestId, "req-123");
      assert.equal(error.retryable, false);
      assert.match(error.message, /REDACTED/);
      assert.ok(!error.message.includes(key));
      assert.ok(!error.message.includes(prompt));
      return true;
    },
  );
});

test("网络错误保留底层 cause 和错误码", async () => {
  const cause = new TypeError("fetch failed", {
    cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
  });
  const model = new OpenAIModel({
    apiKey: "test",
    modelId: "test",
    fetch: async () => {
      throw cause;
    },
  });
  await assert.rejects(model.generate([], { signal: signal() }), (error) => {
    assert.ok(error instanceof ModelError);
    assert.equal(error.code, "ECONNRESET");
    assert.equal(error.retryable, true);
    assert.equal(error.cause, cause);
    return true;
  });
});

test("默认不重试；显式开启后暂时性 HTTP 错误能恢复", async () => {
  let defaultCalls = 0;
  await assert.rejects(
    new OpenAIModel({
      apiKey: "test",
      modelId: "test",
      fetch: async () => {
        defaultCalls++;
        return new Response(null, { status: 503 });
      },
    }).generate([], { signal: signal() }),
    /HTTP 503/,
  );
  assert.equal(defaultCalls, 1);
  let calls = 0;
  const model = new OpenAIModel({
    apiKey: "test",
    modelId: "test",
    maxRetries: 2,
    retryBaseMs: 0,
    fetch: async () => {
      calls++;
      return calls < 3
        ? Response.json({ error: { code: "Busy" } }, { status: calls === 1 ? 429 : 503 })
        : success();
    },
  });
  assert.equal((await model.generate([], { signal: signal() })).message.content, "ok");
  assert.equal(calls, 3);
});

test("401、404 及永久性服务端错误不重试", async () => {
  for (const status of [400, 401, 403, 404, 501]) {
    let calls = 0;
    await assert.rejects(
      new OpenAIModel({
        apiKey: "test",
        modelId: "test",
        maxRetries: 2,
        retryBaseMs: 0,
        fetch: async () => {
          calls++;
          return Response.json({ error: { code: "InvalidRequest" } }, { status });
        },
      }).generate([], { signal: signal() }),
      (error) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("网络错误重试有上限，配置和普通程序错误不重试", async () => {
  let calls = 0;
  const transient = new TypeError("fetch failed", {
    cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
  });
  await assert.rejects(
    new OpenAIModel({
      apiKey: "test",
      modelId: "test",
      maxRetries: 2,
      retryBaseMs: 0,
      fetch: async () => {
        calls++;
        throw transient;
      },
    }).generate([], { signal: signal() }),
    /ECONNRESET/,
  );
  assert.equal(calls, 3);
  for (const cause of [
    Object.assign(new TypeError("invalid URL"), { code: "ERR_INVALID_URL" }),
    new Error("programming error"),
  ]) {
    let permanentCalls = 0;
    await assert.rejects(
      new OpenAIModel({
        apiKey: "test",
        modelId: "test",
        maxRetries: 2,
        fetch: async () => {
          permanentCalls++;
          throw cause;
        },
      }).generate([], { signal: signal() }),
      (error) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(permanentCalls, 1);
  }
});

test("成功 HTTP 响应的 JSON 和协议解析错误不重试，也不输出原始正文", async () => {
  for (const response of [new Response("private-response-content"), Response.json({})]) {
    let calls = 0;
    await assert.rejects(
      new OpenAIModel({
        apiKey: "test",
        modelId: "test",
        maxRetries: 2,
        fetch: async () => {
          calls++;
          return response;
        },
      }).generate([], { signal: signal() }),
      (error) => {
        assert.ok(error instanceof ModelError);
        assert.ok(!error.message.includes("private-response-content"));
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("Retry-After 等待可取消，取消后不会再次请求", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel retry");
  let calls = 0;
  const model = new OpenAIModel({
    apiKey: "test",
    modelId: "test",
    maxRetries: 2,
    retryBaseMs: 0,
    fetch: async () => {
      calls++;
      setTimeout(() => controller.abort(reason), 10);
      return new Response(null, { status: 503, headers: { "retry-after": "60" } });
    },
  });
  await assert.rejects(
    model.generate([], { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(calls, 1);
});

test("Retry-After 受配置上限约束，HTTP 重试也有次数上限", async () => {
  let calls = 0;
  await assert.rejects(
    new OpenAIModel({
      apiKey: "test",
      modelId: "test",
      timeoutMs: 1000,
      maxRetries: 2,
      maxRetryDelayMs: 0,
      fetch: async () => {
        calls++;
        return new Response(null, { status: 503, headers: { "retry-after": "3600" } });
      },
    }).generate([], { signal: signal() }),
    /HTTP 503/,
  );
  assert.equal(calls, 3);
});

test("请求超时包含重试等待，即使注入的 fetch 忽略 signal 也能结束等待", async () => {
  let calls = 0;
  const model = new OpenAIModel({
    apiKey: "test",
    modelId: "test",
    timeoutMs: 30,
    maxRetries: 2,
    retryBaseMs: 1000,
    fetch: async () => {
      calls++;
      return new Response(null, { status: 503 });
    },
  });
  await assert.rejects(
    model.generate([], { signal: signal() }),
    (error) => error instanceof Error && error.name === "TimeoutError",
  );
  assert.equal(calls, 1);
  const controller = new AbortController();
  const reason = new Error("cancel request");
  const pending = new OpenAIModel({
    apiKey: "test",
    modelId: "test",
    fetch: async () => new Promise<Response>(() => {}),
  }).generate([], { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("读取未结束的错误正文时取消，并释放读取器", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const reason = new Error("cancel error body");
  const model = new OpenAIModel({
    apiKey: "test",
    modelId: "test",
    fetch: async () => {
      setTimeout(() => controller.abort(reason), 10);
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"error":'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 },
      );
    },
  });
  await assert.rejects(
    model.generate([], { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(cancelled, true);
});

test("非 JSON 和超限错误正文不进入诊断信息", async () => {
  for (const text of [
    "secret html",
    JSON.stringify({ error: { message: "secret ".repeat(5000) } }),
  ]) {
    await assert.rejects(
      new OpenAIModel({
        apiKey: "test",
        modelId: "test",
        fetch: async () => new Response(text, { status: 400 }),
      }).generate([], { signal: signal() }),
      (error) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.status, 400);
        assert.ok(!error.message.includes("secret"));
        return true;
      },
    );
  }
});

test("错误回显中的工具参数和结构化观察脱敏，并从消息提取 requestId", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    modelId: "test",
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "InvalidParameter",
            message: "Invalid private-tool-token / private-observation. Request id: req-456",
          },
        },
        { status: 400 },
      ),
  });
  await assert.rejects(
    model.generate(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "tool", arguments: { token: "private-tool-token" } }],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          content: JSON.stringify({ token: "private-observation" }),
        },
      ],
      { signal: signal() },
    ),
    (error) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.requestId, "req-456");
      assert.ok(!error.message.includes("private-tool-token"));
      assert.ok(!error.message.includes("private-observation"));
      return true;
    },
  );
});

test("非法重试配置在构造时拒绝", () => {
  for (const options of [
    { maxRetries: -1 },
    { maxRetries: 6 },
    { maxRetries: 1.5 },
    { retryBaseMs: -1 },
    { maxRetryDelayMs: Infinity },
  ]) {
    assert.throws(
      () => new OpenAIModel({ apiKey: "test", modelId: "test", ...options }),
      RangeError,
    );
  }
});
