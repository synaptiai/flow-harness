import { z } from "zod";

import { canonicalGitHubRepositoryIdentity, isValidGitHubNodeId } from "./identity.js";
import { isValidExactGitBranchName } from "./plan.js";
import { calculateIssueLifecycleDomainDigest } from "./private-manifest.js";

export const MAX_GITHUB_OBSERVATION_NODES = 4_096;
export const MAX_GITHUB_OBSERVATION_PAGES = 128;
export const MAX_GITHUB_PAGE_NODES = 100;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}$/);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
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
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(isExactUtcTimestamp);
const cursorSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\p{Cc}\p{Cf}\s]/u.test(value), "cursor must be opaque bounded text");
const pageReceiptSchema = z
  .object({
    requestCursor: cursorSchema.nullable(),
    endCursor: cursorSchema.nullable(),
    hasNextPage: z.boolean(),
    nodeCount: z.number().int().nonnegative().max(MAX_GITHUB_PAGE_NODES),
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
const checkSchema = z
  .object({
    runId: positiveSafeIntegerSchema,
    name: z.string().trim().min(1).max(256),
    sourceApp: sourceAppSchema,
    status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]),
    conclusion: z
      .enum([
        "success",
        "failure",
        "neutral",
        "cancelled",
        "skipped",
        "timed_out",
        "action_required",
        "stale",
        "startup_failure",
      ])
      .nullable(),
    headCommit: gitObjectSchema,
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((check, context) => {
    if (check.status === "completed" && (check.conclusion === null || check.completedAt === null)) {
      context.addIssue({
        code: "custom",
        path: ["conclusion"],
        message: "completed check must have a conclusion and completion time",
      });
    }
    if (check.status !== "completed" && (check.conclusion !== null || check.completedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["conclusion"],
        message: "pending check cannot have a conclusion or completion time",
      });
    }
    if (
      check.startedAt !== null &&
      check.completedAt !== null &&
      check.completedAt < check.startedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "check completion time must not precede its start time",
      });
    }
  });
const commentSchema = z
  .object({
    nodeId: githubNodeIdSchema,
    authorDigest: sha256Schema,
    bodyDigest: sha256Schema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((comment) => comment.updatedAt >= comment.createdAt, {
    path: ["updatedAt"],
    message: "comment update time must not precede creation",
  });
const reviewSchema = z
  .object({
    nodeId: githubNodeIdSchema,
    authorDigest: sha256Schema,
    bodyDigest: sha256Schema,
    state: z.enum(["approved", "changes_requested", "commented", "dismissed", "pending"]),
    submittedAt: timestampSchema.nullable(),
    commit: gitObjectSchema,
  })
  .strict()
  .superRefine((review, context) => {
    if ((review.state === "pending") !== (review.submittedAt === null)) {
      context.addIssue({
        code: "custom",
        path: ["submittedAt"],
        message: "only a pending review can omit its submission time",
      });
    }
  });
const threadSchema = z
  .object({
    nodeId: githubNodeIdSchema,
    isResolved: z.boolean(),
    isOutdated: z.boolean(),
    commentsDigest: sha256Schema,
  })
  .strict();

const checksCollectionSchema = completeCollectionSchema(checkSchema, (check) => check.runId);
const commentsCollectionSchema = completeCollectionSchema(
  commentSchema,
  (comment) => comment.nodeId,
);
const reviewsCollectionSchema = completeCollectionSchema(reviewSchema, (review) => review.nodeId);
const threadsCollectionSchema = completeCollectionSchema(threadSchema, (thread) => thread.nodeId);

const githubLifecycleObservationSchema = z
  .object({
    version: z.literal(1),
    repositoryIdentity: repositoryIdentitySchema,
    repositoryNodeId: githubNodeIdSchema,
    observedAt: timestampSchema,
    issue: z
      .object({
        number: positiveSafeIntegerSchema,
        nodeId: githubNodeIdSchema,
        state: z.enum(["open", "closed"]),
        updatedAt: timestampSchema,
        contentDigest: sha256Schema,
      })
      .strict(),
    base: z.object({ branch: exactBranchSchema, commit: gitObjectSchema }).strict(),
    pullRequest: z
      .object({
        number: positiveSafeIntegerSchema,
        nodeId: githubNodeIdSchema,
        state: z.enum(["open", "closed", "merged"]),
        isDraft: z.boolean(),
        headBranch: exactBranchSchema,
        headCommit: gitObjectSchema,
        baseBranch: exactBranchSchema,
        baseCommit: gitObjectSchema,
        mergeability: z.enum(["mergeable", "conflicting", "unknown"]),
      })
      .strict(),
    checks: checksCollectionSchema,
    conversations: z
      .object({
        comments: commentsCollectionSchema,
        reviews: reviewsCollectionSchema,
        threads: threadsCollectionSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (
      observation.issue.updatedAt > observation.observedAt ||
      observation.checks.nodes.some(
        (check) =>
          (check.startedAt !== null && check.startedAt > observation.observedAt) ||
          (check.completedAt !== null && check.completedAt > observation.observedAt),
      ) ||
      observation.conversations.comments.nodes.some(
        (comment) =>
          comment.createdAt > observation.observedAt || comment.updatedAt > observation.observedAt,
      ) ||
      observation.conversations.reviews.nodes.some(
        (review) => review.submittedAt !== null && review.submittedAt > observation.observedAt,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["observedAt"],
        message: "observation time must not predate observed GitHub state",
      });
    }
    if (observation.pullRequest.headBranch === observation.pullRequest.baseBranch) {
      context.addIssue({
        code: "custom",
        path: ["pullRequest", "headBranch"],
        message: "pull request head branch must differ from its base branch",
      });
    }
    if (observation.pullRequest.baseBranch !== observation.base.branch) {
      context.addIssue({
        code: "custom",
        path: ["pullRequest", "baseBranch"],
        message: "pull request base branch must match the observed base branch",
      });
    }
    if (observation.pullRequest.baseCommit !== observation.base.commit) {
      context.addIssue({
        code: "custom",
        path: ["pullRequest", "baseCommit"],
        message: "pull request base commit must match the observed base commit",
      });
    }
    if (
      observation.checks.nodes.some(
        (check) => check.headCommit !== observation.pullRequest.headCommit,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["checks", "nodes"],
        message: "every check must bind the exact pull request head",
      });
    }
  });

const mergeProofSchema = z
  .object({
    version: z.literal(1),
    repositoryIdentity: repositoryIdentitySchema,
    pullRequestNumber: positiveSafeIntegerSchema,
    pullRequestNodeId: githubNodeIdSchema,
    gateDigest: sha256Schema,
    frozenBaseCommit: gitObjectSchema,
    candidateHead: gitObjectSchema,
    mergeCommit: gitObjectSchema,
    observedBaseCommit: gitObjectSchema,
    mergeCommitReachableFromObservedBase: z.boolean(),
    evidenceDigest: sha256Schema,
    method: z.enum(["merge", "squash", "rebase"]),
    proof: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("merge"), parents: z.array(gitObjectSchema).length(2) }).strict(),
      z
        .object({
          kind: z.literal("squash"),
          parent: gitObjectSchema,
          candidateTree: gitObjectSchema,
          mergeCommitTree: gitObjectSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("rebase"),
          firstParent: gitObjectSchema,
          candidateTree: gitObjectSchema,
          mergedTree: gitObjectSchema,
          candidatePatchDigest: sha256Schema,
          mergedPatchDigest: sha256Schema,
          rewrittenCommitCount: positiveSafeIntegerSchema.max(1_024),
        })
        .strict(),
    ]),
    deleteBranchRequested: z.boolean(),
    branchDeleted: z.boolean(),
  })
  .strict()
  .superRefine((proof, context) => {
    if (!proof.mergeCommitReachableFromObservedBase) {
      context.addIssue({
        code: "custom",
        path: ["mergeCommitReachableFromObservedBase"],
        message: "merge commit must be reachable from the observed base",
      });
    }
    if (proof.candidateHead === proof.frozenBaseCommit) {
      context.addIssue({
        code: "custom",
        path: ["candidateHead"],
        message: "approved candidate must differ from the frozen base",
      });
    }
    if (proof.mergeCommit === proof.frozenBaseCommit || proof.mergeCommit === proof.candidateHead) {
      context.addIssue({
        code: "custom",
        path: ["mergeCommit"],
        message: "merge commit must be distinct from the frozen base and approved candidate",
      });
    }
    if (proof.method !== proof.proof.kind) {
      context.addIssue({
        code: "custom",
        path: ["proof", "kind"],
        message: "merge proof kind must match the selected merge method",
      });
    }
    if (proof.proof.kind === "merge") {
      if (!proof.proof.parents.includes(proof.candidateHead)) {
        context.addIssue({
          code: "custom",
          path: ["proof", "parents"],
          message: "approved candidate must be an exact merge parent",
        });
      }
      if (!proof.proof.parents.includes(proof.frozenBaseCommit)) {
        context.addIssue({
          code: "custom",
          path: ["proof", "parents"],
          message: "frozen base must be an exact merge parent",
        });
      }
      if (new Set(proof.proof.parents).size !== proof.proof.parents.length) {
        context.addIssue({
          code: "custom",
          path: ["proof", "parents"],
          message: "merge parents must be unique",
        });
      }
    }
    if (proof.proof.kind === "squash") {
      if (proof.proof.parent !== proof.frozenBaseCommit) {
        context.addIssue({
          code: "custom",
          path: ["proof", "parent"],
          message: "squash commit parent must be the frozen base",
        });
      }
      if (proof.proof.candidateTree !== proof.proof.mergeCommitTree) {
        context.addIssue({
          code: "custom",
          path: ["proof", "mergeCommitTree"],
          message: "squash merge tree must equal the approved candidate tree",
        });
      }
    }
    if (proof.proof.kind === "rebase") {
      if (proof.proof.firstParent !== proof.frozenBaseCommit) {
        context.addIssue({
          code: "custom",
          path: ["proof", "firstParent"],
          message: "rebased series must begin at the frozen base",
        });
      }
      if (proof.proof.candidateTree !== proof.proof.mergedTree) {
        context.addIssue({
          code: "custom",
          path: ["proof", "mergedTree"],
          message: "rebased result tree must equal the approved candidate tree",
        });
      }
      if (proof.proof.candidatePatchDigest !== proof.proof.mergedPatchDigest) {
        context.addIssue({
          code: "custom",
          path: ["proof", "mergedPatchDigest"],
          message: "rebased patch series must equal the approved candidate patch series",
        });
      }
    }
    if (proof.deleteBranchRequested && !proof.branchDeleted) {
      context.addIssue({
        code: "custom",
        path: ["branchDeleted"],
        message: "requested branch deletion must be observed before merge proof settles",
      });
    }
  });

type ParsedGitHubLifecycleObservation = z.infer<typeof githubLifecycleObservationSchema>;
type ParsedIssueMergeProof = z.infer<typeof mergeProofSchema>;
declare const githubLifecycleObservationBrand: unique symbol;
declare const issueMergeProofBrand: unique symbol;

export type GitHubLifecycleObservation = DeepReadonly<ParsedGitHubLifecycleObservation> & {
  readonly [githubLifecycleObservationBrand]: true;
};
export type IssueMergeProof = DeepReadonly<ParsedIssueMergeProof> & {
  readonly [issueMergeProofBrand]: true;
};

export class GitHubLifecycleObservationError extends Error {
  override readonly name = "GitHubLifecycleObservationError";

  constructor(message: string, options?: ErrorOptions) {
    super(`invalid_schema: ${message}`, options);
  }
}

export function parseGitHubLifecycleObservation(input: unknown): GitHubLifecycleObservation {
  return parseAndFreeze(
    githubLifecycleObservationSchema,
    input,
    "GitHub lifecycle observation",
  ) as unknown as GitHubLifecycleObservation;
}

export function calculateGitHubLifecycleObservationDigest(input: unknown): string {
  return calculateIssueLifecycleDomainDigest(
    "flow.issue.github-observation.v1",
    parseGitHubLifecycleObservation(input),
  );
}

export function verifyIssueMergeProof(input: unknown): IssueMergeProof {
  return parseAndFreeze(mergeProofSchema, input, "issue merge proof") as unknown as IssueMergeProof;
}

export function calculateIssueMergeProofDigest(input: unknown): string {
  return calculateIssueLifecycleDomainDigest(
    "flow.issue.merge-proof.v1",
    verifyIssueMergeProof(input),
  );
}

function completeCollectionSchema<
  NodeSchema extends z.ZodTypeAny,
  Identity extends string | number,
>(nodeSchema: NodeSchema, identity: (node: z.infer<NodeSchema>) => Identity) {
  return z
    .object({
      totalCount: nonnegativeSafeIntegerSchema.max(MAX_GITHUB_OBSERVATION_NODES),
      nodes: z.array(nodeSchema).max(MAX_GITHUB_OBSERVATION_NODES),
      pages: z.array(pageReceiptSchema).min(1).max(MAX_GITHUB_OBSERVATION_PAGES),
    })
    .strict()
    .superRefine((collection, context) => {
      if (collection.totalCount !== collection.nodes.length) {
        context.addIssue({
          code: "custom",
          path: ["totalCount"],
          message: "collection total count must equal the complete observed node count",
        });
      }
      if (new Set(collection.nodes.map(identity)).size !== collection.nodes.length) {
        context.addIssue({
          code: "custom",
          path: ["nodes"],
          message: "collection node identities must be unique",
        });
      }
      if (collection.pages[0]?.requestCursor !== null) {
        context.addIssue({
          code: "custom",
          path: ["pages", 0, "requestCursor"],
          message: "pagination must begin without a cursor",
        });
      }
      let observedNodes = 0;
      const seenRequestCursors = new Set<string>();
      for (const [index, page] of collection.pages.entries()) {
        observedNodes += page.nodeCount;
        if (page.requestCursor !== null) {
          if (seenRequestCursors.has(page.requestCursor)) {
            context.addIssue({
              code: "custom",
              path: ["pages", index, "requestCursor"],
              message: "pagination request cursor must be unique and cannot repeat a loop",
            });
          }
          seenRequestCursors.add(page.requestCursor);
        }
        if (page.requestCursor !== null && page.requestCursor === page.endCursor) {
          context.addIssue({
            code: "custom",
            path: ["pages", index, "endCursor"],
            message: "pagination cursor must advance and cannot form a loop",
          });
        }
        const isFinal = index === collection.pages.length - 1;
        if (page.hasNextPage && page.endCursor === null) {
          context.addIssue({
            code: "custom",
            path: ["pages", index, "endCursor"],
            message: "a nonfinal page must provide its next cursor",
          });
        }
        if (!isFinal && !page.hasNextPage) {
          context.addIssue({
            code: "custom",
            path: ["pages", index, "hasNextPage"],
            message: "only the final pagination receipt can end the collection",
          });
        }
        if (isFinal && page.hasNextPage) {
          context.addIssue({
            code: "custom",
            path: ["pages", index, "hasNextPage"],
            message: "final page must prove pagination is complete",
          });
        }
        const next = collection.pages[index + 1];
        if (next !== undefined && next.requestCursor !== page.endCursor) {
          context.addIssue({
            code: "custom",
            path: ["pages", index + 1, "requestCursor"],
            message: "pagination cursor chain must be contiguous",
          });
        }
      }
      if (observedNodes !== collection.nodes.length) {
        context.addIssue({
          code: "custom",
          path: ["pages"],
          message: "pagination node counts must equal the complete observed node count",
        });
      }
    });
}

function parseAndFreeze<T>(schema: z.ZodType<T>, input: unknown, label: string): Readonly<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new GitHubLifecycleObservationError(
      `${label} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(structuredClone(parsed.data));
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
