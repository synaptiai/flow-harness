import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import type { CompiledWorkflow } from "../workflow/types.js";

export const MAX_SUPPLEMENTAL_MEMORY_ENTRIES = 16;
export const MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES = 16_384;
export const MAX_SUPPLEMENTAL_MEMORY_TARGET_BYTES = 16_384;
export const MAX_SUPPLEMENTAL_MEMORY_STATE_BYTES = 65_536;

const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z
  .object({
    workflowId: identifierSchema,
    childPath: z.array(identifierSchema).max(8),
    agentNodeId: identifierSchema,
  })
  .strict();
export const supplementalMemoryEntrySchema = z
  .object({
    id: identifierSchema,
    target: targetSchema,
    bytes: z.number().int().positive().max(MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES),
    sha256: sha256Schema,
    contentBase64: z.string().max(Math.ceil((MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES * 4) / 3) + 4),
  })
  .strict();

export interface SupplementalMemoryTarget {
  readonly workflowId: string;
  readonly childPath: readonly string[];
  readonly agentNodeId: string;
}

export interface SupplementalMemoryEntryInput {
  readonly id: string;
  readonly target: SupplementalMemoryTarget;
  readonly content: string;
}

export interface SupplementalMemoryEntry {
  readonly id: string;
  readonly target: SupplementalMemoryTarget;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentBase64: string;
}

export type SupplementalMemoryErrorCode =
  | "identity_mismatch"
  | "invalid_schema"
  | "invalid_target"
  | "limit_exceeded";

export class SupplementalMemoryError extends Error {
  override readonly name = "SupplementalMemoryError";

  constructor(
    readonly code: SupplementalMemoryErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function createSupplementalMemoryEntries(
  input: readonly SupplementalMemoryEntryInput[],
  workflow: CompiledWorkflow,
): readonly SupplementalMemoryEntry[] {
  if (input.length > MAX_SUPPLEMENTAL_MEMORY_ENTRIES) {
    throw new SupplementalMemoryError(
      "limit_exceeded",
      `supplemental memory exceeds ${MAX_SUPPLEMENTAL_MEMORY_ENTRIES} entries`,
    );
  }
  const entries = input.map((item) => {
    const parsed = z
      .object({ id: identifierSchema, target: targetSchema, content: z.string() })
      .strict()
      .safeParse(item);
    if (!parsed.success) {
      throw new SupplementalMemoryError("invalid_schema", "supplemental memory entry is invalid");
    }
    const content = Buffer.from(parsed.data.content, "utf8");
    if (
      content.toString("utf8") !== parsed.data.content ||
      parsed.data.content.trim().length === 0
    ) {
      throw new SupplementalMemoryError(
        "invalid_schema",
        "supplemental memory content must be non-blank valid UTF-8",
      );
    }
    if (content.byteLength > MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES) {
      throw new SupplementalMemoryError(
        "limit_exceeded",
        `supplemental memory entry exceeds ${MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES} UTF-8 bytes`,
      );
    }
    assertTarget(workflow, parsed.data.target);
    return {
      id: parsed.data.id,
      target: {
        workflowId: parsed.data.target.workflowId,
        childPath: Object.freeze([...parsed.data.target.childPath]),
        agentNodeId: parsed.data.target.agentNodeId,
      },
      bytes: content.byteLength,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    };
  });
  entries.sort((left, right) => entryKey(left).localeCompare(entryKey(right)));
  return validateEntrySet(entries, workflow, true);
}

export function parseSupplementalMemoryEntries(
  input: readonly unknown[],
  workflow: CompiledWorkflow,
): readonly SupplementalMemoryEntry[] {
  if (input.length > MAX_SUPPLEMENTAL_MEMORY_ENTRIES) {
    throw new SupplementalMemoryError(
      "limit_exceeded",
      `supplemental memory exceeds ${MAX_SUPPLEMENTAL_MEMORY_ENTRIES} entries`,
    );
  }
  const entries = input.map((item) => {
    const parsed = supplementalMemoryEntrySchema.safeParse(item);
    if (!parsed.success) {
      throw new SupplementalMemoryError("invalid_schema", "supplemental memory entry is invalid");
    }
    const content = decodeCanonicalBase64(parsed.data.contentBase64);
    if (
      content.byteLength !== parsed.data.bytes ||
      sha256(content) !== parsed.data.sha256 ||
      decodeUtf8(content).trim().length === 0
    ) {
      throw new SupplementalMemoryError(
        "identity_mismatch",
        "supplemental memory content identity does not match",
      );
    }
    assertTarget(workflow, parsed.data.target);
    return {
      ...parsed.data,
      target: {
        ...parsed.data.target,
        childPath: Object.freeze([...parsed.data.target.childPath]),
      },
    };
  });
  return validateEntrySet(entries, workflow, false);
}

export function supplementalMemoryContent(entry: SupplementalMemoryEntry): string {
  const content = decodeCanonicalBase64(entry.contentBase64);
  if (content.byteLength !== entry.bytes || sha256(content) !== entry.sha256) {
    throw new SupplementalMemoryError(
      "identity_mismatch",
      "supplemental memory content identity does not match",
    );
  }
  return decodeUtf8(content);
}

export function renderSupplementalMemoryBlock(
  entries: readonly SupplementalMemoryEntry[],
  target: SupplementalMemoryTarget,
): string | undefined {
  const selected = entries.filter((entry) => sameTarget(entry.target, target));
  if (selected.length === 0) return undefined;
  return [
    "<supplemental_memory>",
    ...selected.map(
      (entry) =>
        `  <entry id="${escapeXml(entry.id)}" sha256="${entry.sha256}">${escapeXml(
          supplementalMemoryContent(entry),
        )}</entry>`,
    ),
    "</supplemental_memory>",
  ].join("\n");
}

function validateEntrySet(
  entries: readonly SupplementalMemoryEntry[],
  workflow: CompiledWorkflow,
  alreadySorted: boolean,
): readonly SupplementalMemoryEntry[] {
  const keys = entries.map(entryKey);
  if (new Set(keys).size !== keys.length) {
    throw new SupplementalMemoryError(
      "invalid_schema",
      "supplemental memory entries must have unique target and entry identities",
    );
  }
  const sortedKeys = [...keys].sort((left, right) => left.localeCompare(right));
  if (!alreadySorted && !isDeepStrictEqual(keys, sortedKeys)) {
    throw new SupplementalMemoryError(
      "identity_mismatch",
      "supplemental memory entries are not in canonical order",
    );
  }
  let totalBytes = 0;
  const targetBytes = new Map<string, number>();
  for (const entry of entries) {
    assertTarget(workflow, entry.target);
    totalBytes += entry.bytes;
    const target = targetKey(entry.target);
    const nextTargetBytes = (targetBytes.get(target) ?? 0) + entry.bytes;
    if (nextTargetBytes > MAX_SUPPLEMENTAL_MEMORY_TARGET_BYTES) {
      throw new SupplementalMemoryError(
        "limit_exceeded",
        `supplemental memory target exceeds ${MAX_SUPPLEMENTAL_MEMORY_TARGET_BYTES} UTF-8 bytes`,
      );
    }
    targetBytes.set(target, nextTargetBytes);
  }
  if (totalBytes > MAX_SUPPLEMENTAL_MEMORY_STATE_BYTES) {
    throw new SupplementalMemoryError(
      "limit_exceeded",
      `supplemental memory state exceeds ${MAX_SUPPLEMENTAL_MEMORY_STATE_BYTES} UTF-8 bytes`,
    );
  }
  return deepFreeze([...entries]);
}

function assertTarget(workflow: CompiledWorkflow, target: SupplementalMemoryTarget): void {
  if (target.workflowId !== workflow.id) {
    throw new SupplementalMemoryError(
      "invalid_target",
      "supplemental memory belongs to a different root workflow",
    );
  }
  let selected = workflow;
  for (const childNodeId of target.childPath) {
    const node = selected.nodes.find((item) => item.id === childNodeId);
    if (node?.type !== "child" || node.child.workflow.sourcePackage !== undefined) {
      throw new SupplementalMemoryError(
        "invalid_target",
        "supplemental memory child path does not identify an embedded child workflow",
      );
    }
    selected = node.child.workflow;
  }
  if (selected.nodes.find((item) => item.id === target.agentNodeId)?.type !== "agent") {
    throw new SupplementalMemoryError(
      "invalid_target",
      "supplemental memory target does not identify an agent node",
    );
  }
}

function entryKey(entry: Pick<SupplementalMemoryEntry, "id" | "target">): string {
  return `${targetKey(entry.target)}\u0000${entry.id}`;
}

function targetKey(target: SupplementalMemoryTarget): string {
  return `${target.workflowId}\u0000${target.childPath.join("\u0000")}\u0000${target.agentNodeId}`;
}

function sameTarget(left: SupplementalMemoryTarget, right: SupplementalMemoryTarget): boolean {
  return (
    left.workflowId === right.workflowId &&
    left.agentNodeId === right.agentNodeId &&
    left.childPath.length === right.childPath.length &&
    left.childPath.every((item, index) => item === right.childPath[index])
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeCanonicalBase64(value: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new SupplementalMemoryError(
      "identity_mismatch",
      "supplemental memory content is not canonical base64",
    );
  }
  return content;
}

function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new SupplementalMemoryError(
      "invalid_schema",
      "supplemental memory content is not valid UTF-8",
    );
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
