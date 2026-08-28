import { parseDocument } from "yaml";
import { z } from "zod";

import { canonicalGitHubRepositoryIdentity } from "./identity.js";

export const MAX_GITHUB_ISSUE_PLAN_BYTES = 65_536;
export const MAX_ISSUE_VERIFICATION_COMMANDS = 32;
export const MAX_ISSUE_HOSTED_CHECKS = 32;
export const MAX_ISSUE_CANDIDATE_PATH_PREFIXES = 64;

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const boundedArgumentSchema = z
  .string()
  .max(4_096)
  .refine((value) => !value.includes("\0"), "command arguments must not contain NUL bytes");
const executableSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(
    /^(?:[A-Za-z0-9][A-Za-z0-9._+-]*|\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+)$/,
    "must be one executable name or absolute executable path without shell syntax",
  );
const commandSchema = z
  .object({
    executable: executableSchema,
    args: z
      .array(boundedArgumentSchema)
      .max(64)
      .refine(
        (args) =>
          args.reduce((bytes, argument) => bytes + Buffer.byteLength(argument), 0) <= 65_536,
        "command arguments must not exceed 65536 UTF-8 bytes in total",
      ),
    timeoutMs: z.number().int().positive().max(86_400_000),
  })
  .strict();
const workflowPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isSafeWorkflowPath, "must be a strict project-relative workflow path");
const candidatePathPrefixSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isSafeCandidatePathPrefix, "must be a strict allowed project path or directory prefix");
const gitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isValidExactGitBranchName, "must be a valid exact Git branch name");
const branchPrefixSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isSafeGitRefPrefix, "must be a valid Flow-owned Git branch prefix");
const hostedCheckSchema = z.string().trim().min(1).max(256);
const githubAppSlugSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const sourceAppSchema = z
  .object({ id: positiveSafeIntegerSchema, slug: githubAppSlugSchema })
  .strict();
const hostedCheckRequirementSchema = z
  .object({ name: hostedCheckSchema, sourceApp: sourceAppSchema })
  .strict();

const githubIssuePlanSchema = z
  .object({
    apiVersion: z.literal("flow.synapti.ai/v1alpha1"),
    kind: z.literal("GitHubIssuePlan"),
    repository: z
      .object({
        expected: z.string().transform((value, context) => {
          try {
            return canonicalGitHubRepositoryIdentity(value);
          } catch (error) {
            context.addIssue({ code: "custom", message: (error as Error).message });
            return z.NEVER;
          }
        }),
        baseBranch: gitRefSchema,
      })
      .strict(),
    branch: z.object({ prefix: branchPrefixSchema }).strict(),
    candidate: z
      .object({
        allowedPathPrefixes: z
          .array(candidatePathPrefixSchema)
          .min(1)
          .max(MAX_ISSUE_CANDIDATE_PATH_PREFIXES)
          .refine(uniqueStrings, "candidate allowed path prefixes must be unique"),
      })
      .strict(),
    implementation: z.object({ workflow: workflowPathSchema }).strict(),
    holdout: z.object({ command: commandSchema }).strict(),
    verification: z
      .array(z.object({ id: identifierSchema, command: commandSchema }).strict())
      .min(1)
      .max(MAX_ISSUE_VERIFICATION_COMMANDS)
      .refine(
        (items) => uniqueStrings(items.map((item) => item.id)),
        "verification command identifiers must be unique",
      ),
    hostedChecks: z
      .object({
        required: z
          .array(hostedCheckRequirementSchema)
          .min(1)
          .max(MAX_ISSUE_HOSTED_CHECKS)
          .refine(
            (items) => uniqueStrings(items.map((item) => item.name)),
            "hosted check names must be unique",
          ),
      })
      .strict(),
    review: z
      .object({
        workflow: workflowPathSchema,
        resultNode: identifierSchema,
        blockingSeverities: z.tuple([z.literal("P1"), z.literal("P2"), z.literal("P3")]),
      })
      .strict(),
    merge: z
      .object({
        method: z.enum(["squash", "merge", "rebase"]),
        deleteBranch: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (plan) => plan.implementation.workflow !== plan.review.workflow,
    "implementation and review workflows must be distinct",
  );

export type GitHubIssuePlan = Readonly<z.output<typeof githubIssuePlanSchema>>;
export type GitHubIssuePlanErrorCode = "invalid_schema" | "invalid_yaml" | "limit_exceeded";

export class GitHubIssuePlanError extends Error {
  override readonly name = "GitHubIssuePlanError";

  constructor(
    readonly code: GitHubIssuePlanErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export function parseGitHubIssuePlanText(
  source: string,
  sourceName = "GitHub issue plan",
): GitHubIssuePlan {
  if (Buffer.byteLength(source, "utf8") > MAX_GITHUB_ISSUE_PLAN_BYTES) {
    throw new GitHubIssuePlanError(
      "limit_exceeded",
      `${sourceName} exceeds ${MAX_GITHUB_ISSUE_PLAN_BYTES} UTF-8 bytes`,
    );
  }
  let input: unknown;
  try {
    const document = parseDocument(source, { prettyErrors: false, strict: true, uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new GitHubIssuePlanError(
        "invalid_yaml",
        `${sourceName}: ${document.errors.map((error) => error.message).join("; ")}`,
      );
    }
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof GitHubIssuePlanError) throw error;
    throw new GitHubIssuePlanError(
      "invalid_yaml",
      `${sourceName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = githubIssuePlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new GitHubIssuePlanError(
      "invalid_schema",
      `${sourceName}: ${parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(structuredClone(parsed.data));
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isSafeProjectPath(value: string): boolean {
  return isSafeProjectPathOrPrefix(value, false);
}

function isSafeWorkflowPath(value: string): boolean {
  if (isSafeProjectPath(value)) return true;
  if (!value.startsWith(".flow/workflows/")) return false;
  const remainder = value.slice(".flow/workflows/".length);
  return isSafeProjectPathOrPrefix(remainder, false);
}

function isSafeCandidatePathPrefix(value: string): boolean {
  return isSafeProjectPathOrPrefix(value, true);
}

function isSafeProjectPathOrPrefix(value: string, allowTrailingSlash: boolean): boolean {
  if (
    value !== value.trim() ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    (!allowTrailingSlash && value.endsWith("/"))
  ) {
    return false;
  }
  const normalized = allowTrailingSlash && value.endsWith("/") ? value.slice(0, -1) : value;
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
        !segment.includes("\0"),
    )
  );
}

export function isValidExactGitBranchName(value: string): boolean {
  return (
    isSafeGitRefPrefix(value) &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    value !== "HEAD" &&
    value !== "@"
  );
}

function isSafeGitRefPrefix(value: string): boolean {
  if (
    value !== value.trim() ||
    value.startsWith("/") ||
    value.startsWith("-") ||
    value.endsWith(".") ||
    value === "@" ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 0x20 ||
        character.charCodeAt(0) === 0x7f ||
        "~^:?*[\\".includes(character),
    )
  ) {
    return false;
  }
  return value
    .split("/")
    .filter((segment) => segment.length > 0)
    .every(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith(".") &&
        !segment.endsWith(".lock"),
    );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
