export interface CliOptions {
  help: boolean;
  demo: boolean;
  code: boolean;
  stream: boolean;
  task: string;
  maxSteps: number;
  timeoutMs: number;
  maxRetries: number;
  planningInterval?: number;
  contextChars?: number;
}

const numericFlags = {
  "--max-steps": "maxSteps",
  "--timeout-ms": "timeoutMs",
  "--planning-interval": "planningInterval",
  "--max-retries": "maxRetries",
  "--context-chars": "contextChars",
} as const;

export function parseCliArgs(args: readonly string[]): CliOptions {
  const separator = args.indexOf("--");
  const helpIndex = args.indexOf("--help");
  const help = args.length === 0 || (helpIndex >= 0 && (separator < 0 || helpIndex < separator));
  const options: CliOptions = {
    help,
    demo: false,
    code: false,
    stream: false,
    task: "",
    maxSteps: 6,
    timeoutMs: 120_000,
    maxRetries: 0,
  };
  if (options.help) return options;
  const task: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      task.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--demo" || arg === "--code" || arg === "--stream") {
      options[arg.slice(2) as "demo" | "code" | "stream"] = true;
      continue;
    }
    if (Object.hasOwn(numericFlags, arg)) {
      const value = args[++index];
      const number = Number(value);
      const minimum = arg === "--max-retries" ? 0 : 1;
      if (
        !value ||
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(number) ||
        number < minimum ||
        (arg === "--max-retries" && number > 5)
      ) {
        throw new Error(`${arg} 需要${minimum === 0 ? "0 到 5 的整数" : "正整数"}`);
      }
      options[numericFlags[arg as keyof typeof numericFlags]] = number;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`未知选项 ${arg}，使用 --help 查看用法`);
    task.push(arg);
  }
  options.task = options.demo ? "计算 6 × 7" : task.join(" ");
  if (!options.task.trim()) throw new Error("请提供任务，或使用 --demo");
  return options;
}

export const cliHelp = `用法：npm run cli -- [选项] "任务"
--demo                  离线演示 6 × 7，无需 API Key
--code                  使用代码 Agent（默认工具调用 Agent）
--stream                逐行输出模型进度、工具开始/结束、步骤及结果（NDJSON）
--max-steps N           最大动作轮数，默认 6
--planning-interval N   每 N 轮动作前规划，首次动作前也规划
--timeout-ms N          总运行超时，默认 120000
--max-retries N         模型暂时性错误的额外重试次数，0 到 5，默认 0
--context-chars N       模型消息 JSON 的字符预算，默认不裁剪
--                      后续内容全部作为任务`;
