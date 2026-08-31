import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  CleanupIssueGitWorkspaceRequest,
  CommitIssueGitCandidateRequest,
  FetchIssueGitPullRequestHeadRequest,
  FetchIssueGitRemoteBranchRequest,
  InspectIssueGitCandidateRequest,
  InspectIssueGitCommitRequest,
  InspectIssueGitPatchSeriesRequest,
  InspectIssueGitRemoteBranchRequest,
  InspectIssueGitVerificationCandidateRequest,
  InspectIssueGitVerificationWorktreeRequest,
  IssueGitCandidateObservation,
  IssueGitCommitObservation,
  IssueGitCommitResult,
  IssueGitPatchSeriesObservation,
  IssueGitPullRequestHeadObservation,
  IssueGitPushResult,
  IssueGitReachabilityRequest,
  IssueGitRemoteBranchObservation,
  IssueGitVerificationWorktreeObservation,
  IssueGitWorkspace,
  IssueLocalGitPort,
  PrepareIssueGitWorkspaceRequest,
  PushIssueGitCandidateRequest,
  ResetIssueGitVerificationWorktreeRequest,
} from "../../application/issue-local-git-port.js";
import { canonicalGitHubRepositoryIdentity } from "../../domain/issue-lifecycle/identity.js";
import { isValidExactGitBranchName } from "../../domain/issue-lifecycle/plan.js";
import type { GitHubGitCredentialBroker } from "../github/github-cli-git-credential-broker.js";
import { parseExactLocalGitOriginConfiguration } from "./exact-local-git-origin-configuration.js";
import type { PinnedGitHubIssueHostExecutable } from "./fixed-host-executables.js";
import { StrictHostProcess, type StrictHostProcessResult } from "./strict-host-process.js";

export const MAX_ISSUE_CANDIDATE_PATHS = 4_096;
export const MAX_ISSUE_CANDIDATE_BYTES = 67_108_864;
export const MAX_ISSUE_PATCH_COMMITS = 1_024;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_GIT_STDOUT_BYTES = 1_048_576;
const MAX_GIT_STDERR_BYTES = 1_048_576;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OWNERSHIP_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PRIVATE_DIRECTORY_NAME = "git-workspaces";

export type LocalGitIssueErrorCode =
  | "invalid_request"
  | "operation_aborted"
  | "git_unavailable"
  | "git_failed"
  | "git_timed_out"
  | "git_output_limit_exceeded"
  | "git_response_invalid"
  | "source_unavailable"
  | "source_dirty"
  | "source_detached"
  | "source_drift"
  | "authentication_failed"
  | "origin_drift"
  | "base_drift"
  | "workspace_not_owned"
  | "workspace_state_uncertain"
  | "branch_not_owned"
  | "branch_drift"
  | "candidate_prefix_invalid"
  | "candidate_path_disallowed"
  | "candidate_symlink_escape"
  | "candidate_filter_unsupported"
  | "candidate_gitlink_unsupported"
  | "candidate_path_limit_exceeded"
  | "candidate_byte_limit_exceeded"
  | "candidate_tree_drift"
  | "remote_drift"
  | "remote_update_rejected";

export class LocalGitIssueError extends Error {
  override readonly name = "LocalGitIssueError";

  constructor(
    readonly code: LocalGitIssueErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Local Git issue operation failed: ${code}`, options);
  }
}

export interface LocalGitIssueEffectsOptions {
  readonly gitExecutable: PinnedGitHubIssueHostExecutable;
  readonly privateRoot: string;
  readonly timeoutMs?: number;
  readonly maxCandidatePaths?: number;
  readonly maxCandidateBytes?: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly credentialBroker?: GitHubGitCredentialBroker;
  /** @internal Permits one exact local bare remote for real-repository tests. */
  readonly testOnlyLocalRemotePath?: string;
  /** @internal Introduces a deterministic validation race in tests. */
  readonly testOnlyBeforePrivateIndexWrite?: () => Promise<void>;
}

export interface NormalizedGitHubIssueOrigin {
  readonly repositoryIdentity: string;
  readonly canonicalUrl: string;
}

interface WorkspaceOwnershipRecord {
  readonly version: 1;
  readonly status: "prepared" | "active" | "cleaned";
  readonly request: PrepareIssueGitWorkspaceRequest;
  readonly requestDigest: string;
  readonly workspace?: IssueGitWorkspace;
}

interface GitCommandOptions {
  readonly cwd: string;
  readonly arguments: readonly string[];
  readonly signal?: AbortSignal;
  readonly stdin?: Uint8Array;
  readonly environment?: Readonly<Record<string, string>>;
  readonly acceptedExitCodes?: readonly number[];
  readonly allowNonZero?: boolean;
}

interface TreeDeltaEntry {
  readonly path: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldObject: string;
  readonly newObject: string;
}

/** Performs controller-owned Git effects without exposing Git authority to a model. */
export class LocalGitIssueEffects implements IssueLocalGitPort {
  readonly #credentialBroker: GitHubGitCredentialBroker | undefined;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #gitExecutable: PinnedGitHubIssueHostExecutable;
  readonly #maxCandidateBytes: number;
  readonly #maxCandidatePaths: number;
  readonly #privateRoot: string;
  readonly #testOnlyBeforePrivateIndexWrite: (() => Promise<void>) | undefined;
  readonly #testOnlyLocalRemotePath: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: LocalGitIssueEffectsOptions) {
    assertAbsolutePath(options.privateRoot);
    this.#gitExecutable = options.gitExecutable;
    this.#credentialBroker = options.credentialBroker;
    this.#privateRoot = resolve(options.privateRoot);
    this.#testOnlyLocalRemotePath =
      options.testOnlyLocalRemotePath === undefined
        ? undefined
        : normalizeTestRemotePath(options.testOnlyLocalRemotePath);
    this.#testOnlyBeforePrivateIndexWrite = options.testOnlyBeforePrivateIndexWrite;
    this.#timeoutMs = boundedLimit(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 300_000);
    this.#maxCandidatePaths = boundedLimit(
      options.maxCandidatePaths ?? MAX_ISSUE_CANDIDATE_PATHS,
      MAX_ISSUE_CANDIDATE_PATHS,
    );
    this.#maxCandidateBytes = boundedLimit(
      options.maxCandidateBytes ?? MAX_ISSUE_CANDIDATE_BYTES,
      MAX_ISSUE_CANDIDATE_BYTES,
    );
    this.#environment = validateHostEnvironment(options.environment ?? {});
  }

  async prepareWorkspace(
    request: PrepareIssueGitWorkspaceRequest,
    signal?: AbortSignal,
  ): Promise<IssueGitWorkspace> {
    assertPrepareRequest(request);
    assertNotAborted(signal);
    const normalized = await this.#normalizePrepareRequest(request);
    const requestDigest = digest("flow.issue.git-workspace-request.v1", normalized);
    const recordPath = await this.#ownershipRecordPath(normalized.ownershipId);
    const existing = await readOptionalOwnershipRecord(recordPath);
    if (existing !== undefined) {
      return await this.#reconcileExistingWorkspace(existing, normalized, requestDigest, signal);
    }

    await this.#assertSource(normalized, signal);
    if (await pathExists(normalized.workspaceRoot)) {
      throw new LocalGitIssueError("workspace_not_owned");
    }
    if (await pathExists(normalized.verificationRoot)) {
      throw new LocalGitIssueError("workspace_not_owned");
    }
    if ((await this.#readLocalRef(normalized.sourceRoot, normalized.branch, signal)) !== null) {
      throw new LocalGitIssueError("branch_not_owned");
    }
    const prepared: WorkspaceOwnershipRecord = Object.freeze({
      version: 1,
      status: "prepared",
      request: normalized,
      requestDigest,
    });
    const created = await writeExclusiveJson(recordPath, prepared);
    if (!created) {
      const raced = await readRequiredOwnershipRecord(recordPath);
      return await this.#reconcileExistingWorkspace(raced, normalized, requestDigest, signal);
    }

    const result = await this.#git({
      cwd: normalized.sourceRoot,
      arguments: [
        "worktree",
        "add",
        "--quiet",
        "-b",
        normalized.branch,
        normalized.workspaceRoot,
        normalized.baseCommit,
      ],
      allowNonZero: true,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode !== 0 && !(await pathExists(normalized.workspaceRoot))) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    const verificationResult = await this.#git({
      cwd: normalized.sourceRoot,
      arguments: [
        "worktree",
        "add",
        "--quiet",
        "--detach",
        normalized.verificationRoot,
        normalized.baseCommit,
      ],
      allowNonZero: true,
      ...(signal === undefined ? {} : { signal }),
    });
    let workspace: IssueGitWorkspace;
    try {
      workspace = await this.#observeWorkspace(normalized, signal);
    } catch (error) {
      if (result.exitCode !== 0 || verificationResult.exitCode !== 0) {
        throw new LocalGitIssueError("workspace_state_uncertain", { cause: error });
      }
      throw error;
    }
    await replaceJson(recordPath, {
      ...prepared,
      status: "active",
      workspace,
    });
    return workspace;
  }

  async readOwnedWorkspace(
    request: PrepareIssueGitWorkspaceRequest,
    signal?: AbortSignal,
  ): Promise<IssueGitWorkspace> {
    assertPrepareRequest(request);
    assertNotAborted(signal);
    const normalized = await this.#normalizePrepareRequest(request);
    const record = await readRequiredOwnershipRecord(
      await this.#ownershipRecordPath(normalized.ownershipId),
    );
    const requestDigest = digest("flow.issue.git-workspace-request.v1", normalized);
    if (
      record.status !== "active" ||
      record.workspace === undefined ||
      record.requestDigest !== requestDigest ||
      !samePrepareRequest(record.request, normalized)
    ) {
      throw new LocalGitIssueError("workspace_not_owned");
    }
    await this.#assertFrozenLocalSource(normalized, signal);
    const workspace = await this.#observeActiveWorkspace(normalized, signal);
    if (!sameWorkspace(record.workspace, workspace)) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    return workspace;
  }

  async inspectCandidate(
    request: InspectIssueGitCandidateRequest,
  ): Promise<IssueGitCandidateObservation> {
    try {
      return await this.#inspectCandidateOnce(request);
    } catch (error) {
      if (!(error instanceof LocalGitIssueError) || error.code !== "git_response_invalid") {
        throw error;
      }
      assertNotAborted(request.signal);
      return await this.#inspectCandidateOnce(request);
    }
  }

  async #inspectCandidateOnce(
    request: InspectIssueGitCandidateRequest,
  ): Promise<IssueGitCandidateObservation> {
    const prefixes = validateAllowedPrefixes(request.allowedWritePrefixes);
    assertCommit(request.baseCommit);
    const workspace = await this.#assertOwnedActiveWorkspace(request.workspace, request.signal);
    if (
      request.baseCommit !== workspace.baseCommit &&
      !(await this.isAncestor({
        workspace,
        ancestor: workspace.baseCommit,
        descendant: request.baseCommit,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }))
    ) {
      throw new LocalGitIssueError("base_drift");
    }
    assertNoGitlinks(
      await this.#gitBuffer({
        cwd: workspace.root,
        arguments: ["ls-files", "--stage", "-z"],
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
    );
    const head = await this.#readRequiredRef(workspace.root, "HEAD", request.signal);
    if (
      head !== (await this.#readBranchHead(workspace, request.signal)) ||
      !(await this.isAncestor({
        workspace,
        ancestor: request.baseCommit,
        descendant: head,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }))
    ) {
      throw new LocalGitIssueError("branch_drift");
    }
    const changedPaths = await this.#readChangedPaths(
      workspace,
      request.baseCommit,
      request.signal,
    );
    if (changedPaths.length > this.#maxCandidatePaths) {
      throw new LocalGitIssueError("candidate_path_limit_exceeded");
    }
    for (const path of changedPaths) {
      if (path.toLowerCase() === ".gitmodules") {
        throw new LocalGitIssueError("candidate_gitlink_unsupported");
      }
      if (!prefixes.some((prefix) => isAtOrWithinProjectPath(path, prefix))) {
        throw new LocalGitIssueError("candidate_path_disallowed");
      }
      await assertCandidatePathContained(workspace.root, path, prefixes);
    }
    await this.#assertNoFilters(workspace.root, changedPaths, request.signal);
    const preliminaryBytes = await candidateLogicalBytes(workspace.root, changedPaths);
    if (preliminaryBytes > this.#maxCandidateBytes) {
      throw new LocalGitIssueError("candidate_byte_limit_exceeded");
    }
    await this.#testOnlyBeforePrivateIndexWrite?.();
    const tree = await this.#writeCandidateTree(
      workspace,
      request.baseCommit,
      changedPaths,
      request.signal,
    );
    const exactDelta = await this.#readTreeDelta(
      workspace,
      request.baseCommit,
      tree,
      request.signal,
    );
    const exactPaths = exactDelta.map((entry) => entry.path).sort(compareStrings);
    await this.#validateExactCandidatePaths(workspace, exactPaths, prefixes, request.signal);
    const observedPaths = await this.#readChangedPaths(
      workspace,
      request.baseCommit,
      request.signal,
    );
    await this.#validateExactCandidatePaths(workspace, observedPaths, prefixes, request.signal);
    if (canonicalJson(exactPaths) !== canonicalJson(observedPaths)) {
      throw new LocalGitIssueError("candidate_tree_drift");
    }
    const logicalBytes = await this.#treeDeltaLogicalBytes(workspace, exactDelta, request.signal);
    if (logicalBytes > this.#maxCandidateBytes) {
      throw new LocalGitIssueError("candidate_byte_limit_exceeded");
    }
    return Object.freeze({
      branch: workspace.branch,
      head,
      baseCommit: request.baseCommit,
      tree,
      changedPaths: Object.freeze(changedPaths),
      logicalBytes,
      workspaceIdentityDigest: workspace.workspaceIdentityDigest,
    });
  }

  async inspectVerificationCandidate(
    request: InspectIssueGitVerificationCandidateRequest,
  ): Promise<IssueGitCandidateObservation> {
    const prefixes = validateAllowedPrefixes(request.allowedWritePrefixes);
    assertCommit(request.baseCommit);
    assertCommit(request.candidateHead);
    const workspace = await this.#assertOwnedActiveWorkspace(request.workspace, request.signal);
    if (
      request.baseCommit !== workspace.baseCommit ||
      !(await this.#isAncestorAtRoot(
        workspace.sourceRoot,
        request.baseCommit,
        request.candidateHead,
        request.signal,
      ))
    ) {
      throw new LocalGitIssueError("base_drift");
    }
    const verification = await this.#inspectCleanVerificationWorktree(
      workspace,
      request.candidateHead,
      "command-postcondition",
      request.signal,
    );
    const commit = await this.inspectCommit({
      workspace,
      commit: request.candidateHead,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (verification.tree !== commit.tree) {
      throw new LocalGitIssueError("candidate_tree_drift");
    }
    const exactDelta = await this.#readTreeDeltaAtRoot(
      workspace.verificationRoot,
      request.baseCommit,
      commit.tree,
      request.signal,
    );
    const changedPaths = exactDelta.map((entry) => entry.path).sort(compareStrings);
    await this.#validateExactCandidatePaths(
      workspace,
      changedPaths,
      prefixes,
      request.signal,
      workspace.verificationRoot,
    );
    const logicalBytes = await this.#treeDeltaLogicalBytes(workspace, exactDelta, request.signal);
    if (logicalBytes > this.#maxCandidateBytes) {
      throw new LocalGitIssueError("candidate_byte_limit_exceeded");
    }
    return Object.freeze({
      branch: workspace.branch,
      head: request.candidateHead,
      baseCommit: request.baseCommit,
      tree: commit.tree,
      changedPaths: Object.freeze(changedPaths),
      logicalBytes,
      workspaceIdentityDigest: workspace.workspaceIdentityDigest,
    });
  }

  async commitCandidate(request: CommitIssueGitCandidateRequest): Promise<IssueGitCommitResult> {
    assertCommit(request.parentCommit);
    assertCommit(request.candidateTree);
    assertCommitMessage(request.message);
    assertCommitIdentity(request.identity);
    const workspace = await this.#assertOwnedActiveWorkspace(request.workspace, request.signal);
    const candidate = await this.inspectCandidate({
      workspace,
      baseCommit: request.parentCommit,
      allowedWritePrefixes: request.allowedWritePrefixes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (candidate.tree !== request.candidateTree) {
      throw new LocalGitIssueError("candidate_tree_drift");
    }
    const branchHead = await this.#readBranchHead(workspace, request.signal);
    const commitEnvironment = {
      GIT_AUTHOR_NAME: request.identity.name,
      GIT_AUTHOR_EMAIL: request.identity.email,
      GIT_AUTHOR_DATE: request.identity.timestamp,
      GIT_COMMITTER_NAME: request.identity.name,
      GIT_COMMITTER_EMAIL: request.identity.email,
      GIT_COMMITTER_DATE: request.identity.timestamp,
    };
    const created = await this.#gitText({
      cwd: workspace.root,
      arguments: ["commit-tree", request.candidateTree, "-p", request.parentCommit],
      stdin: Buffer.from(request.message, "utf8"),
      environment: commitEnvironment,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const candidateHead = parseCommit(created);
    if (branchHead === candidateHead) {
      return Object.freeze({
        candidateHead,
        tree: request.candidateTree,
        parent: request.parentCommit,
      });
    }
    if (branchHead !== request.parentCommit) {
      throw new LocalGitIssueError("branch_drift");
    }
    const update = await this.#git({
      cwd: workspace.root,
      arguments: [
        "update-ref",
        `refs/heads/${workspace.branch}`,
        candidateHead,
        request.parentCommit,
      ],
      allowNonZero: true,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (update.exitCode !== 0) {
      const reconciled = await this.#readBranchHead(workspace, request.signal);
      if (reconciled !== candidateHead) throw new LocalGitIssueError("branch_drift");
    }
    if ((await this.#readBranchHead(workspace, request.signal)) !== candidateHead) {
      throw new LocalGitIssueError("branch_drift");
    }
    return Object.freeze({
      candidateHead,
      tree: request.candidateTree,
      parent: request.parentCommit,
    });
  }

  async pushCandidate(request: PushIssueGitCandidateRequest): Promise<IssueGitPushResult> {
    assertCommit(request.candidateHead);
    if (request.expectedRemoteHead !== null) assertCommit(request.expectedRemoteHead);
    const workspace = await this.#assertOwnedActiveWorkspace(request.workspace, request.signal);
    if (request.branch !== workspace.branch) throw new LocalGitIssueError("branch_drift");
    if ((await this.#readBranchHead(workspace, request.signal)) !== request.candidateHead) {
      throw new LocalGitIssueError("branch_drift");
    }
    await this.#assertOrigin(workspace, request.signal);
    const remoteHead = await this.#readRemoteRef(workspace, request.branch, request.signal);
    if (remoteHead === request.candidateHead) {
      return Object.freeze({ branch: request.branch, candidateHead: request.candidateHead });
    }
    if (remoteHead !== request.expectedRemoteHead) {
      throw new LocalGitIssueError("remote_drift");
    }
    if (
      request.expectedRemoteHead !== null &&
      !(await this.isAncestor({
        workspace,
        ancestor: request.expectedRemoteHead,
        descendant: request.candidateHead,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }))
    ) {
      throw new LocalGitIssueError("remote_update_rejected");
    }
    const remoteRef = `refs/heads/${request.branch}`;
    const expectedLease = request.expectedRemoteHead ?? "";
    const push = await this.#runTransportGit({
      url: this.#transportUrl(workspace.originCanonicalUrl),
      arguments: [
        "push",
        "--porcelain",
        "--no-verify",
        "--no-signed",
        "--recurse-submodules=no",
        `--force-with-lease=${remoteRef}:${expectedLease}`,
        this.#transportUrl(workspace.originCanonicalUrl),
        `${request.candidateHead}:${remoteRef}`,
      ],
      objectDirectory: await this.#objectDirectory(workspace.root),
      allowNonZero: true,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const observed = await this.#readRemoteRef(workspace, request.branch, request.signal);
    if (observed === request.candidateHead) {
      return Object.freeze({ branch: request.branch, candidateHead: request.candidateHead });
    }
    if (push.exitCode !== 0) throw new LocalGitIssueError("remote_update_rejected");
    throw new LocalGitIssueError("remote_drift");
  }

  async inspectCommit(request: InspectIssueGitCommitRequest): Promise<IssueGitCommitObservation> {
    assertCommit(request.commit);
    const workspace = await this.#assertOwnedActiveWorkspace(request.workspace, request.signal);
    const source = (
      await this.#gitBuffer({
        cwd: workspace.root,
        arguments: ["cat-file", "commit", request.commit],
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    ).toString("utf8");
    const lines = source.split("\n");
    const treeLine = lines[0];
    if (treeLine === undefined || !treeLine.startsWith("tree ")) {
      throw new LocalGitIssueError("git_response_invalid");
    }
    const tree = parseCommit(treeLine.slice(5));
    const parents: string[] = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith("parent ")) parents.push(parseCommit(line.slice(7)));
      else if (line === "") break;
    }
    return Object.freeze({ commit: request.commit, tree, parents: Object.freeze(parents) });
  }

  async isAncestor(request: IssueGitReachabilityRequest): Promise<boolean> {
    assertCommit(request.ancestor);
    assertCommit(request.descendant);
    const workspace = await this.#assertOwnedActiveWorkspace(request.workspace, request.signal);
    return await this.#isAncestorAtRoot(
      workspace.root,
      request.ancestor,
      request.descendant,
      request.signal,
    );
  }

  async inspectRemoteBranch(
    request: InspectIssueGitRemoteBranchRequest,
  ): Promise<IssueGitRemoteBranchObservation> {
    if (!isValidExactGitBranchName(request.branch)) {
      throw new LocalGitIssueError("invalid_request");
    }
    const workspace = await this.#assertOwnedActiveWorkspace(request.workspace, request.signal);
    await this.#assertOrigin(workspace, request.signal);
    const head = await this.#readRemoteRef(workspace, request.branch, request.signal);
    return Object.freeze({ branch: request.branch, head });
  }

  async fetchRemoteBranch(
    request: FetchIssueGitRemoteBranchRequest,
  ): Promise<IssueGitRemoteBranchObservation> {
    assertCommit(request.expectedHead);
    const before = await this.inspectRemoteBranch(request);
    if (before.head !== request.expectedHead) throw new LocalGitIssueError("remote_drift");
    await this.#runTransportGit({
      url: this.#transportUrl(request.workspace.originCanonicalUrl),
      arguments: [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        this.#transportUrl(request.workspace.originCanonicalUrl),
        `refs/heads/${request.branch}`,
      ],
      objectDirectory: await this.#objectDirectory(request.workspace.root),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const after = await this.inspectRemoteBranch(request);
    if (after.head !== request.expectedHead) throw new LocalGitIssueError("remote_drift");
    await this.inspectCommit({
      workspace: request.workspace,
      commit: request.expectedHead,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    return after;
  }

  async fetchPullRequestHead(
    request: FetchIssueGitPullRequestHeadRequest,
  ): Promise<IssueGitPullRequestHeadObservation> {
    if (!Number.isSafeInteger(request.pullRequestNumber) || request.pullRequestNumber <= 0) {
      throw new LocalGitIssueError("invalid_request");
    }
    assertCommit(request.expectedHead);
    const workspace = await this.#assertOwnedActiveWorkspace(request.workspace, request.signal);
    await this.#assertOrigin(workspace, request.signal);
    const remoteRef = `refs/pull/${request.pullRequestNumber}/head`;
    const before = await this.#readExactRemoteRefAtRoot(workspace.root, remoteRef, request.signal);
    if (before !== request.expectedHead) throw new LocalGitIssueError("remote_drift");
    await this.#runTransportGit({
      url: this.#transportUrl(workspace.originCanonicalUrl),
      arguments: [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        this.#transportUrl(workspace.originCanonicalUrl),
        remoteRef,
      ],
      objectDirectory: await this.#objectDirectory(workspace.root),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const after = await this.#readExactRemoteRefAtRoot(workspace.root, remoteRef, request.signal);
    if (after !== request.expectedHead) throw new LocalGitIssueError("remote_drift");
    await this.inspectCommit({
      workspace,
      commit: request.expectedHead,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    return Object.freeze({
      pullRequestNumber: request.pullRequestNumber,
      head: request.expectedHead,
    });
  }

  async inspectPatchSeries(
    request: InspectIssueGitPatchSeriesRequest,
  ): Promise<IssueGitPatchSeriesObservation> {
    assertCommit(request.baseCommit);
    assertCommit(request.headCommit);
    const workspace = await this.#assertOwnedActiveWorkspace(request.workspace, request.signal);
    if (
      !(await this.isAncestor({
        workspace,
        ancestor: request.baseCommit,
        descendant: request.headCommit,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }))
    ) {
      throw new LocalGitIssueError("base_drift");
    }
    const revList = await this.#gitBuffer({
      cwd: workspace.root,
      arguments: [
        "rev-list",
        "--reverse",
        `--max-count=${MAX_ISSUE_PATCH_COMMITS + 1}`,
        `${request.baseCommit}..${request.headCommit}`,
      ],
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const commits = parseCommitList(revList);
    if (commits.length < 1 || commits.length > MAX_ISSUE_PATCH_COMMITS) {
      throw new LocalGitIssueError("git_response_invalid");
    }
    const patchIds: string[] = [];
    let parent = request.baseCommit;
    for (const commit of commits) {
      const observed = await this.inspectCommit({
        workspace,
        commit,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (observed.parents.length !== 1 || observed.parents[0] !== parent) {
        throw new LocalGitIssueError("git_response_invalid");
      }
      const patch = await this.#gitBuffer({
        cwd: workspace.root,
        arguments: [
          "show",
          "--format=%H",
          "--no-ext-diff",
          "--no-color",
          "--full-index",
          "--binary",
          commit,
          "--",
        ],
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const patchIdOutput = await this.#gitBuffer({
        cwd: workspace.root,
        arguments: ["patch-id", "--stable"],
        stdin: patch,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      patchIds.push(parsePatchId(patchIdOutput, commit));
      parent = commit;
    }
    if (parent !== request.headCommit) throw new LocalGitIssueError("git_response_invalid");
    return Object.freeze({
      firstParent: request.baseCommit,
      headCommit: request.headCommit,
      commitCount: commits.length,
      digest: digest("flow.issue.git-patch-series.v1", patchIds),
    });
  }

  async inspectVerificationWorktree(
    request: InspectIssueGitVerificationWorktreeRequest,
  ): Promise<IssueGitVerificationWorktreeObservation> {
    assertCommit(request.commit);
    const workspace = await this.#assertOwnedActiveWorkspace(request.workspace, request.signal);
    await this.#assertAdmittedVerificationCommit(workspace, request.commit, request.signal);
    return await this.#inspectCleanVerificationWorktree(
      workspace,
      request.commit,
      request.cleanliness,
      request.signal,
    );
  }

  async resetVerificationWorktree(
    request: ResetIssueGitVerificationWorktreeRequest,
  ): Promise<IssueGitVerificationWorktreeObservation> {
    assertCommit(request.commit);
    const record = await this.#assertOwnedWorkspaceRecord(request.workspace);
    const workspace = record.workspace;
    if (workspace === undefined) throw new LocalGitIssueError("workspace_not_owned");
    await this.#assertAdmittedVerificationCommit(workspace, request.commit, request.signal);
    if (await pathExists(workspace.verificationRoot)) {
      const verificationWorktree = await this.#observeVerificationWorktree(
        record.request,
        workspace.commonGitDirectory,
        request.signal,
      );
      if (verificationWorktree.gitDirectory !== workspace.verificationGitDirectory) {
        throw new LocalGitIssueError("workspace_state_uncertain");
      }
      await this.#git({
        cwd: workspace.sourceRoot,
        arguments: ["worktree", "remove", "--force", workspace.verificationRoot],
        allowNonZero: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (await pathExists(workspace.verificationRoot)) {
        throw new LocalGitIssueError("workspace_state_uncertain");
      }
    }
    const created = await this.#git({
      cwd: workspace.sourceRoot,
      arguments: [
        "worktree",
        "add",
        "--quiet",
        "--detach",
        workspace.verificationRoot,
        request.commit,
      ],
      allowNonZero: true,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const observed = await this.#observeActiveWorkspace(record.request, request.signal).catch(
      (error: unknown) => {
        if (created.exitCode !== 0) {
          throw new LocalGitIssueError("workspace_state_uncertain", { cause: error });
        }
        throw error;
      },
    );
    if (!sameWorkspace(observed, workspace)) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    return await this.#inspectCleanVerificationWorktree(
      observed,
      request.commit,
      "pristine",
      request.signal,
    );
  }

  async cleanupWorkspace(request: CleanupIssueGitWorkspaceRequest): Promise<void> {
    assertCommit(request.expectedBranchHead);
    const recordPath = await this.#ownershipRecordPath(request.workspace.ownershipId);
    const record = await readOptionalOwnershipRecord(recordPath);
    if (
      record === undefined ||
      record.requestDigest !== workspaceRequestDigest(request.workspace)
    ) {
      throw new LocalGitIssueError("workspace_not_owned");
    }
    if (record.status === "cleaned") return;
    if (record.workspace === undefined || !sameWorkspace(record.workspace, request.workspace)) {
      throw new LocalGitIssueError("workspace_not_owned");
    }
    const workspace = record.workspace;
    if (await pathExists(workspace.root)) {
      await this.#assertOwnedActiveWorkspace(workspace, request.signal);
      if ((await this.#readBranchHead(workspace, request.signal)) !== request.expectedBranchHead) {
        throw new LocalGitIssueError("branch_drift");
      }
      const status = await this.#gitText({
        cwd: workspace.root,
        arguments: [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (status !== "") throw new LocalGitIssueError("source_dirty");
      await this.#git({
        cwd: workspace.sourceRoot,
        arguments: ["worktree", "remove", workspace.root],
        allowNonZero: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (await pathExists(workspace.root)) {
        throw new LocalGitIssueError("workspace_state_uncertain");
      }
    }
    if (await pathExists(workspace.verificationRoot)) {
      const verificationWorktree = await this.#observeVerificationWorktree(
        record.request,
        workspace.commonGitDirectory,
        request.signal,
      );
      if (verificationWorktree.gitDirectory !== workspace.verificationGitDirectory) {
        throw new LocalGitIssueError("workspace_state_uncertain");
      }
      await this.#git({
        cwd: workspace.sourceRoot,
        arguments: ["worktree", "remove", "--force", workspace.verificationRoot],
        allowNonZero: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (await pathExists(workspace.verificationRoot)) {
        throw new LocalGitIssueError("workspace_state_uncertain");
      }
    }
    const branchHead = await this.#readLocalRef(
      workspace.sourceRoot,
      workspace.branch,
      request.signal,
    );
    if (branchHead !== null && branchHead !== request.expectedBranchHead) {
      throw new LocalGitIssueError("branch_drift");
    }
    if (branchHead !== null) {
      await this.#git({
        cwd: workspace.sourceRoot,
        arguments: [
          "update-ref",
          "-d",
          `refs/heads/${workspace.branch}`,
          request.expectedBranchHead,
        ],
        allowNonZero: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (
        (await this.#readLocalRef(workspace.sourceRoot, workspace.branch, request.signal)) !== null
      ) {
        throw new LocalGitIssueError("branch_drift");
      }
    }
    await replaceJson(recordPath, { ...record, status: "cleaned", workspace });
  }

  async #normalizePrepareRequest(
    request: PrepareIssueGitWorkspaceRequest,
  ): Promise<PrepareIssueGitWorkspaceRequest> {
    const sourceRoot = await canonicalDirectory(request.sourceRoot, "source_unavailable");
    const workspaceRoot = await normalizeOwnedWorkspacePath(request.workspaceRoot);
    const verificationRoot = await normalizeOwnedWorkspacePath(request.verificationRoot);
    if (
      sourceRoot === workspaceRoot ||
      sourceRoot === verificationRoot ||
      workspaceRoot === verificationRoot
    ) {
      throw new LocalGitIssueError("workspace_not_owned");
    }
    return Object.freeze({ ...request, sourceRoot, workspaceRoot, verificationRoot });
  }

  async #reconcileExistingWorkspace(
    record: WorkspaceOwnershipRecord,
    request: PrepareIssueGitWorkspaceRequest,
    requestDigest: string,
    signal?: AbortSignal,
  ): Promise<IssueGitWorkspace> {
    if (record.requestDigest !== requestDigest || !samePrepareRequest(record.request, request)) {
      throw new LocalGitIssueError("workspace_not_owned");
    }
    if (record.status === "cleaned") throw new LocalGitIssueError("workspace_not_owned");
    await this.#assertSource(request, signal);
    if (record.status === "prepared") {
      if (!(await pathExists(request.workspaceRoot))) {
        if ((await this.#readLocalRef(request.sourceRoot, request.branch, signal)) !== null) {
          throw new LocalGitIssueError("workspace_state_uncertain");
        }
        await this.#git({
          cwd: request.sourceRoot,
          arguments: [
            "worktree",
            "add",
            "--quiet",
            "-b",
            request.branch,
            request.workspaceRoot,
            request.baseCommit,
          ],
          allowNonZero: true,
          ...(signal === undefined ? {} : { signal }),
        });
      }
      if (!(await pathExists(request.verificationRoot))) {
        await this.#git({
          cwd: request.sourceRoot,
          arguments: [
            "worktree",
            "add",
            "--quiet",
            "--detach",
            request.verificationRoot,
            request.baseCommit,
          ],
          allowNonZero: true,
          ...(signal === undefined ? {} : { signal }),
        });
      }
    }
    const workspace =
      record.status === "active"
        ? await this.#observeActiveWorkspace(request, signal)
        : await this.#observeWorkspace(request, signal);
    if (record.workspace !== undefined && !sameWorkspace(record.workspace, workspace)) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    if (record.status === "prepared") {
      await replaceJson(await this.#ownershipRecordPath(request.ownershipId), {
        ...record,
        status: "active",
        workspace,
      });
    }
    return workspace;
  }

  async #assertSource(
    request: PrepareIssueGitWorkspaceRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertFrozenLocalSource(request, signal);
    const remoteBase = await this.#readRemoteRefAtRoot(
      request.sourceRoot,
      request.baseBranch,
      signal,
    );
    if (remoteBase !== request.baseCommit) throw new LocalGitIssueError("base_drift");
  }

  async #assertFrozenLocalSource(
    request: PrepareIssueGitWorkspaceRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const branch = await this.#gitText({
      cwd: request.sourceRoot,
      arguments: ["symbolic-ref", "--short", "HEAD"],
      ...(signal === undefined ? {} : { signal }),
    }).catch((error: unknown) => {
      if (error instanceof LocalGitIssueError && error.code === "git_failed") {
        throw new LocalGitIssueError("source_detached");
      }
      throw error;
    });
    if (branch !== request.baseBranch) throw new LocalGitIssueError("source_detached");
    const observedOrigin = await this.#observeOrigin(request.sourceRoot, signal);
    if (observedOrigin.repositoryIdentity !== request.repositoryIdentity) {
      throw new LocalGitIssueError("origin_drift");
    }
    const [head, status, baseRef] = await Promise.all([
      this.#gitText({
        cwd: request.sourceRoot,
        arguments: ["rev-parse", "--verify", "HEAD"],
        ...(signal === undefined ? {} : { signal }),
      }),
      this.#gitText({
        cwd: request.sourceRoot,
        arguments: [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        ...(signal === undefined ? {} : { signal }),
      }),
      this.#readLocalRef(request.sourceRoot, request.baseBranch, signal),
    ]);
    if (head !== request.baseCommit || baseRef !== request.baseCommit) {
      throw new LocalGitIssueError("base_drift");
    }
    if (status !== "") throw new LocalGitIssueError("source_dirty");
  }

  async #observeWorkspace(
    request: PrepareIssueGitWorkspaceRequest,
    signal?: AbortSignal,
  ): Promise<IssueGitWorkspace> {
    const root = await canonicalDirectory(request.workspaceRoot, "workspace_state_uncertain");
    if (root !== request.workspaceRoot) throw new LocalGitIssueError("workspace_state_uncertain");
    const gitFile = join(root, ".git");
    const metadata = await lstat(gitFile).catch(() => undefined);
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    const gitFileSource = await readBoundedText(gitFile, 16_384);
    const match = /^gitdir: (.+)\n?$/.exec(gitFileSource);
    if (match?.[1] === undefined || !isAbsolute(match[1])) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    const gitDirectory = await canonicalDirectory(match[1], "workspace_state_uncertain");
    const [commonGitDirectory, branch, head, observedOrigin] = await Promise.all([
      this.#gitText({
        cwd: root,
        arguments: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ...(signal === undefined ? {} : { signal }),
      }),
      this.#gitText({
        cwd: root,
        arguments: ["symbolic-ref", "--short", "HEAD"],
        ...(signal === undefined ? {} : { signal }),
      }),
      this.#gitText({
        cwd: root,
        arguments: ["rev-parse", "--verify", "HEAD"],
        ...(signal === undefined ? {} : { signal }),
      }),
      this.#observeOrigin(root, signal),
    ]);
    const canonicalCommon = await canonicalDirectory(
      commonGitDirectory,
      "workspace_state_uncertain",
    );
    const sourceCommon = await this.#gitText({
      cwd: request.sourceRoot,
      arguments: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      canonicalCommon !== (await canonicalDirectory(sourceCommon, "source_drift")) ||
      !isWithin(canonicalCommon, gitDirectory) ||
      branch !== request.branch ||
      head !== request.baseCommit
    ) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    if (observedOrigin.repositoryIdentity !== request.repositoryIdentity) {
      throw new LocalGitIssueError("origin_drift");
    }
    const identity = {
      version: 1 as const,
      ownershipId: request.ownershipId,
      sourceRoot: request.sourceRoot,
      root,
      verificationRoot: request.verificationRoot,
      commonGitDirectory: canonicalCommon,
      gitDirectory,
      verificationGitDirectory: (
        await this.#observeVerificationWorktree(request, canonicalCommon, signal)
      ).gitDirectory,
      repositoryIdentity: request.repositoryIdentity,
      originCanonicalUrl: observedOrigin.canonicalUrl,
      branch: request.branch,
      baseBranch: request.baseBranch,
      baseCommit: request.baseCommit,
    };
    return Object.freeze({
      ...identity,
      workspaceIdentityDigest: digest("flow.issue.git-workspace.v1", identity),
    });
  }

  async #assertOwnedActiveWorkspace(
    supplied: IssueGitWorkspace,
    signal?: AbortSignal,
  ): Promise<IssueGitWorkspace> {
    assertWorkspaceShape(supplied);
    const record = await this.#assertOwnedWorkspaceRecord(supplied);
    const observed = await this.#observeActiveWorkspace(record.request, signal);
    if (!sameWorkspace(observed, supplied)) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    return observed;
  }

  async #assertOwnedWorkspaceRecord(
    supplied: IssueGitWorkspace,
  ): Promise<WorkspaceOwnershipRecord> {
    assertWorkspaceShape(supplied);
    const record = await readOptionalOwnershipRecord(
      await this.#ownershipRecordPath(supplied.ownershipId),
    );
    if (
      record === undefined ||
      record.status !== "active" ||
      record.workspace === undefined ||
      !sameWorkspace(record.workspace, supplied) ||
      workspaceRequestDigest(supplied) !== record.requestDigest
    ) {
      throw new LocalGitIssueError("workspace_not_owned");
    }
    return record;
  }

  async #observeActiveWorkspace(
    request: PrepareIssueGitWorkspaceRequest,
    signal?: AbortSignal,
  ): Promise<IssueGitWorkspace> {
    const workspace = await this.#observeWorkspaceWithoutHeadConstraint(request, signal);
    await this.#assertOrigin(workspace, signal);
    return workspace;
  }

  async #observeWorkspaceWithoutHeadConstraint(
    request: PrepareIssueGitWorkspaceRequest,
    signal?: AbortSignal,
  ): Promise<IssueGitWorkspace> {
    const root = await canonicalDirectory(request.workspaceRoot, "workspace_state_uncertain");
    const gitFile = join(root, ".git");
    const metadata = await lstat(gitFile).catch(() => undefined);
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    const source = await readBoundedText(gitFile, 16_384);
    const match = /^gitdir: (.+)\n?$/.exec(source);
    if (match?.[1] === undefined || !isAbsolute(match[1])) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    const gitDirectory = await canonicalDirectory(match[1], "workspace_state_uncertain");
    const commonOutput = await this.#gitText({
      cwd: root,
      arguments: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ...(signal === undefined ? {} : { signal }),
    });
    const commonGitDirectory = await canonicalDirectory(commonOutput, "workspace_state_uncertain");
    if (!isWithin(commonGitDirectory, gitDirectory)) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    const sourceCommonOutput = await this.#gitText({
      cwd: request.sourceRoot,
      arguments: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ...(signal === undefined ? {} : { signal }),
    });
    const sourceCommonGitDirectory = await canonicalDirectory(sourceCommonOutput, "source_drift");
    if (sourceCommonGitDirectory !== commonGitDirectory) {
      throw new LocalGitIssueError("source_drift");
    }
    const branch = await this.#gitText({
      cwd: root,
      arguments: ["symbolic-ref", "--short", "HEAD"],
      ...(signal === undefined ? {} : { signal }),
    });
    if (branch !== request.branch) throw new LocalGitIssueError("branch_drift");
    const observedOrigin = await this.#observeOrigin(root, signal);
    if (observedOrigin.repositoryIdentity !== request.repositoryIdentity) {
      throw new LocalGitIssueError("origin_drift");
    }
    const identity = {
      version: 1 as const,
      ownershipId: request.ownershipId,
      sourceRoot: request.sourceRoot,
      root,
      verificationRoot: request.verificationRoot,
      commonGitDirectory,
      gitDirectory,
      verificationGitDirectory: (
        await this.#observeVerificationWorktree(request, commonGitDirectory, signal)
      ).gitDirectory,
      repositoryIdentity: request.repositoryIdentity,
      originCanonicalUrl: observedOrigin.canonicalUrl,
      branch: request.branch,
      baseBranch: request.baseBranch,
      baseCommit: request.baseCommit,
    };
    return Object.freeze({
      ...identity,
      workspaceIdentityDigest: digest("flow.issue.git-workspace.v1", identity),
    });
  }

  async #observeVerificationWorktree(
    request: PrepareIssueGitWorkspaceRequest,
    expectedCommonGitDirectory: string,
    signal?: AbortSignal,
  ): Promise<{ readonly gitDirectory: string; readonly head: string; readonly tree: string }> {
    const root = await canonicalDirectory(request.verificationRoot, "workspace_state_uncertain");
    if (root !== request.verificationRoot)
      throw new LocalGitIssueError("workspace_state_uncertain");
    const gitFile = join(root, ".git");
    const metadata = await lstat(gitFile).catch(() => undefined);
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    const source = await readBoundedText(gitFile, 16_384);
    const match = /^gitdir: (.+)\n?$/.exec(source);
    if (match?.[1] === undefined || !isAbsolute(match[1])) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    const gitDirectory = await canonicalDirectory(match[1], "workspace_state_uncertain");
    const commonGitDirectory = await canonicalDirectory(
      await this.#gitText({
        cwd: root,
        arguments: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ...(signal === undefined ? {} : { signal }),
      }),
      "workspace_state_uncertain",
    );
    const detached = await this.#git({
      cwd: root,
      arguments: ["symbolic-ref", "--quiet", "HEAD"],
      acceptedExitCodes: [0, 1],
      ...(signal === undefined ? {} : { signal }),
    });
    const [head, tree, observedOrigin] = await Promise.all([
      this.#gitText({
        cwd: root,
        arguments: ["rev-parse", "--verify", "HEAD"],
        ...(signal === undefined ? {} : { signal }),
      }),
      this.#gitText({
        cwd: root,
        arguments: ["rev-parse", "--verify", "HEAD^{tree}"],
        ...(signal === undefined ? {} : { signal }),
      }),
      this.#observeOrigin(root, signal),
    ]);
    if (
      commonGitDirectory !== expectedCommonGitDirectory ||
      !isWithin(commonGitDirectory, gitDirectory) ||
      detached.exitCode !== 1 ||
      detached.stdout.length !== 0 ||
      observedOrigin.repositoryIdentity !== request.repositoryIdentity
    ) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    return Object.freeze({ gitDirectory, head: parseCommit(head), tree: parseCommit(tree) });
  }

  async #inspectCleanVerificationWorktree(
    workspace: IssueGitWorkspace,
    expectedCommit: string,
    cleanliness: "pristine" | "command-postcondition",
    signal?: AbortSignal,
  ): Promise<IssueGitVerificationWorktreeObservation> {
    const observed = await this.#observeVerificationWorktree(
      {
        ownershipId: workspace.ownershipId,
        sourceRoot: workspace.sourceRoot,
        workspaceRoot: workspace.root,
        verificationRoot: workspace.verificationRoot,
        repositoryIdentity: workspace.repositoryIdentity,
        baseBranch: workspace.baseBranch,
        baseCommit: workspace.baseCommit,
        branch: workspace.branch,
      },
      workspace.commonGitDirectory,
      signal,
    );
    if (observed.head !== expectedCommit) {
      throw new LocalGitIssueError("workspace_state_uncertain");
    }
    const status = await this.#gitBuffer({
      cwd: workspace.verificationRoot,
      arguments: [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        ...(cleanliness === "pristine" ? ["--ignored=matching"] : []),
        "--ignore-submodules=none",
      ],
      ...(signal === undefined ? {} : { signal }),
    });
    if (status.length !== 0) throw new LocalGitIssueError("source_dirty");
    return Object.freeze({
      head: observed.head,
      tree: observed.tree,
      status: "clean",
      workspaceIdentityDigest: workspace.workspaceIdentityDigest,
    });
  }

  async #assertAdmittedVerificationCommit(
    workspace: IssueGitWorkspace,
    commit: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (commit === workspace.baseCommit) return;
    if (
      !(await this.#isAncestorAtRoot(workspace.sourceRoot, workspace.baseCommit, commit, signal))
    ) {
      throw new LocalGitIssueError("base_drift");
    }
  }

  async #isAncestorAtRoot(
    root: string,
    ancestor: string,
    descendant: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.#git({
      cwd: root,
      arguments: ["merge-base", "--is-ancestor", ancestor, descendant],
      acceptedExitCodes: [0, 1],
      ...(signal === undefined ? {} : { signal }),
    });
    return result.exitCode === 0;
  }

  async #readChangedPaths(
    workspace: IssueGitWorkspace,
    baseCommit: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const [tracked, untracked] = await Promise.all([
      this.#gitBuffer({
        cwd: workspace.root,
        arguments: ["diff", "--no-renames", "--name-only", "-z", baseCommit, "--"],
        ...(signal === undefined ? {} : { signal }),
      }),
      this.#gitBuffer({
        cwd: workspace.root,
        arguments: ["ls-files", "--others", "--exclude-standard", "-z", "--"],
        ...(signal === undefined ? {} : { signal }),
      }),
    ]);
    const paths = [...parseNulList(tracked), ...parseNulList(untracked)];
    return [...new Set(paths)].sort(compareStrings);
  }

  async #assertNoFilters(
    root: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (paths.length === 0) return;
    const result = await this.#gitBuffer({
      cwd: root,
      arguments: ["check-attr", "-z", "--stdin", "filter"],
      stdin: Buffer.from(`${paths.join("\0")}\0`, "utf8"),
      ...(signal === undefined ? {} : { signal }),
    });
    const fields = parseNulList(result);
    if (fields.length !== paths.length * 3) throw new LocalGitIssueError("git_response_invalid");
    for (let index = 2; index < fields.length; index += 3) {
      const value = fields[index];
      if (value !== "unspecified" && value !== "unset") {
        throw new LocalGitIssueError("candidate_filter_unsupported");
      }
    }
  }

  async #writeCandidateTree(
    workspace: IssueGitWorkspace,
    baseCommit: string,
    changedPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const indexRoot = await this.#privateTemporaryDirectory("index-");
    const indexPath = join(indexRoot, "candidate.index");
    const environment = { GIT_INDEX_FILE: indexPath };
    try {
      await this.#gitText({
        cwd: workspace.root,
        arguments: ["read-tree", baseCommit],
        environment,
        ...(signal === undefined ? {} : { signal }),
      });
      for (const path of changedPaths) {
        const target = join(workspace.root, path);
        const metadata = await lstat(target).catch((error: unknown) => {
          if (isNodeError(error, "ENOENT")) return undefined;
          throw error;
        });
        if (metadata === undefined) {
          await this.#gitText({
            cwd: workspace.root,
            arguments: ["update-index", "--remove", "--", path],
            environment,
            ...(signal === undefined ? {} : { signal }),
          });
          continue;
        }
        if (metadata.isSymbolicLink()) {
          throw new LocalGitIssueError("candidate_symlink_escape");
        }
        if (!metadata.isFile()) throw new LocalGitIssueError("candidate_path_disallowed");
        const object = parseCommit(
          await this.#gitText({
            cwd: workspace.root,
            arguments: ["hash-object", "-w", "--no-filters", "--", path],
            ...(signal === undefined ? {} : { signal }),
          }),
        );
        const mode = (metadata.mode & 0o111) === 0 ? "100644" : "100755";
        await this.#gitText({
          cwd: workspace.root,
          arguments: ["update-index", "--add", "--cacheinfo", `${mode},${object},${path}`],
          environment,
          ...(signal === undefined ? {} : { signal }),
        });
      }
      const stages = await this.#gitBuffer({
        cwd: workspace.root,
        arguments: ["ls-files", "--stage", "-z"],
        environment,
        ...(signal === undefined ? {} : { signal }),
      });
      assertNoGitlinks(stages);
      return parseCommit(
        await this.#gitText({
          cwd: workspace.root,
          arguments: ["write-tree"],
          environment,
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    } finally {
      await rm(indexRoot, { force: true, recursive: true });
    }
  }

  async #validateExactCandidatePaths(
    workspace: IssueGitWorkspace,
    paths: readonly string[],
    prefixes: readonly string[],
    signal?: AbortSignal,
    root = workspace.root,
  ): Promise<void> {
    if (paths.length > this.#maxCandidatePaths) {
      throw new LocalGitIssueError("candidate_path_limit_exceeded");
    }
    for (const path of paths) {
      if (path.toLowerCase() === ".gitmodules") {
        throw new LocalGitIssueError("candidate_gitlink_unsupported");
      }
      if (!prefixes.some((prefix) => isAtOrWithinProjectPath(path, prefix))) {
        throw new LocalGitIssueError("candidate_path_disallowed");
      }
      await assertCandidatePathContained(root, path, prefixes);
    }
    await this.#assertNoFilters(root, paths, signal);
  }

  async #readTreeDelta(
    workspace: IssueGitWorkspace,
    baseCommit: string,
    tree: string,
    signal?: AbortSignal,
  ): Promise<readonly TreeDeltaEntry[]> {
    return await this.#readTreeDeltaAtRoot(workspace.root, baseCommit, tree, signal);
  }

  async #readTreeDeltaAtRoot(
    root: string,
    baseCommit: string,
    tree: string,
    signal?: AbortSignal,
  ): Promise<readonly TreeDeltaEntry[]> {
    const source = await this.#gitBuffer({
      cwd: root,
      arguments: [
        "diff-tree",
        "--no-commit-id",
        "--raw",
        "-r",
        "-z",
        "--no-renames",
        "--no-abbrev",
        baseCommit,
        tree,
        "--",
      ],
      ...(signal === undefined ? {} : { signal }),
    });
    const fields = parseNulList(source);
    if (fields.length % 2 !== 0) throw new LocalGitIssueError("git_response_invalid");
    const entries: TreeDeltaEntry[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      const header = fields[index];
      const path = fields[index + 1];
      const match =
        header === undefined
          ? null
          : /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) [AMDT]$/.exec(header);
      if (match === null || path === undefined) {
        throw new LocalGitIssueError("git_response_invalid");
      }
      const [, oldMode, newMode, oldObject, newObject] = match;
      if (
        oldMode === undefined ||
        newMode === undefined ||
        oldObject === undefined ||
        newObject === undefined ||
        oldMode === "160000" ||
        newMode === "160000" ||
        newMode === "120000"
      ) {
        throw new LocalGitIssueError("candidate_gitlink_unsupported");
      }
      entries.push(Object.freeze({ path, oldMode, newMode, oldObject, newObject }));
    }
    return Object.freeze(entries);
  }

  async #treeDeltaLogicalBytes(
    workspace: IssueGitWorkspace,
    entries: readonly TreeDeltaEntry[],
    signal?: AbortSignal,
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const objects = entries.map((entry) =>
      entry.newObject === "0".repeat(40) ? entry.oldObject : entry.newObject,
    );
    const output = (
      await this.#gitBuffer({
        cwd: workspace.root,
        arguments: ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        stdin: Buffer.from(`${objects.join("\n")}\n`, "utf8"),
        ...(signal === undefined ? {} : { signal }),
      })
    ).toString("utf8");
    if (!output.endsWith("\n") || output.includes("\0") || output.includes("\r")) {
      throw new LocalGitIssueError("git_response_invalid");
    }
    const lines = output.slice(0, -1).split("\n");
    if (lines.length !== objects.length) throw new LocalGitIssueError("git_response_invalid");
    let total = 0;
    for (const [index, line] of lines.entries()) {
      const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(line);
      const expected = objects[index];
      const size = match?.[2] === undefined ? Number.NaN : Number(match[2]);
      if (match?.[1] !== expected || !Number.isSafeInteger(size) || size < 0) {
        throw new LocalGitIssueError("git_response_invalid");
      }
      total += size;
      if (!Number.isSafeInteger(total)) {
        throw new LocalGitIssueError("candidate_byte_limit_exceeded");
      }
    }
    return total;
  }

  async #assertOrigin(workspace: IssueGitWorkspace, signal?: AbortSignal): Promise<void> {
    const origin = await this.#observeOrigin(workspace.root, signal);
    if (
      origin.repositoryIdentity !== workspace.repositoryIdentity ||
      origin.canonicalUrl !== workspace.originCanonicalUrl
    ) {
      throw new LocalGitIssueError("origin_drift");
    }
  }

  async #observeOrigin(cwd: string, signal?: AbortSignal): Promise<NormalizedGitHubIssueOrigin> {
    let fetchUrl: string;
    try {
      fetchUrl = parseExactLocalGitOriginConfiguration(
        (
          await this.#git({
            cwd,
            arguments: ["config", "--local", "--null", "--list"],
            ...(signal === undefined ? {} : { signal }),
          })
        ).stdout,
      );
    } catch {
      throw new LocalGitIssueError("origin_drift");
    }
    if (this.#testOnlyLocalRemotePath !== undefined && fetchUrl === this.#testOnlyLocalRemotePath) {
      return Object.freeze({
        repositoryIdentity: "example/project",
        canonicalUrl: "https://github.com/example/project",
      });
    }
    try {
      return normalizeGitHubIssueOrigin(fetchUrl);
    } catch {
      throw new LocalGitIssueError("origin_drift");
    }
  }

  async #readBranchHead(workspace: IssueGitWorkspace, signal?: AbortSignal): Promise<string> {
    return await this.#readRequiredRef(workspace.root, `refs/heads/${workspace.branch}`, signal);
  }

  async #readRequiredRef(cwd: string, ref: string, signal?: AbortSignal): Promise<string> {
    return parseCommit(
      await this.#gitText({
        cwd,
        arguments: ["rev-parse", "--verify", ref],
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  }

  async #readLocalRef(cwd: string, branch: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.#git({
      cwd,
      arguments: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      acceptedExitCodes: [0, 1],
      ...(signal === undefined ? {} : { signal }),
    });
    return result.exitCode === 1 ? null : parseCommit(parseSingleLine(result.stdout));
  }

  async #readRemoteRef(
    workspace: IssueGitWorkspace,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return await this.#readRemoteRefAtRoot(workspace.root, branch, signal);
  }

  async #readRemoteRefAtRoot(
    cwd: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return await this.#readExactRemoteRefAtRoot(cwd, `refs/heads/${branch}`, signal);
  }

  async #readExactRemoteRefAtRoot(
    cwd: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const origin = await this.#observeOrigin(cwd, signal);
    const url = this.#transportUrl(origin.canonicalUrl);
    const output = (
      await this.#runTransportGit({
        url,
        arguments: ["ls-remote", "--refs", url, ref],
        ...(signal === undefined ? {} : { signal }),
      })
    ).stdout;
    if (output.byteLength === 0) return null;
    const line = parseSingleLine(output);
    const separator = line.indexOf("\t");
    if (separator !== 40 || line.slice(separator + 1) !== ref) {
      throw new LocalGitIssueError("git_response_invalid");
    }
    return parseCommit(line.slice(0, separator));
  }

  async #objectDirectory(cwd: string, signal?: AbortSignal): Promise<string> {
    const commonOutput = await this.#gitText({
      cwd,
      arguments: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ...(signal === undefined ? {} : { signal }),
    });
    const common = await canonicalDirectory(commonOutput, "workspace_state_uncertain");
    return await canonicalDirectory(join(common, "objects"), "workspace_state_uncertain");
  }

  #transportUrl(canonicalOriginUrl: string): string {
    return this.#testOnlyLocalRemotePath ?? `${canonicalOriginUrl}.git`;
  }

  async #runTransportGit(options: {
    readonly url: string;
    readonly arguments: readonly string[];
    readonly objectDirectory?: string;
    readonly signal?: AbortSignal;
    readonly allowNonZero?: boolean;
  }): Promise<StrictHostProcessResult> {
    const transportRoot = await this.#privateTemporaryDirectory("transport-");
    let operationFailed = false;
    let operationError: unknown;
    let result: StrictHostProcessResult | undefined;
    try {
      const templateRoot = join(transportRoot, "template");
      const repositoryRoot = join(transportRoot, "repository.git");
      await mkdir(templateRoot, { mode: 0o700 });
      await this.#git({
        cwd: transportRoot,
        arguments: ["init", "--bare", "--quiet", `--template=${templateRoot}`, repositoryRoot],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const isLocalTest =
        this.#testOnlyLocalRemotePath !== undefined &&
        options.url === this.#testOnlyLocalRemotePath;
      const arguments_: string[] = [
        "-c",
        "protocol.allow=never",
        "-c",
        `protocol.${isLocalTest ? "file" : "https"}.allow=always`,
        "-c",
        "credential.helper=",
        "-c",
        "credential.interactive=false",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
        "http.followRedirects=false",
      ];
      const environment: Record<string, string> = {};
      if (options.objectDirectory !== undefined) {
        environment.GIT_OBJECT_DIRECTORY = options.objectDirectory;
      }
      if (!isLocalTest) {
        if (`${normalizeGitHubIssueOrigin(options.url).canonicalUrl}.git` !== options.url) {
          throw new LocalGitIssueError("origin_drift");
        }
        if (this.#credentialBroker === undefined) {
          throw new LocalGitIssueError("authentication_failed");
        }
        let authorizationHeader: string;
        try {
          authorizationHeader = await this.#credentialBroker.authorizationHeader(options.signal);
        } catch (error) {
          throw new LocalGitIssueError("authentication_failed", { cause: error });
        }
        const environmentName = "FLOW_GIT_AUTHORIZATION_HEADER";
        arguments_.push(`--config-env=http.${options.url}.extraHeader=${environmentName}`);
        environment[environmentName] = authorizationHeader;
      }
      arguments_.push(...options.arguments);
      result = await this.#git({
        cwd: repositoryRoot,
        arguments: arguments_,
        environment,
        ...(options.allowNonZero === undefined ? {} : { allowNonZero: options.allowNonZero }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    let cleanupError: unknown;
    try {
      await rm(transportRoot, { recursive: true, force: true, maxRetries: 2 });
    } catch (error) {
      cleanupError = error;
    }
    if (operationFailed) {
      if (cleanupError === undefined) throw operationError;
      const cause = new AggregateError(
        [operationError, cleanupError],
        "Git transport operation and private temporary directory cleanup both failed",
      );
      if (operationError instanceof LocalGitIssueError) {
        throw new LocalGitIssueError(operationError.code, { cause });
      }
      throw cause;
    }
    if (cleanupError !== undefined) {
      throw new LocalGitIssueError("workspace_state_uncertain", { cause: cleanupError });
    }
    if (result === undefined) throw new LocalGitIssueError("workspace_state_uncertain");
    return result;
  }

  async #ownershipRecordPath(ownershipId: string): Promise<string> {
    if (!OWNERSHIP_ID_PATTERN.test(ownershipId) || ownershipId.length > 128) {
      throw new LocalGitIssueError("invalid_request");
    }
    const privateRoot = await canonicalDirectory(this.#privateRoot, "workspace_not_owned");
    const directory = join(privateRoot, PRIVATE_DIRECTORY_NAME);
    await mkdir(directory, { mode: 0o700, recursive: true });
    const canonical = await canonicalDirectory(directory, "workspace_not_owned");
    if (!isWithin(privateRoot, canonical)) throw new LocalGitIssueError("workspace_not_owned");
    return join(canonical, `${ownershipId}.json`);
  }

  async #privateTemporaryDirectory(prefix: string): Promise<string> {
    const privateRoot = await canonicalDirectory(this.#privateRoot, "workspace_not_owned");
    const directory = join(privateRoot, "git-temporary");
    await mkdir(directory, { mode: 0o700, recursive: true });
    const canonical = await canonicalDirectory(directory, "workspace_not_owned");
    if (!isWithin(privateRoot, canonical)) throw new LocalGitIssueError("workspace_not_owned");
    return await mkdtemp(join(canonical, prefix));
  }

  async #gitText(options: GitCommandOptions): Promise<string> {
    return parseSingleLineOrEmpty(await this.#gitBuffer(options));
  }

  async #gitBuffer(options: GitCommandOptions): Promise<Buffer> {
    return (await this.#git(options)).stdout;
  }

  async #git(options: GitCommandOptions): Promise<StrictHostProcessResult> {
    assertNotAborted(options.signal);
    const environment = {
      ...this.#environment,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_EXTERNAL_DIFF: "",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
      PAGER: "cat",
      ...(options.environment ?? {}),
    };
    const runner = new StrictHostProcess({
      executable: this.#gitExecutable,
      environment,
      timeoutMs: this.#timeoutMs,
      maxStdoutBytes: MAX_GIT_STDOUT_BYTES,
      maxStderrBytes: MAX_GIT_STDERR_BYTES,
    });
    const result = await runner.run({
      cwd: options.cwd,
      arguments: [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        "-c",
        "diff.external=",
        ...options.arguments,
      ],
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.termination === "abort") throw new LocalGitIssueError("operation_aborted");
    if (result.termination === "timeout") throw new LocalGitIssueError("git_timed_out");
    if (result.termination === "output_limit") {
      throw new LocalGitIssueError("git_output_limit_exceeded");
    }
    if (result.termination !== "exit") throw new LocalGitIssueError("git_unavailable");
    const accepted = options.acceptedExitCodes ?? [0];
    if (
      result.exitCode === null ||
      (!options.allowNonZero && !accepted.includes(result.exitCode))
    ) {
      throw new LocalGitIssueError("git_failed");
    }
    return result;
  }
}

export function normalizeGitHubIssueOrigin(source: string): NormalizedGitHubIssueOrigin {
  if (
    source !== source.trim() ||
    source.length < 1 ||
    source.length > 4_096 ||
    source.includes("\0") ||
    source.includes("%")
  ) {
    throw new LocalGitIssueError("invalid_request");
  }
  let owner: string | undefined;
  let repository: string | undefined;
  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(source);
  if (scp !== null) {
    owner = scp[1];
    repository = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new LocalGitIssueError("invalid_request");
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "ssh:") ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.protocol === "https:" && url.username !== "") ||
      (url.protocol === "ssh:" && url.username !== "git")
    ) {
      throw new LocalGitIssueError("invalid_request");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) throw new LocalGitIssueError("invalid_request");
    [owner, repository] = segments;
  }
  if (repository?.endsWith(".git")) repository = repository.slice(0, -4);
  if (owner === undefined || repository === undefined) {
    throw new LocalGitIssueError("invalid_request");
  }
  let repositoryIdentity: string;
  try {
    repositoryIdentity = canonicalGitHubRepositoryIdentity(`${owner}/${repository}`);
  } catch {
    throw new LocalGitIssueError("invalid_request");
  }
  return Object.freeze({
    repositoryIdentity,
    canonicalUrl: `https://github.com/${repositoryIdentity}`,
  });
}

function normalizeTestRemotePath(path: string): string {
  assertAbsolutePath(path);
  return resolve(path);
}

function validateHostEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const forbidden = new Set([
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
  ]);
  for (const [name, value] of Object.entries(environment)) {
    if (
      forbidden.has(name) ||
      name.startsWith("GIT_CONFIG_KEY_") ||
      name.startsWith("GIT_CONFIG_VALUE_") ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      value.includes("\0")
    ) {
      throw new LocalGitIssueError("invalid_request");
    }
  }
  return Object.freeze({ ...environment });
}

function assertPrepareRequest(request: PrepareIssueGitWorkspaceRequest): void {
  assertAbsolutePath(request.sourceRoot);
  assertAbsolutePath(request.workspaceRoot);
  assertAbsolutePath(request.verificationRoot);
  if (
    request.sourceRoot === request.workspaceRoot ||
    request.sourceRoot === request.verificationRoot ||
    request.workspaceRoot === request.verificationRoot ||
    !isValidExactGitBranchName(request.baseBranch) ||
    !isValidExactGitBranchName(request.branch) ||
    request.baseBranch === request.branch ||
    !OWNERSHIP_ID_PATTERN.test(request.ownershipId) ||
    request.ownershipId.length > 128
  ) {
    throw new LocalGitIssueError("invalid_request");
  }
  try {
    if (
      canonicalGitHubRepositoryIdentity(request.repositoryIdentity) !== request.repositoryIdentity
    ) {
      throw new Error("repository identity must be canonical");
    }
  } catch {
    throw new LocalGitIssueError("invalid_request");
  }
  assertCommit(request.baseCommit);
}

function assertWorkspaceShape(workspace: IssueGitWorkspace): void {
  if (
    workspace.version !== 1 ||
    !SHA256_PATTERN.test(workspace.workspaceIdentityDigest) ||
    workspace.workspaceIdentityDigest !==
      digest("flow.issue.git-workspace.v1", {
        version: workspace.version,
        ownershipId: workspace.ownershipId,
        sourceRoot: workspace.sourceRoot,
        root: workspace.root,
        verificationRoot: workspace.verificationRoot,
        commonGitDirectory: workspace.commonGitDirectory,
        gitDirectory: workspace.gitDirectory,
        verificationGitDirectory: workspace.verificationGitDirectory,
        repositoryIdentity: workspace.repositoryIdentity,
        originCanonicalUrl: workspace.originCanonicalUrl,
        branch: workspace.branch,
        baseBranch: workspace.baseBranch,
        baseCommit: workspace.baseCommit,
      })
  ) {
    throw new LocalGitIssueError("workspace_not_owned");
  }
}

function workspaceRequestDigest(workspace: IssueGitWorkspace): string {
  return digest("flow.issue.git-workspace-request.v1", {
    ownershipId: workspace.ownershipId,
    sourceRoot: workspace.sourceRoot,
    workspaceRoot: workspace.root,
    verificationRoot: workspace.verificationRoot,
    repositoryIdentity: workspace.repositoryIdentity,
    baseBranch: workspace.baseBranch,
    baseCommit: workspace.baseCommit,
    branch: workspace.branch,
  });
}

function validateAllowedPrefixes(prefixes: readonly string[]): readonly string[] {
  if (prefixes.length < 1 || prefixes.length > 64) {
    throw new LocalGitIssueError("candidate_prefix_invalid");
  }
  const parsed = prefixes.map((prefix) => {
    assertProjectPath(prefix, "candidate_prefix_invalid");
    const first = prefix.split("/")[0]?.toLowerCase();
    if (first === ".git" || first === ".flow") {
      throw new LocalGitIssueError("candidate_prefix_invalid");
    }
    return prefix;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new LocalGitIssueError("candidate_prefix_invalid");
  }
  return Object.freeze([...parsed].sort(compareStrings));
}

function assertProjectPath(path: string, code: LocalGitIssueErrorCode): void {
  const segments = path.split("/");
  if (
    path.length < 1 ||
    path.length > 4_095 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    /[\p{Cc}\p{Cf}]/u.test(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new LocalGitIssueError(code);
  }
}

async function assertCandidatePathContained(
  root: string,
  path: string,
  prefixes: readonly string[],
): Promise<void> {
  assertProjectPath(path, "candidate_path_disallowed");
  const lexical = resolve(root, path);
  if (!isWithin(root, lexical)) throw new LocalGitIssueError("candidate_path_disallowed");
  let candidate = root;
  for (const segment of path.split("/")) {
    candidate = join(candidate, segment);
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        const canonical = await realpath(candidate).catch(() => undefined);
        if (
          canonical === undefined ||
          !isWithin(root, canonical) ||
          !prefixes.some((prefix) => isAtOrWithinAbsolute(canonical, resolve(root, prefix)))
        ) {
          throw new LocalGitIssueError("candidate_symlink_escape");
        }
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) break;
      throw error;
    }
  }
}

async function candidateLogicalBytes(root: string, paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const path of paths) {
    const target = join(root, path);
    try {
      const metadata = await lstat(target);
      total += metadata.isSymbolicLink()
        ? Buffer.byteLength(await readlink(target), "utf8")
        : metadata.isFile()
          ? metadata.size
          : 0;
      if (!Number.isSafeInteger(total))
        throw new LocalGitIssueError("candidate_byte_limit_exceeded");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  return total;
}

function assertNoGitlinks(source: Buffer): void {
  for (const entry of parseNulList(source)) {
    if (entry.startsWith("160000 ")) throw new LocalGitIssueError("candidate_gitlink_unsupported");
  }
}

function assertCommitIdentity(identity: CommitIssueGitCandidateRequest["identity"]): void {
  for (const value of [identity.name, identity.email]) {
    if (
      value.length < 1 ||
      value.length > 320 ||
      value !== value.trim() ||
      /[\0\r\n<>]/.test(value)
    ) {
      throw new LocalGitIssueError("invalid_request");
    }
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(identity.timestamp) ||
    new Date(identity.timestamp).toISOString() !== identity.timestamp
  ) {
    throw new LocalGitIssueError("invalid_request");
  }
}

function assertCommitMessage(message: string): void {
  if (
    message.length < 2 ||
    Buffer.byteLength(message, "utf8") > 65_536 ||
    !message.endsWith("\n") ||
    message.includes("\0")
  ) {
    throw new LocalGitIssueError("invalid_request");
  }
}

function assertCommit(value: string): void {
  if (!SHA1_PATTERN.test(value)) throw new LocalGitIssueError("invalid_request");
}

function assertAbsolutePath(path: string): void {
  if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > 4_095) {
    throw new LocalGitIssueError("invalid_request");
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new LocalGitIssueError("operation_aborted");
}

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new LocalGitIssueError("invalid_request");
  }
  return value;
}

async function canonicalDirectory(path: string, code: LocalGitIssueErrorCode): Promise<string> {
  try {
    const canonical = await realpath(path);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    if (error instanceof LocalGitIssueError) throw error;
    throw new LocalGitIssueError(code);
  }
}

async function readBoundedText(path: string, maximumBytes: number): Promise<string> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > maximumBytes
  ) {
    throw new LocalGitIssueError("git_response_invalid");
  }
  return await readFile(path, "utf8");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw new LocalGitIssueError("workspace_state_uncertain");
  }
}

async function readOptionalOwnershipRecord(
  path: string,
): Promise<WorkspaceOwnershipRecord | undefined> {
  try {
    return parseOwnershipRecord(JSON.parse(await readBoundedText(path, 65_536)));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (error instanceof LocalGitIssueError) throw error;
    throw new LocalGitIssueError("workspace_state_uncertain");
  }
}

async function readRequiredOwnershipRecord(path: string): Promise<WorkspaceOwnershipRecord> {
  const record = await readOptionalOwnershipRecord(path);
  if (record === undefined) throw new LocalGitIssueError("workspace_state_uncertain");
  return record;
}

function parseOwnershipRecord(input: unknown): WorkspaceOwnershipRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new LocalGitIssueError("workspace_state_uncertain");
  }
  const record = input as Partial<WorkspaceOwnershipRecord>;
  if (
    record.version !== 1 ||
    !["prepared", "active", "cleaned"].includes(record.status ?? "") ||
    typeof record.requestDigest !== "string" ||
    !SHA256_PATTERN.test(record.requestDigest) ||
    record.request === undefined
  ) {
    throw new LocalGitIssueError("workspace_state_uncertain");
  }
  assertPrepareRequest(record.request);
  if (digest("flow.issue.git-workspace-request.v1", record.request) !== record.requestDigest) {
    throw new LocalGitIssueError("workspace_state_uncertain");
  }
  if (record.status !== "prepared") {
    if (record.workspace === undefined) throw new LocalGitIssueError("workspace_state_uncertain");
    assertWorkspaceShape(record.workspace);
  }
  return Object.freeze(record as WorkspaceOwnershipRecord);
}

async function writeExclusiveJson(path: string, value: unknown): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await syncParentDirectory(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw new LocalGitIssueError("workspace_state_uncertain");
  } finally {
    await handle?.close();
  }
}

async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncParentDirectory(path);
  } catch {
    throw new LocalGitIssueError("workspace_state_uncertain");
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseNulList(source: Buffer): string[] {
  if (source.byteLength === 0) return [];
  if (source.at(-1) !== 0) throw new LocalGitIssueError("git_response_invalid");
  const values = source.toString("utf8").split("\0");
  values.pop();
  if (values.some((value) => value.length === 0)) {
    throw new LocalGitIssueError("git_response_invalid");
  }
  return values;
}

function parseSingleLine(source: Buffer): string {
  return parseSingleLineOrEmpty(source, false);
}

function parseSingleLineOrEmpty(source: Buffer, allowEmpty = true): string {
  const text = source.toString("utf8");
  const value = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (
    (!allowEmpty && value.length === 0) ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("\0")
  ) {
    throw new LocalGitIssueError("git_response_invalid");
  }
  return value;
}

function parseCommitList(source: Buffer): string[] {
  const text = source.toString("utf8");
  if (text.includes("\r") || text.includes("\0")) {
    throw new LocalGitIssueError("git_response_invalid");
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  const commits = lines.map(parseCommit);
  if (new Set(commits).size !== commits.length) {
    throw new LocalGitIssueError("git_response_invalid");
  }
  return commits;
}

function parsePatchId(source: Buffer, expectedCommit: string): string {
  const value = parseSingleLine(source);
  const match = /^([a-f0-9]{40}) ([a-f0-9]{40})$/.exec(value);
  if (match?.[1] === undefined || match[2] !== expectedCommit) {
    throw new LocalGitIssueError("git_response_invalid");
  }
  return match[1];
}

function parseCommit(value: string): string {
  if (!SHA1_PATTERN.test(value)) throw new LocalGitIssueError("git_response_invalid");
  return value;
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0${canonicalJson(value)}`)
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LocalGitIssueError("invalid_request");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new LocalGitIssueError("invalid_request");
}

function samePrepareRequest(
  left: PrepareIssueGitWorkspaceRequest,
  right: PrepareIssueGitWorkspaceRequest,
): boolean {
  return (
    digest("flow.issue.git-workspace-request.v1", left) ===
    digest("flow.issue.git-workspace-request.v1", right)
  );
}

function sameWorkspace(left: IssueGitWorkspace, right: IssueGitWorkspace): boolean {
  return (
    left.workspaceIdentityDigest === right.workspaceIdentityDigest &&
    canonicalJson(left) === canonicalJson(right)
  );
}

async function normalizeOwnedWorkspacePath(path: string): Promise<string> {
  const lexicalRoot = resolve(path);
  const lexicalParent = dirname(lexicalRoot);
  const parent = await canonicalDirectory(lexicalParent, "workspace_not_owned");
  const name = basename(lexicalRoot);
  const root = join(parent, name);
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    relative(lexicalParent, lexicalRoot) !== name
  ) {
    throw new LocalGitIssueError("workspace_not_owned");
  }
  return root;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function isAtOrWithinAbsolute(path: string, prefix: string): boolean {
  return isWithin(prefix, path);
}

function isAtOrWithinProjectPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function compareStrings(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
