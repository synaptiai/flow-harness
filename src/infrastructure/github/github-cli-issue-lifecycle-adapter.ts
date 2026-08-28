import { createHash } from "node:crypto";

import { z } from "zod";

import {
  type ExactGitHubPullRequestIdentity,
  type FrozenGitHubIssueIdentity,
  type GitHubExternalEffectResult,
  type GitHubIssueAdmissionPort,
  GitHubIssueHostAdmissionError,
  GitHubIssueLifecycleAdapterError,
  type GitHubIssueLifecycleAdapterErrorCode,
  type GitHubIssueLifecycleEvidence,
  type GitHubIssueLifecyclePort,
  type GitHubLifecycleObservationResult,
  type GitHubOpenIssueObservation,
  type GitHubRemoteMergeResult,
} from "../../application/github-issue-ports.js";
import type { IssueExternalEffectResult } from "../../domain/issue-lifecycle/events.js";
import {
  type IssueExternalEffectDescriptor,
  parseIssueExternalEffectDescriptor,
} from "../../domain/issue-lifecycle/external-effects.js";
import {
  MAX_GITHUB_OBSERVATION_NODES,
  MAX_GITHUB_OBSERVATION_PAGES,
  MAX_GITHUB_PAGE_NODES,
  parseGitHubLifecycleObservation,
} from "../../domain/issue-lifecycle/github-observation.js";
import { canonicalGitHubRepositoryIdentity } from "../../domain/issue-lifecycle/identity.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import type { PinnedGitHubIssueHostExecutable } from "../git/fixed-host-executables.js";
import { StrictHostProcess } from "../git/strict-host-process.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 65_536;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 65_536;
const MERGE_SETTLEMENT_OBSERVATION_ATTEMPTS = 3;
const EVIDENCE_MEDIA_TYPE = "application/vnd.synapti.flow.github-evidence.v1+json" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const nodeIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/\s/u.test(value));
const timestampSchema = z.iso.datetime({ offset: true });
const positiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const repositoryIdentitySchema = z
  .object({
    id: nodeIdSchema,
    nameWithOwner: z.string().min(3).max(202),
    url: z.string().url().max(1_024),
  })
  .strict();
const gitRefSchema = z
  .object({ name: z.string().min(1).max(255), target: z.object({ oid: commitSchema }).strict() })
  .strict();
const issueSchema = z
  .object({
    id: nodeIdSchema,
    number: positiveIntegerSchema,
    state: z.enum(["OPEN", "CLOSED"]),
    title: z.string().max(512),
    body: z.string().max(262_144),
    updatedAt: timestampSchema,
    url: z.string().url().max(1_024),
  })
  .strict();
const pullRequestSchema = z
  .object({
    id: nodeIdSchema,
    number: positiveIntegerSchema,
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    title: z.string().max(512),
    body: z.string().max(262_144),
    headRefName: z.string().min(1).max(255),
    headRefOid: commitSchema,
    baseRefName: z.string().min(1).max(255),
    baseRefOid: commitSchema,
    mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
    merged: z.boolean(),
    mergedAt: timestampSchema.nullable(),
    mergeCommit: z.object({ oid: commitSchema }).strict().nullable(),
    headRepository: repositoryIdentitySchema.nullable(),
    baseRepository: repositoryIdentitySchema,
    autoMergeRequest: z.object({ enabledAt: timestampSchema }).strict().nullable(),
    mergeQueueEntry: z.object({ id: nodeIdSchema }).strict().nullable(),
  })
  .strict();
const pageInfoSchema = z
  .object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).max(512).nullable() })
  .strict();
const coreResponseSchema = z
  .object({
    data: z
      .object({
        repository: repositoryIdentitySchema
          .extend({
            isArchived: z.boolean(),
            issue: issueSchema.nullable(),
            baseRef: gitRefSchema.nullable(),
            branchRef: gitRefSchema.nullable(),
            pullRequest: pullRequestSchema.nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();
const admissionResponseSchema = z
  .object({
    data: z
      .object({
        repository: repositoryIdentitySchema
          .extend({
            name: z.string().min(1).max(100),
            owner: z.object({ login: z.string().min(1).max(39) }).strict(),
            isArchived: z.boolean(),
            defaultBranchRef: z
              .object({ name: z.string().min(1).max(255) })
              .strict()
              .nullable(),
            baseRef: gitRefSchema.nullable(),
            issue: issueSchema.nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();
const searchResponseSchema = z
  .object({
    data: z
      .object({
        repository: repositoryIdentitySchema
          .extend({
            isArchived: z.boolean(),
            issue: issueSchema.nullable(),
            baseRef: gitRefSchema.nullable(),
            branchRef: gitRefSchema.nullable(),
            pullRequests: z
              .object({
                totalCount: z.number().int().nonnegative().max(MAX_GITHUB_OBSERVATION_NODES),
                nodes: z.array(pullRequestSchema).max(MAX_GITHUB_PAGE_NODES),
                pageInfo: pageInfoSchema,
              })
              .strict(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();
const checkRunSchema = z
  .object({
    id: positiveIntegerSchema,
    name: z.string().trim().min(1).max(256),
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
    head_sha: commitSchema,
    started_at: timestampSchema.nullable(),
    completed_at: timestampSchema.nullable(),
    app: z
      .object({
        id: positiveIntegerSchema,
        slug: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      })
      .passthrough(),
  })
  .passthrough();
const checkRunsResponseSchema = z
  .object({
    total_count: z.number().int().nonnegative().max(MAX_GITHUB_OBSERVATION_NODES),
    check_runs: z.array(checkRunSchema).max(MAX_GITHUB_PAGE_NODES),
  })
  .strict();
const commentSchema = z
  .object({
    id: nodeIdSchema,
    author: z
      .object({ login: z.string().min(1).max(256) })
      .strict()
      .nullable(),
    body: z.string().max(262_144),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
const reviewSchema = z
  .object({
    id: nodeIdSchema,
    author: z
      .object({ login: z.string().min(1).max(256) })
      .strict()
      .nullable(),
    body: z.string().max(262_144),
    state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
    submittedAt: timestampSchema.nullable(),
    commit: z.object({ oid: commitSchema }).strict(),
  })
  .strict();
const threadCommentSchema = commentSchema;
const threadSchema = z
  .object({
    id: nodeIdSchema,
    isResolved: z.boolean(),
    isOutdated: z.boolean(),
    comments: z
      .object({
        totalCount: z.number().int().nonnegative().max(MAX_GITHUB_OBSERVATION_NODES),
        nodes: z.array(threadCommentSchema).max(MAX_GITHUB_PAGE_NODES),
        pageInfo: pageInfoSchema,
      })
      .strict(),
  })
  .strict();

type CoreResponse = z.infer<typeof coreResponseSchema>;
type PullRequest = z.infer<typeof pullRequestSchema>;
type PageReceipt = {
  readonly requestCursor: string | null;
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
  readonly nodeCount: number;
};

const CORE_QUERY = `query FlowIssueLifecycleCore($owner: String!, $name: String!, $issue: Int!, $pullRequest: Int!, $baseRef: String!, $headRef: String!) {
  repository(owner: $owner, name: $name) {
    id nameWithOwner url isArchived
    issue(number: $issue) { id number state title body updatedAt url }
    baseRef: ref(qualifiedName: $baseRef) { name target { oid } }
    branchRef: ref(qualifiedName: $headRef) { name target { oid } }
    pullRequest(number: $pullRequest) {
      id number state isDraft title body headRefName headRefOid baseRefName baseRefOid mergeable merged mergedAt
      mergeCommit { oid }
      headRepository { id nameWithOwner url }
      baseRepository { id nameWithOwner url }
      autoMergeRequest { enabledAt }
      mergeQueueEntry { id }
    }
  }
}`;
const ADMISSION_QUERY = `query FlowIssueAdmission($owner: String!, $name: String!, $issue: Int!, $baseRef: String!) {
  repository(owner: $owner, name: $name) {
    id name nameWithOwner owner { login } url isArchived defaultBranchRef { name }
    baseRef: ref(qualifiedName: $baseRef) { name target { oid } }
    issue(number: $issue) { id number state title body updatedAt url }
  }
}`;
const COMMENTS_QUERY = connectionQuery("comments", "id author { login } body createdAt updatedAt");
const REVIEWS_QUERY = connectionQuery(
  "reviews",
  "id author { login } body state submittedAt commit { oid }",
);
const THREADS_QUERY = connectionQuery(
  "reviewThreads",
  "id isResolved isOutdated comments(first: 100) { totalCount nodes { id author { login } body createdAt updatedAt } pageInfo { hasNextPage endCursor } }",
);
const THREAD_COMMENTS_QUERY = `query FlowIssueThreadComments($thread: ID!, $after: String) {
  node(id: $thread) { ... on PullRequestReviewThread { id comments(first: 100, after: $after) { totalCount nodes { id author { login } body createdAt updatedAt } pageInfo { hasNextPage endCursor } } } }
}`;
const SEARCH_QUERY = `query FlowIssuePullRequestSearch($owner: String!, $name: String!, $issue: Int!, $baseRef: String!, $head: String!, $headRef: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    id nameWithOwner url isArchived
    issue(number: $issue) { id number state title body updatedAt url }
    baseRef: ref(qualifiedName: $baseRef) { name target { oid } }
    branchRef: ref(qualifiedName: $headRef) { name target { oid } }
    pullRequests(first: 100, after: $after, headRefName: $head, states: [OPEN, CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { id number state isDraft title body headRefName headRefOid baseRefName baseRefOid mergeable merged mergedAt mergeCommit { oid } headRepository { id nameWithOwner url } baseRepository { id nameWithOwner url } autoMergeRequest { enabledAt } mergeQueueEntry { id } }
    }
  }
}`;
const CREATE_QUERY = `mutation FlowIssueCreatePullRequest($repository: ID!, $base: String!, $head: String!, $title: String!, $body: String!) {
  createPullRequest(input: {repositoryId: $repository, baseRefName: $base, headRefName: $head, title: $title, body: $body, draft: true}) { pullRequest { id number } }
}`;
const READY_QUERY = `mutation FlowIssueReadyPullRequest($pullRequest: ID!) {
  markPullRequestReadyForReview(input: {pullRequestId: $pullRequest}) { pullRequest { id number } }
}`;

export interface GitHubCliIssueLifecycleAdapterOptions {
  readonly ghExecutable: PinnedGitHubIssueHostExecutable;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/** Executes the bounded GitHub portion of one frozen issue lifecycle. */
export class GitHubCliIssueLifecycleAdapter
  implements GitHubIssueAdmissionPort, GitHubIssueLifecyclePort
{
  readonly #now: () => Date;
  readonly #process: StrictHostProcess;
  readonly #cwd: string;

  constructor(options: GitHubCliIssueLifecycleAdapterOptions) {
    this.#cwd = options.cwd;
    this.#now = options.now ?? (() => new Date());
    this.#process = new StrictHostProcess({
      executable: options.ghExecutable,
      environment: githubEnvironment(),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxStdoutBytes: MAX_STDOUT_BYTES,
      maxStderrBytes: MAX_STDERR_BYTES,
    });
  }

  async inspectOpenIssue(
    input: Parameters<GitHubIssueAdmissionPort["inspectOpenIssue"]>[0],
    signal?: AbortSignal,
  ): Promise<GitHubOpenIssueObservation> {
    let identity: ReturnType<typeof splitRepositoryIdentity>;
    try {
      identity = splitRepositoryIdentity(`${input.repository.owner}/${input.repository.name}`);
    } catch {
      throw new GitHubIssueHostAdmissionError("repository_identity_invalid");
    }
    if (
      input.repository.host !== "github.com" ||
      identity.identity !==
        `${input.repository.owner.toLowerCase()}/${input.repository.name.toLowerCase()}`
    ) {
      throw new GitHubIssueHostAdmissionError("repository_identity_invalid");
    }
    await this.#authenticate(signal, true);
    let response: z.infer<typeof admissionResponseSchema>;
    try {
      response = await this.#graphql(
        admissionResponseSchema,
        ADMISSION_QUERY,
        {
          owner: identity.owner,
          name: identity.name,
          issue: input.number,
          baseRef: `refs/heads/${input.baseBranch}`,
        },
        signal,
      );
    } catch (error) {
      throw admissionError(error);
    }
    const repository = response.data.repository;
    if (repository === null) throw new GitHubIssueHostAdmissionError("github_repository_not_found");
    if (
      repository.isArchived ||
      canonicalGitHubRepositoryIdentity(repository.nameWithOwner) !== identity.identity ||
      repository.owner.login.toLowerCase() !== identity.owner ||
      repository.name.toLowerCase() !== identity.name ||
      repository.url !== `https://github.com/${identity.identity}` ||
      repository.defaultBranchRef === null ||
      repository.baseRef?.name !== input.baseBranch
    ) {
      throw new GitHubIssueHostAdmissionError("github_repository_identity_mismatch");
    }
    const issue = repository.issue;
    if (issue === null) throw new GitHubIssueHostAdmissionError("github_issue_not_found");
    if (issue.state !== "OPEN") throw new GitHubIssueHostAdmissionError("github_issue_not_open");
    if (
      issue.number !== input.number ||
      issue.url !== `https://github.com/${identity.identity}/issues/${input.number}`
    ) {
      throw new GitHubIssueHostAdmissionError("github_issue_identity_mismatch");
    }
    return Object.freeze({
      repository: Object.freeze({
        host: "github.com" as const,
        owner: identity.owner,
        name: identity.name,
        nodeId: repository.id,
        canonicalUrl: repository.url,
        defaultBranch: repository.defaultBranchRef.name,
        configuredBase: Object.freeze({
          branch: repository.baseRef.name,
          commit: repository.baseRef.target.oid,
        }),
      }),
      issue: Object.freeze({
        host: "github.com" as const,
        owner: identity.owner,
        name: identity.name,
        nodeId: issue.id,
        number: issue.number,
        state: issue.state,
        title: issue.title,
        body: issue.body,
        updatedAt: normalizeTimestamp(issue.updatedAt),
        canonicalUrl: issue.url,
      }),
    });
  }

  async observeLifecycle(
    expected: FrozenGitHubIssueIdentity & { readonly pullRequest: ExactGitHubPullRequestIdentity },
    signal?: AbortSignal,
  ): Promise<GitHubLifecycleObservationResult> {
    validateExpected(expected);
    await this.#authenticate(signal);
    const core = await this.#core(expected, signal);
    requirePremergeCore(core, expected);
    const checks = await this.#checks(expected, signal);
    rejectHostedCheckCollisions(checks.nodes, expected.hostedChecks);
    const comments = await this.#comments(expected, signal);
    const reviews = await this.#reviews(expected, signal);
    const threads = await this.#threads(expected, signal);
    const finalRepository = requirePremergeCore(await this.#core(expected, signal), expected);
    const observedAt = exactNow(this.#now);
    const observation = parseGitHubLifecycleObservation({
      version: 1,
      repositoryIdentity: expected.repositoryIdentity,
      repositoryNodeId: expected.repositoryNodeId,
      observedAt,
      issue: {
        number: finalRepository.issue.number,
        nodeId: finalRepository.issue.id,
        state: finalRepository.issue.state.toLowerCase(),
        updatedAt: normalizeTimestamp(finalRepository.issue.updatedAt),
        contentDigest: expected.issue.contentDigest,
      },
      base: {
        branch: finalRepository.baseRef.name,
        commit: finalRepository.baseRef.target.oid,
      },
      pullRequest: normalizePullRequest(finalRepository.pullRequest),
      checks,
      conversations: { comments, reviews, threads },
    });
    return Object.freeze({
      observation,
      evidence: evidence({
        kind: "lifecycle-observation",
        observation,
        pullRequestContent: {
          titleDigest: expected.pullRequest.titleDigest,
          bodyDigest: expected.pullRequest.bodyDigest,
        },
      }),
    });
  }

  async ensureDraftPullRequest(
    input: Parameters<GitHubIssueLifecyclePort["ensureDraftPullRequest"]>[0],
    signal?: AbortSignal,
  ): Promise<GitHubExternalEffectResult<"pull_request">> {
    const effect = requireEffect(input.effect, "pull_request");
    validateExpected(input.expected);
    requireDraftEffect(effect, input.expected, input.title, input.body);
    await this.#authenticate(signal);
    let pullRequests = await this.#searchPullRequests(input.expected, signal);
    if (pullRequests.length > 1) {
      throw new GitHubIssueLifecycleAdapterError("pull_request_ambiguous");
    }
    const existing = pullRequests[0];
    if (existing !== undefined) {
      const result = draftResult(
        requireExactDraft(existing, input.expected, effect, input.title, input.body),
      );
      return Object.freeze({
        result,
        reconciled: true,
        evidence: evidence({ kind: "draft-pull-request", reconciled: true, result }),
      });
    }
    const mutationSchema = z
      .object({
        data: z
          .object({
            createPullRequest: z
              .object({
                pullRequest: z.object({ id: nodeIdSchema, number: positiveIntegerSchema }).strict(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      })
      .strict();
    let created: z.infer<typeof mutationSchema>;
    try {
      created = await this.#graphql(
        mutationSchema,
        CREATE_QUERY,
        {
          repository: input.expected.repositoryNodeId,
          base: effect.baseBranch,
          head: effect.headBranch,
          title: input.title,
          body: input.body,
        },
        signal,
        true,
      );
    } catch {
      throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
    }
    if (created.data.createPullRequest === null) {
      throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
    }
    try {
      pullRequests = await this.#searchPullRequests(input.expected, signal);
      if (pullRequests.length !== 1) {
        throw new Error("missing unique pull request proof");
      }
      const exact = requireExactDraft(
        pullRequests[0] as PullRequest,
        input.expected,
        effect,
        input.title,
        input.body,
      );
      if (
        created.data.createPullRequest.pullRequest.id !== exact.id ||
        created.data.createPullRequest.pullRequest.number !== exact.number
      ) {
        throw new Error("created pull request identity mismatch");
      }
      const result = draftResult(exact);
      return Object.freeze({
        result,
        reconciled: false,
        evidence: evidence({ kind: "draft-pull-request", reconciled: false, result }),
      });
    } catch {
      throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
    }
  }

  async observeDraftPullRequest(
    input: Parameters<GitHubIssueLifecyclePort["observeDraftPullRequest"]>[0],
    signal?: AbortSignal,
  ): Promise<GitHubExternalEffectResult<"pull_request"> | null> {
    const effect = requireEffect(input.effect, "pull_request");
    validateExpected(input.expected);
    requireDraftEffect(effect, input.expected, input.title, input.body);
    await this.#authenticate(signal);
    const pullRequests = await this.#searchPullRequests(input.expected, signal);
    if (pullRequests.length > 1) {
      throw new GitHubIssueLifecycleAdapterError("pull_request_ambiguous");
    }
    const existing = pullRequests[0];
    if (existing === undefined) return null;
    const result = draftResult(
      requireExactDraft(existing, input.expected, effect, input.title, input.body),
    );
    return Object.freeze({
      result,
      reconciled: true,
      evidence: evidence({ kind: "draft-pull-request", reconciled: true, result }),
    });
  }

  async ensurePullRequestReady(
    input: Parameters<GitHubIssueLifecyclePort["ensurePullRequestReady"]>[0],
    signal?: AbortSignal,
  ): Promise<GitHubExternalEffectResult<"pull_request_ready">> {
    const effect = requireEffect(input.effect, "pull_request_ready");
    validateExpected(input.expected);
    requireReadyEffect(effect, input.expected);
    await this.#authenticate(signal);
    const before = requirePremergeCore(await this.#core(input.expected, signal), input.expected);
    if (!before.pullRequest.isDraft) {
      const result = readyResult(before.pullRequest);
      return Object.freeze({
        result,
        reconciled: true,
        evidence: evidence({ kind: "ready-pull-request", reconciled: true, result }),
      });
    }
    const mutationSchema = z
      .object({
        data: z
          .object({
            markPullRequestReadyForReview: z
              .object({
                pullRequest: z.object({ id: nodeIdSchema, number: positiveIntegerSchema }).strict(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      })
      .strict();
    try {
      const marked = await this.#graphql(
        mutationSchema,
        READY_QUERY,
        { pullRequest: effect.pullRequestNodeId },
        signal,
        true,
      );
      if (
        marked.data.markPullRequestReadyForReview?.pullRequest.id !== effect.pullRequestNodeId ||
        marked.data.markPullRequestReadyForReview.pullRequest.number !== effect.pullRequestNumber
      ) {
        throw new Error("identity mismatch");
      }
    } catch {
      throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
    }
    try {
      const after = requirePremergeCore(await this.#core(input.expected, signal), input.expected);
      if (after.pullRequest.isDraft) {
        throw new Error("pull request remains draft");
      }
      const result = readyResult(after.pullRequest);
      return Object.freeze({
        result,
        reconciled: false,
        evidence: evidence({ kind: "ready-pull-request", reconciled: false, result }),
      });
    } catch {
      throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
    }
  }

  async mergeExactPullRequest(
    input: Parameters<GitHubIssueLifecyclePort["mergeExactPullRequest"]>[0],
    signal?: AbortSignal,
  ): Promise<GitHubRemoteMergeResult> {
    const effect = requireEffect(input.effect, "merge");
    validateExpected(input.expected);
    requireMergeEffect(effect, input.expected);
    await this.#authenticate(signal);
    const identity = splitRepositoryIdentity(input.expected.repositoryIdentity);
    const beforeCore = await this.#core(input.expected, signal);
    const beforeRepository = beforeCore.data.repository;
    if (beforeRepository?.pullRequest?.merged === true) {
      let result = await this.#settledRemoteMergeResult(
        beforeRepository,
        input.expected,
        effect,
        true,
        false,
        signal,
      );
      if (effect.deleteBranch && !result.outcome.branchDeleted) {
        try {
          await this.#invoke(
            restArguments(
              `/repos/${identity.owner}/${identity.name}/git/refs/heads/${encodeURIComponent(input.expected.headBranch)}`,
              "DELETE",
            ),
            undefined,
            signal,
            true,
          );
          const after = await this.#core(input.expected, signal);
          if (after.data.repository === null) throw new Error("missing repository");
          result = await this.#settledRemoteMergeResult(
            after.data.repository,
            input.expected,
            effect,
            true,
            true,
            signal,
          );
        } catch {
          throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
        }
      }
      return result;
    }
    const before = requirePremergeCore(beforeCore, input.expected);
    if (before.pullRequest.isDraft) {
      throw new GitHubIssueLifecycleAdapterError("pull_request_collision");
    }
    if (before.pullRequest.mergeable === "UNKNOWN") {
      throw new GitHubIssueLifecycleAdapterError("mergeability_unknown");
    }
    if (before.pullRequest.mergeable === "CONFLICTING") {
      throw new GitHubIssueLifecycleAdapterError("merge_conflict");
    }
    const rules = await this.#rules(identity, effect.baseBranch, signal);
    if (rules.some((rule) => rule.type === "merge_queue")) {
      throw new GitHubIssueLifecycleAdapterError("merge_queue_unsupported");
    }
    const arguments_ = [
      "pr",
      "merge",
      String(effect.pullRequestNumber),
      "--repo",
      input.expected.repositoryIdentity,
      `--${effect.method}`,
      "--match-head-commit",
      effect.candidateHead,
    ];
    try {
      await this.#invoke(arguments_, undefined, signal, true);
    } catch {
      throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
    }
    let after: CoreResponse;
    try {
      after = await this.#core(input.expected, signal);
    } catch {
      throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
    }
    let repository = after.data.repository;
    if (repository === null) throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
    let result = await this.#settledRemoteMergeResult(
      repository,
      input.expected,
      effect,
      false,
      false,
      signal,
    );
    if (effect.deleteBranch && !result.outcome.branchDeleted) {
      try {
        await this.#invoke(
          restArguments(
            `/repos/${identity.owner}/${identity.name}/git/refs/heads/${encodeURIComponent(input.expected.headBranch)}`,
            "DELETE",
          ),
          undefined,
          signal,
          true,
        );
        after = await this.#core(input.expected, signal);
      } catch {
        throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
      }
      repository = after.data.repository;
      if (repository === null) {
        throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
      }
      result = await this.#settledRemoteMergeResult(
        repository,
        input.expected,
        effect,
        false,
        true,
        signal,
      );
    }
    return result;
  }

  async observeMergeOutcome(
    input: Parameters<GitHubIssueLifecyclePort["observeMergeOutcome"]>[0],
    signal?: AbortSignal,
  ): Promise<GitHubRemoteMergeResult | null> {
    const effect = requireEffect(input.effect, "merge");
    validateExpected(input.expected);
    requireMergeEffect(effect, input.expected);
    await this.#authenticate(signal);
    const core = await this.#core(input.expected, signal);
    const repository = core.data.repository;
    if (repository === null) throw new GitHubIssueLifecycleAdapterError("identity_mismatch");
    if (repository.pullRequest?.merged !== true) {
      requirePremergeCore(core, input.expected);
      return null;
    }
    return await this.#settledRemoteMergeResult(
      repository,
      input.expected,
      effect,
      true,
      true,
      signal,
    );
  }

  async #authenticate(signal: AbortSignal | undefined, admission = false): Promise<void> {
    try {
      await this.#invoke(
        ["auth", "status", "--active", "--hostname", "github.com"],
        undefined,
        signal,
      );
    } catch (error) {
      if (admission) {
        if (error instanceof GitHubIssueLifecycleAdapterError) {
          if (error.code === "command_failed") {
            throw new GitHubIssueHostAdmissionError("github_authentication_failed");
          }
          throw admissionError(error);
        }
        throw new GitHubIssueHostAdmissionError("github_authentication_failed");
      }
      if (error instanceof GitHubIssueLifecycleAdapterError && error.code !== "command_failed") {
        throw error;
      }
      throw new GitHubIssueLifecycleAdapterError("authentication_failed");
    }
  }

  async #core(
    expected: FrozenGitHubIssueIdentity & { readonly pullRequest: ExactGitHubPullRequestIdentity },
    signal?: AbortSignal,
  ): Promise<CoreResponse> {
    const identity = splitRepositoryIdentity(expected.repositoryIdentity);
    return await this.#graphql(
      coreResponseSchema,
      CORE_QUERY,
      {
        owner: identity.owner,
        name: identity.name,
        issue: expected.issue.number,
        pullRequest: expected.pullRequest.number,
        baseRef: `refs/heads/${expected.base.branch}`,
        headRef: `refs/heads/${expected.headBranch}`,
      },
      signal,
    );
  }

  async #checks(expected: FrozenGitHubIssueIdentity, signal?: AbortSignal) {
    const identity = splitRepositoryIdentity(expected.repositoryIdentity);
    const nodes: z.infer<typeof checkRunSchema>[] = [];
    const pages: PageReceipt[] = [];
    let totalCount: number | undefined;
    for (let page = 1; page <= MAX_GITHUB_OBSERVATION_PAGES; page += 1) {
      const response = await this.#rest(
        checkRunsResponseSchema,
        `/repos/${identity.owner}/${identity.name}/commits/${expected.headCommit}/check-runs?per_page=100&page=${page}`,
        signal,
      );
      totalCount ??= response.total_count;
      if (response.total_count !== totalCount) {
        throw new GitHubIssueLifecycleAdapterError("pagination_incomplete");
      }
      nodes.push(...response.check_runs);
      if (nodes.length > MAX_GITHUB_OBSERVATION_NODES) {
        throw new GitHubIssueLifecycleAdapterError("pagination_limit_exceeded");
      }
      const hasNextPage = nodes.length < totalCount;
      pages.push({
        requestCursor: page === 1 ? null : `page:${page}`,
        endCursor: hasNextPage ? `page:${page + 1}` : null,
        hasNextPage,
        nodeCount: response.check_runs.length,
      });
      if (!hasNextPage) {
        if (nodes.length !== totalCount) {
          throw new GitHubIssueLifecycleAdapterError("pagination_incomplete");
        }
        return {
          totalCount,
          nodes: nodes.map((check) => ({
            runId: check.id,
            name: check.name,
            sourceApp: { id: check.app.id, slug: check.app.slug },
            status: check.status,
            conclusion: check.conclusion,
            headCommit: check.head_sha,
            startedAt: nullableTimestamp(check.started_at),
            completedAt: nullableTimestamp(check.completed_at),
          })),
          pages,
        };
      }
      if (response.check_runs.length === 0) {
        throw new GitHubIssueLifecycleAdapterError("pagination_incomplete");
      }
    }
    throw new GitHubIssueLifecycleAdapterError("pagination_limit_exceeded");
  }

  async #rules(
    identity: { readonly owner: string; readonly name: string },
    branch: string,
    signal?: AbortSignal,
  ): Promise<readonly { readonly type: string }[]> {
    const schema = z
      .array(z.object({ type: z.string().min(1).max(128) }).passthrough())
      .max(MAX_GITHUB_PAGE_NODES);
    const rules: { readonly type: string }[] = [];
    for (let page = 1; page <= MAX_GITHUB_OBSERVATION_PAGES; page += 1) {
      const current = await this.#rest(
        schema,
        `/repos/${identity.owner}/${identity.name}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${page}`,
        signal,
      );
      rules.push(...current.map((rule) => ({ type: rule.type })));
      if (rules.length > MAX_GITHUB_OBSERVATION_NODES) {
        throw new GitHubIssueLifecycleAdapterError("pagination_limit_exceeded");
      }
      if (current.length < MAX_GITHUB_PAGE_NODES) return rules;
    }
    throw new GitHubIssueLifecycleAdapterError("pagination_limit_exceeded");
  }

  async #comments(
    expected: FrozenGitHubIssueIdentity & { readonly pullRequest: ExactGitHubPullRequestIdentity },
    signal?: AbortSignal,
  ) {
    const collection = await this.#graphqlConnection(
      commentSchema,
      "comments",
      COMMENTS_QUERY,
      expected,
      signal,
    );
    return {
      ...collection,
      nodes: collection.nodes.map((comment) => ({
        nodeId: comment.id,
        authorDigest: digestText(comment.author?.login ?? "github:deleted-user"),
        bodyDigest: digestText(comment.body),
        createdAt: normalizeTimestamp(comment.createdAt),
        updatedAt: normalizeTimestamp(comment.updatedAt),
      })),
    };
  }

  async #reviews(
    expected: FrozenGitHubIssueIdentity & { readonly pullRequest: ExactGitHubPullRequestIdentity },
    signal?: AbortSignal,
  ) {
    const collection = await this.#graphqlConnection(
      reviewSchema,
      "reviews",
      REVIEWS_QUERY,
      expected,
      signal,
    );
    return {
      ...collection,
      nodes: collection.nodes.map((review) => ({
        nodeId: review.id,
        authorDigest: digestText(review.author?.login ?? "github:deleted-user"),
        bodyDigest: digestText(review.body),
        state: review.state.toLowerCase(),
        submittedAt: nullableTimestamp(review.submittedAt),
        commit: review.commit.oid,
      })),
    };
  }

  async #threads(
    expected: FrozenGitHubIssueIdentity & { readonly pullRequest: ExactGitHubPullRequestIdentity },
    signal?: AbortSignal,
  ) {
    const collection = await this.#graphqlConnection(
      threadSchema,
      "reviewThreads",
      THREADS_QUERY,
      expected,
      signal,
    );
    const nodes = [];
    for (const thread of collection.nodes) {
      const comments = [...thread.comments.nodes];
      if (thread.comments.pageInfo.hasNextPage) {
        comments.push(
          ...(await this.#threadCommentTail(
            thread.id,
            thread.comments.totalCount,
            comments.length,
            thread.comments.pageInfo.endCursor,
            signal,
          )),
        );
      }
      if (comments.length !== thread.comments.totalCount) {
        throw new GitHubIssueLifecycleAdapterError("pagination_incomplete");
      }
      nodes.push({
        nodeId: thread.id,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        commentsDigest: digestCanonical(
          comments.map((comment) => ({
            nodeId: comment.id,
            authorDigest: digestText(comment.author?.login ?? "github:deleted-user"),
            bodyDigest: digestText(comment.body),
            createdAt: normalizeTimestamp(comment.createdAt),
            updatedAt: normalizeTimestamp(comment.updatedAt),
          })),
        ),
      });
    }
    return { ...collection, nodes };
  }

  async #threadCommentTail(
    threadId: string,
    totalCount: number,
    initialCount: number,
    initialCursor: string | null,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof threadCommentSchema>[]> {
    const responseSchema = z
      .object({
        data: z
          .object({
            node: z
              .object({
                id: nodeIdSchema,
                comments: z
                  .object({
                    totalCount: z.number().int().nonnegative().max(MAX_GITHUB_OBSERVATION_NODES),
                    nodes: z.array(threadCommentSchema).max(MAX_GITHUB_PAGE_NODES),
                    pageInfo: pageInfoSchema,
                  })
                  .strict(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      })
      .strict();
    const nodes: z.infer<typeof threadCommentSchema>[] = [];
    const seen = new Set<string>();
    let cursor = requireAdvancingCursor(initialCursor, seen);
    for (let page = 2; page <= MAX_GITHUB_OBSERVATION_PAGES; page += 1) {
      const response = await this.#graphql(
        responseSchema,
        THREAD_COMMENTS_QUERY,
        { thread: threadId, after: cursor },
        signal,
      );
      const node = response.data.node;
      if (node === null || node.id !== threadId || node.comments.totalCount !== totalCount) {
        throw new GitHubIssueLifecycleAdapterError("pagination_incomplete");
      }
      nodes.push(...node.comments.nodes);
      if (initialCount + nodes.length > MAX_GITHUB_OBSERVATION_NODES) {
        throw new GitHubIssueLifecycleAdapterError("pagination_limit_exceeded");
      }
      if (!node.comments.pageInfo.hasNextPage) return nodes;
      cursor = requireAdvancingCursor(node.comments.pageInfo.endCursor, seen);
    }
    throw new GitHubIssueLifecycleAdapterError("pagination_limit_exceeded");
  }

  async #graphqlConnection<Schema extends z.ZodTypeAny>(
    nodeSchema: Schema,
    field: "comments" | "reviews" | "reviewThreads",
    query: string,
    expected: FrozenGitHubIssueIdentity & { readonly pullRequest: ExactGitHubPullRequestIdentity },
    signal?: AbortSignal,
  ): Promise<{ totalCount: number; nodes: z.infer<Schema>[]; pages: PageReceipt[] }> {
    const connectionSchema = z
      .object({
        totalCount: z.number().int().nonnegative().max(MAX_GITHUB_OBSERVATION_NODES),
        nodes: z.array(nodeSchema).max(MAX_GITHUB_PAGE_NODES),
        pageInfo: pageInfoSchema,
      })
      .strict();
    const responseSchema = z
      .object({
        data: z
          .object({
            repository: z
              .object({
                id: nodeIdSchema,
                pullRequest: z
                  .object({ id: nodeIdSchema, [field]: connectionSchema })
                  .strict()
                  .nullable(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      })
      .strict();
    const identity = splitRepositoryIdentity(expected.repositoryIdentity);
    const nodes: z.infer<Schema>[] = [];
    const pages: PageReceipt[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let totalCount: number | undefined;
    for (let page = 1; page <= MAX_GITHUB_OBSERVATION_PAGES; page += 1) {
      const response = await this.#graphql(
        responseSchema,
        query,
        {
          owner: identity.owner,
          name: identity.name,
          pullRequest: expected.pullRequest.number,
          after: cursor,
        },
        signal,
      );
      const repository = response.data.repository;
      const pullRequest = repository?.pullRequest;
      if (
        repository?.id !== expected.repositoryNodeId ||
        pullRequest?.id !== expected.pullRequest.nodeId
      ) {
        throw new GitHubIssueLifecycleAdapterError("identity_mismatch");
      }
      const connection = pullRequest[field] as z.infer<typeof connectionSchema>;
      totalCount ??= connection.totalCount;
      if (connection.totalCount !== totalCount) {
        throw new GitHubIssueLifecycleAdapterError("pagination_incomplete");
      }
      nodes.push(...connection.nodes);
      if (nodes.length > MAX_GITHUB_OBSERVATION_NODES) {
        throw new GitHubIssueLifecycleAdapterError("pagination_limit_exceeded");
      }
      pages.push({
        requestCursor: cursor,
        endCursor: connection.pageInfo.endCursor,
        hasNextPage: connection.pageInfo.hasNextPage,
        nodeCount: connection.nodes.length,
      });
      if (!connection.pageInfo.hasNextPage) {
        if (nodes.length !== totalCount) {
          throw new GitHubIssueLifecycleAdapterError("pagination_incomplete");
        }
        return { totalCount, nodes, pages };
      }
      cursor = requireAdvancingCursor(connection.pageInfo.endCursor, seen);
    }
    throw new GitHubIssueLifecycleAdapterError("pagination_limit_exceeded");
  }

  async #searchPullRequests(
    expected: FrozenGitHubIssueIdentity,
    signal?: AbortSignal,
  ): Promise<PullRequest[]> {
    const identity = splitRepositoryIdentity(expected.repositoryIdentity);
    const nodes: PullRequest[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let totalCount: number | undefined;
    for (let page = 1; page <= MAX_GITHUB_OBSERVATION_PAGES; page += 1) {
      const response = await this.#graphql(
        searchResponseSchema,
        SEARCH_QUERY,
        {
          owner: identity.owner,
          name: identity.name,
          issue: expected.issue.number,
          baseRef: `refs/heads/${expected.base.branch}`,
          head: expected.headBranch,
          headRef: `refs/heads/${expected.headBranch}`,
          after: cursor,
        },
        signal,
      );
      const repository = response.data.repository;
      if (repository === null) {
        throw new GitHubIssueLifecycleAdapterError("identity_mismatch");
      }
      requireDraftSearchContext(repository, expected);
      totalCount ??= repository.pullRequests.totalCount;
      if (totalCount !== repository.pullRequests.totalCount) {
        throw new GitHubIssueLifecycleAdapterError("pagination_incomplete");
      }
      nodes.push(...repository.pullRequests.nodes);
      if (!repository.pullRequests.pageInfo.hasNextPage) {
        if (nodes.length !== totalCount) {
          throw new GitHubIssueLifecycleAdapterError("pagination_incomplete");
        }
        return nodes;
      }
      cursor = requireAdvancingCursor(repository.pullRequests.pageInfo.endCursor, seen);
    }
    throw new GitHubIssueLifecycleAdapterError("pagination_limit_exceeded");
  }

  #remoteMergeResult(
    repository: NonNullable<CoreResponse["data"]["repository"]>,
    expected: FrozenGitHubIssueIdentity & { readonly pullRequest: ExactGitHubPullRequestIdentity },
    effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "merge" }>,
    reconciled: boolean,
    requireRequestedDeletion = true,
  ): GitHubRemoteMergeResult {
    requireRepository(repository, expected);
    const pullRequest = repository.pullRequest;
    const issue = repository.issue;
    if (
      issue === null ||
      issue.id !== expected.issue.nodeId ||
      issue.number !== expected.issue.number ||
      issue.state !== "CLOSED" ||
      issue.title !== expected.issue.title ||
      issue.body !== expected.issue.body ||
      pullRequest === null ||
      pullRequest.id !== effect.pullRequestNodeId ||
      pullRequest.number !== effect.pullRequestNumber ||
      pullRequest.headRefOid !== effect.candidateHead ||
      pullRequest.headRefName !== expected.headBranch ||
      pullRequest.baseRefName !== effect.baseBranch ||
      pullRequest.merged !== true ||
      pullRequest.state !== "MERGED" ||
      pullRequest.mergedAt === null ||
      pullRequest.mergeCommit === null ||
      repository.baseRef?.name !== effect.baseBranch ||
      pullRequest.headRepository?.id !== expected.repositoryNodeId ||
      pullRequest.baseRepository.id !== expected.repositoryNodeId ||
      digestText(pullRequest.title) !== expected.pullRequest.titleDigest ||
      digestText(pullRequest.body) !== expected.pullRequest.bodyDigest ||
      pullRequest.autoMergeRequest !== null ||
      pullRequest.mergeQueueEntry !== null
    ) {
      throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
    }
    const branchDeleted = repository.branchRef === null;
    if (requireRequestedDeletion && effect.deleteBranch && !branchDeleted) {
      throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
    }
    const outcome = Object.freeze({
      repositoryIdentity: expected.repositoryIdentity,
      repositoryNodeId: expected.repositoryNodeId,
      pullRequestNumber: pullRequest.number,
      pullRequestNodeId: pullRequest.id,
      pullRequestTitleDigest: expected.pullRequest.titleDigest,
      pullRequestBodyDigest: expected.pullRequest.bodyDigest,
      issueNumber: issue.number,
      issueNodeId: issue.id,
      issueState: "closed" as const,
      issueUpdatedAt: normalizeTimestamp(issue.updatedAt),
      issueContentDigest: expected.issue.contentDigest,
      candidateHead: pullRequest.headRefOid,
      baseBranch: repository.baseRef.name,
      observedBaseCommit: repository.baseRef.target.oid,
      mergeCommit: pullRequest.mergeCommit.oid,
      mergedAt: normalizeTimestamp(pullRequest.mergedAt),
      branchDeleted,
    });
    return Object.freeze({
      outcome,
      reconciled,
      evidence: evidence({ kind: "remote-merge-outcome", reconciled, outcome }),
    });
  }

  async #settledRemoteMergeResult(
    initial: NonNullable<CoreResponse["data"]["repository"]>,
    expected: FrozenGitHubIssueIdentity & { readonly pullRequest: ExactGitHubPullRequestIdentity },
    effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "merge" }>,
    reconciled: boolean,
    requireRequestedDeletion: boolean,
    signal?: AbortSignal,
  ): Promise<GitHubRemoteMergeResult> {
    let repository = initial;
    for (let attempt = 1; attempt <= MERGE_SETTLEMENT_OBSERVATION_ATTEMPTS; attempt += 1) {
      try {
        return this.#remoteMergeResult(
          repository,
          expected,
          effect,
          reconciled,
          requireRequestedDeletion,
        );
      } catch (error) {
        if (
          !(error instanceof GitHubIssueLifecycleAdapterError) ||
          error.code !== "external_state_uncertain" ||
          attempt === MERGE_SETTLEMENT_OBSERVATION_ATTEMPTS
        ) {
          throw error;
        }
      }
      try {
        const next = await this.#core(expected, signal);
        if (next.data.repository === null) throw new Error("missing repository");
        repository = next.data.repository;
      } catch {
        throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
      }
    }
    throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
  }

  async #graphql<Schema extends z.ZodTypeAny>(
    schema: Schema,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    mutating = false,
  ): Promise<z.infer<Schema>> {
    const source = await this.#invoke(
      graphqlArguments(),
      JSON.stringify({ query, variables }),
      signal,
      mutating,
    );
    return parseResponse(schema, source);
  }

  async #rest<Schema extends z.ZodTypeAny>(
    schema: Schema,
    path: string,
    signal?: AbortSignal,
  ): Promise<z.infer<Schema>> {
    const source = await this.#invoke(restArguments(path), undefined, signal);
    return parseResponse(schema, source);
  }

  async #invoke(
    arguments_: readonly string[],
    stdin: string | undefined,
    signal?: AbortSignal,
    mutating = false,
  ): Promise<string> {
    const result = await this.#process.run({
      arguments: arguments_,
      cwd: this.#cwd,
      ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin, "utf8") }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.termination === "exit" && result.exitCode === 0) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
      } catch {
        throw new GitHubIssueLifecycleAdapterError("command_response_invalid");
      }
    }
    if (mutating) throw new GitHubIssueLifecycleAdapterError("external_state_uncertain");
    throw new GitHubIssueLifecycleAdapterError(processErrorCode(result.termination));
  }
}

function requirePremergeCore(
  response: CoreResponse,
  expected: FrozenGitHubIssueIdentity & { readonly pullRequest: ExactGitHubPullRequestIdentity },
) {
  const repository = response.data.repository;
  if (repository === null) throw new GitHubIssueLifecycleAdapterError("identity_mismatch");
  requireRepository(repository, expected);
  const issue = repository.issue;
  if (
    issue === null ||
    issue.id !== expected.issue.nodeId ||
    issue.number !== expected.issue.number ||
    issue.state !== "OPEN" ||
    normalizeTimestamp(issue.updatedAt) !== normalizeTimestamp(expected.issue.updatedAt) ||
    issue.title !== expected.issue.title ||
    issue.body !== expected.issue.body
  ) {
    throw new GitHubIssueLifecycleAdapterError("issue_changed");
  }
  const pullRequest = repository.pullRequest;
  if (pullRequest === null) throw new GitHubIssueLifecycleAdapterError("pull_request_not_found");
  if (
    pullRequest.id !== expected.pullRequest.nodeId ||
    pullRequest.number !== expected.pullRequest.number ||
    pullRequest.state !== "OPEN" ||
    pullRequest.merged ||
    pullRequest.headRefName !== expected.headBranch ||
    pullRequest.headRefOid !== expected.headCommit ||
    pullRequest.baseRefName !== expected.base.branch ||
    pullRequest.baseRefOid !== expected.base.commit ||
    digestText(pullRequest.title) !== expected.pullRequest.titleDigest ||
    digestText(pullRequest.body) !== expected.pullRequest.bodyDigest ||
    pullRequest.headRepository?.id !== expected.repositoryNodeId ||
    pullRequest.baseRepository.id !== expected.repositoryNodeId ||
    pullRequest.autoMergeRequest !== null ||
    pullRequest.mergeQueueEntry !== null ||
    repository.baseRef?.name !== expected.base.branch ||
    repository.baseRef.target.oid !== expected.base.commit ||
    repository.branchRef?.name !== expected.headBranch ||
    repository.branchRef.target.oid !== expected.headCommit
  ) {
    throw new GitHubIssueLifecycleAdapterError("pull_request_collision");
  }
  return {
    ...repository,
    issue,
    pullRequest,
    baseRef: repository.baseRef,
    branchRef: repository.branchRef,
  };
}

function requireRepository(
  repository: {
    readonly id: string;
    readonly nameWithOwner: string;
    readonly url: string;
    readonly isArchived: boolean;
  },
  expected: FrozenGitHubIssueIdentity,
): void {
  if (
    repository.id !== expected.repositoryNodeId ||
    canonicalGitHubRepositoryIdentity(repository.nameWithOwner) !== expected.repositoryIdentity ||
    repository.url !== `https://github.com/${expected.repositoryIdentity}` ||
    repository.isArchived
  ) {
    throw new GitHubIssueLifecycleAdapterError("identity_mismatch");
  }
}

function requireDraftSearchContext(
  repository: NonNullable<z.infer<typeof searchResponseSchema>["data"]["repository"]>,
  expected: FrozenGitHubIssueIdentity,
): void {
  requireRepository(repository, expected);
  const issue = repository.issue;
  if (
    issue === null ||
    issue.id !== expected.issue.nodeId ||
    issue.number !== expected.issue.number ||
    issue.state !== "OPEN" ||
    normalizeTimestamp(issue.updatedAt) !== normalizeTimestamp(expected.issue.updatedAt) ||
    issue.title !== expected.issue.title ||
    issue.body !== expected.issue.body ||
    issue.url !==
      `https://github.com/${expected.repositoryIdentity}/issues/${expected.issue.number}`
  ) {
    throw new GitHubIssueLifecycleAdapterError("issue_changed");
  }
  if (
    repository.baseRef?.name !== expected.base.branch ||
    repository.baseRef.target.oid !== expected.base.commit ||
    repository.branchRef?.name !== expected.headBranch ||
    repository.branchRef.target.oid !== expected.headCommit
  ) {
    throw new GitHubIssueLifecycleAdapterError("pull_request_collision");
  }
}

function requireExactDraft(
  pullRequest: PullRequest,
  expected: FrozenGitHubIssueIdentity,
  effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request" }>,
  title: string,
  body: string,
): PullRequest {
  if (
    pullRequest.state !== "OPEN" ||
    pullRequest.merged ||
    !pullRequest.isDraft ||
    pullRequest.title !== title ||
    pullRequest.body !== body ||
    pullRequest.headRefName !== effect.headBranch ||
    pullRequest.headRefOid !== effect.headCommit ||
    pullRequest.baseRefName !== effect.baseBranch ||
    pullRequest.baseRefOid !== effect.baseCommit ||
    pullRequest.headRepository?.id !== expected.repositoryNodeId ||
    pullRequest.baseRepository.id !== expected.repositoryNodeId ||
    pullRequest.autoMergeRequest !== null ||
    pullRequest.mergeQueueEntry !== null
  ) {
    throw new GitHubIssueLifecycleAdapterError("pull_request_collision");
  }
  return pullRequest;
}

function draftResult(
  pullRequest: PullRequest,
): Extract<IssueExternalEffectResult, { kind: "pull_request" }> {
  return Object.freeze({
    kind: "pull_request" as const,
    repositoryIdentity: canonicalGitHubRepositoryIdentity(pullRequest.baseRepository.nameWithOwner),
    candidateHead: pullRequest.headRefOid,
    headBranch: pullRequest.headRefName,
    baseBranch: pullRequest.baseRefName,
    pullRequestNumber: pullRequest.number,
    pullRequestNodeId: pullRequest.id,
    isDraft: true as const,
  });
}

function readyResult(
  pullRequest: PullRequest,
): Extract<IssueExternalEffectResult, { kind: "pull_request_ready" }> {
  return Object.freeze({
    kind: "pull_request_ready" as const,
    repositoryIdentity: canonicalGitHubRepositoryIdentity(pullRequest.baseRepository.nameWithOwner),
    candidateHead: pullRequest.headRefOid,
    headBranch: pullRequest.headRefName,
    baseBranch: pullRequest.baseRefName,
    pullRequestNumber: pullRequest.number,
    pullRequestNodeId: pullRequest.id,
    isDraft: false as const,
  });
}

function requireDraftEffect(
  effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request" }>,
  expected: FrozenGitHubIssueIdentity,
  title: string,
  body: string,
): void {
  if (
    effect.repositoryIdentity !== expected.repositoryIdentity ||
    effect.issueNumber !== expected.issue.number ||
    effect.issueNodeId !== expected.issue.nodeId ||
    effect.headBranch !== expected.headBranch ||
    effect.headCommit !== expected.headCommit ||
    effect.baseBranch !== expected.base.branch ||
    effect.baseCommit !== expected.base.commit ||
    effect.titleDigest !== digestText(title) ||
    effect.bodyDigest !== digestText(body)
  ) {
    throw new GitHubIssueLifecycleAdapterError("identity_mismatch");
  }
}

function requireReadyEffect(
  effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request_ready" }>,
  expected: FrozenGitHubIssueIdentity & { readonly pullRequest: ExactGitHubPullRequestIdentity },
): void {
  if (
    effect.repositoryIdentity !== expected.repositoryIdentity ||
    effect.pullRequestNumber !== expected.pullRequest.number ||
    effect.pullRequestNodeId !== expected.pullRequest.nodeId ||
    effect.headBranch !== expected.headBranch ||
    effect.headCommit !== expected.headCommit ||
    effect.baseBranch !== expected.base.branch ||
    effect.baseCommit !== expected.base.commit
  ) {
    throw new GitHubIssueLifecycleAdapterError("identity_mismatch");
  }
}

function requireMergeEffect(
  effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "merge" }>,
  expected: FrozenGitHubIssueIdentity & { readonly pullRequest: ExactGitHubPullRequestIdentity },
): void {
  if (
    effect.repositoryIdentity !== expected.repositoryIdentity ||
    effect.pullRequestNumber !== expected.pullRequest.number ||
    effect.pullRequestNodeId !== expected.pullRequest.nodeId ||
    effect.candidateHead !== expected.headCommit ||
    effect.baseBranch !== expected.base.branch ||
    effect.baseCommit !== expected.base.commit
  ) {
    throw new GitHubIssueLifecycleAdapterError("identity_mismatch");
  }
}

function requireEffect<Kind extends "pull_request" | "pull_request_ready" | "merge">(
  input: unknown,
  kind: Kind,
): Extract<IssueExternalEffectDescriptor, { readonly kind: Kind }> {
  const effect = parseIssueExternalEffectDescriptor(input);
  if (effect.kind !== kind) throw new GitHubIssueLifecycleAdapterError("identity_mismatch");
  return effect as Extract<IssueExternalEffectDescriptor, { readonly kind: Kind }>;
}

function validateExpected(expected: FrozenGitHubIssueIdentity): void {
  const identity = splitRepositoryIdentity(expected.repositoryIdentity);
  if (
    identity.identity !== expected.repositoryIdentity ||
    !nodeIdSchema.safeParse(expected.repositoryNodeId).success ||
    !nodeIdSchema.safeParse(expected.issue.nodeId).success ||
    !positiveIntegerSchema.safeParse(expected.issue.number).success ||
    !timestampSchema.safeParse(expected.issue.updatedAt).success ||
    !sha256Schema.safeParse(expected.issue.contentDigest).success ||
    !commitSchema.safeParse(expected.base.commit).success ||
    !commitSchema.safeParse(expected.headCommit).success ||
    expected.base.branch === expected.headBranch
  ) {
    throw new GitHubIssueLifecycleAdapterError("identity_mismatch");
  }
}

function normalizePullRequest(pullRequest: PullRequest) {
  return {
    number: pullRequest.number,
    nodeId: pullRequest.id,
    state: pullRequest.state.toLowerCase(),
    isDraft: pullRequest.isDraft,
    headBranch: pullRequest.headRefName,
    headCommit: pullRequest.headRefOid,
    baseBranch: pullRequest.baseRefName,
    baseCommit: pullRequest.baseRefOid,
    mergeability: pullRequest.mergeable.toLowerCase(),
  };
}

function rejectHostedCheckCollisions(
  checks: readonly {
    readonly name: string;
    readonly sourceApp: { readonly id: number; readonly slug: string };
  }[],
  required: FrozenGitHubIssueIdentity["hostedChecks"],
): void {
  for (const requirement of required) {
    if (
      checks.some(
        (check) =>
          check.name === requirement.name &&
          (check.sourceApp.id !== requirement.sourceApp.id ||
            check.sourceApp.slug !== requirement.sourceApp.slug),
      )
    ) {
      throw new GitHubIssueLifecycleAdapterError("hosted_check_identity_collision");
    }
  }
}

function parseResponse<Schema extends z.ZodTypeAny>(
  schema: Schema,
  source: string,
): z.infer<Schema> {
  try {
    const strict = parseStrictJson(source, { maxDepth: MAX_JSON_DEPTH, maxNodes: MAX_JSON_NODES });
    return schema.parse(strict);
  } catch {
    throw new GitHubIssueLifecycleAdapterError("command_response_invalid");
  }
}

function evidence(value: unknown): GitHubIssueLifecycleEvidence {
  return Object.freeze({
    mediaType: EVIDENCE_MEDIA_TYPE,
    bytes: Buffer.from(canonicalJson(value), "utf8"),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("GitHub evidence contains an unsupported value");
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestCanonical(value: unknown): string {
  return digestText(canonicalJson(value));
}

function splitRepositoryIdentity(value: string): { owner: string; name: string; identity: string } {
  try {
    const identity = canonicalGitHubRepositoryIdentity(value);
    const separator = identity.indexOf("/");
    return { owner: identity.slice(0, separator), name: identity.slice(separator + 1), identity };
  } catch {
    throw new GitHubIssueLifecycleAdapterError("identity_mismatch");
  }
}

function connectionQuery(field: string, selection: string): string {
  return `query FlowIssue${field}($owner: String!, $name: String!, $pullRequest: Int!, $after: String) { repository(owner: $owner, name: $name) { id pullRequest(number: $pullRequest) { id ${field}(first: 100, after: $after) { totalCount nodes { ${selection} } pageInfo { hasNextPage endCursor } } } } }`;
}

function graphqlArguments(): string[] {
  return ["api", "graphql", "--hostname", "github.com", "--method", "POST", "--input", "-"];
}

function restArguments(path: string, method: "DELETE" | "GET" = "GET"): string[] {
  return [
    "api",
    "--hostname",
    "github.com",
    "--method",
    method,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    path,
  ];
}

function githubEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    GH_HOST: "github.com",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
  };
  for (const name of [
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HOME",
    "XDG_CONFIG_HOME",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return Object.freeze(environment);
}

function processErrorCode(termination: string): GitHubIssueLifecycleAdapterErrorCode {
  switch (termination) {
    case "timeout":
      return "command_timed_out";
    case "abort":
      return "operation_aborted";
    case "output_limit":
      return "command_output_limit_exceeded";
    case "launch_error":
      return "executable_unavailable";
    default:
      return "command_failed";
  }
}

function admissionError(error: unknown): GitHubIssueHostAdmissionError {
  if (error instanceof GitHubIssueHostAdmissionError) return error;
  if (error instanceof GitHubIssueLifecycleAdapterError) {
    const mapping: Partial<
      Record<
        GitHubIssueLifecycleAdapterErrorCode,
        ConstructorParameters<typeof GitHubIssueHostAdmissionError>[0]
      >
    > = {
      executable_unavailable: "executable_unavailable",
      command_timed_out: "command_timed_out",
      command_output_limit_exceeded: "command_output_limit_exceeded",
      command_response_invalid: "command_response_invalid",
      operation_aborted: "operation_aborted",
    };
    return new GitHubIssueHostAdmissionError(mapping[error.code] ?? "command_failed");
  }
  return new GitHubIssueHostAdmissionError("command_failed");
}

function requireAdvancingCursor(cursor: string | null, seen: Set<string>): string {
  if (cursor === null || seen.has(cursor)) {
    throw new GitHubIssueLifecycleAdapterError("pagination_cursor_loop");
  }
  seen.add(cursor);
  return cursor;
}

function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new GitHubIssueLifecycleAdapterError("command_response_invalid");
  }
  return new Date(milliseconds).toISOString();
}

function nullableTimestamp(value: string | null): string | null {
  return value === null ? null : normalizeTimestamp(value);
}

function exactNow(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new GitHubIssueLifecycleAdapterError("command_response_invalid");
  }
  return value.toISOString();
}
