import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import type {
  IssueControllerOperation,
  IssueExternalEffectObservation,
  IssueExternalEffectPreparation,
  IssueExternalEffectsPort,
  IssueGitHubObservationRequest,
  IssueGitHubPort,
  IssueMergeProofRequest,
} from "../../application/github-issue-controller-ports.js";
import type {
  ExactGitHubPullRequestIdentity,
  FrozenGitHubIssueIdentity,
  GitHubIssueAdmissionPort,
  GitHubIssueLifecycleEvidence,
  GitHubIssueLifecyclePort,
  GitHubOpenIssueObservation,
  GitHubRemoteMergeOutcome,
} from "../../application/github-issue-ports.js";
import type { IssueLifecycleStore } from "../../application/issue-lifecycle-store.js";
import type {
  IssueGitCommitObservation,
  IssueGitWorkspace,
  IssueLocalGitPort,
  PrepareIssueGitWorkspaceRequest,
} from "../../application/issue-local-git-port.js";
import type {
  IssueExternalEffectResult,
  IssueLifecycleEvent,
  IssueLifecycleState,
  PendingIssueExternalEffect,
} from "../../domain/issue-lifecycle/events.js";
import {
  calculateIssueExternalEffectOperationDigest,
  type IssueExternalEffectDescriptor,
  parseIssueExternalEffectDescriptor,
} from "../../domain/issue-lifecycle/external-effects.js";
import {
  decodeFrozenGitHubIssueSnapshot,
  encodeFrozenGitHubIssueSnapshot as encodeCanonicalFrozenGitHubIssueSnapshot,
  FROZEN_GITHUB_ISSUE_SNAPSHOT_MEDIA_TYPE,
  type FrozenGitHubIssueSnapshot,
  type FrozenGitHubIssueSnapshotContent,
} from "../../domain/issue-lifecycle/frozen-github-issue-snapshot.js";
import {
  calculateIssueMergeProofDigest,
  type GitHubLifecycleObservation,
  type IssueMergeProof,
  verifyIssueMergeProof,
} from "../../domain/issue-lifecycle/github-observation.js";
import { canonicalGitHubRepositoryIdentity } from "../../domain/issue-lifecycle/identity.js";
import {
  calculateIssueCandidateTreeDigest as calculateCanonicalCandidateTreeDigest,
  calculateIssueCommitMessageDigest,
  renderIssueCommitMessage,
} from "../../domain/issue-lifecycle/issue-delivery-contract.js";
import {
  calculateIssueLifecycleDomainDigest,
  calculateIssuePrivateManifestDigest,
  type FrozenIssueRunManifest,
} from "../../domain/issue-lifecycle/private-manifest.js";

export { FROZEN_GITHUB_ISSUE_SNAPSHOT_MEDIA_TYPE };
export const ISSUE_EXTERNAL_EFFECT_EVIDENCE_MEDIA_TYPE =
  "application/vnd.synapti.flow.issue-effect-evidence.v1+json";
export const ISSUE_MERGE_PROOF_EVIDENCE_MEDIA_TYPE =
  "application/vnd.synapti.flow.issue-merge-proof-evidence.v1+json";

const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
type HostStore = Pick<IssueLifecycleStore, "putBlob" | "read" | "readBlob" | "readManifest">;
type GitHubHostPort = GitHubIssueAdmissionPort & GitHubIssueLifecyclePort;

export interface IssueLifecycleHostOptions {
  readonly store: HostStore;
  readonly localGit: IssueLocalGitPort;
  readonly github: GitHubHostPort;
  readonly sourceRoot: string;
  readonly workspaceParent: string;
}

export type IssueLifecycleHostErrorCode =
  | "invalid_configuration"
  | "frozen_issue_invalid"
  | "descriptor_mismatch"
  | "effect_state_uncertain"
  | "merge_proof_invalid";

export class IssueLifecycleHostError extends Error {
  override readonly name = "IssueLifecycleHostError";

  constructor(
    readonly code: IssueLifecycleHostErrorCode,
    options?: ErrorOptions,
  ) {
    super(`issue lifecycle host failed: ${code}`, options);
  }
}

/** Composes exact local Git and GitHub effects for the foreground issue controller. */
export class IssueLifecycleHost implements IssueExternalEffectsPort, IssueGitHubPort {
  readonly #github: GitHubHostPort;
  readonly #localGit: IssueLocalGitPort;
  readonly #sourceRoot: string;
  readonly #store: HostStore;
  readonly #workspaceParent: string;

  constructor(options: IssueLifecycleHostOptions) {
    if (
      !isAbsolute(options.sourceRoot) ||
      !isAbsolute(options.workspaceParent) ||
      options.sourceRoot.includes("\0") ||
      options.workspaceParent.includes("\0")
    ) {
      throw new IssueLifecycleHostError("invalid_configuration");
    }
    this.#store = options.store;
    this.#localGit = options.localGit;
    this.#github = options.github;
    this.#sourceRoot = resolve(options.sourceRoot);
    this.#workspaceParent = resolve(options.workspaceParent);
  }

  async read(input: {
    readonly runId: string;
    readonly workspaceIdentityDigest?: string;
    readonly signal?: AbortSignal;
  }): Promise<IssueGitWorkspace> {
    const manifest = await this.#store.readManifest(input.runId);
    if (manifest.runId !== input.runId) {
      throw new IssueLifecycleHostError("descriptor_mismatch");
    }
    const workspace = await this.#resolveRecordedWorkspace(manifest, input.signal);
    if (
      input.workspaceIdentityDigest !== undefined &&
      input.workspaceIdentityDigest !== workspace.workspaceIdentityDigest
    ) {
      throw new IssueLifecycleHostError("descriptor_mismatch");
    }
    return workspace;
  }

  async readWorkspace(input: {
    readonly runId: string;
    readonly manifest: FrozenIssueRunManifest;
    readonly signal?: AbortSignal;
  }): Promise<IssueGitWorkspace> {
    const manifest = await this.#exactManifest(input.manifest, input.runId);
    return await this.#resolveRecordedWorkspace(manifest, input.signal);
  }

  async describe(
    request: IssueExternalEffectPreparation,
    manifest: FrozenIssueRunManifest,
  ): Promise<IssueExternalEffectDescriptor> {
    return await this.#describe(request, manifest);
  }

  async recover(
    manifest: FrozenIssueRunManifest,
    state: IssueLifecycleState,
    pending: PendingIssueExternalEffect,
  ): Promise<IssueExternalEffectDescriptor> {
    if (
      state.runId !== manifest.runId ||
      state.pendingEffect?.operationDigest !== pending.operationDigest ||
      state.pendingEffect.effectKind !== pending.effectKind
    ) {
      throw new IssueLifecycleHostError("descriptor_mismatch");
    }
    const commandId = manifest.initialCommandId;
    let preparation: IssueExternalEffectPreparation;
    switch (pending.effectKind) {
      case "workspace":
        preparation = { kind: "workspace", commandId };
        break;
      case "commit": {
        const workspace = await this.#requireWorkspace(manifest);
        const candidate = await this.#localGit.inspectCandidate({
          workspace,
          baseCommit: state.candidateHead ?? manifest.base.commit,
          allowedWritePrefixes: manifest.allowedWritePrefixes,
        });
        preparation = {
          kind: "commit",
          commandId,
          workspaceIdentityDigest: workspace.workspaceIdentityDigest,
          parentCommit: state.candidateHead ?? manifest.base.commit,
          candidateTreeDigest: calculateIssueCandidateTreeDigest(candidate.tree),
          messageDigest: calculateIssueHostCommitMessageDigest(manifest),
        };
        break;
      }
      case "push":
        preparation = {
          kind: "push",
          commandId,
          candidateHead: requireCommit(state.candidateHead),
          expectedRemoteHead: state.publication?.candidateHead ?? null,
        };
        break;
      case "pull_request":
        preparation = {
          kind: "pull_request",
          commandId,
          candidateHead: requireCommit(state.candidateHead),
        };
        break;
      case "pull_request_ready": {
        const pullRequest = pullRequestIdentityFromState(state);
        preparation = {
          kind: "pull_request_ready",
          commandId,
          candidateHead: requireCommit(state.candidateHead),
          pullRequestNumber: pullRequest.number,
          pullRequestNodeId: pullRequest.nodeId,
        };
        break;
      }
      case "merge": {
        const gate = state.mergeGate;
        if (gate === undefined) throw new IssueLifecycleHostError("descriptor_mismatch");
        preparation = {
          kind: "merge",
          commandId,
          candidateHead: gate.candidateHead,
          pullRequestNumber: gate.pullRequestNumber,
          pullRequestNodeId: gate.pullRequestNodeId,
          gateDigest: gate.gateDigest,
        };
        break;
      }
    }
    const descriptor = await this.#describe(preparation, manifest);
    if (
      descriptor.kind !== pending.effectKind ||
      calculateIssueExternalEffectOperationDigest(descriptor) !== pending.operationDigest
    ) {
      throw new IssueLifecycleHostError("descriptor_mismatch");
    }
    return descriptor;
  }

  async reconcile(
    descriptorInput: IssueExternalEffectDescriptor,
    operation: IssueControllerOperation,
  ): Promise<IssueExternalEffectObservation> {
    await operation.pollCancellation();
    const descriptor = parseIssueExternalEffectDescriptor(descriptorInput);
    try {
      const manifest = await this.#manifestForDescriptor(descriptor);
      switch (descriptor.kind) {
        case "workspace":
          return await this.#reconcileWorkspace(descriptor, manifest);
        case "commit":
          return await this.#reconcileCommit(descriptor, manifest, operation.signal);
        case "push":
          return await this.#reconcilePush(descriptor, manifest, operation.signal);
        case "pull_request":
          return await this.#reconcileDraft(descriptor, manifest, operation.signal);
        case "pull_request_ready":
          return await this.#reconcileReady(descriptor, manifest, operation.signal);
        case "merge":
          return await this.#reconcileMerge(descriptor, manifest, operation.signal);
      }
    } catch (error) {
      return await this.#uncertain(descriptor, stableErrorCode(error));
    }
  }

  async execute(
    descriptorInput: IssueExternalEffectDescriptor,
    operation: IssueControllerOperation,
  ): Promise<void> {
    const descriptor = parseIssueExternalEffectDescriptor(descriptorInput);
    const manifest = await this.#manifestForDescriptor(descriptor);
    await operation.pollCancellation();
    switch (descriptor.kind) {
      case "workspace": {
        const workspace = await this.#localGit.prepareWorkspace(
          this.#workspaceRequest(manifest),
          operation.signal,
        );
        await this.#recordApplied(descriptor, {
          kind: "workspace",
          workspaceIdentityDigest: workspace.workspaceIdentityDigest,
        });
        return;
      }
      case "commit": {
        const workspace = await this.#requireWorkspace(manifest);
        const candidate = await this.#localGit.inspectCandidate({
          workspace,
          baseCommit: descriptor.parentCommit,
          allowedWritePrefixes: manifest.allowedWritePrefixes,
          ...(operation.signal === undefined ? {} : { signal: operation.signal }),
        });
        this.#requireCommitIntent(descriptor, candidate.tree, workspace);
        const committed = await this.#localGit.commitCandidate({
          workspace,
          parentCommit: descriptor.parentCommit,
          candidateTree: candidate.tree,
          allowedWritePrefixes: manifest.allowedWritePrefixes,
          message: renderIssueHostCommitMessage(manifest),
          identity: {
            name: "Flow Harness",
            email: "flow-harness@users.noreply.github.com",
            timestamp: manifest.createdAt,
          },
          ...(operation.signal === undefined ? {} : { signal: operation.signal }),
        });
        await this.#recordApplied(descriptor, {
          kind: "commit",
          candidateHead: committed.candidateHead,
        });
        return;
      }
      case "push": {
        const workspace = await this.#requireWorkspace(manifest);
        const pushed = await this.#localGit.pushCandidate({
          workspace,
          branch: descriptor.branch,
          candidateHead: descriptor.candidateHead,
          expectedRemoteHead: descriptor.expectedRemoteHead,
          ...(operation.signal === undefined ? {} : { signal: operation.signal }),
        });
        await this.#recordApplied(descriptor, { kind: "push", ...pushed });
        return;
      }
      case "pull_request": {
        const content = renderIssueHostPullRequest(manifest);
        const result = await this.#github.ensureDraftPullRequest(
          {
            expected: await this.#expectedGitHub(manifest, descriptor.headCommit),
            effect: descriptor,
            ...content,
          },
          operation.signal,
        );
        await this.#recordApplied(descriptor, result.result, result.evidence);
        return;
      }
      case "pull_request_ready": {
        const result = await this.#github.ensurePullRequestReady(
          {
            expected: await this.#expectedGitHubWithPullRequest(manifest, descriptor),
            effect: descriptor,
          },
          operation.signal,
        );
        await this.#recordApplied(descriptor, result.result, result.evidence);
        return;
      }
      case "merge": {
        const result = await this.#github.mergeExactPullRequest(
          {
            expected: await this.#expectedGitHubWithPullRequest(manifest, descriptor),
            effect: descriptor,
          },
          operation.signal,
        );
        this.#requireRemoteOutcome(result.outcome, manifest, descriptor);
        const proof = await this.#proveObservedMerge(
          manifest,
          descriptor,
          result.outcome,
          result.evidence,
          operation.signal,
        );
        await this.#recordApplied(
          descriptor,
          mergeEffectResult(descriptor, result.outcome, calculateIssueMergeProofDigest(proof)),
          result.evidence,
        );
      }
    }
  }

  async observe(request: IssueGitHubObservationRequest): Promise<GitHubLifecycleObservation> {
    await request.pollCancellation();
    const manifest = await this.#exactManifest(request.manifest, request.runId);
    const pullRequest = await this.#pullRequestIdentity(
      manifest,
      request.pullRequestNumber,
      request.candidateHead,
    );
    const observed = await this.#github.observeLifecycle(
      await this.#expectedGitHubWithExactPullRequest(manifest, request.candidateHead, pullRequest),
      request.signal,
    );
    await this.#storeAdapterEvidence(manifest.runId, observed.evidence);
    return observed.observation;
  }

  async proveMerge(request: IssueMergeProofRequest): Promise<IssueMergeProof> {
    await request.pollCancellation();
    const manifest = await this.#exactManifest(request.manifest, request.runId);
    const descriptorInput = parseIssueExternalEffectDescriptor({
      version: 1,
      kind: "merge",
      runId: manifest.runId,
      commandId: manifest.initialCommandId,
      repositoryIdentity: manifest.repository.identity,
      frozenContractDigest: calculateIssuePrivateManifestDigest(manifest),
      pullRequestNumber: request.pullRequestNumber,
      pullRequestNodeId: request.pullRequestNodeId,
      candidateHead: request.candidateHead,
      baseBranch: manifest.base.branch,
      baseCommit: manifest.base.commit,
      gateDigest: request.gateDigest,
      method: manifest.merge.method,
      deleteBranch: manifest.merge.deleteBranch,
    });
    if (descriptorInput.kind !== "merge") {
      throw new IssueLifecycleHostError("merge_proof_invalid");
    }
    const descriptor = descriptorInput;
    const expected = await this.#expectedGitHubWithPullRequest(manifest, descriptor);
    const remote = await this.#github.observeMergeOutcome(
      { expected, effect: descriptor },
      request.signal,
    );
    if (remote === null) throw new IssueLifecycleHostError("merge_proof_invalid");
    this.#requireRemoteOutcome(remote.outcome, manifest, descriptor);
    return await this.#proveObservedMerge(
      manifest,
      descriptor,
      remote.outcome,
      remote.evidence,
      request.signal,
    );
  }

  async #proveObservedMerge(
    manifest: FrozenIssueRunManifest,
    descriptor: Extract<IssueExternalEffectDescriptor, { readonly kind: "merge" }>,
    outcome: GitHubRemoteMergeOutcome,
    evidence: GitHubIssueLifecycleEvidence,
    signal?: AbortSignal,
  ): Promise<IssueMergeProof> {
    this.#requireRemoteOutcome(outcome, manifest, descriptor);
    const remoteEvidenceDigest = await this.#storeAdapterEvidence(manifest.runId, evidence);
    const workspace = await this.#readOwnedWorkspace(manifest, signal);
    await this.#localGit.fetchRemoteBranch({
      workspace,
      branch: manifest.base.branch,
      expectedHead: outcome.observedBaseCommit,
      ...(signal === undefined ? {} : { signal }),
    });
    await this.#localGit.fetchPullRequestHead({
      workspace,
      pullRequestNumber: descriptor.pullRequestNumber,
      expectedHead: descriptor.candidateHead,
      ...(signal === undefined ? {} : { signal }),
    });
    const [candidate, merged, reachable] = await Promise.all([
      this.#localGit.inspectCommit({
        workspace,
        commit: descriptor.candidateHead,
        ...(signal === undefined ? {} : { signal }),
      }),
      this.#localGit.inspectCommit({
        workspace,
        commit: outcome.mergeCommit,
        ...(signal === undefined ? {} : { signal }),
      }),
      this.#localGit.isAncestor({
        workspace,
        ancestor: outcome.mergeCommit,
        descendant: outcome.observedBaseCommit,
        ...(signal === undefined ? {} : { signal }),
      }),
    ]);
    if (!reachable) throw new IssueLifecycleHostError("merge_proof_invalid");
    const proof = await this.#methodProof(manifest, workspace, candidate, merged, signal);
    const evidenceDigest = await this.#storeMergeProofEvidence(
      manifest,
      outcome,
      remoteEvidenceDigest,
      { candidate, merged, reachable, proof },
    );
    try {
      return verifyIssueMergeProof({
        version: 1,
        repositoryIdentity: manifest.repository.identity,
        pullRequestNumber: descriptor.pullRequestNumber,
        pullRequestNodeId: descriptor.pullRequestNodeId,
        gateDigest: descriptor.gateDigest,
        frozenBaseCommit: manifest.base.commit,
        candidateHead: descriptor.candidateHead,
        mergeCommit: outcome.mergeCommit,
        observedBaseCommit: outcome.observedBaseCommit,
        mergeCommitReachableFromObservedBase: reachable,
        evidenceDigest,
        method: manifest.merge.method,
        proof,
        deleteBranchRequested: manifest.merge.deleteBranch,
        branchDeleted: outcome.branchDeleted,
      });
    } catch {
      throw new IssueLifecycleHostError("merge_proof_invalid");
    }
  }

  async #describe(
    request: IssueExternalEffectPreparation,
    manifestInput: FrozenIssueRunManifest,
  ): Promise<IssueExternalEffectDescriptor> {
    const manifest = await this.#exactManifest(manifestInput, manifestInput.runId);
    const common = {
      version: 1 as const,
      runId: manifest.runId,
      commandId: request.commandId,
      repositoryIdentity: manifest.repository.identity,
      frozenContractDigest: calculateIssuePrivateManifestDigest(manifest),
    };
    switch (request.kind) {
      case "workspace": {
        const { workspaceRoot, verificationRoot } = this.#workspaceRequest(manifest);
        return parseIssueExternalEffectDescriptor({
          ...common,
          kind: "workspace",
          baseBranch: manifest.base.branch,
          baseCommit: manifest.base.commit,
          branch: manifest.branch.name,
          workspacePathDigest: calculateIssueLifecycleDomainDigest("flow.issue.workspace-path.v1", {
            workspaceRoot,
            verificationRoot,
          }),
        });
      }
      case "commit": {
        const workspace = await this.#requireWorkspace(manifest);
        const candidate = await this.#localGit.inspectCandidate({
          workspace,
          baseCommit: request.parentCommit,
          allowedWritePrefixes: manifest.allowedWritePrefixes,
        });
        if (
          request.workspaceIdentityDigest !== workspace.workspaceIdentityDigest ||
          request.candidateTreeDigest !== calculateIssueCandidateTreeDigest(candidate.tree) ||
          request.messageDigest !== calculateIssueHostCommitMessageDigest(manifest)
        ) {
          throw new IssueLifecycleHostError("descriptor_mismatch");
        }
        return parseIssueExternalEffectDescriptor({
          ...common,
          kind: "commit",
          branch: manifest.branch.name,
          workspaceIdentityDigest: request.workspaceIdentityDigest,
          parentCommit: request.parentCommit,
          candidateTreeDigest: request.candidateTreeDigest,
          messageDigest: request.messageDigest,
        });
      }
      case "push":
        return parseIssueExternalEffectDescriptor({
          ...common,
          kind: "push",
          branch: manifest.branch.name,
          candidateHead: request.candidateHead,
          expectedRemoteHead: request.expectedRemoteHead,
        });
      case "pull_request": {
        const content = renderIssueHostPullRequest(manifest);
        return parseIssueExternalEffectDescriptor({
          ...common,
          kind: "pull_request",
          issueNumber: manifest.issue.number,
          issueNodeId: manifest.issue.nodeId,
          headBranch: manifest.branch.name,
          headCommit: request.candidateHead,
          baseBranch: manifest.base.branch,
          baseCommit: manifest.base.commit,
          titleDigest: digestText(content.title),
          bodyDigest: digestText(content.body),
          isDraft: true,
        });
      }
      case "pull_request_ready":
        if (request.pullRequestNumber === undefined || request.pullRequestNodeId === undefined) {
          throw new IssueLifecycleHostError("descriptor_mismatch");
        }
        return parseIssueExternalEffectDescriptor({
          ...common,
          kind: "pull_request_ready",
          pullRequestNumber: request.pullRequestNumber,
          pullRequestNodeId: request.pullRequestNodeId,
          headBranch: manifest.branch.name,
          headCommit: request.candidateHead,
          baseBranch: manifest.base.branch,
          baseCommit: manifest.base.commit,
          isDraft: false,
        });
      case "merge":
        return parseIssueExternalEffectDescriptor({
          ...common,
          kind: "merge",
          pullRequestNumber: request.pullRequestNumber,
          pullRequestNodeId: request.pullRequestNodeId,
          candidateHead: request.candidateHead,
          baseBranch: manifest.base.branch,
          baseCommit: manifest.base.commit,
          gateDigest: request.gateDigest,
          method: manifest.merge.method,
          deleteBranch: manifest.merge.deleteBranch,
        });
    }
  }

  async #reconcileWorkspace(
    descriptor: Extract<IssueExternalEffectDescriptor, { readonly kind: "workspace" }>,
    manifest: FrozenIssueRunManifest,
  ): Promise<IssueExternalEffectObservation> {
    const request = this.#workspaceRequest(manifest);
    const [workspaceExists, verificationExists] = await Promise.all([
      pathExists(request.workspaceRoot),
      pathExists(request.verificationRoot),
    ]);
    if (!workspaceExists && !verificationExists) {
      return await this.#notApplied(descriptor);
    }
    const workspace = await this.#localGit.prepareWorkspace(request);
    return await this.#applied(descriptor, {
      kind: "workspace",
      workspaceIdentityDigest: workspace.workspaceIdentityDigest,
    });
  }

  async #reconcileCommit(
    descriptor: Extract<IssueExternalEffectDescriptor, { readonly kind: "commit" }>,
    manifest: FrozenIssueRunManifest,
    signal?: AbortSignal,
  ): Promise<IssueExternalEffectObservation> {
    const workspace = await this.#requireWorkspace(manifest);
    const candidate = await this.#localGit.inspectCandidate({
      workspace,
      baseCommit: descriptor.parentCommit,
      allowedWritePrefixes: manifest.allowedWritePrefixes,
      ...(signal === undefined ? {} : { signal }),
    });
    this.#requireCommitIntent(descriptor, candidate.tree, workspace);
    if (candidate.head === descriptor.parentCommit) return await this.#notApplied(descriptor);
    const commit = await this.#localGit.inspectCommit({
      workspace,
      commit: candidate.head,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      commit.tree !== candidate.tree ||
      commit.parents.length !== 1 ||
      commit.parents[0] !== descriptor.parentCommit
    ) {
      throw new IssueLifecycleHostError("effect_state_uncertain");
    }
    return await this.#applied(descriptor, { kind: "commit", candidateHead: commit.commit });
  }

  async #reconcilePush(
    descriptor: Extract<IssueExternalEffectDescriptor, { readonly kind: "push" }>,
    manifest: FrozenIssueRunManifest,
    signal?: AbortSignal,
  ): Promise<IssueExternalEffectObservation> {
    const workspace = await this.#requireWorkspace(manifest);
    const observed = await this.#localGit.inspectRemoteBranch({
      workspace,
      branch: descriptor.branch,
      ...(signal === undefined ? {} : { signal }),
    });
    if (observed.head === descriptor.candidateHead) {
      return await this.#applied(descriptor, {
        kind: "push",
        branch: descriptor.branch,
        candidateHead: descriptor.candidateHead,
      });
    }
    if (observed.head === descriptor.expectedRemoteHead) return await this.#notApplied(descriptor);
    throw new IssueLifecycleHostError("effect_state_uncertain");
  }

  async #reconcileDraft(
    descriptor: Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request" }>,
    manifest: FrozenIssueRunManifest,
    signal?: AbortSignal,
  ): Promise<IssueExternalEffectObservation> {
    const content = renderIssueHostPullRequest(manifest);
    const observed = await this.#github.observeDraftPullRequest(
      {
        expected: await this.#expectedGitHub(manifest, descriptor.headCommit),
        effect: descriptor,
        ...content,
      },
      signal,
    );
    if (observed === null) return await this.#notApplied(descriptor);
    return await this.#applied(descriptor, observed.result, observed.evidence);
  }

  async #reconcileReady(
    descriptor: Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request_ready" }>,
    manifest: FrozenIssueRunManifest,
    signal?: AbortSignal,
  ): Promise<IssueExternalEffectObservation> {
    const expected = await this.#expectedGitHubWithPullRequest(manifest, descriptor);
    const observed = await this.#github.observeLifecycle(expected, signal);
    if (observed.observation.pullRequest.isDraft) {
      return await this.#notApplied(descriptor, observed.evidence);
    }
    return await this.#applied(
      descriptor,
      pullRequestEffectResult("pull_request_ready", false, observed.observation),
      observed.evidence,
    );
  }

  async #reconcileMerge(
    descriptor: Extract<IssueExternalEffectDescriptor, { readonly kind: "merge" }>,
    manifest: FrozenIssueRunManifest,
    signal?: AbortSignal,
  ): Promise<IssueExternalEffectObservation> {
    const observed = await this.#github.observeMergeOutcome(
      {
        expected: await this.#expectedGitHubWithPullRequest(manifest, descriptor),
        effect: descriptor,
      },
      signal,
    );
    if (observed === null) return await this.#notApplied(descriptor);
    this.#requireRemoteOutcome(observed.outcome, manifest, descriptor);
    const proof = await this.#proveObservedMerge(
      manifest,
      descriptor,
      observed.outcome,
      observed.evidence,
      signal,
    );
    return await this.#applied(
      descriptor,
      mergeEffectResult(descriptor, observed.outcome, calculateIssueMergeProofDigest(proof)),
      observed.evidence,
    );
  }

  async #expectedGitHub(
    manifest: FrozenIssueRunManifest,
    headCommit: string,
  ): Promise<FrozenGitHubIssueIdentity> {
    const snapshot = await this.#frozenIssue(manifest);
    return Object.freeze({
      repositoryIdentity: manifest.repository.identity,
      repositoryNodeId: manifest.repository.nodeId,
      issue: Object.freeze({
        number: manifest.issue.number,
        nodeId: manifest.issue.nodeId,
        updatedAt: manifest.issue.updatedAt,
        title: snapshot.issue.title,
        body: snapshot.issue.body,
        contentDigest: manifest.issue.contentDigest,
      }),
      base: Object.freeze({
        branch: manifest.base.branch,
        commit: manifest.base.commit,
      }),
      headBranch: manifest.branch.name,
      headCommit,
      hostedChecks: Object.freeze(
        manifest.hostedChecks.map((check) => Object.freeze({ ...check })),
      ),
    });
  }

  async #expectedGitHubWithPullRequest(
    manifest: FrozenIssueRunManifest,
    descriptor:
      | Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request_ready" }>
      | Extract<IssueExternalEffectDescriptor, { readonly kind: "merge" }>,
  ) {
    return await this.#expectedGitHubWithExactPullRequest(
      manifest,
      descriptor.kind === "merge" ? descriptor.candidateHead : descriptor.headCommit,
      {
        number: descriptor.pullRequestNumber,
        nodeId: descriptor.pullRequestNodeId,
        ...pullRequestContentDigests(manifest),
      },
    );
  }

  async #expectedGitHubWithExactPullRequest(
    manifest: FrozenIssueRunManifest,
    headCommit: string,
    pullRequest: ExactGitHubPullRequestIdentity,
  ) {
    return Object.freeze({ ...(await this.#expectedGitHub(manifest, headCommit)), pullRequest });
  }

  async #exactManifest(
    supplied: FrozenIssueRunManifest,
    runId: string,
  ): Promise<FrozenIssueRunManifest> {
    const stored = await this.#store.readManifest(runId);
    if (
      supplied.runId !== runId ||
      stored.runId !== runId ||
      calculateIssuePrivateManifestDigest(supplied) !== calculateIssuePrivateManifestDigest(stored)
    ) {
      throw new IssueLifecycleHostError("descriptor_mismatch");
    }
    return stored;
  }

  async #manifestForDescriptor(
    descriptor: IssueExternalEffectDescriptor,
  ): Promise<FrozenIssueRunManifest> {
    const manifest = await this.#store.readManifest(descriptor.runId);
    if (
      descriptor.repositoryIdentity !== manifest.repository.identity ||
      descriptor.frozenContractDigest !== calculateIssuePrivateManifestDigest(manifest)
    ) {
      throw new IssueLifecycleHostError("descriptor_mismatch");
    }
    return manifest;
  }

  async #resolveRecordedWorkspace(
    manifest: FrozenIssueRunManifest,
    signal?: AbortSignal,
  ): Promise<IssueGitWorkspace> {
    const events = await this.#store.read(manifest.runId);
    const recordedDigests = events.flatMap((event) =>
      event.type === "external_effect_settled" &&
      event.outcome === "applied" &&
      event.result.kind === "workspace"
        ? [event.result.workspaceIdentityDigest]
        : [],
    );
    const recordedDigest = recordedDigests[0];
    if (
      recordedDigest === undefined ||
      recordedDigests.some((digest) => digest !== recordedDigest)
    ) {
      throw new IssueLifecycleHostError("effect_state_uncertain");
    }
    const request = this.#workspaceRequest(manifest);
    const [workspaceExists, verificationExists] = await Promise.all([
      pathExists(request.workspaceRoot),
      pathExists(request.verificationRoot),
    ]);
    if (workspaceExists !== verificationExists) {
      throw new IssueLifecycleHostError("effect_state_uncertain");
    }
    let workspace: IssueGitWorkspace;
    try {
      workspace = await this.#localGit.prepareWorkspace(request, signal);
    } catch (error) {
      throw new IssueLifecycleHostError("effect_state_uncertain", { cause: error });
    }
    if (workspace.workspaceIdentityDigest !== recordedDigest) {
      throw new IssueLifecycleHostError("effect_state_uncertain");
    }
    return workspace;
  }

  async #frozenIssue(manifest: FrozenIssueRunManifest): Promise<FrozenGitHubIssueSnapshot> {
    const input = await this.#store.readBlob(manifest.runId, manifest.artifacts.issue);
    if (input.mediaType !== FROZEN_GITHUB_ISSUE_SNAPSHOT_MEDIA_TYPE) {
      throw new IssueLifecycleHostError("frozen_issue_invalid");
    }
    let snapshot: FrozenGitHubIssueSnapshot;
    try {
      snapshot = decodeFrozenGitHubIssueSnapshot(input.bytes);
    } catch {
      throw new IssueLifecycleHostError("frozen_issue_invalid");
    }
    if (
      snapshot.repository.identity !== manifest.repository.identity ||
      snapshot.repository.nodeId !== manifest.repository.nodeId ||
      snapshot.issue.number !== manifest.issue.number ||
      snapshot.issue.nodeId !== manifest.issue.nodeId ||
      snapshot.issue.updatedAt !== manifest.issue.updatedAt ||
      snapshot.issue.contentDigest !== manifest.issue.contentDigest
    ) {
      throw new IssueLifecycleHostError("frozen_issue_invalid");
    }
    return snapshot;
  }

  #workspaceRequest(manifest: FrozenIssueRunManifest): PrepareIssueGitWorkspaceRequest {
    const ownershipId = safeOwnershipId(manifest.runId);
    return Object.freeze({
      ownershipId,
      sourceRoot: this.#sourceRoot,
      workspaceRoot: join(this.#workspaceParent, ownershipId),
      verificationRoot: join(this.#workspaceParent, `${ownershipId}-verification`),
      repositoryIdentity: manifest.repository.identity,
      baseBranch: manifest.base.branch,
      baseCommit: manifest.base.commit,
      branch: manifest.branch.name,
    });
  }

  async #requireWorkspace(manifest: FrozenIssueRunManifest): Promise<IssueGitWorkspace> {
    const request = this.#workspaceRequest(manifest);
    if (
      !(await pathExists(request.workspaceRoot)) ||
      !(await pathExists(request.verificationRoot))
    ) {
      throw new IssueLifecycleHostError("effect_state_uncertain");
    }
    return await this.#localGit.prepareWorkspace(request);
  }

  async #readOwnedWorkspace(
    manifest: FrozenIssueRunManifest,
    signal?: AbortSignal,
  ): Promise<IssueGitWorkspace> {
    const request = this.#workspaceRequest(manifest);
    if (
      !(await pathExists(request.workspaceRoot)) ||
      !(await pathExists(request.verificationRoot))
    ) {
      throw new IssueLifecycleHostError("effect_state_uncertain");
    }
    return await this.#localGit.readOwnedWorkspace(request, signal);
  }

  #requireCommitIntent(
    descriptor: Extract<IssueExternalEffectDescriptor, { readonly kind: "commit" }>,
    tree: string,
    workspace: IssueGitWorkspace,
  ): void {
    if (
      descriptor.workspaceIdentityDigest !== workspace.workspaceIdentityDigest ||
      descriptor.candidateTreeDigest !== calculateIssueCandidateTreeDigest(tree)
    ) {
      throw new IssueLifecycleHostError("descriptor_mismatch");
    }
  }

  #requireRemoteOutcome(
    outcome: GitHubRemoteMergeOutcome,
    manifest: FrozenIssueRunManifest,
    descriptor: Extract<IssueExternalEffectDescriptor, { readonly kind: "merge" }>,
  ): void {
    const digests = pullRequestContentDigests(manifest);
    if (
      outcome.repositoryIdentity !== manifest.repository.identity ||
      outcome.repositoryNodeId !== manifest.repository.nodeId ||
      outcome.pullRequestNumber !== descriptor.pullRequestNumber ||
      outcome.pullRequestNodeId !== descriptor.pullRequestNodeId ||
      outcome.pullRequestTitleDigest !== digests.titleDigest ||
      outcome.pullRequestBodyDigest !== digests.bodyDigest ||
      outcome.issueNumber !== manifest.issue.number ||
      outcome.issueNodeId !== manifest.issue.nodeId ||
      outcome.issueState !== "closed" ||
      outcome.issueContentDigest !== manifest.issue.contentDigest ||
      outcome.candidateHead !== descriptor.candidateHead ||
      outcome.baseBranch !== descriptor.baseBranch ||
      (descriptor.deleteBranch && !outcome.branchDeleted)
    ) {
      throw new IssueLifecycleHostError("merge_proof_invalid");
    }
  }

  async #methodProof(
    manifest: FrozenIssueRunManifest,
    workspace: IssueGitWorkspace,
    candidate: IssueGitCommitObservation,
    merged: IssueGitCommitObservation,
    signal?: AbortSignal,
  ) {
    switch (manifest.merge.method) {
      case "merge":
        if (
          merged.parents.length !== 2 ||
          !merged.parents.includes(manifest.base.commit) ||
          !merged.parents.includes(candidate.commit)
        ) {
          throw new IssueLifecycleHostError("merge_proof_invalid");
        }
        return {
          kind: "merge" as const,
          parents: [merged.parents[0] as string, merged.parents[1] as string] as const,
        };
      case "squash":
        if (
          merged.parents.length !== 1 ||
          merged.parents[0] !== manifest.base.commit ||
          candidate.tree !== merged.tree
        ) {
          throw new IssueLifecycleHostError("merge_proof_invalid");
        }
        return {
          kind: "squash" as const,
          parent: manifest.base.commit,
          candidateTree: candidate.tree,
          mergeCommitTree: merged.tree,
        };
      case "rebase": {
        if (candidate.tree !== merged.tree) {
          throw new IssueLifecycleHostError("merge_proof_invalid");
        }
        const [candidateSeries, mergedSeries] = await Promise.all([
          this.#localGit.inspectPatchSeries({
            workspace,
            baseCommit: manifest.base.commit,
            headCommit: candidate.commit,
            ...(signal === undefined ? {} : { signal }),
          }),
          this.#localGit.inspectPatchSeries({
            workspace,
            baseCommit: manifest.base.commit,
            headCommit: merged.commit,
            ...(signal === undefined ? {} : { signal }),
          }),
        ]);
        if (
          candidateSeries.firstParent !== manifest.base.commit ||
          mergedSeries.firstParent !== manifest.base.commit ||
          candidateSeries.commitCount !== mergedSeries.commitCount ||
          candidateSeries.digest !== mergedSeries.digest
        ) {
          throw new IssueLifecycleHostError("merge_proof_invalid");
        }
        return {
          kind: "rebase" as const,
          firstParent: mergedSeries.firstParent,
          candidateTree: candidate.tree,
          mergedTree: merged.tree,
          candidatePatchDigest: candidateSeries.digest,
          mergedPatchDigest: mergedSeries.digest,
          rewrittenCommitCount: mergedSeries.commitCount,
        };
      }
    }
  }

  async #pullRequestIdentity(
    manifest: FrozenIssueRunManifest,
    expectedNumber: number,
    candidateHead: string,
  ): Promise<ExactGitHubPullRequestIdentity> {
    const events = await this.#store.read(manifest.runId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (
        event?.type === "external_effect_settled" &&
        event.outcome === "applied" &&
        (event.result.kind === "pull_request" || event.result.kind === "pull_request_ready") &&
        event.result.pullRequestNumber === expectedNumber &&
        event.result.candidateHead === candidateHead
      ) {
        return Object.freeze({
          number: event.result.pullRequestNumber,
          nodeId: event.result.pullRequestNodeId,
          ...pullRequestContentDigests(manifest),
        });
      }
    }
    throw new IssueLifecycleHostError("descriptor_mismatch");
  }

  async #notApplied(
    descriptor: IssueExternalEffectDescriptor,
    adapterEvidence?: GitHubIssueLifecycleEvidence,
  ): Promise<IssueExternalEffectObservation> {
    return {
      status: "not_applied",
      observationDigest: await this.#record(descriptor, "not_applied", undefined, adapterEvidence),
    };
  }

  async #applied(
    descriptor: IssueExternalEffectDescriptor,
    result: IssueExternalEffectResult,
    adapterEvidence?: GitHubIssueLifecycleEvidence,
  ): Promise<IssueExternalEffectObservation> {
    return {
      status: "applied",
      observationDigest: await this.#record(descriptor, "applied", result, adapterEvidence),
      result,
    };
  }

  async #uncertain(
    descriptor: IssueExternalEffectDescriptor,
    code: string,
  ): Promise<IssueExternalEffectObservation> {
    return {
      status: "uncertain",
      code,
      evidenceDigest: await this.#record(descriptor, "uncertain", undefined, undefined, code),
    };
  }

  async #recordApplied(
    descriptor: IssueExternalEffectDescriptor,
    result: IssueExternalEffectResult,
    adapterEvidence?: GitHubIssueLifecycleEvidence,
  ): Promise<void> {
    await this.#record(descriptor, "applied", result, adapterEvidence);
  }

  async #record(
    descriptor: IssueExternalEffectDescriptor,
    status: "applied" | "not_applied" | "uncertain",
    result?: IssueExternalEffectResult,
    adapterEvidence?: GitHubIssueLifecycleEvidence,
    code?: string,
  ): Promise<string> {
    const adapterEvidenceDigest =
      adapterEvidence === undefined
        ? undefined
        : await this.#storeAdapterEvidence(descriptor.runId, adapterEvidence);
    const bytes = encodeCanonical({
      version: 1,
      kind: descriptor.kind,
      operationDigest: calculateIssueExternalEffectOperationDigest(descriptor),
      status,
      ...(result === undefined ? {} : { result }),
      ...(adapterEvidenceDigest === undefined ? {} : { adapterEvidenceDigest }),
      ...(code === undefined ? {} : { code }),
    });
    const reference = await this.#store.putBlob(descriptor.runId, {
      mediaType: ISSUE_EXTERNAL_EFFECT_EVIDENCE_MEDIA_TYPE,
      bytes,
    });
    return reference.digest;
  }

  async #storeAdapterEvidence(
    runId: string,
    evidence: GitHubIssueLifecycleEvidence,
  ): Promise<string> {
    const reference = await this.#store.putBlob(runId, {
      mediaType: evidence.mediaType,
      bytes: Uint8Array.from(evidence.bytes),
    });
    return reference.digest;
  }

  async #storeMergeProofEvidence(
    manifest: FrozenIssueRunManifest,
    remote: GitHubRemoteMergeOutcome,
    remoteEvidenceDigest: string,
    topology: unknown,
  ): Promise<string> {
    const reference = await this.#store.putBlob(manifest.runId, {
      mediaType: ISSUE_MERGE_PROOF_EVIDENCE_MEDIA_TYPE,
      bytes: encodeCanonical({ version: 1, remote, remoteEvidenceDigest, topology }),
    });
    return reference.digest;
  }
}

export function renderIssueHostCommitMessage(manifest: FrozenIssueRunManifest): string {
  return renderIssueCommitMessage(manifest.issue.number);
}

export function calculateIssueHostCommitMessageDigest(manifest: FrozenIssueRunManifest): string {
  return calculateIssueCommitMessageDigest(manifest.issue.number);
}

export function calculateIssueCandidateTreeDigest(tree: string): string {
  try {
    return calculateCanonicalCandidateTreeDigest(tree);
  } catch {
    throw new IssueLifecycleHostError("descriptor_mismatch");
  }
}

export function renderIssueHostPullRequest(manifest: FrozenIssueRunManifest): {
  readonly title: string;
  readonly body: string;
} {
  return Object.freeze({
    title: `Implement issue #${manifest.issue.number}`,
    body: `Closes #${manifest.issue.number}\n\nCreated by the Flow harness for frozen run \`${manifest.runId}\`.\n`,
  });
}

export function encodeFrozenGitHubIssueSnapshot(
  observation: GitHubOpenIssueObservation,
): Uint8Array {
  let repositoryIdentity: string;
  try {
    repositoryIdentity = canonicalGitHubRepositoryIdentity(
      `${observation.repository.owner}/${observation.repository.name}`,
    );
  } catch {
    throw new IssueLifecycleHostError("frozen_issue_invalid");
  }
  const content: FrozenGitHubIssueSnapshotContent = {
    version: 1,
    repository: { identity: repositoryIdentity, nodeId: observation.repository.nodeId },
    issue: {
      number: observation.issue.number,
      nodeId: observation.issue.nodeId,
      updatedAt: observation.issue.updatedAt,
      title: observation.issue.title,
      body: observation.issue.body,
    },
  };
  try {
    return encodeCanonicalFrozenGitHubIssueSnapshot(content);
  } catch {
    throw new IssueLifecycleHostError("frozen_issue_invalid");
  }
}

function pullRequestContentDigests(manifest: FrozenIssueRunManifest) {
  const content = renderIssueHostPullRequest(manifest);
  return Object.freeze({
    titleDigest: digestText(content.title),
    bodyDigest: digestText(content.body),
  });
}

function pullRequestIdentityFromState(state: IssueLifecycleState): {
  readonly number: number;
  readonly nodeId: string;
} {
  if (state.publication !== undefined) {
    return {
      number: state.publication.pullRequestNumber,
      nodeId: state.publication.pullRequestNodeId,
    };
  }
  for (let index = state.appliedEffects.length - 1; index >= 0; index -= 1) {
    const effect = state.appliedEffects[index];
    if (effect?.result.kind === "pull_request" || effect?.result.kind === "pull_request_ready") {
      return { number: effect.result.pullRequestNumber, nodeId: effect.result.pullRequestNodeId };
    }
  }
  throw new IssueLifecycleHostError("descriptor_mismatch");
}

function pullRequestEffectResult(
  kind: "pull_request" | "pull_request_ready",
  isDraft: boolean,
  observation: GitHubLifecycleObservation,
): IssueExternalEffectResult {
  return {
    kind,
    repositoryIdentity: observation.repositoryIdentity,
    candidateHead: observation.pullRequest.headCommit,
    headBranch: observation.pullRequest.headBranch,
    baseBranch: observation.pullRequest.baseBranch,
    pullRequestNumber: observation.pullRequest.number,
    pullRequestNodeId: observation.pullRequest.nodeId,
    isDraft,
  } as IssueExternalEffectResult;
}

function mergeEffectResult(
  descriptor: Extract<IssueExternalEffectDescriptor, { readonly kind: "merge" }>,
  outcome: GitHubRemoteMergeOutcome,
  proofDigest: string,
): Extract<IssueExternalEffectResult, { readonly kind: "merge" }> {
  return Object.freeze({
    kind: "merge",
    candidateHead: descriptor.candidateHead,
    gateDigest: descriptor.gateDigest,
    mergeCommit: outcome.mergeCommit,
    deleteBranchRequested: descriptor.deleteBranch,
    branchDeleted: outcome.branchDeleted,
    proofDigest,
  });
}

function requireCommit(value: string | undefined): string {
  if (value === undefined || !gitCommitSchema.safeParse(value).success) {
    throw new IssueLifecycleHostError("descriptor_mismatch");
  }
  return value;
}

function safeOwnershipId(runId: string): string {
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(runId) && runId.length <= 128) return runId;
  return `issue-${digestText(runId).slice(0, 32)}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function stableErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(error.code) &&
    error.code.length <= 128
  ) {
    return error.code;
  }
  return "effect_state_uncertain";
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encodeCanonical(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new IssueLifecycleHostError("descriptor_mismatch");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new IssueLifecycleHostError("descriptor_mismatch");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

void (null as unknown as IssueLifecycleEvent);
