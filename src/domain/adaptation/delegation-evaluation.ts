import { createHash } from "node:crypto";

import { z } from "zod";

import { compileWorkflowText } from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import { type CompiledRunBudget, MAX_CHILD_WORKFLOW_SOURCE_BYTES } from "../workflow/types.js";

export const DELEGATION_EVALUATION_SNAPSHOT_KIND = "delegation-evaluation-v1" as const;
export const MAX_DELEGATION_OBJECTIVE_BYTES = 262_144;

const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const semanticVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const packageIdentitySchema = z
  .object({
    package: z.enum(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]),
    version: semanticVersionSchema,
    integrity: z.string().min(1).max(1_024),
    packageContentSha256: sha256Schema,
  })
  .strict();

const executorContentSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("embedded-pi-v1"),
    adapterContractVersion: semanticVersionSchema,
    node: z.object({ version: semanticVersionSchema, executableSha256: sha256Schema }).strict(),
    harness: packageIdentitySchema.extend({
      package: z.literal("@earendil-works/pi-coding-agent"),
    }),
    inference: packageIdentitySchema.extend({ package: z.literal("@earendil-works/pi-ai") }),
    dependencyClosureSha256: sha256Schema,
  })
  .strict();

export const delegationExecutorIdentitySchema = executorContentSchema
  .extend({ identityDigest: sha256Schema })
  .strict()
  .superRefine((identity, context) => {
    const { identityDigest, ...content } = identity;
    if (calculateDelegationExecutorIdentityDigest(content) !== identityDigest) {
      context.addIssue({
        code: "custom",
        path: ["identityDigest"],
        message: "embedded Pi executor identity digest does not match",
      });
    }
  });

const runBudgetSchema = z
  .object({
    maxNodeStarts: positiveSafeIntegerSchema,
    maxModelTokens: positiveSafeIntegerSchema,
    maxCostUsdMicros: positiveSafeIntegerSchema,
    maxExecutionMs: positiveSafeIntegerSchema,
    maxArtifactBytes: positiveSafeIntegerSchema,
  })
  .strict();

const objectiveSchema = z
  .object({
    text: z
      .string()
      .refine((value) => value.trim().length > 0, "delegation objective must not be blank")
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_DELEGATION_OBJECTIVE_BYTES,
        `delegation objective must not exceed ${MAX_DELEGATION_OBJECTIVE_BYTES} UTF-8 bytes`,
      ),
    bytes: z.number().int().positive().max(MAX_DELEGATION_OBJECTIVE_BYTES),
    sha256: sha256Schema,
  })
  .strict()
  .superRefine((objective, context) => {
    if (Buffer.byteLength(objective.text, "utf8") !== objective.bytes) {
      context.addIssue({ code: "custom", path: ["bytes"], message: "byte count does not match" });
    }
    if (sha256(objective.text) !== objective.sha256) {
      context.addIssue({ code: "custom", path: ["sha256"], message: "digest does not match" });
    }
  });

const childSnapshotSchema = z
  .object({
    workflowId: identifierSchema,
    sourceText: z
      .string()
      .min(1)
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_CHILD_WORKFLOW_SOURCE_BYTES,
        `child workflow source must not exceed ${MAX_CHILD_WORKFLOW_SOURCE_BYTES} UTF-8 bytes`,
      ),
    sourceSha256: sha256Schema,
    workflowDigest: sha256Schema,
    resultNodeId: identifierSchema,
    resultSchemaDigest: sha256Schema,
    budget: runBudgetSchema,
    packageClosureDigest: sha256Schema,
  })
  .strict();

const snapshotContentSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal(DELEGATION_EVALUATION_SNAPSHOT_KIND),
    target: z.object({ workflowId: identifierSchema, managerNodeId: identifierSchema }).strict(),
    objective: objectiveSchema,
    child: childSnapshotSchema,
    executor: delegationExecutorIdentitySchema,
    maxDepth: z.literal(1),
    maxCalls: z.literal(1),
  })
  .strict();

const snapshotSchema = snapshotContentSchema
  .extend({ candidateDigest: sha256Schema, snapshotDigest: sha256Schema })
  .strict()
  .superRefine((snapshot, context) => {
    const { candidateDigest: _candidateDigest, snapshotDigest, ...content } = snapshot;
    if (calculateDelegationEvaluationSnapshotDigest(content) !== snapshotDigest) {
      context.addIssue({
        code: "custom",
        path: ["snapshotDigest"],
        message: "delegation snapshot digest does not match",
      });
    }
  });

export type DelegationExecutorIdentityContent = Readonly<z.infer<typeof executorContentSchema>>;
export type DelegationExecutorIdentity = Readonly<z.infer<typeof delegationExecutorIdentitySchema>>;
export type DelegationEvaluationSnapshotContent = Readonly<z.infer<typeof snapshotContentSchema>>;
export type DelegationEvaluationSnapshot = Readonly<z.infer<typeof snapshotSchema>>;

export function calculateDelegationExecutorIdentityDigest(
  input: DelegationExecutorIdentityContent,
): string {
  return sha256(canonicalize(input));
}

export function parseDelegationExecutorIdentity(input: unknown): DelegationExecutorIdentity {
  const parsed = delegationExecutorIdentitySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("embedded Pi executor identity is invalid", { cause: parsed.error });
  }
  return deepFreeze(parsed.data);
}

export function calculateDelegationEvaluationSnapshotDigest(
  input: DelegationEvaluationSnapshotContent,
): string {
  return sha256(canonicalize(input));
}

export function parseDelegationEvaluationSnapshot(input: unknown): DelegationEvaluationSnapshot {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("delegation evaluation snapshot is invalid", { cause: parsed.error });
  }
  const snapshot = parsed.data;
  let compiled: ReturnType<typeof compileWorkflowText>;
  try {
    compiled = compileWorkflowText(snapshot.child.sourceText, "delegation child snapshot");
  } catch (error) {
    throw new Error("delegation evaluation child snapshot cannot be compiled", { cause: error });
  }
  const result = compiled.nodes.find((node) => node.id === snapshot.child.resultNodeId);
  if (
    sha256(snapshot.child.sourceText) !== snapshot.child.sourceSha256 ||
    compiled.id !== snapshot.child.workflowId ||
    calculateWorkflowDigest(compiled) !== snapshot.child.workflowDigest ||
    result?.type !== "result" ||
    result.result.schemaDigest !== snapshot.child.resultSchemaDigest ||
    !sameCompleteBudget(compiled.budget, snapshot.child.budget)
  ) {
    throw new Error("delegation evaluation child snapshot identity does not match");
  }
  return deepFreeze(snapshot);
}

export function createDelegationEvaluationSnapshot(
  input: DelegationEvaluationSnapshotContent & { readonly candidateDigest: string },
): DelegationEvaluationSnapshot {
  const { candidateDigest, ...content } = input;
  return parseDelegationEvaluationSnapshot({
    ...content,
    candidateDigest,
    snapshotDigest: calculateDelegationEvaluationSnapshotDigest(content),
  });
}

function sameCompleteBudget(
  actual: CompiledRunBudget | undefined,
  expected: CompiledRunBudget,
): boolean {
  return (
    actual !== undefined &&
    actual.maxNodeStarts === expected.maxNodeStarts &&
    actual.maxModelTokens === expected.maxModelTokens &&
    actual.maxCostUsdMicros === expected.maxCostUsdMicros &&
    actual.maxExecutionMs === expected.maxExecutionMs &&
    actual.maxArtifactBytes === expected.maxArtifactBytes
  );
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("delegation identity is not canonical JSON");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
