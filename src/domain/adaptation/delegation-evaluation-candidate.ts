import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { parseDocument } from "yaml";
import { z } from "zod";

import {
  type CapabilityPackageSnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../capability/agent-skills.js";
import {
  bindWorkflowCapabilities,
  collectWorkflowAgentSkillNames,
  collectWorkflowPackageReferences,
  collectWorkflowToolPackageReferences,
  collectWorkflowVerifierPackageReferences,
} from "../capability/workflow-capabilities.js";
import { parseWorkflowSourceText } from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import type { WorkflowSource } from "../workflow/schema.js";
import type { CompiledRunBudget, CompiledWorkflow } from "../workflow/types.js";
import {
  calculateDelegationEvaluationSnapshotDigest,
  type DelegationEvaluationSnapshot,
  type DelegationEvaluationSnapshotContent,
  type DelegationExecutorIdentity,
  delegationExecutorIdentitySchema,
  MAX_DELEGATION_OBJECTIVE_BYTES,
  parseDelegationEvaluationSnapshot,
  parseDelegationExecutorIdentity,
} from "./delegation-evaluation.js";

export {
  calculateDelegationExecutorIdentityDigest,
  type DelegationExecutorIdentity,
  MAX_DELEGATION_OBJECTIVE_BYTES,
} from "./delegation-evaluation.js";

export const DELEGATION_EVALUATION_CANDIDATE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_DELEGATION_EVALUATION_CANDIDATE_BYTES = 1_048_576;

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
const portableRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isPortableRelativePath, "must be a canonical portable relative path");
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const budgetSchema = z
  .object({
    maxNodeStarts: positiveSafeIntegerSchema,
    maxModelTokens: positiveSafeIntegerSchema,
    maxCostUsdMicros: positiveSafeIntegerSchema,
    maxExecutionMs: positiveSafeIntegerSchema,
    maxArtifactBytes: positiveSafeIntegerSchema,
  })
  .strict();
const scopeSchema = z
  .object({
    kind: z.literal("workflow-agent-delegation"),
    workflowId: identifierSchema,
    managerNodeId: identifierSchema,
  })
  .strict();
const sourceSchema = z
  .object({
    apiVersion: z.literal(DELEGATION_EVALUATION_CANDIDATE_API_VERSION),
    kind: z.literal("DelegationEvaluationCandidate"),
    metadata: z.object({ id: identifierSchema, version: semanticVersionSchema }).strict(),
    scope: scopeSchema,
    baseline: z
      .object({
        workflow: z
          .object({
            path: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
          })
          .strict(),
        packageClosureDigest: sha256Schema,
      })
      .strict(),
    delegation: z
      .object({
        objective: z
          .string()
          .refine((value) => value.trim().length > 0, "delegation objective must not be blank")
          .refine(
            (value) => Buffer.byteLength(value, "utf8") <= MAX_DELEGATION_OBJECTIVE_BYTES,
            `delegation objective must not exceed ${MAX_DELEGATION_OBJECTIVE_BYTES} UTF-8 bytes`,
          ),
        child: z
          .object({
            path: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
            resultNodeId: identifierSchema,
            resultSchemaDigest: sha256Schema,
            budget: budgetSchema,
          })
          .strict(),
        executor: delegationExecutorIdentitySchema,
        maxDepth: z.literal(1),
        maxCalls: z.literal(1),
      })
      .strict(),
  })
  .strict();

export type DelegationEvaluationCandidateSource = Readonly<z.infer<typeof sourceSchema>>;

export interface DelegationEvaluationCandidateIdentity {
  readonly version: 1;
  readonly kind: "delegation-evaluation-candidate";
  readonly id: string;
  readonly candidateVersion: string;
  readonly scope: DelegationEvaluationCandidateSource["scope"];
  readonly manifest: { readonly provenance: string; readonly sourceSha256: string };
  readonly baseline: {
    readonly workflow: {
      readonly provenance: string;
      readonly sourceSha256: string;
      readonly workflowDigest: string;
    };
    readonly packageClosureDigest: string;
  };
  readonly delegation: {
    readonly objective: { readonly bytes: number; readonly sha256: string };
    readonly child: {
      readonly workflowId: string;
      readonly provenance: string;
      readonly sourceSha256: string;
      readonly workflowDigest: string;
      readonly resultNodeId: string;
      readonly resultSchemaDigest: string;
      readonly budget: Required<CompiledRunBudget>;
    };
    readonly executor: DelegationExecutorIdentity;
    readonly maxDepth: 1;
    readonly maxCalls: 1;
  };
  readonly snapshotDigest: string;
  readonly candidateDigest: string;
}

const identitySchema: z.ZodType<DelegationEvaluationCandidateIdentity> = z
  .object({
    version: z.literal(1),
    kind: z.literal("delegation-evaluation-candidate"),
    id: identifierSchema,
    candidateVersion: semanticVersionSchema,
    scope: scopeSchema,
    manifest: z
      .object({ provenance: portableRelativePathSchema, sourceSha256: sha256Schema })
      .strict(),
    baseline: z
      .object({
        workflow: z
          .object({
            provenance: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
          })
          .strict(),
        packageClosureDigest: sha256Schema,
      })
      .strict(),
    delegation: z
      .object({
        objective: z
          .object({
            bytes: z.number().int().positive().max(MAX_DELEGATION_OBJECTIVE_BYTES),
            sha256: sha256Schema,
          })
          .strict(),
        child: z
          .object({
            workflowId: identifierSchema,
            provenance: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
            resultNodeId: identifierSchema,
            resultSchemaDigest: sha256Schema,
            budget: budgetSchema,
          })
          .strict(),
        executor: delegationExecutorIdentitySchema,
        maxDepth: z.literal(1),
        maxCalls: z.literal(1),
      })
      .strict(),
    snapshotDigest: sha256Schema,
    candidateDigest: sha256Schema,
  })
  .strict();

export interface DelegationEvaluationCandidateProjectionInput {
  readonly manifestProvenance: string;
  readonly sourceSha256: string;
  readonly source: DelegationEvaluationCandidateSource;
  readonly baseline: {
    readonly provenance: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly source: WorkflowSource;
    readonly compiled: CompiledWorkflow;
    readonly packages: readonly CapabilityPackageSnapshot[];
  };
  readonly child: {
    readonly provenance: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly source: WorkflowSource;
    readonly compiled: CompiledWorkflow;
  };
  readonly executor: DelegationExecutorIdentity;
}

export interface ProjectedDelegationEvaluationCandidate {
  readonly identity: DelegationEvaluationCandidateIdentity;
  readonly snapshot: DelegationEvaluationSnapshot;
}

export type DelegationEvaluationCandidateErrorCode =
  | "identity_mismatch"
  | "invalid_child"
  | "invalid_projection"
  | "invalid_schema"
  | "invalid_target"
  | "invalid_yaml"
  | "limit_exceeded";

export class DelegationEvaluationCandidateError extends Error {
  override readonly name = "DelegationEvaluationCandidateError";

  constructor(
    readonly code: DelegationEvaluationCandidateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${boundedText(message, 8_192)}`, options);
  }
}

export function parseDelegationEvaluationCandidateText(
  text: string,
  sourceName = "delegation evaluation candidate",
): DelegationEvaluationCandidateSource {
  if (Buffer.byteLength(text, "utf8") > MAX_DELEGATION_EVALUATION_CANDIDATE_BYTES) {
    throw new DelegationEvaluationCandidateError(
      "limit_exceeded",
      `candidate exceeds ${MAX_DELEGATION_EVALUATION_CANDIDATE_BYTES} UTF-8 bytes`,
    );
  }
  let input: unknown;
  try {
    const document = parseDocument(text, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new DelegationEvaluationCandidateError(
        "invalid_yaml",
        `${sourceName}: ${boundedMessages(document.errors.map((error) => error.message))}`,
      );
    }
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof DelegationEvaluationCandidateError) throw error;
    throw new DelegationEvaluationCandidateError("invalid_yaml", `${sourceName} cannot be parsed`, {
      cause: error,
    });
  }
  const parsed = sourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new DelegationEvaluationCandidateError(
      "invalid_schema",
      `${sourceName}: ${boundedMessages(
        parsed.error.issues.map(
          (issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`,
        ),
      )}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

export function parseDelegationEvaluationCandidateIdentity(
  input: unknown,
): DelegationEvaluationCandidateIdentity {
  const parsed = identitySchema.safeParse(input);
  if (!parsed.success) {
    throw new DelegationEvaluationCandidateError(
      "identity_mismatch",
      `delegation candidate identity is invalid: ${boundedMessages(
        parsed.error.issues.map(
          (issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`,
        ),
      )}`,
    );
  }
  const identity = parsed.data;
  const { candidateDigest: _candidateDigest, ...withoutDigest } = identity;
  if (calculateDelegationEvaluationCandidateDigest(withoutDigest) !== identity.candidateDigest) {
    throw new DelegationEvaluationCandidateError(
      "identity_mismatch",
      "delegation candidate identity digest does not match",
    );
  }
  return deepFreeze(identity);
}

export function calculateDelegationEvaluationCandidateDigest(
  input: Omit<DelegationEvaluationCandidateIdentity, "candidateDigest">,
): string {
  return sha256(canonicalize(input));
}

export function projectDelegationEvaluationCandidate(
  input: DelegationEvaluationCandidateProjectionInput,
): ProjectedDelegationEvaluationCandidate {
  validateSha256(input.sourceSha256, "candidate source");
  validateSha256(input.baseline.sourceSha256, "baseline workflow source");
  validateSha256(input.child.sourceSha256, "child workflow source");
  const sourceExecutor = parseDelegationExecutorIdentity(input.source.delegation.executor);
  const currentExecutor = parseDelegationExecutorIdentity(input.executor);
  if (!isDeepStrictEqual(sourceExecutor, currentExecutor)) {
    throw new DelegationEvaluationCandidateError(
      "identity_mismatch",
      "delegation candidate executor does not match the admitted embedded Pi executor",
    );
  }

  const packageClosureDigest = calculateCapabilitySnapshotDigest(input.baseline.packages);
  const packageSnapshot =
    input.baseline.packages.length === 0
      ? undefined
      : validateCapabilitySnapshot({
          version: 1,
          packages: input.baseline.packages,
          digest: packageClosureDigest,
        });
  try {
    bindWorkflowCapabilities(input.baseline.compiled, packageSnapshot, { allowUnexpected: true });
    bindWorkflowCapabilities(input.child.compiled, packageSnapshot, { allowUnexpected: true });
    assertNoUnusedPackages(input.baseline.compiled, input.child.compiled, input.baseline.packages);
  } catch (error) {
    throw new DelegationEvaluationCandidateError(
      "identity_mismatch",
      "delegation candidate package closure does not bind the root and child workflows",
      { cause: error },
    );
  }

  const baselineDigest = calculateWorkflowDigest(input.baseline.compiled);
  const childDigest = calculateWorkflowDigest(input.child.compiled);
  if (
    sha256(input.baseline.sourceText) !== input.baseline.sourceSha256 ||
    sha256(input.child.sourceText) !== input.child.sourceSha256 ||
    !isDeepStrictEqual(
      normalizeJson(parseWorkflowSourceText(input.baseline.sourceText, input.baseline.provenance)),
      normalizeJson(input.baseline.source),
    ) ||
    !isDeepStrictEqual(
      normalizeJson(parseWorkflowSourceText(input.child.sourceText, input.child.provenance)),
      normalizeJson(input.child.source),
    ) ||
    input.source.baseline.workflow.path !== input.baseline.provenance ||
    input.source.baseline.workflow.sourceSha256 !== input.baseline.sourceSha256 ||
    input.source.baseline.workflow.workflowDigest !== baselineDigest ||
    input.source.baseline.packageClosureDigest !== packageClosureDigest ||
    input.source.delegation.child.path !== input.child.provenance ||
    input.source.delegation.child.sourceSha256 !== input.child.sourceSha256 ||
    input.source.delegation.child.workflowDigest !== childDigest ||
    input.baseline.compiled.id !== input.source.scope.workflowId ||
    input.baseline.source.metadata.id !== input.source.scope.workflowId
  ) {
    throw new DelegationEvaluationCandidateError(
      "identity_mismatch",
      "delegation candidate sources do not match their admitted identities",
    );
  }

  const manager = input.baseline.compiled.nodes.find(
    (node) => node.id === input.source.scope.managerNodeId,
  );
  if (
    manager?.type !== "agent" ||
    manager.agent.recovery !== undefined ||
    input.baseline.compiled.concurrency?.maxNodes !== 1 ||
    input.baseline.compiled.nodes.some((node) => node.type === "child")
  ) {
    throw new DelegationEvaluationCandidateError(
      "invalid_target",
      "delegation candidate requires one non-retrying local manager in a sequential root workflow without child nodes",
    );
  }

  const childResults = input.child.compiled.nodes.filter((node) => node.type === "result");
  const result = childResults.find(
    (node) => node.id === input.source.delegation.child.resultNodeId,
  );
  if (
    childResults.length !== 1 ||
    result?.type !== "result" ||
    result.result.schemaDigest !== input.source.delegation.child.resultSchemaDigest ||
    input.child.compiled.nodes.some(
      (node) =>
        node.type === "child" ||
        node.type === "approval" ||
        (node.type === "agent" && node.agent.recovery !== undefined),
    ) ||
    !input.child.compiled.nodes.some(
      (node) =>
        node.type === "agent" ||
        (node.type === "verifier" &&
          (node.verifier.kind === "model" || node.verifier.kind === "packaged-model")),
    ) ||
    !sameCompleteBudget(input.child.compiled.budget, input.source.delegation.child.budget)
  ) {
    throw new DelegationEvaluationCandidateError(
      "invalid_child",
      "delegation child must be bounded, non-recursive, non-waiting, non-retrying, model-backed, and return one exact typed result",
    );
  }
  assertParentHeadroom(input.baseline.compiled.budget, input.source.delegation.child.budget);

  const objective = Object.freeze({
    text: input.source.delegation.objective,
    bytes: Buffer.byteLength(input.source.delegation.objective, "utf8"),
    sha256: sha256(input.source.delegation.objective),
  });
  const snapshotContent: DelegationEvaluationSnapshotContent = {
    version: 1,
    kind: "delegation-evaluation-v1",
    target: {
      workflowId: input.source.scope.workflowId,
      managerNodeId: input.source.scope.managerNodeId,
    },
    objective,
    child: {
      workflowId: input.child.compiled.id,
      sourceText: input.child.sourceText,
      sourceSha256: input.child.sourceSha256,
      workflowDigest: childDigest,
      resultNodeId: result.id,
      resultSchemaDigest: result.result.schemaDigest,
      budget: requiredBudget(input.child.compiled.budget),
      packageClosureDigest,
    },
    executor: currentExecutor,
    maxDepth: 1,
    maxCalls: 1,
  };
  const snapshotDigest = calculateDelegationEvaluationSnapshotDigest(snapshotContent);
  const identityWithoutDigest: Omit<DelegationEvaluationCandidateIdentity, "candidateDigest"> = {
    version: 1,
    kind: "delegation-evaluation-candidate",
    id: input.source.metadata.id,
    candidateVersion: input.source.metadata.version,
    scope: input.source.scope,
    manifest: {
      provenance: input.manifestProvenance,
      sourceSha256: input.sourceSha256,
    },
    baseline: {
      workflow: {
        provenance: input.baseline.provenance,
        sourceSha256: input.baseline.sourceSha256,
        workflowDigest: baselineDigest,
      },
      packageClosureDigest,
    },
    delegation: {
      objective: { bytes: objective.bytes, sha256: objective.sha256 },
      child: {
        workflowId: input.child.compiled.id,
        provenance: input.child.provenance,
        sourceSha256: input.child.sourceSha256,
        workflowDigest: childDigest,
        resultNodeId: result.id,
        resultSchemaDigest: result.result.schemaDigest,
        budget: requiredBudget(input.child.compiled.budget),
      },
      executor: currentExecutor,
      maxDepth: 1,
      maxCalls: 1,
    },
    snapshotDigest,
  };
  const candidateDigest = calculateDelegationEvaluationCandidateDigest(identityWithoutDigest);
  const identity = parseDelegationEvaluationCandidateIdentity({
    ...identityWithoutDigest,
    candidateDigest,
  });
  const snapshot = parseDelegationEvaluationSnapshot({
    ...snapshotContent,
    candidateDigest,
    snapshotDigest,
  });
  return deepFreeze({ identity, snapshot });
}

function assertParentHeadroom(
  parent: CompiledRunBudget | undefined,
  child: Required<CompiledRunBudget>,
): void {
  const completeParent = requiredBudget(parent);
  const unavailable = [
    completeParent.maxNodeStarts < child.maxNodeStarts + 1 ? "nodeStarts" : null,
    completeParent.maxModelTokens < child.maxModelTokens ? "modelTokens" : null,
    completeParent.maxCostUsdMicros < child.maxCostUsdMicros ? "modelCostUsdMicros" : null,
    completeParent.maxExecutionMs < child.maxExecutionMs ? "executionMs" : null,
    completeParent.maxArtifactBytes < child.maxArtifactBytes ? "artifactBytes" : null,
  ].filter((value): value is string => value !== null);
  if (unavailable.length > 0) {
    throw new DelegationEvaluationCandidateError(
      "invalid_child",
      `delegation child ceiling exceeds root workflow headroom for ${unavailable.join(", ")}`,
    );
  }
}

function requiredBudget(budget: CompiledRunBudget | undefined): Required<CompiledRunBudget> {
  if (
    budget?.maxNodeStarts === undefined ||
    budget.maxModelTokens === undefined ||
    budget.maxCostUsdMicros === undefined ||
    budget.maxExecutionMs === undefined ||
    budget.maxArtifactBytes === undefined
  ) {
    throw new DelegationEvaluationCandidateError(
      "invalid_child",
      "delegation root and child workflows require all five budget ceilings",
    );
  }
  return Object.freeze({ ...budget }) as Required<CompiledRunBudget>;
}

function sameCompleteBudget(
  actual: CompiledRunBudget | undefined,
  expected: Required<CompiledRunBudget>,
): boolean {
  return (
    actual?.maxNodeStarts === expected.maxNodeStarts &&
    actual.maxModelTokens === expected.maxModelTokens &&
    actual.maxCostUsdMicros === expected.maxCostUsdMicros &&
    actual.maxExecutionMs === expected.maxExecutionMs &&
    actual.maxArtifactBytes === expected.maxArtifactBytes
  );
}

function assertNoUnusedPackages(
  root: CompiledWorkflow,
  child: CompiledWorkflow,
  packages: readonly CapabilityPackageSnapshot[],
): void {
  const skills = new Set([
    ...collectWorkflowAgentSkillNames(root),
    ...collectWorkflowAgentSkillNames(child),
  ]);
  const verifiers = [
    ...collectWorkflowVerifierPackageReferences(root),
    ...collectWorkflowVerifierPackageReferences(child),
  ];
  const tools = [
    ...collectWorkflowToolPackageReferences(root),
    ...collectWorkflowToolPackageReferences(child),
  ];
  const workflows = [
    ...collectWorkflowPackageReferences(root),
    ...collectWorkflowPackageReferences(child),
  ];
  for (const item of packages) {
    const selected =
      item.kind === "agent-skill"
        ? skills.has(item.name)
        : item.kind === "verifier-package"
          ? verifiers.some((value) => value.name === item.name && value.version === item.version)
          : item.kind === "tool-package"
            ? tools.some((value) => value.name === item.name && value.version === item.version)
            : item.kind === "workflow-package"
              ? workflows.some(
                  (value) =>
                    value.name === item.name &&
                    value.version === item.version &&
                    value.digest === item.digest,
                )
              : false;
    if (!selected) throw new Error("delegation package closure contains an unused package");
  }
}

function normalizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new DelegationEvaluationCandidateError("identity_mismatch", `${label} digest is invalid`);
  }
}

function isPortableRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
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
  throw new DelegationEvaluationCandidateError(
    "invalid_projection",
    "delegation candidate identity is not canonical JSON",
  );
}

function boundedMessages(messages: readonly string[]): string {
  const retained = messages.slice(0, 12).map((message) => boundedText(message, 512));
  return `${retained.join("; ")}${messages.length > retained.length ? "; additional diagnostics omitted" : ""}`;
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
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
