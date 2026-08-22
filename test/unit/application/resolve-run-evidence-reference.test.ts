import { describe, expect, it, vi } from "vitest";

import {
  calculateRunEvidenceEventDigest,
  resolveRunEvidenceReferences,
  RunEvidenceAdmissionError,
} from "../../../src/application/resolve-run-evidence-reference.js";
import type { RunEvent } from "../../../src/domain/run/events.js";

describe("run evidence reference admission", () => {
  it("resolves, deduplicates, and sorts exact durable terminal events", async () => {
    const first = succeededEvent("proof-run", "implement", 1, 9, "PRIVATE_FIRST");
    const second = succeededEvent("proof-run", "implement", 2, 3, "PRIVATE_SECOND");
    const reader = { read: vi.fn(async () => [first, second]) };

    const references = await resolveRunEvidenceReferences(
      [
        { runId: "proof-run", nodeId: "implement", attempt: 2 },
        { runId: "proof-run", nodeId: "implement", attempt: 1 },
        { runId: "proof-run", nodeId: "implement", attempt: 2 },
      ],
      reader,
    );

    expect(reader.read).toHaveBeenCalledOnce();
    expect(references).toEqual([
      {
        runId: "proof-run",
        nodeId: "implement",
        attempt: 1,
        sequence: 9,
        eventDigest: calculateRunEvidenceEventDigest(first),
      },
      {
        runId: "proof-run",
        nodeId: "implement",
        attempt: 2,
        sequence: 3,
        eventDigest: calculateRunEvidenceEventDigest(second),
      },
    ]);
  });

  it("fails closed when an exact event is unavailable, ambiguous, or outside caller scope", async () => {
    const privateCanary = "PRIVATE_WRONG_SCOPE";
    const event = succeededEvent("proof-run", "implement", 1, 9, privateCanary);

    for (const events of [[], [event, event]]) {
      await expect(
        resolveRunEvidenceReferences([{ runId: "proof-run", nodeId: "implement", attempt: 1 }], {
          read: async () => events,
        }),
      ).rejects.toMatchObject({ code: "evidence_unavailable" });
    }

    const error = await resolveRunEvidenceReferences(
      [{ runId: "proof-run", nodeId: "implement", attempt: 1 }],
      { read: async () => [event] },
      { acceptEvent: (candidate) => candidate.workflowId === "other-workflow" },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(RunEvidenceAdmissionError);
    expect(error).toMatchObject({ code: "evidence_unavailable" });
    expect((error as Error).message).toBe("run evidence is unavailable");
    expect(JSON.stringify(error)).not.toContain(privateCanary);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("preserves exact caller cancellation across a run-read boundary", async () => {
    const controller = new AbortController();
    const reason = new Error("PRIVATE_EXACT_CANCELLATION");

    await expect(
      resolveRunEvidenceReferences(
        [{ runId: "proof-run", nodeId: "implement", attempt: 1 }],
        {
          read: async () => {
            controller.abort(reason);
            return [succeededEvent("proof-run", "implement", 1, 9, "PRIVATE")];
          },
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
  });
});

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
    at: "2026-08-22T09:00:00.000Z",
    runId,
    workflowId: "memory-workflow",
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
