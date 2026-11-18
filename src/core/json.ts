/** 跨模型、工具和执行器只传 JSON，避免把宿主对象带进生成的代码。 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertJson(
  value: unknown,
  ancestors = new Set<object>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) throw new TypeError("值必须是有限的 JSON 数据");
  if (ancestors.has(value)) throw new TypeError("JSON 数据不能包含循环引用");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new TypeError("JSON 对象必须是普通对象");
  }
  ancestors.add(value);
  for (const entry of Object.values(value)) assertJson(entry, ancestors);
  ancestors.delete(value);
}

export function jsonText(value: unknown): string {
  assertJson(value);
  return JSON.stringify(value);
}
