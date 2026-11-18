# smolagent-ts

参考 `smolagents` 的 Python 源码，以 TypeScript 重新组织核心架构。目标是让你能沿着“任务 → 模型 → 动作 → 观察 → 下一步”的调用链阅读和运行代码。

它实现 Python 版的核心执行机制，不宣称兼容全部 Python API；完整对应与边界见 [迁移对照](docs/PYTHON-MAPPING.md)。

## 先运行

需要 Node.js ≥ 22.18，使用 ESM 和严格 TypeScript。源码可由 Node 直接擦除类型后运行，构建产物是普通 JavaScript。

```bash
cd smolagent-ts
npm ci
npm run demo          # 工具调用：6 × 7 → 42，无需 API Key
npm run demo:code     # 代码执行：调用工具 → state 保存 → 下一步提交
npm run demo:managed  # 父 Agent 通过工具调用子 Agent
npm run check        # 严格类型检查 + 行为测试
npm run build        # 生成 dist 中的 JS、类型声明和 sourcemap
node dist/examples/02-code-agent.js
```

真实模型：复制 `.env.example` 为 `.env`，填写 `MODEL_API_KEY`、`MODEL_ID`，按服务提供方配置 `MODEL_BASE_URL`，然后执行 `npm run demo:live`。真实调用可能产生服务商费用；默认示例和测试全部离线。

```bash
npm run cli -- --demo
npm run cli -- --demo --code
npm run cli -- "用工具计算 (6 + 7) × 8"
```

查看实时进度与工具轨迹：

```bash
npm run cli -- --demo --code --stream
npm run cli -- --code --stream --max-steps 8 --planning-interval 3 --timeout-ms 120000 "用工具计算 (6 + 7) × 8"
npm run cli -- --help
```

默认 CLI 仍在结束后打印完整 JSON；`--stream` 改为每行一个 JSON 事件（NDJSON），依次输出模型调用、工具调用、步骤和最终结果。`--max-retries` 可显式开启模型请求重试，默认 0。`--` 后面的所有内容都作为任务。

## 进度与工具轨迹

`agent.run(task, { onEvent })` 和 `agent.stream(task, { onEvent })` 都支持可选观察器：

```ts
const result = await agent.run("执行任务", {
  onEvent(event) {
    if (event.type === "tool_start") console.log("开始工具：", event.execution.name);
    if (event.type === "tool_end")
      console.log("工具结果：", event.execution.output, event.execution.error);
  },
});
```

| 事件                        | 含义                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `model_start` / `model_end` | 一次逻辑模型调用开始/结束，含规划或动作阶段、调用序号，结束时含耗时及成功标志。HTTP 内部重试仍属于同一次逻辑调用。 |
| `tool_start` / `tool_end`   | 一次工具调用开始/结束，含动作编号及独立调用 ID，可配对追踪。结束事件含结果或错误及耗时。                           |
| `step` / `result`           | CLI 流输出中的完整步骤与最终 RunResult；`agent.stream()` 本身仍只 yield MemoryStep。                               |

每个动作的 `toolExecutions` 保存已完成工具调用的名称、输入、输出或错误、耗时和调用 ID。工具调用 Agent 额外保存模型的 `callId`；代码 Agent 即使在调用工具后抛错，也会保存已经发生的轨迹。独立的 `final_answer()` 是代码执行器的控制函数，不作为普通工具桥接调用记录。

观察器接收独立快照；同步异常和异步拒绝会被隔离，异步观察器不会阻塞任务，应用需要自行等待日志写入完成。轨迹中的业务参数和结果不会自动使用 HTTP 错误的脱敏规则。自定义 `CodeExecutor` 可转发可选的第五个参数 `onToolEvent` 到工具注册表，以接入相同轨迹。

## 上下文限额

可在创建 Agent 时配置 `context: { maxChars: 24000 }`，也可通过 CLI 使用：

```bash
npm run cli -- --demo --code --stream --context-chars 5000
```

限额只影响模型请求的消息投影，完整 `agent.memory`、返回的执行记录及代码 `state` 仍保留。未配置时继续提供完整上下文。规划的附加提示同样计入消息预算。

裁剪从最早的可移除步骤开始，始终保留系统提示、当前任务、当前任务的最新动作和刚生成的计划。每个动作的模型工具调用与对应工具结果一起保留或一起移除，不截断单条消息；如果必要上下文已经超过限额，会在请求模型之前报错。

剩余空间允许时，为旧步骤附上数量、最近答案和观察的简要记录；也可提供同步的 `context.summarize(omittedSteps)` 返回自己的摘要。摘要器只在发生裁剪且有空间时调用一次，输入是历史快照；摘要最多取前 512 个字符串单元，再按 JSON 转义后的实际长度缩短。必要消息刚好占满预算时允许不附摘要。

`maxChars` 计量内部统一消息数组序列化后的字符数，不是精确 token 数或供应商转换后的 HTTP 请求大小，也不包含单独提供的工具 schema。内置简要记录不额外调用 LLM，不等同于完整语义摘要。

## 目录与阅读路线

```text
src/
  core/          JSON 边界、错误类型、取消等待
  tools/         工具定义、Schema 校验、注册表、默认工具、子 Agent 工具
  models/        消息协议、Model 接口、离线模型、HTTP 适配器
  memory/        步骤类型与模型上下文投影
  agents/        共享循环、工具调用策略、代码执行策略
  executors/     CodeExecutor 接口与 QuickJS 实现
  prompts/       与策略配套的提示词
  monitoring/    步数、错误数、token 汇总
  index.ts       对外 API
  cli.ts         命令行入口
examples/        4 个完整示例
tests/           离线行为验证
docs/            架构、逐步阅读、Python 对照和扩展规划
```

建议按以下顺序阅读：

1. [examples/01-tool-calling.ts](examples/01-tool-calling.ts)：先看一次完整运行，认识输入和结果。
2. [src/tools/tool.ts](src/tools/tool.ts)：理解工具如何描述、校验和执行。
3. [src/models/model.ts](src/models/model.ts)：明确模型的统一输入输出。
4. [src/memory/steps.ts](src/memory/steps.ts) 与 [agent-memory.ts](src/memory/agent-memory.ts)：理解运行历史如何变成模型上下文。
5. [src/agents/multi-step-agent.ts](src/agents/multi-step-agent.ts)：重点阅读 `stream()`，这是整个项目的主干。
6. [src/agents/tool-calling-agent.ts](src/agents/tool-calling-agent.ts)：只负责一次结构化工具动作。
7. [src/agents/code-agent.ts](src/agents/code-agent.ts) 与 [QuickJS 执行器](src/executors/quickjs-executor.ts)：理解两种策略如何共用主干。
8. [src/models/openai-model.ts](src/models/openai-model.ts)：最后看真实服务的协议适配。

进一步阅读：[架构与关键取舍](docs/ARCHITECTURE.md) · [跟踪一次执行](docs/READING-GUIDE.md) · [Python 源码映射与规划](docs/PYTHON-MAPPING.md)。

## 最小用法

```ts
import { ToolCallingAgent, ScriptedModel, calculatorTool, toolReply } from "./src/index.ts";

const agent = new ToolCallingAgent({
  tools: [calculatorTool],
  model: new ScriptedModel([
    toolReply("calculate", { operation: "multiply", a: 6, b: 7 }),
    toolReply("final_answer", { answer: 42 }),
  ]),
  maxSteps: 4,
});

const result = await agent.run("计算 6 × 7");
console.log(result.status, result.output); // success 42
console.log(result.summary); // 步数、错误数、usage
```

这里的 `ScriptedModel` 用预设回复替代真实 LLM，让你不用网络也能观察 Agent。示例 01 还展示了读取实际工具观察生成下一条回复的写法。

## 已实现的行为

- `ToolCallingAgent`、`CodeAgent` 共用多步循环、步数预算和最终答案校验。
- 参数校验、工具查找、多个调用的顺序执行和错误恢复。
- `final_answer` 显式结束；普通文本不会误判为成功，`null` 也可作为合法答案。
- 任务、规划、动作、答案的类型化记忆；支持 `reset: false` 续聊。
- `AsyncGenerator` 按步骤输出；`run()` 消费同一生成器并返回结果。
- 周期规划、父子 Agent 编排、取消与运行超时、并发保护。
- QuickJS 执行生成的 JavaScript，JSON `state` 跨动作保存。
- Chat Completions 兼容服务适配、token 使用量与运行摘要、CLI。
- 记忆 JSON 导出 `agent.memory.toJSON()`，用于检查和存档。

运行耗尽预算时返回 `status: "max_steps"`、`output: null`；调用方应先检查状态。模型或网络故障、外部取消直接抛出错误，不会伪装成工具观察。`usage: null` 表示统计所需数据不完整。

代码 Agent 的宿主是 TypeScript，模型动作是 JavaScript。工具在动作里以同步形式调用，例如 `tools.calculate({...})`；Asyncify 在内部等待宿主异步工具。请遵循提示词约定，不使用 async/await。跨步骤的数据放在 `state`，局部变量只属于当前动作。

当前没有迁移 Gradio、浏览器自动化、多模态、Python 解释器语法、远程执行平台、Hub 发布或所有供应商 SDK。后续可以通过现有的 `Model`、`Tool`、`CodeExecutor` 接口逐项接入。
