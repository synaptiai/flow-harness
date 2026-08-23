import type { EvaluationProfileIdentity, EvaluationTrialScheduleItem } from "./plan.js";
import {
  EVALUATION_NUMERIC_METRICS,
  type EvaluationNumericMetric,
  type EvaluationTrialRecord,
  parseEvaluationTrialRecord,
} from "./records.js";

const BOOTSTRAP_SAMPLES = 2_000;

export interface EvaluationReportInput {
  readonly planDigest: string;
  readonly purpose?: "acp-interoperability-v1";
  readonly schedule: readonly EvaluationTrialScheduleItem[];
  readonly profileIds: readonly [string, string];
  readonly profileAdapters: Readonly<Record<string, EvaluationProfileIdentity["adapter"]>>;
  readonly profileWorkflowDigests?: Readonly<Record<string, string>>;
  readonly profileCapabilitySnapshotDigests?: Readonly<Record<string, string>>;
  readonly profileAcpAgents?: Readonly<
    Record<string, { readonly name: string; readonly digest: string }>
  >;
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
  readonly qualification?: EvaluationAcpQualificationReport;
}

export interface EvaluationAcpQualificationReport {
  readonly purpose: "acp-interoperability-v1";
  readonly verdict: "qualified" | "not_qualified" | "insufficient_evidence";
  readonly requiredPairs: number;
  readonly scheduledPairs: number;
  readonly completePairs: number;
  readonly verifiedPairs: number;
  readonly workflowDigest: string;
  readonly outputVerification: {
    readonly accepted: number;
    readonly rejected: number;
    readonly errors: number;
    readonly notRun: number;
  };
  readonly profiles: Readonly<Record<string, EvaluationAcpQualificationProfileReport>>;
  readonly limitations: readonly string[];
}

export interface EvaluationAcpQualificationProfileReport {
  readonly executor: {
    readonly capabilitySnapshotDigest: string;
    readonly agentName: string;
    readonly agentDigest: string;
  };
  readonly latencyMs: {
    readonly available: number;
    readonly unavailable: number;
    readonly minimum: number | null;
    readonly maximum: number | null;
    readonly mean: number | null;
  };
  readonly usage: {
    readonly modelTokensComplete: number;
    readonly costUsdComplete: number;
    readonly incomplete: number;
    readonly modelTokensTotal: number | null;
    readonly costUsdMicrosTotal: number | null;
  };
  readonly failures: {
    readonly harness: number;
    readonly falseCompletion: number;
    readonly verifierError: number;
    readonly authorityViolation: number;
    readonly unconfirmedTermination: number;
    readonly toolActivity: number;
    readonly policyViolation: number;
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
    ...(input.purpose === "acp-interoperability-v1"
      ? { qualification: acpQualificationReport(input, records) }
      : {}),
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
  for (const profileId of input.profileIds) {
    if (input.profileAdapters[profileId] === undefined) {
      throw new EvaluationAggregationError("evaluation profile adapter evidence is incomplete");
    }
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
    const profileAdapter = input.profileAdapters[record.profileId];
    const runtimeAdapter = record.harness.runtime?.adapter;
    const completedExternalWithoutRuntime =
      profileAdapter !== undefined &&
      profileAdapter !== "flow-workflow-v1" &&
      record.harness.outcome === "completed" &&
      runtimeAdapter === undefined;
    if (
      profileAdapter === undefined ||
      (profileAdapter === "flow-workflow-v1" && runtimeAdapter !== undefined) ||
      completedExternalWithoutRuntime ||
      (runtimeAdapter !== undefined && runtimeAdapter !== profileAdapter)
    ) {
      throw new EvaluationAggregationError(
        `evaluation trial record ${index + 1} contradicts its profile adapter`,
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
    validateQualificationRecordIdentity(input, record, index);
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

function validateQualificationRecordIdentity(
  input: EvaluationReportInput,
  record: EvaluationTrialRecord,
  index: number,
): void {
  if (input.purpose !== "acp-interoperability-v1") {
    if (record.qualification !== undefined) {
      throw new EvaluationAggregationError(
        `evaluation trial record ${index + 1} contains undeclared ACP qualification evidence`,
      );
    }
    return;
  }
  const observation = record.qualification;
  if (observation === undefined) return;
  const expectedWorkflow = input.profileWorkflowDigests?.[record.profileId];
  const expectedCapability = input.profileCapabilitySnapshotDigests?.[record.profileId];
  const expectedAgent = input.profileAcpAgents?.[record.profileId];
  if (
    expectedWorkflow === undefined ||
    expectedCapability === undefined ||
    expectedAgent === undefined ||
    observation.workflowDigest !== expectedWorkflow ||
    observation.capabilitySnapshotDigest !== expectedCapability ||
    observation.agent.name !== expectedAgent.name ||
    observation.agent.digest !== expectedAgent.digest
  ) {
    throw new EvaluationAggregationError(
      `evaluation trial record ${index + 1} contradicts its admitted ACP identity`,
    );
  }
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

function acpQualificationReport(
  input: EvaluationReportInput,
  records: readonly EvaluationTrialRecord[],
): EvaluationAcpQualificationReport {
  const identity = requireAcpQualificationIdentity(input);
  const pairs = pairedSchedule(input, undefined);
  const byTrialId = new Map(records.map((record) => [record.trialId, record]));
  const completePairs = completePairRecords(pairs, byTrialId);
  const comparablePairs = completePairs.filter(({ baseline, candidate }) =>
    sameEnvironment(baseline.environment, candidate.environment),
  );
  const profiles = Object.fromEntries(
    input.profileIds.map((profileId) => [
      profileId,
      acpQualificationProfileReport(
        profileId,
        identity.capabilitySnapshotDigests[profileId] ?? "",
        identity.agents[profileId],
        records.filter((record) => record.profileId === profileId),
      ),
    ]),
  ) as Record<string, EvaluationAcpQualificationProfileReport>;
  const verifiedPairs = comparablePairs.filter(
    ({ baseline, candidate }) =>
      isVerifiedAcpQualificationTrial(baseline) && isVerifiedAcpQualificationTrial(candidate),
  ).length;
  const outputVerification = Object.freeze({
    accepted: records.filter((record) => record.verification.outcome === "accepted").length,
    rejected: records.filter((record) => record.verification.outcome === "rejected").length,
    errors: records.filter((record) => record.verification.outcome === "error").length,
    notRun: records.filter((record) => record.verification.outcome === "not_run").length,
  });
  const limitations = qualificationLimitations(
    input,
    records,
    pairs.length,
    completePairs.length,
    comparablePairs.length,
  );
  const hasConformanceFailure = records.some(hasAcpConformanceFailure);
  const completeQualification =
    pairs.length >= input.comparison.minimumPairedTrials &&
    completePairs.length === pairs.length &&
    comparablePairs.length === pairs.length &&
    verifiedPairs === pairs.length;
  const verdict = hasConformanceFailure
    ? "not_qualified"
    : completeQualification
      ? "qualified"
      : "insufficient_evidence";
  return Object.freeze({
    purpose: "acp-interoperability-v1",
    verdict,
    requiredPairs: input.comparison.minimumPairedTrials,
    scheduledPairs: pairs.length,
    completePairs: completePairs.length,
    verifiedPairs,
    workflowDigest: identity.workflowDigest,
    outputVerification,
    profiles: Object.freeze(profiles),
    limitations: Object.freeze(limitations),
  });
}

function requireAcpQualificationIdentity(input: EvaluationReportInput): {
  readonly workflowDigest: string;
  readonly capabilitySnapshotDigests: Readonly<Record<string, string>>;
  readonly agents: Readonly<Record<string, { readonly name: string; readonly digest: string }>>;
} {
  const workflows = input.profileIds.map((id) => input.profileWorkflowDigests?.[id]);
  const capabilities = input.profileIds.map((id) => input.profileCapabilitySnapshotDigests?.[id]);
  const agents = input.profileIds.map((id) => input.profileAcpAgents?.[id]);
  if (
    workflows.some((value) => value === undefined || !/^[a-f0-9]{64}$/.test(value)) ||
    capabilities.some((value) => value === undefined || !/^[a-f0-9]{64}$/.test(value)) ||
    agents.some(
      (value) =>
        value === undefined ||
        !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.name) ||
        !/^[a-f0-9]{64}$/.test(value.digest),
    ) ||
    new Set(workflows).size !== 1 ||
    new Set(capabilities).size !== input.profileIds.length ||
    new Set(agents.map((value) => value?.digest)).size !== input.profileIds.length
  ) {
    throw new EvaluationAggregationError(
      "ACP qualification report input has invalid workflow or capability identities",
    );
  }
  return Object.freeze({
    workflowDigest: workflows[0] ?? "",
    capabilitySnapshotDigests: Object.freeze(
      Object.fromEntries(input.profileIds.map((id, index) => [id, capabilities[index] ?? ""])),
    ),
    agents: Object.freeze(
      Object.fromEntries(input.profileIds.map((id, index) => [id, agents[index]])),
    ) as Readonly<Record<string, { readonly name: string; readonly digest: string }>>,
  });
}

function acpQualificationProfileReport(
  profileId: string,
  capabilitySnapshotDigest: string,
  expectedAgent: { readonly name: string; readonly digest: string } | undefined,
  records: readonly EvaluationTrialRecord[],
): EvaluationAcpQualificationProfileReport {
  const observations = records.flatMap((record) =>
    record.qualification === undefined ? [] : [record.qualification],
  );
  const names = new Set(observations.map((observation) => observation.agent.name));
  const digests = new Set(observations.map((observation) => observation.agent.digest));
  if (
    expectedAgent === undefined ||
    names.size > 1 ||
    digests.size > 1 ||
    [...names].some((name) => name !== expectedAgent.name) ||
    [...digests].some((digest) => digest !== expectedAgent.digest)
  ) {
    throw new EvaluationAggregationError(
      `ACP qualification profile "${profileId}" contains inconsistent executor identities`,
    );
  }
  const durations = observations.map((observation) => observation.durationMs);
  const modelTokens = observations.flatMap((observation) =>
    observation.usage.modelTokens.status === "complete"
      ? [observation.usage.modelTokens.totalTokens]
      : [],
  );
  const costs = observations.flatMap((observation) =>
    observation.usage.costUsd.status === "complete"
      ? [observation.usage.costUsd.costUsdMicros]
      : [],
  );
  return Object.freeze({
    executor: Object.freeze({
      capabilitySnapshotDigest,
      agentName: expectedAgent.name,
      agentDigest: expectedAgent.digest,
    }),
    latencyMs: Object.freeze({
      available: durations.length,
      unavailable: records.length - durations.length,
      minimum: durations.length === 0 ? null : Math.min(...durations),
      maximum: durations.length === 0 ? null : Math.max(...durations),
      mean:
        durations.length === 0 ? null : safeMetricTotal(durations, "duration") / durations.length,
    }),
    usage: Object.freeze({
      modelTokensComplete: modelTokens.length,
      costUsdComplete: costs.length,
      incomplete: observations.filter(
        (observation) =>
          observation.usage.modelTokens.status !== "complete" ||
          observation.usage.costUsd.status !== "complete",
      ).length,
      modelTokensTotal:
        modelTokens.length === 0 ? null : safeMetricTotal(modelTokens, "model token"),
      costUsdMicrosTotal: costs.length === 0 ? null : safeMetricTotal(costs, "cost"),
    }),
    failures: Object.freeze({
      harness: records.filter((record) => record.classification === "harness_failure").length,
      falseCompletion: records.filter((record) => record.classification === "false_completion")
        .length,
      verifierError: records.filter((record) => record.classification === "verifier_error").length,
      authorityViolation: observations.filter(
        (observation) => observation.authorityViolation !== undefined,
      ).length,
      unconfirmedTermination: observations.filter(
        (observation) => observation.terminationStatus !== "confirmed",
      ).length,
      toolActivity: observations.filter(
        (observation) => observation.activity.toolCalls > 0 || observation.activity.toolErrors > 0,
      ).length,
      policyViolation: observations.filter((observation) => observation.policyViolations > 0)
        .length,
    }),
  });
}

function isVerifiedAcpQualificationTrial(record: EvaluationTrialRecord): boolean {
  const observation = record.qualification;
  return (
    record.classification === "verified_success" &&
    observation !== undefined &&
    observation.terminationStatus === "confirmed" &&
    observation.authorityViolation === undefined &&
    observation.activity.toolCalls === 0 &&
    observation.activity.toolErrors === 0 &&
    observation.policyViolations === 0 &&
    observation.usage.modelTokens.status === "complete" &&
    observation.usage.costUsd.status === "complete"
  );
}

function hasAcpConformanceFailure(record: EvaluationTrialRecord): boolean {
  if (record.classification === "harness_failure" || record.classification === "false_completion") {
    return true;
  }
  const observation = record.qualification;
  return (
    observation !== undefined &&
    (observation.terminationStatus !== "confirmed" ||
      observation.authorityViolation !== undefined ||
      observation.activity.toolCalls > 0 ||
      observation.activity.toolErrors > 0 ||
      observation.policyViolations > 0)
  );
}

function qualificationLimitations(
  input: EvaluationReportInput,
  records: readonly EvaluationTrialRecord[],
  scheduledPairs: number,
  completePairs: number,
  comparablePairs: number,
): string[] {
  const limitations: string[] = [];
  const missing = input.schedule.length - records.length;
  const verifierErrors = records.filter(
    (record) => record.classification === "verifier_error",
  ).length;
  const harnessFailures = records.filter(
    (record) => record.classification === "harness_failure",
  ).length;
  const rejected = records.filter((record) => record.classification === "false_completion").length;
  const missingObservations = records.filter(
    (record) => record.classification === "verified_success" && record.qualification === undefined,
  ).length;
  const incompleteAccounting = records.filter(
    (record) =>
      record.qualification !== undefined &&
      (record.qualification.usage.modelTokens.status !== "complete" ||
        record.qualification.usage.costUsd.status !== "complete"),
  ).length;
  if (missing > 0) limitations.push(`${missing} scheduled ACP qualification trial(s) are missing.`);
  if (completePairs < scheduledPairs) {
    limitations.push(`${scheduledPairs - completePairs} scheduled pair(s) are incomplete.`);
  }
  if (comparablePairs < completePairs) {
    limitations.push(
      `${completePairs - comparablePairs} complete pair(s) have different environments.`,
    );
  }
  if (verifierErrors > 0) limitations.push(`${verifierErrors} trial(s) have verifier errors.`);
  if (missingObservations > 0) {
    limitations.push(
      `${missingObservations} verified trial(s) lack ACP qualification observations.`,
    );
  }
  if (incompleteAccounting > 0) {
    limitations.push(`${incompleteAccounting} trial(s) have incomplete token or cost accounting.`);
  }
  if (harnessFailures > 0) limitations.push(`${harnessFailures} ACP harness execution(s) failed.`);
  if (rejected > 0) limitations.push(`${rejected} ACP result verification(s) failed.`);
  const unsafe = records.filter((record) => {
    const observation = record.qualification;
    return (
      observation !== undefined &&
      (observation.terminationStatus !== "confirmed" ||
        observation.authorityViolation !== undefined ||
        observation.activity.toolCalls > 0 ||
        observation.activity.toolErrors > 0 ||
        observation.policyViolations > 0)
    );
  }).length;
  if (unsafe > 0) limitations.push(`${unsafe} trial(s) contain containment or authority failures.`);
  return limitations;
}

function safeMetricTotal(values: readonly number[], label: string): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) {
    throw new EvaluationAggregationError(`ACP qualification ${label} evidence overflowed`);
  }
  return total;
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
  partition: "tuning" | "regression" | "holdout" | undefined = "holdout",
): readonly {
  readonly baseline: EvaluationTrialScheduleItem;
  readonly candidate: EvaluationTrialScheduleItem;
}[] {
  const groups = new Map<string, EvaluationTrialScheduleItem[]>();
  for (const item of input.schedule) {
    if (
      partition !== undefined &&
      input.tasks.find((task) => task.id === item.taskId)?.partition !== partition
    ) {
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
