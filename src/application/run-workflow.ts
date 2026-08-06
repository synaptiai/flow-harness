import { createHash, randomUUID } from "node:crypto";

import {
  appendRunEvent,
  type NodeFailure,
  type RunEvent,
  type RunCancelledEvent,
  type RunFailedEvent,
  type RunStartedEvent,
  type RunState,
} from "../domain/run/events.js";
import type { CompiledNode, CompiledWorkflow } from "../domain/workflow/types.js";
import type { NodeExecutionOutcome, NodeExecutor, RunEventStore } from "./ports.js";

export interface RunWorkflowOptions {
  readonly cwd: string;
  readonly protectedPaths: readonly string[];
  readonly store: RunEventStore;
  readonly executor: NodeExecutor;
  readonly runId?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
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
  let state: RunState | undefined;

  async function record(event: RunEvent): Promise<void> {
    await options.store.append(event);
    state = appendRunEvent(state, event);
  }

  function nextSequence(): number {
    return (state?.lastSequence ?? 0) + 1;
  }

  function currentState(): RunState {
    if (state === undefined) {
      throw new Error("Run state is unavailable after a committed event");
    }
    return state;
  }

  function base(sequence: number) {
    return {
      version: 1 as const,
      sequence,
      at: now().toISOString(),
      runId,
      workflowId: workflow.id,
    };
  }

  const started: RunStartedEvent = {
    ...base(1),
    type: "run_started",
    nodeIds: workflow.nodes.map((node) => node.id),
    workflowApiVersion: workflow.apiVersion,
    workflowDigest: createHash("sha256").update(JSON.stringify(workflow)).digest("hex"),
    ...(workflow.goal === undefined ? {} : { goal: workflow.goal }),
  };
  await record(started);

  const completed = new Set<string>();
  while (completed.size < workflow.nodes.length) {
    if (isAborted(options.signal)) {
      return await cancelRun();
    }
    const node = selectReadyNode(workflow.nodes, completed);
    if (node === undefined) {
      throw new Error("Compiled workflow has no ready node; compiler invariant was violated");
    }

    const attempt = 1;
    await record({
      ...base(nextSequence()),
      type: "node_started",
      nodeId: node.id,
      attempt,
    });

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
      return currentState();
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
  return currentState();

  async function cancelRun(): Promise<RunState> {
    const cancelled: RunCancelledEvent = {
      ...base(nextSequence()),
      type: "run_cancelled",
      reason: abortReason(options.signal),
    };
    await record(cancelled);
    return currentState();
  }
}

export class RunWorkflowAbortedError extends Error {
  override readonly name = "RunWorkflowAbortedError";
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
