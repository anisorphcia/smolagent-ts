import { defineTool, objectInput } from "./tool.ts";
import type { MultiStepAgent } from "../agents/multi-step-agent.ts";

/** 对应 Python managed_agents：子 Agent 通过普通工具接口暴露给父 Agent。 */
export function managedAgentTool(name: string, description: string, agent: MultiStepAgent) {
  return defineTool({
    name,
    description,
    parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    parse: (input) => objectInput(input).task as string,
    async execute(task, { signal }) {
      const result = await agent.run(task, { signal });
      if (result.status !== "success") throw new Error("子 Agent 达到步数上限");
      return result.output;
    },
  });
}
