import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalGitHubRepositoryIdentity, isValidGitHubNodeId } from "./identity.js";
import { isValidExactGitBranchName } from "./plan.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const boundedIdentitySchema = z.string().min(1).max(256);
const githubNodeIdSchema = z
  .string()
  .refine(isValidGitHubNodeId, "must be a bounded non-whitespace GitHub node identity");
const githubAppSlugSchema = boundedIdentitySchema.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);
const verificationSchema = z
  .object({
    id: boundedIdentitySchema,
    commandDigest: sha256Schema,
    evidenceDigest: sha256Schema,
    headCommit: gitCommitSchema,
  })
  .strict();
const verificationRequirementSchema = z
  .object({
    id: boundedIdentitySchema,
    commandDigest: sha256Schema,
  })
  .strict();
const sourceAppSchema = z
  .object({ id: positiveSafeIntegerSchema, slug: githubAppSlugSchema })
  .strict();
const hostedCheckSchema = z
  .object({
    name: boundedIdentitySchema,
    runId: positiveSafeIntegerSchema,
    sourceApp: sourceAppSchema,
    conclusion: z.literal("success"),
    headCommit: gitCommitSchema,
    evidenceDigest: sha256Schema,
  })
  .strict();
const hostedCheckRequirementSchema = z
  .object({ name: boundedIdentitySchema, sourceApp: sourceAppSchema })
  .strict();
const exactBranchSchema = boundedIdentitySchema.refine(
  isValidExactGitBranchName,
  "must be a valid exact Git branch name",
);
const mergeGateInputSchema = z
  .object({
    version: z.literal(1),
    runId: boundedIdentitySchema,
    githubHost: z.literal("github.com"),
    repositoryIdentity: z.string().transform((value, context) => {
      try {
        return canonicalGitHubRepositoryIdentity(value);
      } catch (error) {
        context.addIssue({ code: "custom", message: (error as Error).message });
        return z.NEVER;
      }
    }),
    issue: z
      .object({
        nodeId: githubNodeIdSchema,
        number: positiveSafeIntegerSchema,
        state: z.literal("open"),
        digest: sha256Schema,
        updatedAt: timestampSchema,
      })
      .strict(),
    base: z
      .object({
        branch: exactBranchSchema,
        commit: gitCommitSchema,
        observedCommit: gitCommitSchema,
      })
      .strict(),
    branch: exactBranchSchema,
    frozenContractDigest: sha256Schema,
    planDigest: sha256Schema,
    implementationWorkflowDigest: sha256Schema,
    reviewWorkflowDigest: sha256Schema,
    budgetDigest: sha256Schema,
    requirements: z
      .object({
        deterministicVerification: z
          .array(verificationRequirementSchema)
          .min(1)
          .max(32)
          .refine(
            (items) => uniqueBy(items, (item) => item.id),
            "trusted deterministic verification identifiers must be unique",
          ),
        hostedChecks: z
          .array(hostedCheckRequirementSchema)
          .min(1)
          .max(32)
          .refine(
            (items) => uniqueBy(items, (item) => item.name),
            "trusted hosted check names must be unique",
          ),
      })
      .strict(),
    pullRequest: z
      .object({
        number: positiveSafeIntegerSchema,
        nodeId: githubNodeIdSchema,
        state: z.literal("open"),
        isDraft: z.literal(false),
        headBranch: exactBranchSchema,
        headCommit: gitCommitSchema,
        baseBranch: exactBranchSchema,
        baseCommit: gitCommitSchema,
      })
      .strict(),
    merge: z
      .object({ method: z.enum(["squash", "merge", "rebase"]), deleteBranch: z.boolean() })
      .strict(),
    implementation: z
      .object({
        flowRunId: boundedIdentitySchema,
        executionWorkflowDigest: sha256Schema,
        terminalSequence: positiveSafeIntegerSchema,
        evidenceDigest: sha256Schema,
        candidateHead: gitCommitSchema,
      })
      .strict(),
    negativeControl: z
      .object({
        baseCommit: gitCommitSchema,
        baseOutcome: z.literal("failed"),
        candidateHead: gitCommitSchema,
        candidateOutcome: z.literal("passed"),
        evidenceDigest: sha256Schema,
      })
      .strict(),
    deterministicVerification: z.array(verificationSchema).min(1).max(32),
    review: z
      .object({
        flowRunId: boundedIdentitySchema,
        executionWorkflowDigest: sha256Schema,
        terminalSequence: positiveSafeIntegerSchema,
        evidenceDigest: sha256Schema,
        reportDigest: sha256Schema,
        headCommit: gitCommitSchema,
        verdict: z.literal("clear"),
      })
      .strict(),
    hostedChecks: z.array(hostedCheckSchema).min(1).max(32),
    conversation: z
      .object({
        commentsDigest: sha256Schema,
        reviewsDigest: sha256Schema,
        threadsDigest: sha256Schema,
        unresolvedThreadCount: z.literal(0),
      })
      .strict(),
    mergeability: z
      .object({ state: z.literal("mergeable"), evidenceDigest: sha256Schema })
      .strict(),
    gateCreationSequence: positiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((gate, context) => {
    const head = gate.pullRequest.headCommit;
    if (gate.branch === gate.base.branch) {
      context.addIssue({
        code: "custom",
        path: ["branch"],
        message: "derived Flow branch must be distinct from the frozen base branch",
      });
    }
    if (gate.pullRequest.headBranch !== gate.branch) {
      context.addIssue({
        code: "custom",
        path: ["pullRequest", "headBranch"],
        message: "pull request head branch must match the frozen Flow branch",
      });
    }
    if (gate.pullRequest.baseBranch !== gate.base.branch) {
      context.addIssue({
        code: "custom",
        path: ["pullRequest", "baseBranch"],
        message: "pull request base branch must match the frozen base branch",
      });
    }
    if (
      gate.base.observedCommit !== gate.base.commit ||
      gate.pullRequest.baseCommit !== gate.base.commit
    ) {
      context.addIssue({
        code: "custom",
        path: ["pullRequest", "baseCommit"],
        message: "observed and pull request base commits must match the frozen base commit",
      });
    }
    if (
      gate.implementation.candidateHead !== head ||
      gate.negativeControl.candidateHead !== head ||
      gate.review.headCommit !== head ||
      gate.deterministicVerification.some((item) => item.headCommit !== head) ||
      gate.hostedChecks.some((item) => item.headCommit !== head)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pullRequest", "headCommit"],
        message: "all candidate evidence must bind the exact candidate head",
      });
    }
    if (gate.negativeControl.baseCommit !== gate.base.commit) {
      context.addIssue({
        code: "custom",
        path: ["negativeControl", "baseCommit"],
        message: "negative control must bind the frozen base commit",
      });
    }
    if (
      new Set(gate.deterministicVerification.map((item) => item.id)).size !==
      gate.deterministicVerification.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["deterministicVerification"],
        message: "verification evidence identifiers must be unique",
      });
    }
    if (new Set(gate.hostedChecks.map((item) => item.name)).size !== gate.hostedChecks.length) {
      context.addIssue({
        code: "custom",
        path: ["hostedChecks"],
        message: "hosted check names must be unique",
      });
    }
    const requiredVerification = new Map(
      gate.requirements.deterministicVerification.map((item) => [item.id, item.commandDigest]),
    );
    if (
      gate.deterministicVerification.length !== requiredVerification.size ||
      gate.deterministicVerification.some(
        (item) => requiredVerification.get(item.id) !== item.commandDigest,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["deterministicVerification"],
        message: "deterministic verification must match the trusted requirements exactly",
      });
    }
    const requiredHostedChecks = new Map(
      gate.requirements.hostedChecks.map((item) => [item.name, item.sourceApp]),
    );
    if (
      gate.hostedChecks.length !== requiredHostedChecks.size ||
      gate.hostedChecks.some((item) => {
        const required = requiredHostedChecks.get(item.name);
        return (
          required === undefined ||
          required.id !== item.sourceApp.id ||
          required.slug !== item.sourceApp.slug
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["hostedChecks"],
        message: "hosted checks must match the trusted requirements exactly",
      });
    }
  });

export type MergeGateInput = z.input<typeof mergeGateInputSchema>;

export function calculateMergeGateDigest(input: MergeGateInput): string {
  const gate = mergeGateInputSchema.parse(input);
  return digestGate("flow.issue.merge-gate.v1", canonicalGate(gate));
}

/**
 * Calculates the operator-approval identity while excluding per-execution evidence receipts.
 * Fresh verification must reproduce the same claims, but its timestamps and durations differ.
 */
export function calculateMergeApprovalDigest(input: MergeGateInput): string {
  const gate = mergeGateInputSchema.parse(input);
  const canonical = canonicalGate(gate);
  return digestGate("flow.issue.merge-approval.v1", {
    ...canonical,
    negativeControl: {
      baseCommit: canonical.negativeControl.baseCommit,
      baseOutcome: canonical.negativeControl.baseOutcome,
      candidateHead: canonical.negativeControl.candidateHead,
      candidateOutcome: canonical.negativeControl.candidateOutcome,
    },
    deterministicVerification: canonical.deterministicVerification.map(
      ({ evidenceDigest: _evidenceDigest, ...verification }) => verification,
    ),
  });
}

function canonicalGate(gate: ReturnType<typeof mergeGateInputSchema.parse>) {
  return {
    ...gate,
    requirements: {
      deterministicVerification: [...gate.requirements.deterministicVerification].sort(
        (left, right) => compareStrings(left.id, right.id),
      ),
      hostedChecks: [...gate.requirements.hostedChecks].sort((left, right) =>
        compareStrings(left.name, right.name),
      ),
    },
    deterministicVerification: [...gate.deterministicVerification].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    hostedChecks: [...gate.hostedChecks].sort((left, right) =>
      compareStrings(left.name, right.name),
    ),
  };
}

function digestGate(domain: string, gate: unknown): string {
  return createHash("sha256").update(`${domain}\0`).update(canonicalize(gate)).digest("hex");
}

function uniqueBy<T>(items: readonly T[], identity: (item: T) => string): boolean {
  return new Set(items.map(identity)).size === items.length;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("merge gate numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  throw new Error("merge gate contains non-canonical data");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
