import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  calculateWorkflowApprovalRequestDigest,
  workflowApprovalRequestId,
  type WorkflowApprovalRequest,
} from "../../../src/domain/approval/workflow-approval.js";
import { reduceRunEvents, type RunEvent } from "../../../src/domain/run/events.js";

describe("durable workflow approval replay", () => {
  it("reconstructs an exact request and immediate approval", () => {
    const state = reduceRunEvents([
      runStarted(),
      { ...base(2), type: "node_started", nodeId: "plan", attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "plan",
        attempt: 1,
        evidence: commandEvidence("verified plan"),
      },
      requestEvent(4),
      approvedEvent(5),
      { ...base(6), type: "node_started", nodeId: "verify", attempt: 1 },
      {
        ...base(7),
        type: "node_succeeded",
        nodeId: "verify",
        attempt: 1,
        evidence: commandEvidence("verified"),
      },
      { ...base(8), type: "run_succeeded" },
    ] as unknown as RunEvent[]);

    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 2 },
      nodes: {
        review: {
          status: "succeeded",
          attempt: 1,
          control: {
            kind: "approval",
            requestId: "approval-4",
            requestDigest: requestDigest(),
            actor: "operator:daniel",
          },
          workflowApproval: {
            status: "approved",
            request: { prompt: "Approve the verified plan." },
          },
        },
      },
    });
  });

  it.each([
    ["request id", { requestId: "approval-99" }, /request id/i],
    ["prompt", { request: { ...request(), prompt: "Forged prompt." } }, /request snapshot/i],
    [
      "source attempt",
      {
        request: {
          ...request(),
          evidence: [{ ...firstEvidence(), sourceAttempt: 2 }],
        },
      },
      /request snapshot/i,
    ],
    [
      "source hash",
      {
        request: {
          ...request(),
          evidence: [{ ...firstEvidence(), sourceHash: "f".repeat(64) }],
        },
      },
      /request snapshot/i,
    ],
    [
      "source field",
      {
        request: {
          ...request(),
          evidence: [{ ...firstEvidence(), sourceField: "command.stderr" }],
        },
      },
      /request snapshot/i,
    ],
    ["request digest", { requestDigest: "f".repeat(64) }, /request digest/i],
  ] as const)("rejects a forged %s", (_name, mutation, message) => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "plan", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "plan",
          attempt: 1,
          evidence: commandEvidence("verified plan"),
        },
        { ...requestEvent(4), ...mutation },
      ] as unknown as RunEvent[]),
    ).toThrowError(message);
  });

  it("records denial as an exact side-effect-free node failure", () => {
    const state = reduceRunEvents([
      runStarted(),
      { ...base(2), type: "node_started", nodeId: "plan", attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "plan",
        attempt: 1,
        evidence: commandEvidence("verified plan"),
      },
      requestEvent(4),
      deniedEvent(5),
      {
        ...base(6),
        type: "run_failed",
        failedNodeId: "review",
        reason: "workflow approval denied by operator:daniel: unsafe plan",
      },
    ] as unknown as RunEvent[]);

    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "review",
      nodes: {
        review: {
          status: "failed",
          error: {
            code: "workflow_approval_denied",
            retryable: false,
            sideEffectStatus: "none",
          },
          workflowApproval: { status: "denied", reason: "unsafe plan" },
        },
      },
    });
  });

  it("rejects requesting approval over truncated evidence", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "plan", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "plan",
          attempt: 1,
          evidence: { ...commandEvidence("verified plan"), stdoutTruncated: true },
        },
        requestEvent(4),
      ] as unknown as RunEvent[]),
    ).toThrowError(/evidence is truncated/i);
  });

  it("rejects a non-canonical request prompt instead of normalizing ledger authority", () => {
    const event = requestEvent(4);
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "plan", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "plan",
          attempt: 1,
          evidence: commandEvidence("verified plan"),
        },
        { ...event, request: { ...event.request, prompt: " Approve the verified plan. " } },
      ] as unknown as RunEvent[]),
    ).toThrowError(/surrounding whitespace/i);
  });

  it("rejects starting an approval control node through an executor", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "plan", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "plan",
          attempt: 1,
          evidence: commandEvidence("verified plan"),
        },
        { ...base(4), type: "node_started", nodeId: "review", attempt: 1 },
      ] as unknown as RunEvent[]),
    ).toThrowError(/control node.*cannot start/i);
  });

  it("lets cancellation terminalize the exact durable wait without a decision", () => {
    const state = reduceRunEvents([
      runStarted(),
      { ...base(2), type: "node_started", nodeId: "plan", attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "plan",
        attempt: 1,
        evidence: commandEvidence("verified plan"),
      },
      requestEvent(4),
      {
        ...base(5),
        type: "run_cancelled",
        reason: "operator cancelled review",
        actor: "operator:daniel",
        requestId: "019fd722-4144-7a72-9c86-6f9af022b2e8",
      },
    ] as unknown as RunEvent[]);

    expect(state).toMatchObject({
      status: "cancelled",
      nodes: { review: { status: "pending", workflowApproval: { status: "pending" } } },
    });
  });
});

function runStarted() {
  return {
    ...base(1),
    type: "run_started",
    nodeIds: ["plan", "review", "verify"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "d".repeat(64),
    controlGraph: {
      nodes: [
        { nodeId: "plan", type: "command", dependsOn: [] },
        {
          nodeId: "review",
          type: "approval",
          dependsOn: ["plan"],
          approval: {
            prompt: "Approve the verified plan.",
            evidence: [{ nodeId: "plan", field: "command.stdout" }],
          },
        },
        { nodeId: "verify", type: "command", dependsOn: ["review"] },
      ],
    },
  };
}

function request(): WorkflowApprovalRequest {
  return {
    version: 1,
    runId: "run-review",
    workflowId: "review-workflow",
    workflowDigest: "d".repeat(64),
    nodeId: "review",
    attempt: 1,
    prompt: "Approve the verified plan.",
    evidence: [
      {
        sourceNodeId: "plan",
        sourceAttempt: 1,
        sourceField: "command.stdout",
        sourceHash: sha256("verified plan"),
      },
    ],
  };
}

function requestDigest(): string {
  return calculateWorkflowApprovalRequestDigest(request());
}

function firstEvidence(): WorkflowApprovalRequest["evidence"][number] {
  const evidence = request().evidence[0];
  if (evidence === undefined) {
    throw new Error("expected workflow approval evidence");
  }
  return evidence;
}

function requestEvent(sequence: number) {
  return {
    ...base(sequence),
    type: "workflow_approval_requested",
    nodeId: "review",
    attempt: 1,
    requestId: workflowApprovalRequestId(sequence),
    request: request(),
    requestDigest: requestDigest(),
  };
}

function approvedEvent(sequence: number) {
  return {
    ...base(sequence),
    type: "workflow_approval_approved",
    nodeId: "review",
    attempt: 1,
    requestId: "approval-4",
    requestDigest: requestDigest(),
    actor: "operator:daniel",
  };
}

function deniedEvent(sequence: number) {
  return {
    ...base(sequence),
    type: "workflow_approval_denied",
    nodeId: "review",
    attempt: 1,
    requestId: "approval-4",
    requestDigest: requestDigest(),
    actor: "operator:daniel",
    reason: "unsafe plan",
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-07T21:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId: "run-review",
    workflowId: "review-workflow",
  };
}

function commandEvidence(stdout: string) {
  return {
    kind: "command" as const,
    executable: "node",
    args: ["--version"],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: sha256(stdout),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
