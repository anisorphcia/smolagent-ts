import { ToolCallingAgent, ScriptedModel, calculatorTool, toolReply } from "../src/index.ts";

const model = new ScriptedModel([
  toolReply("calculate", { operation: "multiply", a: 6, b: 7 }),
  (messages) => {
    const observation = messages.at(-1);
    if (observation?.role !== "tool") throw new Error("预期得到工具观察");
    return toolReply("final_answer", { answer: Number(observation.content) });
  },
]);
const agent = new ToolCallingAgent({ model, tools: [calculatorTool] });
const run = agent.stream("计算 6 × 7");
for (;;) {
  const next = await run.next();
  if (next.done) { console.log("运行结果：", next.value); break; }
  console.log("步骤：", next.value);
}
