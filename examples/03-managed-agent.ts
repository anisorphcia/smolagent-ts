import { ToolCallingAgent, ScriptedModel, toolReply, managedAgentTool } from "../src/index.ts";

const researcher = new ToolCallingAgent({
  model: new ScriptedModel([
    toolReply("final_answer", { answer: "工具、模型、记忆、执行循环是四个核心模块。" }),
  ]),
});
const manager = new ToolCallingAgent({
  tools: [managedAgentTool("researcher", "分析 Agent 架构", researcher)],
  model: new ScriptedModel([
    toolReply("researcher", { task: "解释 Agent 的核心模块" }),
    (messages) => toolReply("final_answer", { answer: JSON.parse(messages.at(-1)!.content) }),
  ]),
});
console.log(await manager.run("请研究员解释 Agent 的核心模块"));
