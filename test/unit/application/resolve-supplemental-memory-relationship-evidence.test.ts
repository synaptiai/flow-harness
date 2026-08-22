import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { resolveSupplementalMemoryRelationshipEvidence } from "../../../src/application/resolve-supplemental-memory-relationship-evidence.js";
import { createEffectiveHarnessState } from "../../../src/domain/adaptation/effective-harness-state.js";
import { parseSupplementalMemoryCandidateText } from "../../../src/domain/adaptation/supplemental-memory-candidate.js";
import { calculateCapabilitySnapshotDigest } from "../../../src/domain/capability/agent-skills.js";
import type { RunEvent } from "../../../src/domain/run/events.js";
import { promptCandidateWorkflowText } from "../../fixtures/prompt-candidate-generation.js";

describe("supplemental-memory relationship evidence admission", () => {
  it("resolves exact evidence only for the compiled target workflow and agent", async () => {
    const baseline = baselineState();
    const source = relationshipSource(baseline);
    const event = succeededEvent(baseline.workflowId, "implement");
    const reader = { read: vi.fn(async () => [event]) };

    const references = await resolveSupplementalMemoryRelationshipEvidence(
      source,
      baseline,
      reader,
    );

    expect(reader.read).toHaveBeenCalledOnce();
    expect(references).toEqual([
      expect.objectContaining({
        runId: "proof-run",
        nodeId: "implement",
        attempt: 1,
        sequence: 7,
      }),
    ]);

    for (const rejected of [
      succeededEvent("other-workflow", "implement"),
      succeededEvent(baseline.workflowId, "other-agent"),
    ]) {
      await expect(
        resolveSupplementalMemoryRelationshipEvidence(source, baseline, {
          read: async () => [rejected],
        }),
      ).rejects.toMatchObject({ code: "evidence_unavailable" });
    }
  });

  it("returns no references and performs no reads when the candidate adds no relationships", async () => {
    const baseline = baselineState();
    const source = parseSupplementalMemoryCandidateText(
      JSON.stringify({
        ...baseDocument(baseline),
        relationships: {
          remove: [{ id: "old-link", beforeDigest: "f".repeat(64) }],
          add: [],
        },
      }),
    );
    const read = vi.fn(async () => []);

    await expect(
      resolveSupplementalMemoryRelationshipEvidence(source, baseline, { read }),
    ).resolves.toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

function relationshipSource(baseline: ReturnType<typeof baselineState>) {
  return parseSupplementalMemoryCandidateText(
    JSON.stringify({
      ...baseDocument(baseline),
      relationships: {
        remove: [],
        add: [
          {
            id: "supporting-link",
            predicate: "supports",
            from: { entryId: "reviewed-fixture", entrySha256: sha256("New reviewed fact.") },
            to: {
              entryId: "other-fact",
              entrySha256: baseline.supplementalMemory?.[0]?.sha256,
            },
            evidence: [{ runId: "proof-run", nodeId: "implement", attempt: 1 }],
          },
        ],
      },
    }),
  );
}

function baseDocument(baseline: ReturnType<typeof baselineState>) {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "SupplementalMemoryCandidate",
    metadata: { id: "reviewed-fixture", version: "1.0.0" },
    scope: {
      kind: "workflow-agent-memory",
      workflowId: baseline.workflowId,
      childPath: [],
      agentNodeId: "implement",
      entryId: "reviewed-fixture",
    },
    baseline: {
      stateDigest: baseline.stateDigest,
      workflowDigest: baseline.workflow.workflowDigest,
      packageClosureDigest: calculateCapabilitySnapshotDigest(baseline.packages),
    },
    change: { kind: "add", value: "New reviewed fact." },
  };
}

function baselineState() {
  return createEffectiveHarnessState({
    scopeDigest: "a".repeat(64),
    workflowSource: promptCandidateWorkflowText(),
    packages: [],
    supplementalMemory: [
      {
        id: "other-fact",
        target: {
          workflowId: "adaptive-workflow",
          childPath: [],
          agentNodeId: "implement",
        },
        content: "Existing reviewed fact.",
      },
    ],
  });
}

function succeededEvent(workflowId: string, nodeId: string): RunEvent {
  return {
    version: 1,
    type: "node_succeeded",
    sequence: 7,
    at: "2026-08-22T12:00:00.000Z",
    runId: "proof-run",
    workflowId,
    nodeId,
    attempt: 1,
    evidence: {
      kind: "command",
      executable: "node",
      args: [],
      exitCode: 0,
      signal: null,
      stdout: "PRIVATE_RELATIONSHIP_EVIDENCE",
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
