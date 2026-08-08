import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  addRunResources,
  emptyRunResources,
  type RunResourceConsumption,
} from "../../../src/domain/run/budget.js";
import { parseRunEvent, type RunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";

describe("durable artifact budget replay", () => {
  it("counts only retained primary executor payloads using UTF-8 bytes", () => {
    const expectedArtifactBytes =
      11 + Buffer.byteLength(JSON.stringify({ verdict: "accepted", reason: "漢" }), "utf8");
    const state = reduceRunEvents([
      runStarted(100, ["command", "agent", "model-verifier", "command-verifier"]),
      nodeStarted(2, "command"),
      nodeSucceeded(3, "command", commandEvidence("é", "🙂")),
      nodeStarted(4, "agent"),
      nodeSucceeded(5, "agent", agentEvidence("å")),
      nodeStarted(6, "model-verifier"),
      nodeSucceeded(7, "model-verifier", modelVerifierEvidence("漢")),
      nodeStarted(8, "command-verifier"),
      nodeSucceeded(9, "command-verifier", commandVerifierEvidence("x", "ø")),
      { ...base(10), type: "run_succeeded" },
    ] as unknown as RunEvent[]);

    expect(state.resources.artifactBytes).toBe(expectedArtifactBytes);
    expect(state.budget).toMatchObject({
      limits: { maxArtifactBytes: 100 },
      remaining: { artifactBytes: 100 - expectedArtifactBytes },
      exhausted: [],
    });
  });

  it("charges committed failed evidence and settles equality", () => {
    const state = reduceRunEvents([
      runStarted(5, ["verify"]),
      nodeStarted(2, "verify"),
      {
        ...base(3),
        type: "node_failed",
        nodeId: "verify",
        attempt: 1,
        error: {
          code: "command_failed",
          message: "command failed after retaining output",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: commandEvidence("é", "abc", 1),
      },
      {
        ...base(4),
        type: "run_budget_exhausted",
        exhausted: [{ dimension: "artifactBytes", limit: 5, consumed: 5 }],
      },
    ] as unknown as RunEvent[]);

    expect(state).toMatchObject({
      status: "resource_exhausted",
      resources: { artifactBytes: 5 },
      budget: {
        remaining: { artifactBytes: 0 },
        exhausted: [{ dimension: "artifactBytes", limit: 5, consumed: 5 }],
      },
    });
  });

  it("accepts durable exhaustion events containing all five resource dimensions", () => {
    const event = parseRunEvent({
      ...base(4),
      type: "run_budget_exhausted",
      exhausted: [
        { dimension: "nodeStarts", limit: 1, consumed: 1 },
        { dimension: "modelTokens", limit: 1, consumed: 1 },
        { dimension: "modelCostUsdMicros", limit: 1, consumed: 1 },
        { dimension: "executionMs", limit: 1, consumed: 1 },
        { dimension: "artifactBytes", limit: 1, consumed: 1 },
      ],
    });

    expect(event.type === "run_budget_exhausted" ? event.exhausted : []).toHaveLength(5);
  });

  it("counts missing failed evidence as zero", () => {
    const state = reduceRunEvents([
      runStarted(10, ["verify"]),
      nodeStarted(2, "verify"),
      {
        ...base(3),
        type: "node_failed",
        nodeId: "verify",
        attempt: 1,
        error: {
          code: "executor_unavailable",
          message: "executor failed before producing evidence",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: null,
      },
    ] as unknown as RunEvent[]);

    expect(state.resources.artifactBytes).toBe(0);
  });

  it("does not charge verifier metadata when command execution produced no evidence", () => {
    const reason = "command executor failed before producing evidence";
    const started = runStarted(10, ["verify"]);
    const state = reduceRunEvents([
      {
        ...started,
        controlGraph: {
          nodes: [
            {
              nodeId: "verify",
              type: "verifier",
              dependsOn: [],
              verifier: {
                kind: "command",
                command: { executable: "node", args: ["verify"], timeoutMs: 60_000 },
              },
            },
          ],
        },
      },
      nodeStarted(2, "verify"),
      {
        ...base(3),
        type: "node_failed",
        nodeId: "verify",
        attempt: 1,
        error: {
          code: "verifier_inconclusive",
          message: reason,
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: {
          kind: "verifier",
          driver: "command",
          result: "execution_failed",
          verdict: "inconclusive",
          reason,
          reasonHash: sha256(reason),
          durationMs: 0,
          sources: [],
          command: null,
        },
      },
    ] as unknown as RunEvent[]);

    expect(state.resources.artifactBytes).toBe(0);
    expect(state.budget).toMatchObject({ remaining: { artifactBytes: 10 }, exhausted: [] });
  });

  it("rejects a forged artifact exhaustion projection", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(2, ["verify"]),
        nodeStarted(2, "verify"),
        nodeSucceeded(3, "verify", commandEvidence("é", "")),
        {
          ...base(4),
          type: "run_budget_exhausted",
          exhausted: [{ dimension: "artifactBytes", limit: 2, consumed: 1 }],
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/does not match/i);
  });

  it("fails closed when artifact aggregation exceeds a safe integer", () => {
    const saturated = addRunResources(emptyRunResources(), {
      artifactBytes: Number.MAX_SAFE_INTEGER,
    } as Partial<RunResourceConsumption>);

    expect(() =>
      addRunResources(saturated, { artifactBytes: 1 } as Partial<RunResourceConsumption>),
    ).toThrowError(/artifactBytes.*overflow|safe integer/i);
  });

  it("normalizes historical child evidence without artifact bytes to zero", () => {
    const parsed = parseRunEvent({
      ...base(3),
      type: "node_succeeded",
      nodeId: "delegate",
      attempt: 1,
      evidence: {
        kind: "child",
        childRunId: "child-run",
        workflowId: "child-workflow",
        workflowDigest: "c".repeat(64),
        terminalSequence: 4,
        outcome: "failed",
        result: null,
        resources: {
          nodeStarts: 1,
          modelTokens: 2,
          modelCostUsdMicros: 3,
          executionMs: 4,
        },
        durationMs: 4,
        workspace: {
          backend: "reflink-copy-v1",
          snapshotDigest: "d".repeat(64),
          disposition: "discarded",
        },
      },
    });

    expect(
      parsed.type === "node_succeeded" && parsed.evidence.kind === "child"
        ? parsed.evidence.resources.artifactBytes
        : undefined,
    ).toBe(0);
  });
});

function runStarted(maxArtifactBytes: number, nodeIds: readonly string[]) {
  return {
    ...base(1),
    type: "run_started",
    nodeIds,
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "a".repeat(64),
    budget: { maxArtifactBytes },
    controlGraph: { nodes: nodeIds.map(controlNode) },
  };
}

function controlNode(nodeId: string) {
  switch (nodeId) {
    case "agent":
      return { nodeId, type: "agent" as const, dependsOn: ["command"] };
    case "model-verifier":
      return {
        nodeId,
        type: "verifier" as const,
        dependsOn: ["command", "agent"],
        verifier: {
          kind: "model" as const,
          prompt: "Review the retained evidence.",
          evidence: [{ nodeId: "command", field: "command.stdout" as const }],
          model: { provider: "test-provider", id: "test-model", thinking: "medium" as const },
          timeoutMs: 60_000,
        },
      };
    case "command-verifier":
      return {
        nodeId,
        type: "verifier" as const,
        dependsOn: ["model-verifier"],
        verifier: {
          kind: "command" as const,
          command: { executable: "node", args: ["verify"], timeoutMs: 60_000 },
        },
      };
    default:
      return { nodeId, type: "command" as const, dependsOn: [] };
  }
}

function nodeStarted(sequence: number, nodeId: string) {
  return { ...base(sequence), type: "node_started", nodeId, attempt: 1 };
}

function nodeSucceeded(sequence: number, nodeId: string, evidence: unknown) {
  return { ...base(sequence), type: "node_succeeded", nodeId, attempt: 1, evidence };
}

function commandEvidence(stdout: string, stderr: string, exitCode = 0) {
  return {
    kind: "command",
    executable: "node",
    args: ["verify"],
    exitCode,
    signal: null,
    stdout,
    stderr,
    stdoutHash: sha256(stdout),
    stderrHash: sha256(stderr),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function agentEvidence(text: string) {
  return {
    kind: "agent",
    provider: "test-provider",
    model: "test-model",
    text,
    textHash: sha256(text),
    textTruncated: false,
    durationMs: 1,
    policyDecisions: [],
    effectReceipts: [],
  };
}

function modelVerifierEvidence(reason: string) {
  const raw = JSON.stringify({ verdict: "accepted", reason });
  return {
    kind: "verifier",
    driver: "model",
    result: "parsed",
    verdict: "accepted",
    reason,
    reasonHash: sha256(reason),
    durationMs: 1,
    sources: [commandSource()],
    provider: "test-provider",
    model: "test-model",
    raw,
    rawHash: sha256(raw),
    rawTruncated: false,
  };
}

function commandVerifierEvidence(stdout: string, stderr: string) {
  const reason = "command exited with code 0";
  return {
    kind: "verifier",
    driver: "command",
    result: "completed",
    verdict: "accepted",
    reason,
    reasonHash: sha256(reason),
    durationMs: 1,
    sources: [],
    command: commandEvidence(stdout, stderr),
  };
}

function commandSource() {
  return {
    sourceNodeId: "command",
    sourceAttempt: 1,
    sourceField: "command.stdout",
    sourceHash: sha256("é"),
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-08T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId: "run-artifact-budget",
    workflowId: "workflow-artifact-budget",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
