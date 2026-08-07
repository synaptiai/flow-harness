import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  appendRunEvent,
  reduceRunEvents,
  type NodeFailure,
  type RunEvent,
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
import type { CompiledNode, CompiledWorkflow } from "../domain/workflow/types.js";
import type {
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
}

export async function runWorkflow(
  workflow: CompiledWorkflow,
  options: RunWorkflowOptions,
): Promise<RunState> {
  if (isAborted(options.signal)) {
    throw new RunWorkflowAbortedError(abortReason(options.signal));
  }
  const runId = options.runId ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const executionCwd = resolve(options.cwd);
  return await releaseAfter(options.store, runId, async () => {
    const approvalRequirements = commandApprovalRequirements(workflow);
    const started: RunStartedEvent = {
      ...eventBase(workflow, runId, 1, now),
      type: "run_started",
      nodeIds: workflow.nodes.map((node) => node.id),
      workflowApiVersion: workflow.apiVersion,
      workflowDigest: calculateWorkflowDigest(workflow),
      executionCwd,
      ...(approvalRequirements.length === 0 ? {} : { approvalRequirements }),
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
  if (isAborted(options.signal)) {
    throw new RunWorkflowAbortedError(abortReason(options.signal));
  }

  const events = await options.store.claim(options.runId);
  return await releaseAfter(options.store, options.runId, async () => {
    let state = reduceRunEvents(events);
    const executionCwd = resolve(options.cwd);
    validateRecovery(workflow, options.runId, executionCwd, state, events);
    const now = options.now ?? (() => new Date());
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

  async function record(event: RunEvent): Promise<void> {
    await options.store.append(event);
    state = appendRunEvent(state, event);
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
    await record({
      ...base(nextSequence()),
      type: "run_failed",
      failedNodeId,
      reason: failedNode.error.message,
    });
    return state;
  }

  while (completed.size < workflow.nodes.length) {
    if (isAborted(options.signal)) {
      return await cancelRun();
    }
    const node = selectReadyNode(workflow.nodes, completed);
    if (node === undefined) {
      throw new Error("Compiled workflow has no ready node; compiler invariant was violated");
    }

    const attempt = 1;
    let approval: { readonly requestId: string; readonly operationDigest: string } | undefined;
    if (node.type === "command" && node.approval !== undefined) {
      const operation = createCommandApprovalOperation(node, options.cwd);
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
      });
    }

    const outcome = isAborted(options.signal)
      ? abortedOutcome(options.signal)
      : await executeNode(node, options.executor, {
          runId,
          workflowId: workflow.id,
          attempt,
          cwd: options.cwd,
          protectedPaths: options.protectedPaths,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    const authoritativeOutcome =
      isAborted(options.signal) && outcome.status === "succeeded"
        ? abortedOutcome(options.signal)
        : outcome;

    if (authoritativeOutcome.status === "failed") {
      await record({
        ...base(nextSequence()),
        type: "node_failed",
        nodeId: node.id,
        attempt,
        error: authoritativeOutcome.error,
        evidence: authoritativeOutcome.evidence,
      });
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

  if (isAborted(options.signal)) {
    return await cancelRun();
  }

  await record({
    ...base(nextSequence()),
    type: "run_succeeded",
  });
  return state;

  async function cancelRun(): Promise<RunState> {
    const cancelled: RunCancelledEvent = {
      ...base(nextSequence()),
      type: "run_cancelled",
      reason: abortReason(options.signal),
    };
    await record(cancelled);
    return state;
  }
}

export type RunRecoveryErrorCode =
  | "execution_context_mismatch"
  | "terminal_run"
  | "uncertain_operation"
  | "workflow_mismatch";

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

function validateRecovery(
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
    const expectedOperation = createCommandApprovalOperation(node, executionCwd);
    const expectedDigest = calculateCommandApprovalOperationDigest(expectedOperation);
    if (
      nodeState.approval.operationDigest !== expectedDigest ||
      calculateCommandApprovalOperationDigest(nodeState.approval.operation) !== expectedDigest
    ) {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${runId}" approval operation does not match command node "${nodeId}"`,
      );
    }
  }

  const openAttempt = Object.entries(state.nodes).find(([, node]) => node.status === "running");
  if (openAttempt !== undefined) {
    const [nodeId, node] = openAttempt;
    throw new RunRecoveryError(
      "uncertain_operation",
      `run "${runId}" cannot resume because node "${nodeId}" attempt ${node.attempt} has no committed outcome`,
    );
  }

  validateRecoveredHistory(workflow, runId, events);
}

function validateRecoveredHistory(
  workflow: CompiledWorkflow,
  runId: string,
  events: readonly RunEvent[],
): void {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const completed = new Set<string>();

  for (const event of events) {
    if (event.type === "command_approval_requested") {
      const node = nodeById.get(event.nodeId);
      if (
        node?.type !== "command" ||
        node.approval === undefined ||
        event.attempt !== 1 ||
        !node.dependsOn.every((dependency) => completed.has(dependency))
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains approval history that violates the compiled workflow graph`,
        );
      }
    } else if (event.type === "node_started") {
      const node = nodeById.get(event.nodeId);
      if (
        node === undefined ||
        event.attempt !== 1 ||
        !node.dependsOn.every((dependency) => completed.has(dependency))
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains node history that violates the compiled workflow graph`,
        );
      }
    } else if (event.type === "node_succeeded") {
      completed.add(event.nodeId);
    }
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

function abortedOutcome(signal: AbortSignal | undefined): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code: "workflow_aborted",
      message: abortReason(signal),
      retryable: false,
      sideEffectStatus: "uncertain",
    },
    evidence: null,
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
