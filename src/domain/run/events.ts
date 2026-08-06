import { z } from "zod";

export interface CommandEvidence {
  readonly kind: "command";
  readonly executable: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutHash: string;
  readonly stderrHash: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface AgentEvidence {
  readonly kind: "agent";
  readonly provider: string;
  readonly model: string;
  readonly text: string;
  readonly durationMs: number;
}

export type NodeEvidence = CommandEvidence | AgentEvidence;

export interface NodeFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly sideEffectStatus: "none" | "committed" | "uncertain";
}

interface RunEventBase {
  readonly version: 1;
  readonly sequence: number;
  readonly at: string;
  readonly runId: string;
  readonly workflowId: string;
}

export interface RunStartedEvent extends RunEventBase {
  readonly type: "run_started";
  readonly nodeIds: readonly string[];
  readonly workflowApiVersion: "flow.synapti.ai/v1alpha1";
  readonly workflowDigest: string;
}

export interface NodeStartedEvent extends RunEventBase {
  readonly type: "node_started";
  readonly nodeId: string;
  readonly attempt: number;
}

export interface NodeSucceededEvent extends RunEventBase {
  readonly type: "node_succeeded";
  readonly nodeId: string;
  readonly attempt: number;
  readonly evidence: NodeEvidence;
}

export interface NodeFailedEvent extends RunEventBase {
  readonly type: "node_failed";
  readonly nodeId: string;
  readonly attempt: number;
  readonly error: NodeFailure;
  readonly evidence: NodeEvidence | null;
}

export interface RunSucceededEvent extends RunEventBase {
  readonly type: "run_succeeded";
}

export interface RunFailedEvent extends RunEventBase {
  readonly type: "run_failed";
  readonly failedNodeId: string;
  readonly reason: string;
}

export interface RunCancelledEvent extends RunEventBase {
  readonly type: "run_cancelled";
  readonly reason: string;
}

export type RunEvent =
  | RunStartedEvent
  | NodeStartedEvent
  | NodeSucceededEvent
  | NodeFailedEvent
  | RunSucceededEvent
  | RunFailedEvent
  | RunCancelledEvent;

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type NodeRunStatus = "pending" | "running" | "succeeded" | "failed";

export interface NodeRunState {
  readonly status: NodeRunStatus;
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly evidence: NodeEvidence | null;
  readonly error: NodeFailure | null;
}

export interface RunState {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowApiVersion: "flow.synapti.ai/v1alpha1";
  readonly workflowDigest: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly lastSequence: number;
  readonly failedNodeId: string | null;
  readonly failureReason: string | null;
  readonly nodes: Readonly<Record<string, NodeRunState>>;
}

export class RunReplayError extends Error {
  override readonly name = "RunReplayError";

  constructor(
    readonly eventIndex: number,
    message: string,
  ) {
    super(`Cannot replay event ${eventIndex + 1}: ${message}`);
  }
}

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const eventBaseShape = {
  version: z.literal(1),
  sequence: z.number().int().positive(),
  at: z.iso.datetime({ offset: true }),
  runId: identifierSchema,
  workflowId: identifierSchema,
};

const commandEvidenceSchema = z
  .object({
    kind: z.literal("command"),
    executable: z.string().min(1),
    args: z.array(z.string()),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    stdoutHash: z.string().regex(/^[a-f0-9]{64}$/),
    stderrHash: z.string().regex(/^[a-f0-9]{64}$/),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    timedOut: z.boolean(),
    durationMs: z.number().nonnegative(),
  })
  .strict();

const agentEvidenceSchema = z
  .object({
    kind: z.literal("agent"),
    provider: z.string().min(1),
    model: z.string().min(1),
    text: z.string(),
    durationMs: z.number().nonnegative(),
  })
  .strict();

const nodeEvidenceSchema = z.discriminatedUnion("kind", [
  commandEvidenceSchema,
  agentEvidenceSchema,
]);

const nodeFailureSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    sideEffectStatus: z.enum(["none", "committed", "uncertain"]),
  })
  .strict();

const runEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...eventBaseShape,
      type: z.literal("run_started"),
      nodeIds: z
        .array(identifierSchema)
        .min(1)
        .refine((items) => new Set(items).size === items.length, "node ids must be unique"),
      workflowApiVersion: z.literal("flow.synapti.ai/v1alpha1"),
      workflowDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_started"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_succeeded"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      evidence: nodeEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_failed"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      error: nodeFailureSchema,
      evidence: nodeEvidenceSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("run_succeeded"),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("run_failed"),
      failedNodeId: identifierSchema,
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("run_cancelled"),
      reason: z.string().min(1),
    })
    .strict(),
]);

export function parseRunEvent(input: unknown): RunEvent {
  return runEventSchema.parse(input) as RunEvent;
}

export function reduceRunEvents(inputEvents: readonly RunEvent[]): RunState {
  if (inputEvents.length === 0) {
    throw new RunReplayError(0, "the ledger is empty");
  }

  const events = inputEvents.map((event, index) => {
    try {
      return parseRunEvent(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RunReplayError(index, `event schema is invalid: ${message}`);
    }
  });
  const first = events[0];
  if (first?.type !== "run_started") {
    throw new RunReplayError(0, "the first event must be run_started");
  }

  const nodes: Record<string, NodeRunState> = {};
  for (const nodeId of first.nodeIds) {
    nodes[nodeId] = pendingNodeState();
  }

  let status: RunStatus = "running";
  let finishedAt: string | null = null;
  let failedNodeId: string | null = null;
  let failureReason: string | null = null;

  for (const [index, event] of events.entries()) {
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      throw new RunReplayError(
        index,
        `expected sequence ${expectedSequence}, received ${event.sequence}`,
      );
    }
    if (event.runId !== first.runId || event.workflowId !== first.workflowId) {
      throw new RunReplayError(index, "runId and workflowId must remain constant");
    }
    if (index > 0 && status !== "running") {
      throw new RunReplayError(index, `event follows terminal run status "${status}"`);
    }

    switch (event.type) {
      case "run_started": {
        if (index !== 0) {
          throw new RunReplayError(index, "run_started may occur only once");
        }
        break;
      }
      case "node_started": {
        const current = requireNode(nodes, event.nodeId, index);
        if (current.status !== "pending") {
          throw new RunReplayError(index, `node "${event.nodeId}" must be pending before start`);
        }
        nodes[event.nodeId] = Object.freeze({
          ...current,
          status: "running",
          attempt: event.attempt,
          startedAt: event.at,
        });
        break;
      }
      case "node_succeeded": {
        const current = requireRunningAttempt(nodes, event.nodeId, event.attempt, index);
        nodes[event.nodeId] = Object.freeze({
          ...current,
          status: "succeeded",
          finishedAt: event.at,
          evidence: deepFreeze(structuredClone(event.evidence)),
        });
        break;
      }
      case "node_failed": {
        const current = requireRunningAttempt(nodes, event.nodeId, event.attempt, index);
        nodes[event.nodeId] = Object.freeze({
          ...current,
          status: "failed",
          finishedAt: event.at,
          evidence: event.evidence === null ? null : deepFreeze(structuredClone(event.evidence)),
          error: deepFreeze(structuredClone(event.error)),
        });
        break;
      }
      case "run_succeeded": {
        if (!Object.values(nodes).every((node) => node.status === "succeeded")) {
          throw new RunReplayError(index, "run cannot succeed because not every node succeeded");
        }
        status = "succeeded";
        finishedAt = event.at;
        break;
      }
      case "run_failed": {
        const failed = requireNode(nodes, event.failedNodeId, index);
        if (failed.status !== "failed") {
          throw new RunReplayError(index, `failed node "${event.failedNodeId}" is not failed`);
        }
        status = "failed";
        finishedAt = event.at;
        failedNodeId = event.failedNodeId;
        failureReason = event.reason;
        break;
      }
      case "run_cancelled": {
        if (Object.values(nodes).some((node) => node.status === "running")) {
          throw new RunReplayError(index, "run cannot cancel while a node remains running");
        }
        status = "cancelled";
        finishedAt = event.at;
        failureReason = event.reason;
        break;
      }
    }
  }

  const last = events.at(-1);
  if (last === undefined) {
    throw new RunReplayError(0, "the ledger is empty");
  }

  return Object.freeze({
    runId: first.runId,
    workflowId: first.workflowId,
    workflowApiVersion: first.workflowApiVersion,
    workflowDigest: first.workflowDigest,
    status,
    startedAt: first.at,
    finishedAt,
    lastSequence: last.sequence,
    failedNodeId,
    failureReason,
    nodes: Object.freeze({ ...nodes }),
  });
}

function pendingNodeState(): NodeRunState {
  return Object.freeze({
    status: "pending",
    attempt: 0,
    startedAt: null,
    finishedAt: null,
    evidence: null,
    error: null,
  });
}

function requireNode(
  nodes: Readonly<Record<string, NodeRunState>>,
  nodeId: string,
  eventIndex: number,
): NodeRunState {
  const node = nodes[nodeId];
  if (node === undefined) {
    throw new RunReplayError(eventIndex, `event references unknown node "${nodeId}"`);
  }
  return node;
}

function requireRunningAttempt(
  nodes: Readonly<Record<string, NodeRunState>>,
  nodeId: string,
  attempt: number,
  eventIndex: number,
): NodeRunState {
  const node = requireNode(nodes, nodeId, eventIndex);
  if (node.status !== "running") {
    throw new RunReplayError(eventIndex, `node "${nodeId}" must be running before completion`);
  }
  if (node.attempt !== attempt) {
    throw new RunReplayError(
      eventIndex,
      `node "${nodeId}" completion attempt ${attempt} does not match ${node.attempt}`,
    );
  }
  return node;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
