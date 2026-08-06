import { z } from "zod";
import { createHash } from "node:crypto";

import {
  GoalEvaluationError,
  acceptGoal,
  createGoalRunState,
  recordCriterionDecision,
  rejectIncompleteGoal,
} from "../goal/evaluator.js";
import { compiledGoalSchema } from "../goal/schema.js";
import type { CompiledGoal, GoalRunState } from "../goal/types.js";
import {
  MAX_POLICY_DECISIONS,
  calculatePolicyRequestDigest,
  classifyPolicyAction,
} from "../policy/broker.js";
import { policyDecisionSchema } from "../policy/schema.js";
import type { PolicyDecision } from "../policy/types.js";

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
  readonly textHash: string;
  readonly textTruncated: boolean;
  readonly durationMs: number;
  readonly policyDecisions: readonly PolicyDecision[];
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
  readonly goal?: CompiledGoal;
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
  readonly goal: GoalRunState | null;
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

const commandOutputSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, "utf8") <= 32_768, {
    message: "command output must not exceed 32768 UTF-8 bytes",
  });

const agentOutputSchema = z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 65_536, {
  message: "agent output must not exceed 65536 UTF-8 bytes",
});

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
    executable: z.string().min(1).max(4096),
    args: z
      .array(z.string().max(4096))
      .max(64)
      .refine(
        (args) => args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= 65_536,
        "command arguments must not exceed 65536 UTF-8 bytes in total",
      ),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: commandOutputSchema,
    stderr: commandOutputSchema,
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
    provider: z.string().min(1).max(96),
    model: z.string().min(1).max(256),
    text: agentOutputSchema,
    textHash: z.string().regex(/^[a-f0-9]{64}$/),
    textTruncated: z.boolean(),
    durationMs: z.number().nonnegative(),
    policyDecisions: z.array(policyDecisionSchema).max(MAX_POLICY_DECISIONS).default([]),
  })
  .strict();

const nodeEvidenceSchema = z.discriminatedUnion("kind", [
  commandEvidenceSchema,
  agentEvidenceSchema,
]);

const nodeFailureSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1).max(16_384),
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
      goal: compiledGoalSchema.optional(),
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
      reason: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("run_cancelled"),
      reason: z.string().min(1).max(16_384),
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

  let state: RunState | undefined;
  for (const [index, inputEvent] of inputEvents.entries()) {
    state = appendRunEvent(state, inputEvent, index);
  }
  if (state === undefined) {
    throw new RunReplayError(0, "the ledger is empty");
  }
  return state;
}

/**
 * Validate and apply one event without replaying prior evidence. Stores use this
 * transition function to keep append cost linear in the number of events.
 */
export function appendRunEvent(
  currentState: RunState | undefined,
  inputEvent: RunEvent,
  eventIndex = currentState?.lastSequence ?? 0,
): RunState {
  let event: RunEvent;
  try {
    event = parseRunEvent(inputEvent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RunReplayError(eventIndex, `event schema is invalid: ${message}`);
  }

  const expectedSequence = (currentState?.lastSequence ?? 0) + 1;
  if (event.sequence !== expectedSequence) {
    throw new RunReplayError(
      eventIndex,
      `expected sequence ${expectedSequence}, received ${event.sequence}`,
    );
  }

  if (currentState === undefined) {
    if (event.type !== "run_started") {
      throw new RunReplayError(eventIndex, "the first event must be run_started");
    }
    const nodes: Record<string, NodeRunState> = {};
    for (const nodeId of event.nodeIds) {
      nodes[nodeId] = pendingNodeState();
    }
    if (
      event.goal?.criteria.some((criterion) => !event.nodeIds.includes(criterion.verifierNodeId))
    ) {
      throw new RunReplayError(eventIndex, "goal references a verifier outside the run node set");
    }
    return freezeRunState({
      runId: event.runId,
      workflowId: event.workflowId,
      workflowApiVersion: event.workflowApiVersion,
      workflowDigest: event.workflowDigest,
      status: "running",
      startedAt: event.at,
      finishedAt: null,
      lastSequence: event.sequence,
      failedNodeId: null,
      failureReason: null,
      goal: event.goal === undefined ? null : createGoalRunState(event.goal),
      nodes,
    });
  }

  if (event.runId !== currentState.runId || event.workflowId !== currentState.workflowId) {
    throw new RunReplayError(eventIndex, "runId and workflowId must remain constant");
  }
  if (currentState.status !== "running") {
    throw new RunReplayError(
      eventIndex,
      `event follows terminal run status "${currentState.status}"`,
    );
  }
  if (event.type === "run_started") {
    throw new RunReplayError(eventIndex, "run_started may occur only once");
  }

  const nodes: Record<string, NodeRunState> = { ...currentState.nodes };
  const failedNodes = Object.entries(nodes).filter(([, node]) => node.status === "failed");
  if (failedNodes.length > 0 && event.type !== "run_failed") {
    throw new RunReplayError(eventIndex, "node_failed must be followed immediately by run_failed");
  }

  let status: RunStatus = "running";
  let finishedAt: string | null = null;
  let failedNodeId: string | null = null;
  let failureReason: string | null = null;
  let goal = currentState.goal;

  switch (event.type) {
    case "node_started": {
      if (Object.values(nodes).some((node) => node.status === "running")) {
        throw new RunReplayError(eventIndex, "only one node may be running at a time");
      }
      const current = requireNode(nodes, event.nodeId, eventIndex);
      if (current.status !== "pending") {
        throw new RunReplayError(eventIndex, `node "${event.nodeId}" must be pending before start`);
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
      validateEvidenceIntegrity(event.evidence, event, eventIndex);
      validateSucceededEvidence(event.evidence, eventIndex);
      const current = requireRunningAttempt(nodes, event.nodeId, event.attempt, eventIndex);
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "succeeded",
        finishedAt: event.at,
        evidence: deepFreeze(structuredClone(event.evidence)),
      });
      goal = applyCriterionDecision(
        goal,
        {
          runId: event.runId,
          nodeId: event.nodeId,
          attempt: event.attempt,
          at: event.at,
          outcome: event.evidence.kind === "command" ? "accepted" : "inconclusive",
          evidenceAvailable: true,
        },
        eventIndex,
      );
      break;
    }
    case "node_failed": {
      if (event.evidence !== null) {
        validateEvidenceIntegrity(event.evidence, event, eventIndex);
      }
      const current = requireRunningAttempt(nodes, event.nodeId, event.attempt, eventIndex);
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "failed",
        finishedAt: event.at,
        evidence: event.evidence === null ? null : deepFreeze(structuredClone(event.evidence)),
        error: deepFreeze(structuredClone(event.error)),
      });
      goal = applyCriterionDecision(
        goal,
        {
          runId: event.runId,
          nodeId: event.nodeId,
          attempt: event.attempt,
          at: event.at,
          outcome: isConclusiveVerifierRejection(event.evidence) ? "rejected" : "inconclusive",
          evidenceAvailable: event.evidence !== null,
        },
        eventIndex,
      );
      break;
    }
    case "run_succeeded": {
      if (!Object.values(nodes).every((node) => node.status === "succeeded")) {
        throw new RunReplayError(eventIndex, "run cannot succeed because not every node succeeded");
      }
      status = "succeeded";
      finishedAt = event.at;
      goal = applyGoalAcceptance(goal, eventIndex);
      break;
    }
    case "run_failed": {
      const failed = requireNode(nodes, event.failedNodeId, eventIndex);
      if (
        failed.status !== "failed" ||
        failedNodes.length !== 1 ||
        failedNodes[0]?.[0] !== event.failedNodeId ||
        Object.values(nodes).some((node) => node.status === "running")
      ) {
        throw new RunReplayError(
          eventIndex,
          `failed node "${event.failedNodeId}" is not the sole failed node`,
        );
      }
      status = "failed";
      finishedAt = event.at;
      failedNodeId = event.failedNodeId;
      failureReason = event.reason;
      goal = goal === null ? null : rejectIncompleteGoal(goal);
      break;
    }
    case "run_cancelled": {
      if (Object.values(nodes).some((node) => node.status === "running")) {
        throw new RunReplayError(eventIndex, "run cannot cancel while a node remains running");
      }
      status = "cancelled";
      finishedAt = event.at;
      failureReason = event.reason;
      goal = goal === null ? null : rejectIncompleteGoal(goal);
      break;
    }
  }

  return freezeRunState({
    runId: currentState.runId,
    workflowId: currentState.workflowId,
    workflowApiVersion: currentState.workflowApiVersion,
    workflowDigest: currentState.workflowDigest,
    status,
    startedAt: currentState.startedAt,
    finishedAt,
    lastSequence: event.sequence,
    failedNodeId,
    failureReason,
    goal,
    nodes,
  });
}

function applyCriterionDecision(
  goal: GoalRunState | null,
  input: Parameters<typeof recordCriterionDecision>[1],
  eventIndex: number,
): GoalRunState | null {
  if (goal === null) {
    return null;
  }
  try {
    return recordCriterionDecision(goal, input);
  } catch (error) {
    throw goalReplayError(error, eventIndex);
  }
}

function applyGoalAcceptance(goal: GoalRunState | null, eventIndex: number): GoalRunState | null {
  if (goal === null) {
    return null;
  }
  try {
    return acceptGoal(goal);
  } catch (error) {
    throw goalReplayError(error, eventIndex);
  }
}

function goalReplayError(error: unknown, eventIndex: number): RunReplayError {
  const message = error instanceof Error ? error.message : String(error);
  return new RunReplayError(
    eventIndex,
    error instanceof GoalEvaluationError ? message : `goal evaluation failed: ${message}`,
  );
}

function isConclusiveVerifierRejection(evidence: NodeEvidence | null): boolean {
  return (
    evidence?.kind === "command" &&
    evidence.exitCode !== null &&
    evidence.exitCode !== 0 &&
    evidence.signal === null &&
    !evidence.timedOut
  );
}

function freezeRunState(state: RunState): RunState {
  return Object.freeze({ ...state, nodes: Object.freeze({ ...state.nodes }) });
}

function validateSucceededEvidence(evidence: NodeEvidence, eventIndex: number): void {
  if (
    evidence.kind === "command" &&
    (evidence.exitCode !== 0 || evidence.signal !== null || evidence.timedOut)
  ) {
    throw new RunReplayError(
      eventIndex,
      "successful command evidence must have exit code 0, no signal, and no timeout",
    );
  }
  if (evidence.kind === "agent" && evidence.textTruncated) {
    throw new RunReplayError(eventIndex, "successful agent evidence must not be truncated");
  }
}

function validateEvidenceIntegrity(
  evidence: NodeEvidence,
  event: NodeSucceededEvent | NodeFailedEvent,
  eventIndex: number,
): void {
  if (
    evidence.kind === "agent" &&
    !evidence.textTruncated &&
    evidence.textHash !== sha256(evidence.text)
  ) {
    throw new RunReplayError(eventIndex, "agent evidence text hash is invalid");
  }
  if (evidence.kind === "agent") {
    for (const [index, decision] of evidence.policyDecisions.entries()) {
      const expectedSequence = index + 1;
      if (decision.sequence !== expectedSequence) {
        throw new RunReplayError(
          eventIndex,
          `policy decision sequence must be contiguous; expected ${expectedSequence}, received ${decision.sequence}`,
        );
      }
      if (
        decision.runId !== event.runId ||
        decision.workflowId !== event.workflowId ||
        decision.nodeId !== event.nodeId ||
        decision.attempt !== event.attempt
      ) {
        throw new RunReplayError(
          eventIndex,
          "policy decision attribution does not match its node event",
        );
      }
      if (decision.authority !== classifyPolicyAction(decision.action)) {
        throw new RunReplayError(eventIndex, "policy decision authority does not match its action");
      }
      const expectedOutcome = decision.reason === "operation_declared" ? "allowed" : "denied";
      if (decision.outcome !== expectedOutcome) {
        throw new RunReplayError(eventIndex, "policy decision outcome does not match its reason");
      }
      const expectedDigest = calculatePolicyRequestDigest({
        version: decision.version,
        runId: decision.runId,
        workflowId: decision.workflowId,
        nodeId: decision.nodeId,
        attempt: decision.attempt,
        authority: decision.authority,
        action: decision.action,
        target: decision.target,
      });
      if (decision.requestDigest !== expectedDigest) {
        throw new RunReplayError(eventIndex, "policy decision request digest is invalid");
      }
    }
  }
  if (evidence.kind === "command") {
    if (!evidence.stdoutTruncated && evidence.stdoutHash !== sha256(evidence.stdout)) {
      throw new RunReplayError(eventIndex, "command evidence stdout hash is invalid");
    }
    if (!evidence.stderrTruncated && evidence.stderrHash !== sha256(evidence.stderr)) {
      throw new RunReplayError(eventIndex, "command evidence stderr hash is invalid");
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
