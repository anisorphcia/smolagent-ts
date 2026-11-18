# 跟踪一次执行

先执行 `npm run demo`，再把下面的步骤与源码对应起来。例子求 `6 × 7`，使用预设模型回复，因此每次结果一致。

## 第一步：应用组装依赖

打开 `examples/01-tool-calling.ts`：

- `calculatorTool` 表示可调用能力。
- `ScriptedModel` 模拟模型，第一条回复要求调用计算器。
- `ToolCallingAgent` 组装模型、工具和循环。

`ToolCallingAgent` 构造时调用父类，注册应用工具，并自动加入 `final_answer`。应用不需要自己注册最终答案工具，重复注册会报错。

## 第二步：进入共享循环

在 `agents/multi-step-agent.ts` 的 `stream()` 中，任务首先变成 `TaskStep`。此时 `memory.toMessages()` 产生 system 和 user 两条消息。

循环创建第一个 `ActionStep`，然后调用具体策略的 `act(step, signal)`。先忽略可选规划分支，就能看清主干。

## 第三步：模型产出结构化动作

在 `agents/tool-calling-agent.ts` 中，`model.generate()` 得到：

```ts
{
  role: "assistant",
  content: "",
  toolCalls: [{
    id: "某个唯一调用ID",
    name: "calculate",
    arguments: { operation: "multiply", a: 6, b: 7 },
  }],
}
```

模型只描述动作，还没有执行计算。

## 第四步：工具执行与观察

`ToolRegistry.call()` 查找名称，`defineTool()` 返回的 `call()` 校验参数，然后执行计算并检查结果是否是 JSON 值。结果 `42` 被写成对应调用 ID 的 tool 消息。

动作保存到记忆并从流中输出。模型看到的上下文变成：

```text
system: 任务处理规则
user: 计算 6 × 7
assistant: 调用 calculate
tool: 42
```

如果参数把 `a` 写成字符串，工具会返回类型错误；这个错误也通过 tool 消息进入下一轮上下文。查看 `tests/agents.test.ts` 中的错误恢复用例，可观察这一分支。

## 第五步：显式提交答案

示例中的第二条模型回复读取最后一条真实工具观察，把它放进 `final_answer` 的 `answer` 参数。策略执行这个工具，并调用共享的 `checkAnswer()`。

通过校验后 `isFinalAnswer` 设为 true。循环写入 `FinalAnswerStep`，然后返回 `RunResult`。是否结束由标志决定，所以 `null`、`false`、`0` 都是有效答案。

## 接着看代码 Agent

运行 `npm run demo:code`。同一主循环中的动作变为：

```js
state.result = tools.calculate({ operation: "multiply", a: 6, b: 7 });
console.log(state.result);
```

下一步：

```js
final_answer(state.result);
```

阅读 `CodeAgent.act()` 可以看到，变化集中在代码解析和执行；任务、预算、记忆、规划和最终结果仍由父类处理。再读 `QuickJSExecutor.execute()`，注意以下三个边界：

1. 将宿主 JSON state 导入客体。
2. 将客体工具调用转换成宿主 `ToolRegistry.call()`。
3. 导出 JSON state，并在 finally 释放解释器资源。

## 自己扩展一个工具

```ts
import { defineTool, objectInput } from "../src/index.ts";

const greet = defineTool({
  name: "greet",
  description: "返回中文问候语",
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  parse(input) {
    return objectInput(input).name as string;
  },
  execute(name) {
    return `你好，${name}`;
  },
});
```

把工具加入 Agent 的 `tools` 即可。它同时可供结构化工具调用和代码动作使用。需要 I/O 时，让 `execute` 返回 Promise，并把上下文中的 signal 传给 I/O API。

建议最后阅读 `OpenAIModel`：它把内部消息转换为 HTTP 请求，并把 HTTP 响应转回内部类型。真实模型不会改变 Agent 的循环结构，这正是接口拆分的用途。
