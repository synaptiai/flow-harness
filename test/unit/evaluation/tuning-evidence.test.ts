import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  createEvaluationSchedule,
  type EvaluationTrialScheduleItem,
} from "../../../src/domain/evaluation/plan.js";
import {
  type CreateEvaluationTrialRecordInput,
  createEvaluationTrialRecord,
  type EvaluationTrialRecord,
} from "../../../src/domain/evaluation/records.js";
import {
  createTuningEvidencePacket,
  MAX_TUNING_EVIDENCE_BYTES,
  parseTuningEvidencePacket,
  TuningEvidenceError,
} from "../../../src/domain/evaluation/tuning-evidence.js";

const digest = "a".repeat(64);
const verifierDigest = "b".repeat(64);

describe("tuning evidence", () => {
  it("projects only bounded tuning outcomes and metrics into deterministic evidence", () => {
    const input = completeEvaluation();

    const first = createTuningEvidencePacket(input);
    const second = createTuningEvidencePacket(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: 1,
      kind: "flow.tuning-evidence/v1",
      evaluation: {
        id: "source-evaluation",
        planDigest: digest,
        completedTrials: 6,
        scheduledTrials: 6,
      },
      suite: { id: "adaptive-suite", version: "1.0.0" },
      profiles: [
        { id: "baseline", adapter: "flow-workflow-v1", workflowDigest: "c".repeat(64) },
        { id: "candidate", adapter: "flow-workflow-v1", workflowDigest: "d".repeat(64) },
      ],
      tasks: [
        {
          id: "tune-task",
          trials: [
            {
              profileId: "baseline",
              seed: 7,
              repetition: 1,
              classification: "verified_success",
              harness: { outcome: "completed", reason: null },
              verification: { outcome: "accepted" },
            },
            {
              profileId: "candidate",
              seed: 7,
              repetition: 1,
              classification: "verified_success",
              harness: { outcome: "completed", reason: null },
              verification: { outcome: "accepted" },
            },
          ],
        },
      ],
    });
    expect(first.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);

    const serialized = JSON.stringify(first);
    for (const forbidden of [
      "regression-secret",
      "holdout-secret",
      "run-secret",
      "trial-",
      "verifierDigest",
      "assertions",
      "recordDigest",
      "previousDigest",
      "position",
      "fixture",
      "instruction",
      "partition",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("retains an optional prior candidate identity without exposing its manifest", () => {
    const input = completeEvaluation();
    input.profiles[1] = {
      id: "candidate",
      adapter: "flow-workflow-v1",
      workflowDigest: "d".repeat(64),
      candidateDigest: "e".repeat(64),
    };

    expect(createTuningEvidencePacket(input).profiles[1]).toEqual({
      id: "candidate",
      adapter: "flow-workflow-v1",
      workflowDigest: "d".repeat(64),
      candidateDigest: "e".repeat(64),
    });
  });

  it("rejects incomplete evaluations and evaluations without tuning tasks", () => {
    const incomplete = completeEvaluation();
    incomplete.records.pop();
    expect(() => createTuningEvidencePacket(incomplete)).toThrowError(
      new TuningEvidenceError("evaluation must be complete before tuning evidence can be exported"),
    );

    const noTuning = completeEvaluation();
    noTuning.tasks = noTuning.tasks.map((task) => ({ ...task, partition: "holdout" as const }));
    expect(() => createTuningEvidencePacket(noTuning)).toThrowError(
      new TuningEvidenceError("evaluation does not contain a tuning task"),
    );
  });

  it("rejects schedule contradictions instead of exporting mismatched evidence", () => {
    const input = completeEvaluation();
    const record = input.records[0];
    if (record === undefined) {
      throw new Error("fixture record is missing");
    }
    input.records[0] = { ...record, profileId: "candidate" } as EvaluationTrialRecord;

    expect(() => createTuningEvidencePacket(input)).toThrowError(
      /record 1 contradicts the evaluation schedule/,
    );
  });

  it("parses only strict canonical packets and verifies their digest", () => {
    const packet = createTuningEvidencePacket(completeEvaluation());
    expect(parseTuningEvidencePacket(JSON.parse(JSON.stringify(packet)))).toEqual(packet);

    expect(() =>
      parseTuningEvidencePacket({ ...packet, evidenceDigest: "f".repeat(64) }),
    ).toThrowError(/digest does not match/);
    expect(() => parseTuningEvidencePacket({ ...packet, unexpected: true })).toThrowError(
      /invalid tuning evidence/,
    );
    expect(() =>
      parseTuningEvidencePacket({
        ...packet,
        tasks: [...packet.tasks, packet.tasks[0]],
        evidenceDigest: packet.evidenceDigest,
      }),
    ).toThrowError(/invalid tuning evidence|digest does not match/);
  });

  it("rejects self-consistent but semantically impossible or duplicate trials", () => {
    const contradictory = structuredClone(createTuningEvidencePacket(completeEvaluation()));
    const firstTrial = contradictory.tasks[0]?.trials[0];
    if (firstTrial === undefined) {
      throw new Error("fixture tuning trial is missing");
    }
    firstTrial.classification = "verified_success";
    firstTrial.harness.outcome = "failed";
    firstTrial.verification.outcome = "not_run";
    redigest(contradictory);
    expect(() => parseTuningEvidencePacket(contradictory)).toThrowError(/contradict/i);

    const recovery = structuredClone(createTuningEvidencePacket(completeEvaluation()));
    const recoveryTrial = recovery.tasks[0]?.trials[0];
    if (recoveryTrial === undefined) {
      throw new Error("fixture recovery trial is missing");
    }
    recoveryTrial.metrics.recoveryAttempts = 0;
    recoveryTrial.metrics.recoveryOutcome = "succeeded";
    redigest(recovery);
    expect(() => parseTuningEvidencePacket(recovery)).toThrowError(/recovery/i);

    const duplicate = structuredClone(createTuningEvidencePacket(completeEvaluation()));
    const duplicatedTrial = duplicate.tasks[0]?.trials[0];
    if (duplicatedTrial === undefined || duplicate.tasks[0] === undefined) {
      throw new Error("fixture duplicate trial is missing");
    }
    duplicate.tasks[0].trials[1] = structuredClone(duplicatedTrial);
    redigest(duplicate);
    expect(() => parseTuningEvidencePacket(duplicate)).toThrowError(/duplicate|unique|paired/i);
  });

  it("rejects scheduler-impossible seed mappings, repetitions, and declared totals", () => {
    const reusedSeed = structuredClone(createTuningEvidencePacket(completeEvaluation()));
    const reusedSeedTask = reusedSeed.tasks[0];
    if (reusedSeedTask === undefined) {
      throw new Error("fixture tuning task is missing");
    }
    reusedSeedTask.trials.push(
      ...reusedSeedTask.trials.map((trial) => ({ ...trial, repetition: 2 })),
    );
    reusedSeed.evaluation.completedTrials = 12;
    reusedSeed.evaluation.scheduledTrials = 12;
    redigest(reusedSeed);
    expect(() => parseTuningEvidencePacket(reusedSeed)).toThrowError(/seed|repetition|schedule/i);

    const nonContiguous = structuredClone(createTuningEvidencePacket(completeEvaluation()));
    const nonContiguousTask = nonContiguous.tasks[0];
    if (nonContiguousTask === undefined) {
      throw new Error("fixture tuning task is missing");
    }
    nonContiguousTask.trials.push(
      ...nonContiguousTask.trials.map((trial) => ({ ...trial, seed: 8, repetition: 3 })),
    );
    nonContiguous.evaluation.completedTrials = 12;
    nonContiguous.evaluation.scheduledTrials = 12;
    redigest(nonContiguous);
    expect(() => parseTuningEvidencePacket(nonContiguous)).toThrowError(
      /contiguous|repetition|schedule/i,
    );

    const impossibleTotal = structuredClone(createTuningEvidencePacket(completeEvaluation()));
    impossibleTotal.evaluation.completedTrials = 4_096;
    impossibleTotal.evaluation.scheduledTrials = 4_096;
    redigest(impossibleTotal);
    expect(() => parseTuningEvidencePacket(impossibleTotal)).toThrowError(/total|task|schedule/i);
  });

  it("keeps the maximum legal export within its own admission bound", () => {
    const packet = createTuningEvidencePacket(maximumEvaluation());

    expect(Buffer.byteLength(JSON.stringify(packet), "utf8") + 1).toBeLessThanOrEqual(
      MAX_TUNING_EVIDENCE_BYTES,
    );
    expect(packet.tasks[0]?.trials[0]?.harness).toMatchObject({ reasonTruncated: true });
  });

  it("bounds hostile parser diagnostics", () => {
    const packet = structuredClone(createTuningEvidencePacket(completeEvaluation())) as Record<
      string,
      unknown
    >;
    packet["x".repeat(1_000_000)] = true;
    try {
      parseTuningEvidencePacket(packet);
      throw new Error("hostile evidence unexpectedly parsed");
    } catch (error) {
      expect(error).toBeInstanceOf(TuningEvidenceError);
      expect((error as Error).message.length).toBeLessThanOrEqual(8_500);
    }
  });
});

interface MutableEvaluationInput {
  evaluationId: string;
  planDigest: string;
  suite: { id: string; version: string };
  tasks: Array<{ id: string; partition: "tuning" | "regression" | "holdout" }>;
  profiles: Array<{
    id: string;
    adapter: "flow-workflow-v1";
    workflowDigest: string;
    candidateDigest?: string;
  }>;
  schedule: readonly EvaluationTrialScheduleItem[];
  records: EvaluationTrialRecord[];
}

function completeEvaluation(): MutableEvaluationInput {
  const taskIds = ["tune-task", "regression-secret", "holdout-secret"];
  const profileIds = ["baseline", "candidate"];
  const schedule = createEvaluationSchedule(digest, taskIds, profileIds, [7]);
  let previousDigest: string | null = null;
  const records = schedule.map((item) => {
    const record = trialRecord(item, previousDigest);
    previousDigest = record.recordDigest;
    return record;
  });
  return {
    evaluationId: "source-evaluation",
    planDigest: digest,
    suite: { id: "adaptive-suite", version: "1.0.0" },
    tasks: [
      { id: "tune-task", partition: "tuning" },
      { id: "regression-secret", partition: "regression" },
      { id: "holdout-secret", partition: "holdout" },
    ],
    profiles: [
      { id: "baseline", adapter: "flow-workflow-v1", workflowDigest: "c".repeat(64) },
      { id: "candidate", adapter: "flow-workflow-v1", workflowDigest: "d".repeat(64) },
    ],
    schedule,
    records,
  };
}

function maximumEvaluation(): MutableEvaluationInput {
  const taskIds = Array.from({ length: 64 }, (_, index) => `tune-${index}`);
  const profileIds = ["baseline", "candidate"];
  const seeds = Array.from({ length: 32 }, (_, index) => index);
  const schedule = createEvaluationSchedule(digest, taskIds, profileIds, seeds);
  let previousDigest: string | null = null;
  const records = schedule.map((item) => {
    const record = createEvaluationTrialRecord({
      ...trialRecordInput(item, previousDigest),
      harness: { outcome: "completed", runId: "run-secret", reason: "r".repeat(4_096) },
    });
    previousDigest = record.recordDigest;
    return record;
  });
  return {
    evaluationId: "maximum-evaluation",
    planDigest: digest,
    suite: { id: "maximum-suite", version: "1.0.0" },
    tasks: taskIds.map((id) => ({ id, partition: "tuning" as const })),
    profiles: [
      { id: "baseline", adapter: "flow-workflow-v1", workflowDigest: "c".repeat(64) },
      { id: "candidate", adapter: "flow-workflow-v1", workflowDigest: "d".repeat(64) },
    ],
    schedule,
    records,
  };
}

function trialRecord(
  schedule: EvaluationTrialScheduleItem,
  previousDigest: string | null,
): EvaluationTrialRecord {
  return createEvaluationTrialRecord(trialRecordInput(schedule, previousDigest));
}

function trialRecordInput(
  schedule: EvaluationTrialScheduleItem,
  previousDigest: string | null,
): CreateEvaluationTrialRecordInput {
  return {
    schedule,
    planDigest: digest,
    previousDigest,
    startedAt: "2026-08-09T00:00:00.000Z",
    completedAt: "2026-08-09T00:00:01.000Z",
    environment: {
      platform: "linux",
      architecture: "x64",
      nodeVersion: "v22.19.0",
      flowVersion: "0.0.0-test",
      workspaceBackend: "reflink-copy-v1",
      workspaceSnapshotDigest: "9".repeat(64),
    },
    harness: { outcome: "completed", runId: "run-secret", reason: null },
    verification: {
      outcome: "accepted",
      verifierDigest,
      assertions: [{ kind: "exists", path: "SECRET.md", outcome: true }],
    },
    metrics: {
      costUsdMicros: 10,
      inputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      outputTokens: 5,
      turns: 2,
      toolCalls: 1,
      toolErrors: 0,
      wallTimeMs: 1_000,
      activeTimeMs: 900,
      interventions: 0,
      policyViolations: 0,
      recoveryAttempts: 0,
      recoveryOutcome: "not_attempted",
    },
  };
}

function redigest(packet: Record<string, unknown>): void {
  const { evidenceDigest: _evidenceDigest, ...content } = packet;
  packet.evidenceDigest = createHash("sha256").update(canonicalize(content)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("test value is not canonical JSON");
}
