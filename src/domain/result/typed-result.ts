import { createHash } from "node:crypto";

import {
  MAX_RESULT_VALUE_BYTES,
  MAX_RESULT_VALUE_NODES,
  type CompiledResultSchema,
} from "../workflow/types.js";
import {
  parseStrictJson,
  StrictJsonError,
  type StrictJsonObject as JsonObject,
  type StrictJsonValue as JsonValue,
} from "../strict-json.js";

const MAX_RESULT_VALUE_DEPTH = 64;

export type TypedResultErrorCode =
  | "result_invalid_json"
  | "result_invalid_i_json"
  | "result_schema_mismatch"
  | "result_value_too_complex"
  | "result_value_too_large";

export class TypedResultError extends Error {
  override readonly name = "TypedResultError";

  constructor(
    readonly code: TypedResultErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface EvaluatedTypedResult {
  readonly canonicalValue: string;
  readonly valueHash: string;
}

export function calculateResultSchemaDigest(schema: CompiledResultSchema): string {
  return sha256(canonicalResultSchema(schema));
}

export function resultSourceTruncationMessage(resultNodeId: string, sourceField: string): string {
  return `result "${resultNodeId}" source ${sourceField} is truncated`;
}

export function evaluateTypedResult(
  source: string,
  schema: CompiledResultSchema,
): EvaluatedTypedResult {
  let value: JsonValue;
  try {
    value = parseStrictJson(source, {
      maxDepth: MAX_RESULT_VALUE_DEPTH,
      maxNodes: MAX_RESULT_VALUE_NODES,
      valueLabel: "result value",
    });
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new TypedResultError(strictJsonResultCode(error.code), error.message);
    }
    throw error;
  }
  validateValue(value, schema, "$", 1);
  const canonicalValue = canonicalize(value);
  if (Buffer.byteLength(canonicalValue, "utf8") > MAX_RESULT_VALUE_BYTES) {
    throw new TypedResultError(
      "result_value_too_large",
      `canonical result must not exceed ${MAX_RESULT_VALUE_BYTES} UTF-8 bytes`,
    );
  }
  return Object.freeze({
    canonicalValue,
    valueHash: sha256(canonicalValue),
  });
}

function strictJsonResultCode(code: StrictJsonError["code"]): TypedResultErrorCode {
  if (code === "invalid_json") {
    return "result_invalid_json";
  }
  return code === "invalid_i_json" ? "result_invalid_i_json" : "result_value_too_complex";
}

function validateValue(
  value: JsonValue,
  schema: CompiledResultSchema,
  path: string,
  depth: number,
): void {
  if (depth > MAX_RESULT_VALUE_DEPTH) {
    throw new TypedResultError(
      "result_value_too_complex",
      `result value depth must not exceed ${MAX_RESULT_VALUE_DEPTH}`,
    );
  }
  switch (schema.type) {
    case "null":
      requireSchema(value === null, path, "must be null");
      return;
    case "boolean":
      requireSchema(typeof value === "boolean", path, "must be a boolean");
      return;
    case "number":
      requireSchema(typeof value === "number", path, "must be a number");
      if (typeof value === "number") {
        requireRange(value, schema.minimum, schema.maximum, path);
      }
      return;
    case "integer":
      requireSchema(Number.isSafeInteger(value), path, "must be a safe integer");
      if (typeof value === "number") {
        requireRange(value, schema.minimum, schema.maximum, path);
      }
      return;
    case "string":
      requireSchema(typeof value === "string", path, "must be a string");
      if (typeof value === "string") {
        requireSchema(
          [...value].length <= schema.maxLength,
          path,
          `must not exceed ${schema.maxLength} Unicode characters`,
        );
      }
      return;
    case "array":
      requireSchema(Array.isArray(value), path, "must be an array");
      if (Array.isArray(value)) {
        requireSchema(
          value.length <= schema.maxItems,
          path,
          `must not exceed ${schema.maxItems} items`,
        );
        for (const [index, item] of value.entries()) {
          validateValue(item, schema.items, `${path}[${index}]`, depth + 1);
        }
      }
      return;
    case "object": {
      const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
      requireSchema(isObject, path, "must be an object");
      if (!isObject) {
        return;
      }
      const object = value as JsonObject;
      const keys = Object.keys(object);
      for (const key of keys) {
        requireSchema(
          Object.hasOwn(schema.properties, key),
          resultPropertyPath(path, key),
          "is not declared",
        );
      }
      for (const key of schema.required) {
        requireSchema(Object.hasOwn(object, key), `${path}.${key}`, "is required");
      }
      for (const key of keys) {
        if (Object.hasOwn(schema.properties, key)) {
          const propertySchema = schema.properties[key] as CompiledResultSchema;
          validateValue(
            object[key] as JsonValue,
            propertySchema,
            resultPropertyPath(path, key),
            depth + 1,
          );
        }
      }
      return;
    }
  }
}

function requireRange(
  value: number,
  minimum: number | undefined,
  maximum: number | undefined,
  path: string,
): void {
  if (minimum !== undefined) {
    requireSchema(value >= minimum, path, `must be at least ${minimum}`);
  }
  if (maximum !== undefined) {
    requireSchema(value <= maximum, path, `must be at most ${maximum}`);
  }
}

function requireSchema(condition: boolean, path: string, message: string): void {
  if (!condition) {
    throw new TypedResultError("result_schema_mismatch", `${path} ${message}`);
  }
}

function resultPropertyPath(path: string, key: string): string {
  return `${path}[${describeJsonKey(key)}]`;
}

function describeJsonKey(key: string): string {
  const characters = [...key];
  if (characters.length <= 96) {
    return JSON.stringify(key);
  }
  return `${JSON.stringify(characters.slice(0, 96).join(""))}… (sha256:${sha256(key)})`;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as JsonValue)}`)
    .join(",")}}`;
}

function canonicalResultSchema(schema: CompiledResultSchema): string {
  switch (schema.type) {
    case "null":
    case "boolean":
      return JSON.stringify({ type: schema.type });
    case "number":
    case "integer":
      return JSON.stringify({
        type: schema.type,
        ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }),
        ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }),
      });
    case "string":
      return JSON.stringify({ type: schema.type, maxLength: schema.maxLength });
    case "array":
      return `{"type":"array","items":${canonicalResultSchema(schema.items)},"maxItems":${schema.maxItems}}`;
    case "object":
      return `{"type":"object","properties":{${Object.keys(schema.properties)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonicalResultSchema(schema.properties[key] as CompiledResultSchema)}`,
        )
        .join(",")}},"required":${JSON.stringify([...schema.required].sort())}}`;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
