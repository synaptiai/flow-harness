import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { reduceRunEvents, type RunEvent } from "../../../src/domain/run/events.js";

describe("bounded loop replay", () => {
  it("reconstructs an evidence-bound stop and loop completion", () => {
    const state = reduceRunEvents([
      runStarted(),
      { ...base(2), type: "node_started", nodeId: probeId, attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: probeId,
        attempt: 1,
        evidence: commandEvidence("pass"),
      },
      {
        ...base(4),
        type: "node_loop_checked",
        nodeId: checkId,
        attempt: 1,
        loopId: "repair",
        iteration: 1,
        sourceNodeId: probeId,
        sourceAttempt: 1,
        sourceField: "command.stdout",
        sourceHash: sha256("pass"),
        decision: "stop",
      },
      {
        ...base(5),
        type: "node_loop_completed",
        nodeId: "repair",
        attempt: 1,
        completedIterations: 1,
        terminatingCheckNodeId: checkId,
      },
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

    expect(state).toMatchObject({ status: "succeeded", lastSequence: 8 });
    expect(state.nodes[checkId]).toMatchObject({
      status: "succeeded",
      attempt: 1,
      control: {
        kind: "loop-check",
        loopId: "repair",
        iteration: 1,
        sourceNodeId: probeId,
        sourceAttempt: 1,
        sourceField: "command.stdout",
        sourceHash: sha256("pass"),
        decision: "stop",
      },
    });
    expect(state.nodes.repair).toMatchObject({
      status: "succeeded",
      attempt: 1,
      control: {
        kind: "loop",
        completedIterations: 1,
        terminatingCheckNodeId: checkId,
      },
    });
    expect(state.resources.nodeStarts).toBe(2);
  });

  it("omits every later iteration after the first durable stop decision", () => {
    const secondProbeId = "repair--i2--node--probe";
    const secondCheckId = "repair--i2--check";
    const state = reduceRunEvents([
      twoIterationRunStarted(),
      { ...base(2), type: "node_started", nodeId: probeId, attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: probeId,
        attempt: 1,
        evidence: commandEvidence("pass"),
      },
      loopChecked(4, checkId, 1, probeId, "stop"),
      {
        ...base(5),
        type: "node_omitted",
        nodeId: secondProbeId,
        reason: "loop_not_continued",
        loopId: "repair",
        iteration: 2,
        checkNodeId: checkId,
      },
      {
        ...base(6),
        type: "node_omitted",
        nodeId: secondCheckId,
        reason: "dependency_omitted",
        omittedDependencies: [secondProbeId],
      },
      {
        ...base(7),
        type: "node_loop_completed",
        nodeId: "repair",
        attempt: 1,
        completedIterations: 1,
        terminatingCheckNodeId: checkId,
      },
    ] as unknown as RunEvent[]);

    expect(state.nodes[secondProbeId]).toMatchObject({
      status: "omitted",
      omission: {
        reason: "loop_not_continued",
        loopId: "repair",
        iteration: 2,
        checkNodeId: checkId,
      },
    });
    expect(state.nodes[secondCheckId]).toMatchObject({
      status: "omitted",
      omission: { reason: "dependency_omitted", omittedDependencies: [secondProbeId] },
    });
    expect(state.nodes.repair).toMatchObject({ status: "succeeded" });
    expect(state.resources.nodeStarts).toBe(1);
  });

  it("fails closed when the final allowed iteration does not stop", () => {
    const state = reduceRunEvents([
      runStarted(),
      { ...base(2), type: "node_started", nodeId: probeId, attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: probeId,
        attempt: 1,
        evidence: commandEvidence("again"),
      },
      {
        ...loopChecked(4, checkId, 1, probeId, "continue"),
        sourceHash: sha256("again"),
      },
      {
        ...base(5),
        type: "node_control_failed",
        nodeId: "repair",
        attempt: 1,
        error: {
          code: "loop_limit_reached",
          message:
            'loop "repair" reached maximum 1 iterations without satisfying its stop condition',
          retryable: false,
          sideEffectStatus: "none",
        },
      },
    ] as unknown as RunEvent[]);

    expect(state.nodes.repair).toMatchObject({
      status: "failed",
      attempt: 1,
      error: { code: "loop_limit_reached", retryable: false, sideEffectStatus: "none" },
    });
  });

  it.each([
    ["source node", { sourceNodeId: "verify" }, /source node/i],
    ["source attempt", { sourceAttempt: 2 }, /source attempt/i],
    ["source field", { sourceField: "command.stderr" }, /source field/i],
    ["source hash", { sourceHash: "f".repeat(64) }, /source hash/i],
    ["decision", { decision: "continue" }, /decision .* durable source evidence/i],
  ] as const)("rejects a forged loop-check %s", (_name, mutation, message) => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: probeId, attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: probeId,
          attempt: 1,
          evidence: commandEvidence("pass"),
        },
        { ...loopChecked(4, checkId, 1, probeId, "stop"), ...mutation },
      ] as unknown as RunEvent[]),
    ).toThrowError(message);
  });

  it("rejects starting a later iteration after a durable stop", () => {
    const secondProbeId = "repair--i2--node--probe";
    expect(() =>
      reduceRunEvents([
        twoIterationRunStarted(),
        { ...base(2), type: "node_started", nodeId: probeId, attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: probeId,
          attempt: 1,
          evidence: commandEvidence("pass"),
        },
        loopChecked(4, checkId, 1, probeId, "stop"),
        { ...base(5), type: "node_started", nodeId: secondProbeId, attempt: 1 },
      ] as unknown as RunEvent[]),
    ).toThrowError(/prior loop check did not continue iteration 2/i);
  });

  it("rejects omitting a later iteration after a durable continue", () => {
    const secondProbeId = "repair--i2--node--probe";
    expect(() =>
      reduceRunEvents([
        twoIterationRunStarted(),
        { ...base(2), type: "node_started", nodeId: probeId, attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: probeId,
          attempt: 1,
          evidence: commandEvidence("again"),
        },
        {
          ...loopChecked(4, checkId, 1, probeId, "continue"),
          sourceHash: sha256("again"),
        },
        {
          ...base(5),
          type: "node_omitted",
          nodeId: secondProbeId,
          reason: "loop_not_continued",
          loopId: "repair",
          iteration: 2,
          checkNodeId: checkId,
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/prior loop check continued and cannot omit/i);
  });

  it("rejects loop completion without a stop decision", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: probeId, attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: probeId,
          attempt: 1,
          evidence: commandEvidence("again"),
        },
        {
          ...loopChecked(4, checkId, 1, probeId, "continue"),
          sourceHash: sha256("again"),
        },
        {
          ...base(5),
          type: "node_loop_completed",
          nodeId: "repair",
          attempt: 1,
          completedIterations: 1,
          terminatingCheckNodeId: checkId,
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/no successful stop decision/i);
  });

  it("rejects loop-limit failure before every check has continued", () => {
    expect(() =>
      reduceRunEvents([
        twoIterationRunStarted(),
        { ...base(2), type: "node_started", nodeId: probeId, attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: probeId,
          attempt: 1,
          evidence: commandEvidence("again"),
        },
        {
          ...loopChecked(4, checkId, 1, probeId, "continue"),
          sourceHash: sha256("again"),
        },
        loopLimitFailed(5, 2),
      ] as unknown as RunEvent[]),
    ).toThrowError(/dependency .* is not terminal/i);
  });

  it("rejects loop-limit failure after a successful stop", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: probeId, attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: probeId,
          attempt: 1,
          evidence: commandEvidence("pass"),
        },
        loopChecked(4, checkId, 1, probeId, "stop"),
        loopLimitFailed(5, 1),
      ] as unknown as RunEvent[]),
    ).toThrowError(/before every check durably continues/i);
  });

  it("rejects a loop check whose source lacks matching loop-instance identity", () => {
    const started = runStarted();
    expect(() =>
      reduceRunEvents([
        {
          ...started,
          controlGraph: {
            nodes: started.controlGraph.nodes.map((node) =>
              node.nodeId === probeId
                ? { nodeId: probeId, type: "command" as const, dependsOn: [] }
                : node,
            ),
          },
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/source must belong to the same loop iteration/i);
  });

  it("rejects a later loop iteration with no prior-check guard", () => {
    const started = twoIterationRunStarted();
    const secondProbeId = "repair--i2--node--probe";
    expect(() =>
      reduceRunEvents([
        {
          ...started,
          controlGraph: {
            nodes: started.controlGraph.nodes.map((node) =>
              node.nodeId === secondProbeId
                ? {
                    nodeId: node.nodeId,
                    type: node.type,
                    dependsOn: node.dependsOn,
                    loopInstance: node.loopInstance,
                  }
                : node,
            ),
          },
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/iteration 2 must have exactly one prior-check-guarded entry/i);
  });

  it("rejects loop-instance metadata outside its controller bound", () => {
    const started = runStarted();
    expect(() =>
      reduceRunEvents([
        {
          ...started,
          controlGraph: {
            nodes: started.controlGraph.nodes.map((node) =>
              node.nodeId === "verify"
                ? {
                    ...node,
                    loopInstance: {
                      loopId: "repair",
                      iteration: 2,
                      templateNodeId: "forged",
                    },
                  }
                : node,
            ),
          },
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/iteration is outside its controller bound/i);
  });

  it("rejects a loop check that is not registered by its controller", () => {
    const started = runStarted();
    const extraCheckId = "repair--unregistered-check";
    const nodes = started.controlGraph.nodes.flatMap((node) => {
      if (node.nodeId === checkId && node.type === "loop-check") {
        return [
          node,
          {
            ...node,
            nodeId: extraCheckId,
          },
        ];
      }
      if (node.nodeId === "verify") {
        return [{ ...node, dependsOn: ["repair", extraCheckId] }];
      }
      return [node];
    });

    expect(() =>
      reduceRunEvents([
        {
          ...started,
          nodeIds: nodes.map((node) => node.nodeId),
          controlGraph: { nodes },
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/loop check .* is not registered by its controller/i);
  });

  it("rejects structural drift between cloned loop-body iterations", () => {
    const started = twoIterationRunStarted();
    expect(() =>
      reduceRunEvents([
        {
          ...started,
          controlGraph: {
            nodes: started.controlGraph.nodes.map((node) => {
              if (node.nodeId === "repair--i2--node--probe") {
                return { ...node, type: "agent" as const };
              }
              if (
                node.nodeId === "repair--i2--check" &&
                node.type === "loop-check" &&
                node.loopCheck !== undefined
              ) {
                return {
                  ...node,
                  loopCheck: {
                    ...node.loopCheck,
                    source: { ...node.loopCheck.source, field: "agent.text" as const },
                  },
                };
              }
              return node;
            }),
          },
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/iteration 2 does not clone the same template structure/i);
  });

  it("rejects stop-contract drift between loop iterations", () => {
    const started = twoIterationRunStarted();
    expect(() =>
      reduceRunEvents([
        {
          ...started,
          controlGraph: {
            nodes: started.controlGraph.nodes.map((node) =>
              node.nodeId === "repair--i2--check" && node.type === "loop-check"
                ? { ...node, loopCheck: { ...node.loopCheck, equals: "different" } }
                : node,
            ),
          },
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/iteration 2 changes its stop contract/i);
  });

  it("rejects a loop omission carrying partial fields from another reason", () => {
    const secondProbeId = "repair--i2--node--probe";
    expect(() =>
      reduceRunEvents([
        twoIterationRunStarted(),
        { ...base(2), type: "node_started", nodeId: probeId, attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: probeId,
          attempt: 1,
          evidence: commandEvidence("pass"),
        },
        loopChecked(4, checkId, 1, probeId, "stop"),
        {
          ...base(5),
          type: "node_omitted",
          nodeId: secondProbeId,
          reason: "loop_not_continued",
          loopId: "repair",
          iteration: 2,
          checkNodeId: checkId,
          conditionId: "forged-partial-group",
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/loop omission requires only loop guard fields/i);
  });
});

const probeId = "repair--i1--node--probe";
const checkId = "repair--i1--check";

function runStarted() {
  return {
    ...base(1),
    type: "run_started",
    nodeIds: [probeId, checkId, "repair", "verify"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "d".repeat(64),
    controlGraph: {
      nodes: [
        {
          nodeId: probeId,
          type: "command",
          dependsOn: [],
          loopInstance: { loopId: "repair", iteration: 1, templateNodeId: "probe" },
        },
        {
          nodeId: checkId,
          type: "loop-check",
          dependsOn: [probeId],
          loopCheck: {
            loopId: "repair",
            iteration: 1,
            source: { nodeId: probeId, field: "command.stdout" },
            equals: "pass",
          },
        },
        {
          nodeId: "repair",
          type: "loop",
          dependsOn: [checkId],
          loop: { maxIterations: 1, checkNodeIds: [checkId] },
        },
        { nodeId: "verify", type: "command", dependsOn: ["repair"] },
      ],
    },
  };
}

function twoIterationRunStarted() {
  const secondProbeId = "repair--i2--node--probe";
  const secondCheckId = "repair--i2--check";
  return {
    ...base(1),
    type: "run_started",
    nodeIds: [probeId, checkId, secondProbeId, secondCheckId, "repair", "verify"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "e".repeat(64),
    controlGraph: {
      nodes: [
        {
          nodeId: probeId,
          type: "command",
          dependsOn: [],
          loopInstance: { loopId: "repair", iteration: 1, templateNodeId: "probe" },
        },
        {
          nodeId: checkId,
          type: "loop-check",
          dependsOn: [probeId],
          loopCheck: {
            loopId: "repair",
            iteration: 1,
            source: { nodeId: probeId, field: "command.stdout" },
            equals: "pass",
          },
        },
        {
          nodeId: secondProbeId,
          type: "command",
          dependsOn: [checkId],
          loopInstance: { loopId: "repair", iteration: 2, templateNodeId: "probe" },
          loopGuard: { loopId: "repair", iteration: 2, checkNodeId: checkId },
        },
        {
          nodeId: secondCheckId,
          type: "loop-check",
          dependsOn: [secondProbeId],
          loopCheck: {
            loopId: "repair",
            iteration: 2,
            source: { nodeId: secondProbeId, field: "command.stdout" },
            equals: "pass",
          },
        },
        {
          nodeId: "repair",
          type: "loop",
          dependsOn: [checkId, secondCheckId],
          loop: { maxIterations: 2, checkNodeIds: [checkId, secondCheckId] },
        },
        { nodeId: "verify", type: "command", dependsOn: ["repair"] },
      ],
    },
  };
}

function loopLimitFailed(sequence: number, maxIterations: number) {
  return {
    ...base(sequence),
    type: "node_control_failed",
    nodeId: "repair",
    attempt: 1,
    error: {
      code: "loop_limit_reached",
      message: `loop "repair" reached maximum ${maxIterations} iterations without satisfying its stop condition`,
      retryable: false,
      sideEffectStatus: "none",
    },
  };
}

function loopChecked(
  sequence: number,
  nodeId: string,
  iteration: number,
  sourceNodeId: string,
  decision: "stop" | "continue",
) {
  return {
    ...base(sequence),
    type: "node_loop_checked",
    nodeId,
    attempt: 1,
    loopId: "repair",
    iteration,
    sourceNodeId,
    sourceAttempt: 1,
    sourceField: "command.stdout",
    sourceHash: sha256("pass"),
    decision,
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-07T19:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId: "run-loop",
    workflowId: "bounded-loop",
  };
}

function commandEvidence(stdout: string) {
  return {
    kind: "command" as const,
    executable: "node",
    args: [],
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
