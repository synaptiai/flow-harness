import { createHash } from "node:crypto";

import {
  MAX_RESULT_VALUE_BYTES,
  MAX_RESULT_VALUE_NODES,
  type CompiledResultSchema,
} from "../workflow/types.js";

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

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

export function evaluateTypedResult(
  source: string,
  schema: CompiledResultSchema,
): EvaluatedTypedResult {
  const value = new StrictJsonParser(source).parse();
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

class StrictJsonParser {
  private index = 0;
  private nodes = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    this.skipWhitespace();
    if (this.index === this.source.length) {
      this.invalid("JSON input is empty");
    }
    const value = this.parseValue(1);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.invalid(`unexpected trailing input at offset ${this.index}`);
    }
    return value;
  }

  private parseValue(depth: number): JsonValue {
    if (depth > MAX_RESULT_VALUE_DEPTH) {
      throw new TypedResultError(
        "result_value_too_complex",
        `result value depth must not exceed ${MAX_RESULT_VALUE_DEPTH}`,
      );
    }
    this.nodes += 1;
    if (this.nodes > MAX_RESULT_VALUE_NODES) {
      throw new TypedResultError(
        "result_value_too_complex",
        `result value nodes must not exceed ${MAX_RESULT_VALUE_NODES}`,
      );
    }

    const token = this.source[this.index];
    if (token === '"') {
      return this.parseString();
    }
    if (token === "{") {
      return this.parseObject(depth);
    }
    if (token === "[") {
      return this.parseArray(depth);
    }
    if (token === "t") {
      this.consumeLiteral("true");
      return true;
    }
    if (token === "f") {
      this.consumeLiteral("false");
      return false;
    }
    if (token === "n") {
      this.consumeLiteral("null");
      return null;
    }
    if (token === "-" || isDigit(token)) {
      return this.parseNumber();
    }
    this.invalid(`unexpected token at offset ${this.index}`);
  }

  private parseObject(depth: number): JsonObject {
    this.index += 1;
    this.skipWhitespace();
    const value = Object.create(null) as JsonObject;
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return value;
    }
    while (this.index < this.source.length) {
      if (this.source[this.index] !== '"') {
        this.invalid(`object key must be a JSON string at offset ${this.index}`);
      }
      const key = this.parseString();
      if (keys.has(key)) {
        this.invalid(`duplicate object key ${describeJsonKey(key)}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") {
        this.invalid(`expected ':' after object key at offset ${this.index}`);
      }
      this.index += 1;
      this.skipWhitespace();
      const item = this.parseValue(depth + 1);
      Object.defineProperty(value, key, {
        configurable: false,
        enumerable: true,
        value: item,
        writable: false,
      });
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return value;
      }
      if (delimiter !== ",") {
        this.invalid(`expected ',' or '}' at offset ${this.index}`);
      }
      this.index += 1;
      this.skipWhitespace();
    }
    this.invalid("unterminated object");
  }

  private parseArray(depth: number): JsonValue[] {
    this.index += 1;
    this.skipWhitespace();
    const value: JsonValue[] = [];
    if (this.source[this.index] === "]") {
      this.index += 1;
      return value;
    }
    while (this.index < this.source.length) {
      value.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return value;
      }
      if (delimiter !== ",") {
        this.invalid(`expected ',' or ']' at offset ${this.index}`);
      }
      this.index += 1;
      this.skipWhitespace();
    }
    this.invalid("unterminated array");
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.source.slice(start, this.index));
        } catch {
          this.invalid(`invalid JSON string at offset ${start}`);
        }
        if (typeof value !== "string") {
          this.invalid(`invalid JSON string at offset ${start}`);
        }
        requireValidUnicode(value);
        return value;
      }
      if (character === "\\") {
        const escapeCode = this.source[this.index + 1];
        if (escapeCode === "u") {
          const code = this.source.slice(this.index + 2, this.index + 6);
          if (!/^[a-fA-F0-9]{4}$/.test(code)) {
            this.invalid(`invalid Unicode escape at offset ${this.index}`);
          }
          this.index += 6;
          continue;
        }
        if (escapeCode === undefined || !'"\\/bfnrt'.includes(escapeCode)) {
          this.invalid(`invalid string escape at offset ${this.index}`);
        }
        this.index += 2;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        this.invalid(`unescaped control character at offset ${this.index}`);
      }
      this.index += 1;
    }
    this.invalid(`unterminated string at offset ${start}`);
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.source.slice(this.index),
    );
    if (match === null) {
      this.invalid(`invalid number at offset ${this.index}`);
    }
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new TypedResultError(
        "result_invalid_i_json",
        `JSON number at offset ${this.index - match[0].length} is not finite IEEE-754`,
      );
    }
    return value;
  }

  private consumeLiteral(literal: "true" | "false" | "null"): void {
    if (!this.source.startsWith(literal, this.index)) {
      this.invalid(`invalid literal at offset ${this.index}`);
    }
    this.index += literal.length;
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character !== " " && character !== "\t" && character !== "\r" && character !== "\n") {
        break;
      }
      this.index += 1;
    }
  }

  private invalid(message: string): never {
    throw new TypedResultError("result_invalid_json", message);
  }
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

function requireValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypedResultError(
          "result_invalid_i_json",
          "JSON string contains an unpaired high surrogate",
        );
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypedResultError(
        "result_invalid_i_json",
        "JSON string contains an unpaired low surrogate",
      );
    }
  }
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

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
