import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** 宿主给每个用例单独限时；若 WASM 中断失效，也不会挂住整个测试进程。 */
async function runIsolated(code: string, shouldInterrupt: boolean): Promise<void> {
  const source = `
    import assert from 'node:assert/strict';
    import { QuickJSExecutor, ToolRegistry } from './src/index.ts';
    const executor = new QuickJSExecutor({ timeoutMs: 50 });
    const registry = new ToolRegistry([]);
    const run = () => executor.execute(${JSON.stringify(code)}, registry, {}, new AbortController().signal);
    if (${shouldInterrupt}) {
      await assert.rejects(run(), /interrupted|超时/);
    } else {
      const result = await run();
      assert.deepEqual(result.state, { result: 104 });
      assert.equal(result.isFinalAnswer, ${code.includes("final_answer(")});
      if (result.isFinalAnswer) assert.equal(result.output, 104);
    }
    // 失败动作清理完毕后，执行器仍可用于下一次独立执行。
    const next = await executor.execute('final_answer(42)', registry, {}, new AbortController().signal);
    assert.equal(next.output, 42);
    console.log('verified');
  `;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", source], {
    cwd: new URL("../", import.meta.url),
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
  assert.equal(stdout.trim(), "verified");
}

test("toJSON 状态导出的死循环受动作超时保护", async () => {
  await runIsolated("state.toJSON = () => { while (true) {} };", true);
});

test("getter 状态导出的死循环受动作超时保护", async () => {
  await runIsolated(
    'Object.defineProperty(state, "value", { enumerable: true, get() { while (true) {} } });',
    true,
  );
});

test("提交答案后导出 state 仍保留超时保护", async () => {
  await runIsolated("state.toJSON = () => { while (true) {} }; final_answer(104);", true);
});

test("提交答案后仍可正常序列化 state", async () => {
  await runIsolated("state.toJSON = () => ({ result: 104 }); final_answer(104);", false);
});

test("清理绕过被客体替换的 globalThis Proxy", async () => {
  await runIsolated(
    "state.result = 104; globalThis = new Proxy(globalThis, { deleteProperty() { while (true) {} } });",
    false,
  );
});

test("清理绕过客体在 globalThis 上定义的 getter", async () => {
  await runIsolated(
    'state.result = 104; Object.defineProperty(globalThis, "globalThis", { configurable: true, get() { while (true) {} } });',
    false,
  );
});
