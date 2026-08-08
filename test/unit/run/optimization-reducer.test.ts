import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { calculateResultSchemaDigest } from "../../../src/domain/result/typed-result.js";
import {
  calculateChildRunId,
  calculateOptimizationPromotionId,
  parseRunEvent,
  type RunEvent,
  reduceRunEvents,
} from "../../../src/domain/run/events.js";
import {
  type CompiledResultSchema,
  MAX_OPTIMIZATION_DELTA_EVIDENCE_BYTES,
} from "../../../src/domain/workflow/types.js";

describe("durable optimization replay", () => {
  it("retains a successful optimization candidate workspace for its check", () => {
    const state = reduceRunEvents(throughCandidate());

    expect(state.nodes["optimize--c1--candidate"]).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "child",
        outcome: "succeeded",
        workspace: { disposition: "retained" },
      },
    });
  });

  it("keeps the ordinary child contract fail-closed for a retained workspace", () => {
    const events = throughCandidate();
    const startedEvent = events[0];
    if (startedEvent?.type !== "run_started" || startedEvent.controlGraph === undefined) {
      throw new Error("test fixture must start with a control graph");
    }
    const originalGraph = structuredClone(startedEvent.controlGraph);
    const candidate = originalGraph.nodes[2];
    if (candidate?.type !== "child") {
      throw new Error("test fixture candidate must be a child node");
    }
    const { optimizationCandidate: _optimizationCandidate, ...ordinaryCandidate } = candidate;
    const graph = {
      nodes: [originalGraph.nodes[0], originalGraph.nodes[1], ordinaryCandidate],
    };

    expect(() =>
      reduceRunEvents([
        {
          ...startedEvent,
          nodeIds: ["measure", "baseline", candidate.nodeId],
          controlGraph: graph,
        },
        ...events.slice(1),
      ] as RunEvent[]),
    ).toThrowError(/successful child.*discarded workspace/i);
  });

  it("replays evaluation, promotion, cleanup, check, and controller boundaries", () => {
    const state = reduceRunEvents(successfulOptimization());

    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        [checkNodeId]: {
          status: "succeeded",
          optimization: {
            decision: "promote",
            reason: "improved",
            preparedAt: "2026-08-08T00:00:08.000Z",
            settlement: { outcome: "committed", reason: "local_commit_durable" },
            cleanedAt: "2026-08-08T00:00:10.000Z",
          },
          control: {
            kind: "optimization-check",
            outcome: "accepted",
            bestMetric: 8,
            bestCandidate: 1,
            stagnation: 0,
            stop: false,
          },
        },
        optimize: {
          status: "succeeded",
          control: {
            kind: "optimization",
            completedCandidates: 1,
            bestMetric: 8,
            bestCandidate: 1,
            stopReason: "max_candidates",
          },
        },
      },
    });
  });

  it.each([
    ["candidate metric", { candidateMetric: 7 }, /candidate metric/i],
    ["best metric", { bestMetricBefore: 9 }, /best metric/i],
    ["stagnation", { stagnation: 1 }, /stagnation/i],
    [
      "invariant observation",
      { candidateInvariants: [invariantObservation(false)] },
      /candidate metric|outcome/i,
    ],
    [
      "promotion baseline",
      { promotion: { ...promotionBoundary(), baselineSnapshotDigest: "f".repeat(64) } },
      /promotion|boundary/i,
    ],
    [
      "delta entries",
      {
        deltaEntries: candidateDeltaEntries().map((entry, index) =>
          index === 0
            ? {
                ...entry,
                after: { kind: "file" as const, mode: 0o644, size: 65, sha256: "1".repeat(64) },
              }
            : entry,
        ),
      },
      /promotion|boundary/i,
    ],
  ])("rejects a forged optimization %s", (_name, change, error) => {
    expect(() =>
      reduceRunEvents([
        ...throughCandidate(),
        { ...evaluated(7), ...change },
      ] as unknown as RunEvent[]),
    ).toThrowError(error);
  });

  it("rejects cleanup before a promoted candidate has a durable settlement", () => {
    expect(() =>
      reduceRunEvents([...throughCandidate(), evaluated(7), cleaned(8)] as unknown as RunEvent[]),
    ).toThrowError(/settlement|cleanup/i);
  });

  it("rejects a serialized delta manifest above the durable evidence ceiling", () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({
      path: `links/${String(index).padStart(3, "0")}`,
      before: { kind: "missing" as const },
      after: { kind: "symlink" as const, target: "x".repeat(4_096) },
    }));
    expect(Buffer.byteLength(JSON.stringify(entries), "utf8")).toBeGreaterThan(
      MAX_OPTIMIZATION_DELTA_EVIDENCE_BYTES,
    );

    expect(() =>
      parseRunEvent({
        ...evaluated(7),
        deltaEntries: entries,
      }),
    ).toThrowError(/serialized optimization delta evidence/i);
  });

  it("turns a failed candidate run into bounded rejection instead of failing the parent run", () => {
    const candidateEvents = throughCandidate();
    const candidateSettlement = candidateEvents.at(-1);
    if (
      candidateSettlement?.type !== "node_succeeded" ||
      candidateSettlement.evidence.kind !== "child"
    ) {
      throw new Error("test fixture must end with child success evidence");
    }
    const failedCandidate = {
      ...candidateSettlement,
      evidence: {
        ...candidateSettlement.evidence,
        outcome: "failed" as const,
        result: null,
        workspace: {
          ...candidateSettlement.evidence.workspace,
          disposition: "discarded" as const,
        },
      },
    };
    const evaluatedFailure = {
      ...evaluated(7),
      candidateOutcome: "failed" as const,
      candidateValueHash: null,
      candidateMetric: null,
      candidateInvariants: null,
      decision: "reject" as const,
      reason: "candidate_failed" as const,
      stagnation: 1,
      stop: true,
      promotion: null,
      deltaEntries: null,
    };
    const checkedFailure = {
      ...base(8),
      type: "node_optimization_checked" as const,
      nodeId: checkNodeId,
      attempt: 1 as const,
      optimizationId: "optimize",
      candidate: 1,
      outcome: "rejected" as const,
      reason: "candidate_failed" as const,
      bestValueHash: sha256('{"score":10,"tests-passed":true}'),
      bestMetric: 10,
      bestCandidate: null,
      stagnation: 1,
      stop: true,
    };

    const state = reduceRunEvents([
      ...candidateEvents.slice(0, -1),
      failedCandidate,
      evaluatedFailure,
      checkedFailure,
    ] as unknown as RunEvent[]);

    expect(state.nodes[checkNodeId]).toMatchObject({
      status: "succeeded",
      control: {
        kind: "optimization-check",
        outcome: "rejected",
        reason: "candidate_failed",
        stagnation: 1,
        stop: true,
      },
    });
  });
});

const resultSchema: CompiledResultSchema = {
  type: "object",
  properties: {
    score: { type: "number" },
    "tests-passed": { type: "boolean" },
  },
  required: ["score", "tests-passed"],
};
const resultSchemaDigest = calculateResultSchemaDigest(resultSchema);
const candidateNodeId = "optimize--c1--candidate";
const checkNodeId = "optimize--c1--check";
const childRunId = calculateChildRunId("optimization-run", candidateNodeId, 1);

function throughCandidate(): RunEvent[] {
  return [
    started(),
    { ...base(2), type: "node_started", nodeId: "measure", attempt: 1 },
    {
      ...base(3),
      type: "node_succeeded",
      nodeId: "measure",
      attempt: 1,
      evidence: commandEvidence('{"score":10,"tests-passed":true}'),
    },
    {
      ...base(4),
      type: "node_result_published",
      nodeId: "baseline",
      attempt: 1,
      sourceNodeId: "measure",
      sourceAttempt: 1,
      sourceField: "command.stdout",
      sourceHash: sha256('{"score":10,"tests-passed":true}'),
      schemaDigest: resultSchemaDigest,
      canonicalValue: '{"score":10,"tests-passed":true}',
      valueHash: sha256('{"score":10,"tests-passed":true}'),
    },
    {
      ...base(5),
      type: "node_started",
      nodeId: candidateNodeId,
      attempt: 1,
      child: childLink(),
    },
    {
      ...base(6),
      type: "node_succeeded",
      nodeId: candidateNodeId,
      attempt: 1,
      evidence: {
        kind: "child",
        childRunId,
        workflowId: "candidate",
        workflowDigest: "c".repeat(64),
        terminalSequence: 4,
        outcome: "succeeded",
        result: {
          nodeId: "publish",
          schemaDigest: resultSchemaDigest,
          canonicalValue: '{"score":8,"tests-passed":true}',
          valueHash: sha256('{"score":8,"tests-passed":true}'),
        },
        resources: {
          nodeStarts: 1,
          modelTokens: 0,
          modelCostUsdMicros: 0,
          executionMs: 2,
        },
        durationMs: 2,
        workspace: {
          backend: "reflink-copy-v1",
          snapshotDigest: "a".repeat(64),
          disposition: "retained",
        },
      },
    },
  ] as unknown as RunEvent[];
}

function successfulOptimization(): RunEvent[] {
  return [
    ...throughCandidate(),
    evaluated(7),
    {
      ...base(8),
      type: "node_optimization_promotion_prepared",
      nodeId: checkNodeId,
      attempt: 1,
      optimizationId: "optimize",
      candidate: 1,
      promotion: promotionBoundary(),
    },
    {
      ...base(9),
      type: "node_optimization_promotion_settled",
      nodeId: checkNodeId,
      attempt: 1,
      optimizationId: "optimize",
      candidate: 1,
      promotionId: promotionBoundary().promotionId,
      deltaDigest: promotionBoundary().deltaDigest,
      outcome: "committed",
      reason: "local_commit_durable",
    },
    cleaned(10),
    {
      ...base(11),
      type: "node_optimization_checked",
      nodeId: checkNodeId,
      attempt: 1,
      optimizationId: "optimize",
      candidate: 1,
      outcome: "accepted",
      reason: "improved",
      bestValueHash: sha256('{"score":8,"tests-passed":true}'),
      bestMetric: 8,
      bestCandidate: 1,
      stagnation: 0,
      stop: false,
    },
    {
      ...base(12),
      type: "node_optimization_completed",
      nodeId: "optimize",
      attempt: 1,
      completedCandidates: 1,
      terminatingCheckNodeId: checkNodeId,
      bestValueHash: sha256('{"score":8,"tests-passed":true}'),
      bestMetric: 8,
      bestCandidate: 1,
      stopReason: "max_candidates",
    },
    { ...base(13), type: "run_succeeded" },
  ] as unknown as RunEvent[];
}

function evaluated(sequence: number) {
  return {
    ...base(sequence),
    type: "node_optimization_evaluated" as const,
    nodeId: checkNodeId,
    attempt: 1 as const,
    optimizationId: "optimize",
    candidate: 1,
    candidateNodeId,
    baselineValueHash: sha256('{"score":10,"tests-passed":true}'),
    baselineMetric: 10,
    baselineInvariants: [invariantObservation(true)],
    bestValueHashBefore: sha256('{"score":10,"tests-passed":true}'),
    bestMetricBefore: 10,
    candidateOutcome: "succeeded" as const,
    candidateValueHash: sha256('{"score":8,"tests-passed":true}'),
    candidateMetric: 8,
    candidateInvariants: [invariantObservation(true)],
    decision: "promote" as const,
    reason: "improved" as const,
    stagnation: 0,
    stop: false,
    promotion: promotionBoundary(),
    deltaEntries: candidateDeltaEntries(),
  };
}

function cleaned(sequence: number) {
  return {
    ...base(sequence),
    type: "node_optimization_candidate_cleaned" as const,
    nodeId: checkNodeId,
    attempt: 1 as const,
    optimizationId: "optimize",
    candidate: 1,
    candidateNodeId,
    workspaceId: childRunId,
    reason: "promotion_settled" as const,
  };
}

function promotionBoundary() {
  const manifest = {
    version: 1 as const,
    workspaceId: childRunId,
    baselineSnapshotDigest: "a".repeat(64),
    candidateSnapshotDigest: "b".repeat(64),
    entryCount: 2,
    logicalBytes: 128,
    entries: candidateDeltaEntries(),
  };
  return {
    promotionId: calculateOptimizationPromotionId("optimization-run", checkNodeId),
    workspaceId: manifest.workspaceId,
    deltaDigest: sha256(JSON.stringify(manifest)),
    baselineSnapshotDigest: manifest.baselineSnapshotDigest,
    candidateSnapshotDigest: manifest.candidateSnapshotDigest,
    entryCount: manifest.entryCount,
    logicalBytes: manifest.logicalBytes,
  };
}

function candidateDeltaEntries() {
  return [
    {
      path: "a.txt",
      before: { kind: "missing" as const },
      after: { kind: "file" as const, mode: 0o644, size: 64, sha256: "1".repeat(64) },
    },
    {
      path: "b.txt",
      before: { kind: "file" as const, mode: 0o644, size: 64, sha256: "2".repeat(64) },
      after: { kind: "missing" as const },
    },
  ];
}

function invariantObservation(passed: boolean) {
  return {
    pointer: "/tests-passed",
    expected: true,
    actual: passed,
    passed,
  };
}

function started() {
  return {
    ...base(1),
    type: "run_started" as const,
    nodeIds: ["measure", "baseline", candidateNodeId, checkNodeId, "optimize"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1" as const,
    workflowDigest: "d".repeat(64),
    executionCwd: "/tmp/optimization",
    controlGraph: {
      nodes: [
        { nodeId: "measure", type: "command" as const, dependsOn: [] },
        {
          nodeId: "baseline",
          type: "result" as const,
          dependsOn: ["measure"],
          result: {
            source: { nodeId: "measure", field: "command.stdout" as const },
            schema: resultSchema,
            schemaDigest: resultSchemaDigest,
          },
        },
        {
          nodeId: candidateNodeId,
          type: "child" as const,
          dependsOn: ["baseline"],
          optimizationCandidate: {
            optimizationId: "optimize",
            candidate: 1,
            checkNodeId,
          },
          child: {
            workflowId: "candidate",
            workflowDigest: "c".repeat(64),
            resultNodeId: "publish",
            resultSchema,
            resultSchemaDigest,
          },
        },
        {
          nodeId: checkNodeId,
          type: "optimization-check" as const,
          dependsOn: [candidateNodeId],
          optimizationCheck: {
            optimizationId: "optimize",
            candidate: 1,
            candidateNodeId,
            baseline: { nodeId: "baseline", field: "result.value" as const },
            metric: { pointer: "/score", direction: "minimize" as const },
            invariants: [{ pointer: "/tests-passed", equals: true }],
            maxConsecutiveNonImproving: 1,
            rollback: "previous-best" as const,
          },
        },
        {
          nodeId: "optimize",
          type: "optimization" as const,
          dependsOn: [checkNodeId],
          optimization: {
            baseline: { nodeId: "baseline", field: "result.value" as const },
            baselineSchemaDigest: resultSchemaDigest,
            metric: { pointer: "/score", direction: "minimize" as const },
            invariants: [{ pointer: "/tests-passed", equals: true }],
            maxCandidates: 1,
            maxConsecutiveNonImproving: 1,
            rollback: "previous-best" as const,
            candidateNodeIds: [candidateNodeId],
            checkNodeIds: [checkNodeId],
          },
        },
      ],
    },
  };
}

function childLink() {
  return {
    runId: childRunId,
    workflowId: "candidate",
    workflowDigest: "c".repeat(64),
    resultNodeId: "publish",
    resultSchemaDigest,
    isolationBackend: "reflink-copy-v1" as const,
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

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-08T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId: "optimization-run",
    workflowId: "optimization-workflow",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
