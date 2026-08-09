import type { EvaluationTrialScheduleItem } from "./plan.js";
import {
  EVALUATION_NUMERIC_METRICS,
  type EvaluationNumericMetric,
  type EvaluationTrialRecord,
  parseEvaluationTrialRecord,
} from "./records.js";

const BOOTSTRAP_SAMPLES = 2_000;

export interface EvaluationReportInput {
  readonly planDigest: string;
  readonly schedule: readonly EvaluationTrialScheduleItem[];
  readonly profileIds: readonly [string, string];
  readonly tasks: readonly {
    readonly id: string;
    readonly partition: "tuning" | "regression" | "holdout";
    readonly verifierDigest: string;
    readonly assertionCount: number;
  }[];
  readonly comparison: {
    readonly baselineProfileId: string;
    readonly candidateProfileId: string;
    readonly minimumPairedTrials: number;
    readonly confidenceLevel: 0.95;
    readonly minimumEffect: number;
    readonly maxFalseCompletionRate: number;
    readonly maxPolicyViolations: number;
    readonly maxVerifiedSuccessRegression: number;
  };
}

export interface EvaluationMetricSummary {
  readonly available: number;
  readonly unavailable: number;
  readonly sum: number | null;
  readonly mean: number | null;
}

export interface EvaluationRecoveryOutcomeSummary {
  readonly available: number;
  readonly unavailable: number;
  readonly counts: {
    readonly notAttempted: number;
    readonly succeeded: number;
    readonly failed: number;
  };
}

export type EvaluationProfileMetrics = Readonly<
  Record<EvaluationNumericMetric, EvaluationMetricSummary>
> & {
  readonly recoveryOutcome: EvaluationRecoveryOutcomeSummary;
};

export interface EvaluationProfileReport {
  readonly scheduled: number;
  readonly committed: number;
  readonly missing: number;
  readonly verifiedSuccess: number;
  readonly verifiedSuccessRate: number;
  readonly falseCompletion: number;
  readonly falseCompletionRate: number;
  readonly harnessFailure: number;
  readonly verifierError: number;
  readonly costPerAcceptedResultUsdMicros: number | null;
  readonly metrics: EvaluationProfileMetrics;
}

export interface EvaluationReport {
  readonly version: 1;
  readonly planDigest: string;
  readonly scheduledTrials: number;
  readonly committedTrials: number;
  readonly profiles: Readonly<Record<string, EvaluationProfileReport>>;
  readonly comparison: {
    readonly verdict: "superior" | "not_superior" | "insufficient_evidence" | "constraint_failed";
    readonly scheduledPairs: number;
    readonly completePairs: number;
    readonly comparablePairs: number;
    readonly pairedSuccessDelta: number | null;
    readonly confidenceInterval: {
      readonly lower: number;
      readonly upper: number;
      readonly level: 0.95;
    } | null;
    readonly constraints: {
      readonly falseCompletionRate: boolean | null;
      readonly policyViolations: boolean | null;
      readonly verifiedSuccessRegression: boolean | null;
    };
  };
}

export class EvaluationAggregationError extends Error {
  override readonly name = "EvaluationAggregationError";
}

export function aggregateEvaluation(
  input: EvaluationReportInput,
  rawRecords: readonly EvaluationTrialRecord[],
): EvaluationReport {
  const records = validateCommittedEvaluationPrefix(input, rawRecords);
  const profiles: Record<string, EvaluationProfileReport> = {};
  for (const profileId of input.profileIds) {
    const scheduled = input.schedule.filter((item) => item.profileId === profileId).length;
    const profileRecords = records.filter((item) => item.profileId === profileId);
    profiles[profileId] = profileReport(scheduled, profileRecords);
  }
  const baseline = profiles[input.comparison.baselineProfileId];
  const candidate = profiles[input.comparison.candidateProfileId];
  if (baseline === undefined || candidate === undefined) {
    throw new EvaluationAggregationError("comparison profiles are missing from the report input");
  }
  return deepFreeze({
    version: 1,
    planDigest: input.planDigest,
    scheduledTrials: input.schedule.length,
    committedTrials: records.length,
    profiles,
    comparison: comparisonReport(input, records, candidate),
  });
}

export function validateCommittedEvaluationPrefix(
  input: EvaluationReportInput,
  rawRecords: readonly EvaluationTrialRecord[],
): readonly EvaluationTrialRecord[] {
  if (!/^[a-f0-9]{64}$/.test(input.planDigest)) {
    throw new EvaluationAggregationError("evaluation plan digest is invalid");
  }
  if (rawRecords.length > input.schedule.length) {
    throw new EvaluationAggregationError("evaluation has more records than scheduled trials");
  }
  let previousDigest: string | null = null;
  const records: EvaluationTrialRecord[] = [];
  for (const [index, raw] of rawRecords.entries()) {
    const record = parseEvaluationTrialRecord(raw);
    const scheduled = input.schedule[index];
    if (
      scheduled === undefined ||
      record.planDigest !== input.planDigest ||
      record.sequence !== index + 1 ||
      record.position !== scheduled.position ||
      record.trialId !== scheduled.trialId ||
      record.taskId !== scheduled.taskId ||
      record.profileId !== scheduled.profileId ||
      record.seed !== scheduled.seed ||
      record.repetition !== scheduled.repetition
    ) {
      throw new EvaluationAggregationError(
        `evaluation trial record ${index + 1} contradicts the admitted schedule`,
      );
    }
    const task = input.tasks.find((item) => item.id === record.taskId);
    if (task === undefined || record.verification.verifierDigest !== task.verifierDigest) {
      throw new EvaluationAggregationError(
        `evaluation trial record ${index + 1} has the wrong verifier digest`,
      );
    }
    if (
      ((record.verification.outcome === "accepted" || record.verification.outcome === "rejected") &&
        record.verification.assertions.length !== task.assertionCount) ||
      record.verification.assertions.length > task.assertionCount
    ) {
      throw new EvaluationAggregationError(
        `evaluation trial record ${index + 1} has incomplete verifier evidence`,
      );
    }
    if (record.previousDigest !== previousDigest) {
      throw new EvaluationAggregationError(
        `evaluation trial record ${index + 1} has an invalid previous digest`,
      );
    }
    previousDigest = record.recordDigest;
    records.push(record);
  }
  return Object.freeze(records);
}

function profileReport(
  scheduled: number,
  records: readonly EvaluationTrialRecord[],
): EvaluationProfileReport {
  const count = (classification: EvaluationTrialRecord["classification"]) =>
    records.filter((item) => item.classification === classification).length;
  const numericMetrics = Object.fromEntries(
    EVALUATION_NUMERIC_METRICS.map((metric) => [metric, summarizeMetric(records, metric)]),
  ) as Record<EvaluationNumericMetric, EvaluationMetricSummary>;
  const metrics: EvaluationProfileMetrics = Object.freeze({
    ...numericMetrics,
    recoveryOutcome: summarizeRecoveryOutcome(records),
  });
  const verifiedSuccess = count("verified_success");
  const falseCompletion = count("false_completion");
  const cost = numericMetrics.costUsdMicros;
  const costPerAcceptedResultUsdMicros =
    records.length === scheduled &&
    cost.available === scheduled &&
    cost.sum !== null &&
    verifiedSuccess > 0
      ? cost.sum / verifiedSuccess
      : null;
  return Object.freeze({
    scheduled,
    committed: records.length,
    missing: scheduled - records.length,
    verifiedSuccess,
    verifiedSuccessRate: scheduled === 0 ? 0 : verifiedSuccess / scheduled,
    falseCompletion,
    falseCompletionRate: scheduled === 0 ? 0 : falseCompletion / scheduled,
    harnessFailure: count("harness_failure"),
    verifierError: count("verifier_error"),
    costPerAcceptedResultUsdMicros,
    metrics,
  });
}

function summarizeMetric(
  records: readonly EvaluationTrialRecord[],
  metric: EvaluationNumericMetric,
): EvaluationMetricSummary {
  const values = records
    .map((item) => item.metrics[metric])
    .filter((value): value is number => value !== null);
  const sum = values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
  if (sum !== null && !Number.isSafeInteger(sum)) {
    throw new EvaluationAggregationError(`evaluation metric ${metric} overflowed a safe integer`);
  }
  return Object.freeze({
    available: values.length,
    unavailable: records.length - values.length,
    sum,
    mean: sum === null ? null : sum / values.length,
  });
}

function summarizeRecoveryOutcome(
  records: readonly EvaluationTrialRecord[],
): EvaluationRecoveryOutcomeSummary {
  const values = records
    .map((record) => record.metrics.recoveryOutcome)
    .filter((value): value is NonNullable<typeof value> => value !== null);
  return Object.freeze({
    available: values.length,
    unavailable: records.length - values.length,
    counts: Object.freeze({
      notAttempted: values.filter((value) => value === "not_attempted").length,
      succeeded: values.filter((value) => value === "succeeded").length,
      failed: values.filter((value) => value === "failed").length,
    }),
  });
}

function comparisonReport(
  input: EvaluationReportInput,
  records: readonly EvaluationTrialRecord[],
  candidate: EvaluationProfileReport,
): EvaluationReport["comparison"] {
  const byTrialId = new Map(records.map((record) => [record.trialId, record]));
  const pairs = pairedSchedule(input);
  const complete = completePairRecords(pairs, byTrialId);
  const comparable = complete.filter(({ baseline: left, candidate: right }) =>
    sameEnvironment(left.environment, right.environment),
  );
  const deltas = comparable.map(
    ({ baseline: left, candidate: right }) =>
      Number(right.classification === "verified_success") -
      Number(left.classification === "verified_success"),
  );
  const pairedSuccessDelta = deltas.length === 0 ? null : mean(deltas);
  const confidenceInterval =
    deltas.length === 0
      ? null
      : {
          ...bootstrapInterval(input.planDigest, deltas),
          level: 0.95 as const,
        };
  const candidateRecords = records.filter(
    (item) => item.profileId === input.comparison.candidateProfileId,
  );
  const policyValues = candidateRecords.map((item) => item.metrics.policyViolations);
  const regressionPairs = pairedSchedule(input, "regression");
  const completeRegressionPairs = completePairRecords(regressionPairs, byTrialId);
  const comparableRegressionPairs = completeRegressionPairs.filter(
    ({ baseline: left, candidate: right }) => sameEnvironment(left.environment, right.environment),
  );
  const verifiedSuccessRegression =
    regressionPairs.length === 0
      ? true
      : completeRegressionPairs.length !== regressionPairs.length ||
          comparableRegressionPairs.length !== regressionPairs.length
        ? null
        : successRate(comparableRegressionPairs.map((pair) => pair.baseline)) -
            successRate(comparableRegressionPairs.map((pair) => pair.candidate)) <=
          input.comparison.maxVerifiedSuccessRegression;
  const constraints = {
    falseCompletionRate:
      candidate.committed === candidate.scheduled
        ? candidate.falseCompletionRate <= input.comparison.maxFalseCompletionRate
        : null,
    policyViolations:
      candidate.committed !== candidate.scheduled || policyValues.some((value) => value === null)
        ? null
        : policyValues.reduce<number>((total, value) => total + (value ?? 0), 0) <=
          input.comparison.maxPolicyViolations,
    verifiedSuccessRegression,
  } as const;
  const hasVerifierError = records.some((item) => item.classification === "verifier_error");
  let verdict: EvaluationReport["comparison"]["verdict"];
  if (
    complete.length !== pairs.length ||
    comparable.length !== pairs.length ||
    complete.length < input.comparison.minimumPairedTrials ||
    hasVerifierError ||
    Object.values(constraints).some((value) => value === null)
  ) {
    verdict = "insufficient_evidence";
  } else if (Object.values(constraints).some((value) => value === false)) {
    verdict = "constraint_failed";
  } else if (
    confidenceInterval !== null &&
    confidenceInterval.lower > input.comparison.minimumEffect
  ) {
    verdict = "superior";
  } else {
    verdict = "not_superior";
  }
  return Object.freeze({
    verdict,
    scheduledPairs: pairs.length,
    completePairs: complete.length,
    comparablePairs: comparable.length,
    pairedSuccessDelta,
    confidenceInterval: confidenceInterval === null ? null : Object.freeze(confidenceInterval),
    constraints: Object.freeze(constraints),
  });
}

function pairedSchedule(
  input: EvaluationReportInput,
  partition: "tuning" | "regression" | "holdout" = "holdout",
): readonly {
  readonly baseline: EvaluationTrialScheduleItem;
  readonly candidate: EvaluationTrialScheduleItem;
}[] {
  const groups = new Map<string, EvaluationTrialScheduleItem[]>();
  for (const item of input.schedule) {
    if (input.tasks.find((task) => task.id === item.taskId)?.partition !== partition) {
      continue;
    }
    const key = `${item.taskId}\0${item.seed}\0${item.repetition}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return Object.freeze(
    [...groups.values()].map((group) => {
      const baseline = group.find((item) => item.profileId === input.comparison.baselineProfileId);
      const candidate = group.find(
        (item) => item.profileId === input.comparison.candidateProfileId,
      );
      if (baseline === undefined || candidate === undefined || group.length !== 2) {
        throw new EvaluationAggregationError(
          "evaluation schedule contains an invalid profile pair",
        );
      }
      return Object.freeze({ baseline, candidate });
    }),
  );
}

function completePairRecords(
  pairs: readonly {
    readonly baseline: EvaluationTrialScheduleItem;
    readonly candidate: EvaluationTrialScheduleItem;
  }[],
  byTrialId: ReadonlyMap<string, EvaluationTrialRecord>,
): readonly {
  readonly baseline: EvaluationTrialRecord;
  readonly candidate: EvaluationTrialRecord;
}[] {
  return pairs.flatMap((pair) => {
    const baseline = byTrialId.get(pair.baseline.trialId);
    const candidate = byTrialId.get(pair.candidate.trialId);
    return baseline === undefined || candidate === undefined ? [] : [{ baseline, candidate }];
  });
}

function successRate(records: readonly EvaluationTrialRecord[]): number {
  return records.length === 0
    ? 0
    : records.filter((record) => record.classification === "verified_success").length /
        records.length;
}

function sameEnvironment(
  left: EvaluationTrialRecord["environment"],
  right: EvaluationTrialRecord["environment"],
): boolean {
  return (
    left.platform === right.platform &&
    left.architecture === right.architecture &&
    left.nodeVersion === right.nodeVersion &&
    left.flowVersion === right.flowVersion &&
    left.workspaceBackend === right.workspaceBackend &&
    left.workspaceSnapshotDigest === right.workspaceSnapshotDigest
  );
}

function bootstrapInterval(
  planDigest: string,
  deltas: readonly number[],
): {
  readonly lower: number;
  readonly upper: number;
} {
  let state = Number.parseInt(planDigest.slice(0, 8), 16) || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const samples: number[] = [];
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample += 1) {
    let total = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      total += deltas[Math.floor(next() * deltas.length)] ?? 0;
    }
    samples.push(total / deltas.length);
  }
  samples.sort((left, right) => left - right);
  return Object.freeze({
    lower: percentile(samples, 0.025),
    upper: percentile(samples, 0.975),
  });
}

function percentile(values: readonly number[], quantile: number): number {
  return values[Math.floor((values.length - 1) * quantile)] ?? 0;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return value;
}
