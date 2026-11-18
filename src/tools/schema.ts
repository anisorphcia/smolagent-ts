import { assertJson, isRecord } from "../core/json.ts";

/** 教学版本明确支持的 JSON Schema 子集；空 schema 接受任意 JSON 值。 */
export type Schema =
  | { type?: never; description?: string }
  | { type: "string"; description?: string; enum?: readonly string[] }
  | { type: "number" | "integer" | "boolean" | "null"; description?: string }
  | { type: "array"; items: Schema; description?: string }
  | { type: "object"; properties: Record<string, Schema>; required?: readonly string[]; additionalProperties?: boolean; description?: string };

export function validate(schema: Schema, value: unknown, path = "input"): void {
  if (schema.type === undefined) {
    assertJson(value);
  } else if (schema.type === "object") {
    if (!isRecord(value)) throw new TypeError(`${path} 必须是对象`);
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} 是必填参数`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties, key)) validate(schema.properties[key]!, entry, `${path}.${key}`);
      else if (schema.additionalProperties !== true) throw new TypeError(`${path}.${key} 是未知参数`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new TypeError(`${path} 必须是数组`);
    value.forEach((entry, i) => validate(schema.items, entry, `${path}[${i}]`));
  } else if (schema.type === "null") {
    if (value !== null) throw new TypeError(`${path} 必须是 null`);
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
      throw new TypeError(`${path} 必须是有限的 ${schema.type}`);
    }
  } else {
    if (typeof value !== schema.type) throw new TypeError(`${path} 必须是 ${schema.type}`);
    if (schema.type === "string" && schema.enum && !schema.enum.includes(value as string)) {
      throw new TypeError(`${path} 必须属于 ${schema.enum.join(", ")}`);
    }
  }
}
