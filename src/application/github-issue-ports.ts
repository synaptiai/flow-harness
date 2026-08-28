import type { IssueExternalEffectResult } from "../domain/issue-lifecycle/events.js";
import type { IssueExternalEffectDescriptor } from "../domain/issue-lifecycle/external-effects.js";
import type { GitHubLifecycleObservation } from "../domain/issue-lifecycle/github-observation.js";

export type GitHubIssueHostAdmissionErrorCode =
  | "executable_unavailable"
  | "repository_identity_invalid"
  | "repository_unavailable"
  | "repository_dirty"
  | "repository_detached"
  | "flow_runtime_not_ignored"
  | "repository_origin_unsupported"
  | "repository_identity_mismatch"
  | "command_failed"
  | "command_timed_out"
  | "command_output_limit_exceeded"
  | "command_response_invalid"
  | "github_authentication_failed"
  | "github_repository_not_found"
  | "github_repository_identity_mismatch"
  | "github_issue_not_found"
  | "github_issue_not_open"
  | "github_issue_identity_mismatch"
  | "operation_aborted";

export class GitHubIssueHostAdmissionError extends Error {
  override readonly name = "GitHubIssueHostAdmissionError";

  constructor(readonly code: GitHubIssueHostAdmissionErrorCode) {
    super(`GitHub issue host admission failed: ${code}`);
  }
}

export interface GitHubRepositoryReference {
  readonly host: "github.com";
  readonly owner: string;
  readonly name: string;
}

export interface LocalGitRepositoryObservation {
  readonly root: string;
  readonly clean: true;
  readonly flowRuntimeIgnored: true;
  readonly branch: string;
  readonly head: string;
  readonly origin: GitHubRepositoryReference & {
    readonly canonicalUrl: string;
  };
}

export interface GitRepositoryAdmissionPort {
  inspect(
    invocationRoot: string,
    expectedRepository: GitHubRepositoryReference,
    signal?: AbortSignal,
  ): Promise<LocalGitRepositoryObservation>;
}

export interface GitHubRepositoryObservation extends GitHubRepositoryReference {
  readonly nodeId: string;
  readonly canonicalUrl: string;
  readonly defaultBranch: string;
  readonly configuredBase: {
    readonly branch: string;
    readonly commit: string;
  };
}

export interface OpenGitHubIssueSnapshot extends GitHubRepositoryReference {
  readonly nodeId: string;
  readonly number: number;
  readonly state: "OPEN";
  readonly title: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly canonicalUrl: string;
}

export interface GitHubOpenIssueObservation {
  readonly repository: GitHubRepositoryObservation;
  readonly issue: OpenGitHubIssueSnapshot;
}

export interface GitHubIssueAdmissionPort {
  inspectOpenIssue(
    input: {
      readonly repository: GitHubRepositoryReference;
      readonly number: number;
      readonly baseBranch: string;
    },
    signal?: AbortSignal,
  ): Promise<GitHubOpenIssueObservation>;
}

export type GitHubIssueLifecycleAdapterErrorCode =
  | "executable_unavailable"
  | "authentication_failed"
  | "command_failed"
  | "command_timed_out"
  | "command_output_limit_exceeded"
  | "command_response_invalid"
  | "operation_aborted"
  | "identity_mismatch"
  | "issue_changed"
  | "pull_request_not_found"
  | "pull_request_ambiguous"
  | "pull_request_collision"
  | "pagination_incomplete"
  | "pagination_limit_exceeded"
  | "pagination_cursor_loop"
  | "hosted_check_identity_collision"
  | "mergeability_unknown"
  | "merge_conflict"
  | "merge_queue_unsupported"
  | "external_state_uncertain";

export class GitHubIssueLifecycleAdapterError extends Error {
  override readonly name = "GitHubIssueLifecycleAdapterError";

  constructor(readonly code: GitHubIssueLifecycleAdapterErrorCode) {
    super(`GitHub issue lifecycle operation failed: ${code}`);
  }
}

export interface GitHubIssueLifecycleEvidence {
  readonly mediaType: "application/vnd.synapti.flow.github-evidence.v1+json";
  readonly bytes: Uint8Array;
}

export interface FrozenGitHubIssueIdentity {
  readonly repositoryIdentity: string;
  readonly repositoryNodeId: string;
  readonly issue: {
    readonly number: number;
    readonly nodeId: string;
    readonly updatedAt: string;
    readonly title: string;
    readonly body: string;
    readonly contentDigest: string;
  };
  readonly base: { readonly branch: string; readonly commit: string };
  readonly headBranch: string;
  readonly headCommit: string;
  readonly hostedChecks: readonly {
    readonly name: string;
    readonly sourceApp: { readonly id: number; readonly slug: string };
  }[];
}

export interface ExactGitHubPullRequestIdentity {
  readonly number: number;
  readonly nodeId: string;
  readonly titleDigest: string;
  readonly bodyDigest: string;
}

export interface GitHubLifecycleObservationResult {
  readonly observation: GitHubLifecycleObservation;
  readonly evidence: GitHubIssueLifecycleEvidence;
}

export interface GitHubExternalEffectResult<Kind extends "pull_request" | "pull_request_ready"> {
  readonly result: Extract<IssueExternalEffectResult, { readonly kind: Kind }>;
  readonly evidence: GitHubIssueLifecycleEvidence;
  readonly reconciled: boolean;
}

export interface GitHubRemoteMergeOutcome {
  readonly repositoryIdentity: string;
  readonly repositoryNodeId: string;
  readonly pullRequestNumber: number;
  readonly pullRequestNodeId: string;
  readonly pullRequestTitleDigest: string;
  readonly pullRequestBodyDigest: string;
  readonly issueNumber: number;
  readonly issueNodeId: string;
  readonly issueState: "closed";
  readonly issueUpdatedAt: string;
  readonly issueContentDigest: string;
  readonly candidateHead: string;
  readonly baseBranch: string;
  readonly observedBaseCommit: string;
  readonly mergeCommit: string;
  readonly mergedAt: string;
  readonly branchDeleted: boolean;
}

export interface GitHubRemoteMergeResult {
  readonly outcome: GitHubRemoteMergeOutcome;
  readonly evidence: GitHubIssueLifecycleEvidence;
  readonly reconciled: boolean;
}

export interface GitHubIssueLifecyclePort {
  observeLifecycle(
    expected: FrozenGitHubIssueIdentity & {
      readonly pullRequest: ExactGitHubPullRequestIdentity;
    },
    signal?: AbortSignal,
  ): Promise<GitHubLifecycleObservationResult>;

  ensureDraftPullRequest(
    input: {
      readonly expected: FrozenGitHubIssueIdentity;
      readonly effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request" }>;
      readonly title: string;
      readonly body: string;
    },
    signal?: AbortSignal,
  ): Promise<GitHubExternalEffectResult<"pull_request">>;

  ensurePullRequestReady(
    input: {
      readonly expected: FrozenGitHubIssueIdentity & {
        readonly pullRequest: ExactGitHubPullRequestIdentity;
      };
      readonly effect: Extract<
        IssueExternalEffectDescriptor,
        { readonly kind: "pull_request_ready" }
      >;
    },
    signal?: AbortSignal,
  ): Promise<GitHubExternalEffectResult<"pull_request_ready">>;

  mergeExactPullRequest(
    input: {
      readonly expected: FrozenGitHubIssueIdentity & {
        readonly pullRequest: ExactGitHubPullRequestIdentity;
      };
      readonly effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "merge" }>;
    },
    signal?: AbortSignal,
  ): Promise<GitHubRemoteMergeResult>;

  observeMergeOutcome(
    input: {
      readonly expected: FrozenGitHubIssueIdentity & {
        readonly pullRequest: ExactGitHubPullRequestIdentity;
      };
      readonly effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "merge" }>;
    },
    signal?: AbortSignal,
  ): Promise<GitHubRemoteMergeResult | null>;
}
