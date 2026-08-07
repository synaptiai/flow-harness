import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { reduceRunEvents, type RunEvent } from "../../../src/domain/run/events.js";

describe("concurrent workflow replay", () => {
  it("keeps legacy runs at one active node", () => {
    const state = reduceRunEvents([runStarted(false), nodeStarted(2, "root")] as RunEvent[]);

    expect(state.concurrency).toEqual({ maxNodes: 1 });
    expect(() =>
      reduceRunEvents([
        runStarted(false),
        nodeStarted(2, "root"),
        nodeStarted(3, "left"),
      ] as RunEvent[]),
    ).toThrowError(/concurr|one node|capacity/i);
  });

  it("rejects concurrent run metadata without the durable dependency graph", () => {
    const { controlGraph: _controlGraph, ...startedWithoutGraph } = runStarted();

    expect(() => reduceRunEvents([startedWithoutGraph] as RunEvent[])).toThrowError(
      /concurr.*graph|graph.*concurr/i,
    );
  });

  it("replays a bounded concurrent wave and later dependency", () => {
    const state = reduceRunEvents([
      runStarted(),
      nodeStarted(2, "root"),
      nodeSucceeded(3, "root"),
      nodeStarted(4, "left"),
      nodeStarted(5, "right"),
      nodeSucceeded(6, "left"),
      nodeSucceeded(7, "right"),
      nodeStarted(8, "join"),
      nodeSucceeded(9, "join"),
      { ...base(10), type: "run_succeeded" },
    ] as RunEvent[]);

    expect(state).toMatchObject({
      status: "succeeded",
      concurrency: { maxNodes: 2 },
      resources: { nodeStarts: 4 },
      nodes: {
        left: { status: "succeeded" },
        right: { status: "succeeded" },
        join: { status: "succeeded" },
      },
    });
    expect(Object.isFrozen(state.concurrency)).toBe(true);
  });

  it("rejects a start above the durable node-concurrency limit", () => {
    expect(() =>
      reduceRunEvents([
        runStartedWithThirdReadyNode(),
        nodeStarted(2, "root"),
        nodeSucceeded(3, "root"),
        nodeStarted(4, "left"),
        nodeStarted(5, "right"),
        nodeStarted(6, "third"),
      ] as RunEvent[]),
    ).toThrowError(/concurr|capacity|running nodes/i);
  });

  it("rejects a concurrent start whose durable dependencies have not succeeded", () => {
    expect(() =>
      reduceRunEvents([runStarted(), nodeStarted(2, "left")] as RunEvent[]),
    ).toThrowError(/dependency.*root.*not.*succeeded/i);
  });

  it("requires concurrent outcomes in workflow declaration order", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        nodeStarted(2, "root"),
        nodeSucceeded(3, "root"),
        nodeStarted(4, "left"),
        nodeStarted(5, "right"),
        nodeSucceeded(6, "right"),
      ] as RunEvent[]),
    ).toThrowError(/outcome|completion|declaration|left/i);
  });

  it("quiesces every admitted node before recording one deterministic failure", () => {
    const state = reduceRunEvents([
      runStarted(),
      nodeStarted(2, "root"),
      nodeSucceeded(3, "root"),
      nodeStarted(4, "left"),
      nodeStarted(5, "right"),
      nodeFailed(6, "left", "left failed"),
      nodeFailed(7, "right", "right failed"),
      { ...base(8), type: "run_failed", failedNodeId: "left", reason: "left failed" },
    ] as RunEvent[]);

    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "left",
      nodes: {
        left: { status: "failed", error: { message: "left failed" } },
        right: { status: "failed", error: { message: "right failed" } },
        join: { status: "pending" },
      },
    });
  });

  it("rejects failure terminalization while an admitted sibling remains running", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        nodeStarted(2, "root"),
        nodeSucceeded(3, "root"),
        nodeStarted(4, "left"),
        nodeStarted(5, "right"),
        nodeFailed(6, "left", "left failed"),
        { ...base(7), type: "run_failed", failedNodeId: "left", reason: "left failed" },
      ] as RunEvent[]),
    ).toThrowError(/running|quiesc/i);
  });

  it("rejects a non-primary failure after a wave quiesces", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        nodeStarted(2, "root"),
        nodeSucceeded(3, "root"),
        nodeStarted(4, "left"),
        nodeStarted(5, "right"),
        nodeFailed(6, "left", "left failed"),
        nodeFailed(7, "right", "right failed"),
        { ...base(8), type: "run_failed", failedNodeId: "right", reason: "right failed" },
      ] as RunEvent[]),
    ).toThrowError(/primary|first|failed node.*right/i);
  });

  it("records the exact ordered failed-node set for concurrent cancellation", () => {
    const state = reduceRunEvents([
      runStarted(),
      nodeStarted(2, "root"),
      nodeSucceeded(3, "root"),
      nodeStarted(4, "left"),
      nodeStarted(5, "right"),
      nodeFailed(6, "left", "operator cancelled"),
      nodeFailed(7, "right", "operator cancelled"),
      {
        ...base(8),
        type: "run_cancelled",
        reason: "operator cancelled",
        cancelledNodeIds: ["left", "right"],
      },
    ] as unknown as RunEvent[]);

    expect(state).toMatchObject({
      status: "cancelled",
      failedNodeId: "left",
      failureReason: "operator cancelled",
    });
  });

  it("rejects a cancellation that supplies both singular and plural node projections", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        nodeStarted(2, "root"),
        nodeSucceeded(3, "root"),
        nodeStarted(4, "left"),
        nodeStarted(5, "right"),
        nodeFailed(6, "left", "operator cancelled"),
        nodeFailed(7, "right", "operator cancelled"),
        {
          ...base(8),
          type: "run_cancelled",
          reason: "operator cancelled",
          cancelledNodeId: "left",
          cancelledNodeIds: ["left", "right"],
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/either.*single|singular.*plural|both/i);
  });

  it("rejects a cancellation whose failed-node projection is incomplete", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        nodeStarted(2, "root"),
        nodeSucceeded(3, "root"),
        nodeStarted(4, "left"),
        nodeStarted(5, "right"),
        nodeFailed(6, "left", "operator cancelled"),
        nodeFailed(7, "right", "operator cancelled"),
        {
          ...base(8),
          type: "run_cancelled",
          reason: "operator cancelled",
          cancelledNodeIds: ["left"],
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/cancellation.*failed nodes|failed-node projection/i);
  });
});

function runStarted(concurrent = true) {
  return {
    ...base(1),
    type: "run_started",
    nodeIds: ["root", "left", "right", "join"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "a".repeat(64),
    ...(concurrent ? { concurrency: { maxNodes: 2 }, controlGraph: graph() } : {}),
  };
}

function graph() {
  return {
    nodes: [
      { nodeId: "root", type: "command", dependsOn: [] },
      { nodeId: "left", type: "command", dependsOn: ["root"] },
      { nodeId: "right", type: "command", dependsOn: ["root"] },
      { nodeId: "join", type: "command", dependsOn: ["left", "right"] },
    ],
  };
}

function runStartedWithThirdReadyNode() {
  return {
    ...runStarted(),
    nodeIds: ["root", "left", "right", "third", "join"],
    controlGraph: {
      nodes: [
        { nodeId: "root", type: "command", dependsOn: [] },
        { nodeId: "left", type: "command", dependsOn: ["root"] },
        { nodeId: "right", type: "command", dependsOn: ["root"] },
        { nodeId: "third", type: "command", dependsOn: ["root"] },
        { nodeId: "join", type: "command", dependsOn: ["left", "right", "third"] },
      ],
    },
  };
}

function nodeStarted(sequence: number, nodeId: string) {
  return { ...base(sequence), type: "node_started", nodeId, attempt: 1 };
}

function nodeSucceeded(sequence: number, nodeId: string) {
  return {
    ...base(sequence),
    type: "node_succeeded",
    nodeId,
    attempt: 1,
    evidence: commandEvidence(nodeId),
  };
}

function nodeFailed(sequence: number, nodeId: string, message: string) {
  return {
    ...base(sequence),
    type: "node_failed",
    nodeId,
    attempt: 1,
    error: {
      code: "command_failed",
      message,
      retryable: false,
      sideEffectStatus: "none",
    },
    evidence: { ...commandEvidence(nodeId), exitCode: 1 },
  };
}

function commandEvidence(nodeId: string) {
  const stdout = `${nodeId}\n`;
  return {
    kind: "command",
    executable: "node",
    args: [nodeId],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: sha256(stdout),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 10,
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-07T18:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId: "run-concurrent",
    workflowId: "concurrent-workflow",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
