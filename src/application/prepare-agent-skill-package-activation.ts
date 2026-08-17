import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  type AgentSkillPackageActivationSnapshot,
  createAgentSkillPackageActivationSnapshot,
} from "../domain/adaptation/agent-skill-package-activation.js";
import {
  type AgentSkillPackageCandidateIdentity,
  parseAgentSkillPackageCandidateIdentity,
} from "../domain/adaptation/agent-skill-package-candidate.js";
import {
  type AgentSkillPackageSnapshot,
  calculateCapabilitySnapshotDigest,
} from "../domain/capability/agent-skills.js";
import {
  aggregateEvaluation,
  EvaluationAggregationError,
  type EvaluationReportInput,
} from "../domain/evaluation/aggregate.js";
import type { EvaluationTrialRecord } from "../domain/evaluation/records.js";
import type { PromptActivationStoredEvaluation } from "./prepare-prompt-activation.js";

const MAX_ADMISSION_ERROR_BYTES = 16 * 1024;

export interface AgentSkillPackageActivationCandidate {
  readonly identity: AgentSkillPackageCandidateIdentity;
  readonly baselineWorkflow: {
    readonly source: string;
    readonly sourceSha256: string;
    readonly workflowDigest: string;
  };
  readonly candidateWorkflow: {
    readonly source: string;
    readonly sourceSha256: string;
    readonly workflowDigest: string;
  };
  readonly candidateSkill: AgentSkillPackageSnapshot;
}

export type AgentSkillPackageActivationAdmissionErrorCode =
  | "evaluation_incomplete"
  | "evaluation_not_superior"
  | "identity_mismatch"
  | "invalid_evaluation";

export class AgentSkillPackageActivationAdmissionError extends Error {
  override readonly name = "AgentSkillPackageActivationAdmissionError";

  constructor(
    readonly code: AgentSkillPackageActivationAdmissionErrorCode,
    message: string,
  ) {
    super(`${code}: ${boundedText(message, MAX_ADMISSION_ERROR_BYTES)}`);
  }
}

export function createAgentSkillPackageActivationFromEvaluation(
  rawCandidate: AgentSkillPackageActivationCandidate,
  stored: PromptActivationStoredEvaluation,
): {
  readonly candidate: AgentSkillPackageActivationSnapshot;
  readonly baseline: AgentSkillPackageActivationSnapshot;
} {
  const candidate = parseCandidate(rawCandidate.identity);
  validateLiveCandidate(candidate, rawCandidate);
  const report = aggregateStoredEvaluation(reportInput(stored), stored.records);
  if (stored.records.length !== stored.header.schedule.length) {
    throw new AgentSkillPackageActivationAdmissionError(
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
    throw new AgentSkillPackageActivationAdmissionError(
      "evaluation_not_superior",
      "the evaluation is not a complete superior comparison",
    );
  }
  const terminalRecord = stored.records.at(-1);
  if (terminalRecord === undefined) {
    throw new AgentSkillPackageActivationAdmissionError(
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
    candidate: createAgentSkillPackageActivationSnapshot({
      selection: "candidate",
      candidate,
      evaluation,
      workflowSource: rawCandidate.candidateWorkflow.source,
      skill: rawCandidate.candidateSkill,
    }),
    baseline: createAgentSkillPackageActivationSnapshot({
      selection: "baseline",
      candidate,
      evaluation,
      workflowSource: rawCandidate.baselineWorkflow.source,
    }),
  });
}

function parseCandidate(input: unknown): AgentSkillPackageCandidateIdentity {
  try {
    return parseAgentSkillPackageCandidateIdentity(input);
  } catch {
    throw new AgentSkillPackageActivationAdmissionError(
      "identity_mismatch",
      "the live Agent Skill package candidate identity is invalid",
    );
  }
}

function validateLiveCandidate(
  candidate: AgentSkillPackageCandidateIdentity,
  live: AgentSkillPackageActivationCandidate,
): void {
  if (
    live.baselineWorkflow.sourceSha256 !== candidate.baseline.workflow.sourceSha256 ||
    live.baselineWorkflow.workflowDigest !== candidate.baseline.workflow.workflowDigest ||
    live.candidateWorkflow.sourceSha256 !== candidate.projectedWorkflow.sourceSha256 ||
    live.candidateWorkflow.workflowDigest !== candidate.projectedWorkflow.workflowDigest ||
    live.candidateSkill.name !== candidate.package.name ||
    live.candidateSkill.provenance !== candidate.package.provenance ||
    live.candidateSkill.digest !== candidate.package.packageDigest ||
    calculateCapabilitySnapshotDigest([live.candidateSkill]) !== candidate.package.capabilityDigest
  ) {
    throw new AgentSkillPackageActivationAdmissionError(
      "identity_mismatch",
      "the live Agent Skill package candidate does not match its evaluated identities",
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
    throw new AgentSkillPackageActivationAdmissionError(
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
      throw new AgentSkillPackageActivationAdmissionError(
        "invalid_evaluation",
        "the evaluation records are invalid",
      );
    }
    throw error;
  }
}

function validateEvaluationProfiles(
  candidate: AgentSkillPackageCandidateIdentity,
  stored: PromptActivationStoredEvaluation,
) {
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
    throw new AgentSkillPackageActivationAdmissionError(
      "identity_mismatch",
      "the evaluation does not contain the selected Agent Skill package profiles",
    );
  }
  const storedCandidate = parseCandidate(selected.candidate.identity);
  if (
    storedCandidate.candidateDigest !== candidate.candidateDigest ||
    selected.candidate.provenance !== selected.workflow.provenance ||
    `${posix.basename(selected.candidate.provenance)}/CANDIDATE.json` !==
      candidate.manifest.provenance ||
    selected.workflow.sourceKind !== "agent-skill-package-candidate-projection" ||
    selected.workflow.sourceSha256 !== candidate.projectedWorkflow.sourceSha256 ||
    selected.workflow.workflowDigest !== candidate.projectedWorkflow.workflowDigest ||
    selected.capabilitySnapshotDigest !== candidate.package.capabilityDigest ||
    !sameSingleDigest(selected.capabilityPackageDigests, candidate.package.packageDigest) ||
    baseline.candidate !== undefined ||
    baseline.workflow.sourceKind !== undefined ||
    baseline.workflow.provenance !== candidate.baseline.workflow.provenance ||
    baseline.workflow.sourceSha256 !== candidate.baseline.workflow.sourceSha256 ||
    baseline.workflow.workflowDigest !== candidate.baseline.workflow.workflowDigest ||
    baseline.capabilitySnapshotDigest !== undefined ||
    baseline.capabilityPackageDigests !== undefined
  ) {
    throw new AgentSkillPackageActivationAdmissionError(
      "identity_mismatch",
      "the evaluation profiles do not match the live Agent Skill package candidate",
    );
  }
  return { baseline, candidate: selected };
}

function sameSingleDigest(value: readonly string[] | undefined, expected: string): boolean {
  return value?.length === 1 && value[0] === expected;
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
  throw new AgentSkillPackageActivationAdmissionError(
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
