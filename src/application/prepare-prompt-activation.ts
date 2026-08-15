import { createHash } from "node:crypto";

import {
  createPromptActivationSnapshot,
  type PromptActivationSnapshot,
} from "../domain/adaptation/prompt-activation.js";
import {
  type PromptCandidateIdentity,
  parsePromptCandidateIdentity,
} from "../domain/adaptation/prompt-candidate.js";
import {
  aggregateEvaluation,
  EvaluationAggregationError,
  type EvaluationReportInput,
} from "../domain/evaluation/aggregate.js";
import type { EvaluationTrialScheduleItem } from "../domain/evaluation/plan.js";
import type { EvaluationTrialRecord } from "../domain/evaluation/records.js";

const MAX_ADMISSION_ERROR_BYTES = 16 * 1024;

export interface PromptActivationCandidate {
  readonly identity: PromptCandidateIdentity;
  readonly baseline: {
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly workflowDigest: string;
  };
  readonly workflow: {
    readonly source: string;
    readonly sourceSha256: string;
    readonly workflowDigest: string;
  };
}

export interface PromptActivationStoredEvaluation {
  readonly header: {
    readonly evaluationId: string;
    readonly planDigest: string;
    readonly suite: {
      readonly tasks: readonly {
        readonly id: string;
        readonly partition: "tuning" | "regression" | "holdout";
        readonly verifier: {
          readonly digest: string;
          readonly assertionCount: number;
        };
      }[];
    };
    readonly profiles: readonly (
      | {
          readonly id: string;
          readonly adapter: "flow-workflow-v1";
          readonly workflow: {
            readonly provenance: string;
            readonly sourceSha256: string;
            readonly workflowDigest: string;
            readonly sourceKind?:
              | "prompt-candidate-projection"
              | "agent-skill-candidate-projection"
              | undefined;
          };
          readonly candidate?:
            | {
                readonly provenance: string;
                readonly identity: unknown;
              }
            | undefined;
        }
      | {
          readonly id: string;
          readonly adapter: "pi-native-v1" | "omp-native-v1" | "prime-agent-native-v1";
          readonly harness: unknown;
        }
    )[];
    readonly comparison: EvaluationReportInput["comparison"];
    readonly schedule: readonly EvaluationTrialScheduleItem[];
  };
  readonly records: readonly EvaluationTrialRecord[];
}

export type PromptActivationAdmissionErrorCode =
  | "evaluation_incomplete"
  | "evaluation_not_superior"
  | "identity_mismatch"
  | "invalid_evaluation";

export class PromptActivationAdmissionError extends Error {
  override readonly name = "PromptActivationAdmissionError";

  constructor(
    readonly code: PromptActivationAdmissionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${boundedText(message, MAX_ADMISSION_ERROR_BYTES)}`, options);
  }
}

export function createPromptActivationFromEvaluation(
  rawCandidate: PromptActivationCandidate,
  stored: PromptActivationStoredEvaluation,
): {
  readonly candidate: PromptActivationSnapshot;
  readonly baseline: PromptActivationSnapshot;
} {
  const candidate = parsePromptCandidateIdentity(rawCandidate.identity);
  validateLiveCandidate(candidate, rawCandidate);
  const input = reportInput(stored);
  const report = aggregateStoredEvaluation(input, stored.records);
  if (stored.records.length !== stored.header.schedule.length) {
    throw new PromptActivationAdmissionError(
      "evaluation_incomplete",
      "the evaluation does not contain every scheduled trial",
    );
  }
  const profiles = validateEvaluationProfiles(candidate, stored);
  const comparison = report.comparison;
  if (
    comparison.verdict !== "superior" ||
    comparison.pairedSuccessDelta === null ||
    comparison.confidenceInterval === null ||
    comparison.constraints.falseCompletionRate !== true ||
    comparison.constraints.policyViolations !== true ||
    comparison.constraints.verifiedSuccessRegression !== true
  ) {
    throw new PromptActivationAdmissionError(
      "evaluation_not_superior",
      `the evaluation verdict is ${comparison.verdict}`,
    );
  }
  const terminalRecord = stored.records.at(-1);
  if (terminalRecord === undefined) {
    throw new PromptActivationAdmissionError(
      "evaluation_incomplete",
      "the evaluation has no committed trial",
    );
  }
  const evaluation = {
    evaluationId: stored.header.evaluationId,
    planDigest: stored.header.planDigest,
    terminalRecordDigest: terminalRecord.recordDigest,
    reportDigest: sha256(canonicalize(report)),
    baselineProfileId: profiles.baseline.id,
    candidateProfileId: profiles.candidate.id,
    scheduledTrials: report.scheduledTrials,
    committedTrials: report.committedTrials,
    criteria: {
      minimumPairedTrials: stored.header.comparison.minimumPairedTrials,
      confidenceLevel: stored.header.comparison.confidenceLevel,
      minimumEffect: stored.header.comparison.minimumEffect,
      maxFalseCompletionRate: stored.header.comparison.maxFalseCompletionRate,
      maxPolicyViolations: stored.header.comparison.maxPolicyViolations,
      maxVerifiedSuccessRegression: stored.header.comparison.maxVerifiedSuccessRegression,
    },
    comparison: {
      verdict: "superior",
      scheduledPairs: comparison.scheduledPairs,
      completePairs: comparison.completePairs,
      comparablePairs: comparison.comparablePairs,
      pairedSuccessDelta: comparison.pairedSuccessDelta,
      confidenceInterval: comparison.confidenceInterval,
      constraints: {
        falseCompletionRate: true,
        policyViolations: true,
        verifiedSuccessRegression: true,
      },
    },
  } as const;
  return Object.freeze({
    candidate: createPromptActivationSnapshot({
      selection: "candidate",
      candidate,
      source: rawCandidate.workflow.source,
      evaluation,
    }),
    baseline: createPromptActivationSnapshot({
      selection: "baseline",
      candidate,
      source: rawCandidate.baseline.sourceText,
      evaluation,
    }),
  });
}

function validateLiveCandidate(
  candidate: PromptCandidateIdentity,
  live: PromptActivationCandidate,
): void {
  if (
    live.baseline.sourceSha256 !== candidate.baseline.sourceSha256 ||
    live.baseline.workflowDigest !== candidate.baseline.workflowDigest ||
    live.workflow.sourceSha256 !== candidate.projectedWorkflow.sourceSha256 ||
    live.workflow.workflowDigest !== candidate.projectedWorkflow.workflowDigest
  ) {
    throw new PromptActivationAdmissionError(
      "identity_mismatch",
      "the live candidate workflow does not match its identity",
    );
  }
}

function reportInput(stored: PromptActivationStoredEvaluation): EvaluationReportInput {
  const [firstProfile, secondProfile] = stored.header.profiles;
  if (
    stored.header.profiles.length !== 2 ||
    firstProfile === undefined ||
    secondProfile === undefined
  ) {
    throw new PromptActivationAdmissionError(
      "invalid_evaluation",
      "the evaluation must contain two profiles",
    );
  }
  return {
    planDigest: stored.header.planDigest,
    schedule: stored.header.schedule,
    profileIds: [firstProfile.id, secondProfile.id],
    profileAdapters: Object.freeze({
      [firstProfile.id]: firstProfile.adapter,
      [secondProfile.id]: secondProfile.adapter,
    }),
    tasks: stored.header.suite.tasks.map((task) => ({
      id: task.id,
      partition: task.partition,
      verifierDigest: task.verifier.digest,
      assertionCount: task.verifier.assertionCount,
    })),
    comparison: stored.header.comparison,
  };
}

function aggregateStoredEvaluation(
  input: EvaluationReportInput,
  records: readonly EvaluationTrialRecord[],
) {
  try {
    return aggregateEvaluation(input, records);
  } catch (error) {
    if (error instanceof EvaluationAggregationError) {
      throw new PromptActivationAdmissionError("invalid_evaluation", error.message, {
        cause: error,
      });
    }
    throw error;
  }
}

function validateEvaluationProfiles(
  candidate: PromptCandidateIdentity,
  stored: PromptActivationStoredEvaluation,
): {
  readonly baseline: Extract<
    PromptActivationStoredEvaluation["header"]["profiles"][number],
    { readonly adapter: "flow-workflow-v1" }
  >;
  readonly candidate: Extract<
    PromptActivationStoredEvaluation["header"]["profiles"][number],
    { readonly adapter: "flow-workflow-v1" }
  >;
} {
  const baseline = stored.header.profiles.find(
    (profile) => profile.id === stored.header.comparison.baselineProfileId,
  );
  const selected = stored.header.profiles.find(
    (profile) => profile.id === stored.header.comparison.candidateProfileId,
  );
  if (
    baseline === undefined ||
    selected === undefined ||
    baseline.adapter !== "flow-workflow-v1" ||
    selected.adapter !== "flow-workflow-v1" ||
    selected.candidate === undefined
  ) {
    throw new PromptActivationAdmissionError(
      "identity_mismatch",
      "the evaluation does not contain the selected candidate profiles",
    );
  }
  const storedCandidate = parsePromptCandidateIdentity(selected.candidate.identity);
  if (
    storedCandidate.candidateDigest !== candidate.candidateDigest ||
    selected.candidate.provenance !== candidate.manifest.provenance ||
    selected.workflow.sourceKind !== "prompt-candidate-projection" ||
    selected.workflow.provenance !== candidate.manifest.provenance ||
    selected.workflow.sourceSha256 !== candidate.projectedWorkflow.sourceSha256 ||
    selected.workflow.workflowDigest !== candidate.projectedWorkflow.workflowDigest ||
    baseline.candidate !== undefined ||
    baseline.workflow.sourceKind !== undefined ||
    baseline.workflow.provenance !== candidate.baseline.provenance ||
    baseline.workflow.sourceSha256 !== candidate.baseline.sourceSha256 ||
    baseline.workflow.workflowDigest !== candidate.baseline.workflowDigest
  ) {
    throw new PromptActivationAdmissionError(
      "identity_mismatch",
      "the evaluation profiles do not match the live candidate and baseline",
    );
  }
  return { baseline, candidate: selected };
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
  throw new PromptActivationAdmissionError(
    "invalid_evaluation",
    "the evaluation report is not canonical JSON",
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedText(value: string, bytes: number): string {
  const content = Buffer.from(value, "utf8");
  if (content.byteLength <= bytes) {
    return value;
  }
  return `${content.subarray(0, Math.max(0, bytes - 3)).toString("utf8")}...`;
}
