# Python 源码映射与扩展规划

参考来源：同级 `smolagent-study/src/smolagents`，其 `pyproject.toml` 标记版本为 `1.27.0.dev0`。本次以本地源码为依据，没有追踪上游实时版本。

## 已迁移的核心职责

| Python 源文件 / 概念 | TypeScript 对应 | 主要调整 |
| --- | --- | --- |
| `agents.py / MultiStepAgent` | `src/agents/multi-step-agent.ts` | async generator 统一 run/stream，明确预算和结果状态 |
| `agents.py / ToolCallingAgent` | `src/agents/tool-calling-agent.ts` | 按 toolCall ID 返回观察，工具顺序执行 |
| `agents.py / CodeAgent` | `src/agents/code-agent.ts` | 动作语言由 Python 改成 JavaScript |
| `agents.py / final_answer_checks` | `MultiStepAgent.checkAnswer()` | 同步或异步 boolean 检查，失败可重试 |
| `agents.py / planning` | 共享循环中的 `plan()` | 可选周期规划，独立步骤和 token 使用量 |
| `agents.py / managed_agents` | `src/tools/managed-agent.ts` | 子 Agent 被包装成普通工具 |
| `tools.py / Tool, @tool` | `src/tools/tool.ts` | 接口 + 工厂函数，显式 parse 和 schema |
| `tool_validation.py`、类型提示解析 | `src/tools/schema.ts` | 显式 Schema 子集，替代运行时反射 |
| `default_tools.py / FinalAnswerTool` | `src/tools/default-tools.ts` | 保留 `final_answer` 协议 |
| `default_tools.py / PythonInterpreterTool` | 计算器与 CodeExecutor | 计算器不执行任意表达式，代码执行单独抽象 |
| `models.py / Model, ChatMessage` | `src/models/model.ts` | 纯接口与联合消息类型 |
| `models.py / OpenAIModel` | `src/models/openai-model.ts` | fetch 实现文本 Chat Completions，支持兼容服务 |
| 测试中的假模型 | `src/models/scripted-model.ts` | 可读取上下文的确定性回复脚本 |
| `memory.py / *Step` | `src/memory/steps.ts` | dataclass 层级改为可辨识联合 |
| `memory.py / AgentMemory` | `src/memory/agent-memory.ts` | 步骤存储、上下文投影、JSON 导出 |
| `local_python_executor.py / PythonExecutor` | `src/executors/code-executor.ts` | 定义语言无关的执行职责 |
| `local_python_executor.py / LocalPythonExecutor` | `src/executors/quickjs-executor.ts` | 使用 QuickJS/WASM；仅 JSON state 跨动作 |
| `prompts/*.yaml` | `src/prompts/templates.ts` | 策略提示词集中维护，无模板引擎依赖 |
| `monitoring.py / TokenUsage, Timing, Monitor` | `src/monitoring/run-summary.ts` 与步骤类型 | 聚合使用量、耗时、动作和错误数 |
| `cli.py` | `src/cli.ts` | 离线/真实模型、工具/代码 Agent 入口 |
| `__init__.py` | `src/index.ts` | 集中导出稳定的阅读入口 |

## 有意保留的行为差异

- Python 到达步数上限会额外请求模型生成兜底答案；这里直接返回 `max_steps`，预算不会被隐式突破。
- Python 支持解释器变量和复杂对象跨步复用；这里每步重建解释器，显式 JSON `state` 持久化。
- Python 工具可从函数签名和 docstring 推断 schema；TS 类型运行时不存在，所以使用显式 schema + parse。
- Python 的完整流接口可以混合 token 增量和步骤；这里只提供步骤流。
- Python 多种输出包装类型没有移植；当前模型消息是文本，工具与最终答案均为 JSON。
- Python 的序列化模块涉及复杂对象和代理代码；这里只导出可检查的运行记忆，不支持载入并执行历史代码。

## 尚未迁移的扩展

| 原模块或能力 | 当前状态 | 后续合理入口 |
| --- | --- | --- |
| `mcp_client.py` | 未实现 | 将 MCP 工具包装为 `Tool`；新增传输生命周期模块 |
| `remote_executors.py` 的 Docker/E2B/Modal/Blaxel | 未实现 | 实现 `CodeExecutor`，把资源清理纳入执行器契约 |
| `models.py` 的 HF/Bedrock/Azure/Transformers 等 | 未实现专用适配器 | 实现 `Model`；兼容 Chat Completions 的服务可先配置 baseUrl |
| token SSE 流、模型重试和上下文裁剪 | 未实现 | 模型装饰器与流接口，避免把服务商细节加进循环 |
| `agent_types.py` 的图像/音频 | 未实现 | 先扩展消息和工具输出协议，再接模型与 UI |
| `default_tools.py` 的搜索/网页/语音工具 | 未实现 | 用 `defineTool` 注册，可独立验证和替换 |
| `serialization.py` 的完整持久化、Hub 加载 | 未实现 | 独立版本化数据协议；不要直接反序列化可执行代码 |
| `gradio_ui.py`、`vision_web_browser.py` | 未实现 | 应用层消费步骤流，不侵入 Agent 核心 |
| 遥测、可视化日志、Python callback registry | 未实现完整对应 | 应用消费步骤流，未来可加入 observer 接口 |

## 后续顺序

当前交付的工具、模型、记忆、两种策略、执行器、规划、子 Agent、CLI 和离线验证构成可运行的核心版本。后续建议依次扩展：

1. 模型层的重试、SSE token 流、上下文窗口管理。
2. 工具层的文件读取、搜索、MCP 接入。
3. 执行层的 Worker 与远程执行器、运行生命周期契约。
4. 消息层的多模态，再增加应用 UI 和观测界面。

每次扩展应先确定接口边界和错误语义，再写能说明行为的离线测试及示例。这样阅读主循环时无需同时理解网络传输、UI 和平台 SDK。
