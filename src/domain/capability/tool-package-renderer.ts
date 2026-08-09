import { createHash } from "node:crypto";

import { type AgentCommandRequest, normalizeAgentCommandRequest } from "../agent-command.js";
import type { ToolPackageSnapshot } from "./tool-packages.js";

export const MAX_TOOL_PACKAGE_STRING_INPUT_BYTES = 4_096;

export type ToolPackageInputValue = string | number | boolean;
export type CanonicalToolPackageInput = Readonly<Record<string, ToolPackageInputValue>>;

export interface RenderedToolPackageCommand {
  readonly input: CanonicalToolPackageInput;
  readonly inputDigest: string;
  readonly request: AgentCommandRequest;
}

const inputPlaceholder = /^\{input:([A-Za-z][A-Za-z0-9_]*)\}$/;

export function renderToolPackageCommand(
  snapshot: ToolPackageSnapshot,
  input: unknown,
): RenderedToolPackageCommand {
  const canonicalInput = canonicalizeInput(snapshot, input);
  const rendered = snapshot.definition.driver.args.map((argument) => {
    const match = inputPlaceholder.exec(argument);
    if (match === null) {
      return argument;
    }
    const name = match[1];
    if (name === undefined || !Object.hasOwn(canonicalInput, name)) {
      throw new Error(`tool package "${snapshot.name}" has an invalid input placeholder`);
    }
    return canonicalArgument(canonicalInput[name]);
  });
  const request = normalizeAgentCommandRequest({
    executable: snapshot.definition.driver.executable,
    args: rendered,
    timeoutMs: snapshot.definition.driver.timeoutMs,
  });
  return deepFreeze({
    input: canonicalInput,
    inputDigest: calculateCanonicalInputDigest(snapshot, canonicalInput),
    request,
  });
}

export function calculateToolPackageInputDigest(
  snapshot: ToolPackageSnapshot,
  input: unknown,
): string {
  return calculateCanonicalInputDigest(snapshot, canonicalizeInput(snapshot, input));
}

function canonicalizeInput(
  snapshot: ToolPackageSnapshot,
  input: unknown,
): CanonicalToolPackageInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`tool "${snapshot.definition.tool.name}" input must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`tool "${snapshot.definition.tool.name}" input must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        descriptors[key]?.enumerable !== true ||
        !("value" in (descriptors[key] ?? {})),
    )
  ) {
    throw new Error(`tool "${snapshot.definition.tool.name}" input must contain plain data fields`);
  }

  const definitions = new Map(
    snapshot.definition.tool.inputs.map((definition) => [definition.name, definition]),
  );
  for (const key of Object.keys(descriptors)) {
    if (!definitions.has(key)) {
      throw new Error(`tool "${snapshot.definition.tool.name}" received unknown input "${key}"`);
    }
  }

  const canonical: Record<string, ToolPackageInputValue> = {};
  for (const definition of snapshot.definition.tool.inputs) {
    const descriptor = descriptors[definition.name];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(
        `tool "${snapshot.definition.tool.name}" requires input "${definition.name}"`,
      );
    }
    const value = descriptor.value;
    switch (definition.type) {
      case "string":
        if (typeof value !== "string") {
          throw invalidInputType(snapshot, definition.name, "string");
        }
        if (Buffer.byteLength(value, "utf8") > MAX_TOOL_PACKAGE_STRING_INPUT_BYTES) {
          throw new Error(
            `tool "${snapshot.definition.tool.name}" input "${definition.name}" must not exceed ${MAX_TOOL_PACKAGE_STRING_INPUT_BYTES} UTF-8 bytes`,
          );
        }
        canonical[definition.name] = value;
        break;
      case "enum":
        if (typeof value !== "string" || !definition.values.includes(value)) {
          throw new Error(
            `tool "${snapshot.definition.tool.name}" input "${definition.name}" must be one of its declared enum values`,
          );
        }
        canonical[definition.name] = value;
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
          throw invalidInputType(snapshot, definition.name, "safe integer");
        }
        canonical[definition.name] = value;
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          throw invalidInputType(snapshot, definition.name, "boolean");
        }
        canonical[definition.name] = value;
        break;
    }
  }
  return deepFreeze(canonical);
}

function invalidInputType(
  snapshot: ToolPackageSnapshot,
  name: string,
  expected: string,
): TypeError {
  return new TypeError(
    `tool "${snapshot.definition.tool.name}" input "${name}" must be a ${expected}`,
  );
}

function canonicalArgument(value: ToolPackageInputValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  throw new Error("tool package input could not be rendered canonically");
}

function calculateCanonicalInputDigest(
  snapshot: ToolPackageSnapshot,
  input: CanonicalToolPackageInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        package: {
          name: snapshot.name,
          version: snapshot.version,
          digest: snapshot.digest,
        },
        toolName: snapshot.definition.tool.name,
        input: snapshot.definition.tool.inputs.map((definition) => [
          definition.name,
          input[definition.name],
        ]),
      }),
    )
    .digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
