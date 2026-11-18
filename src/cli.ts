#!/usr/bin/env node
import { ToolCallingAgent } from "./agents/tool-calling-agent.ts";
import { CodeAgent } from "./agents/code-agent.ts";
import { OpenAIModel } from "./models/openai-model.ts";
import { ScriptedModel, textReply, toolReply } from "./models/scripted-model.ts";
import { calculatorTool } from "./tools/default-tools.ts";
import { errorMessage } from "./core/errors.ts";
import { cliHelp, parseCliArgs } from "./cli-options.ts";
import { planningPrompt } from "./prompts/templates.ts";
import type { Script } from "./models/scripted-model.ts";
import type { RunResult } from "./agents/multi-step-agent.ts";

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(cliHelp);
    return;
  }
  let demoAction = 0;
  const demoReply: Script = (messages) => {
    if (messages.at(-1)?.content === planningPrompt)
      return textReply("先计算乘积，再提交最终答案。");
    if (options.code)
      return textReply(
        '```javascript\nfinal_answer(tools.calculate({operation:"multiply", a:6, b:7}));\n```',
      );
    return demoAction++ === 0
      ? toolReply("calculate", { operation: "multiply", a: 6, b: 7 })
      : toolReply("final_answer", { answer: 42 });
  };
  // 离线演示最多两轮动作，加上每轮规划，共四次模型回复即可完成。
  const model = options.demo
    ? new ScriptedModel(Array.from({ length: 4 }, () => demoReply))
    : new OpenAIModel({
        apiKey: process.env.MODEL_API_KEY ?? "",
        modelId: process.env.MODEL_ID ?? "",
        ...(process.env.MODEL_BASE_URL ? { baseUrl: process.env.MODEL_BASE_URL } : {}),
        maxRetries: options.maxRetries,
      });
  const config = {
    model,
    tools: [calculatorTool],
    maxSteps: options.maxSteps,
    ...(options.planningInterval !== undefined
      ? { planningInterval: options.planningInterval }
      : {}),
    ...(options.contextChars !== undefined ? { context: { maxChars: options.contextChars } } : {}),
  };
  const agent = options.code ? new CodeAgent(config) : new ToolCallingAgent(config);
  const lifecycle = new AbortController();
  const cancel = () => {
    process.exitCode = 130;
    lifecycle.abort(new Error("用户取消任务"));
  };
  process.once("SIGINT", cancel);
  let result: RunResult;
  try {
    const runOptions = { signal: lifecycle.signal, timeoutMs: options.timeoutMs };
    if (options.stream) {
      const iterator = agent.stream(options.task, {
        ...runOptions,
        onEvent: (event) => console.log(JSON.stringify(event)),
      });
      let completed = false;
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            result = next.value;
            completed = true;
            break;
          }
          console.log(JSON.stringify({ type: "step", step: next.value }));
        }
      } finally {
        // 消费方异常时也关闭步骤流；关闭时不使用生成器的返回值。
        if (!completed) await iterator.return(undefined as never);
      }
      console.log(JSON.stringify({ type: "result", result }));
    } else {
      result = await agent.run(options.task, runOptions);
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    process.removeListener("SIGINT", cancel);
  }
  if (result.status !== "success") process.exitCode = 1;
}
main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode ||= 1;
});
