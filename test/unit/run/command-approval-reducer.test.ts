import { describe, expect, it } from "vitest";

import {
  calculateCommandApprovalOperationDigest,
  commandApprovalRequestId,
  type CommandApprovalOperation,
} from "../../../src/domain/approval/command-approval.js";
import {
  reduceRunEvents,
  type RunEvent,
  type RunStartedEvent,
} from "../../../src/domain/run/events.js";

describe("command approval run replay", () => {
  it("reconstructs an inspectable durable wait before a command starts", () => {
    const state = reduceRunEvents([requiredRunStarted(), approvalRequested(2)]);

    expect(state).toMatchObject({
      status: "waiting_for_approval",
      executionCwd: "/workspace",
      approvalRequirements: { verify: { grantTtlMs: 60000 } },
      nodes: {
        verify: {
          status: "pending",
          startedAt: null,
          approval: {
            status: "pending",
            requestId: "approval-2",
            attempt: 1,
            requestedAt: at(2),
            operation: commandOperation(),
            operationDigest: operationDigest(),
            grantTtlMs: 60000,
          },
        },
      },
    });
    expect(Object.isFrozen(state.nodes.verify?.approval)).toBe(true);
    expect(Object.isFrozen(state.nodes.verify?.approval?.operation)).toBe(true);
  });

  it("consumes one exact unexpired grant when the command starts", () => {
    const state = reduceRunEvents([
      requiredRunStarted(),
      approvalRequested(2),
      approvalGranted(3),
      commandStarted(4),
    ]);

    expect(state).toMatchObject({
      status: "running",
      nodes: {
        verify: {
          status: "running",
          attempt: 1,
          approval: {
            status: "consumed",
            actor: "operator:daniel",
            expiresAt: "2026-08-07T15:01:03.000Z",
            consumedAt: at(4),
          },
        },
      },
    });
  });

  it("returns an unused expired grant to a new durable request", () => {
    const state = reduceRunEvents([
      requiredRunStarted(1000),
      approvalRequested(2, 1000),
      approvalGranted(3, 1000, "2026-08-07T15:00:04.000Z"),
      approvalExpired(4),
      approvalRequested(5, 1000),
    ]);

    expect(state).toMatchObject({
      status: "waiting_for_approval",
      nodes: {
        verify: {
          status: "pending",
          approval: {
            status: "pending",
            requestId: "approval-5",
            requestedAt: at(5),
            grantTtlMs: 1000,
          },
        },
      },
    });
  });

  it("turns a denial into a side-effect-free failed node and terminal run", () => {
    const state = reduceRunEvents([
      requiredRunStarted(),
      approvalRequested(2),
      approvalDenied(3),
      {
        ...base(4),
        type: "run_failed",
        failedNodeId: "verify",
        reason: "command approval denied by operator:daniel: unsafe operation",
      },
    ]);

    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "verify",
      nodes: {
        verify: {
          status: "failed",
          attempt: 1,
          startedAt: null,
          finishedAt: at(3),
          evidence: null,
          error: {
            code: "command_approval_denied",
            retryable: false,
            sideEffectStatus: "none",
          },
          approval: {
            status: "denied",
            actor: "operator:daniel",
            reason: "unsafe operation",
          },
        },
      },
    });
  });

  it("keeps old runs approval-free and replayable", () => {
    const state = reduceRunEvents([
      legacyRunStarted(),
      { ...base(2), type: "node_started", nodeId: "verify", attempt: 1 },
    ]);

    expect(state).toMatchObject({
      status: "running",
      executionCwd: null,
      approvalRequirements: {},
      nodes: { verify: { status: "running", approval: null } },
    });
  });

  it("rejects every node start while the run is globally waiting", () => {
    const started: RunStartedEvent = {
      ...requiredRunStarted(),
      nodeIds: ["verify", "unrelated"],
    };

    expect(() =>
      reduceRunEvents([
        started,
        approvalRequested(2),
        { ...base(3), type: "node_started", nodeId: "unrelated", attempt: 1 },
      ]),
    ).toThrowError(/cannot start.*waiting for approval/i);
  });

  it("rejects a second request while another grant remains unconsumed", () => {
    const started: RunStartedEvent = {
      ...requiredRunStarted(),
      nodeIds: ["verify", "later"],
      approvalRequirements: [
        { nodeId: "verify", grantTtlMs: 60000 },
        { nodeId: "later", grantTtlMs: 60000 },
      ],
    };

    expect(() =>
      reduceRunEvents([
        started,
        approvalRequested(2),
        approvalGranted(3),
        {
          ...base(4),
          type: "command_approval_requested",
          nodeId: "later",
          attempt: 1,
          requestId: "approval-4",
          grantTtlMs: 60000,
          operation: commandOperation(),
          operationDigest: operationDigest(),
        },
      ]),
    ).toThrowError(/another approval grant remains unconsumed/i);
  });

  it.each([
    [
      "a request id not bound to its event sequence",
      () => [requiredRunStarted(), { ...approvalRequested(2), requestId: "approval-99" }],
      /request id.*sequence/i,
    ],
    [
      "a tampered operation",
      () => [
        requiredRunStarted(),
        {
          ...approvalRequested(2),
          operation: { ...commandOperation(), executable: "npm" },
        },
      ],
      /operation digest/i,
    ],
    [
      "a duplicate grant",
      () => [
        requiredRunStarted(),
        approvalRequested(2),
        approvalGranted(3),
        { ...approvalGranted(4), at: at(4) },
      ],
      /requires a waiting run|must be pending/i,
    ],
    [
      "a grant with a forged expiry",
      () => [
        requiredRunStarted(),
        approvalRequested(2),
        approvalGranted(3, 60000, "2026-08-07T16:00:00.000Z"),
      ],
      /expiry.*grant lifetime/i,
    ],
    [
      "a required command start without approval",
      () => [
        requiredRunStarted(),
        { ...base(2), type: "node_started", nodeId: "verify", attempt: 1 },
      ],
      /requires an approved request/i,
    ],
    [
      "a required command start while approval is pending",
      () => [requiredRunStarted(), approvalRequested(2), commandStarted(3)],
      /waiting for approval|requires an unexpired grant/i,
    ],
    [
      "a required command start at the expiry boundary",
      () => [
        requiredRunStarted(1000),
        approvalRequested(2, 1000),
        approvalGranted(3, 1000, "2026-08-07T15:00:04.000Z"),
        { ...commandStarted(4), at: "2026-08-07T15:00:04.000Z" },
      ],
      /grant expired/i,
    ],
    [
      "a required command start under a different attempt",
      () => [
        requiredRunStarted(),
        approvalRequested(2),
        approvalGranted(3),
        { ...commandStarted(4), attempt: 2 },
      ],
      /attempt.*does not match.*grant/i,
    ],
    [
      "approval metadata on an unguarded command",
      () => [
        legacyRunStarted(),
        {
          ...base(2),
          type: "node_started",
          nodeId: "verify",
          attempt: 1,
          approval: { requestId: "approval-1", operationDigest: operationDigest() },
        },
      ],
      /does not require approval/i,
    ],
  ] satisfies ReadonlyArray<[string, () => RunEvent[], RegExp]>)(
    "rejects %s",
    (_case, events, expected) => {
      expect(() => reduceRunEvents(events())).toThrowError(expected);
    },
  );

  it("rejects duplicate or unknown approval requirements at run start", () => {
    expect(() =>
      reduceRunEvents([
        {
          ...requiredRunStarted(),
          approvalRequirements: [
            { nodeId: "verify", grantTtlMs: 60000 },
            { nodeId: "verify", grantTtlMs: 60000 },
          ],
        },
      ]),
    ).toThrowError(/approval requirements.*unique/i);

    expect(() =>
      reduceRunEvents([
        {
          ...requiredRunStarted(),
          approvalRequirements: [{ nodeId: "absent", grantTtlMs: 60000 }],
        },
      ]),
    ).toThrowError(/approval requirement.*outside the run node set/i);
  });
});

function requiredRunStarted(grantTtlMs = 60000): RunStartedEvent {
  return {
    ...legacyRunStarted(),
    executionCwd: "/workspace",
    approvalRequirements: [{ nodeId: "verify", grantTtlMs }],
  };
}

function legacyRunStarted(): RunStartedEvent {
  return {
    ...base(1),
    type: "run_started",
    nodeIds: ["verify"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "a".repeat(64),
  };
}

function approvalRequested(sequence: number, grantTtlMs = 60000): RunEvent {
  return {
    ...base(sequence),
    type: "command_approval_requested",
    nodeId: "verify",
    attempt: 1,
    requestId: commandApprovalRequestId(sequence),
    grantTtlMs,
    operation: commandOperation(),
    operationDigest: operationDigest(),
  };
}

function approvalGranted(
  sequence: number,
  grantTtlMs = 60000,
  expiresAt = new Date(Date.parse(at(sequence)) + grantTtlMs).toISOString(),
): RunEvent {
  return {
    ...base(sequence),
    type: "command_approval_granted",
    nodeId: "verify",
    attempt: 1,
    requestId: "approval-2",
    operationDigest: operationDigest(),
    actor: "operator:daniel",
    expiresAt,
  };
}

function approvalDenied(sequence: number): RunEvent {
  return {
    ...base(sequence),
    type: "command_approval_denied",
    nodeId: "verify",
    attempt: 1,
    requestId: "approval-2",
    operationDigest: operationDigest(),
    actor: "operator:daniel",
    reason: "unsafe operation",
  };
}

function approvalExpired(sequence: number): RunEvent {
  return {
    ...base(sequence),
    type: "command_approval_expired",
    nodeId: "verify",
    attempt: 1,
    requestId: "approval-2",
    operationDigest: operationDigest(),
  };
}

function commandStarted(sequence: number): RunEvent {
  return {
    ...base(sequence),
    type: "node_started",
    nodeId: "verify",
    attempt: 1,
    approval: { requestId: "approval-2", operationDigest: operationDigest() },
  };
}

function commandOperation(): CommandApprovalOperation {
  return {
    version: 1,
    action: "process.execute",
    cwd: "/workspace",
    executable: "node",
    args: ["--version"],
    timeoutMs: 10000,
  };
}

function operationDigest(): string {
  return calculateCommandApprovalOperationDigest(commandOperation());
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: at(sequence),
    runId: "run-approval",
    workflowId: "approval-workflow",
  };
}

function at(sequence: number): string {
  return `2026-08-07T15:00:${String(sequence).padStart(2, "0")}.000Z`;
}
