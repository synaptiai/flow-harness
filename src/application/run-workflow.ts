import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  DURABLE_EFFECT_PROTOCOL,
  RunReplayError,
  appendRunEvent,
  nodeEffectId,
  reduceRunEvents,
  type AgentEffectReceipt,
  type AgentRecoveryRequirement,
  type FilesystemEditEffectDescriptor,
  type NodeEffectSettlementInput,
  type NodeEffectReconciledEvent,
  type NodeFailure,
  type RunEvent,
  type RunBudgetExhaustedEvent,
  type RunCancelledEvent,
  type RunFailedEvent,
  type RunResumedEvent,
  type RunStartedEvent,
  type RunState,
} from "../domain/run/events.js";
import {
  calculateCommandApprovalOperationDigest,
  commandApprovalRequestId,
  createCommandApprovalOperation,
} from "../domain/approval/command-approval.js";
import type {
  CompiledAgentNode,
  CompiledCommandNode,
  CompiledNode,
  CompiledWorkflow,
} from "../domain/workflow/types.js";
import type {
  NodeEffectJournal,
  NodeEffectReconciler,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
  RunEventStore,
} from "./ports.js";

export interface RunWorkflowOptions {
  readonly cwd: string;
  readonly protectedPaths: readonly string[];
  readonly store: RunEventStore;
  readonly executor: NodeExecutor;
  readonly runId?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface ResumeWorkflowOptions extends Omit<RunWorkflowOptions, "runId" | "store"> {
  readonly runId: string;
  readonly store: RecoverableRunEventStore;
  readonly effectReconciler?: NodeEffectReconciler;
}

export async function runWorkflow(
  workflow: CompiledWorkflow,
  options: RunWorkflowOptions,
): Promise<RunState> {
  assertNotAborted(options.signal);
  const runId = options.runId ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const executionCwd = resolve(options.cwd);
  return await releaseAfter(options.store, runId, async () => {
    const approvalRequirements = commandApprovalRequirements(workflow);
    const recoveryRequirements = agentRecoveryRequirements(workflow);
    const started: RunStartedEvent = {
      ...eventBase(workflow, runId, 1, now),
      type: "run_started",
      nodeIds: workflow.nodes.map((node) => node.id),
      workflowApiVersion: workflow.apiVersion,
      workflowDigest: calculateWorkflowDigest(workflow),
      executionCwd,
      ...(workflow.budget === undefined ? {} : { budget: workflow.budget }),
      ...(approvalRequirements.length === 0 ? {} : { approvalRequirements }),
      ...(recoveryRequirements.length === 0 ? {} : { recoveryRequirements }),
      ...(workflow.goal === undefined ? {} : { goal: workflow.goal }),
    };
    await options.store.append(started);
    return await continueWorkflow(
      workflow,
      { ...options, cwd: executionCwd },
      runId,
      appendRunEvent(undefined, started),
      now,
    );
  });
}

export async function resumeWorkflow(
  workflow: CompiledWorkflow,
  options: ResumeWorkflowOptions,
): Promise<RunState> {
  assertNotAborted(options.signal);

  const events = await options.store.claim(options.runId);
  return await releaseAfter(options.store, options.runId, async () => {
    assertNotAborted(options.signal);
    let state = reduceRunEvents(events);
    const executionCwd = resolve(options.cwd);
    const now = options.now ?? (() => new Date());
    validateRecoveryCompatibility(workflow, options.runId, executionCwd, state, events);
    state = await reconcileOpenEffects(workflow, options, state, now);
    assertNotAborted(options.signal);
    state = await disposeProofSafeInterruptedAttempt(workflow, options, state, now);
    rejectOpenAttempt(options.runId, state);
    const resumed: RunResumedEvent = {
      ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
      type: "run_resumed",
    };
    await options.store.append(resumed);
    state = appendRunEvent(state, resumed);
    return await continueWorkflow(
      workflow,
      { ...options, cwd: executionCwd },
      options.runId,
      state,
      now,
    );
  });
}

async function continueWorkflow(
  workflow: CompiledWorkflow,
  options: Omit<RunWorkflowOptions, "runId">,
  runId: string,
  initialState: RunState,
  now: () => Date,
): Promise<RunState> {
  let state = initialState;
  let publicationTail = Promise.resolve();
  let publicationPoisoned = false;
  let publicationFailure: unknown;

  async function record(event: RunEvent): Promise<void> {
    await publish(async () => {
      await append(event);
    });
  }

  async function append(event: RunEvent): Promise<void> {
    const nextState = appendRunEvent(state, event);
    await options.store.append(event);
    state = nextState;
  }

  function publish<T>(operation: () => Promise<T>): Promise<T> {
    const publication = publicationTail.then(async () => {
      if (publicationPoisoned) {
        throw publicationFailure;
      }
      try {
        return await operation();
      } catch (error) {
        publicationPoisoned = true;
        publicationFailure = error;
        throw error;
      }
    });
    publicationTail = publication.then(
      () => undefined,
      () => undefined,
    );
    return publication;
  }

  function nextSequence(): number {
    return state.lastSequence + 1;
  }

  function base(sequence: number, at?: Date) {
    return eventBase(workflow, runId, sequence, now, at);
  }

  const completed = new Set(
    Object.entries(state.nodes)
      .filter(([, node]) => node.status === "succeeded")
      .map(([nodeId]) => nodeId),
  );
  const failed = Object.entries(state.nodes).find(([, node]) => node.status === "failed");
  if (failed !== undefined) {
    const [failedNodeId, failedNode] = failed;
    if (failedNode.error === null) {
      throw new Error(`Failed node "${failedNodeId}" has no committed error`);
    }
    if (hasSettlementExhaustion(state)) {
      return await exhaustRun();
    }
    await record({
      ...base(nextSequence()),
      type: "run_failed",
      failedNodeId,
      reason: failedNode.error.message,
    });
    return state;
  }

  while (completed.size < workflow.nodes.length) {
    if ((state.budget?.exhausted.length ?? 0) > 0) {
      return await exhaustRun();
    }
    if (isAborted(options.signal)) {
      return await cancelRun();
    }
    const node = selectReadyNode(workflow.nodes, completed);
    if (node === undefined) {
      throw new Error("Compiled workflow has no ready node; compiler invariant was violated");
    }

    const executionNode = boundNodeTimeout(node, state);
    const attempt = (state.nodes[node.id]?.attempt ?? 0) + 1;
    let approval: { readonly requestId: string; readonly operationDigest: string } | undefined;
    if (node.type === "command" && node.approval !== undefined) {
      if (executionNode.type !== "command") {
        throw new Error("bounded command node changed type");
      }
      const operation = createCommandApprovalOperation(executionNode, options.cwd);
      const operationDigest = calculateCommandApprovalOperationDigest(operation);
      const currentApproval = state.nodes[node.id]?.approval ?? null;

      if (currentApproval === null || currentApproval.status === "expired") {
        const sequence = nextSequence();
        await record({
          ...base(sequence),
          type: "command_approval_requested",
          nodeId: node.id,
          attempt,
          requestId: commandApprovalRequestId(sequence),
          grantTtlMs: node.approval.grantTtlMs,
          operation,
          operationDigest,
        });
        return state;
      }
      if (
        currentApproval.operationDigest !== operationDigest ||
        calculateCommandApprovalOperationDigest(currentApproval.operation) !== operationDigest
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" approval operation no longer matches command node "${node.id}"`,
        );
      }
      if (currentApproval.status === "pending") {
        return state;
      }
      if (currentApproval.status !== "granted") {
        throw new Error(
          `approval invariant was violated for node "${node.id}" with status "${currentApproval.status}"`,
        );
      }

      const startTime = now();
      if (
        currentApproval.expiresAt === null ||
        startTime.getTime() >= Date.parse(currentApproval.expiresAt)
      ) {
        await record({
          ...base(nextSequence(), startTime),
          type: "command_approval_expired",
          nodeId: node.id,
          attempt,
          requestId: currentApproval.requestId,
          operationDigest,
        });
        continue;
      }
      approval = {
        requestId: currentApproval.requestId,
        operationDigest,
      };
      await record({
        ...base(nextSequence(), startTime),
        type: "node_started",
        nodeId: node.id,
        attempt,
        approval,
      });
    } else {
      await record({
        ...base(nextSequence()),
        type: "node_started",
        nodeId: node.id,
        attempt,
        ...(supportsDurableEffects(node) ? { effectProtocol: DURABLE_EFFECT_PROTOCOL } : {}),
      });
    }

    const effectJournal = supportsDurableEffects(node)
      ? createEffectJournal(node.id, attempt)
      : undefined;

    const abortedBeforeExecution = isAborted(options.signal);
    const outcome = abortedBeforeExecution
      ? abortedOutcome(options.signal)
      : await executeNode(executionNode, options.executor, {
          runId,
          workflowId: workflow.id,
          attempt,
          cwd: options.cwd,
          protectedPaths: options.protectedPaths,
          ...(effectJournal === undefined ? {} : { effectJournal }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    await publicationTail;
    const abortAfterSuccessfulExecution =
      isAborted(options.signal) && outcome.status === "succeeded";
    const interruptedOutcome = abortAfterSuccessfulExecution
      ? abortedOutcome(options.signal, outcome.evidence)
      : outcome;
    const retrySafeOutcome =
      effectJournal === undefined
        ? interruptedOutcome
        : normalizeUnknownEffectRetryability(node.id, interruptedOutcome);
    const authoritativeOutcome =
      effectJournal === undefined || (!abortedBeforeExecution && !abortAfterSuccessfulExecution)
        ? retrySafeOutcome
        : normalizeWorkflowAbortEffectStatus(node.id, retrySafeOutcome);

    if (authoritativeOutcome.status === "failed") {
      await record({
        ...base(nextSequence()),
        type: "node_failed",
        nodeId: node.id,
        attempt,
        error: authoritativeOutcome.error,
        evidence: authoritativeOutcome.evidence,
      });
      if (hasSettlementExhaustion(state)) {
        return await exhaustRun();
      }
      if (isAborted(options.signal)) {
        return await cancelRun(node.id);
      }
      const failed: RunFailedEvent = {
        ...base(nextSequence()),
        type: "run_failed",
        failedNodeId: node.id,
        reason: authoritativeOutcome.error.message,
      };
      await record(failed);
      return state;
    }

    await record({
      ...base(nextSequence()),
      type: "node_succeeded",
      nodeId: node.id,
      attempt,
      evidence: authoritativeOutcome.evidence,
    });
    completed.add(node.id);
  }

  if (state.budget?.exhausted.some((item) => item.dimension !== "nodeStarts") === true) {
    return await exhaustRun();
  }
  if (isAborted(options.signal)) {
    return await cancelRun();
  }

  await record({
    ...base(nextSequence()),
    type: "run_succeeded",
  });
  return state;

  function createEffectJournal(nodeId: string, attempt: number): NodeEffectJournal {
    return Object.freeze({
      prepare: async (descriptor: FilesystemEditEffectDescriptor) =>
        await publish(async () => {
          const preparedDescriptor = structuredClone(descriptor);
          const sequence = nextSequence();
          const effectId = nodeEffectId(sequence);
          const effectSequence = (state.nodes[nodeId]?.effects.length ?? 0) + 1;
          await append({
            ...base(sequence),
            type: "node_effect_prepared",
            nodeId,
            attempt,
            effectId,
            effectSequence,
            descriptor: preparedDescriptor,
          });
          let settled = false;
          return Object.freeze({
            effectId,
            effectSequence,
            settle: async (settlement: NodeEffectSettlementInput) =>
              await publish(async () => {
                if (settled) {
                  throw new Error(`effect "${effectId}" is already settled`);
                }
                await append({
                  ...base(nextSequence()),
                  type: "node_effect_settled",
                  nodeId,
                  attempt,
                  effectId,
                  ...settlement,
                });
                settled = true;
                if (settlement.outcome === "not_applied") {
                  return null;
                }
                const receipt: AgentEffectReceipt = Object.freeze({
                  version: 1,
                  sequence: effectSequence,
                  runId,
                  workflowId: workflow.id,
                  nodeId,
                  attempt,
                  kind: preparedDescriptor.kind,
                  target: preparedDescriptor.target,
                  operationDigest: preparedDescriptor.operationDigest,
                  beforeSha256: preparedDescriptor.beforeSha256,
                  afterSha256: preparedDescriptor.afterSha256,
                  outcome: settlement.outcome === "committed" ? "committed" : "uncertain",
                });
                return receipt;
              }),
          });
        }),
    });
  }

  function normalizeWorkflowAbortEffectStatus(
    nodeId: string,
    outcome: NodeExecutionOutcome,
  ): NodeExecutionOutcome {
    if (outcome.status === "succeeded") {
      return outcome;
    }
    const effects = state.nodes[nodeId]?.effects ?? [];
    if (effects.some((effect) => effect.settlement === null)) {
      return outcome;
    }
    const sideEffectStatus = effects.some((effect) => effect.settlement?.outcome === "unknown")
      ? "uncertain"
      : effects.some((effect) => effect.settlement?.outcome === "committed")
        ? "committed"
        : "none";
    return Object.freeze({
      ...outcome,
      error: Object.freeze({ ...outcome.error, sideEffectStatus }),
    });
  }

  function normalizeUnknownEffectRetryability(
    nodeId: string,
    outcome: NodeExecutionOutcome,
  ): NodeExecutionOutcome {
    if (
      outcome.status === "succeeded" ||
      !outcome.error.retryable ||
      !state.nodes[nodeId]?.effects.some((effect) => effect.settlement?.outcome === "unknown")
    ) {
      return outcome;
    }
    return Object.freeze({
      ...outcome,
      error: Object.freeze({ ...outcome.error, retryable: false }),
    });
  }

  async function cancelRun(cancelledNodeId?: string): Promise<RunState> {
    const attribution = cancellationAttribution(options.signal);
    const cancelled: RunCancelledEvent = {
      ...base(nextSequence()),
      type: "run_cancelled",
      reason: abortReason(options.signal),
      ...(cancelledNodeId === undefined ? {} : { cancelledNodeId }),
      ...(attribution === undefined ? {} : attribution),
    };
    await record(cancelled);
    return state;
  }

  async function exhaustRun(): Promise<RunState> {
    const exhausted = state.budget?.exhausted;
    if (exhausted === undefined || exhausted.length === 0) {
      throw new Error("budget exhaustion invariant was violated");
    }
    const event: RunBudgetExhaustedEvent = {
      ...base(nextSequence()),
      type: "run_budget_exhausted",
      exhausted,
    };
    await record(event);
    return state;
  }
}

function supportsDurableEffects(node: CompiledNode): node is CompiledAgentNode {
  return node.type === "agent" && node.agent.tools.includes("edit");
}

export const RUN_RECOVERY_ERROR_CODES = [
  "execution_context_mismatch",
  "reconciliation_incomplete",
  "reconciliation_unavailable",
  "recovery_retry_ineligible",
  "terminal_run",
  "uncertain_operation",
  "workflow_mismatch",
] as const;

export type RunRecoveryErrorCode = (typeof RUN_RECOVERY_ERROR_CODES)[number];

export class RunRecoveryError extends Error {
  override readonly name = "RunRecoveryError";

  constructor(
    readonly code: RunRecoveryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class RunWorkflowAbortedError extends Error {
  override readonly name = "RunWorkflowAbortedError";
}

export class RunCancellation extends Error {
  override readonly name = "RunCancellation";

  constructor(
    message: string,
    readonly actor: string,
    readonly requestId: string,
  ) {
    super(boundedFailureMessage(message));
    if (!isValidCancellationActor(actor)) {
      throw new RangeError(
        "cancellation actor must be 1-128 characters without control characters",
      );
    }
    if (!UUID_PATTERN.test(requestId)) {
      throw new RangeError("cancellation request id must be a UUID");
    }
  }
}

function validateRecoveryCompatibility(
  workflow: CompiledWorkflow,
  runId: string,
  executionCwd: string,
  state: RunState,
  events: readonly RunEvent[],
): void {
  if (state.status !== "running" && state.status !== "waiting_for_approval") {
    throw new RunRecoveryError(
      "terminal_run",
      `run "${runId}" is already terminal with status "${state.status}"`,
    );
  }

  if (state.executionCwd !== null && state.executionCwd !== executionCwd) {
    throw new RunRecoveryError(
      "execution_context_mismatch",
      `run "${runId}" was started in "${state.executionCwd}" and cannot resume in "${executionCwd}"`,
    );
  }

  const expectedNodeIds = workflow.nodes.map((node) => node.id);
  const recoveredNodeIds = Object.keys(state.nodes);
  if (
    state.runId !== runId ||
    state.workflowId !== workflow.id ||
    state.workflowApiVersion !== workflow.apiVersion ||
    state.workflowDigest !== calculateWorkflowDigest(workflow) ||
    !sameStrings(recoveredNodeIds, expectedNodeIds)
  ) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" was not started from this exact compiled workflow`,
    );
  }

  const expectedApprovalRequirements = commandApprovalRequirements(workflow);
  const recoveredApprovalRequirements = Object.entries(state.approvalRequirements).map(
    ([nodeId, requirement]) => ({ nodeId, grantTtlMs: requirement.grantTtlMs }),
  );
  if (!sameApprovalRequirements(recoveredApprovalRequirements, expectedApprovalRequirements)) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" approval requirements do not match the compiled workflow`,
    );
  }

  const expectedRecoveryRequirements = agentRecoveryRequirements(workflow);
  const recoveredRecoveryRequirements = Object.entries(state.recoveryRequirements).map(
    ([nodeId, requirement]) => ({ nodeId, ...requirement }),
  );
  if (!sameRecoveryRequirements(recoveredRecoveryRequirements, expectedRecoveryRequirements)) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" recovery requirements do not match the compiled workflow`,
    );
  }

  if (!sameRunBudget(state.budget?.limits, workflow.budget)) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" budget does not match the compiled workflow`,
    );
  }

  const workflowNodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (nodeState.approval === null) {
      continue;
    }
    const node = workflowNodeById.get(nodeId);
    if (node?.type !== "command" || node.approval === undefined) {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${runId}" has approval state for non-approved node "${nodeId}"`,
      );
    }
  }

  validateRecoveredHistory(workflow, runId, events);
}

async function reconcileOpenEffects(
  workflow: CompiledWorkflow,
  options: ResumeWorkflowOptions,
  initialState: RunState,
  now: () => Date,
): Promise<RunState> {
  let state = initialState;
  const openAttempt = Object.entries(state.nodes).find(([, node]) => node.status === "running");
  if (openAttempt === undefined) {
    return state;
  }
  const [nodeId, node] = openAttempt;
  const openEffects = node.effects.filter(
    (effect) => effect.settlement === null && effect.reconciliation === null,
  );
  if (openEffects.length === 0) {
    return state;
  }
  const reconciler = options.effectReconciler;
  if (reconciler === undefined) {
    throw new RunRecoveryError(
      "reconciliation_unavailable",
      `run "${options.runId}" cannot inspect open durable effects because no effect reconciler is configured`,
    );
  }

  for (const effect of openEffects) {
    let publicationStarted = false;
    let published = false;
    await reconciler.reconcile(
      effect.descriptor,
      async (observation) => {
        if (publicationStarted) {
          throw new RunRecoveryError(
            "reconciliation_incomplete",
            `effect reconciler published more than one observation for "${effect.effectId}"`,
          );
        }
        publicationStarted = true;
        const event: NodeEffectReconciledEvent = {
          ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
          type: "node_effect_reconciled",
          nodeId,
          attempt: node.attempt,
          effectId: effect.effectId,
          ...observation,
        };
        const nextState = appendRunEvent(state, event);
        await options.store.append(event);
        state = nextState;
        published = true;
      },
      options.signal,
    );
    if (!published) {
      throw new RunRecoveryError(
        "reconciliation_incomplete",
        `effect reconciler returned without publishing an observation for "${effect.effectId}"`,
      );
    }
  }
  return state;
}

async function disposeProofSafeInterruptedAttempt(
  workflow: CompiledWorkflow,
  options: ResumeWorkflowOptions,
  state: RunState,
  now: () => Date,
): Promise<RunState> {
  const openAttempt = Object.entries(state.nodes).find(([, node]) => node.status === "running");
  if (openAttempt === undefined) {
    return state;
  }
  const [nodeId, node] = openAttempt;
  if (state.recoveryRequirements[nodeId] === undefined) {
    return state;
  }

  const event: RunEvent = {
    ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
    type: "node_attempt_interrupted",
    nodeId,
    attempt: node.attempt,
    reason: "process_interrupted",
    disposition: "fresh_retry",
    resourceAccounting: "incomplete",
  };
  let nextState: RunState;
  try {
    nextState = appendRunEvent(state, event);
  } catch (error) {
    if (!(error instanceof RunReplayError)) {
      throw error;
    }
    throw new RunRecoveryError(
      "recovery_retry_ineligible",
      `run "${options.runId}" cannot fresh-retry node "${nodeId}" attempt ${node.attempt}: ${error.message}`,
    );
  }
  await options.store.append(event);
  return nextState;
}

function rejectOpenAttempt(runId: string, state: RunState): void {
  const openAttempt = Object.entries(state.nodes).find(([, node]) => node.status === "running");
  if (openAttempt === undefined) {
    return;
  }
  const [nodeId, node] = openAttempt;
  throw new RunRecoveryError(
    "uncertain_operation",
    `run "${runId}" cannot resume because node "${nodeId}" attempt ${node.attempt} has no committed outcome`,
  );
}

function validateRecoveredHistory(
  workflow: CompiledWorkflow,
  runId: string,
  events: readonly RunEvent[],
): void {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const completed = new Set<string>();
  let replayState: RunState | undefined;
  let interruptionRequiresResume = false;

  for (const event of events) {
    if (interruptionRequiresResume && event.type !== "run_resumed") {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${runId}" contains recovery history that skipped the required resume marker`,
      );
    }
    if (event.type === "run_resumed") {
      interruptionRequiresResume = false;
    }
    if (event.type === "command_approval_requested") {
      const node = nodeById.get(event.nodeId);
      const expectedReadyNode = selectReadyNode(workflow.nodes, completed);
      const expectedAttempt = replayState?.nodes[event.nodeId]?.attempt;
      if (
        node?.type !== "command" ||
        expectedReadyNode?.id !== event.nodeId ||
        node.approval === undefined ||
        expectedAttempt === undefined ||
        event.attempt !== expectedAttempt + 1 ||
        !node.dependsOn.every((dependency) => completed.has(dependency))
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains approval history that violates the compiled workflow graph`,
        );
      }
      if (replayState === undefined) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" approval history has no starting state`,
        );
      }
      if (replayState.executionCwd === null) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" approval history has no persisted execution working directory`,
        );
      }
      const executionNode = boundNodeTimeout(node, replayState);
      const expectedOperation = createCommandApprovalOperation(
        executionNode,
        replayState.executionCwd,
      );
      const expectedDigest = calculateCommandApprovalOperationDigest(expectedOperation);
      if (
        event.operationDigest !== expectedDigest ||
        calculateCommandApprovalOperationDigest(event.operation) !== expectedDigest
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" approval operation does not match command node "${event.nodeId}"`,
        );
      }
    } else if (event.type === "node_started") {
      const node = nodeById.get(event.nodeId);
      const expectedReadyNode = selectReadyNode(workflow.nodes, completed);
      const expectedAttempt = replayState?.nodes[event.nodeId]?.attempt;
      if (
        node === undefined ||
        expectedReadyNode?.id !== event.nodeId ||
        expectedAttempt === undefined ||
        event.attempt !== expectedAttempt + 1 ||
        (event.effectProtocol !== undefined && !supportsDurableEffects(node)) ||
        !node.dependsOn.every((dependency) => completed.has(dependency))
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains node history that violates the compiled workflow graph`,
        );
      }
    } else if (event.type === "node_attempt_interrupted") {
      const node = nodeById.get(event.nodeId);
      if (
        node?.type !== "agent" ||
        node.agent.recovery === undefined ||
        !node.dependsOn.every((dependency) => completed.has(dependency))
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains recovery history that violates the compiled workflow graph`,
        );
      }
      interruptionRequiresResume = true;
    } else if (event.type === "node_succeeded") {
      completed.add(event.nodeId);
    }
    replayState = appendRunEvent(replayState, event);
  }
}

function eventBase(
  workflow: CompiledWorkflow,
  runId: string,
  sequence: number,
  now: () => Date,
  at = now(),
) {
  return {
    version: 1 as const,
    sequence,
    at: at.toISOString(),
    runId,
    workflowId: workflow.id,
  };
}

function commandApprovalRequirements(workflow: CompiledWorkflow) {
  return Object.freeze(
    workflow.nodes.flatMap((node) =>
      node.type === "command" && node.approval !== undefined
        ? [Object.freeze({ nodeId: node.id, grantTtlMs: node.approval.grantTtlMs })]
        : [],
    ),
  );
}

function agentRecoveryRequirements(
  workflow: CompiledWorkflow,
): readonly AgentRecoveryRequirement[] {
  return Object.freeze(
    workflow.nodes.flatMap((node) => {
      if (node.type !== "agent" || node.agent.recovery === undefined) {
        return [];
      }
      const requirement: AgentRecoveryRequirement = Object.freeze({
        nodeId: node.id,
        mode: node.agent.recovery.mode,
        maxAttempts: node.agent.recovery.maxAttempts,
        effectProtocol: supportsDurableEffects(node) ? DURABLE_EFFECT_PROTOCOL : "none",
      });
      return [requirement];
    }),
  );
}

function sameApprovalRequirements(
  left: readonly { readonly nodeId: string; readonly grantTtlMs: number }[],
  right: readonly { readonly nodeId: string; readonly grantTtlMs: number }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (requirement, index) =>
        requirement.nodeId === right[index]?.nodeId &&
        requirement.grantTtlMs === right[index]?.grantTtlMs,
    )
  );
}

function sameRecoveryRequirements(
  left: readonly AgentRecoveryRequirement[],
  right: readonly AgentRecoveryRequirement[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (requirement, index) =>
        requirement.nodeId === right[index]?.nodeId &&
        requirement.mode === right[index]?.mode &&
        requirement.maxAttempts === right[index]?.maxAttempts &&
        requirement.effectProtocol === right[index]?.effectProtocol,
    )
  );
}

function sameRunBudget(
  left: CompiledWorkflow["budget"],
  right: CompiledWorkflow["budget"],
): boolean {
  return (
    left?.maxNodeStarts === right?.maxNodeStarts &&
    left?.maxModelTokens === right?.maxModelTokens &&
    left?.maxCostUsdMicros === right?.maxCostUsdMicros &&
    left?.maxExecutionMs === right?.maxExecutionMs
  );
}

function calculateWorkflowDigest(workflow: CompiledWorkflow): string {
  return createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function releaseAfter<T>(
  store: RunEventStore,
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let operationCompleted = false;
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
    operationCompleted = true;
  } catch (error) {
    operationError = error;
  }

  let releaseError: unknown;
  if (hasRelease(store)) {
    try {
      await store.release(runId);
    } catch (error) {
      releaseError = error;
    }
  }

  if (!operationCompleted) {
    if (releaseError !== undefined) {
      throw new AggregateError(
        [operationError, releaseError],
        `run "${runId}" failed and its ownership could not be released`,
      );
    }
    throw operationError;
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
  return result as T;
}

function hasRelease(
  store: RunEventStore,
): store is RunEventStore & Pick<RecoverableRunEventStore, "release"> {
  return "release" in store && typeof store.release === "function";
}

function selectReadyNode(
  nodes: readonly CompiledNode[],
  completed: ReadonlySet<string>,
): CompiledNode | undefined {
  return nodes.find(
    (node) =>
      !completed.has(node.id) && node.dependsOn.every((dependency) => completed.has(dependency)),
  );
}

function hasSettlementExhaustion(state: RunState): boolean {
  return state.budget?.exhausted.some((item) => item.dimension !== "nodeStarts") === true;
}

function boundNodeTimeout(node: CompiledCommandNode, state: RunState): CompiledCommandNode;
function boundNodeTimeout(node: CompiledAgentNode, state: RunState): CompiledAgentNode;
function boundNodeTimeout(node: CompiledNode, state: RunState): CompiledNode;
function boundNodeTimeout(node: CompiledNode, state: RunState): CompiledNode {
  const remaining = state.budget?.remaining.executionMs;
  if (remaining === undefined) {
    return node;
  }
  if (remaining <= 0) {
    throw new Error("execution budget must be available before bounding a node timeout");
  }
  if (node.type === "command") {
    if (node.command.timeoutMs <= remaining) {
      return node;
    }
    return Object.freeze({
      ...node,
      command: Object.freeze({ ...node.command, timeoutMs: remaining }),
    });
  }
  if (node.agent.timeoutMs <= remaining) {
    return node;
  }
  return Object.freeze({
    ...node,
    agent: Object.freeze({ ...node.agent, timeoutMs: remaining }),
  });
}

async function executeNode(
  node: CompiledNode,
  executor: NodeExecutor,
  context: Parameters<NodeExecutor["execute"]>[1],
): Promise<NodeExecutionOutcome> {
  try {
    return await executor.execute(node, context);
  } catch (error) {
    const message = boundedFailureMessage(error instanceof Error ? error.message : String(error));
    const failure: NodeFailure = {
      code: "executor_error",
      message,
      retryable: false,
      sideEffectStatus: "uncertain",
    };
    return { status: "failed", error: failure, evidence: null };
  }
}

function abortedOutcome(
  signal: AbortSignal | undefined,
  evidence: NodeExecutionOutcome["evidence"] = null,
): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code: "workflow_aborted",
      message: abortReason(signal),
      retryable: false,
      sideEffectStatus: "uncertain",
    },
    evidence,
  };
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message.length > 0) {
    return boundedFailureMessage(reason.message);
  }
  if (typeof reason === "string" && reason.length > 0) {
    return boundedFailureMessage(reason);
  }
  return "workflow execution was cancelled";
}

function boundedFailureMessage(message: string): string {
  return message.length <= 16_384 ? message : `${message.slice(0, 16_350)}… [truncated]`;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (isAborted(signal)) {
    throw new RunWorkflowAbortedError(abortReason(signal));
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cancellationAttribution(
  signal: AbortSignal | undefined,
): { readonly actor: string; readonly requestId: string } | undefined {
  return signal?.reason instanceof RunCancellation
    ? { actor: signal.reason.actor, requestId: signal.reason.requestId }
    : undefined;
}

function isValidCancellationActor(actor: string): boolean {
  return (
    actor.length > 0 &&
    actor.length <= 128 &&
    !Array.from(actor).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}
