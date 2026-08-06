import { describe, expect, it } from "vitest";

import { RunReplayError, reduceRunEvents, type RunEvent } from "../../../src/domain/run/events.js";

describe("reduceRunEvents", () => {
  it("reconstructs a successful run from authoritative events", () => {
    const state = reduceRunEvents(successfulEvents());

    expect(state).toMatchObject({
      runId: "run-1",
      workflowId: "verify-foundation",
      status: "succeeded",
      lastSequence: 6,
    });
    expect(state.nodes["node-version"]).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(state.nodes.typecheck).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.nodes)).toBe(true);
  });

  it("rejects sequence gaps", () => {
    const events = successfulEvents().map((event) => ({ ...event })) as RunEvent[];
    const third = events[2];
    if (third !== undefined) {
      events[2] = { ...third, sequence: 4 };
    }

    expect(() => reduceRunEvents(events)).toThrowError(RunReplayError);
    expect(() => reduceRunEvents(events)).toThrowError(/expected sequence 3/i);
  });

  it("rejects node completion without a matching start", () => {
    const events: RunEvent[] = [
      runStarted(),
      {
        ...base(2),
        type: "node_succeeded",
        nodeId: "node-version",
        attempt: 1,
        evidence: commandEvidence(0),
      },
    ];

    expect(() => reduceRunEvents(events)).toThrowError(/must be running/i);
  });

  it("rejects run success while nodes remain incomplete", () => {
    const events: RunEvent[] = [
      runStarted(),
      { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "node-version",
        attempt: 1,
        evidence: commandEvidence(0),
      },
      { ...base(4), type: "run_succeeded" },
    ];

    expect(() => reduceRunEvents(events)).toThrowError(/not every node succeeded/i);
  });

  it("reconstructs cancellation between node attempts", () => {
    const state = reduceRunEvents([
      runStarted(),
      { ...base(2), type: "run_cancelled", reason: "operator cancelled" },
    ]);

    expect(state).toMatchObject({
      status: "cancelled",
      failureReason: "operator cancelled",
      failedNodeId: null,
      finishedAt: base(2).at,
    });
  });

  it("rejects cancellation while a node remains running", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        { ...base(3), type: "run_cancelled", reason: "operator cancelled" },
      ]),
    ).toThrowError(/node remains running/i);
  });
});

function successfulEvents(): RunEvent[] {
  return [
    runStarted(),
    { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
    {
      ...base(3),
      type: "node_succeeded",
      nodeId: "node-version",
      attempt: 1,
      evidence: commandEvidence(0),
    },
    { ...base(4), type: "node_started", nodeId: "typecheck", attempt: 1 },
    {
      ...base(5),
      type: "node_succeeded",
      nodeId: "typecheck",
      attempt: 1,
      evidence: commandEvidence(0),
    },
    { ...base(6), type: "run_succeeded" },
  ];
}

function runStarted(): RunEvent {
  return {
    ...base(1),
    type: "run_started",
    nodeIds: ["node-version", "typecheck"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "c".repeat(64),
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-06T15:00:0${sequence}.000Z`,
    runId: "run-1",
    workflowId: "verify-foundation",
  };
}

function commandEvidence(exitCode: number) {
  return {
    kind: "command" as const,
    executable: "node",
    args: ["--version"],
    exitCode,
    signal: null,
    stdout: "v22.19.0\n",
    stderr: "",
    stdoutHash: "a".repeat(64),
    stderrHash: "b".repeat(64),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 20,
  };
}
