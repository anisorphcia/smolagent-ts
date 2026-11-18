import { newQuickJSAsyncWASMModule, newVariant, RELEASE_ASYNC } from "quickjs-emscripten";
import type { QuickJSHandle } from "quickjs-emscripten";
import { abortable, ExecutionError, errorMessage } from "../core/errors.ts";
import { assertJson, isRecord, jsonText } from "../core/json.ts";
import type { JsonObject, JsonValue } from "../core/json.ts";
import type { ToolRegistry, ToolEventObserver } from "../tools/tool.ts";
import type { CodeExecutor, ExecutionResult } from "./code-executor.ts";

export interface QuickJSOptions {
  timeoutMs?: number;
  memoryLimitMb?: number;
  maxToolCalls?: number;
}

/**
 * 对应 LocalPythonExecutor 的职责，用独立的 WASM 解释器执行 JavaScript。
 * 每步新建解释器，只让 JSON state 跨步存活，资源生命周期集中在 finally。
 * Asyncify 使客体的同步工具调用可等待宿主的异步 I/O。
 */
export class QuickJSExecutor implements CodeExecutor {
  private readonly options: Required<QuickJSOptions>;
  constructor(options: QuickJSOptions = {}) {
    this.options = {
      timeoutMs: options.timeoutMs ?? 2_000,
      memoryLimitMb: options.memoryLimitMb ?? 32,
      maxToolCalls: options.maxToolCalls ?? 32,
    };
    for (const [key, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} 必须是正整数`);
    }
    if (this.options.memoryLimitMb < 16) throw new RangeError("WASM 内存至少需要 16 MiB");
  }
  async execute(
    code: string,
    tools: ToolRegistry,
    state: JsonObject,
    signal: AbortSignal,
    onToolEvent?: ToolEventObserver,
  ): Promise<ExecutionResult> {
    signal.throwIfAborted();
    if (code.length > 65_536) throw new ExecutionError("代码长度超过限制");
    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: this.options.memoryLimitMb * 16,
    });
    // 每次 execute 都创建独立的 QuickJS/WASM 环境；上一轮的局部变量不会自动存在。
    const module = await newQuickJSAsyncWASMModule(
      newVariant(RELEASE_ASYNC, { wasmMemory: memory }),
    );
    const runtime = module.newRuntime();
    runtime.setMaxStackSize(256 * 1024);
    const vm = runtime.newContext();
    const deadline = performance.now() + this.options.timeoutMs;
    const control = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]);
    let isFinalAnswer = false;
    let executingAction = true;
    let output: JsonValue = null;
    let calls = 0;
    const logs: string[] = [];
    runtime.setInterruptHandler(
      () => (executingAction && isFinalAnswer) || control.aborted || performance.now() >= deadline,
    );
    const encode = vm.unwrapResult(vm.evalCode("JSON.stringify"));
    const parse = vm.unwrapResult(vm.evalCode("JSON.parse"));
    const encodeValue = (handle: QuickJSHandle): string => {
      const encoded = vm.unwrapResult(vm.callFunction(encode, vm.undefined, handle));
      try {
        if (vm.typeof(encoded) !== "string") throw new TypeError("值必须是 JSON 数据");
        const json = vm.getString(encoded);
        if (json.length > 65_536) throw new TypeError("JSON 数据长度超过限制");
        return json;
      } finally {
        encoded.dispose();
      }
    };
    const decode = (json: string): QuickJSHandle => {
      const text = vm.newString(json);
      try {
        return vm.unwrapResult(vm.callFunction(parse, vm.undefined, text));
      } finally {
        text.dispose();
      }
    };
    try {
      // 将 CodeAgent 保存的 JSON state 复制进新解释器，供本轮代码读写。
      decode(jsonText(state)).consume((value) => vm.setProp(vm.global, "state", value));
      // 客体不能直接访问 Node 的 global / process / require / fetch。
      // 禁止客体自行排队微任务，保证一次动作在返回后不会留下未完成工作。
      vm.unwrapResult(vm.evalCode("globalThis.Promise = undefined;")).dispose();
      const toolObject = vm.newObject();
      // 注入 tools.NAME 桥接函数：客体代码同步调用，Asyncify 在宿主侧等待异步工具。
      // final_answer 单独注入，作为控制执行结束的函数，不走普通工具桥接。
      for (const tool of tools.definitions().filter((entry) => entry.name !== "final_answer")) {
        vm.newAsyncifiedFunction(tool.name, async (input = vm.undefined) => {
          try {
            if (isFinalAnswer) throw new Error("动作已经结束");
            if (++calls > this.options.maxToolCalls) throw new Error("工具调用次数超过限制");
            const args: unknown = JSON.parse(encodeValue(input));
            const value = await abortable(
              () =>
                tools.call(tool.name, args, {
                  signal: control,
                  ...(onToolEvent ? { onToolEvent } : {}),
                }),
              control,
            );
            return decode(jsonText(value));
          } catch (error) {
            return { error: vm.newError(errorMessage(error)) };
          }
        }).consume((fn) => vm.setProp(toolObject, tool.name, fn));
      }
      vm.setProp(vm.global, "tools", toolObject);
      toolObject.dispose();
      const consoleObject = vm.newObject();
      vm.newFunction("log", (...args) => {
        if (logs.length >= 100) throw new Error("日志条数超过限制");
        const line = args
          .map((arg) => (vm.typeof(arg) === "string" ? vm.getString(arg) : encodeValue(arg)))
          .join(" ");
        if (logs.join("").length + line.length > 65_536) throw new Error("日志长度超过限制");
        logs.push(line);
      }).consume((fn) => vm.setProp(consoleObject, "log", fn));
      vm.setProp(vm.global, "console", consoleObject);
      consoleObject.dispose();
      // 提交答案时保存 output 并标记结束，再用错误/中断立即停止剩余代码。
      // 后面用 isFinalAnswer 区分“主动提交答案”和“普通执行失败”。
      vm.newFunction("final_answer", (answer = vm.undefined) => {
        if (isFinalAnswer) return { error: vm.newError("最终答案已经提交") };
        output = JSON.parse(encodeValue(answer)) as JsonValue;
        isFinalAnswer = true;
        return { error: vm.newError("final_answer 已提交") };
      }).consume((fn) => vm.setProp(vm.global, "final_answer", fn));

      const result = await vm.evalCodeAsync(
        `(function () { "use strict";\n${code}\n})()`,
        "agent-action.js",
      );
      // 提交答案只终止动作代码；错误展开与 state 导出仍须受超时和取消保护。
      executingAction = false;
      if (result.error) {
        const error: unknown = vm.dump(result.error);
        result.error.dispose();
        if (!isFinalAnswer)
          throw new ExecutionError(errorMessage(isRecord(error) ? error.message : error));
      } else {
        result.value.dispose();
      }
      control.throwIfAborted();
      // 序列化可能执行 getter / toJSON，不能在导出 state 前移除中断处理器。
      const stateHandle = vm.getProp(vm.global, "state");
      try {
        // 仅正常结束或主动提交答案时导出 state；返回给 CodeAgent 供下一轮恢复。
        const nextState: unknown = JSON.parse(encodeValue(stateHandle));
        assertJson(nextState);
        if (!isRecord(nextState)) throw new ExecutionError("state 必须保持为 JSON 对象");
        return { logs, state: nextState as JsonObject, isFinalAnswer, output };
      } finally {
        stateHandle.dispose();
      }
    } finally {
      // 动作可能已经超时；清理另设短期限，避免立即中断清理或无限执行客体代码。
      const cleanupDeadline = performance.now() + 50;
      runtime.setInterruptHandler(() => performance.now() >= cleanupDeadline);
      try {
        // 顶层 this 指向原始全局对象，绕过客体替换的 globalThis / Proxy / getter。
        vm.evalCode(
          "delete this.tools; delete this.console; delete this.final_answer; delete this.state;",
        ).dispose();
      } finally {
        encode.dispose();
        parse.dispose();
        try {
          vm.dispose();
        } finally {
          runtime.removeInterruptHandler();
          runtime.dispose();
        }
      }
    }
  }
}
