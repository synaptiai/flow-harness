import { createHash, randomUUID } from "node:crypto";

import {
  reduceRunEvents,
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
  const events: RunEvent[] = [];

  async function record(event: RunEvent): Promise<void> {
    await options.store.append(event);
    events.push(event);
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
      ...base(events.length + 1),
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
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    const authoritativeOutcome =
      isAborted(options.signal) && outcome.status === "succeeded"
        ? abortedOutcome(options.signal)
        : outcome;

    if (authoritativeOutcome.status === "failed") {
      await record({
        ...base(events.length + 1),
        type: "node_failed",
        nodeId: node.id,
        attempt,
        error: authoritativeOutcome.error,
        evidence: authoritativeOutcome.evidence,
      });
      const failed: RunFailedEvent = {
        ...base(events.length + 1),
        type: "run_failed",
        failedNodeId: node.id,
        reason: authoritativeOutcome.error.message,
      };
      await record(failed);
      return reduceRunEvents(events);
    }

    await record({
      ...base(events.length + 1),
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
    ...base(events.length + 1),
    type: "run_succeeded",
  });
  return reduceRunEvents(events);

  async function cancelRun(): Promise<RunState> {
    const cancelled: RunCancelledEvent = {
      ...base(events.length + 1),
      type: "run_cancelled",
      reason: abortReason(options.signal),
    };
    await record(cancelled);
    return reduceRunEvents(events);
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
    const message = error instanceof Error ? error.message : String(error);
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
    return reason.message;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }
  return "workflow execution was cancelled";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
