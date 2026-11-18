import type { ToolDefinition } from "../tools/tool.ts";

export const toolCallingPrompt = `You solve tasks by calling tools and reading their observations.
Use the exact tool argument schema. Correct errors using the next action.
You MUST submit the result through final_answer({answer: ...}); plain text is not a final answer.`;

export function codePrompt(tools: readonly ToolDefinition[]): string {
  return `You solve tasks by writing JavaScript code, executed in an isolated QuickJS interpreter.
Return exactly one fenced javascript code block for each action.
Available tools: ${JSON.stringify(tools)}
Call tools.NAME({...}) synchronously. The host awaits the underlying asynchronous tool for you.
Save reusable JSON values in state, which persists between actions.
Local variables do not persist. console.log(...) produces observations.
Submit the answer with final_answer(value). It ends the action immediately.
No imports, Node.js, network, filesystem, timers, Promise or async/await are available.
Use only the registered tools to interact with the outside world.`;
}

export const planningPrompt =
  "Review the task and observations. Produce a short updated plan. Do not execute code or call tools yet.";
