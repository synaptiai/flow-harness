import { z } from "zod";

import {
  calculateIssueLifecycleDomainDigest,
  type IssuePrivateBlobReference,
  MAX_ISSUE_PRIVATE_TOTAL_BYTES,
  parseIssuePrivateBlobReference,
} from "./private-manifest.js";

export const MAX_ISSUE_PRIVATE_EVIDENCE_ARTIFACTS = 32;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);
const workflowRunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const codeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(isExactUtcTimestamp);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const privateBlobReferenceSchema = z.unknown().transform((value, context) => {
  try {
    return parseIssuePrivateBlobReference(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});
const artifactSchema = z
  .object({ role: identifierSchema, blob: privateBlobReferenceSchema })
  .strict();
const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frozen-input"), frozenContractDigest: sha256Schema }).strict(),
  z.object({ kind: z.literal("workspace"), workspaceIdentityDigest: sha256Schema }).strict(),
  z
    .object({
      kind: z.literal("implementation"),
      candidateHead: gitCommitSchema,
      flowRunId: workflowRunIdSchema,
      executionWorkflowDigest: sha256Schema,
      terminalSequence: positiveSafeIntegerSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("negative-control"),
      baseCommit: gitCommitSchema,
      candidateHead: gitCommitSchema.optional(),
      commandDigest: sha256Schema,
      expectedOutcome: z.enum(["failed", "passed"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("verification"),
      candidateHead: gitCommitSchema,
      checkId: identifierSchema,
      commandDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("review"),
      candidateHead: gitCommitSchema,
      flowRunId: workflowRunIdSchema,
      executionWorkflowDigest: sha256Schema,
      terminalSequence: positiveSafeIntegerSchema,
      reportDigest: sha256Schema,
    })
    .strict(),
  z.object({ kind: z.literal("github-observation"), observationDigest: sha256Schema }).strict(),
  z
    .object({
      kind: z.literal("external-effect"),
      effectId: identifierSchema,
      operationDigest: sha256Schema,
      observationDigest: sha256Schema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("failure"), code: codeSchema, subjectDigest: sha256Schema }).strict(),
  z
    .object({
      kind: z.literal("merge-proof"),
      gateDigest: sha256Schema,
      candidateHead: gitCommitSchema,
      mergeCommit: gitCommitSchema,
      proofDigest: sha256Schema,
    })
    .strict(),
]);
const issuePrivateEvidenceSchema = z
  .object({
    version: z.literal(1),
    runId: identifierSchema,
    recordedAt: timestampSchema,
    kind: z.enum([
      "frozen-input",
      "workspace",
      "implementation",
      "negative-control",
      "verification",
      "review",
      "github-observation",
      "external-effect",
      "failure",
      "merge-proof",
    ]),
    scope: scopeSchema,
    artifacts: z
      .array(artifactSchema)
      .min(1)
      .max(MAX_ISSUE_PRIVATE_EVIDENCE_ARTIFACTS)
      .refine(
        (artifacts) =>
          new Set(artifacts.map((artifact) => artifact.role)).size === artifacts.length,
        "private evidence artifact roles must be unique",
      ),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.kind !== evidence.scope.kind) {
      context.addIssue({
        code: "custom",
        path: ["scope", "kind"],
        message: "private evidence kind must match its typed scope",
      });
    }
    if (
      evidence.scope.kind === "negative-control" &&
      evidence.scope.expectedOutcome === "failed" &&
      evidence.scope.candidateHead !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope", "candidateHead"],
        message: "failed base negative control cannot bind a candidate head",
      });
    }
    const declaredArtifactBytes = evidence.artifacts.reduce(
      (total, artifact) => total + artifact.blob.byteLength,
      0,
    );
    if (declaredArtifactBytes > MAX_ISSUE_PRIVATE_TOTAL_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: `private evidence artifacts must not exceed ${MAX_ISSUE_PRIVATE_TOTAL_BYTES} declared bytes in total`,
      });
    }
  });

type ParsedIssuePrivateEvidence = z.infer<typeof issuePrivateEvidenceSchema>;
declare const issuePrivateEvidenceBrand: unique symbol;

export type IssuePrivateEvidence = DeepReadonly<ParsedIssuePrivateEvidence> & {
  readonly [issuePrivateEvidenceBrand]: true;
};

export class IssuePrivateEvidenceError extends Error {
  override readonly name = "IssuePrivateEvidenceError";

  constructor(message: string, options?: ErrorOptions) {
    super(`invalid_schema: ${message}`, options);
  }
}

export function parseIssuePrivateEvidence(input: unknown): IssuePrivateEvidence {
  const parsed = issuePrivateEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    throw new IssuePrivateEvidenceError(
      parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
        .join("; "),
      { cause: parsed.error },
    );
  }
  return deepFreeze(structuredClone(parsed.data)) as unknown as IssuePrivateEvidence;
}

export function calculateIssuePrivateEvidenceDigest(input: unknown): string {
  const parsed = parseIssuePrivateEvidence(input);
  const canonical = {
    ...parsed,
    artifacts: [...parsed.artifacts].sort((left, right) => compareStrings(left.role, right.role)),
  };
  return calculateIssueLifecycleDomainDigest("flow.issue.private-evidence.v1", canonical);
}

export type { IssuePrivateBlobReference };

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isExactUtcTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

type DeepReadonly<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };
