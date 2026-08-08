import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  DURABLE_EFFECT_PROTOCOL,
  RunReplayError,
  appendRunEvent,
  calculateChildRunId,
  loopLimitFailureMessage,
  nodeEffectId,
  reduceRunEvents,
  type AgentEffectReceipt,
  type AgentRecoveryRequirement,
  type ChildEvidence,
  type ChildRunLink,
  type ControlGraph,
  type FilesystemEditEffectDescriptor,
  type ExecutionWorkspaceProvenance,
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
import {
  calculateWorkflowApprovalRequestDigest,
  workflowApprovalEvidenceTruncationMessage,
  workflowApprovalRequestId,
} from "../domain/approval/workflow-approval.js";
import {
  TypedResultError,
  evaluateTypedResult,
  resultSourceTruncationMessage,
} from "../domain/result/typed-result.js";
import type {
  CompiledAgentNode,
  CompiledApprovalNode,
  CompiledCommandNode,
  CompiledConditionNode,
  CompiledChildNode,
  CompiledJoinNode,
  CompiledLoopCheckNode,
  CompiledLoopNode,
  CompiledNode,
  CompiledResultNode,
  CompiledVerifierNode,
  CompiledWorkflow,
  EvidenceSourceField,
} from "../domain/workflow/types.js";
import {
  projectCompiledControlGraph,
  workflowRequiresControlGraph,
} from "../domain/workflow/control-graph.js";
import { calculateWorkflowDigest } from "../domain/workflow/digest.js";
import type {
  IsolatedWorkspace,
  NodeEffectJournal,
  NodeEffectReconciler,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
  RunEventStore,
  VerifierSourceInput,
  WorkspaceIsolator,
} from "./ports.js";

export interface RunWorkflowOptions {
  readonly cwd: string;
  readonly protectedPaths: readonly string[];
  readonly store: RunEventStore;
  readonly executor: NodeExecutor;
  readonly workspaceIsolator?: WorkspaceIsolator;
  readonly executionWorkspace?: ExecutionWorkspaceProvenance;
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
    const controlGraph = workflowControlGraph(workflow);
    const started: RunStartedEvent = {
      ...eventBase(workflow, runId, 1, now),
      type: "run_started",
      nodeIds: workflow.nodes.map((node) => node.id),
      workflowApiVersion: workflow.apiVersion,
      workflowDigest: calculateWorkflowDigest(workflow),
      executionCwd,
      ...(options.executionWorkspace === undefined
        ? {}
        : { executionWorkspace: options.executionWorkspace }),
      ...(workflow.budget === undefined ? {} : { budget: workflow.budget }),
      ...(workflow.concurrency === undefined ? {} : { concurrency: workflow.concurrency }),
      ...(approvalRequirements.length === 0 ? {} : { approvalRequirements }),
      ...(recoveryRequirements.length === 0 ? {} : { recoveryRequirements }),
      ...(controlGraph === undefined ? {} : { controlGraph }),
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
    validateRecoveryCompatibility(
      workflow,
      options.runId,
      executionCwd,
      options.executionWorkspace,
      state,
      events,
    );
    state = await reconcileOpenEffects(workflow, options, state, now);
    assertNotAborted(options.signal);
    state = await disposeProofSafeInterruptedAttempt(workflow, options, state, now);
    state = await recoverOpenChildAttempts(workflow, options, state, now);
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

  workflowLoop: while (!workflowIsTerminal(state)) {
    if ((state.budget?.exhausted.length ?? 0) > 0) {
      return await exhaustRun();
    }
    if (isAborted(options.signal)) {
      return await cancelRun();
    }
    const admitted: Array<{
      readonly node: ExecutableNode;
      readonly executionNode: ExecutableNode;
      readonly attempt: number;
      readonly effectJournal?: NodeEffectJournal;
      readonly verifierSources?: readonly VerifierSourceInput[];
      readonly preflightOutcome?: NodeExecutionOutcome;
    }> = [];
    const childBudgetReservations = {
      nodeStarts: 0,
      modelTokens: 0,
      modelCostUsdMicros: 0,
      executionMs: 0,
    };

    while (admitted.length < state.concurrency.maxNodes) {
      const transition = selectNextTransition(workflow.nodes, state);
      if (transition === undefined) {
        if (admitted.length === 0) {
          throw new Error("Compiled workflow has no ready node; compiler invariant was violated");
        }
        break;
      }
      if (transition.kind !== "execute") {
        if (admitted.length > 0) {
          break;
        }
        if (
          transition.kind === "request_approval" &&
          state.nodes[transition.node.id]?.workflowApproval?.status === "pending"
        ) {
          return state;
        }
        const event = controlTransitionEvent(transition, state, base(nextSequence()));
        await record(event);
        if (event.type === "workflow_approval_requested") {
          return state;
        }
        if (event.type === "node_control_failed") {
          const failed: RunFailedEvent = {
            ...base(nextSequence()),
            type: "run_failed",
            failedNodeId: event.nodeId,
            reason: event.error.message,
          };
          await record(failed);
          return state;
        }
        continue workflowLoop;
      }

      const node = transition.node;
      if (admitted.length > 0 && (node.type === "child") !== (admitted[0]?.node.type === "child")) {
        break;
      }
      const executionNode = boundNodeTimeout(node, state);
      const attempt = (state.nodes[node.id]?.attempt ?? 0) + 1;
      const verifierSources = verifierExecutionSources(executionNode, state);
      const preflightOutcome =
        executionNode.type === "child"
          ? childBudgetPreflight(executionNode, state, childBudgetReservations)
          : undefined;
      let approval: { readonly requestId: string; readonly operationDigest: string } | undefined;
      let startTime: Date | undefined;
      if (node.type === "command" && node.approval !== undefined) {
        if (executionNode.type !== "command") {
          throw new Error("bounded command node changed type");
        }
        const operation = createCommandApprovalOperation(executionNode, options.cwd);
        const operationDigest = calculateCommandApprovalOperationDigest(operation);
        const currentApproval = state.nodes[node.id]?.approval ?? null;

        if (currentApproval === null || currentApproval.status === "expired") {
          if (admitted.length > 0) {
            break;
          }
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
          if (admitted.length > 0) {
            break;
          }
          return state;
        }
        if (currentApproval.status !== "granted") {
          throw new Error(
            `approval invariant was violated for node "${node.id}" with status "${currentApproval.status}"`,
          );
        }

        startTime = now();
        if (
          currentApproval.expiresAt === null ||
          startTime.getTime() >= Date.parse(currentApproval.expiresAt)
        ) {
          if (admitted.length > 0) {
            break;
          }
          await record({
            ...base(nextSequence(), startTime),
            type: "command_approval_expired",
            nodeId: node.id,
            attempt,
            requestId: currentApproval.requestId,
            operationDigest,
          });
          continue workflowLoop;
        }
        approval = {
          requestId: currentApproval.requestId,
          operationDigest,
        };
      }

      await record({
        ...base(nextSequence(), startTime),
        type: "node_started",
        nodeId: node.id,
        attempt,
        ...(node.type === "child" ? { child: createChildRunLink(runId, node, attempt) } : {}),
        ...(approval === undefined ? {} : { approval }),
        ...(supportsDurableEffects(node) ? { effectProtocol: DURABLE_EFFECT_PROTOCOL } : {}),
      });
      const effectJournal = supportsDurableEffects(node)
        ? createEffectJournal(node.id, attempt)
        : undefined;
      admitted.push({
        node,
        executionNode,
        attempt,
        ...(effectJournal === undefined ? {} : { effectJournal }),
        ...(verifierSources === undefined ? {} : { verifierSources }),
        ...(preflightOutcome === undefined ? {} : { preflightOutcome }),
      });
      if (executionNode.type === "child" && preflightOutcome === undefined) {
        reserveChildBudget(executionNode, childBudgetReservations);
      }
      if (preflightOutcome !== undefined) {
        break;
      }
      if ((state.budget?.exhausted.length ?? 0) > 0) {
        break;
      }
    }

    const settlements = await Promise.all(
      admitted.map(
        async ({ executionNode, attempt, effectJournal, verifierSources, preflightOutcome }) => {
          const abortedBeforeExecution = isAborted(options.signal);
          const outcome = abortedBeforeExecution
            ? executionNode.type === "child"
              ? childFailure("child_cancelled_before_start", abortReason(options.signal))
              : abortedOutcome(options.signal)
            : preflightOutcome !== undefined
              ? preflightOutcome
              : await executeNode(
                  executionNode,
                  options.executor,
                  {
                    runId,
                    workflowId: workflow.id,
                    attempt,
                    cwd: options.cwd,
                    protectedPaths: options.protectedPaths,
                    ...(effectJournal === undefined ? {} : { effectJournal }),
                    ...(verifierSources === undefined ? {} : { verifierSources }),
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                  },
                  options,
                  now,
                );
          return { outcome, abortedBeforeExecution };
        },
      ),
    );
    await publicationTail;

    for (const [index, admission] of admitted.entries()) {
      const settlement = settlements[index];
      if (settlement === undefined) {
        throw new Error(`node "${admission.node.id}" has no executor settlement`);
      }
      const { outcome, abortedBeforeExecution } = settlement;
      const abortAfterSuccessfulExecution =
        isAborted(options.signal) &&
        outcome.status === "succeeded" &&
        admission.node.type !== "child";
      const interruptedOutcome = abortAfterSuccessfulExecution
        ? abortedOutcome(options.signal, outcome.evidence)
        : outcome;
      const retrySafeOutcome =
        admission.effectJournal === undefined
          ? interruptedOutcome
          : normalizeUnknownEffectRetryability(admission.node.id, interruptedOutcome);
      const authoritativeOutcome =
        admission.effectJournal === undefined ||
        (!abortedBeforeExecution && !abortAfterSuccessfulExecution)
          ? retrySafeOutcome
          : normalizeWorkflowAbortEffectStatus(admission.node.id, retrySafeOutcome);

      if (authoritativeOutcome.status === "failed") {
        await record({
          ...base(nextSequence()),
          type: "node_failed",
          nodeId: admission.node.id,
          attempt: admission.attempt,
          error: authoritativeOutcome.error,
          evidence: authoritativeOutcome.evidence,
        });
      } else {
        await record({
          ...base(nextSequence()),
          type: "node_succeeded",
          nodeId: admission.node.id,
          attempt: admission.attempt,
          evidence: authoritativeOutcome.evidence,
        });
      }
    }

    if (hasSettlementExhaustion(state) || hasPendingStartExhaustion(state)) {
      return await exhaustRun();
    }
    const failedNodeIds = Object.entries(state.nodes)
      .filter(([, node]) => node.status === "failed")
      .map(([nodeId]) => nodeId);
    if (isAborted(options.signal)) {
      return await cancelRun(failedNodeIds);
    }
    const primaryFailure = failedNodeIds[0];
    if (primaryFailure !== undefined) {
      const error = state.nodes[primaryFailure]?.error;
      if (error === null || error === undefined) {
        throw new Error(`Failed node "${primaryFailure}" has no committed error`);
      }
      await record({
        ...base(nextSequence()),
        type: "run_failed",
        failedNodeId: primaryFailure,
        reason: error.message,
      });
      return state;
    }
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

  async function cancelRun(cancelledNodeIds: readonly string[] = []): Promise<RunState> {
    const attribution = cancellationAttribution(options.signal);
    const cancelledNodeId = cancelledNodeIds.length === 1 ? cancelledNodeIds[0] : undefined;
    const cancelled: RunCancelledEvent = {
      ...base(nextSequence()),
      type: "run_cancelled",
      reason: abortReason(options.signal),
      ...(cancelledNodeId !== undefined
        ? { cancelledNodeId }
        : cancelledNodeIds.length === 0
          ? {}
          : { cancelledNodeIds }),
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

function createChildRunLink(
  parentRunId: string,
  node: CompiledChildNode,
  attempt: number,
): ChildRunLink {
  return Object.freeze({
    runId: calculateChildRunId(parentRunId, node.id, attempt),
    workflowId: node.child.workflow.id,
    workflowDigest: node.child.workflowDigest,
    resultNodeId: node.child.resultNodeId,
    resultSchemaDigest: node.child.resultSchemaDigest,
    isolationBackend: "reflink-copy-v1",
  });
}

interface ChildBudgetReservation {
  nodeStarts: number;
  modelTokens: number;
  modelCostUsdMicros: number;
  executionMs: number;
}

function childBudgetPreflight(
  node: CompiledChildNode,
  state: RunState,
  reserved: ChildBudgetReservation,
): NodeExecutionOutcome | undefined {
  const remaining = state.budget?.remaining;
  const child = node.child.workflow.budget;
  if (remaining === undefined || child === undefined) {
    return undefined;
  }
  const unavailable = [
    remaining.nodeStarts !== undefined &&
    1 + reserved.nodeStarts + requireBudgetLimit(child.maxNodeStarts) > remaining.nodeStarts
      ? "nodeStarts"
      : null,
    remaining.modelTokens !== undefined &&
    reserved.modelTokens + requireBudgetLimit(child.maxModelTokens) > remaining.modelTokens
      ? "modelTokens"
      : null,
    remaining.modelCostUsdMicros !== undefined &&
    reserved.modelCostUsdMicros + requireBudgetLimit(child.maxCostUsdMicros) >
      remaining.modelCostUsdMicros
      ? "modelCostUsdMicros"
      : null,
    remaining.executionMs !== undefined &&
    reserved.executionMs + requireBudgetLimit(child.maxExecutionMs) > remaining.executionMs
      ? "executionMs"
      : null,
  ].filter((value): value is string => value !== null);
  return unavailable.length === 0
    ? undefined
    : childFailure(
        "child_budget_unavailable",
        `child node "${node.id}" ceiling exceeds parent remaining budget for ${unavailable.join(", ")}`,
      );
}

function reserveChildBudget(node: CompiledChildNode, reserved: ChildBudgetReservation): void {
  const budget = node.child.workflow.budget;
  if (budget === undefined) {
    return;
  }
  reserved.nodeStarts = saturatingAdd(
    reserved.nodeStarts,
    requireBudgetLimit(budget.maxNodeStarts),
  );
  reserved.modelTokens = saturatingAdd(
    reserved.modelTokens,
    requireBudgetLimit(budget.maxModelTokens),
  );
  reserved.modelCostUsdMicros = saturatingAdd(
    reserved.modelCostUsdMicros,
    requireBudgetLimit(budget.maxCostUsdMicros),
  );
  reserved.executionMs = saturatingAdd(
    reserved.executionMs,
    requireBudgetLimit(budget.maxExecutionMs),
  );
}

function requireBudgetLimit(value: number | undefined): number {
  if (value === undefined) {
    throw new Error("compiled child workflow is missing a required budget limit");
  }
  return value;
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

export const RUN_RECOVERY_ERROR_CODES = [
  "child_recovery_ineligible",
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
  executionWorkspace: ExecutionWorkspaceProvenance | undefined,
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
  if (!sameExecutionWorkspace(state.executionWorkspace, executionWorkspace)) {
    throw new RunRecoveryError(
      "execution_context_mismatch",
      `run "${runId}" workspace provenance does not match its recovery context`,
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

  if (state.concurrency.maxNodes !== (workflow.concurrency?.maxNodes ?? 1)) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" concurrency does not match the compiled workflow`,
    );
  }

  if (!sameControlGraph(state.controlGraph, workflowControlGraph(workflow))) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" control graph does not match the compiled workflow`,
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
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (nodeState.workflowApproval === null) {
      continue;
    }
    if (workflowNodeById.get(nodeId)?.type !== "approval") {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${runId}" has workflow approval state for non-approval node "${nodeId}"`,
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
  const openAttempts = Object.entries(state.nodes).filter(([, node]) => node.status === "running");
  for (const [nodeId, node] of openAttempts) {
    const openEffects = node.effects.filter(
      (effect) => effect.settlement === null && effect.reconciliation === null,
    );
    if (openEffects.length === 0) {
      continue;
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
  }
  return state;
}

async function disposeProofSafeInterruptedAttempt(
  workflow: CompiledWorkflow,
  options: ResumeWorkflowOptions,
  state: RunState,
  now: () => Date,
): Promise<RunState> {
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.status !== "running" || state.recoveryRequirements[nodeId] === undefined) {
      continue;
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
    state = nextState;
  }
  return state;
}

async function recoverOpenChildAttempts(
  workflow: CompiledWorkflow,
  options: ResumeWorkflowOptions,
  initialState: RunState,
  now: () => Date,
): Promise<RunState> {
  let state = initialState;
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (nodeState.status !== "running") {
      continue;
    }
    const node = nodeById.get(nodeId);
    if (node?.type !== "child") {
      continue;
    }
    let outcome: NodeExecutionOutcome;
    try {
      outcome = await recoverChildNode(node, nodeState.attempt, options, now);
    } catch (error) {
      throw new RunRecoveryError(
        "child_recovery_ineligible",
        `run "${options.runId}" cannot recover child node "${nodeId}": ${boundedFailureMessage(error instanceof Error ? error.message : String(error))}`,
      );
    }
    if (outcome.status === "failed" && outcome.evidence === null) {
      throw new RunRecoveryError(
        "child_recovery_ineligible",
        `run "${options.runId}" cannot recover child node "${nodeId}": ${outcome.error.message}`,
      );
    }
    const event: RunEvent =
      outcome.status === "succeeded"
        ? {
            ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
            type: "node_succeeded",
            nodeId,
            attempt: nodeState.attempt,
            evidence: outcome.evidence,
          }
        : {
            ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
            type: "node_failed",
            nodeId,
            attempt: nodeState.attempt,
            error: outcome.error,
            evidence: outcome.evidence,
          };
    const nextState = appendRunEvent(state, event);
    await options.store.append(event);
    state = nextState;
  }
  return state;
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
  let replayState: RunState | undefined;
  let interruptionRequiresResume = false;

  for (const event of events) {
    if (
      interruptionRequiresResume &&
      event.type !== "run_resumed" &&
      event.type !== "node_attempt_interrupted"
    ) {
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
      const expectedTransition =
        replayState === undefined ? undefined : selectNextTransition(workflow.nodes, replayState);
      const expectedAttempt = replayState?.nodes[event.nodeId]?.attempt;
      if (
        node?.type !== "command" ||
        expectedTransition?.kind !== "execute" ||
        expectedTransition.node.id !== event.nodeId ||
        node.approval === undefined ||
        expectedAttempt === undefined ||
        event.attempt !== expectedAttempt + 1
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
    } else if (event.type === "workflow_approval_requested") {
      const expectedTransition =
        replayState === undefined ? undefined : selectNextTransition(workflow.nodes, replayState);
      if (
        expectedTransition?.kind !== "request_approval" ||
        expectedTransition.node.id !== event.nodeId
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains workflow approval history that violates the compiled workflow graph`,
        );
      }
    } else if (event.type === "node_started") {
      const node = nodeById.get(event.nodeId);
      const expectedTransition =
        replayState === undefined ? undefined : selectNextTransition(workflow.nodes, replayState);
      const expectedAttempt = replayState?.nodes[event.nodeId]?.attempt;
      if (
        node === undefined ||
        expectedTransition?.kind !== "execute" ||
        expectedTransition.node.id !== event.nodeId ||
        expectedAttempt === undefined ||
        event.attempt !== expectedAttempt + 1 ||
        (event.effectProtocol !== undefined && !supportsDurableEffects(node))
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
        replayState === undefined ||
        !node.dependsOn.every(
          (dependency) => replayState?.nodes[dependency]?.status === "succeeded",
        )
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains recovery history that violates the compiled workflow graph`,
        );
      }
      interruptionRequiresResume = true;
    } else if (
      event.type === "node_condition_evaluated" ||
      event.type === "node_result_published" ||
      event.type === "node_loop_checked" ||
      event.type === "node_loop_completed" ||
      event.type === "node_omitted" ||
      event.type === "node_joined" ||
      event.type === "node_control_failed"
    ) {
      const expectedTransition =
        replayState === undefined ? undefined : selectNextTransition(workflow.nodes, replayState);
      if (!controlEventMatchesTransition(event, expectedTransition)) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains control history that violates the compiled workflow graph`,
        );
      }
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

function workflowControlGraph(workflow: CompiledWorkflow): ControlGraph | undefined {
  if (!workflowRequiresControlGraph(workflow)) {
    return undefined;
  }
  return projectCompiledControlGraph(workflow);
}

function sameControlGraph(left: ControlGraph | null, right: ControlGraph | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right ?? null);
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameExecutionWorkspace(
  left: ExecutionWorkspaceProvenance | null,
  right: ExecutionWorkspaceProvenance | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right ?? null);
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

type ExecutableNode =
  | CompiledAgentNode
  | CompiledChildNode
  | CompiledCommandNode
  | CompiledVerifierNode;

type WorkflowTransition =
  | { readonly kind: "execute"; readonly node: ExecutableNode }
  | { readonly kind: "request_approval"; readonly node: CompiledApprovalNode }
  | { readonly kind: "evaluate_condition"; readonly node: CompiledConditionNode }
  | { readonly kind: "publish_result"; readonly node: CompiledResultNode }
  | {
      readonly kind: "omit_condition";
      readonly node:
        | CompiledAgentNode
        | CompiledCommandNode
        | CompiledVerifierNode
        | CompiledApprovalNode
        | CompiledResultNode
        | CompiledChildNode
        | CompiledConditionNode;
      readonly selectedCase: string;
    }
  | {
      readonly kind: "omit_dependency";
      readonly node: CompiledNode;
      readonly omittedDependencies: readonly string[];
    }
  | {
      readonly kind: "omit_loop";
      readonly node:
        | CompiledAgentNode
        | CompiledCommandNode
        | CompiledVerifierNode
        | CompiledApprovalNode
        | CompiledResultNode
        | CompiledChildNode
        | CompiledConditionNode;
    }
  | { readonly kind: "join"; readonly node: CompiledJoinNode }
  | { readonly kind: "evaluate_loop"; readonly node: CompiledLoopCheckNode }
  | { readonly kind: "complete_loop"; readonly node: CompiledLoopNode };

function selectNextTransition(
  nodes: readonly CompiledNode[],
  state: RunState,
): WorkflowTransition | undefined {
  for (const node of nodes) {
    const nodeState = state.nodes[node.id];
    if (nodeState?.status !== "pending") {
      continue;
    }
    const dependencyStates = node.dependsOn.map((dependency) => state.nodes[dependency]);
    if (
      dependencyStates.some(
        (dependency) => dependency?.status !== "succeeded" && dependency?.status !== "omitted",
      )
    ) {
      continue;
    }
    if (node.type === "join") {
      const decision = conditionDecision(state, node.join.conditionId);
      if (decision !== undefined) {
        return { kind: "join", node };
      }
      const omittedDependencies = node.dependsOn.filter(
        (dependency) => state.nodes[dependency]?.status === "omitted",
      );
      if (
        state.nodes[node.join.conditionId]?.status === "omitted" &&
        omittedDependencies.length > 0
      ) {
        return { kind: "omit_dependency", node, omittedDependencies };
      }
      continue;
    }
    if (node.type === "loop-check") {
      const omittedDependencies = node.dependsOn.filter(
        (dependency) => state.nodes[dependency]?.status === "omitted",
      );
      return omittedDependencies.length > 0
        ? { kind: "omit_dependency", node, omittedDependencies }
        : { kind: "evaluate_loop", node };
    }
    if (node.type === "loop") {
      if (
        node.loop.checkNodeIds.some(
          (checkNodeId) => loopCheckDecision(state, checkNodeId) === "stop",
        )
      ) {
        return { kind: "complete_loop", node };
      }
      const omittedDependencies = node.dependsOn.filter(
        (dependency) => state.nodes[dependency]?.status === "omitted",
      );
      return omittedDependencies.length > 0
        ? { kind: "omit_dependency", node, omittedDependencies }
        : { kind: "complete_loop", node };
    }
    if (node.loopGuard !== undefined) {
      const decision = loopCheckDecision(state, node.loopGuard.checkNodeId);
      if (decision === "stop") {
        return { kind: "omit_loop", node };
      }
      if (decision === undefined) {
        if (state.nodes[node.loopGuard.checkNodeId]?.status !== "omitted") {
          continue;
        }
      }
    }
    if (node.when !== undefined) {
      const decision = conditionDecision(state, node.when.conditionId);
      if (decision === undefined) {
        if (state.nodes[node.when.conditionId]?.status !== "omitted") {
          continue;
        }
      } else if (decision.selectedCase !== node.when.case) {
        return { kind: "omit_condition", node, selectedCase: decision.selectedCase };
      }
    }
    const omittedDependencies = node.dependsOn.filter(
      (dependency) => state.nodes[dependency]?.status === "omitted",
    );
    if (omittedDependencies.length > 0) {
      return { kind: "omit_dependency", node, omittedDependencies };
    }
    if (node.type === "condition") {
      return { kind: "evaluate_condition", node };
    }
    if (node.type === "approval") {
      return { kind: "request_approval", node };
    }
    if (node.type === "result") {
      return { kind: "publish_result", node };
    }
    return { kind: "execute", node };
  }
  return undefined;
}

function controlEventMatchesTransition(
  event: Extract<
    RunEvent,
    {
      readonly type:
        | "node_condition_evaluated"
        | "node_result_published"
        | "node_loop_checked"
        | "node_loop_completed"
        | "node_omitted"
        | "node_joined"
        | "node_control_failed"
        | "workflow_approval_requested";
    }
  >,
  transition: WorkflowTransition | undefined,
): boolean {
  if (event.type === "node_condition_evaluated") {
    return transition?.kind === "evaluate_condition" && transition.node.id === event.nodeId;
  }
  if (event.type === "node_result_published") {
    return transition?.kind === "publish_result" && transition.node.id === event.nodeId;
  }
  if (event.type === "workflow_approval_requested") {
    return transition?.kind === "request_approval" && transition.node.id === event.nodeId;
  }
  if (event.type === "node_loop_checked") {
    return transition?.kind === "evaluate_loop" && transition.node.id === event.nodeId;
  }
  if (event.type === "node_loop_completed") {
    return transition?.kind === "complete_loop" && transition.node.id === event.nodeId;
  }
  if (event.type === "node_control_failed") {
    return (
      (transition?.kind === "evaluate_condition" ||
        transition?.kind === "request_approval" ||
        transition?.kind === "publish_result" ||
        transition?.kind === "evaluate_loop" ||
        transition?.kind === "complete_loop") &&
      transition.node.id === event.nodeId
    );
  }
  if (event.type === "node_joined") {
    return transition?.kind === "join" && transition.node.id === event.nodeId;
  }
  return (
    (transition?.kind === "omit_condition" ||
      transition?.kind === "omit_dependency" ||
      transition?.kind === "omit_loop") &&
    transition.node.id === event.nodeId
  );
}

function controlTransitionEvent(
  transition: Exclude<WorkflowTransition, { readonly kind: "execute" }>,
  state: RunState,
  base: ReturnType<typeof eventBase>,
): RunEvent {
  if (transition.kind === "omit_loop") {
    const guard = transition.node.loopGuard;
    if (guard === undefined) {
      throw new Error(`loop omission for node "${transition.node.id}" has no loop guard`);
    }
    return {
      ...base,
      type: "node_omitted",
      nodeId: transition.node.id,
      reason: "loop_not_continued",
      loopId: guard.loopId,
      iteration: guard.iteration,
      checkNodeId: guard.checkNodeId,
    };
  }
  if (transition.kind === "omit_condition") {
    const guard = transition.node.when;
    if (guard === undefined) {
      throw new Error(`control omission for node "${transition.node.id}" has no guard`);
    }
    return {
      ...base,
      type: "node_omitted",
      nodeId: transition.node.id,
      reason: "condition_not_selected",
      conditionId: guard.conditionId,
      selectedCase: transition.selectedCase,
      expectedCase: guard.case,
    };
  }
  if (transition.kind === "omit_dependency") {
    return {
      ...base,
      type: "node_omitted",
      nodeId: transition.node.id,
      reason: "dependency_omitted",
      omittedDependencies: transition.omittedDependencies,
    };
  }
  if (transition.kind === "join") {
    const decision = conditionDecision(state, transition.node.join.conditionId);
    if (decision === undefined) {
      throw new Error(`join "${transition.node.id}" has no durable condition decision`);
    }
    const selectedBranch = transition.node.join.branches.find(
      (branch) => branch.case === decision.selectedCase,
    );
    if (selectedBranch === undefined) {
      throw new Error(`join "${transition.node.id}" has no selected branch mapping`);
    }
    return {
      ...base,
      type: "node_joined",
      nodeId: transition.node.id,
      attempt: 1,
      conditionId: transition.node.join.conditionId,
      selectedCase: decision.selectedCase,
      completedNodeId: selectedBranch.nodeId,
      omittedNodeIds: transition.node.join.branches
        .filter((branch) => branch.case !== decision.selectedCase)
        .map((branch) => branch.nodeId),
    };
  }

  if (transition.kind === "complete_loop") {
    const terminatingCheckNodeId = transition.node.loop.checkNodeIds.find(
      (checkNodeId) => loopCheckDecision(state, checkNodeId) === "stop",
    );
    if (terminatingCheckNodeId === undefined) {
      return {
        ...base,
        type: "node_control_failed",
        nodeId: transition.node.id,
        attempt: 1,
        error: {
          code: "loop_limit_reached",
          message: loopLimitFailureMessage(transition.node.id, transition.node.loop.maxIterations),
          retryable: false,
          sideEffectStatus: "none",
        },
      };
    }
    const completedIterations =
      transition.node.loop.checkNodeIds.indexOf(terminatingCheckNodeId) + 1;
    return {
      ...base,
      type: "node_loop_completed",
      nodeId: transition.node.id,
      attempt: 1,
      completedIterations,
      terminatingCheckNodeId,
    };
  }

  if (transition.kind === "request_approval") {
    const observations = transition.node.approval.evidence.map((declaration) => {
      const source = controlSource(transition.node.id, declaration, state);
      return { declaration, source };
    });
    const truncated = observations.find(({ source }) => source.truncated);
    if (truncated !== undefined) {
      return {
        ...base,
        type: "node_control_failed",
        nodeId: transition.node.id,
        attempt: 1,
        error: {
          code: "workflow_approval_evidence_truncated",
          message: workflowApprovalEvidenceTruncationMessage(
            transition.node.id,
            truncated.declaration.nodeId,
            truncated.declaration.field,
          ),
          retryable: false,
          sideEffectStatus: "none",
        },
      };
    }
    const request = {
      version: 1 as const,
      runId: state.runId,
      workflowId: state.workflowId,
      workflowDigest: state.workflowDigest,
      nodeId: transition.node.id,
      attempt: 1 as const,
      prompt: transition.node.approval.prompt,
      evidence: observations.map(({ declaration, source }) => ({
        sourceNodeId: declaration.nodeId,
        sourceAttempt: source.attempt,
        sourceField: declaration.field,
        sourceHash: source.hash,
      })),
    };
    return {
      ...base,
      type: "workflow_approval_requested",
      nodeId: transition.node.id,
      attempt: 1,
      requestId: workflowApprovalRequestId(base.sequence),
      request,
      requestDigest: calculateWorkflowApprovalRequestDigest(request),
    };
  }

  if (transition.kind === "publish_result") {
    const source = controlSource(transition.node.id, transition.node.result.source, state);
    if (source.truncated) {
      return {
        ...base,
        type: "node_control_failed",
        nodeId: transition.node.id,
        attempt: 1,
        error: {
          code: "result_source_truncated",
          message: resultSourceTruncationMessage(
            transition.node.id,
            transition.node.result.source.field,
          ),
          retryable: false,
          sideEffectStatus: "none",
        },
      };
    }
    let evaluated: ReturnType<typeof evaluateTypedResult>;
    try {
      evaluated = evaluateTypedResult(source.value, transition.node.result.schema);
    } catch (error) {
      if (!(error instanceof TypedResultError)) {
        throw error;
      }
      return {
        ...base,
        type: "node_control_failed",
        nodeId: transition.node.id,
        attempt: 1,
        error: {
          code: error.code,
          message: error.message,
          retryable: false,
          sideEffectStatus: "none",
        },
      };
    }
    return {
      ...base,
      type: "node_result_published",
      nodeId: transition.node.id,
      attempt: 1,
      sourceNodeId: transition.node.result.source.nodeId,
      sourceAttempt: source.attempt,
      sourceField: transition.node.result.source.field,
      sourceHash: source.hash,
      schemaDigest: transition.node.result.schemaDigest,
      canonicalValue: evaluated.canonicalValue,
      valueHash: evaluated.valueHash,
    };
  }

  if (transition.kind === "evaluate_loop") {
    const source = loopCheckSource(transition.node, state);
    if (source.truncated) {
      return {
        ...base,
        type: "node_control_failed",
        nodeId: transition.node.id,
        attempt: 1,
        error: {
          code: "loop_source_truncated",
          message: `loop check "${transition.node.id}" source ${transition.node.loopCheck.source.field} is truncated`,
          retryable: false,
          sideEffectStatus: "none",
        },
      };
    }
    return {
      ...base,
      type: "node_loop_checked",
      nodeId: transition.node.id,
      attempt: 1,
      loopId: transition.node.loopCheck.loopId,
      iteration: transition.node.loopCheck.iteration,
      sourceNodeId: transition.node.loopCheck.source.nodeId,
      sourceAttempt: source.attempt,
      sourceField: transition.node.loopCheck.source.field,
      sourceHash: source.hash,
      decision: source.value === transition.node.loopCheck.equals ? "stop" : "continue",
    };
  }

  const source = conditionSource(transition.node, state);
  if (source.truncated) {
    return {
      ...base,
      type: "node_control_failed",
      nodeId: transition.node.id,
      attempt: 1,
      error: {
        code: "condition_source_truncated",
        message: `condition "${transition.node.id}" source ${transition.node.condition.source.field} is truncated`,
        retryable: false,
        sideEffectStatus: "none",
      },
    };
  }
  const selectedCase =
    transition.node.condition.cases.find((item) => item.equals === source.value)?.id ??
    transition.node.condition.default;
  return {
    ...base,
    type: "node_condition_evaluated",
    nodeId: transition.node.id,
    attempt: 1,
    sourceNodeId: transition.node.condition.source.nodeId,
    sourceAttempt: source.attempt,
    sourceField: transition.node.condition.source.field,
    sourceHash: source.hash,
    selectedCase,
  };
}

function conditionDecision(
  state: RunState,
  conditionId: string,
):
  | Extract<NonNullable<RunState["nodes"][string]["control"]>, { readonly kind: "condition" }>
  | undefined {
  const control = state.nodes[conditionId]?.control;
  return control?.kind === "condition" ? control : undefined;
}

function loopCheckDecision(state: RunState, checkNodeId: string): "stop" | "continue" | undefined {
  const control = state.nodes[checkNodeId]?.control;
  return control?.kind === "loop-check" ? control.decision : undefined;
}

function conditionSource(
  node: CompiledConditionNode,
  state: RunState,
): ReturnType<typeof controlSource> {
  return controlSource(node.id, node.condition.source, state);
}

function loopCheckSource(
  node: CompiledLoopCheckNode,
  state: RunState,
): ReturnType<typeof controlSource> {
  return controlSource(node.id, node.loopCheck.source, state);
}

function controlSource(
  controlNodeId: string,
  declaration: {
    readonly nodeId: string;
    readonly field: EvidenceSourceField;
  },
  state: RunState,
): {
  readonly attempt: number;
  readonly value: string;
  readonly hash: string;
  readonly truncated: boolean;
} {
  const source = state.nodes[declaration.nodeId];
  if (source?.status !== "succeeded") {
    throw new Error(`control node "${controlNodeId}" source has no successful evidence`);
  }
  if (declaration.field === "result.value") {
    const result = typedResultSource(source);
    if (result !== null) {
      return result;
    }
    throw new Error(
      `control node "${controlNodeId}" source field is incompatible with its evidence`,
    );
  }
  if (source.evidence === null) {
    throw new Error(`control node "${controlNodeId}" source has no successful evidence`);
  }
  switch (declaration.field) {
    case "command.stdout":
      if (source.evidence.kind === "command") {
        return {
          attempt: source.attempt,
          value: source.evidence.stdout,
          hash: source.evidence.stdoutHash,
          truncated: source.evidence.stdoutTruncated,
        };
      }
      break;
    case "command.stderr":
      if (source.evidence.kind === "command") {
        return {
          attempt: source.attempt,
          value: source.evidence.stderr,
          hash: source.evidence.stderrHash,
          truncated: source.evidence.stderrTruncated,
        };
      }
      break;
    case "agent.text":
      if (source.evidence.kind === "agent") {
        return {
          attempt: source.attempt,
          value: source.evidence.text,
          hash: source.evidence.textHash,
          truncated: source.evidence.textTruncated,
        };
      }
      break;
    case "verifier.verdict":
      if (source.evidence.kind === "verifier") {
        return {
          attempt: source.attempt,
          value: source.evidence.verdict,
          hash: createHash("sha256").update(source.evidence.verdict).digest("hex"),
          truncated: false,
        };
      }
      break;
    case "verifier.reason":
      if (source.evidence.kind === "verifier") {
        return {
          attempt: source.attempt,
          value: source.evidence.reason,
          hash: source.evidence.reasonHash,
          truncated: false,
        };
      }
      break;
  }
  throw new Error(`control node "${controlNodeId}" source field is incompatible with its evidence`);
}

function verifierExecutionSources(
  node: ExecutableNode,
  state: RunState,
): readonly VerifierSourceInput[] | undefined {
  if (node.type !== "verifier" || node.verifier.kind !== "model") {
    return undefined;
  }
  return Object.freeze(
    node.verifier.evidence.map((declaration) => {
      const source = verifierSource(node.id, declaration, state);
      return Object.freeze({
        sourceNodeId: declaration.nodeId,
        sourceAttempt: source.attempt,
        sourceField: declaration.field,
        sourceHash: source.hash,
        value: source.value,
        truncated: source.truncated,
      });
    }),
  );
}

function verifierSource(
  verifierNodeId: string,
  declaration: { readonly nodeId: string; readonly field: EvidenceSourceField },
  state: RunState,
): {
  readonly attempt: number;
  readonly value: string;
  readonly hash: string;
  readonly truncated: boolean;
} {
  const source = state.nodes[declaration.nodeId];
  if (source?.status !== "succeeded") {
    throw new Error(`verifier node "${verifierNodeId}" source has no successful evidence`);
  }
  if (declaration.field === "result.value") {
    const result = typedResultSource(source);
    if (result !== null) {
      return result;
    }
    throw new Error(
      `verifier node "${verifierNodeId}" source field is incompatible with its evidence`,
    );
  }
  if (source.evidence === null) {
    throw new Error(`verifier node "${verifierNodeId}" source has no successful evidence`);
  }
  switch (declaration.field) {
    case "command.stdout":
      if (source.evidence.kind === "command") {
        return {
          attempt: source.attempt,
          value: source.evidence.stdout,
          hash: source.evidence.stdoutHash,
          truncated: source.evidence.stdoutTruncated,
        };
      }
      break;
    case "command.stderr":
      if (source.evidence.kind === "command") {
        return {
          attempt: source.attempt,
          value: source.evidence.stderr,
          hash: source.evidence.stderrHash,
          truncated: source.evidence.stderrTruncated,
        };
      }
      break;
    case "agent.text":
      if (source.evidence.kind === "agent") {
        return {
          attempt: source.attempt,
          value: source.evidence.text,
          hash: source.evidence.textHash,
          truncated: source.evidence.textTruncated,
        };
      }
      break;
    case "verifier.verdict":
      if (source.evidence.kind === "verifier") {
        return {
          attempt: source.attempt,
          value: source.evidence.verdict,
          hash: createHash("sha256").update(source.evidence.verdict).digest("hex"),
          truncated: false,
        };
      }
      break;
    case "verifier.reason":
      if (source.evidence.kind === "verifier") {
        return {
          attempt: source.attempt,
          value: source.evidence.reason,
          hash: source.evidence.reasonHash,
          truncated: false,
        };
      }
      break;
  }
  throw new Error(
    `verifier node "${verifierNodeId}" source field is incompatible with its evidence`,
  );
}

function typedResultSource(source: RunState["nodes"][string]): {
  readonly attempt: number;
  readonly value: string;
  readonly hash: string;
  readonly truncated: false;
} | null {
  if (source.control?.kind === "result") {
    return {
      attempt: source.attempt,
      value: source.control.canonicalValue,
      hash: source.control.valueHash,
      truncated: false,
    };
  }
  if (source.evidence?.kind === "child" && source.evidence.result !== null) {
    return {
      attempt: source.attempt,
      value: source.evidence.result.canonicalValue,
      hash: source.evidence.result.valueHash,
      truncated: false,
    };
  }
  return null;
}

function workflowIsTerminal(state: RunState): boolean {
  return Object.values(state.nodes).every(
    (node) => node.status === "succeeded" || node.status === "omitted",
  );
}

type TerminalRunState = RunState & {
  readonly status: "succeeded" | "failed" | "cancelled" | "resource_exhausted";
};

function runStateIsTerminal(state: RunState): state is TerminalRunState {
  return (
    state.status === "succeeded" ||
    state.status === "failed" ||
    state.status === "cancelled" ||
    state.status === "resource_exhausted"
  );
}

function hasSettlementExhaustion(state: RunState): boolean {
  return state.budget?.exhausted.some((item) => item.dimension !== "nodeStarts") === true;
}

function hasPendingStartExhaustion(state: RunState): boolean {
  return (
    state.budget?.exhausted.some((item) => item.dimension === "nodeStarts") === true &&
    Object.values(state.nodes).some((node) => node.status === "pending") &&
    !Object.values(state.nodes).some((node) => node.status === "failed")
  );
}

function boundNodeTimeout(node: CompiledCommandNode, state: RunState): CompiledCommandNode;
function boundNodeTimeout(node: CompiledAgentNode, state: RunState): CompiledAgentNode;
function boundNodeTimeout(node: CompiledVerifierNode, state: RunState): CompiledVerifierNode;
function boundNodeTimeout(node: ExecutableNode, state: RunState): ExecutableNode;
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
  if (node.type === "verifier") {
    const timeoutMs =
      node.verifier.kind === "command" ? node.verifier.command.timeoutMs : node.verifier.timeoutMs;
    if (timeoutMs <= remaining) {
      return node;
    }
    return Object.freeze({
      ...node,
      verifier: Object.freeze(
        node.verifier.kind === "command"
          ? {
              ...node.verifier,
              command: Object.freeze({ ...node.verifier.command, timeoutMs: remaining }),
            }
          : { ...node.verifier, timeoutMs: remaining },
      ),
    });
  }
  if (node.type !== "agent") {
    return node;
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
  options: Omit<RunWorkflowOptions, "runId">,
  now: () => Date,
): Promise<NodeExecutionOutcome> {
  if (node.type === "child") {
    return await executeChildNode(node, context, options, now);
  }
  try {
    return await executor.execute(node, context);
  } catch (error) {
    const message = boundedFailureMessage(error instanceof Error ? error.message : String(error));
    const failure: NodeFailure = {
      code: node.type === "verifier" ? "verifier_inconclusive" : "executor_error",
      message,
      retryable: false,
      sideEffectStatus: "uncertain",
    };
    return { status: "failed", error: failure, evidence: null };
  }
}

async function executeChildNode(
  node: CompiledChildNode,
  context: Parameters<NodeExecutor["execute"]>[1],
  options: Omit<RunWorkflowOptions, "runId">,
  now: () => Date,
): Promise<NodeExecutionOutcome> {
  const store = childRunStore(options.store);
  if (store === null || options.workspaceIsolator === undefined) {
    return childFailure(
      "child_runtime_unavailable",
      "child workflows require a recoverable run store and workspace isolator",
    );
  }
  const link = createChildRunLink(context.runId, node, context.attempt);
  if (await store.exists(link.runId)) {
    return childFailure(
      "child_run_collision",
      `child run "${link.runId}" already exists before its parent attempt started`,
    );
  }

  let workspace: IsolatedWorkspace;
  try {
    workspace = await options.workspaceIsolator.create({
      workspaceId: link.runId,
      sourceCwd: context.cwd,
      excludedPaths: context.protectedPaths,
    });
  } catch (error) {
    return childFailure(
      "child_workspace_unavailable",
      `child workspace could not be created: ${boundedFailureMessage(error instanceof Error ? error.message : String(error))}`,
    );
  }

  const executionWorkspace: ExecutionWorkspaceProvenance = Object.freeze({
    backend: workspace.backend,
    snapshotDigest: workspace.snapshotDigest,
    parentRunId: context.runId,
    parentNodeId: node.id,
    parentAttempt: context.attempt,
  });
  const childState = await runWorkflow(node.child.workflow, {
    runId: link.runId,
    cwd: workspace.cwd,
    protectedPaths: context.protectedPaths,
    store,
    executor: options.executor,
    ...(options.workspaceIsolator === undefined
      ? {}
      : { workspaceIsolator: options.workspaceIsolator }),
    executionWorkspace,
    now,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  return await settleChildState(node, childState, options.workspaceIsolator);
}

async function recoverChildNode(
  node: CompiledChildNode,
  attempt: number,
  options: ResumeWorkflowOptions,
  now: () => Date,
): Promise<NodeExecutionOutcome> {
  const store = childRunStore(options.store);
  if (store === null || options.workspaceIsolator === undefined) {
    return childFailure(
      "child_runtime_unavailable",
      "child workflows require a recoverable run store and workspace isolator",
    );
  }
  const link = createChildRunLink(options.runId, node, attempt);
  if (!(await store.exists(link.runId))) {
    await options.workspaceIsolator.cleanup(link.runId);
    return await executeChildNode(
      node,
      {
        runId: options.runId,
        workflowId: node.child.workflow.id,
        attempt,
        cwd: resolve(options.cwd),
        protectedPaths: options.protectedPaths,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      options,
      now,
    );
  }

  let childState = reduceRunEvents(await store.read(link.runId));
  validateRecoveredChildIdentity(link, node, options.runId, attempt, childState);
  if (!runStateIsTerminal(childState)) {
    const workspace = await options.workspaceIsolator.reopen({
      workspaceId: link.runId,
      sourceCwd: resolve(options.cwd),
      excludedPaths: options.protectedPaths,
    });
    const provenance = childState.executionWorkspace;
    if (
      provenance === null ||
      provenance.backend !== workspace.backend ||
      provenance.snapshotDigest !== workspace.snapshotDigest
    ) {
      throw new Error(`child run "${link.runId}" workspace provenance has diverged`);
    }
    childState = await resumeWorkflow(node.child.workflow, {
      runId: link.runId,
      cwd: workspace.cwd,
      protectedPaths: options.protectedPaths,
      store,
      executor: options.executor,
      workspaceIsolator: options.workspaceIsolator,
      executionWorkspace: provenance,
      ...(options.effectReconciler === undefined
        ? {}
        : { effectReconciler: options.effectReconciler }),
      now,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
  return await settleChildState(node, childState, options.workspaceIsolator);
}

function validateRecoveredChildIdentity(
  link: ChildRunLink,
  node: CompiledChildNode,
  parentRunId: string,
  attempt: number,
  state: RunState,
): void {
  const provenance = state.executionWorkspace;
  if (
    state.runId !== link.runId ||
    state.workflowId !== link.workflowId ||
    state.workflowDigest !== link.workflowDigest ||
    provenance === null ||
    provenance.parentRunId !== parentRunId ||
    provenance.parentNodeId !== node.id ||
    provenance.parentAttempt !== attempt
  ) {
    throw new Error(`child run "${link.runId}" does not match its durable parent link`);
  }
}

async function settleChildState(
  node: CompiledChildNode,
  childState: RunState,
  workspaceIsolator: WorkspaceIsolator,
): Promise<NodeExecutionOutcome> {
  if (!runStateIsTerminal(childState)) {
    return childFailure(
      "child_wait_unsupported",
      `child run "${childState.runId}" entered unsupported status "${childState.status}"`,
    );
  }

  let disposition: "discarded" | "retained" = "discarded";
  try {
    await workspaceIsolator.cleanup(childState.runId);
  } catch {
    disposition = "retained";
  }
  const evidence = childEvidence(node, childState, disposition);
  if (disposition === "retained") {
    return childFailure(
      "child_workspace_cleanup_failed",
      `child workspace "${childState.runId}" could not be discarded`,
      evidence,
    );
  }
  if (childState.status === "succeeded") {
    return { status: "succeeded", evidence };
  }
  return childFailure(
    childFailureCode(childState.status),
    childState.failureReason ??
      `child run "${childState.runId}" ended with status "${childState.status}"`,
    evidence,
  );
}

function childEvidence(
  node: CompiledChildNode,
  state: RunState,
  disposition: "discarded" | "retained",
): ChildEvidence {
  const provenance = state.executionWorkspace;
  if (provenance === null) {
    throw new Error(`child run "${state.runId}" has no workspace provenance`);
  }
  const resultState = state.nodes[node.child.resultNodeId];
  const result =
    resultState?.control?.kind === "result"
      ? Object.freeze({
          nodeId: node.child.resultNodeId,
          schemaDigest: resultState.control.schemaDigest,
          canonicalValue: resultState.control.canonicalValue,
          valueHash: resultState.control.valueHash,
        })
      : null;
  const finishedAt =
    state.finishedAt === null ? Date.parse(state.startedAt) : Date.parse(state.finishedAt);
  return Object.freeze({
    kind: "child",
    childRunId: state.runId,
    workflowId: state.workflowId,
    workflowDigest: state.workflowDigest,
    terminalSequence: state.lastSequence,
    outcome: requireChildTerminalStatus(state.status),
    result,
    resources: state.resources,
    durationMs: Math.max(0, finishedAt - Date.parse(state.startedAt)),
    workspace: Object.freeze({
      backend: provenance.backend,
      snapshotDigest: provenance.snapshotDigest,
      disposition,
    }),
  });
}

function requireChildTerminalStatus(status: RunState["status"]): ChildEvidence["outcome"] {
  if (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "resource_exhausted"
  ) {
    return status;
  }
  throw new Error(`child run is not terminal: ${status}`);
}

function childFailureCode(status: ChildEvidence["outcome"]): string {
  switch (status) {
    case "failed":
      return "child_run_failed";
    case "cancelled":
      return "child_run_cancelled";
    case "resource_exhausted":
      return "child_run_resource_exhausted";
    case "succeeded":
      return "child_run_failed";
  }
}

function childFailure(
  code: string,
  message: string,
  evidence: ChildEvidence | null = null,
): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code,
      message: boundedFailureMessage(message),
      retryable: false,
      sideEffectStatus: "none",
    },
    evidence,
  };
}

function childRunStore(
  store: RunEventStore,
): (RecoverableRunEventStore & { exists(runId: string): Promise<boolean> }) | null {
  return "claim" in store &&
    typeof store.claim === "function" &&
    "release" in store &&
    typeof store.release === "function" &&
    "exists" in store &&
    typeof store.exists === "function"
    ? (store as RecoverableRunEventStore & { exists(runId: string): Promise<boolean> })
    : null;
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
