import { describe, expect, it } from "vitest";

import { aggregateEvaluation } from "../../../src/domain/evaluation/aggregate.js";
import { createEvaluationSchedule } from "../../../src/domain/evaluation/plan.js";
import {
  createEvaluationTrialRecord,
  type EvaluationTrialRecord,
  unavailableEvaluationMetrics,
} from "../../../src/domain/evaluation/records.js";

const planDigest = "a".repeat(64);

describe("evaluation aggregation", () => {
  it("keeps failures and missing trials in the scheduled denominator without inventing metrics", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11, 22],
    );
    const records = chain([
      trial(schedule[0], "accepted", { inputTokens: 10 }),
      trial(schedule[1], "rejected", { inputTokens: null }),
      trial(schedule[2], "harness_failure", {
        inputTokens: 20,
        recoveryOutcome: "failed",
      }),
    ]);

    const report = aggregateEvaluation(reportInput(schedule), records);

    expect(report.profiles.baseline).toMatchObject({
      scheduled: 2,
      committed: 1,
      missing: 1,
      verifiedSuccess: 1,
      verifiedSuccessRate: 0.5,
      falseCompletion: 0,
      costPerAcceptedResultUsdMicros: null,
    });
    expect(report.profiles.candidate).toMatchObject({
      scheduled: 2,
      committed: 2,
      missing: 0,
      verifiedSuccess: 0,
      falseCompletion: 1,
      falseCompletionRate: 0.5,
      harnessFailure: 1,
      costPerAcceptedResultUsdMicros: null,
    });
    const candidate = report.profiles.candidate;
    expect(candidate).toBeDefined();
    expect(candidate?.metrics.inputTokens).toEqual({
      available: 1,
      unavailable: 1,
      sum: 20,
      mean: 20,
    });
    expect(candidate?.metrics.recoveryOutcome).toEqual({
      available: 1,
      unavailable: 1,
      counts: { notAttempted: 0, succeeded: 0, failed: 1 },
    });
    expect(report.comparison).toMatchObject({
      verdict: "insufficient_evidence",
      scheduledPairs: 2,
      completePairs: 1,
    });
  });

  it("reports cost per accepted result only from complete available profile evidence", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11, 22],
    );
    const records = chain([
      trial(schedule[0], "accepted", { costUsdMicros: 50 }),
      trial(schedule[1], "accepted", { costUsdMicros: 200 }),
      trial(schedule[2], "harness_failure", { costUsdMicros: 300 }),
      trial(schedule[3], "rejected", { costUsdMicros: 100 }),
    ]);

    const report = aggregateEvaluation(reportInput(schedule), records);

    expect(report.profiles.baseline?.costPerAcceptedResultUsdMicros).toBe(150);
    expect(report.profiles.candidate?.costPerAcceptedResultUsdMicros).toBe(500);

    const unavailable = chain([
      trial(schedule[0], "accepted", { costUsdMicros: 50 }),
      trial(schedule[1], "accepted", { costUsdMicros: null }),
      trial(schedule[2], "harness_failure", { costUsdMicros: 300 }),
      trial(schedule[3], "rejected", { costUsdMicros: 100 }),
    ]);
    expect(
      aggregateEvaluation(reportInput(schedule), unavailable).profiles.candidate
        ?.costPerAcceptedResultUsdMicros,
    ).toBeNull();
  });

  it("produces superiority only for complete paired evidence above the uncertainty threshold", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11, 22, 33, 44],
    );
    const records = chain(
      schedule.map((item) =>
        trial(item, item.profileId === "candidate" ? "accepted" : "harness_failure", {
          policyViolations: 0,
        }),
      ),
    );

    const report = aggregateEvaluation(reportInput(schedule, 4), records);

    expect(report.comparison).toMatchObject({
      verdict: "superior",
      scheduledPairs: 4,
      completePairs: 4,
      pairedSuccessDelta: 1,
      confidenceInterval: { lower: 1, upper: 1, level: 0.95 },
    });
  });

  it("blocks a favorable success result when a declared safety constraint fails", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11, 22],
    );
    const records = chain(
      schedule.map((item) =>
        trial(item, item.profileId === "candidate" ? "accepted" : "harness_failure", {
          policyViolations: item.profileId === "candidate" ? 1 : 0,
        }),
      ),
    );

    const report = aggregateEvaluation(reportInput(schedule), records);

    expect(report.comparison).toMatchObject({
      verdict: "constraint_failed",
      constraints: { policyViolations: false },
    });
  });

  it("keeps a safety constraint unavailable until the candidate schedule is complete", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11],
    );
    const records = chain([trial(schedule[0], "accepted", { policyViolations: 0 })]);

    expect(aggregateEvaluation(reportInput(schedule, 1), records).comparison).toMatchObject({
      verdict: "insufficient_evidence",
      constraints: { policyViolations: null },
    });
  });

  it("rejects a re-digested record bound to the wrong private verifier", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11],
    );
    const record = trial(schedule[0], "accepted");
    const scheduled = schedule[0];
    if (scheduled === undefined) {
      throw new Error("test schedule is incomplete");
    }
    const wrongVerifier = createEvaluationTrialRecord({
      schedule: scheduled,
      planDigest,
      previousDigest: null,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      environment: record.environment,
      harness: record.harness,
      verification: { ...record.verification, verifierDigest: "f".repeat(64) },
      metrics: record.metrics,
    });

    expect(() => aggregateEvaluation(reportInput(schedule, 1), [wrongVerifier])).toThrow(
      /verifier.*digest|digest.*verifier/i,
    );
  });

  it("rejects re-digested runtime evidence for the wrong profile adapter", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11],
    );
    const scheduled = schedule[0];
    if (scheduled === undefined) {
      throw new Error("test schedule is incomplete");
    }
    const base = trial(scheduled, "accepted");
    const wrongRuntime = createEvaluationTrialRecord({
      schedule: scheduled,
      planDigest,
      previousDigest: null,
      startedAt: base.startedAt,
      completedAt: base.completedAt,
      environment: base.environment,
      harness: {
        ...base.harness,
        runtime: {
          adapter: "pi-native-v1",
          containment: "linux-pid-namespace",
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          treeTermination: "confirmed",
        },
      },
      verification: base.verification,
      metrics: base.metrics,
    });
    const input = {
      ...reportInput(schedule, 1),
      profileAdapters: {
        baseline: "omp-native-v1" as const,
        candidate: "flow-workflow-v1" as const,
      },
    };

    expect(() => aggregateEvaluation(input, [wrongRuntime])).toThrow(/profile adapter/i);
  });

  it("rejects a completed external trial without runtime evidence", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11],
    );
    const scheduled = schedule[0];
    if (scheduled === undefined) {
      throw new Error("test schedule is incomplete");
    }
    const base = trial(scheduled, "accepted");
    const missingRuntime = createEvaluationTrialRecord({
      schedule: scheduled,
      planDigest,
      previousDigest: null,
      startedAt: base.startedAt,
      completedAt: base.completedAt,
      environment: base.environment,
      harness: {
        outcome: "completed",
        runId: base.harness.runId,
        reason: null,
      },
      verification: base.verification,
      metrics: base.metrics,
    });
    const input = {
      ...reportInput(schedule, 1),
      profileAdapters: {
        baseline: "omp-native-v1" as const,
        candidate: "flow-workflow-v1" as const,
      },
    };

    expect(() => aggregateEvaluation(input, [missingRuntime])).toThrow(/profile adapter/i);
  });

  it("refuses superiority when paired runtime environments differ", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11, 22, 33, 44],
    );
    const records = chain(
      schedule.map((item) =>
        trial(
          item,
          item.profileId === "candidate" ? "accepted" : "harness_failure",
          { policyViolations: 0 },
          item.profileId === "candidate" ? { flowVersion: "0.0.1" } : {},
        ),
      ),
    );

    expect(aggregateEvaluation(reportInput(schedule, 4), records).comparison).toMatchObject({
      verdict: "insufficient_evidence",
      completePairs: 4,
      comparablePairs: 0,
    });
  });

  it("keeps tuning-only results descriptive rather than claiming superiority", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11, 22, 33, 44],
    );
    const records = chain(
      schedule.map((item) =>
        trial(item, item.profileId === "candidate" ? "accepted" : "harness_failure", {
          policyViolations: 0,
        }),
      ),
    );

    expect(
      aggregateEvaluation(reportInput(schedule, 1, "tuning"), records).comparison,
    ).toMatchObject({
      verdict: "insufficient_evidence",
      scheduledPairs: 0,
      completePairs: 0,
    });
  });

  it("produces a stable heterogeneous paired bootstrap interval and every verdict gate", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11, 22, 33, 44, 55, 66],
    );
    const pairOutcomes = [
      ["harness_failure", "accepted"],
      ["accepted", "accepted"],
      ["accepted", "harness_failure"],
      ["harness_failure", "accepted"],
      ["harness_failure", "accepted"],
      ["accepted", "accepted"],
    ] as const;
    const records = chain(
      schedule.map((item, index) => {
        const pair = pairOutcomes[Math.floor(index / 2)];
        if (pair === undefined) {
          throw new Error("test pair schedule is incomplete");
        }
        const outcome = item.profileId === "baseline" ? pair[0] : pair[1];
        return trial(item, outcome, { policyViolations: 0 });
      }),
    );

    const first = aggregateEvaluation(reportInput(schedule, 6), records);
    const second = aggregateEvaluation(reportInput(schedule, 6), records);
    expect(first.comparison.confidenceInterval).toEqual(second.comparison.confidenceInterval);
    expect(first.comparison).toMatchObject({
      pairedSuccessDelta: 1 / 3,
      confidenceInterval: { lower: -1 / 3, upper: 5 / 6, level: 0.95 },
    });
    expect(first.comparison.verdict).toBe("not_superior");
  });

  it.each([
    {
      name: "minimum paired sample",
      build: () => {
        const schedule = createEvaluationSchedule(
          planDigest,
          ["task-a"],
          ["baseline", "candidate"],
          [11, 22, 33, 44],
        );
        return {
          input: reportInput(schedule, 5),
          records: chain(
            schedule.map((item) =>
              trial(item, item.profileId === "candidate" ? "accepted" : "harness_failure", {
                policyViolations: 0,
              }),
            ),
          ),
          expected: { verdict: "insufficient_evidence" },
        };
      },
    },
    {
      name: "verifier error",
      build: () => {
        const schedule = createEvaluationSchedule(
          planDigest,
          ["task-a"],
          ["baseline", "candidate"],
          [11, 22, 33, 44],
        );
        return {
          input: reportInput(schedule, 4),
          records: chain(
            schedule.map((item, index) =>
              trial(
                item,
                item.profileId === "candidate"
                  ? index === 1
                    ? "verifier_error"
                    : "accepted"
                  : "harness_failure",
                { policyViolations: 0 },
              ),
            ),
          ),
          expected: { verdict: "insufficient_evidence" },
        };
      },
    },
    {
      name: "false-completion ceiling",
      build: () => {
        const schedule = createEvaluationSchedule(
          planDigest,
          ["task-a"],
          ["baseline", "candidate"],
          [11, 22, 33, 44, 55, 66, 77, 88, 99, 111, 122, 133, 144, 155, 166, 177],
        );
        let candidateIndex = 0;
        return {
          input: reportInput(schedule, 8),
          records: chain(
            schedule.map((item) => {
              const outcome =
                item.profileId === "baseline"
                  ? "harness_failure"
                  : candidateIndex++ === 0
                    ? "rejected"
                    : "accepted";
              return trial(item, outcome, { policyViolations: 0 });
            }),
          ),
          expected: {
            verdict: "constraint_failed",
            constraints: { falseCompletionRate: false },
          },
        };
      },
    },
  ])("enforces the $name verdict gate", ({ build }) => {
    const { input, records, expected } = build();
    expect(aggregateEvaluation(input, records).comparison).toMatchObject(expected);
  });

  it("evaluates regression loss on regression pairs instead of the whole suite", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["holdout-task", "regression-task"],
      ["baseline", "candidate"],
      [11, 22, 33, 44],
    );
    const records = chain(
      schedule.map((item) =>
        trial(
          item,
          item.taskId === "holdout-task"
            ? item.profileId === "candidate"
              ? "accepted"
              : "harness_failure"
            : item.profileId === "baseline"
              ? "accepted"
              : "harness_failure",
          { policyViolations: 0 },
        ),
      ),
    );
    const input = {
      ...reportInput(schedule, 4),
      tasks: [
        {
          id: "holdout-task",
          partition: "holdout" as const,
          verifierDigest: "c".repeat(64),
          assertionCount: 1,
        },
        {
          id: "regression-task",
          partition: "regression" as const,
          verifierDigest: "c".repeat(64),
          assertionCount: 1,
        },
      ],
    };

    expect(aggregateEvaluation(input, records).comparison).toMatchObject({
      verdict: "constraint_failed",
      constraints: { verifiedSuccessRegression: false },
    });
  });

  it("qualifies two distinct ACP executors only from complete conforming paired evidence", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11, 22],
    );
    const records = chain(schedule.map((item) => qualificationTrial(item)));

    const report = aggregateEvaluation(qualificationReportInput(schedule), records);

    expect(report.qualification).toMatchObject({
      purpose: "acp-interoperability-v1",
      verdict: "qualified",
      requiredPairs: 2,
      scheduledPairs: 2,
      completePairs: 2,
      verifiedPairs: 2,
      workflowDigest: "8".repeat(64),
      outputVerification: { accepted: 4, rejected: 0, errors: 0 },
      profiles: {
        baseline: {
          executor: {
            capabilitySnapshotDigest: "3".repeat(64),
            agentName: "baseline-agent",
            agentDigest: "1".repeat(64),
          },
          usage: { modelTokensComplete: 2, costUsdComplete: 2, incomplete: 0 },
        },
        candidate: {
          executor: {
            capabilitySnapshotDigest: "4".repeat(64),
            agentName: "candidate-agent",
            agentDigest: "2".repeat(64),
          },
          usage: { modelTokensComplete: 2, costUsdComplete: 2, incomplete: 0 },
        },
      },
      limitations: [],
    });
  });

  it.each([
    {
      name: "missing paired trial",
      records: (schedule: ReturnType<typeof createEvaluationSchedule>) =>
        chain(schedule.slice(0, -1).map((item) => qualificationTrial(item))),
      verdict: "insufficient_evidence",
      limitation: /missing/i,
    },
    {
      name: "incomplete accounting",
      records: (schedule: ReturnType<typeof createEvaluationSchedule>) =>
        chain(
          schedule.map((item, index) =>
            qualificationTrial(item, index === 0 ? { incompleteUsage: true } : {}),
          ),
        ),
      verdict: "insufficient_evidence",
      limitation: /accounting/i,
    },
    {
      name: "wrong result",
      records: (schedule: ReturnType<typeof createEvaluationSchedule>) =>
        chain(
          schedule.map((item, index) =>
            qualificationTrial(item, index === 0 ? { rejected: true } : {}),
          ),
        ),
      verdict: "not_qualified",
      limitation: /result/i,
    },
  ])(
    "reports $name without synthesizing qualification",
    ({ records: build, verdict, limitation }) => {
      const schedule = createEvaluationSchedule(
        planDigest,
        ["task-a"],
        ["baseline", "candidate"],
        [11, 22],
      );

      const report = aggregateEvaluation(qualificationReportInput(schedule), build(schedule));

      expect(report.qualification?.verdict).toBe(verdict);
      expect(report.qualification?.limitations).toEqual(
        expect.arrayContaining([expect.stringMatching(limitation)]),
      );
    },
  );

  it("rejects an ACP observation attributed to a different admitted executor", () => {
    const schedule = createEvaluationSchedule(
      planDigest,
      ["task-a"],
      ["baseline", "candidate"],
      [11, 22],
    );
    const input = {
      ...qualificationReportInput(schedule),
      profileAcpAgents: {
        baseline: { name: "baseline-agent", digest: "5".repeat(64) },
        candidate: { name: "candidate-agent", digest: "2".repeat(64) },
      },
    };

    expect(() =>
      aggregateEvaluation(input, chain(schedule.map((item) => qualificationTrial(item)))),
    ).toThrow(/contradicts.*admitted ACP identity/i);
  });
});

function trial(
  schedule: ReturnType<typeof createEvaluationSchedule>[number] | undefined,
  outcome: "accepted" | "rejected" | "harness_failure" | "verifier_error",
  metrics: Partial<ReturnType<typeof unavailableEvaluationMetrics>> = {},
  environment: Partial<EvaluationTrialRecord["environment"]> = {},
): EvaluationTrialRecord {
  if (schedule === undefined) {
    throw new Error("test schedule is incomplete");
  }
  return createEvaluationTrialRecord({
    schedule,
    planDigest,
    previousDigest: null,
    startedAt: "2026-08-09T00:00:00.000Z",
    completedAt: "2026-08-09T00:00:01.000Z",
    environment: {
      platform: "linux",
      architecture: "x64",
      nodeVersion: "22.19.0",
      flowVersion: "0.0.0",
      workspaceBackend: "reflink-copy-v1",
      workspaceSnapshotDigest: "b".repeat(64),
      ...environment,
    },
    harness:
      outcome === "harness_failure"
        ? { outcome: "failed", runId: null, reason: "runner failed" }
        : { outcome: "completed", runId: `run-${schedule.trialId.slice(6, 18)}`, reason: null },
    verification:
      outcome === "harness_failure"
        ? { outcome: "not_run", verifierDigest: "c".repeat(64), assertions: [] }
        : outcome === "verifier_error"
          ? {
              outcome: "error",
              verifierDigest: "c".repeat(64),
              assertions: [],
              reason: "verifier unavailable",
            }
          : {
              outcome,
              verifierDigest: "c".repeat(64),
              assertions: [{ kind: "exists", path: "RESULT.md", outcome: outcome === "accepted" }],
            },
    metrics: { ...unavailableEvaluationMetrics(), ...metrics },
  });
}

function qualificationTrial(
  schedule: ReturnType<typeof createEvaluationSchedule>[number] | undefined,
  options: { readonly incompleteUsage?: boolean; readonly rejected?: boolean } = {},
): EvaluationTrialRecord {
  if (schedule === undefined) throw new Error("test schedule is incomplete");
  const baseline = schedule.profileId === "baseline";
  const rejected = options.rejected === true;
  const observedSha256 = rejected ? "0".repeat(64) : "9".repeat(64);
  return createEvaluationTrialRecord({
    schedule,
    planDigest,
    previousDigest: null,
    startedAt: "2026-08-09T00:00:00.000Z",
    completedAt: "2026-08-09T00:00:01.000Z",
    environment: {
      platform: "linux",
      architecture: "x64",
      nodeVersion: "27.0.0",
      flowVersion: "0.1.0-alpha.1",
      workspaceBackend: "reflink-copy-v1",
      workspaceSnapshotDigest: "b".repeat(64),
    },
    harness: { outcome: "completed", runId: `run-${schedule.trialId.slice(6, 18)}`, reason: null },
    verification: {
      outcome: rejected ? "rejected" : "accepted",
      verifierDigest: "c".repeat(64),
      assertions: [
        {
          kind: "agent-result",
          outcome: !rejected,
          observedSha256,
          observedBytes: 10,
        },
      ],
    },
    metrics: unavailableEvaluationMetrics(),
    qualification: {
      version: 1,
      workflowDigest: "8".repeat(64),
      capabilitySnapshotDigest: (baseline ? "3" : "4").repeat(64),
      agent: {
        name: baseline ? "baseline-agent" : "candidate-agent",
        digest: (baseline ? "1" : "2").repeat(64),
      },
      result: { sha256: observedSha256, bytes: 10 },
      durationMs: 25,
      activity: { turns: 1, toolCalls: 0, toolErrors: 0 },
      policyViolations: 0,
      terminationStatus: "confirmed",
      processContainment: "linux-pid-namespace",
      sandbox: {
        backend: "anthropic-sandbox-runtime",
        backendVersion: "0.0.70",
        profile: "acp-prompt-only-v1",
        policyDigest: "7".repeat(64),
      },
      usage: {
        modelTokens: options.incompleteUsage
          ? { status: "unavailable" }
          : { status: "complete", totalTokens: 11 },
        costUsd: { status: "complete", costUsdMicros: 19 },
      },
      usageProvenance: {
        modelTokens: options.incompleteUsage ? "not-observed" : "prompt-response",
        costUsd: "session-usage-update",
      },
    },
  });
}

function chain(records: readonly EvaluationTrialRecord[]): readonly EvaluationTrialRecord[] {
  let previousDigest: string | null = null;
  return records.map((record) => {
    const chained = createEvaluationTrialRecord({
      schedule: {
        version: 1,
        position: record.position,
        trialId: record.trialId,
        taskId: record.taskId,
        profileId: record.profileId,
        seed: record.seed,
        repetition: record.repetition,
      },
      planDigest: record.planDigest,
      previousDigest,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      environment: record.environment,
      harness: record.harness,
      verification: record.verification,
      metrics: record.metrics,
      ...(record.qualification === undefined ? {} : { qualification: record.qualification }),
    });
    previousDigest = chained.recordDigest;
    return chained;
  });
}

function reportInput(
  schedule: ReturnType<typeof createEvaluationSchedule>,
  minimumPairedTrials = 2,
  partition: "tuning" | "regression" | "holdout" = "holdout",
) {
  return {
    planDigest,
    schedule,
    profileIds: ["baseline", "candidate"] as const,
    profileAdapters: {
      baseline: "flow-workflow-v1" as const,
      candidate: "flow-workflow-v1" as const,
    },
    tasks: [{ id: "task-a", partition, verifierDigest: "c".repeat(64), assertionCount: 1 }],
    comparison: {
      baselineProfileId: "baseline",
      candidateProfileId: "candidate",
      minimumPairedTrials,
      confidenceLevel: 0.95 as const,
      minimumEffect: 0,
      maxFalseCompletionRate: 0,
      maxPolicyViolations: 0,
      maxVerifiedSuccessRegression: 0,
    },
  };
}

function qualificationReportInput(schedule: ReturnType<typeof createEvaluationSchedule>) {
  return {
    ...reportInput(schedule),
    purpose: "acp-interoperability-v1" as const,
    profileWorkflowDigests: {
      baseline: "8".repeat(64),
      candidate: "8".repeat(64),
    },
    profileCapabilitySnapshotDigests: {
      baseline: "3".repeat(64),
      candidate: "4".repeat(64),
    },
    profileAcpAgents: {
      baseline: { name: "baseline-agent", digest: "1".repeat(64) },
      candidate: { name: "candidate-agent", digest: "2".repeat(64) },
    },
  };
}
