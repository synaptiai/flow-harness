import { describe, expect, it } from "vitest";

import {
  aggregateContextCompactionEvaluation,
  CONTEXT_COMPACTION_EVALUATION_MODES,
  ContextCompactionEvaluationPlanError,
  createContextCompactionEvaluationSchedule,
  parseContextCompactionEvaluationPlanText,
} from "../../../src/domain/evaluation/context-compaction-evaluation.js";
import {
  createEvaluationTrialRecord,
  type EvaluationTrialRecord,
  unavailableEvaluationMetrics,
} from "../../../src/domain/evaluation/records.js";

const digest = "a".repeat(64);

describe("context compaction evaluation plan", () => {
  it("admits holdout tasks and schedules every three-mode order in six-seed blocks", () => {
    const plan = parseContextCompactionEvaluationPlanText(planText());
    const schedule = createContextCompactionEvaluationSchedule(
      digest,
      plan.suite.tasks.map((task) => task.id),
      plan.seeds,
    );

    expect(plan.kind).toBe("ContextCompactionEvaluationPlan");
    expect(plan.modes).toEqual(CONTEXT_COMPACTION_EVALUATION_MODES);
    expect(schedule).toHaveLength(18);
    expect(
      Array.from({ length: 6 }, (_, index) =>
        schedule.slice(index * 3, index * 3 + 3).map((trial) => trial.profileId),
      ),
    ).toEqual([
      ["none", "references", "references-and-summary"],
      ["none", "references-and-summary", "references"],
      ["references", "none", "references-and-summary"],
      ["references", "references-and-summary", "none"],
      ["references-and-summary", "none", "references"],
      ["references-and-summary", "references", "none"],
    ]);
    for (const mode of CONTEXT_COMPACTION_EVALUATION_MODES) {
      expect(
        [0, 1, 2].map(
          (position) =>
            schedule.filter((trial, index) => trial.profileId === mode && index % 3 === position)
              .length,
        ),
      ).toEqual([2, 2, 2]);
    }
  });

  it.each([
    ["five seeds", planText().replace("  - 16\n", "")],
    ["non-holdout task", planText().replace("partition: holdout", "partition: regression")],
    [
      "missing constraint assertion",
      planText().replace("constraintAssertionIndexes: [0]", "constraintAssertionIndexes: []"),
    ],
    [
      "reordered modes",
      planText().replace(
        "modes: [none, references, references-and-summary]",
        "modes: [references, none, references-and-summary]",
      ),
    ],
  ])("rejects %s", (_label, source) => {
    expect(() => parseContextCompactionEvaluationPlanText(source)).toThrow(
      ContextCompactionEvaluationPlanError,
    );
  });

  it("reports all required measures and applies the hierarchical comparison", () => {
    const plan = parseContextCompactionEvaluationPlanText(planText());
    const schedule = createContextCompactionEvaluationSchedule(
      digest,
      plan.suite.tasks.map((task) => task.id),
      plan.seeds,
    );
    const records = recordsFor(schedule);

    const report = aggregateContextCompactionEvaluation(reportInput(plan, schedule), records);

    expect(report.productionActivation).toBe("not_authorized");
    expect(report.modes.none).toMatchObject({
      scheduled: 6,
      verifiedSuccess: 6,
      constraintRetention: { checked: 6, retained: 6, losses: 0 },
      totals: { tokens: 720, costUsdMicros: 60, latencyMs: 600 },
    });
    expect(report.modes["references-and-summary"].compaction).toEqual({
      providerRequestBytes: 6000,
      providerRequestEstimatedTokens: 1500,
      attempts: 6,
      accepted: 6,
      rejected: 0,
      interrupted: 0,
      summaryInputTokens: 60,
      summaryOutputTokens: 30,
      summaryCostUsdMicros: 6,
      artifactReopenAttempts: 6,
      artifactReopenSuccesses: 6,
    });
    expect(report.comparisons.referencesVsNone).toMatchObject({
      verdict: "passes",
      comparablePairs: 6,
      verifiedSuccessDelta: 0,
      totalTokenChangeRate: -0.25,
    });
    expect(report.comparisons.summaryVsReferences).toMatchObject({
      verdict: "passes",
      comparablePairs: 6,
      verifiedSuccessDelta: 0,
      totalTokenChangeRate: expect.closeTo(-1 / 9),
    });
  });

  it("does not evaluate summaries when references lose a protected constraint", () => {
    const plan = parseContextCompactionEvaluationPlanText(planText());
    const schedule = createContextCompactionEvaluationSchedule(
      digest,
      plan.suite.tasks.map((task) => task.id),
      plan.seeds,
    );
    const records = recordsFor(schedule, "references");

    const report = aggregateContextCompactionEvaluation(reportInput(plan, schedule), records);

    expect(report.comparisons.referencesVsNone.verdict).toBe("constraint_failed");
    expect(report.comparisons.summaryVsReferences).toEqual({
      verdict: "not_evaluated",
      reason: "references_vs_none_gate_failed",
    });
  });

  it("preserves unavailable compaction evidence for a harness failure", () => {
    const plan = parseContextCompactionEvaluationPlanText(planText());
    const schedule = createContextCompactionEvaluationSchedule(
      digest,
      plan.suite.tasks.map((task) => task.id),
      plan.seeds,
    );
    const report = aggregateContextCompactionEvaluation(
      reportInput(plan, schedule),
      recordsFor(schedule, undefined, "none"),
    );

    expect(report.modes.none).toMatchObject({
      harnessFailure: 6,
      totals: { tokens: null, costUsdMicros: null, latencyMs: null },
      compaction: null,
    });
    expect(report.comparisons.referencesVsNone.verdict).toBe("insufficient_evidence");
    expect(report.comparisons.summaryVsReferences).toEqual({
      verdict: "not_evaluated",
      reason: "references_vs_none_gate_failed",
    });
  });
});

function reportInput(
  plan: ReturnType<typeof parseContextCompactionEvaluationPlanText>,
  schedule: ReturnType<typeof createContextCompactionEvaluationSchedule>,
) {
  return {
    planDigest: digest,
    schedule,
    tasks: plan.suite.tasks.map((task) => ({
      id: task.id,
      verifierDigest: "c".repeat(64),
      assertionCount: task.verifier.assertions.length,
      constraintAssertionIndexes: task.constraintAssertionIndexes,
    })),
    comparison: plan.comparison,
  } as const;
}

function recordsFor(
  schedule: ReturnType<typeof createContextCompactionEvaluationSchedule>,
  failedConstraintMode?: string,
  unavailableMode?: string,
): readonly EvaluationTrialRecord[] {
  const records: EvaluationTrialRecord[] = [];
  let previousDigest: string | null = null;
  for (const trial of schedule) {
    const constraintRetained = trial.profileId !== failedConstraintMode;
    const totalTokens =
      trial.profileId === "none" ? 120 : trial.profileId === "references" ? 90 : 80;
    const evidenceUnavailable = trial.profileId === unavailableMode;
    const record = createEvaluationTrialRecord({
      schedule: trial,
      planDigest: digest,
      previousDigest,
      startedAt: "2026-08-22T00:00:00.000Z",
      completedAt: "2026-08-22T00:00:01.000Z",
      environment: {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v27.0.0",
        flowVersion: "0.1.0-alpha.1",
        workspaceBackend: "reflink-copy-v1",
        workspaceSnapshotDigest: "d".repeat(64),
      },
      harness: evidenceUnavailable
        ? { outcome: "crashed", runId: null, reason: "interrupted after durable start" }
        : { outcome: "completed", runId: `eval-${trial.trialId}`, reason: null },
      verification: evidenceUnavailable
        ? {
            outcome: "not_run",
            verifierDigest: "c".repeat(64),
            assertions: [],
          }
        : {
            outcome: constraintRetained ? "accepted" : "rejected",
            verifierDigest: "c".repeat(64),
            assertions: [
              {
                kind: "sha256",
                path: "release-policy.txt",
                outcome: constraintRetained,
                observedSha256: constraintRetained ? "b".repeat(64) : "e".repeat(64),
              },
            ],
          },
      metrics: evidenceUnavailable
        ? unavailableEvaluationMetrics()
        : {
            costUsdMicros: 10,
            inputTokens: totalTokens - 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 20,
            turns: 3,
            toolCalls: 2,
            toolErrors: 0,
            wallTimeMs: 100,
            activeTimeMs: 90,
            interventions: 0,
            policyViolations: 0,
            recoveryAttempts: 0,
            recoveryOutcome: "not_attempted",
            contextCompaction: {
              mode: trial.profileId as "none" | "references" | "references-and-summary",
              providerRequestBytes: trial.profileId === "none" ? 2_000 : 1_000,
              providerRequestEstimatedTokens: trial.profileId === "none" ? 500 : 250,
              attempts: trial.profileId === "references-and-summary" ? 1 : 0,
              accepted: trial.profileId === "references-and-summary" ? 1 : 0,
              rejected: 0,
              interrupted: 0,
              summaryInputTokens: trial.profileId === "references-and-summary" ? 10 : 0,
              summaryOutputTokens: trial.profileId === "references-and-summary" ? 5 : 0,
              summaryCostUsdMicros: trial.profileId === "references-and-summary" ? 1 : 0,
              artifactReopenAttempts: 1,
              artifactReopenSuccesses: 1,
            },
          },
    });
    records.push(record);
    previousDigest = record.recordDigest;
  }
  return records;
}

function planText(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ContextCompactionEvaluationPlan
metadata:
  id: reference-first-compaction
suite:
  id: context-compaction-holdout
  version: 1.0.0
  tasks:
    - id: preserve-release-policy
      partition: holdout
      fixture: fixtures/release-policy
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions:
          - kind: sha256
            path: release-policy.txt
            value: ${"b".repeat(64)}
      protectedConstraints:
        - Never change release policy.
      constraintAssertionIndexes: [0]
profile:
  adapter: flow-workflow-v1
  workflow: workflows/agent.yaml
controls:
  model:
    provider: test-provider
    id: test-model
    thinking: low
  budget:
    maxNodeStarts: 8
    maxModelTokens: 100000
    maxCostUsdMicros: 1000000
    maxExecutionMs: 60000
    maxArtifactBytes: 1048576
  network: deny
  retry:
    providerRetries: 0
    harnessRetries: 0
  compaction:
    minimumReductionBytes: 1024
    summaryOutputTokenLimits: [512, 256]
seeds:
  - 11
  - 12
  - 13
  - 14
  - 15
  - 16
modes: [none, references, references-and-summary]
order: six-order-balanced-v1
comparison:
  minimumPairedTrials: 6
  maxVerifiedSuccessRegression: 0
  maxTotalTokenIncreaseRate: 0.1
  maxConstraintLosses: 0
`;
}
