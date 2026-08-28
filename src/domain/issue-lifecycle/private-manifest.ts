import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalGitHubRepositoryIdentity, isValidGitHubNodeId } from "./identity.js";
import { isValidExactGitBranchName } from "./plan.js";

export const MAX_ISSUE_PRIVATE_BLOB_BYTES = 33_554_432;
export const MAX_ISSUE_PRIVATE_BLOBS = 4_096;
export const MAX_ISSUE_PRIVATE_TOTAL_BYTES = 268_435_456;
export const MAX_ISSUE_ACCEPTANCE_CRITERIA = 64;
export const MAX_ISSUE_CONTROLLER_TIMEOUTS = 64;
export const MAX_ISSUE_COMMAND_TIMEOUT_MS = 86_400_000;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);
const planIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const workflowCriterionIdentifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a canonical lowercase UUID",
  )
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000", "must not be nil");
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(isExactUtcTimestamp, "must be an exact UTC timestamp");
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const githubNodeIdSchema = z
  .string()
  .refine(isValidGitHubNodeId, "must be a bounded non-whitespace GitHub node identity");
const repositoryIdentitySchema = z.string().transform((value, context) => {
  try {
    return canonicalGitHubRepositoryIdentity(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});
const exactBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isValidExactGitBranchName, "must be a valid exact Git branch name");
const mediaTypeSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; [a-z0-9][a-z0-9!#$&^_.+-]*=[a-z0-9][a-z0-9!#$&^_.+-]*)*$/,
    "must be a canonical lowercase media type",
  );
const modelBindingSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    id: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value)),
  })
  .strict();
const workflowBudgetSchema = z
  .object({
    maxNodeStarts: positiveSafeIntegerSchema,
    maxModelTokens: positiveSafeIntegerSchema,
    maxCostUsdMicros: positiveSafeIntegerSchema,
    maxExecutionMs: positiveSafeIntegerSchema,
    maxArtifactBytes: positiveSafeIntegerSchema,
  })
  .strict();
const timeoutSchema = z.number().int().positive().max(MAX_ISSUE_COMMAND_TIMEOUT_MS);
const namedTimeoutSchema = z
  .object({ id: planIdentifierSchema, timeoutMs: timeoutSchema })
  .strict();
const issueBudgetInputSchema = z
  .object({
    implementation: workflowBudgetSchema,
    review: workflowBudgetSchema,
    holdout: z.object({ timeoutMs: timeoutSchema }).strict(),
    verification: z
      .array(namedTimeoutSchema)
      .min(1)
      .max(32)
      .refine(uniqueIds, "verification timeout identifiers must be unique"),
    controller: z
      .array(namedTimeoutSchema)
      .min(1)
      .max(MAX_ISSUE_CONTROLLER_TIMEOUTS)
      .refine(uniqueIds, "controller timeout identifiers must be unique"),
  })
  .strict();
const privateBlobReferenceSchema = z
  .object({
    version: z.literal(1),
    mediaType: mediaTypeSchema,
    byteLength: z.number().int().nonnegative().max(MAX_ISSUE_PRIVATE_BLOB_BYTES),
    digest: sha256Schema,
  })
  .strict();
const candidatePathPrefixSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isSafeCandidatePathPrefix, "must be a strict allowed project path or directory prefix");
const workflowIdentitySchema = z
  .object({
    sourceDigest: sha256Schema,
    templateWorkflowDigest: sha256Schema,
    capabilitySnapshotDigest: sha256Schema.optional(),
    model: modelBindingSchema,
  })
  .strict();
const sourceAppSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    slug: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  })
  .strict();
const verificationSchema = z
  .object({ id: planIdentifierSchema, commandDigest: sha256Schema, timeoutMs: timeoutSchema })
  .strict();
const hostedCheckSchema = z
  .object({ name: z.string().trim().min(1).max(256), sourceApp: sourceAppSchema })
  .strict();

const frozenIssueRunManifestSchema = z
  .object({
    version: z.literal(1),
    runId: identifierSchema,
    initialCommandId: uuidSchema,
    createdAt: timestampSchema,
    repository: z
      .object({
        host: z.literal("github.com"),
        identity: repositoryIdentitySchema,
        nodeId: githubNodeIdSchema,
        canonicalUrl: z.string().url().max(1_024),
      })
      .strict(),
    issue: z
      .object({
        number: positiveSafeIntegerSchema,
        nodeId: githubNodeIdSchema,
        state: z.literal("open"),
        updatedAt: timestampSchema,
        canonicalUrl: z.string().url().max(1_024),
        contentDigest: sha256Schema,
      })
      .strict(),
    base: z
      .object({
        branch: exactBranchSchema,
        commit: gitCommitSchema,
        remoteRef: z.string().min(12).max(266),
      })
      .strict(),
    branch: z.object({ prefix: z.string().min(1).max(128), name: exactBranchSchema }).strict(),
    planDigest: sha256Schema,
    implementationWorkflow: workflowIdentitySchema,
    reviewWorkflow: workflowIdentitySchema.extend({ resultNodeId: planIdentifierSchema }).strict(),
    acceptanceCriteria: z
      .array(workflowCriterionIdentifierSchema)
      .min(1)
      .max(MAX_ISSUE_ACCEPTANCE_CRITERIA)
      .refine(uniqueStrings, "acceptance criterion identifiers must be unique"),
    allowedWritePrefixes: z
      .array(candidatePathPrefixSchema)
      .min(1)
      .max(64)
      .refine(uniqueStrings, "allowed write prefixes must be unique"),
    holdout: z.object({ commandDigest: sha256Schema, timeoutMs: timeoutSchema }).strict(),
    verification: z
      .array(verificationSchema)
      .min(1)
      .max(32)
      .refine(uniqueIds, "verification identifiers must be unique"),
    hostedChecks: z
      .array(hostedCheckSchema)
      .min(1)
      .max(32)
      .refine(uniqueNames, "hosted check names must be unique"),
    merge: z
      .object({ method: z.enum(["squash", "merge", "rebase"]), deleteBranch: z.boolean() })
      .strict(),
    budgets: issueBudgetInputSchema,
    budgetDigest: sha256Schema,
    artifacts: z
      .object({
        issue: privateBlobReferenceSchema,
        plan: privateBlobReferenceSchema,
        implementationWorkflow: privateBlobReferenceSchema,
        reviewWorkflow: privateBlobReferenceSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const expectedRepositoryUrl = `https://github.com/${manifest.repository.identity}`;
    const expectedIssueUrl = `${expectedRepositoryUrl}/issues/${manifest.issue.number}`;
    if (manifest.repository.canonicalUrl !== expectedRepositoryUrl) {
      context.addIssue({
        code: "custom",
        path: ["repository", "canonicalUrl"],
        message: "repository URL must match the canonical repository identity",
      });
    }
    if (manifest.issue.canonicalUrl !== expectedIssueUrl) {
      context.addIssue({
        code: "custom",
        path: ["issue", "canonicalUrl"],
        message: "issue URL must match the canonical repository and issue number",
      });
    }
    if (manifest.base.remoteRef !== `refs/heads/${manifest.base.branch}`) {
      context.addIssue({
        code: "custom",
        path: ["base", "remoteRef"],
        message: "remote base ref must be the exact refs/heads value for the frozen base branch",
      });
    }
    if (
      !isSafeBranchPrefix(manifest.branch.prefix) ||
      !manifest.branch.name.startsWith(manifest.branch.prefix)
    ) {
      context.addIssue({
        code: "custom",
        path: ["branch"],
        message: "Flow branch must use the frozen safe branch prefix",
      });
    }
    if (manifest.branch.name === manifest.base.branch) {
      context.addIssue({
        code: "custom",
        path: ["branch", "name"],
        message: "Flow branch must differ from the frozen base branch",
      });
    }
    if (!sameTimeouts(manifest.verification, manifest.budgets.verification)) {
      context.addIssue({
        code: "custom",
        path: ["budgets", "verification"],
        message: "budget verification timeouts must match the frozen verification commands",
      });
    }
    if (manifest.holdout.timeoutMs !== manifest.budgets.holdout.timeoutMs) {
      context.addIssue({
        code: "custom",
        path: ["budgets", "holdout"],
        message: "budget holdout timeout must match the frozen holdout command",
      });
    }
    if (manifest.budgetDigest !== digestBudget(manifest.budgets)) {
      context.addIssue({
        code: "custom",
        path: ["budgetDigest"],
        message: "budget digest must match the complete frozen budget identity",
      });
    }
  });

type ParsedIssueBudgetInput = z.infer<typeof issueBudgetInputSchema>;
type ParsedFrozenIssueRunManifest = z.infer<typeof frozenIssueRunManifestSchema>;
declare const frozenIssueRunManifestBrand: unique symbol;

export interface IssuePrivateBlobInput {
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface IssuePrivateBlobReference {
  readonly version: 1;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly digest: string;
}

export type IssueBudgetInput = DeepReadonly<ParsedIssueBudgetInput>;

export type FrozenIssueRunManifest = DeepReadonly<ParsedFrozenIssueRunManifest> & {
  readonly [frozenIssueRunManifestBrand]: true;
};

export type IssuePrivateManifestErrorCode = "invalid_schema" | "blob_limit_exceeded";

export class IssuePrivateManifestError extends Error {
  override readonly name = "IssuePrivateManifestError";

  constructor(
    readonly code: IssuePrivateManifestErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export function createIssuePrivateBlobReference(
  input: IssuePrivateBlobInput,
): IssuePrivateBlobReference {
  const mediaType = parseShape(mediaTypeSchema, input.mediaType, "private blob media type");
  if (!(input.bytes instanceof Uint8Array)) {
    throw new IssuePrivateManifestError("invalid_schema", "private blob bytes must be Uint8Array");
  }
  if (input.bytes.byteLength > MAX_ISSUE_PRIVATE_BLOB_BYTES) {
    throw new IssuePrivateManifestError(
      "blob_limit_exceeded",
      `private blob must not exceed ${MAX_ISSUE_PRIVATE_BLOB_BYTES} bytes; one run permits at most ${MAX_ISSUE_PRIVATE_BLOBS} blobs and ${MAX_ISSUE_PRIVATE_TOTAL_BYTES} total bytes`,
    );
  }
  return Object.freeze({
    version: 1,
    mediaType,
    byteLength: input.bytes.byteLength,
    digest: digestBlob(mediaType, input.bytes),
  });
}

export function parseIssuePrivateBlobReference(input: unknown): IssuePrivateBlobReference {
  return deepFreeze(
    structuredClone(parseShape(privateBlobReferenceSchema, input, "private blob reference")),
  );
}

export function verifyIssuePrivateBlob(
  input: IssuePrivateBlobInput,
  expected: unknown,
): IssuePrivateBlobReference {
  const expectedReference = parseIssuePrivateBlobReference(expected);
  const actualReference = createIssuePrivateBlobReference(input);
  if (
    expectedReference.mediaType !== actualReference.mediaType ||
    expectedReference.byteLength !== actualReference.byteLength ||
    expectedReference.digest !== actualReference.digest
  ) {
    throw new IssuePrivateManifestError(
      "invalid_schema",
      "private blob bytes do not match the expected content-addressed reference",
    );
  }
  return actualReference;
}

export function calculateIssueBudgetDigest(input: unknown): string {
  const parsed = parseShape(issueBudgetInputSchema, input, "issue budget identity");
  return digestBudget(parsed);
}

export function parseIssuePrivateManifest(input: unknown): FrozenIssueRunManifest {
  const parsed = parseShape(frozenIssueRunManifestSchema, input, "frozen issue-run manifest");
  return deepFreeze(structuredClone(parsed)) as unknown as FrozenIssueRunManifest;
}

export function calculateIssuePrivateManifestDigest(input: unknown): string {
  const parsed = parseIssuePrivateManifest(input);
  const canonical = {
    ...parsed,
    allowedWritePrefixes: [...parsed.allowedWritePrefixes].sort(compareStrings),
    verification: [...parsed.verification].sort((left, right) => compareStrings(left.id, right.id)),
    hostedChecks: [...parsed.hostedChecks].sort((left, right) =>
      compareStrings(left.name, right.name),
    ),
    budgets: canonicalBudget(parsed.budgets),
  };
  return calculateIssueLifecycleDomainDigest("flow.issue.private-manifest.v1", canonical);
}

/** @internal Shared only by closed issue-lifecycle domain contracts. */
export function calculateIssueLifecycleDomainDigest(domain: string, value: unknown): string {
  if (!/^[a-z][a-z0-9.-]+\.v[1-9][0-9]*$/.test(domain)) {
    throw new IssuePrivateManifestError("invalid_schema", "digest domain is invalid");
  }
  return createHash("sha256").update(`${domain}\0`).update(canonicalize(value)).digest("hex");
}

function digestBudget(budget: IssueBudgetInput): string {
  return calculateIssueLifecycleDomainDigest("flow.issue.budget.v1", canonicalBudget(budget));
}

function canonicalBudget(budget: IssueBudgetInput): ParsedIssueBudgetInput {
  return {
    ...budget,
    verification: [...budget.verification].sort((left, right) => compareStrings(left.id, right.id)),
    controller: [...budget.controller].sort((left, right) => compareStrings(left.id, right.id)),
  };
}

function digestBlob(mediaType: string, bytes: Uint8Array): string {
  return createHash("sha256")
    .update("flow.issue.private-blob.v1\0")
    .update(mediaType)
    .update("\0")
    .update(bytes)
    .digest("hex");
}

function parseShape<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new IssuePrivateManifestError(
      "invalid_schema",
      `${label} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function uniqueIds(items: readonly { readonly id: string }[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

function isExactUtcTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function uniqueNames(items: readonly { readonly name: string }[]): boolean {
  return new Set(items.map((item) => item.name)).size === items.length;
}

function uniqueStrings(items: readonly string[]): boolean {
  return new Set(items).size === items.length;
}

function sameTimeouts(
  left: readonly { readonly id: string; readonly timeoutMs: number }[],
  right: readonly { readonly id: string; readonly timeoutMs: number }[],
): boolean {
  if (left.length !== right.length) return false;
  const expected = new Map(left.map((item) => [item.id, item.timeoutMs]));
  return right.every((item) => expected.get(item.id) === item.timeoutMs);
}

function isSafeBranchPrefix(value: string): boolean {
  return value === value.trim() && isValidExactGitBranchName(`${value}x`);
}

function isSafeCandidatePathPrefix(value: string): boolean {
  if (value !== value.trim() || value.startsWith("/") || value.includes("\\")) return false;
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = normalized.split("/");
  return (
    normalized.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        segment !== ".git" &&
        segment !== ".flow" &&
        !/[\p{Cc}\p{Cf}]/u.test(segment),
    )
  );
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new IssuePrivateManifestError(
        "invalid_schema",
        "canonical numbers must be safe integers",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  throw new IssuePrivateManifestError(
    "invalid_schema",
    `canonical JSON cannot encode ${typeof value}`,
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
