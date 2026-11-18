export class AgentError extends Error {}
export class ToolError extends AgentError {}
export interface ModelErrorOptions extends ErrorOptions {
  status?: number;
  code?: string;
  requestId?: string;
  retryable?: boolean;
}
/** 保持普通 Error 的 message/cause，同时让调用方按字段处理模型请求失败。 */
export class ModelError extends AgentError {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  constructor(message: string, options: ModelErrorOptions = {}) {
    super(message, options);
    this.name = "ModelError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
  }
}
export class ExecutionError extends AgentError {}
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 等待可取消；宿主工具仍需主动响应 signal，才能停止自身的 I/O。 */
export async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop: () => void = () => {};
  // 把 abort 事件转换成拒绝的 Promise；never 表示它不会成功产出值。
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
  });
  // 任务与取消信号谁先落定就采用谁的结果；race 不会自动停止底层 work 的 I/O。
  // 保留 return await，确保 finally 在等待结束后才移除监听器。
  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
