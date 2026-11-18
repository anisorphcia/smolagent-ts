import { CodeAgent, ScriptedModel, calculatorTool, textReply } from "../src/index.ts";

const agent = new CodeAgent({
  tools: [calculatorTool],
  model: new ScriptedModel([
    textReply(
      '```javascript\nstate.result = tools.calculate({operation: "multiply", a: 6, b: 7});\nconsole.log(state.result);\n```',
    ),
    textReply("```javascript\nfinal_answer(state.result);\n```"),
  ]),
});
const result = await agent.run("计算 6 × 7，保存结果，再在下一步提交答案");
console.log("答案：", result.output);
console.log("步骤：", JSON.stringify(result.steps, null, 2));
