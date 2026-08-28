export interface IssueGitWorkspace {
  readonly version: 1;
  readonly ownershipId: string;
  readonly sourceRoot: string;
  readonly root: string;
  readonly commonGitDirectory: string;
  readonly gitDirectory: string;
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
  commitCandidate(request: CommitIssueGitCandidateRequest): Promise<IssueGitCommitResult>;
  pushCandidate(request: PushIssueGitCandidateRequest): Promise<IssueGitPushResult>;
  inspectCommit(request: InspectIssueGitCommitRequest): Promise<IssueGitCommitObservation>;
  isAncestor(request: IssueGitReachabilityRequest): Promise<boolean>;
  cleanupWorkspace(request: CleanupIssueGitWorkspaceRequest): Promise<void>;
}
