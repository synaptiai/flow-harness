import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { reduceRunEvents, type RunEvent } from "../../../src/domain/run/events.js";

describe("durable verifier replay", () => {
  it("accepts an integrity-checked command verifier and its goal criterion", () => {
    const state = reduceRunEvents([
      commandRunStarted(),
      started(2, "verify"),
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "verify",
        attempt: 1,
        evidence: commandVerifierEvidence("accepted"),
      },
      { ...base(4), type: "run_succeeded" },
    ] as unknown as RunEvent[]);

    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 1, executionMs: 7 },
      goal: {
        status: "accepted",
        criteria: {
          reviewed: {
            status: "accepted",
            decision: { nodeId: "verify", evidenceAvailable: true },
          },
        },
      },
      nodes: {
        verify: {
          status: "succeeded",
          evidence: { kind: "verifier", driver: "command", verdict: "accepted" },
        },
      },
    });
  });

  it("records a normal non-zero command verdict as rejected without weakening side-effect status", () => {
    const evidence = commandVerifierEvidence("rejected");
    const state = reduceRunEvents([
      commandRunStarted(),
      started(2, "verify"),
      {
        ...base(3),
        type: "node_failed",
        nodeId: "verify",
        attempt: 1,
        error: {
          code: "verifier_rejected",
          message: evidence.reason,
          retryable: false,
          sideEffectStatus: "uncertain",
        },
        evidence,
      },
      {
        ...base(4),
        type: "run_failed",
        failedNodeId: "verify",
        reason: evidence.reason,
      },
    ] as unknown as RunEvent[]);

    expect(state).toMatchObject({
      status: "failed",
      goal: { status: "not_accepted", criteria: { reviewed: { status: "rejected" } } },
      nodes: {
        verify: {
          status: "failed",
          error: { sideEffectStatus: "uncertain" },
          evidence: { verdict: "rejected" },
        },
      },
    });
  });

  it("accepts a committed command side-effect lower bound without relabeling it", () => {
    const evidence = commandVerifierEvidence("rejected");
    const state = reduceRunEvents([
      commandRunStarted(),
      started(2, "verify"),
      {
        ...base(3),
        type: "node_failed",
        nodeId: "verify",
        attempt: 1,
        error: {
          code: "verifier_rejected",
          message: evidence.reason,
          retryable: false,
          sideEffectStatus: "committed",
        },
        evidence,
      },
    ] as unknown as RunEvent[]);

    expect(state.nodes.verify?.error?.sideEffectStatus).toBe("committed");
  });

  it("replays an accepted evidence-isolated model verdict and accounts its usage", () => {
    const state = reduceRunEvents([
      modelRunStarted(),
      started(2, "source"),
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "source",
        attempt: 1,
        evidence: commandEvidence("verified input"),
      },
      started(4, "review"),
      {
        ...base(5),
        type: "node_succeeded",
        nodeId: "review",
        attempt: 1,
        evidence: modelVerifierEvidence("accepted"),
      },
      started(6, "finish"),
      {
        ...base(7),
        type: "node_succeeded",
        nodeId: "finish",
        attempt: 1,
        evidence: commandEvidence("done"),
      },
      { ...base(8), type: "run_succeeded" },
    ] as unknown as RunEvent[]);

    expect(state).toMatchObject({
      status: "succeeded",
      resources: {
        nodeStarts: 3,
        modelTokens: 10,
        modelCostUsdMicros: 23,
        executionMs: 19,
      },
      nodes: {
        review: {
          evidence: {
            kind: "verifier",
            driver: "model",
            verdict: "accepted",
            sources: [
              {
                sourceNodeId: "source",
                sourceAttempt: 1,
                sourceField: "command.stdout",
                sourceHash: sha256("verified input"),
              },
            ],
          },
        },
      },
    });
  });

  it.each([
    ["reason hash", { reasonHash: "f".repeat(64) }, /reason hash/i],
    ["raw hash", { rawHash: "f".repeat(64) }, /raw.*hash/i],
    [
      "source attempt",
      { sources: [{ ...sourceObservation(), sourceAttempt: 2 }] },
      /source.*attempt/i,
    ],
    [
      "source hash",
      { sources: [{ ...sourceObservation(), sourceHash: "f".repeat(64) }] },
      /source/i,
    ],
    ["source order", { sources: [] }, /source/i],
    ["driver", { driver: "command" }, /driver|schema/i],
  ] as const)("rejects a forged model verifier %s", (_name, mutation, message) => {
    expect(() =>
      reduceRunEvents([
        modelRunStarted(),
        started(2, "source"),
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "source",
          attempt: 1,
          evidence: commandEvidence("verified input"),
        },
        started(4, "review"),
        {
          ...base(5),
          type: "node_succeeded",
          nodeId: "review",
          attempt: 1,
          evidence: { ...modelVerifierEvidence("accepted"), ...mutation },
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(message);
  });

  it("rejects a model verifier bound to truncated source evidence", () => {
    const source = { ...commandEvidence("verified input"), stdoutTruncated: true };
    expect(() =>
      reduceRunEvents([
        modelRunStarted(),
        started(2, "source"),
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "source",
          attempt: 1,
          evidence: source,
        },
        started(4, "review"),
        {
          ...base(5),
          type: "node_succeeded",
          nodeId: "review",
          attempt: 1,
          evidence: modelVerifierEvidence("accepted"),
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/source.*truncated/i);
  });

  it("rejects duplicate keys in persisted model output", () => {
    const evidence = modelVerifierEvidence("accepted");
    const raw = `{"verdict":"rejected","verdict":"accepted","reason":"${evidence.reason}"}`;
    expect(() =>
      reduceRunEvents([
        modelRunStarted(),
        started(2, "source"),
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "source",
          attempt: 1,
          evidence: commandEvidence("verified input"),
        },
        started(4, "review"),
        {
          ...base(5),
          type: "node_succeeded",
          nodeId: "review",
          attempt: 1,
          evidence: { ...evidence, raw, rawHash: sha256(raw) },
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/strict verdict contract/i);
  });

  it("rejects a successful node carrying a non-accepted verifier verdict", () => {
    expect(() =>
      reduceRunEvents([
        commandRunStarted(),
        started(2, "verify"),
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "verify",
          attempt: 1,
          evidence: commandVerifierEvidence("rejected"),
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/successful verifier.*accepted/i);
  });

  it("rejects a forged deterministic command-verifier reason", () => {
    const evidence = commandVerifierEvidence("accepted");
    const reason = "a forged acceptance explanation";
    expect(() =>
      reduceRunEvents([
        commandRunStarted(),
        started(2, "verify"),
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "verify",
          attempt: 1,
          evidence: { ...evidence, reason, reasonHash: sha256(reason) },
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/command verifier reason/i);
  });

  it("rejects a failed node carrying accepted verifier evidence", () => {
    expect(() =>
      reduceRunEvents([
        commandRunStarted(),
        started(2, "verify"),
        {
          ...base(3),
          type: "node_failed",
          nodeId: "verify",
          attempt: 1,
          error: {
            code: "verifier_inconclusive",
            message: "forged failure",
            retryable: false,
            sideEffectStatus: "none",
          },
          evidence: commandVerifierEvidence("accepted"),
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/failed verifier.*accepted/i);
  });

  it("projects an inconclusive model verdict into an inconclusive criterion decision", () => {
    const evidence = modelVerifierEvidence("inconclusive");
    const state = reduceRunEvents([
      terminalModelRunStarted(),
      started(2, "source"),
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "source",
        attempt: 1,
        evidence: commandEvidence("verified input"),
      },
      started(4, "review"),
      {
        ...base(5),
        type: "node_failed",
        nodeId: "review",
        attempt: 1,
        error: {
          code: "verifier_inconclusive",
          message: evidence.reason,
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence,
      },
      { ...base(6), type: "run_failed", failedNodeId: "review", reason: evidence.reason },
    ] as unknown as RunEvent[]);

    expect(state.goal?.criteria.reviewed?.status).toBe("inconclusive");
  });
});

function commandRunStarted() {
  return {
    ...base(1),
    type: "run_started",
    nodeIds: ["verify"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "d".repeat(64),
    goal: goal("verify"),
    controlGraph: {
      nodes: [
        {
          nodeId: "verify",
          type: "verifier",
          dependsOn: [],
          verifier: {
            kind: "command",
            command: { executable: "node", args: ["--version"], timeoutMs: 60_000 },
          },
        },
      ],
    },
  };
}

function modelRunStarted() {
  return runStartedWithModel(["source", "review", "finish"]);
}

function terminalModelRunStarted() {
  return { ...runStartedWithModel(["source", "review"]), goal: goal("review") };
}

function runStartedWithModel(nodeIds: readonly string[]) {
  return {
    ...base(1),
    type: "run_started",
    nodeIds,
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "d".repeat(64),
    controlGraph: {
      nodes: [
        { nodeId: "source", type: "command", dependsOn: [] },
        {
          nodeId: "review",
          type: "verifier",
          dependsOn: ["source"],
          verifier: {
            kind: "model",
            prompt: "Review the exact evidence.",
            evidence: [{ nodeId: "source", field: "command.stdout" }],
            model: { provider: "test", id: "deterministic", thinking: "medium" },
            timeoutMs: 60_000,
          },
        },
        ...(nodeIds.includes("finish")
          ? [{ nodeId: "finish", type: "command", dependsOn: ["review"] }]
          : []),
      ],
    },
  };
}

function goal(verifierNodeId: string) {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    id: "reviewed-change",
    outcome: "The change is accepted.",
    criteria: [
      {
        id: "reviewed",
        description: "The verifier accepts the evidence.",
        verifierNodeId,
      },
    ],
  };
}

function commandVerifierEvidence(verdict: "accepted" | "rejected" | "inconclusive") {
  const command = commandEvidence(
    verdict === "accepted" ? "ok" : "not accepted",
    verdict === "accepted" ? 0 : verdict === "rejected" ? 1 : null,
  );
  const reason =
    verdict === "accepted"
      ? "command exited with code 0"
      : verdict === "rejected"
        ? "command exited with code 1"
        : "command execution was inconclusive";
  return {
    kind: "verifier",
    driver: "command",
    result: "completed",
    verdict,
    reason,
    reasonHash: sha256(reason),
    durationMs: command.durationMs,
    sources: [],
    command,
  };
}

function modelVerifierEvidence(verdict: "accepted" | "rejected" | "inconclusive") {
  const reason = `${verdict} by declared evidence`;
  const raw = JSON.stringify({ verdict, reason });
  return {
    kind: "verifier",
    driver: "model",
    result: "parsed",
    verdict,
    reason,
    reasonHash: sha256(reason),
    raw,
    rawHash: sha256(raw),
    rawTruncated: false,
    durationMs: 5,
    usage: {
      inputTokens: 4,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsdMicros: 23,
    },
    provider: "test",
    model: "deterministic",
    sources: [sourceObservation()],
  };
}

function sourceObservation() {
  return {
    sourceNodeId: "source",
    sourceAttempt: 1,
    sourceField: "command.stdout",
    sourceHash: sha256("verified input"),
  };
}

function commandEvidence(stdout: string, exitCode: number | null = 0) {
  return {
    kind: "command",
    executable: "node",
    args: ["--version"],
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: sha256(stdout),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: exitCode === null,
    durationMs: 7,
  };
}

function started(sequence: number, nodeId: string) {
  return { ...base(sequence), type: "node_started", nodeId, attempt: 1 };
}

function base(sequence: number) {
  return {
    version: 1,
    sequence,
    at: `2026-08-07T23:00:0${sequence}.000Z`,
    runId: "run-verifier",
    workflowId: "verifier-workflow",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
