import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ArtifactStore } from "../../application/artifact-store.js";
import {
  calculateFrozenIssueVerificationCommandDigest,
  FROZEN_ISSUE_HOLDOUT_STDIN_MEDIA_TYPE,
  MAX_FROZEN_ISSUE_HOLDOUT_STDIN_BYTES,
} from "../../application/frozen-issue-command.js";
import {
  buildIssueIndependentReviewProjection,
  serializeBoundedIssueReviewContext,
} from "../../application/issue-independent-review-projection.js";
import type {
  FrozenIssueRunInput,
  IssueControllerOperation,
  IssueImplementationWorkflowRequest,
  IssueReviewWorkflowRequest,
  IssueRunFreezerPort,
  IssueWorkflowRunnerPort,
} from "../../application/github-issue-controller-ports.js";
import type {
  GitHubIssueAdmissionPort,
  GitHubOpenIssueObservation,
  GitRepositoryAdmissionPort,
  LocalGitRepositoryObservation,
} from "../../application/github-issue-ports.js";
import type { IssueLifecycleStore } from "../../application/issue-lifecycle-store.js";
import type {
  IssueGitCandidateObservation,
  IssueGitWorkspace,
  IssueLocalGitPort,
} from "../../application/issue-local-git-port.js";
import {
  calculateIssueReviewEvidenceDigest,
  ISSUE_REVIEW_DIFF_MEDIA_TYPE,
  type IssueReviewEvidence,
  type IssueReviewEvidencePort,
} from "../../application/issue-review-evidence-port.js";
import { validateIssueVerificationResult } from "../../application/issue-verification.js";
import {
  type AdmittedImplementationWorkflow,
  type AdmittedReviewWorkflow,
  admitIssueWorkflow,
  completeIssueWorkflowBudget,
} from "../../application/issue-workflow-admission.js";
import {
  type ImplementationWorkflowResult,
  IssueWorkflowExecutionError,
  type RawReviewWorkflowResult,
} from "../../application/issue-workflow-runner.js";
import type {
  ModelSessionStore,
  NodeEffectReconciler,
  NodeExecutor,
  WorkspaceIsolator,
} from "../../application/ports.js";
import { RunRecoveryError, resumeWorkflow, runWorkflow } from "../../application/run-workflow.js";
import type { CapabilitySnapshot } from "../../domain/capability/agent-skills.js";
import type { IssueLifecycleCommand } from "../../domain/issue-lifecycle/commands.js";
import {
  calculateFrozenGitHubIssueContentDigest,
  decodeFrozenGitHubIssueSnapshot,
  encodeFrozenGitHubIssueSnapshot,
  FROZEN_GITHUB_ISSUE_SNAPSHOT_MEDIA_TYPE,
  type FrozenGitHubIssueSnapshot,
  type FrozenGitHubIssueSnapshotContent,
} from "../../domain/issue-lifecycle/frozen-github-issue-snapshot.js";
import { parseGitHubIssueUrl } from "../../domain/issue-lifecycle/identity.js";
import {
  calculateIssueCandidateTreeDigest,
  calculateIssueCommitMessageDigest,
} from "../../domain/issue-lifecycle/issue-delivery-contract.js";
import { parseGitHubIssuePlanText } from "../../domain/issue-lifecycle/plan.js";
import {
  calculateIssueBudgetDigest,
  calculateIssueLifecycleDomainDigest,
  calculateIssuePrivateManifestDigest,
  createIssuePrivateBlobReference,
  type FrozenIssueRunManifest,
  type IssueBudgetInput,
  type IssuePrivateBlobInput,
  type IssuePrivateBlobReference,
  parseIssuePrivateBlobReference,
  parseIssuePrivateManifest,
  verifyIssuePrivateBlob,
} from "../../domain/issue-lifecycle/private-manifest.js";
import { type RunState, reduceRunEvents } from "../../domain/run/events.js";
import {
  type FrozenProjectFile,
  type FrozenProjectFileRequest,
  readFrozenProjectFile,
} from "../fs/frozen-project-file.js";
import { JsonlRunStore } from "../fs/jsonl-run-store.js";

const PLAN_MEDIA_TYPE = "application/vnd.flow.github-issue-plan+yaml";
const WORKFLOW_MEDIA_TYPE = "application/vnd.flow.workflow+yaml";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "resource_exhausted"]);

export interface FrozenIssueSourceFilePort {
  read(request: FrozenProjectFileRequest): Promise<FrozenProjectFile>;
}

export interface IssueControllerTimeout {
  readonly id: string;
  readonly timeoutMs: number;
}

export interface ProductionIssueRunFreezerOptions {
  readonly projectRoot: string;
  readonly planPath: string;
  readonly controllerTimeouts: readonly IssueControllerTimeout[];
  readonly repositoryAdmission: GitRepositoryAdmissionPort;
  readonly githubAdmission: GitHubIssueAdmissionPort;
  readonly capabilitySnapshot?: CapabilitySnapshot;
  readonly files?: FrozenIssueSourceFilePort;
  readonly now?: () => Date;
}

/** Freezes all mutable issue-run inputs before the controller performs its first effect. */
export class ProductionIssueRunFreezer implements IssueRunFreezerPort {
  readonly #capabilitySnapshot: CapabilitySnapshot | undefined;
  readonly #controllerTimeouts: readonly IssueControllerTimeout[];
  readonly #files: FrozenIssueSourceFilePort;
  readonly #githubAdmission: GitHubIssueAdmissionPort;
  readonly #now: () => Date;
  readonly #planPath: string;
  readonly #projectRoot: string;
  readonly #repositoryAdmission: GitRepositoryAdmissionPort;

  constructor(options: ProductionIssueRunFreezerOptions) {
    if (!isAbsolute(options.projectRoot) || resolve(options.projectRoot) !== options.projectRoot) {
      throw new Error("production issue freezer project root must be an absolute normalized path");
    }
    this.#projectRoot = options.projectRoot;
    this.#planPath = options.planPath;
    this.#controllerTimeouts = Object.freeze(
      options.controllerTimeouts.map((timeout) => Object.freeze({ ...timeout })),
    );
    this.#repositoryAdmission = options.repositoryAdmission;
    this.#githubAdmission = options.githubAdmission;
    this.#capabilitySnapshot = options.capabilitySnapshot;
    this.#files = options.files ?? { read: readFrozenProjectFile };
    this.#now = options.now ?? (() => new Date());
  }

  async freeze(
    command: Extract<IssueLifecycleCommand, { readonly kind: "run" }>,
    operation: IssueControllerOperation,
  ): Promise<FrozenIssueRunInput> {
    await operation.pollCancellation();
    const planFile = await this.#read(this.#planPath);
    if (planFile.sha256 !== command.planDigest) {
      throw new Error("run command plan digest does not match the exact frozen plan bytes");
    }
    const planSource = decodeUtf8(planFile);
    const plan = parseGitHubIssuePlanText(planSource, this.#planPath);
    const issueIdentity = parseGitHubIssueUrl(command.issueUrl);
    if (
      plan.repository.expected !== command.repositoryIdentity ||
      issueIdentity.repositoryIdentity !== command.repositoryIdentity
    ) {
      throw new Error("run command, issue URL, and frozen plan repository identities differ");
    }
    const repository = repositoryReference(command.repositoryIdentity);
    const firstLocal = await this.#repositoryAdmission.inspect(
      this.#projectRoot,
      repository,
      operation.signal,
    );
    const firstGitHub = await this.#githubAdmission.inspectOpenIssue(
      { repository, number: issueIdentity.number, baseBranch: plan.repository.baseBranch },
      operation.signal,
    );
    assertAdmission(firstLocal, firstGitHub, plan.repository.baseBranch, this.#projectRoot);
    await operation.pollCancellation();

    const implementationFile = await this.#read(plan.implementation.workflow);
    const reviewFile = await this.#read(plan.review.workflow);
    const holdoutStdinFile =
      plan.holdout.stdin === undefined
        ? undefined
        : await this.#read(plan.holdout.stdin.path, MAX_FROZEN_ISSUE_HOLDOUT_STDIN_BYTES);
    const implementationSource = decodeUtf8(implementationFile);
    const reviewSource = decodeUtf8(reviewFile);
    const issueSnapshot = issueSnapshotContent(firstGitHub);
    const issueBlob = issueSourceBlob(issueSnapshot);
    const implementation = admitIssueWorkflow({
      role: "implementation",
      source: implementationSource,
      sourceName: plan.implementation.workflow,
      ...(this.#capabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: this.#capabilitySnapshot }),
      model: { provider: command.provider, id: command.model },
      context: { kind: "issue", content: modelIssueContext(issueSnapshot) },
      allowedWritePrefixes: plan.candidate.allowedPathPrefixes,
    });
    const review = admitIssueWorkflow({
      role: "review",
      source: reviewSource,
      sourceName: plan.review.workflow,
      ...(this.#capabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: this.#capabilitySnapshot }),
      model: { provider: command.provider, id: command.model },
      context: {
        kind: "review",
        content: reviewValidationContext(
          modelIssueContext(issueSnapshot),
          implementation.criteria.map(({ id, description }) => ({ id, description })),
        ),
      },
      resultNodeId: plan.review.resultNode,
    });
    await operation.pollCancellation();
    const secondLocal = await this.#repositoryAdmission.inspect(
      this.#projectRoot,
      repository,
      operation.signal,
    );
    const secondGitHub = await this.#githubAdmission.inspectOpenIssue(
      { repository, number: issueIdentity.number, baseBranch: plan.repository.baseBranch },
      operation.signal,
    );
    assertAdmission(secondLocal, secondGitHub, plan.repository.baseBranch, this.#projectRoot);
    if (!sameAdmission(firstLocal, secondLocal) || !sameAdmission(firstGitHub, secondGitHub)) {
      throw new Error("GitHub issue or repository state changed during freezing");
    }

    const planBlob = sourceBlob(PLAN_MEDIA_TYPE, planFile);
    const implementationBlob = sourceBlob(WORKFLOW_MEDIA_TYPE, implementationFile);
    const reviewBlob = sourceBlob(WORKFLOW_MEDIA_TYPE, reviewFile);
    const holdoutStdinBlob =
      holdoutStdinFile === undefined
        ? undefined
        : sourceBlob(FROZEN_ISSUE_HOLDOUT_STDIN_MEDIA_TYPE, holdoutStdinFile);
    const initialBlobs = Object.freeze([
      issueBlob,
      planBlob,
      implementationBlob,
      reviewBlob,
      ...(holdoutStdinBlob === undefined ? [] : [holdoutStdinBlob]),
    ] as const);
    const budgets = issueBudgets(
      implementation,
      review,
      plan.holdout.command.timeoutMs,
      plan.verification.map((entry) => ({ id: entry.id, timeoutMs: entry.command.timeoutMs })),
      this.#controllerTimeouts,
    );
    const manifest = parseIssuePrivateManifest({
      version: 1,
      runId: deriveIssueRunId(command.commandId),
      initialCommandId: command.commandId,
      createdAt: this.#now().toISOString(),
      repository: {
        host: "github.com",
        identity: command.repositoryIdentity,
        nodeId: firstGitHub.repository.nodeId,
        canonicalUrl: firstGitHub.repository.canonicalUrl,
      },
      issue: {
        number: firstGitHub.issue.number,
        nodeId: firstGitHub.issue.nodeId,
        state: "open",
        updatedAt: canonicalTimestamp(firstGitHub.issue.updatedAt),
        canonicalUrl: firstGitHub.issue.canonicalUrl,
        contentDigest: calculateFrozenGitHubIssueContentDigest(issueSnapshot),
      },
      base: {
        branch: plan.repository.baseBranch,
        commit: firstGitHub.repository.configuredBase.commit,
        remoteRef: `refs/heads/${plan.repository.baseBranch}`,
      },
      branch: {
        prefix: plan.branch.prefix,
        name: `${plan.branch.prefix}${firstGitHub.issue.number}-${command.commandId.slice(0, 8)}`,
      },
      planDigest: planFile.sha256,
      implementationWorkflow: workflowIdentity(implementation, implementationFile.sha256),
      reviewWorkflow: {
        ...workflowIdentity(review, reviewFile.sha256),
        resultNodeId: review.resultNodeId,
      },
      acceptanceCriteria: implementation.criteria.map(({ id, description }) => ({
        id,
        description,
      })),
      allowedWritePrefixes: [...implementation.allowedWritePrefixes],
      holdout: {
        commandDigest: calculateFrozenIssueVerificationCommandDigest(plan.holdout.command),
        timeoutMs: plan.holdout.command.timeoutMs,
        ...(holdoutStdinFile === undefined ? {} : { stdinDigest: holdoutStdinFile.sha256 }),
      },
      verification: plan.verification.map((entry) => ({
        id: entry.id,
        commandDigest: calculateFrozenIssueVerificationCommandDigest(entry.command),
        timeoutMs: entry.command.timeoutMs,
      })),
      hostedChecks: plan.hostedChecks.required,
      merge: plan.merge,
      budgets,
      budgetDigest: calculateIssueBudgetDigest(budgets),
      artifacts: {
        issue: createIssuePrivateBlobReference(issueBlob),
        plan: createIssuePrivateBlobReference(planBlob),
        implementationWorkflow: createIssuePrivateBlobReference(implementationBlob),
        reviewWorkflow: createIssuePrivateBlobReference(reviewBlob),
        ...(holdoutStdinBlob === undefined
          ? {}
          : { holdoutStdin: createIssuePrivateBlobReference(holdoutStdinBlob) }),
      },
    });
    const frozenContractDigest = calculateIssuePrivateManifestDigest(manifest);
    return Object.freeze({
      manifest,
      initialBlobs,
      evidenceDigest: calculateIssueLifecycleDomainDigest("flow.issue.frozen-input-evidence.v1", {
        frozenContractDigest,
        artifacts: manifest.artifacts,
      }),
    });
  }

  async #read(path: string, maxBytes = 1_048_576): Promise<FrozenProjectFile> {
    return await this.#files.read({ projectRoot: this.#projectRoot, path, maxBytes });
  }
}

export interface IssueWorkflowWorkspacePort {
  read(input: {
    readonly runId: string;
    readonly workspaceIdentityDigest?: string;
    readonly signal?: AbortSignal;
  }): Promise<IssueGitWorkspace>;
}

export interface ProductionIssueWorkflowRunnerOptions {
  readonly nestedRunRoot: string;
  readonly lifecycleStore: Pick<IssueLifecycleStore, "readManifest" | "readBlob">;
  readonly workspaces: IssueWorkflowWorkspacePort;
  readonly git: Pick<IssueLocalGitPort, "inspectCandidate">;
  readonly reviewEvidence: IssueReviewEvidencePort;
  readonly executor: NodeExecutor;
  readonly capabilitySnapshot?: CapabilitySnapshot;
  readonly modelSessionStore?: ModelSessionStore;
  readonly artifactStore?: ArtifactStore;
  readonly effectReconciler?: NodeEffectReconciler;
  readonly workspaceIsolator?: WorkspaceIsolator;
  readonly now?: () => Date;
}

/** Executes admitted nested issue workflows without granting delivery authority to model nodes. */
export class ProductionIssueWorkflowRunner implements IssueWorkflowRunnerPort {
  readonly #artifactStore: ArtifactStore | undefined;
  readonly #capabilitySnapshot: CapabilitySnapshot | undefined;
  readonly #effectReconciler: NodeEffectReconciler | undefined;
  readonly #executor: NodeExecutor;
  readonly #git: Pick<IssueLocalGitPort, "inspectCandidate">;
  readonly #lifecycleStore: Pick<IssueLifecycleStore, "readManifest" | "readBlob">;
  readonly #modelSessionStore: ModelSessionStore | undefined;
  readonly #nestedRunRoot: string;
  readonly #now: (() => Date) | undefined;
  readonly #reviewEvidence: IssueReviewEvidencePort;
  readonly #workspaces: IssueWorkflowWorkspacePort;
  readonly #workspaceIsolator: WorkspaceIsolator | undefined;

  constructor(options: ProductionIssueWorkflowRunnerOptions) {
    if (
      !isAbsolute(options.nestedRunRoot) ||
      resolve(options.nestedRunRoot) !== options.nestedRunRoot
    ) {
      throw new Error("nested issue workflow root must be an absolute normalized path");
    }
    this.#nestedRunRoot = options.nestedRunRoot;
    this.#lifecycleStore = options.lifecycleStore;
    this.#workspaces = options.workspaces;
    this.#git = options.git;
    this.#reviewEvidence = options.reviewEvidence;
    this.#executor = options.executor;
    this.#capabilitySnapshot = options.capabilitySnapshot;
    this.#modelSessionStore = options.modelSessionStore;
    this.#artifactStore = options.artifactStore;
    this.#effectReconciler = options.effectReconciler;
    this.#workspaceIsolator = options.workspaceIsolator;
    this.#now = options.now;
  }

  async runImplementation(
    request: IssueImplementationWorkflowRequest,
  ): Promise<ImplementationWorkflowResult> {
    assertFrozenContractDigest(request.manifest, request.frozenContractDigest);
    await request.pollCancellation();
    const workspace = await this.#readWorkspace(request);
    const issueSnapshot = await this.#readIssueSnapshot(
      request.runId,
      request.manifest.artifacts.issue,
    );
    const source = await this.#readTextBlob(
      request.runId,
      request.manifest.artifacts.implementationWorkflow,
      WORKFLOW_MEDIA_TYPE,
    );
    const admitted = admitIssueWorkflow({
      role: "implementation",
      source,
      sourceName: "frozen-implementation.workflow.yaml",
      ...(this.#capabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: this.#capabilitySnapshot }),
      model: request.manifest.implementationWorkflow.model,
      context: { kind: "issue", content: modelIssueContext(issueSnapshot) },
      allowedWritePrefixes: request.manifest.allowedWritePrefixes,
    });
    assertWorkflowIdentity(request.manifest, "implementation", admitted);
    const flowRunId = deriveNestedIssueWorkflowRunId(
      request.runId,
      "implementation",
      String(request.iteration),
    );
    const state = await this.#execute(admitted, flowRunId, workspace, request.signal);
    assertSucceeded(state, flowRunId, "implementation");
    await request.pollCancellation();
    const candidate = await this.#git.inspectCandidate({
      workspace,
      baseCommit: request.manifest.base.commit,
      allowedWritePrefixes: request.manifest.allowedWritePrefixes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    assertCandidate(candidate, workspace, request.manifest);
    return Object.freeze({
      parentIssueRunId: request.runId,
      iteration: request.iteration,
      flowRunId,
      templateWorkflowDigest: admitted.templateWorkflowDigest,
      executionWorkflowDigest: state.workflowDigest,
      terminalSequence: state.lastSequence,
      evidenceDigest: await this.#evidenceDigest(flowRunId),
      workspaceIdentityDigest: workspace.workspaceIdentityDigest,
      candidateTreeDigest: calculateIssueCandidateTreeDigest(candidate.tree),
      commitMessageDigest: calculateIssueCommitMessageDigest(request.manifest.issue.number),
    });
  }

  async runReview(request: IssueReviewWorkflowRequest): Promise<RawReviewWorkflowResult> {
    assertFrozenContractDigest(request.manifest, request.frozenContractDigest);
    await request.pollCancellation();
    const workspace = await this.#readWorkspace(request);
    const issueSnapshot = await this.#readIssueSnapshot(
      request.runId,
      request.manifest.artifacts.issue,
    );
    const source = await this.#readTextBlob(
      request.runId,
      request.manifest.artifacts.reviewWorkflow,
      WORKFLOW_MEDIA_TYPE,
    );
    const reviewEvidence = validateReviewEvidence(
      request.manifest,
      request.candidateHead,
      workspace,
      await this.#reviewEvidence.read({
        runId: request.runId,
        manifest: request.manifest,
        candidateHead: request.candidateHead,
        workspace,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
    );
    const diff = await this.#readTextBlob(
      request.runId,
      reviewEvidence.diffBlob,
      ISSUE_REVIEW_DIFF_MEDIA_TYPE,
    );
    const admitted = admitIssueWorkflow({
      role: "review",
      source,
      sourceName: "frozen-review.workflow.yaml",
      ...(this.#capabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: this.#capabilitySnapshot }),
      model: request.manifest.reviewWorkflow.model,
      context: {
        kind: "review",
        content: buildIssueIndependentReviewProjection({
          manifest: request.manifest,
          frozenContractDigest: request.frozenContractDigest,
          candidateHead: request.candidateHead,
          issueSource: modelIssueContext(issueSnapshot),
          evidence: reviewEvidence,
          diff,
        }),
      },
      resultNodeId: request.manifest.reviewWorkflow.resultNodeId,
    });
    assertWorkflowIdentity(request.manifest, "review", admitted);
    const flowRunId = deriveNestedIssueWorkflowRunId(
      request.runId,
      "review",
      request.candidateHead,
    );
    const state = await this.#execute(
      admitted,
      flowRunId,
      workspace,
      request.signal,
      requireVerificationRoot(workspace),
    );
    assertSucceeded(state, flowRunId, "review");
    await request.pollCancellation();
    return await this.#reviewResult(request.manifest, request.candidateHead, flowRunId, state, {
      templateWorkflowDigest: admitted.templateWorkflowDigest,
      executionWorkflowDigest: state.workflowDigest,
      resultNodeId: admitted.resultNodeId,
    });
  }

  async readReviewResult(input: {
    readonly runId: string;
    readonly flowRunId: string;
    readonly candidateHead: string;
    readonly signal?: AbortSignal;
  }): Promise<RawReviewWorkflowResult> {
    const manifest = await this.#lifecycleStore.readManifest(input.runId);
    const expectedRunId = deriveNestedIssueWorkflowRunId(
      input.runId,
      "review",
      input.candidateHead,
    );
    if (input.flowRunId !== expectedRunId) {
      throw new Error("review nested run identity does not match the exact candidate");
    }
    const store = new JsonlRunStore(this.#nestedRunRoot);
    const state = reduceRunEvents(await store.read(input.flowRunId));
    assertSucceeded(state, input.flowRunId, "review");
    return await this.#reviewResult(manifest, input.candidateHead, input.flowRunId, state, {
      templateWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
      executionWorkflowDigest: state.workflowDigest,
      resultNodeId: manifest.reviewWorkflow.resultNodeId,
    });
  }

  async #execute(
    admitted: AdmittedImplementationWorkflow | AdmittedReviewWorkflow,
    flowRunId: string,
    workspace: IssueGitWorkspace,
    signal?: AbortSignal,
    executionRoot = workspace.root,
  ): Promise<RunState> {
    const store = new JsonlRunStore(this.#nestedRunRoot);
    const common = {
      cwd: executionRoot,
      projectRoot: executionRoot,
      protectedPaths: admitted.protectedPaths,
      allowedWritePrefixes: admitted.allowedWritePrefixes,
      ...(admitted.capabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: admitted.capabilitySnapshot }),
      executor: this.#executor,
      ...(this.#workspaceIsolator === undefined
        ? {}
        : { workspaceIsolator: this.#workspaceIsolator }),
      ...(this.#modelSessionStore === undefined
        ? {}
        : { modelSessionStore: this.#modelSessionStore }),
      ...(this.#artifactStore === undefined ? {} : { artifactStore: this.#artifactStore }),
      ...(this.#now === undefined ? {} : { now: this.#now }),
      ...(signal === undefined ? {} : { signal }),
    };
    if (!(await store.exists(flowRunId))) {
      return await runWorkflow(admitted.workflow, { ...common, store, runId: flowRunId });
    }
    const recovered = reduceRunEvents(await store.read(flowRunId));
    try {
      return await resumeWorkflow(admitted.workflow, {
        ...common,
        store,
        runId: flowRunId,
        ...(this.#effectReconciler === undefined
          ? {}
          : { effectReconciler: this.#effectReconciler }),
      });
    } catch (error) {
      if (
        TERMINAL_RUN_STATUSES.has(recovered.status) &&
        error instanceof RunRecoveryError &&
        error.code === "terminal_run"
      ) {
        return recovered;
      }
      throw error;
    }
  }

  async #readWorkspace(request: {
    readonly runId: string;
    readonly manifest: FrozenIssueRunManifest;
    readonly workspaceIdentityDigest?: string;
    readonly signal?: AbortSignal;
  }): Promise<IssueGitWorkspace> {
    const workspaceIdentityDigest = request.workspaceIdentityDigest;
    if (workspaceIdentityDigest !== undefined && !SHA256_PATTERN.test(workspaceIdentityDigest)) {
      throw new Error("issue workflow request has an invalid workspace identity");
    }
    const workspace = await this.#workspaces.read({
      runId: request.runId,
      ...(workspaceIdentityDigest === undefined ? {} : { workspaceIdentityDigest }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (
      !SHA256_PATTERN.test(workspace.workspaceIdentityDigest) ||
      (workspaceIdentityDigest !== undefined &&
        workspace.workspaceIdentityDigest !== workspaceIdentityDigest) ||
      workspace.repositoryIdentity !== request.manifest.repository.identity ||
      workspace.branch !== request.manifest.branch.name ||
      workspace.baseBranch !== request.manifest.base.branch ||
      workspace.baseCommit !== request.manifest.base.commit
    ) {
      throw new Error("resolved issue workspace does not match the frozen run identity");
    }
    return workspace;
  }

  async #readTextBlob(
    runId: string,
    reference: IssuePrivateBlobReference,
    expectedMediaType: string,
  ): Promise<string> {
    const blob = await this.#lifecycleStore.readBlob(runId, reference);
    verifyIssuePrivateBlob(blob, reference);
    if (blob.mediaType !== expectedMediaType) {
      throw new Error("frozen issue source blob has an unexpected media type");
    }
    return decodeBlobText(blob);
  }

  async #readIssueSnapshot(
    runId: string,
    reference: IssuePrivateBlobReference,
  ): Promise<FrozenGitHubIssueSnapshot> {
    const blob = await this.#lifecycleStore.readBlob(runId, reference);
    verifyIssuePrivateBlob(blob, reference);
    if (blob.mediaType !== FROZEN_GITHUB_ISSUE_SNAPSHOT_MEDIA_TYPE) {
      throw new Error("frozen GitHub issue snapshot has an unexpected media type");
    }
    return decodeFrozenGitHubIssueSnapshot(blob.bytes);
  }

  async #reviewResult(
    manifest: FrozenIssueRunManifest,
    candidateHead: string,
    flowRunId: string,
    state: RunState,
    identity: {
      readonly templateWorkflowDigest: string;
      readonly executionWorkflowDigest: string;
      readonly resultNodeId: string;
    },
  ): Promise<RawReviewWorkflowResult> {
    const resultNode = state.nodes[identity.resultNodeId];
    if (resultNode?.status !== "succeeded" || resultNode.evidence?.kind !== "agent") {
      throw new Error("review result node did not produce successful agent evidence");
    }
    return Object.freeze({
      parentIssueRunId: manifest.runId,
      candidateHead,
      flowRunId,
      templateWorkflowDigest: identity.templateWorkflowDigest,
      executionWorkflowDigest: identity.executionWorkflowDigest,
      terminalSequence: state.lastSequence,
      evidenceDigest: await this.#evidenceDigest(flowRunId),
      resultNodeId: identity.resultNodeId,
      resultTextTruncated: resultNode.evidence.textTruncated,
      resultText: resultNode.evidence.text,
    });
  }

  async #evidenceDigest(flowRunId: string): Promise<string> {
    const events = await new JsonlRunStore(this.#nestedRunRoot).read(flowRunId);
    return createHash("sha256")
      .update("flow.issue.nested-workflow-evidence.v1\0")
      .update(JSON.stringify(events))
      .digest("hex");
  }
}

export function deriveNestedIssueWorkflowRunId(
  parentRunId: string,
  role: "implementation" | "review",
  binding: string,
): string {
  if (role === "implementation") return `${parentRunId}-implementation-${binding}`;
  const digest = createHash("sha256")
    .update("flow.issue.review-run.v1\0")
    .update(parentRunId)
    .update("\0")
    .update(binding)
    .digest("hex")
    .slice(0, 32);
  return `${parentRunId}-review-${digest}`;
}

function workflowIdentity(
  workflow: AdmittedImplementationWorkflow | AdmittedReviewWorkflow,
  sourceDigest: string,
) {
  return {
    sourceDigest,
    templateWorkflowDigest: workflow.templateWorkflowDigest,
    ...(workflow.capabilitySnapshotDigest === undefined
      ? {}
      : { capabilitySnapshotDigest: workflow.capabilitySnapshotDigest }),
    model: {
      provider: firstWorkflowModel(workflow).provider,
      id: firstWorkflowModel(workflow).id,
    },
  };
}

function firstWorkflowModel(workflow: AdmittedImplementationWorkflow | AdmittedReviewWorkflow) {
  for (const node of workflow.workflow.nodes) {
    if (node.type === "agent") return node.agent.model;
    if (node.type === "verifier" && node.verifier.kind === "model") return node.verifier.model;
  }
  throw new Error("admitted issue workflow has no model binding");
}

function issueBudgets(
  implementation: AdmittedImplementationWorkflow,
  review: AdmittedReviewWorkflow,
  holdoutTimeoutMs: number,
  verification: readonly IssueControllerTimeout[],
  controller: readonly IssueControllerTimeout[],
): IssueBudgetInput {
  return {
    implementation: completeIssueWorkflowBudget(implementation.workflow.budget, "implementation"),
    review: completeIssueWorkflowBudget(review.workflow.budget, "review"),
    holdout: { timeoutMs: holdoutTimeoutMs },
    verification: verification.map((item) => ({ ...item })),
    controller: controller.map((item) => ({ ...item })),
  };
}

function sourceBlob(mediaType: string, file: FrozenProjectFile): IssuePrivateBlobInput {
  return Object.freeze({ mediaType, bytes: Buffer.from(file.contentBase64, "base64") });
}

function issueSnapshotContent(
  observation: GitHubOpenIssueObservation,
): FrozenGitHubIssueSnapshotContent {
  return Object.freeze({
    version: 1,
    repository: Object.freeze({
      identity: `${observation.repository.owner.toLowerCase()}/${observation.repository.name.toLowerCase()}`,
      nodeId: observation.repository.nodeId,
    }),
    issue: Object.freeze({
      number: observation.issue.number,
      nodeId: observation.issue.nodeId,
      updatedAt: canonicalTimestamp(observation.issue.updatedAt),
      title: observation.issue.title,
      body: observation.issue.body,
    }),
  });
}

function issueSourceBlob(snapshot: FrozenGitHubIssueSnapshotContent): IssuePrivateBlobInput {
  return Object.freeze({
    mediaType: FROZEN_GITHUB_ISSUE_SNAPSHOT_MEDIA_TYPE,
    bytes: encodeFrozenGitHubIssueSnapshot(snapshot),
  });
}

function reviewValidationContext(
  issueSource: string,
  acceptanceCriteria: FrozenIssueRunManifest["acceptanceCriteria"],
): string {
  return serializeBoundedIssueReviewContext({
    version: 1,
    issue: JSON.parse(issueSource),
    acceptanceCriteria: acceptanceCriteria.map((criterion) => ({ ...criterion })),
  });
}

function modelIssueContext(snapshot: FrozenGitHubIssueSnapshotContent): string {
  return JSON.stringify({
    version: 1,
    repository: { identity: snapshot.repository.identity },
    issue: {
      number: snapshot.issue.number,
      title: snapshot.issue.title,
      body: snapshot.issue.body,
      updatedAt: snapshot.issue.updatedAt,
    },
  });
}

function validateReviewEvidence(
  manifest: FrozenIssueRunManifest,
  candidateHead: string,
  workspace: IssueGitWorkspace,
  evidence: IssueReviewEvidence,
): IssueReviewEvidence {
  const verification = validateIssueVerificationResult(
    manifest,
    candidateHead,
    evidence.verification,
  );
  const paths = evidence.changedPaths;
  const diffBlob = parseIssuePrivateBlobReference(evidence.diffBlob);
  if (
    evidence.version !== 1 ||
    evidence.baseCommit !== manifest.base.commit ||
    evidence.candidateHead !== candidateHead ||
    !GIT_COMMIT_PATTERN.test(evidence.candidateTree) ||
    evidence.workspaceIdentityDigest !== workspace.workspaceIdentityDigest ||
    paths.length !== verification.candidateDelta.pathCount ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !isSafeReviewPath(path)) ||
    evidence.logicalBytes !== verification.candidateDelta.logicalBytes ||
    evidence.evidenceDigest !==
      calculateIssueReviewEvidenceDigest({
        version: evidence.version,
        baseCommit: evidence.baseCommit,
        candidateHead: evidence.candidateHead,
        candidateTree: evidence.candidateTree,
        workspaceIdentityDigest: evidence.workspaceIdentityDigest,
        changedPaths: evidence.changedPaths,
        logicalBytes: evidence.logicalBytes,
        diffBlob,
        verification,
      })
  ) {
    throw new Error("private review evidence does not match the exact verified candidate");
  }
  return Object.freeze({ ...evidence, verification });
}

function requireVerificationRoot(workspace: IssueGitWorkspace): string {
  const verificationRoot = (workspace as IssueGitWorkspace & { verificationRoot?: unknown })
    .verificationRoot;
  if (
    typeof verificationRoot !== "string" ||
    !isAbsolute(verificationRoot) ||
    resolve(verificationRoot) !== verificationRoot ||
    verificationRoot === workspace.root ||
    verificationRoot === workspace.sourceRoot
  ) {
    throw new Error("issue review workspace has an invalid detached verification root");
  }
  return verificationRoot;
}

function isSafeReviewPath(path: string): boolean {
  if (
    path.length < 1 ||
    path.length > 1_024 ||
    path !== path.trim() ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\p{Cc}\p{Cf}]/u.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      segment !== ".git" &&
      segment !== ".flow",
  );
}

function decodeUtf8(file: FrozenProjectFile): string {
  const bytes = Buffer.from(file.contentBase64, "base64");
  if (bytes.byteLength !== file.byteLength || sha256(bytes) !== file.sha256) {
    throw new Error("frozen project file bytes do not match their immutable identity");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("frozen project file must contain valid UTF-8", { cause: error });
  }
}

function decodeBlobText(blob: IssuePrivateBlobInput): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes);
  } catch (error) {
    throw new Error("frozen issue source blob must contain valid UTF-8", { cause: error });
  }
}

function assertAdmission(
  local: LocalGitRepositoryObservation,
  github: GitHubOpenIssueObservation,
  baseBranch: string,
  projectRoot: string,
): void {
  const identity = `${github.repository.owner.toLowerCase()}/${github.repository.name.toLowerCase()}`;
  if (
    local.root !== projectRoot ||
    local.branch !== baseBranch ||
    local.head !== github.repository.configuredBase.commit ||
    local.origin.owner.toLowerCase() !== github.repository.owner.toLowerCase() ||
    local.origin.name.toLowerCase() !== github.repository.name.toLowerCase() ||
    github.repository.configuredBase.branch !== baseBranch ||
    local.origin.canonicalUrl.toLowerCase() !== `https://github.com/${identity}`
  ) {
    throw new Error("local and GitHub repository admission identities do not match");
  }
}

function sameAdmission(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertWorkflowIdentity(
  manifest: FrozenIssueRunManifest,
  role: "implementation" | "review",
  admitted: AdmittedImplementationWorkflow | AdmittedReviewWorkflow,
): void {
  const expected =
    role === "implementation" ? manifest.implementationWorkflow : manifest.reviewWorkflow;
  if (
    admitted.role !== role ||
    admitted.sourceDigest !== expected.sourceDigest ||
    admitted.templateWorkflowDigest !== expected.templateWorkflowDigest ||
    admitted.capabilitySnapshotDigest !== expected.capabilitySnapshotDigest ||
    firstWorkflowModel(admitted).provider !== expected.model.provider ||
    firstWorkflowModel(admitted).id !== expected.model.id ||
    (role === "review" &&
      (admitted as AdmittedReviewWorkflow).resultNodeId !== manifest.reviewWorkflow.resultNodeId)
  ) {
    throw new Error(`${role} workflow does not match its frozen manifest identity`);
  }
  const budget = completeIssueWorkflowBudget(admitted.workflow.budget, role);
  const frozenBudget =
    role === "implementation" ? manifest.budgets.implementation : manifest.budgets.review;
  if (JSON.stringify(budget) !== JSON.stringify(frozenBudget)) {
    throw new Error(`${role} workflow budget does not match its frozen manifest identity`);
  }
}

function assertFrozenContractDigest(
  manifest: FrozenIssueRunManifest,
  frozenContractDigest: string,
): void {
  if (calculateIssuePrivateManifestDigest(manifest) !== frozenContractDigest) {
    throw new Error("issue workflow request does not match the frozen contract digest");
  }
}

function assertCandidate(
  candidate: IssueGitCandidateObservation,
  workspace: IssueGitWorkspace,
  manifest: FrozenIssueRunManifest,
): void {
  if (
    candidate.workspaceIdentityDigest !== workspace.workspaceIdentityDigest ||
    candidate.branch !== manifest.branch.name ||
    candidate.baseCommit !== manifest.base.commit
  ) {
    throw new Error("host-observed candidate does not match the frozen workspace");
  }
}

function assertSucceeded(
  state: RunState,
  flowRunId: string,
  role: "implementation" | "review",
): void {
  if (state.runId !== flowRunId) {
    throw new IssueWorkflowExecutionError(
      "nested_workflow_identity_mismatch",
      role,
      state.status,
      state.failedNodeId,
      nestedFailureCode(state),
    );
  }
  if (state.status === "succeeded") return;
  const suffix =
    state.status === "resource_exhausted"
      ? "resource_exhausted"
      : state.status === "failed"
        ? "workflow_failed"
        : state.status === "cancelled"
          ? "workflow_cancelled"
          : "workflow_incomplete";
  throw new IssueWorkflowExecutionError(
    `${role}_${suffix}`,
    role,
    state.status,
    state.failedNodeId,
    nestedFailureCode(state),
  );
}

function nestedFailureCode(state: RunState): string | null {
  if (state.failedNodeId === null) return null;
  const code = state.nodes[state.failedNodeId]?.error?.code;
  return typeof code === "string" &&
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(code) &&
    code.length <= 128
    ? code
    : null;
}

function deriveIssueRunId(commandId: string): string {
  return `issue-${commandId}`;
}

function repositoryReference(identity: string) {
  const [owner, name] = identity.split("/") as [string, string];
  return { host: "github.com" as const, owner, name };
}

function canonicalTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("GitHub timestamp is invalid");
  return new Date(milliseconds).toISOString();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
