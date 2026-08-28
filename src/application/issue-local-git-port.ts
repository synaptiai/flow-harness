export interface IssueGitWorkspace {
  readonly version: 1;
  readonly ownershipId: string;
  readonly sourceRoot: string;
  readonly root: string;
  readonly verificationRoot: string;
  readonly commonGitDirectory: string;
  readonly gitDirectory: string;
  readonly verificationGitDirectory: string;
  readonly repositoryIdentity: string;
  readonly originCanonicalUrl: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly workspaceIdentityDigest: string;
}

export interface PrepareIssueGitWorkspaceRequest {
  readonly ownershipId: string;
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly verificationRoot: string;
  readonly repositoryIdentity: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly branch: string;
}

export interface InspectIssueGitCandidateRequest {
  readonly workspace: IssueGitWorkspace;
  readonly baseCommit: string;
  readonly allowedWritePrefixes: readonly string[];
  readonly signal?: AbortSignal;
}

export interface IssueGitCandidateObservation {
  readonly branch: string;
  readonly head: string;
  readonly baseCommit: string;
  readonly tree: string;
  readonly changedPaths: readonly string[];
  readonly logicalBytes: number;
  readonly workspaceIdentityDigest: string;
}

export interface InspectIssueGitVerificationCandidateRequest {
  readonly workspace: IssueGitWorkspace;
  readonly baseCommit: string;
  readonly candidateHead: string;
  readonly allowedWritePrefixes: readonly string[];
  readonly signal?: AbortSignal;
}

export interface IssueGitCommitIdentity {
  readonly name: string;
  readonly email: string;
  readonly timestamp: string;
}

export interface CommitIssueGitCandidateRequest {
  readonly workspace: IssueGitWorkspace;
  readonly parentCommit: string;
  readonly candidateTree: string;
  readonly allowedWritePrefixes: readonly string[];
  readonly message: string;
  readonly identity: IssueGitCommitIdentity;
  readonly signal?: AbortSignal;
}

export interface IssueGitCommitResult {
  readonly candidateHead: string;
  readonly tree: string;
  readonly parent: string;
}

export interface PushIssueGitCandidateRequest {
  readonly workspace: IssueGitWorkspace;
  readonly branch: string;
  readonly candidateHead: string;
  readonly expectedRemoteHead: string | null;
  readonly signal?: AbortSignal;
}

export interface IssueGitPushResult {
  readonly branch: string;
  readonly candidateHead: string;
}

export interface InspectIssueGitCommitRequest {
  readonly workspace: IssueGitWorkspace;
  readonly commit: string;
  readonly signal?: AbortSignal;
}

export interface IssueGitCommitObservation {
  readonly commit: string;
  readonly tree: string;
  readonly parents: readonly string[];
}

export interface IssueGitReachabilityRequest {
  readonly workspace: IssueGitWorkspace;
  readonly ancestor: string;
  readonly descendant: string;
  readonly signal?: AbortSignal;
}

export interface InspectIssueGitRemoteBranchRequest {
  readonly workspace: IssueGitWorkspace;
  readonly branch: string;
  readonly signal?: AbortSignal;
}

export interface FetchIssueGitRemoteBranchRequest extends InspectIssueGitRemoteBranchRequest {
  readonly expectedHead: string;
}

export interface IssueGitRemoteBranchObservation {
  readonly branch: string;
  readonly head: string | null;
}

export interface FetchIssueGitPullRequestHeadRequest {
  readonly workspace: IssueGitWorkspace;
  readonly pullRequestNumber: number;
  readonly expectedHead: string;
  readonly signal?: AbortSignal;
}

export interface IssueGitPullRequestHeadObservation {
  readonly pullRequestNumber: number;
  readonly head: string;
}

export interface InspectIssueGitPatchSeriesRequest {
  readonly workspace: IssueGitWorkspace;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly signal?: AbortSignal;
}

export interface IssueGitPatchSeriesObservation {
  readonly firstParent: string;
  readonly headCommit: string;
  readonly commitCount: number;
  readonly digest: string;
}

export interface InspectIssueGitVerificationWorktreeRequest {
  readonly workspace: IssueGitWorkspace;
  readonly commit: string;
  readonly cleanliness: "pristine" | "command-postcondition";
  readonly signal?: AbortSignal;
}

export interface ResetIssueGitVerificationWorktreeRequest {
  readonly workspace: IssueGitWorkspace;
  readonly commit: string;
  readonly signal?: AbortSignal;
}

export interface IssueGitVerificationWorktreeObservation {
  readonly head: string;
  readonly tree: string;
  readonly status: "clean";
  readonly workspaceIdentityDigest: string;
}

export interface CleanupIssueGitWorkspaceRequest {
  readonly workspace: IssueGitWorkspace;
  readonly expectedBranchHead: string;
  readonly signal?: AbortSignal;
}

export interface IssueLocalGitPort {
  prepareWorkspace(
    request: PrepareIssueGitWorkspaceRequest,
    signal?: AbortSignal,
  ): Promise<IssueGitWorkspace>;
  inspectCandidate(request: InspectIssueGitCandidateRequest): Promise<IssueGitCandidateObservation>;
  inspectVerificationCandidate(
    request: InspectIssueGitVerificationCandidateRequest,
  ): Promise<IssueGitCandidateObservation>;
  commitCandidate(request: CommitIssueGitCandidateRequest): Promise<IssueGitCommitResult>;
  pushCandidate(request: PushIssueGitCandidateRequest): Promise<IssueGitPushResult>;
  inspectCommit(request: InspectIssueGitCommitRequest): Promise<IssueGitCommitObservation>;
  isAncestor(request: IssueGitReachabilityRequest): Promise<boolean>;
  inspectRemoteBranch(
    request: InspectIssueGitRemoteBranchRequest,
  ): Promise<IssueGitRemoteBranchObservation>;
  fetchRemoteBranch(
    request: FetchIssueGitRemoteBranchRequest,
  ): Promise<IssueGitRemoteBranchObservation>;
  fetchPullRequestHead(
    request: FetchIssueGitPullRequestHeadRequest,
  ): Promise<IssueGitPullRequestHeadObservation>;
  inspectPatchSeries(
    request: InspectIssueGitPatchSeriesRequest,
  ): Promise<IssueGitPatchSeriesObservation>;
  inspectVerificationWorktree(
    request: InspectIssueGitVerificationWorktreeRequest,
  ): Promise<IssueGitVerificationWorktreeObservation>;
  resetVerificationWorktree(
    request: ResetIssueGitVerificationWorktreeRequest,
  ): Promise<IssueGitVerificationWorktreeObservation>;
  cleanupWorkspace(request: CleanupIssueGitWorkspaceRequest): Promise<void>;
}
