import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { parseCliArgs } from "../src/cli-options.ts";

const exec = promisify(execFile);
const cwd = new URL("../", import.meta.url);

test("CLI 校验数值配置并支持 -- 后的完整任务", () => {
  for (const args of [
    ["--timeout-ms", "0"],
    ["--max-steps", "1.5"],
    ["--planning-interval"],
    ["--max-retries", "6"],
    ["--context-chars", "0"],
    ["--unknown"],
  ])
    assert.throws(() => parseCliArgs(args));
  const options = parseCliArgs(["--code", "--stream", "--max-steps", "4", "--", "--task", "hello"]);
  assert.equal(options.task, "--task hello");
  assert.equal(options.maxSteps, 4);
  assert.equal(options.code, true);
  assert.equal(options.stream, true);
  assert.equal(parseCliArgs(["--", "--help"]).task, "--help");
  assert.equal(parseCliArgs(["--", "--help"]).help, false);
});

test("默认 CLI 仍输出完整 JSON，帮助无需配置模型", async () => {
  const { stdout } = await exec(process.execPath, ["src/cli.ts", "--demo"], {
    cwd,
    timeout: 10_000,
  });
  assert.equal(JSON.parse(stdout).output, 42);
  const help = await exec(process.execPath, ["src/cli.ts", "--help"], { cwd, timeout: 10_000 });
  assert.match(help.stdout, /--stream/);
});

test("两种 Agent 的 CLI 流输出模型进度、工具事件、步骤和最终结果", async () => {
  for (const mode of [[], ["--code"]]) {
    const { stdout } = await exec(
      process.execPath,
      [
        "src/cli.ts",
        "--demo",
        "--stream",
        "--planning-interval",
        "1",
        "--context-chars",
        "5000",
        ...mode,
      ],
      { cwd, timeout: 10_000 },
    );
    const events = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "model_start" && event.phase === "planning"));
    assert.ok(
      events.some((event) => event.type === "tool_start" && event.execution.name === "calculate"),
    );
    assert.ok(events.some((event) => event.type === "tool_end" && event.execution.output === 42));
    assert.ok(events.some((event) => event.type === "step" && event.step.kind === "planning"));
    assert.equal(events.at(-1)?.type, "result");
    assert.equal(events.at(-1)?.result.status, "success");
    assert.equal(events.at(-1)?.result.output, 42);
    for (const start of events.filter((event) => event.type === "tool_start")) {
      assert.ok(
        events.some(
          (event) => event.type === "tool_end" && event.execution.id === start.execution.id,
        ),
      );
    }
  }
});

test("CLI 动作预算耗尽保持非零退出码，并输出最终状态", async () => {
  await assert.rejects(
    exec(process.execPath, ["src/cli.ts", "--demo", "--stream", "--max-steps", "1"], {
      cwd,
      timeout: 10_000,
    }),
    (error) => {
      assert.ok(error !== null && typeof error === "object" && "stdout" in error);
      const events = String(error.stdout)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(events.at(-1)?.result.status, "max_steps");
      return true;
    },
  );
});

test("CLI 在等待模型时支持 Ctrl+C，取消后退出码为 130", async () => {
  const source = `
    // 模拟真实网络连接的活跃句柄，避免永不完成的空 Promise 让 Node 提前退出。
    const keepAlive = setInterval(() => {}, 1000);
    process.once('SIGINT', () => clearInterval(keepAlive));
    globalThis.fetch = async () => new Promise(() => {});
    process.argv = [process.execPath, 'src/cli.ts', '--stream', 'task'];
    await import('./src/cli.ts');
  `;
  const result = await new Promise<{ code: number | null; signal: string | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          MODEL_API_KEY: "test-key",
          MODEL_ID: "test-model",
          MODEL_BASE_URL: "https://example.invalid/v1",
        },
      });
      let stdout = "",
        stderr = "",
        sent = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("CLI 未在取消后退出"));
      }, 5_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (!sent && stdout.includes('"type":"model_start"')) {
          sent = true;
          child.kill("SIGINT");
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stderr });
      });
    },
  );
  assert.equal(result.code, 130);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /用户取消任务/);
});
