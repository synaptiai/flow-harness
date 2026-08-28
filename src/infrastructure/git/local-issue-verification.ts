import { createHash } from "node:crypto";
import { join } from "node:path";

import type { CommandSandbox } from "../../application/command-sandbox.js";
import {
  calculateFrozenIssueVerificationCommandDigest,
  type FrozenIssueVerificationCommand,
} from "../../application/frozen-issue-command.js";
import type {
  IssueVerificationPort,
  IssueVerificationRequest,
} from "../../application/github-issue-controller-ports.js";
import type { IssueLifecycleStore } from "../../application/issue-lifecycle-store.js";
import type {
  IssueGitCandidateObservation,
  IssueGitCommitObservation,
  IssueGitRemoteBranchObservation,
  IssueGitVerificationWorktreeObservation,
  IssueGitWorkspace,
  IssueLocalGitPort,
} from "../../application/issue-local-git-port.js";
import {
  type IssueCandidateDeltaResult,
  type IssueDeterministicVerificationResult,
  type IssueNegativeControlResult,
  type IssueVerificationResult,
  validateIssueVerificationResult,
} from "../../application/issue-verification.js";
import {
  IssueWorkflowAdmissionError,
  normalizeIssueWorkflowWritePrefixes,
} from "../../application/issue-workflow-admission.js";
import {
  type GitHubIssuePlan,
  parseGitHubIssuePlanText,
} from "../../domain/issue-lifecycle/plan.js";
import {
  calculateIssuePrivateEvidenceDigest,
  parseIssuePrivateEvidence,
} from "../../domain/issue-lifecycle/private-evidence.js";
import {
  calculateIssueLifecycleDomainDigest,
  calculateIssuePrivateManifestDigest,
  type FrozenIssueRunManifest,
  type IssuePrivateBlobInput,
  type IssuePrivateBlobReference,
  verifyIssuePrivateBlob,
} from "../../domain/issue-lifecycle/private-manifest.js";
import type { CommandEvidence } from "../../domain/run/events.js";
import type { CompiledCommandNode } from "../../domain/workflow/types.js";
import { CommandNodeExecutor } from "../process/command-node-executor.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PLAN_MEDIA_TYPE = "application/vnd.flow.github-issue-plan+yaml";
const COMMAND_EVIDENCE_MEDIA_TYPE = "application/vnd.flow.issue-command-evidence+json";
const PRIVATE_EVIDENCE_MEDIA_TYPE = "application/vnd.flow.issue-private-evidence+json";
const CANDIDATE_EVIDENCE_MEDIA_TYPE = "application/vnd.flow.issue-candidate-delta+json";
const ALLOWED_SANDBOX_PROFILES = new Set(["workspace-write-network-deny-v1", "flow-container-v1"]);

export type LocalIssueVerificationErrorCode =
  | "invalid_request"
  | "frozen_input_mismatch"
  | "workspace_mismatch"
  | "base_drift"
  | "candidate_drift"
  | "negative_control_mismatch"
  | "verification_failed"
  | "command_output_limit"
  | "command_timeout"
  | "command_signaled"
  | "command_execution_failed"
  | "operation_cancelled"
  | "evidence_store_failed";

/** A content-free failure at the trusted local verification boundary. */
export class LocalIssueVerificationError extends Error {
  override readonly name = "LocalIssueVerificationError";

  constructor(readonly code: LocalIssueVerificationErrorCode) {
    super(`Local issue verification failed: ${code}`);
  }
}

export interface IssueVerificationWorkspaceProvider {
  readWorkspace(request: {
    readonly runId: string;
    readonly manifest: FrozenIssueRunManifest;
    readonly signal?: AbortSignal;
  }): Promise<IssueGitWorkspace>;
}

export interface LocalIssueVerificationOptions {
  readonly git: IssueLocalGitPort;
  readonly workspaceProvider: IssueVerificationWorkspaceProvider;
  readonly privateStore: Pick<IssueLifecycleStore, "readBlob" | "putBlob">;
  readonly sandbox: CommandSandbox;
  readonly clock?: () => string;
  readonly maxOutputBytes?: number;
  readonly terminationGraceMs?: number;
  readonly terminationConfirmationMs?: number;
}

interface CandidateProof {
  readonly commit: IssueGitCommitObservation;
  readonly candidate: IssueGitCandidateObservation;
}

interface VerificationWorktreeProof {
  readonly commit: IssueGitCommitObservation;
  readonly worktree: IssueGitVerificationWorktreeObservation;
}

interface CandidateCommandProof {
  readonly authority: CandidateProof | IssueGitRemoteBranchObservation;
  readonly candidate: IssueGitCandidateObservation;
  readonly verification: VerificationWorktreeProof;
}

interface CandidateAuthority {
  readonly kind: "local" | "remote";
  readonly initial: CandidateProof | IssueGitRemoteBranchObservation;
}

interface ExecutionProof {
  readonly evidence: CommandEvidence;
  readonly succeeded: boolean;
  readonly errorCode?: string;
}

/** Executes frozen issue checks without exposing command, Git, network, or evidence authority. */
export class LocalIssueVerification implements IssueVerificationPort {
  readonly #clock: () => string;
  readonly #executor: CommandNodeExecutor;
  readonly #git: IssueLocalGitPort;
  readonly #privateStore: Pick<IssueLifecycleStore, "readBlob" | "putBlob">;
  readonly #workspaceProvider: IssueVerificationWorkspaceProvider;

  constructor(options: LocalIssueVerificationOptions) {
    this.#git = options.git;
    this.#workspaceProvider = options.workspaceProvider;
    this.#privateStore = options.privateStore;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#executor = new CommandNodeExecutor({
      sandbox: options.sandbox,
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.terminationGraceMs === undefined
        ? {}
        : { terminationGraceMs: options.terminationGraceMs }),
      ...(options.terminationConfirmationMs === undefined
        ? {}
        : { terminationConfirmationMs: options.terminationConfirmationMs }),
    });
  }

  async verify(request: IssueVerificationRequest): Promise<IssueVerificationResult> {
    validateRequest(request);
    await checkpoint(request);
    const plan = await this.#readFrozenPlan(request);
    const commands = bindFrozenCommands(request.manifest, plan);
    const workspace = await this.#workspaceProvider
      .readWorkspace({
        runId: request.runId,
        manifest: request.manifest,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      .catch(() => {
        if (isAborted(request.signal)) fail("operation_cancelled");
        return fail("workspace_mismatch");
      });
    validateWorkspace(request.manifest, workspace);
    const authority = await this.#admitCandidateAuthority(request, workspace);
    await this.#resetVerificationWorktree(
      request,
      workspace,
      request.manifest.base.commit,
      "base_drift",
    );

    const baseExecution = await this.#runProvenCommand({
      request,
      workspace,
      command: commands.holdout,
      nodeId: "negative-control-base",
      cwd: workspace.verificationRoot,
      protectedPaths: verificationProtectedPaths(workspace),
      prove: async (cleanliness, signal) =>
        await this.#proveBase(request, workspace, cleanliness, signal),
      driftCode: "base_drift",
    });
    const baseEvidenceDigest = await this.#recordCommandEvidence({
      request,
      evidence: baseExecution.evidence,
      scope: {
        kind: "negative-control",
        baseCommit: request.manifest.base.commit,
        commandDigest: request.manifest.holdout.commandDigest,
        expectedOutcome: "failed",
      },
    });
    if (baseExecution.succeeded || baseExecution.errorCode !== "command_failed") {
      throw executionFailure(baseExecution, "negative_control_mismatch");
    }

    await this.#resetVerificationWorktree(
      request,
      workspace,
      request.candidateHead,
      "candidate_drift",
    );
    const candidateExecution = await this.#runProvenCommand({
      request,
      workspace,
      command: commands.holdout,
      nodeId: "negative-control-candidate",
      cwd: workspace.verificationRoot,
      protectedPaths: verificationProtectedPaths(workspace),
      prove: async (cleanliness, signal) =>
        await this.#proveCandidateCommand(request, workspace, authority, cleanliness, signal),
      driftCode: "candidate_drift",
    });
    const candidateEvidenceDigest = await this.#recordCommandEvidence({
      request,
      evidence: candidateExecution.evidence,
      scope: {
        kind: "negative-control",
        baseCommit: request.manifest.base.commit,
        candidateHead: request.candidateHead,
        commandDigest: request.manifest.holdout.commandDigest,
        expectedOutcome: "passed",
      },
    });
    if (!candidateExecution.succeeded) {
      throw executionFailure(candidateExecution, "negative_control_mismatch");
    }
    const negativeControl: IssueNegativeControlResult = Object.freeze({
      baseCommit: request.manifest.base.commit,
      baseOutcome: "failed",
      candidateHead: request.candidateHead,
      candidateOutcome: "passed",
      evidenceDigest: calculateIssueLifecycleDomainDigest("flow.issue.negative-control-proof.v1", {
        commandDigest: request.manifest.holdout.commandDigest,
        baseEvidenceDigest,
        candidateEvidenceDigest,
      }),
    });

    const deterministic: IssueDeterministicVerificationResult[] = [];
    for (const requirement of request.manifest.verification) {
      const command = commands.verification.get(requirement.id);
      if (command === undefined) fail("frozen_input_mismatch");
      await this.#resetVerificationWorktree(
        request,
        workspace,
        request.candidateHead,
        "candidate_drift",
      );
      const execution = await this.#runProvenCommand({
        request,
        workspace,
        command,
        nodeId: `verification-${requirement.id}`,
        cwd: workspace.verificationRoot,
        protectedPaths: verificationProtectedPaths(workspace),
        prove: async (cleanliness, signal) =>
          await this.#proveCandidateCommand(request, workspace, authority, cleanliness, signal),
        driftCode: "candidate_drift",
      });
      const evidenceDigest = await this.#recordCommandEvidence({
        request,
        evidence: execution.evidence,
        scope: {
          kind: "verification",
          candidateHead: request.candidateHead,
          checkId: requirement.id,
          commandDigest: requirement.commandDigest,
        },
      });
      if (!execution.succeeded) throw executionFailure(execution, "verification_failed");
      deterministic.push(
        Object.freeze({
          id: requirement.id,
          commandDigest: requirement.commandDigest,
          evidenceDigest,
          headCommit: request.candidateHead,
        }),
      );
    }

    const finalProof = await this.#proveCandidateCommand(
      request,
      workspace,
      authority,
      "command-postcondition",
      request.signal,
    );
    if (!sameProof(authority.initial, finalProof.authority)) fail("candidate_drift");
    const candidateDelta = await this.#recordCandidateDelta(request, finalProof.candidate);
    const resultWithoutDigest = {
      negativeControl,
      deterministic: Object.freeze(deterministic),
      candidateDelta,
    };
    const result = {
      ...resultWithoutDigest,
      evidenceDigest: calculateIssueLifecycleDomainDigest("flow.issue.verification-proof.v1", {
        frozenContractDigest: request.frozenContractDigest,
        ...resultWithoutDigest,
      }),
    };
    try {
      return validateIssueVerificationResult(request.manifest, request.candidateHead, result);
    } catch {
      return fail("verification_failed");
    }
  }

  async #readFrozenPlan(request: IssueVerificationRequest): Promise<GitHubIssuePlan> {
    let blob: IssuePrivateBlobInput;
    try {
      blob = await this.#privateStore.readBlob(request.runId, request.manifest.artifacts.plan);
      verifyIssuePrivateBlob(blob, request.manifest.artifacts.plan);
      if (blob.mediaType !== PLAN_MEDIA_TYPE) fail("frozen_input_mismatch");
      const source = new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes);
      return parseGitHubIssuePlanText(source, "frozen issue plan");
    } catch (error) {
      if (error instanceof LocalIssueVerificationError) throw error;
      return fail("frozen_input_mismatch");
    }
  }

  async #admitCandidateAuthority(
    request: IssueVerificationRequest,
    workspace: IssueGitWorkspace,
  ): Promise<CandidateAuthority> {
    try {
      const [base, localCandidate] = await Promise.all([
        this.#git.inspectCommit({
          workspace,
          commit: request.manifest.base.commit,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
        this.#git.inspectCandidate({
          workspace,
          baseCommit: request.manifest.base.commit,
          allowedWritePrefixes: request.manifest.allowedWritePrefixes,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
      ]);
      if (localCandidate.head === request.candidateHead) {
        return Object.freeze({
          kind: "local",
          initial: await this.#proveCandidate(request, workspace, request.signal),
        });
      }
      if (
        localCandidate.head !== request.manifest.base.commit ||
        localCandidate.tree !== base.tree ||
        localCandidate.changedPaths.length !== 0 ||
        localCandidate.logicalBytes !== 0
      ) {
        fail("candidate_drift");
      }
      const remote = await this.#git.fetchRemoteBranch({
        workspace,
        branch: request.manifest.branch.name,
        expectedHead: request.candidateHead,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const reachable = await this.#git.isAncestor({
        workspace,
        ancestor: request.manifest.base.commit,
        descendant: request.candidateHead,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (
        remote.branch !== request.manifest.branch.name ||
        remote.head !== request.candidateHead ||
        !reachable
      ) {
        fail("candidate_drift");
      }
      return Object.freeze({ kind: "remote", initial: remote });
    } catch (error) {
      if (error instanceof LocalIssueVerificationError) throw error;
      return fail("candidate_drift");
    }
  }

  async #resetVerificationWorktree(
    request: IssueVerificationRequest,
    workspace: IssueGitWorkspace,
    commit: string,
    driftCode: "base_drift" | "candidate_drift",
  ): Promise<VerificationWorktreeProof> {
    try {
      const worktree = await this.#git.resetVerificationWorktree({
        workspace,
        commit,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return await this.#validateVerificationWorktree(workspace, commit, worktree, request.signal);
    } catch (error) {
      if (error instanceof LocalIssueVerificationError) throw error;
      return fail(driftCode);
    }
  }

  async #proveBase(
    request: IssueVerificationRequest,
    workspace: IssueGitWorkspace,
    cleanliness: "pristine" | "command-postcondition",
    signal?: AbortSignal,
  ): Promise<VerificationWorktreeProof> {
    try {
      const worktree = await this.#git.inspectVerificationWorktree({
        workspace,
        commit: request.manifest.base.commit,
        cleanliness,
        ...(signal === undefined ? {} : { signal }),
      });
      return await this.#validateVerificationWorktree(
        workspace,
        request.manifest.base.commit,
        worktree,
        signal,
      );
    } catch (error) {
      if (error instanceof LocalIssueVerificationError) throw error;
      return fail("base_drift");
    }
  }

  async #proveCandidateCommand(
    request: IssueVerificationRequest,
    workspace: IssueGitWorkspace,
    authority: CandidateAuthority,
    cleanliness: "pristine" | "command-postcondition",
    signal?: AbortSignal,
  ): Promise<CandidateCommandProof> {
    try {
      const [authorityProof, candidate, worktree] = await Promise.all([
        this.#proveCandidateAuthority(request, workspace, authority.kind, signal),
        this.#git.inspectVerificationCandidate({
          workspace,
          baseCommit: request.manifest.base.commit,
          candidateHead: request.candidateHead,
          allowedWritePrefixes: request.manifest.allowedWritePrefixes,
          ...(signal === undefined ? {} : { signal }),
        }),
        this.#git.inspectVerificationWorktree({
          workspace,
          commit: request.candidateHead,
          cleanliness,
          ...(signal === undefined ? {} : { signal }),
        }),
      ]);
      const verification = await this.#validateVerificationWorktree(
        workspace,
        request.candidateHead,
        worktree,
        signal,
      );
      if (
        verification.commit.tree !== candidate.tree ||
        candidate.head !== request.candidateHead ||
        candidate.changedPaths.length === 0 ||
        !sameProof(authority.initial, authorityProof)
      ) {
        fail("candidate_drift");
      }
      return Object.freeze({ authority: authorityProof, candidate, verification });
    } catch (error) {
      if (error instanceof LocalIssueVerificationError) throw error;
      return fail("candidate_drift");
    }
  }

  async #proveCandidateAuthority(
    request: IssueVerificationRequest,
    workspace: IssueGitWorkspace,
    kind: CandidateAuthority["kind"],
    signal?: AbortSignal,
  ): Promise<CandidateProof | IssueGitRemoteBranchObservation> {
    if (kind === "local") return await this.#proveCandidate(request, workspace, signal);
    try {
      const remote = await this.#git.inspectRemoteBranch({
        workspace,
        branch: request.manifest.branch.name,
        ...(signal === undefined ? {} : { signal }),
      });
      if (remote.head !== request.candidateHead) fail("candidate_drift");
      return remote;
    } catch (error) {
      if (error instanceof LocalIssueVerificationError) throw error;
      return fail("candidate_drift");
    }
  }

  async #validateVerificationWorktree(
    workspace: IssueGitWorkspace,
    expectedCommit: string,
    worktree: IssueGitVerificationWorktreeObservation,
    signal?: AbortSignal,
  ): Promise<VerificationWorktreeProof> {
    const commit = await this.#git.inspectCommit({
      workspace,
      commit: expectedCommit,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      worktree.head !== expectedCommit ||
      worktree.tree !== commit.tree ||
      worktree.status !== "clean" ||
      worktree.workspaceIdentityDigest !== workspace.workspaceIdentityDigest
    ) {
      fail(expectedCommit === workspace.baseCommit ? "base_drift" : "candidate_drift");
    }
    return Object.freeze({ commit, worktree });
  }

  async #proveCandidate(
    request: IssueVerificationRequest,
    workspace: IssueGitWorkspace,
    signal?: AbortSignal,
  ): Promise<CandidateProof> {
    try {
      const [commit, candidate] = await Promise.all([
        this.#git.inspectCommit({
          workspace,
          commit: request.candidateHead,
          ...(signal === undefined ? {} : { signal }),
        }),
        this.#git.inspectCandidate({
          workspace,
          baseCommit: request.manifest.base.commit,
          allowedWritePrefixes: request.manifest.allowedWritePrefixes,
          ...(signal === undefined ? {} : { signal }),
        }),
      ]);
      if (
        commit.commit !== request.candidateHead ||
        candidate.head !== request.candidateHead ||
        candidate.baseCommit !== request.manifest.base.commit ||
        candidate.tree !== commit.tree ||
        candidate.workspaceIdentityDigest !== workspace.workspaceIdentityDigest ||
        candidate.changedPaths.length === 0
      ) {
        fail("candidate_drift");
      }
      return Object.freeze({ commit, candidate });
    } catch (error) {
      if (error instanceof LocalIssueVerificationError) throw error;
      return fail("candidate_drift");
    }
  }

  async #runProvenCommand<Proof>(input: {
    readonly request: IssueVerificationRequest;
    readonly workspace: IssueGitWorkspace;
    readonly command: FrozenIssueVerificationCommand;
    readonly nodeId: string;
    readonly cwd: string;
    readonly protectedPaths: readonly string[];
    readonly prove: (
      cleanliness: "pristine" | "command-postcondition",
      signal?: AbortSignal,
    ) => Promise<Proof>;
    readonly driftCode: "base_drift" | "candidate_drift";
  }): Promise<ExecutionProof> {
    await checkpoint(input.request);
    const before = await input.prove("pristine", input.request.signal);
    let outcome: Awaited<ReturnType<CommandNodeExecutor["execute"]>> | undefined;
    let executionThrew = false;
    try {
      const node: CompiledCommandNode = {
        id: input.nodeId,
        type: "command",
        dependsOn: Object.freeze([]),
        command: {
          executable: input.command.executable,
          args: Object.freeze([...input.command.args]),
          timeoutMs: input.command.timeoutMs,
        },
      };
      outcome = await this.#executor.execute(node, {
        runId: input.request.runId,
        workflowId: "issue-verification",
        nodeId: input.nodeId,
        attempt: 1,
        cwd: input.cwd,
        projectRoot: input.cwd,
        protectedPaths: input.protectedPaths,
        ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
      });
    } catch {
      executionThrew = true;
    } finally {
      const after = await input.prove("command-postcondition");
      if (!sameProof(before, after)) fail(input.driftCode);
    }
    if (executionThrew) fail("command_execution_failed");
    if (outcome === undefined) fail("command_execution_failed");
    if (input.request.signal?.aborted === true) fail("operation_cancelled");
    await checkpoint(input.request);
    const evidence = outcome.evidence;
    if (evidence?.kind !== "command") fail("command_execution_failed");
    validateCommandEvidence(input.command, evidence);
    return Object.freeze({
      evidence,
      succeeded: outcome.status === "succeeded",
      ...(outcome.status === "failed" ? { errorCode: outcome.error.code } : {}),
    });
  }

  async #recordCommandEvidence(input: {
    readonly request: IssueVerificationRequest;
    readonly evidence: CommandEvidence;
    readonly scope:
      | {
          readonly kind: "negative-control";
          readonly baseCommit: string;
          readonly candidateHead?: string;
          readonly commandDigest: string;
          readonly expectedOutcome: "failed" | "passed";
        }
      | {
          readonly kind: "verification";
          readonly candidateHead: string;
          readonly checkId: string;
          readonly commandDigest: string;
        };
  }): Promise<string> {
    try {
      const commandBlob = await this.#putJson(
        input.request.runId,
        COMMAND_EVIDENCE_MEDIA_TYPE,
        input.evidence,
      );
      const privateEvidence = parseIssuePrivateEvidence({
        version: 1,
        runId: input.request.runId,
        recordedAt: this.#clock(),
        kind: input.scope.kind,
        scope: input.scope,
        artifacts: [{ role: "command-result", blob: commandBlob }],
      });
      await this.#putJson(input.request.runId, PRIVATE_EVIDENCE_MEDIA_TYPE, privateEvidence);
      return calculateIssuePrivateEvidenceDigest(privateEvidence);
    } catch {
      return fail("evidence_store_failed");
    }
  }

  async #recordCandidateDelta(
    request: IssueVerificationRequest,
    candidate: IssueGitCandidateObservation,
  ): Promise<IssueCandidateDeltaResult> {
    try {
      const evidenceBlob = await this.#putJson(request.runId, CANDIDATE_EVIDENCE_MEDIA_TYPE, {
        version: 1,
        baseCommit: request.manifest.base.commit,
        candidateHead: request.candidateHead,
        candidateTree: candidate.tree,
        changedPaths: candidate.changedPaths,
        logicalBytes: candidate.logicalBytes,
      });
      return Object.freeze({
        baseCommit: request.manifest.base.commit,
        candidateHead: request.candidateHead,
        pathCount: candidate.changedPaths.length,
        logicalBytes: candidate.logicalBytes,
        relevant: candidate.changedPaths.length > 0,
        evidenceDigest: calculateIssueLifecycleDomainDigest("flow.issue.candidate-delta-proof.v1", {
          blob: evidenceBlob,
          candidateTree: candidate.tree,
          pathCount: candidate.changedPaths.length,
          logicalBytes: candidate.logicalBytes,
        }),
      });
    } catch {
      return fail("evidence_store_failed");
    }
  }

  async #putJson(
    runId: string,
    mediaType: string,
    value: unknown,
  ): Promise<IssuePrivateBlobReference> {
    return await this.#privateStore.putBlob(runId, {
      mediaType,
      bytes: Buffer.from(JSON.stringify(value), "utf8"),
    });
  }
}

function bindFrozenCommands(
  manifest: FrozenIssueRunManifest,
  plan: GitHubIssuePlan,
): {
  readonly holdout: FrozenIssueVerificationCommand;
  readonly verification: ReadonlyMap<string, FrozenIssueVerificationCommand>;
} {
  let plannedWritePrefixes: readonly string[];
  try {
    plannedWritePrefixes = normalizeIssueWorkflowWritePrefixes(plan.candidate.allowedPathPrefixes);
  } catch (error) {
    if (error instanceof IssueWorkflowAdmissionError) fail("frozen_input_mismatch");
    throw error;
  }
  if (
    plan.repository.expected !== manifest.repository.identity ||
    plan.repository.baseBranch !== manifest.base.branch ||
    plan.branch.prefix !== manifest.branch.prefix ||
    !sameStrings(plannedWritePrefixes, manifest.allowedWritePrefixes) ||
    plan.holdout.command.timeoutMs !== manifest.holdout.timeoutMs ||
    calculateFrozenIssueVerificationCommandDigest(plan.holdout.command) !==
      manifest.holdout.commandDigest ||
    plan.verification.length !== manifest.verification.length
  ) {
    fail("frozen_input_mismatch");
  }
  const verification = new Map<string, FrozenIssueVerificationCommand>();
  for (const requirement of manifest.verification) {
    const planned = plan.verification.find(({ id }) => id === requirement.id);
    if (
      planned === undefined ||
      planned.command.timeoutMs !== requirement.timeoutMs ||
      calculateFrozenIssueVerificationCommandDigest(planned.command) !== requirement.commandDigest
    ) {
      fail("frozen_input_mismatch");
    }
    verification.set(requirement.id, planned.command);
  }
  return Object.freeze({ holdout: plan.holdout.command, verification });
}

function validateWorkspace(manifest: FrozenIssueRunManifest, workspace: IssueGitWorkspace): void {
  if (
    workspace.repositoryIdentity !== manifest.repository.identity ||
    workspace.originCanonicalUrl !== manifest.repository.canonicalUrl ||
    workspace.baseBranch !== manifest.base.branch ||
    workspace.baseCommit !== manifest.base.commit ||
    workspace.branch !== manifest.branch.name ||
    workspace.verificationRoot === workspace.root ||
    workspace.verificationRoot === workspace.sourceRoot ||
    !SHA256_PATTERN.test(workspace.workspaceIdentityDigest)
  ) {
    fail("workspace_mismatch");
  }
}

function validateRequest(request: IssueVerificationRequest): void {
  if (
    request.runId !== request.manifest.runId ||
    !SHA256_PATTERN.test(request.frozenContractDigest) ||
    !GIT_COMMIT_PATTERN.test(request.candidateHead) ||
    request.candidateHead === request.manifest.base.commit
  ) {
    fail("invalid_request");
  }
  if (request.frozenContractDigest !== calculateIssuePrivateManifestDigest(request.manifest)) {
    fail("frozen_input_mismatch");
  }
}

async function checkpoint(request: IssueVerificationRequest): Promise<void> {
  if (isAborted(request.signal)) fail("operation_cancelled");
  try {
    await request.pollCancellation();
  } catch {
    fail("operation_cancelled");
  }
  if (isAborted(request.signal)) fail("operation_cancelled");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function validateCommandEvidence(
  command: FrozenIssueVerificationCommand,
  evidence: CommandEvidence,
): void {
  if (
    evidence.executable !== command.executable ||
    !sameStrings(evidence.args, command.args) ||
    evidence.sandbox === undefined ||
    !ALLOWED_SANDBOX_PROFILES.has(evidence.sandbox.profile) ||
    !SHA256_PATTERN.test(evidence.sandbox.policyDigest) ||
    evidence.terminationStatus === "unconfirmed"
  ) {
    fail("command_execution_failed");
  }
  if (evidence.stdoutTruncated || evidence.stderrTruncated) fail("command_output_limit");
  if (
    evidence.stdoutHash !== hash(evidence.stdout) ||
    evidence.stderrHash !== hash(evidence.stderr)
  ) {
    fail("command_execution_failed");
  }
  if (evidence.timedOut) fail("command_timeout");
  if (evidence.aborted === true) fail("operation_cancelled");
  if (evidence.signal !== null) fail("command_signaled");
}

function executionFailure(
  execution: ExecutionProof,
  fallback: "negative_control_mismatch" | "verification_failed",
): LocalIssueVerificationError {
  switch (execution.errorCode) {
    case "command_timeout":
      return new LocalIssueVerificationError("command_timeout");
    case "command_aborted":
      return new LocalIssueVerificationError("operation_cancelled");
    case "command_signaled":
      return new LocalIssueVerificationError("command_signaled");
    default:
      return new LocalIssueVerificationError(fallback);
  }
}

function verificationProtectedPaths(workspace: IssueGitWorkspace): readonly string[] {
  return Object.freeze(
    uniqueStrings([
      workspace.commonGitDirectory,
      workspace.gitDirectory,
      workspace.verificationGitDirectory,
      join(workspace.verificationRoot, ".git"),
      workspace.sourceRoot,
      workspace.root,
    ]),
  );
}

function sameProof(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueStrings(input: readonly string[]): string[] {
  return [...new Set(input)];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code: LocalIssueVerificationErrorCode): never {
  throw new LocalIssueVerificationError(code);
}
