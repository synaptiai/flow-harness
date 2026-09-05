import { z } from "zod";

import { canonicalGitHubRepositoryIdentity, isValidGitHubNodeId } from "./identity.js";
import { isValidExactGitBranchName } from "./plan.js";
import { calculateIssueLifecycleDomainDigest } from "./private-manifest.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const runIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);
const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a canonical lowercase UUID",
  )
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000", "must not be nil");
const repositoryIdentitySchema = z.string().transform((value, context) => {
  try {
    return canonicalGitHubRepositoryIdentity(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});
const githubNodeIdSchema = z
  .string()
  .refine(isValidGitHubNodeId, "must be a bounded non-whitespace GitHub node identity");
const exactBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isValidExactGitBranchName, "must be a valid exact Git branch name");
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const common = {
  version: z.literal(1),
  runId: runIdSchema,
  commandId: uuidSchema,
  repositoryIdentity: repositoryIdentitySchema,
  frozenContractDigest: sha256Schema,
};
const pullRequestIdentity = {
  pullRequestNumber: positiveSafeIntegerSchema,
  pullRequestNodeId: githubNodeIdSchema,
  headBranch: exactBranchSchema,
  headCommit: gitCommitSchema,
  baseBranch: exactBranchSchema,
  baseCommit: gitCommitSchema,
};
const issueExternalEffectDescriptorSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...common,
        kind: z.literal("workspace"),
        baseBranch: exactBranchSchema,
        baseCommit: gitCommitSchema,
        branch: exactBranchSchema,
        workspacePathDigest: sha256Schema,
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("commit"),
        branch: exactBranchSchema,
        workspaceIdentityDigest: sha256Schema,
        parentCommit: gitCommitSchema,
        candidateTreeDigest: sha256Schema,
        messageDigest: sha256Schema,
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("push"),
        branch: exactBranchSchema,
        candidateHead: gitCommitSchema,
        expectedRemoteHead: gitCommitSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("pull_request"),
        issueNumber: positiveSafeIntegerSchema,
        issueNodeId: githubNodeIdSchema,
        headBranch: exactBranchSchema,
        headCommit: gitCommitSchema,
        baseBranch: exactBranchSchema,
        baseCommit: gitCommitSchema,
        titleDigest: sha256Schema,
        bodyDigest: sha256Schema,
        isDraft: z.literal(true),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("pull_request_ready"),
        ...pullRequestIdentity,
        isDraft: z.literal(false),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("merge"),
        pullRequestNumber: positiveSafeIntegerSchema,
        pullRequestNodeId: githubNodeIdSchema,
        candidateHead: gitCommitSchema,
        baseBranch: exactBranchSchema,
        baseCommit: gitCommitSchema,
        gateDigest: sha256Schema,
        method: z.enum(["squash", "merge", "rebase"]),
        deleteBranch: z.boolean(),
      })
      .strict(),
  ])
  .superRefine((descriptor, context) => {
    if (descriptor.kind === "workspace" && descriptor.baseBranch === descriptor.branch) {
      context.addIssue({
        code: "custom",
        path: ["branch"],
        message: "workspace branch must differ from the frozen base branch",
      });
    }
    if (
      (descriptor.kind === "pull_request" || descriptor.kind === "pull_request_ready") &&
      descriptor.headBranch === descriptor.baseBranch
    ) {
      context.addIssue({
        code: "custom",
        path: ["headBranch"],
        message: "pull request head branch must differ from the frozen base branch",
      });
    }
  });

type ParsedIssueExternalEffectDescriptor = z.infer<typeof issueExternalEffectDescriptorSchema>;
declare const issueExternalEffectDescriptorBrand: unique symbol;

export type IssueExternalEffectDescriptor = DeepReadonly<ParsedIssueExternalEffectDescriptor> & {
  readonly [issueExternalEffectDescriptorBrand]: true;
};

export class IssueExternalEffectDescriptorError extends Error {
  override readonly name = "IssueExternalEffectDescriptorError";

  constructor(message: string, options?: ErrorOptions) {
    super(`invalid_schema: ${message}`, options);
  }
}

export function parseIssueExternalEffectDescriptor(input: unknown): IssueExternalEffectDescriptor {
  const parsed = issueExternalEffectDescriptorSchema.safeParse(input);
  if (!parsed.success) {
    throw new IssueExternalEffectDescriptorError(
      parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
        .join("; "),
      { cause: parsed.error },
    );
  }
  return deepFreeze(structuredClone(parsed.data)) as IssueExternalEffectDescriptor;
}

export function calculateIssueExternalEffectOperationDigest(input: unknown): string {
  const descriptor = parseIssueExternalEffectDescriptor(input);
  const { commandId: _commandId, ...semanticOperation } = descriptor;
  return calculateIssueLifecycleDomainDigest(
    `flow.issue.external-effect.${descriptor.kind.replaceAll("_", "-")}.v1`,
    semanticOperation,
  );
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
