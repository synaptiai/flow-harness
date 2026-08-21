import { describe, expect, it, vi } from "vitest";

import {
  calculateGoalWorkspaceRunEventDigest,
  GoalWorkspaceAdmissionError,
  prepareGoalWorkspaceRevision,
  resolveGoalWorkspaceEvidence,
} from "../../../src/application/goal-workspace.js";
import { parseGoalWorkspaceSourceText } from "../../../src/domain/goal/workspace.js";
import type { RunEvent } from "../../../src/domain/run/events.js";

describe("goal workspace admission", () => {
  it("resolves a verified fact to the exact durable evidence event", async () => {
    const event = succeededEvent("run-proof", "verify", 2, 7, "PRIVATE_EVIDENCE_PAYLOAD");
    const reader = { read: vi.fn(async () => [event]) };

    const references = await resolveGoalWorkspaceEvidence(source(), reader);

    expect(references).toEqual([
      {
        runId: "run-proof",
        nodeId: "verify",
        attempt: 2,
        sequence: 7,
        eventDigest: calculateGoalWorkspaceRunEventDigest(event),
      },
    ]);
    expect(reader.read).toHaveBeenCalledOnce();
  });

  it("reads each referenced run once and sorts resolved evidence", async () => {
    const reader = {
      read: vi.fn(async (runId: string) => [
        succeededEvent(runId, "z-node", 1, 3, "PRIVATE_Z"),
        succeededEvent(runId, "a-node", 1, 5, "PRIVATE_A"),
      ]),
    };
    const admitted = parseGoalWorkspaceSourceText(
      JSON.stringify({
        ...sourceValue(),
        verifiedFacts: [
          {
            id: "proofs",
            text: "Proofs exist.",
            evidence: [
              { runId: "same-run", nodeId: "z-node", attempt: 1 },
              { runId: "same-run", nodeId: "a-node", attempt: 1 },
            ],
          },
        ],
      }),
      "goal.json",
    );

    const references = await resolveGoalWorkspaceEvidence(admitted, reader);

    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(references.map((item) => item.nodeId)).toEqual(["a-node", "z-node"]);
  });

  it("resolves one evidence event once when multiple facts cite it", async () => {
    const event = succeededEvent("run-proof", "verify", 2, 7, "PRIVATE_SHARED_EVIDENCE");
    const reader = { read: vi.fn(async () => [event]) };
    const admitted = parseGoalWorkspaceSourceText(
      JSON.stringify({
        ...sourceValue(),
        verifiedFacts: [
          {
            id: "first-proof",
            text: "The first fact is established.",
            evidence: [{ runId: "run-proof", nodeId: "verify", attempt: 2 }],
          },
          {
            id: "second-proof",
            text: "The second fact uses the same evidence.",
            evidence: [{ runId: "run-proof", nodeId: "verify", attempt: 2 }],
          },
        ],
      }),
      "goal.json",
    );

    const prepared = await prepareGoalWorkspaceRevision({
      source: admitted,
      expected: null,
      at: "2026-08-21T12:00:00.000Z",
      runReader: reader,
    });

    expect(reader.read).toHaveBeenCalledOnce();
    expect(prepared.verifiedFacts).toHaveLength(2);
    expect(prepared.verifiedFacts[0]?.evidence).toEqual(prepared.verifiedFacts[1]?.evidence);
  });

  it.each([
    ["missing run", async () => Promise.reject(new Error("PRIVATE_MISSING_RUN"))],
    ["missing node", async () => [succeededEvent("run-proof", "other", 2, 7, "PRIVATE_NODE")]],
    ["failed without evidence", async () => [failedEventWithoutEvidence()]],
  ])("rejects unavailable evidence with a fixed private message: %s", async (_label, read) => {
    const privateCanary = "PRIVATE_MISSING_RUN PRIVATE_NODE PRIVATE_FAILURE";
    const error = await resolveGoalWorkspaceEvidence(source(), { read }).catch((caught) => caught);

    expect(error).toBeInstanceOf(GoalWorkspaceAdmissionError);
    expect(error).toMatchObject({ code: "evidence_unavailable" });
    expect((error as Error).message).toBe("goal workspace evidence is unavailable");
    for (const canary of privateCanary.split(" ")) {
      expect(JSON.stringify(error)).not.toContain(canary);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it("preserves exact caller cancellation after a run read boundary", async () => {
    const controller = new AbortController();
    const reason = new Error("PRIVATE_EXACT_CANCELLATION");
    const reader = {
      read: vi.fn(async () => {
        controller.abort(reason);
        return [succeededEvent("run-proof", "verify", 2, 7, "PRIVATE_EVIDENCE")];
      }),
    };

    await expect(resolveGoalWorkspaceEvidence(source(), reader, controller.signal)).rejects.toBe(
      reason,
    );
  });

  it("prepares the exact next revision from the expected identity", async () => {
    const event = succeededEvent("run-proof", "verify", 2, 7, "PRIVATE_EVIDENCE");
    const reader = { read: async () => [event] };

    const first = await prepareGoalWorkspaceRevision({
      source: source(),
      expected: null,
      at: "2026-08-21T12:00:00.000Z",
      runReader: reader,
    });
    const second = await prepareGoalWorkspaceRevision({
      source: source(),
      expected: { revision: first.revision, digest: first.digest },
      at: "2026-08-21T12:01:00.000Z",
      runReader: reader,
    });

    expect(first).toMatchObject({ revision: 1, previousDigest: null });
    expect(second).toMatchObject({ revision: 2, previousDigest: first.digest });
    expect(second.digest).not.toBe(first.digest);
  });
});

function source() {
  return parseGoalWorkspaceSourceText(JSON.stringify(sourceValue()), "goal.json");
}

function sourceValue() {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "GoalWorkspace",
    objective: "Deliver the harness.",
    facts: [],
    invariants: [{ id: "authority", text: "Criteria remain authoritative." }],
    verifiedFacts: [
      {
        id: "proof",
        text: "The proof passed.",
        evidence: [{ runId: "run-proof", nodeId: "verify", attempt: 2 }],
      },
    ],
    openQuestions: [],
    nextAction: { id: "continue", text: "Continue implementation." },
  };
}

function succeededEvent(
  runId: string,
  nodeId: string,
  attempt: number,
  sequence: number,
  stdout: string,
): RunEvent {
  return {
    version: 1,
    type: "node_succeeded",
    sequence,
    at: "2026-08-21T11:00:00.000Z",
    runId,
    workflowId: "workflow",
    nodeId,
    attempt,
    evidence: {
      kind: "command",
      executable: "node",
      args: [],
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      stdoutHash: "a".repeat(64),
      stderrHash: "b".repeat(64),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
    },
  };
}

function failedEventWithoutEvidence(): RunEvent {
  return {
    version: 1,
    type: "node_failed",
    sequence: 7,
    at: "2026-08-21T11:00:00.000Z",
    runId: "run-proof",
    workflowId: "workflow",
    nodeId: "verify",
    attempt: 2,
    error: {
      code: "PRIVATE_FAILURE",
      message: "PRIVATE_FAILURE_MESSAGE",
      retryable: false,
      sideEffectStatus: "none",
    },
    evidence: null,
  };
}
