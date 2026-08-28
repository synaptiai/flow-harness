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
