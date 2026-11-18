import { abortable, ModelError } from "../core/errors.ts";
import { isRecord } from "../core/json.ts";
import type { ChatMessage } from "./model.ts";

export type Redact = (value: string) => string;
const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
const retryableNetworkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** 只记录已知诊断字段；密钥、请求消息及结构化参数字符串按已知值脱敏。 */
export function requestRedactor(apiKey: string, messages: readonly ChatMessage[]): Redact {
  const secrets = new Set([apiKey, ...messages.map((message) => message.content)]);
  const collect = (value: unknown): void => {
    if (typeof value === "string") secrets.add(value);
    else if (value !== null && typeof value === "object")
      for (const entry of Object.values(value)) collect(entry);
  };
  for (const message of messages) {
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? []) collect(call.arguments);
    try {
      collect(JSON.parse(message.content));
    } catch {
      /* 普通文字已经加入脱敏集合。 */
    }
  }
  const values = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  return (value) => {
    let result = value;
    // 先换成占位符，避免后面的短字符串再次匹配并扩张 [REDACTED] 标记。
    for (const secret of values) result = result.replaceAll(secret, "\u0000");
    return result
      .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer \u0000")
      .replaceAll("\u0000", "[REDACTED]")
      .replace(/[\u0001-\u001f\u007f]/g, " ");
  };
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : undefined;
}

export function networkError(cause: unknown, redact: Redact): ModelError {
  const nested = isRecord(cause) && isRecord(cause.cause) ? cause.cause : cause;
  const candidate = identifier(isRecord(nested) ? nested.code : undefined);
  const code = candidate ?? "NETWORK_ERROR";
  const retryable =
    retryableNetworkCodes.has(code) ||
    (!candidate && cause instanceof TypeError && cause.message === "fetch failed");
  return new ModelError(`模型网络请求失败：${redact(code)}`, {
    code: redact(code),
    retryable,
    cause,
  });
}

async function boundedErrorJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    if (signal.aborted) cancel();
    signal.throwIfAborted();
    for (;;) {
      const chunk = await abortable(() => reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      // 限制错误正文为 16 KiB；超限不解析部分响应，也不把原文写入错误。
      if (bytes > 16_384) {
        cancel();
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    signal.throwIfAborted();
    return undefined; // 空响应、HTML 和损坏 JSON 仍保留 HTTP 状态。
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function httpError(
  response: Response,
  signal: AbortSignal,
  redact: Redact,
): Promise<ModelError> {
  const data = await boundedErrorJson(response, signal);
  signal.throwIfAborted();
  const fields = isRecord(data) && isRecord(data.error) ? data.error : {};
  const code = identifier(fields.code);
  const messageId =
    typeof fields.message === "string"
      ? /request[\s_-]*id\s*[:=]\s*([A-Za-z0-9_:./-]+)/i.exec(fields.message)?.[1]
      : undefined;
  const requestId = [
    response.headers.get("x-request-id"),
    response.headers.get("x-tt-logid"),
    fields.request_id,
    isRecord(data) ? data.request_id : undefined,
    messageId,
  ]
    .map(identifier)
    .find((value) => value !== undefined);
  const detail = typeof fields.message === "string" ? redact(fields.message).slice(0, 512) : "";
  return new ModelError(
    `模型请求失败：HTTP ${response.status}${code ? ` [${redact(code)}]` : ""}${detail ? `：${detail}` : ""}${requestId ? ` (requestId: ${redact(requestId)})` : ""}`,
    {
      status: response.status,
      ...(code ? { code: redact(code) } : {}),
      ...(requestId ? { requestId: redact(requestId) } : {}),
      retryable: retryableStatuses.has(response.status),
    },
  );
}
