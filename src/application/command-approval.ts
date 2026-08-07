import type { RecoverableRunEventStore } from "./ports.js";
import { isValidApprovalActor } from "../domain/approval/command-approval.js";
import {
  appendRunEvent,
  reduceRunEvents,
  type CommandApprovalDeniedEvent,
  type CommandApprovalGrantedEvent,
  type CommandApprovalRunState,
  type RunFailedEvent,
  type RunState,
  type WorkflowApprovalApprovedEvent,
  type WorkflowApprovalDeniedEvent,
  type WorkflowApprovalRunState,
} from "../domain/run/events.js";

interface ApprovalDecisionOptionsBase {
  readonly runId: string;
  readonly requestId: string;
  readonly actor: string;
  readonly store: RecoverableRunEventStore;
  readonly now?: () => Date;
}

export type ApprovalDecisionOptions = ApprovalDecisionOptionsBase &
  (
    | { readonly decision: "approve"; readonly reason?: never }
    | { readonly decision: "deny"; readonly reason?: string }
  );

export type ApprovalDecisionErrorCode =
  | "invalid_actor"
  | "invalid_reason"
  | "not_waiting"
  | "request_mismatch"
  | "terminal_run";

export class ApprovalDecisionError extends Error {
  override readonly name = "ApprovalDecisionError";

  constructor(
    readonly code: ApprovalDecisionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export async function decideApproval(options: ApprovalDecisionOptions): Promise<RunState> {
  const actor = normalizeActor(options.actor);
  const reason = options.decision === "deny" ? normalizeReason(options.reason) : undefined;
  const events = await options.store.claim(options.runId);

  return await releaseAfterDecision(options.store, options.runId, async () => {
    let state = reduceRunEvents(events);
    if (
      state.status === "succeeded" ||
      state.status === "failed" ||
      state.status === "cancelled" ||
      state.status === "resource_exhausted"
    ) {
      throw new ApprovalDecisionError(
        "terminal_run",
        `run "${options.runId}" is already terminal with status "${state.status}"`,
      );
    }
    if (state.status !== "waiting_for_approval") {
      throw new ApprovalDecisionError(
        "not_waiting",
        `run "${options.runId}" is not waiting for an approval decision`,
      );
    }

    const pending = currentPendingApproval(state);
    if (pending === undefined || pending.approval.requestId !== options.requestId) {
      throw new ApprovalDecisionError(
        "request_mismatch",
        `request "${options.requestId}" is not the current pending approval for run "${options.runId}"`,
      );
    }

    const at = (options.now ?? (() => new Date()))().toISOString();
    const sequence = state.lastSequence + 1;
    const eventBase = {
      version: 1 as const,
      sequence,
      at,
      runId: state.runId,
      workflowId: state.workflowId,
      nodeId: pending.nodeId,
      requestId: pending.approval.requestId,
    };

    if (options.decision === "approve") {
      if (pending.kind === "command") {
        const granted: CommandApprovalGrantedEvent = {
          ...eventBase,
          type: "command_approval_granted",
          attempt: pending.approval.attempt,
          operationDigest: pending.approval.operationDigest,
          actor,
          expiresAt: new Date(Date.parse(at) + pending.approval.grantTtlMs).toISOString(),
        };
        await options.store.append(granted);
        return appendRunEvent(state, granted);
      }
      const approved: WorkflowApprovalApprovedEvent = {
        ...eventBase,
        type: "workflow_approval_approved",
        attempt: pending.approval.attempt,
        requestDigest: pending.approval.requestDigest,
        actor,
      };
      await options.store.append(approved);
      return appendRunEvent(state, approved);
    }

    const denied: CommandApprovalDeniedEvent | WorkflowApprovalDeniedEvent =
      pending.kind === "command"
        ? {
            ...eventBase,
            type: "command_approval_denied",
            attempt: pending.approval.attempt,
            operationDigest: pending.approval.operationDigest,
            actor,
            ...(reason === undefined ? {} : { reason }),
          }
        : {
            ...eventBase,
            type: "workflow_approval_denied",
            attempt: pending.approval.attempt,
            requestDigest: pending.approval.requestDigest,
            actor,
            ...(reason === undefined ? {} : { reason }),
          };
    await options.store.append(denied);
    state = appendRunEvent(state, denied);
    const failedNode = state.nodes[pending.nodeId];
    if (failedNode?.status !== "failed" || failedNode.error === null) {
      throw new Error("approval denial did not produce the expected committed node failure");
    }
    const failed: RunFailedEvent = {
      version: 1,
      sequence: state.lastSequence + 1,
      at,
      runId: state.runId,
      workflowId: state.workflowId,
      type: "run_failed",
      failedNodeId: pending.nodeId,
      reason: failedNode.error.message,
    };
    await options.store.append(failed);
    return appendRunEvent(state, failed);
  });
}

export async function decideCommandApproval(options: ApprovalDecisionOptions): Promise<RunState> {
  return await decideApproval(options);
}

function currentPendingApproval(state: RunState):
  | {
      readonly kind: "command";
      readonly nodeId: string;
      readonly approval: CommandApprovalRunState;
    }
  | {
      readonly kind: "workflow";
      readonly nodeId: string;
      readonly approval: WorkflowApprovalRunState;
    }
  | undefined {
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.approval?.status === "pending") {
      return { kind: "command", nodeId, approval: node.approval };
    }
    if (node.workflowApproval?.status === "pending") {
      return { kind: "workflow", nodeId, approval: node.workflowApproval };
    }
  }
  return undefined;
}

function normalizeActor(input: string): string {
  const actor = input.trim();
  if (!isValidApprovalActor(actor)) {
    throw new ApprovalDecisionError(
      "invalid_actor",
      "approval actor must be 1 to 128 characters without control characters",
    );
  }
  return actor;
}

function normalizeReason(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const reason = input.trim();
  if (reason.length === 0 || reason.length > 4096) {
    throw new ApprovalDecisionError(
      "invalid_reason",
      "approval denial reason must be 1 to 4096 characters when provided",
    );
  }
  return reason;
}

async function releaseAfterDecision<T>(
  store: RecoverableRunEventStore,
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  let releaseError: unknown;
  try {
    await store.release(runId);
  } catch (error) {
    releaseError = error;
  }

  if (operationError !== undefined) {
    if (releaseError !== undefined) {
      throw new AggregateError(
        [operationError, releaseError],
        `approval decision for run "${runId}" failed and ownership could not be released`,
      );
    }
    throw operationError;
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
  return result as T;
}
