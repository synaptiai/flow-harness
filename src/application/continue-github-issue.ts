import { calculateIssueLifecycleCommandDigest } from "../domain/issue-lifecycle/commands.js";
import type { PublicIssueLifecycleState } from "../domain/issue-lifecycle/events.js";
import {
  createInitialIssueLifecycleState,
  deriveIssueExternalEffectId,
  type IssueExternalEffectResult,
  type IssueLifecycleEvent,
  type IssueLifecyclePhaseReceipt,
  type IssueLifecycleState,
  parseIssueLifecycleEvent,
  projectPublicIssueLifecycleState,
  reduceIssueLifecycleEvent,
} from "../domain/issue-lifecycle/events.js";
import {
  calculateIssueExternalEffectOperationDigest,
  type IssueExternalEffectDescriptor,
  parseIssueExternalEffectDescriptor,
} from "../domain/issue-lifecycle/external-effects.js";
import type { GitHubLifecycleObservation } from "../domain/issue-lifecycle/github-observation.js";
import {
  calculateIssueLifecycleDomainDigest,
  calculateIssuePrivateManifestDigest,
  type FrozenIssueRunManifest,
} from "../domain/issue-lifecycle/private-manifest.js";
import type {
  IssueControllerCommandRecord,
  IssueControllerOperation,
  IssueControllerRuntimeDependencies,
  IssueExternalEffectPreparation,
} from "./github-issue-controller-ports.js";
import {
  assessGitHubObservation,
  type BuiltIssueMergeGate,
  buildIssueMergeGate,
  type IssueVerificationResult,
  validateIssueVerificationResult,
} from "./issue-verification.js";
import {
  type ValidatedReviewWorkflowResult,
  validateImplementationWorkflowResult,
  validateReviewWorkflowResult,
} from "./issue-workflow-runner.js";

const MAX_CONTROLLER_STEPS = 256;

export interface ClaimedIssueController {
  readonly manifest: FrozenIssueRunManifest;
  readonly frozenContractDigest: string;
  readonly commandId: string;
  readonly dependencies: IssueControllerRuntimeDependencies;
  readonly events: readonly IssueLifecycleEvent[];
  readonly state: IssueLifecycleState;
  append(typeSpecificEvent: Record<string, unknown>): Promise<void>;
  operation(): IssueControllerOperation;
}

export interface CurrentIssueGate {
  readonly gate: BuiltIssueMergeGate;
  readonly observation: GitHubLifecycleObservation;
  readonly verification: IssueVerificationResult;
  readonly review: ValidatedReviewWorkflowResult;
}

export class IssueControllerError extends Error {
  override readonly name = "IssueControllerError";

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

class MutableClaimedIssueController implements ClaimedIssueController {
  readonly frozenContractDigest: string;
  #events: IssueLifecycleEvent[];
  #state: IssueLifecycleState;

  constructor(
    readonly manifest: FrozenIssueRunManifest,
    events: readonly IssueLifecycleEvent[],
    readonly commandId: string,
    readonly dependencies: IssueControllerRuntimeDependencies,
  ) {
    this.frozenContractDigest = calculateIssuePrivateManifestDigest(manifest);
    this.#events = [...events];
    this.#state = replayIssueLifecycleState(manifest, events);
  }

  get events(): readonly IssueLifecycleEvent[] {
    return this.#events;
  }

  get state(): IssueLifecycleState {
    return this.#state;
  }

  operation(): IssueControllerOperation {
    return {
      ...(this.dependencies.signal === undefined ? {} : { signal: this.dependencies.signal }),
      pollCancellation: async () => {
        if (this.dependencies.signal?.aborted) {
          throw new IssueControllerError("operation_aborted", "issue operation was aborted");
        }
        const cancellation = await this.dependencies.repository.readPendingCancellation(
          this.manifest.runId,
        );
        if (cancellation !== undefined) {
          throw new IssueCancellationRequested(cancellation);
        }
      },
    };
  }

  async append(typeSpecificEvent: Record<string, unknown>): Promise<void> {
    const event = parseIssueLifecycleEvent({
      version: 1,
      runId: this.manifest.runId,
      sequence: this.#state.sequence + 1,
      at: monotonicTimestamp(this.#state.lastEventAt, this.dependencies.now),
      ...typeSpecificEvent,
    });
    const next = reduceIssueLifecycleEvent(this.#state, event);
    await this.dependencies.repository.append(event);
    this.#events.push(event);
    this.#state = next;
  }
}

export class IssueCancellationRequested extends Error {
  override readonly name = "IssueCancellationRequested";
  constructor(readonly record: IssueControllerCommandRecord) {
    super("issue cancellation was requested");
  }
}

export async function createClaimedIssueController(
  runId: string,
  commandId: string,
  dependencies: IssueControllerRuntimeDependencies,
): Promise<ClaimedIssueController> {
  const events = await dependencies.repository.claim(runId);
  try {
    const manifest = await dependencies.repository.readManifest(runId);
    return new MutableClaimedIssueController(manifest, events, commandId, dependencies);
  } catch (error) {
    await dependencies.repository.release(runId);
    throw error;
  }
}

export async function releaseClaimedIssue(controller: ClaimedIssueController): Promise<void> {
  await controller.dependencies.repository.release(controller.manifest.runId);
}

export async function continueClaimedIssue(
  controller: ClaimedIssueController,
): Promise<PublicIssueLifecycleState> {
  try {
    return await continueClaimedIssueLoop(controller);
  } catch (error) {
    if (error instanceof IssueCancellationRequested) {
      return await cancelClaimedIssue(controller, error.record);
    }
    throw error;
  }
}

async function continueClaimedIssueLoop(
  controller: ClaimedIssueController,
): Promise<PublicIssueLifecycleState> {
  for (let step = 0; step < MAX_CONTROLLER_STEPS; step += 1) {
    if (["merged", "failed", "cancelled"].includes(controller.state.phase)) {
      return projectPublicIssueLifecycleState(controller.state);
    }
    if (controller.state.phase !== "external_state_uncertain") {
      await controller.operation().pollCancellation();
    }
    switch (controller.state.phase) {
      case "issue_frozen":
        await prepareWorkspace(controller);
        break;
      case "workspace_prepared":
        await startImplementation(
          controller,
          evidenceDigest("implementation-start", {
            iteration: controller.state.implementationIteration + 1,
          }),
        );
        break;
      case "implementing":
        await implement(controller);
        break;
      case "verifying":
        await verifyCandidate(controller);
        break;
      case "reviewing":
        await reviewCandidate(controller);
        break;
      case "publishing":
        await publishCandidate(controller);
        break;
      case "waiting_for_ci": {
        const gate = await createCurrentIssueGate(controller);
        if (gate === undefined) return projectPublicIssueLifecycleState(controller.state);
        await controller.append({
          type: "phase_transitioned",
          from: "waiting_for_ci",
          to: "merge_approval_required",
          receipt: {
            kind: "merge_gate",
            repositoryIdentity: controller.manifest.repository.identity,
            baseBranch: controller.manifest.base.branch,
            baseCommit: controller.manifest.base.commit,
            branch: controller.manifest.branch.name,
            pullRequestNumber: gate.observation.pullRequest.number,
            pullRequestNodeId: gate.observation.pullRequest.nodeId,
            candidateHead: requiredCandidateHead(controller.state),
            checksDigest: gate.gate.checksDigest,
            gateDigest: gate.gate.digest,
            deleteBranch: controller.manifest.merge.deleteBranch,
            evidenceDigest: gate.gate.evidenceDigest,
          },
        });
        return projectPublicIssueLifecycleState(controller.state);
      }
      case "external_state_uncertain": {
        const recovered = await recoverPendingEffect(controller);
        if (!recovered) return projectPublicIssueLifecycleState(controller.state);
        break;
      }
      case "merge_approval_required":
      case "merged":
      case "failed":
      case "cancelled":
        throw new IssueControllerError(
          "terminal_dispatch_unreachable",
          "terminal lifecycle state bypassed the foreground terminal guard",
        );
      case "preflight":
        throw new IssueControllerError(
          "missing_frozen_snapshot",
          "initialized issue run has no frozen snapshot",
        );
      case "merging":
        throw new IssueControllerError(
          "merge_command_required",
          "only an exact operator merge command can continue the merging phase",
        );
    }
  }
  throw new IssueControllerError(
    "controller_step_limit",
    `issue controller exceeded ${MAX_CONTROLLER_STEPS} foreground steps`,
  );
}

async function cancelClaimedIssue(
  controller: ClaimedIssueController,
  record: IssueControllerCommandRecord,
): Promise<PublicIssueLifecycleState> {
  if (record.command.kind !== "cancel" || record.command.runId !== controller.manifest.runId) {
    throw new IssueControllerError(
      "cancellation_mismatch",
      "pending cancellation does not match the claimed issue run",
    );
  }
  if (controller.state.pendingEffect !== undefined) {
    throw new IssueControllerError(
      "cancellation_deferred",
      "pending external effect must reconcile before cancellation can settle",
    );
  }
  const actorDigest = evidenceDigest("cancellation-actor", { actor: record.command.actor });
  const reasonDigest =
    record.command.reason === undefined
      ? undefined
      : evidenceDigest("cancellation-reason", { reason: record.command.reason });
  await controller.append({
    type: "run_cancelled",
    actorDigest,
    ...(reasonDigest === undefined ? {} : { reasonDigest }),
  });
  const state = projectPublicIssueLifecycleState(controller.state);
  await controller.dependencies.repository.settleCommand(
    controller.manifest.runId,
    record.command.commandId,
    {
      version: 1,
      commandDigest: calculateIssueLifecycleCommandDigest(record.command),
      settledAt: state.lastEventAt,
      outcome: "completed",
      resultDigest: publicStateDigest(state),
    },
  );
  return state;
}

export async function createCurrentIssueGate(
  controller: ClaimedIssueController,
): Promise<CurrentIssueGate | undefined> {
  const candidateHead = requiredCandidateHead(controller.state);
  const publication = controller.state.publication;
  if (publication === undefined) {
    throw new IssueControllerError("publication_missing", "published pull request is missing");
  }
  const verification = validateIssueVerificationResult(
    controller.manifest,
    candidateHead,
    await controller.dependencies.verification.verify({
      runId: controller.manifest.runId,
      manifest: controller.manifest,
      frozenContractDigest: controller.frozenContractDigest,
      candidateHead,
      ...controller.operation(),
    }),
  );
  const observation = await controller.dependencies.github.observe({
    runId: controller.manifest.runId,
    manifest: controller.manifest,
    pullRequestNumber: publication.pullRequestNumber,
    candidateHead,
    ...controller.operation(),
  });
  const assessment = assessGitHubObservation(
    controller.manifest,
    publication.pullRequestNumber,
    candidateHead,
    observation,
  );
  if (assessment.status === "waiting") return undefined;

  const implementationReceipt = latestReceipt(controller.events, "implementation");
  const reviewReceipt = latestReceipt(controller.events, "review");
  const rawReview = await controller.dependencies.workflows.readReviewResult({
    runId: controller.manifest.runId,
    flowRunId: reviewReceipt.flowRunId,
    candidateHead,
    ...(controller.dependencies.signal === undefined
      ? {}
      : { signal: controller.dependencies.signal }),
  });
  const review = validateReviewWorkflowResult(controller.manifest, candidateHead, rawReview);
  if (
    review.flowRunId !== reviewReceipt.flowRunId ||
    review.executionWorkflowDigest !== reviewReceipt.executionWorkflowDigest ||
    review.terminalSequence !== reviewReceipt.terminalSequence ||
    review.evidenceDigest !== reviewReceipt.evidenceDigest ||
    review.reportDigest !== reviewReceipt.reportDigest
  ) {
    throw new IssueControllerError(
      "review_recovery_mismatch",
      "recovered review output does not match the append-only review receipt",
    );
  }

  return {
    verification,
    observation: assessment.observation,
    review,
    gate: buildIssueMergeGate({
      manifest: controller.manifest,
      frozenContractDigest: controller.frozenContractDigest,
      sequence:
        controller.state.phase === "merge_approval_required"
          ? controller.state.sequence - 1
          : controller.state.sequence,
      candidateHead,
      implementation: {
        flowRunId: implementationReceipt.flowRunId,
        executionWorkflowDigest: implementationReceipt.executionWorkflowDigest,
        terminalSequence: implementationReceipt.terminalSequence,
        evidenceDigest: implementationReceipt.evidenceDigest,
      },
      verification,
      review: {
        flowRunId: review.flowRunId,
        executionWorkflowDigest: review.executionWorkflowDigest,
        terminalSequence: review.terminalSequence,
        evidenceDigest: review.evidenceDigest,
        reportDigest: review.reportDigest,
        report: review.report,
      },
      observation: assessment.observation,
    }),
  };
}

async function prepareWorkspace(controller: ClaimedIssueController): Promise<void> {
  const applied = await runExternalEffect(controller, {
    kind: "workspace",
    commandId: controller.commandId,
  });
  if (applied === undefined) return;
  if (applied.result.kind !== "workspace") impossibleEffect(applied.result, "workspace");
  await controller.append({
    type: "phase_transitioned",
    from: "issue_frozen",
    to: "workspace_prepared",
    receipt: {
      kind: "workspace",
      workspaceIdentityDigest: applied.result.workspaceIdentityDigest,
      evidenceDigest: applied.observationDigest,
    },
  });
}

async function startImplementation(
  controller: ClaimedIssueController,
  implementationEvidenceDigest: string,
): Promise<void> {
  await controller.append({
    type: "phase_transitioned",
    from: controller.state.phase,
    to: "implementing",
    receipt: {
      kind: "implementation_started",
      iteration: controller.state.implementationIteration + 1,
      evidenceDigest: implementationEvidenceDigest,
    },
  });
}

async function implement(controller: ClaimedIssueController): Promise<void> {
  const workspace = requiredLatestAppliedResult(controller.events, "workspace");
  const raw = await controller.dependencies.workflows.runImplementation({
    kind: "implementation",
    runId: controller.manifest.runId,
    manifest: controller.manifest,
    frozenContractDigest: controller.frozenContractDigest,
    iteration: controller.state.implementationIteration,
    workspaceIdentityDigest: workspace.workspaceIdentityDigest,
    ...controller.operation(),
  });
  const result = validateImplementationWorkflowResult(
    controller.manifest,
    controller.state.implementationIteration,
    workspace.workspaceIdentityDigest,
    raw,
  );
  const parentCommit = controller.state.candidateHead ?? controller.manifest.base.commit;
  const applied = await runExternalEffect(controller, {
    kind: "commit",
    commandId: controller.commandId,
    workspaceIdentityDigest: workspace.workspaceIdentityDigest,
    parentCommit,
    candidateTreeDigest: result.candidateTreeDigest,
    messageDigest: result.commitMessageDigest,
  });
  if (applied === undefined) return;
  if (applied.result.kind !== "commit") impossibleEffect(applied.result, "commit");
  await controller.append({
    type: "phase_transitioned",
    from: "implementing",
    to: "verifying",
    receipt: {
      kind: "implementation",
      candidateHead: applied.result.candidateHead,
      flowRunId: result.flowRunId,
      executionWorkflowDigest: result.executionWorkflowDigest,
      terminalSequence: result.terminalSequence,
      evidenceDigest: result.evidenceDigest,
    },
  });
}

async function verifyCandidate(controller: ClaimedIssueController): Promise<void> {
  const candidateHead = requiredCandidateHead(controller.state);
  const verification = validateIssueVerificationResult(
    controller.manifest,
    candidateHead,
    await controller.dependencies.verification.verify({
      runId: controller.manifest.runId,
      manifest: controller.manifest,
      frozenContractDigest: controller.frozenContractDigest,
      candidateHead,
      ...controller.operation(),
    }),
  );
  await controller.append({
    type: "phase_transitioned",
    from: "verifying",
    to: "reviewing",
    receipt: {
      kind: "verification",
      candidateHead,
      evidenceDigest: verification.evidenceDigest,
    },
  });
}

async function reviewCandidate(controller: ClaimedIssueController): Promise<void> {
  const candidateHead = requiredCandidateHead(controller.state);
  const review = validateReviewWorkflowResult(
    controller.manifest,
    candidateHead,
    await controller.dependencies.workflows.runReview({
      kind: "review",
      runId: controller.manifest.runId,
      manifest: controller.manifest,
      frozenContractDigest: controller.frozenContractDigest,
      candidateHead,
      ...controller.operation(),
    }),
  );
  if (review.report.verdict === "blocked") {
    await controller.append({
      type: "run_failed",
      code: "review_blocked",
      evidenceDigest: review.reportDigest,
    });
    return;
  }
  await controller.append({
    type: "phase_transitioned",
    from: "reviewing",
    to: "publishing",
    receipt: {
      kind: "review",
      candidateHead,
      flowRunId: review.flowRunId,
      executionWorkflowDigest: review.executionWorkflowDigest,
      terminalSequence: review.terminalSequence,
      reportDigest: review.reportDigest,
      evidenceDigest: review.evidenceDigest,
    },
  });
}

async function publishCandidate(controller: ClaimedIssueController): Promise<void> {
  const candidateHead = requiredCandidateHead(controller.state);
  const priorPublication = controller.state.publication;
  const push = await runExternalEffect(controller, {
    kind: "push",
    commandId: controller.commandId,
    candidateHead,
    expectedRemoteHead: priorPublication?.candidateHead ?? null,
  });
  if (push === undefined) return;
  let pullRequestNumber = priorPublication?.pullRequestNumber;
  let pullRequestNodeId = priorPublication?.pullRequestNodeId;
  if (priorPublication === undefined) {
    const draft = await runExternalEffect(controller, {
      kind: "pull_request",
      commandId: controller.commandId,
      candidateHead,
    });
    if (draft === undefined) return;
    if (draft.result.kind !== "pull_request") impossibleEffect(draft.result, "pull_request");
    pullRequestNumber = draft.result.pullRequestNumber;
    pullRequestNodeId = draft.result.pullRequestNodeId;
  }
  if (pullRequestNumber === undefined || pullRequestNodeId === undefined) {
    throw new IssueControllerError("publication_missing", "draft pull request identity is missing");
  }
  const ready = await runExternalEffect(controller, {
    kind: "pull_request_ready",
    commandId: controller.commandId,
    candidateHead,
    pullRequestNumber,
    pullRequestNodeId,
  });
  if (ready === undefined) return;
  if (ready.result.kind !== "pull_request_ready") {
    impossibleEffect(ready.result, "pull_request_ready");
  }
  await controller.append({
    type: "phase_transitioned",
    from: "publishing",
    to: "waiting_for_ci",
    receipt: {
      kind: "publication",
      candidateHead,
      branch: controller.manifest.branch.name,
      baseBranch: controller.manifest.base.branch,
      pullRequestNumber,
      pullRequestNodeId,
      evidenceDigest: ready.observationDigest,
    },
  });
}

interface AppliedExternalEffect {
  readonly result: IssueExternalEffectResult;
  readonly observationDigest: string;
}

export async function runExternalEffect(
  controller: ClaimedIssueController,
  preparation: IssueExternalEffectPreparation,
): Promise<AppliedExternalEffect | undefined> {
  const descriptor = parseIssueExternalEffectDescriptor(
    await controller.dependencies.effects.describe(preparation, controller.manifest),
  );
  validateEffectDescriptor(controller, preparation, descriptor);
  const operationDigest = calculateIssueExternalEffectOperationDigest(descriptor);
  const effectId = deriveIssueExternalEffectId(descriptor.kind, operationDigest);
  await controller.append({
    type: "external_effect_prepared",
    effectId,
    effectKind: descriptor.kind,
    operationDigest,
  });
  return await reconcileAndMaybeExecute(controller, descriptor);
}

export async function recoverPendingEffect(controller: ClaimedIssueController): Promise<boolean> {
  const pending = controller.state.pendingEffect;
  if (pending === undefined) {
    throw new IssueControllerError(
      "recovery_descriptor_missing",
      "uncertain state has no pending effect",
    );
  }
  const descriptor = parseIssueExternalEffectDescriptor(
    await controller.dependencies.effects.recover(controller.manifest, controller.state, pending),
  );
  if (
    descriptor.kind !== pending.effectKind ||
    calculateIssueExternalEffectOperationDigest(descriptor) !== pending.operationDigest ||
    deriveIssueExternalEffectId(descriptor.kind, pending.operationDigest) !== pending.effectId
  ) {
    throw new IssueControllerError(
      "recovery_descriptor_mismatch",
      "recovered effect descriptor does not match the append-only prepared event",
    );
  }
  const observation = await controller.dependencies.effects.reconcile(
    descriptor,
    controller.operation(),
  );
  if (observation.status === "uncertain") return false;
  try {
    await settleExternalEffect(controller, pending.effectId, observation, descriptor);
  } catch {
    return false;
  }
  return true;
}

async function reconcileAndMaybeExecute(
  controller: ClaimedIssueController,
  descriptor: IssueExternalEffectDescriptor,
): Promise<AppliedExternalEffect | undefined> {
  let observation = await safelyReconcile(controller, descriptor);
  if (observation.status === "not_applied") {
    try {
      await controller.dependencies.effects.execute(descriptor, controller.operation());
    } catch (error) {
      observation = await safelyReconcile(controller, descriptor, error);
    }
    if (observation.status === "not_applied") {
      observation = await safelyReconcile(controller, descriptor);
    }
  }
  if (observation.status === "uncertain" || observation.status === "not_applied") {
    await controller.append({
      type: "external_state_uncertain",
      effectId: controller.state.pendingEffect?.effectId,
      code: observation.status === "uncertain" ? observation.code : "effect_not_observed",
      evidenceDigest:
        observation.status === "uncertain"
          ? observation.evidenceDigest
          : evidenceDigest("external-effect-not-observed", descriptor),
    });
    return undefined;
  }
  try {
    await settleExternalEffect(
      controller,
      controller.state.pendingEffect?.effectId ?? "missing-effect",
      observation,
      descriptor,
    );
  } catch (error) {
    await controller.append({
      type: "external_state_uncertain",
      effectId: controller.state.pendingEffect?.effectId,
      code: "effect_observation_invalid",
      evidenceDigest: evidenceDigest("external-effect-invalid-observation", {
        descriptor,
        error: boundedError(error),
      }),
    });
    return undefined;
  }
  return { result: observation.result, observationDigest: observation.observationDigest };
}

async function safelyReconcile(
  controller: ClaimedIssueController,
  descriptor: IssueExternalEffectDescriptor,
  priorError?: unknown,
) {
  try {
    return await controller.dependencies.effects.reconcile(descriptor, controller.operation());
  } catch (error) {
    return {
      status: "uncertain" as const,
      code: "effect_reconciliation_failed",
      evidenceDigest: evidenceDigest("external-effect-error", {
        descriptor,
        priorError: boundedError(priorError),
        reconciliationError: boundedError(error),
      }),
    };
  }
}

async function settleExternalEffect(
  controller: ClaimedIssueController,
  effectId: string,
  observation:
    | { readonly status: "not_applied"; readonly observationDigest: string }
    | {
        readonly status: "applied";
        readonly observationDigest: string;
        readonly result: IssueExternalEffectResult;
      },
  descriptor: IssueExternalEffectDescriptor,
): Promise<void> {
  if (observation.status === "applied") {
    validateEffectResult(descriptor, observation.result);
  }
  await controller.append({
    type: "external_effect_settled",
    effectId,
    outcome: observation.status === "applied" ? "applied" : "not_applied",
    observationDigest: observation.observationDigest,
    ...(observation.status === "applied" ? { result: observation.result } : {}),
  });
}

function validateEffectResult(
  descriptor: IssueExternalEffectDescriptor,
  result: IssueExternalEffectResult,
): void {
  if (descriptor.kind !== result.kind) effectResultMismatch(descriptor.kind);
  switch (descriptor.kind) {
    case "workspace":
    case "commit":
      return;
    case "push":
      if (
        result.kind !== "push" ||
        result.candidateHead !== descriptor.candidateHead ||
        result.branch !== descriptor.branch
      )
        effectResultMismatch(descriptor.kind);
      return;
    case "pull_request":
      if (
        result.kind !== "pull_request" ||
        result.repositoryIdentity !== descriptor.repositoryIdentity ||
        result.candidateHead !== descriptor.headCommit ||
        result.headBranch !== descriptor.headBranch ||
        result.baseBranch !== descriptor.baseBranch ||
        !result.isDraft
      )
        effectResultMismatch(descriptor.kind);
      return;
    case "pull_request_ready":
      if (
        result.kind !== "pull_request_ready" ||
        result.repositoryIdentity !== descriptor.repositoryIdentity ||
        result.candidateHead !== descriptor.headCommit ||
        result.headBranch !== descriptor.headBranch ||
        result.baseBranch !== descriptor.baseBranch ||
        result.pullRequestNumber !== descriptor.pullRequestNumber ||
        result.pullRequestNodeId !== descriptor.pullRequestNodeId ||
        result.isDraft
      )
        effectResultMismatch(descriptor.kind);
      return;
    case "merge":
      if (
        result.kind !== "merge" ||
        result.candidateHead !== descriptor.candidateHead ||
        result.gateDigest !== descriptor.gateDigest ||
        result.deleteBranchRequested !== descriptor.deleteBranch ||
        (descriptor.deleteBranch && !result.branchDeleted)
      )
        effectResultMismatch(descriptor.kind);
  }
}

function validateEffectDescriptor(
  controller: ClaimedIssueController,
  preparation: IssueExternalEffectPreparation,
  descriptor: IssueExternalEffectDescriptor,
): void {
  const manifest = controller.manifest;
  if (
    descriptor.kind !== preparation.kind ||
    descriptor.runId !== manifest.runId ||
    descriptor.commandId !== preparation.commandId ||
    descriptor.repositoryIdentity !== manifest.repository.identity ||
    descriptor.frozenContractDigest !== controller.frozenContractDigest
  ) {
    throw new IssueControllerError(
      "effect_descriptor_mismatch",
      "external effect descriptor does not bind the command and frozen run identity",
    );
  }
  switch (descriptor.kind) {
    case "workspace":
      if (
        descriptor.baseBranch !== manifest.base.branch ||
        descriptor.baseCommit !== manifest.base.commit ||
        descriptor.branch !== manifest.branch.name
      )
        effectMismatch(descriptor.kind);
      return;
    case "commit":
      if (
        preparation.kind !== "commit" ||
        descriptor.branch !== manifest.branch.name ||
        descriptor.workspaceIdentityDigest !== preparation.workspaceIdentityDigest ||
        descriptor.parentCommit !== preparation.parentCommit ||
        descriptor.candidateTreeDigest !== preparation.candidateTreeDigest ||
        descriptor.messageDigest !== preparation.messageDigest
      )
        effectMismatch(descriptor.kind);
      return;
    case "push":
      if (
        preparation.kind !== "push" ||
        descriptor.branch !== manifest.branch.name ||
        descriptor.candidateHead !== preparation.candidateHead ||
        descriptor.expectedRemoteHead !== preparation.expectedRemoteHead
      )
        effectMismatch(descriptor.kind);
      return;
    case "pull_request":
      if (
        preparation.kind !== "pull_request" ||
        descriptor.issueNumber !== manifest.issue.number ||
        descriptor.issueNodeId !== manifest.issue.nodeId ||
        descriptor.headBranch !== manifest.branch.name ||
        descriptor.headCommit !== preparation.candidateHead ||
        descriptor.baseBranch !== manifest.base.branch ||
        descriptor.baseCommit !== manifest.base.commit ||
        !descriptor.isDraft
      )
        effectMismatch(descriptor.kind);
      return;
    case "pull_request_ready":
      if (
        preparation.kind !== "pull_request_ready" ||
        descriptor.pullRequestNumber !== preparation.pullRequestNumber ||
        descriptor.pullRequestNodeId !== preparation.pullRequestNodeId ||
        descriptor.headBranch !== manifest.branch.name ||
        descriptor.headCommit !== preparation.candidateHead ||
        descriptor.baseBranch !== manifest.base.branch ||
        descriptor.baseCommit !== manifest.base.commit ||
        descriptor.isDraft
      )
        effectMismatch(descriptor.kind);
      return;
    case "merge":
      if (
        preparation.kind !== "merge" ||
        descriptor.pullRequestNumber !== preparation.pullRequestNumber ||
        descriptor.pullRequestNodeId !== preparation.pullRequestNodeId ||
        descriptor.candidateHead !== preparation.candidateHead ||
        descriptor.baseBranch !== manifest.base.branch ||
        descriptor.baseCommit !== manifest.base.commit ||
        descriptor.gateDigest !== preparation.gateDigest ||
        descriptor.method !== manifest.merge.method ||
        descriptor.deleteBranch !== manifest.merge.deleteBranch
      )
        effectMismatch(descriptor.kind);
  }
}

function latestReceipt<Kind extends IssueLifecyclePhaseReceipt["kind"]>(
  events: readonly IssueLifecycleEvent[],
  kind: Kind,
): Extract<IssueLifecyclePhaseReceipt, { readonly kind: Kind }> {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "phase_transitioned" && event.receipt.kind === kind) {
      return event.receipt as Extract<IssueLifecyclePhaseReceipt, { readonly kind: Kind }>;
    }
  }
  throw new IssueControllerError("evidence_missing", `${kind} receipt is missing`);
}

function requiredLatestAppliedResult<Kind extends IssueExternalEffectResult["kind"]>(
  events: readonly IssueLifecycleEvent[],
  kind: Kind,
): Extract<IssueExternalEffectResult, { readonly kind: Kind }> {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === "external_effect_settled" &&
      event.outcome === "applied" &&
      event.result.kind === kind
    ) {
      return event.result as Extract<IssueExternalEffectResult, { readonly kind: Kind }>;
    }
  }
  throw new IssueControllerError("evidence_missing", `${kind} effect result is missing`);
}

export function replayIssueLifecycleState(
  manifest: FrozenIssueRunManifest,
  events: readonly IssueLifecycleEvent[],
): IssueLifecycleState {
  let state = createInitialIssueLifecycleState(manifest.runId, manifest.createdAt);
  for (const event of events) state = reduceIssueLifecycleEvent(state, event);
  assertStateMatchesManifest(state, manifest, calculateIssuePrivateManifestDigest(manifest));
  return state;
}

function assertStateMatchesManifest(
  state: IssueLifecycleState,
  manifest: FrozenIssueRunManifest,
  frozenContractDigest: string,
): void {
  if (
    state.sequence < 1 ||
    state.frozenRepositoryIdentity !== manifest.repository.identity ||
    state.frozenIssueNumber !== manifest.issue.number ||
    state.frozenIssueNodeId !== manifest.issue.nodeId ||
    state.frozenIssueUpdatedAt !== manifest.issue.updatedAt ||
    state.frozenIssueDigest !== manifest.issue.contentDigest ||
    state.frozenBaseBranch !== manifest.base.branch ||
    state.frozenBaseCommit !== manifest.base.commit ||
    state.frozenBranch !== manifest.branch.name ||
    state.frozenContractDigest !== frozenContractDigest ||
    state.frozenPlanDigest !== manifest.planDigest ||
    state.frozenBudgetDigest !== manifest.budgetDigest
  ) {
    throw new IssueControllerError(
      "frozen_state_mismatch",
      "append-only state does not match the immutable run manifest",
    );
  }
}

export function requiredCandidateHead(state: IssueLifecycleState): string {
  if (state.candidateHead === undefined) {
    throw new IssueControllerError("candidate_missing", "candidate head is missing");
  }
  return state.candidateHead;
}

export function evidenceDigest(label: string, value: unknown): string {
  const domainLabel = label.replaceAll("_", "-");
  return calculateIssueLifecycleDomainDigest(`flow.issue.controller.${domainLabel}.v1`, value);
}

export function publicStateDigest(state: PublicIssueLifecycleState): string {
  return evidenceDigest("public-state", state);
}

function monotonicTimestamp(previous: string, now: (() => Date) | undefined): string {
  const candidate = (now ?? (() => new Date()))().toISOString();
  return candidate < previous ? previous : candidate;
}

function effectMismatch(kind: string): never {
  throw new IssueControllerError(
    "effect_descriptor_mismatch",
    `${kind} descriptor does not bind the requested frozen identities`,
  );
}

function impossibleEffect(result: IssueExternalEffectResult, expected: string): never {
  throw new IssueControllerError(
    "effect_result_mismatch",
    `expected ${expected} effect result, received ${result.kind}`,
  );
}

function effectResultMismatch(kind: string): never {
  throw new IssueControllerError(
    "effect_result_mismatch",
    `${kind} observation does not bind the prepared external effect descriptor`,
  );
}

function boundedError(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048);
}
