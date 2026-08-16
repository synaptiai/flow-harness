import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  type AgentSkillActivationSnapshot,
  createAgentSkillActivationSnapshot,
} from "../domain/adaptation/agent-skill-activation.js";
import {
  type AgentSkillCandidateIdentity,
  parseAgentSkillCandidateIdentity,
} from "../domain/adaptation/agent-skill-candidate.js";
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

export interface AgentSkillActivationCandidate {
  readonly identity: AgentSkillCandidateIdentity;
  readonly workflow: {
    readonly source: string;
    readonly sourceSha256: string;
    readonly workflowDigest: string;
  };
  readonly baselineSkill: AgentSkillPackageSnapshot;
  readonly candidateSkill: AgentSkillPackageSnapshot;
}

export type AgentSkillActivationAdmissionErrorCode =
  | "evaluation_incomplete"
  | "evaluation_not_superior"
  | "identity_mismatch"
  | "invalid_evaluation";

export class AgentSkillActivationAdmissionError extends Error {
  override readonly name = "AgentSkillActivationAdmissionError";

  constructor(
    readonly code: AgentSkillActivationAdmissionErrorCode,
    message: string,
  ) {
    super(`${code}: ${boundedText(message, MAX_ADMISSION_ERROR_BYTES)}`);
  }
}

export function createAgentSkillActivationFromEvaluation(
  rawCandidate: AgentSkillActivationCandidate,
  stored: PromptActivationStoredEvaluation,
): {
  readonly candidate: AgentSkillActivationSnapshot;
  readonly baseline: AgentSkillActivationSnapshot;
} {
  const candidate = parseCandidate(rawCandidate.identity);
  validateLiveCandidate(candidate, rawCandidate);
  const input = reportInput(stored);
  const report = aggregateStoredEvaluation(input, stored.records);
  if (stored.records.length !== stored.header.schedule.length) {
    throw new AgentSkillActivationAdmissionError(
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
    throw new AgentSkillActivationAdmissionError(
      "evaluation_not_superior",
      "the evaluation is not a complete superior comparison",
    );
  }
  const terminalRecord = stored.records.at(-1);
  if (terminalRecord === undefined) {
    throw new AgentSkillActivationAdmissionError(
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
    candidate: createAgentSkillActivationSnapshot({
      selection: "candidate",
      candidate,
      evaluation,
      workflowSource: rawCandidate.workflow.source,
      skill: rawCandidate.candidateSkill,
    }),
    baseline: createAgentSkillActivationSnapshot({
      selection: "baseline",
      candidate,
      evaluation,
      workflowSource: rawCandidate.workflow.source,
      skill: rawCandidate.baselineSkill,
    }),
  });
}

function parseCandidate(input: unknown): AgentSkillCandidateIdentity {
  try {
    return parseAgentSkillCandidateIdentity(input);
  } catch {
    throw new AgentSkillActivationAdmissionError(
      "identity_mismatch",
      "the live Agent Skill candidate identity is invalid",
    );
  }
}

function validateLiveCandidate(
  candidate: AgentSkillCandidateIdentity,
  live: AgentSkillActivationCandidate,
): void {
  if (
    live.workflow.sourceSha256 !== candidate.baseline.workflow.sourceSha256 ||
    live.workflow.workflowDigest !== candidate.baseline.workflow.workflowDigest ||
    live.baselineSkill.name !== candidate.scope.skillName ||
    live.baselineSkill.provenance !== candidate.baseline.skill.provenance ||
    live.baselineSkill.digest !== candidate.baseline.skill.packageDigest ||
    calculateCapabilitySnapshotDigest([live.baselineSkill]) !==
      candidate.baseline.skill.capabilityDigest ||
    live.candidateSkill.name !== candidate.scope.skillName ||
    live.candidateSkill.provenance !== candidate.baseline.skill.provenance ||
    live.candidateSkill.digest !== candidate.projectedSkill.packageDigest ||
    calculateCapabilitySnapshotDigest([live.candidateSkill]) !==
      candidate.projectedSkill.capabilityDigest
  ) {
    throw new AgentSkillActivationAdmissionError(
      "identity_mismatch",
      "the live Agent Skill candidate does not match its evaluated identities",
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
    throw new AgentSkillActivationAdmissionError(
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
      throw new AgentSkillActivationAdmissionError(
        "invalid_evaluation",
        "the evaluation records are invalid",
      );
    }
    throw error;
  }
}

function validateEvaluationProfiles(
  candidate: AgentSkillCandidateIdentity,
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
    throw new AgentSkillActivationAdmissionError(
      "identity_mismatch",
      "the evaluation does not contain the selected Agent Skill profiles",
    );
  }
  const storedCandidate = parseCandidate(selected.candidate.identity);
  if (
    storedCandidate.candidateDigest !== candidate.candidateDigest ||
    selected.candidate.provenance !== selected.workflow.provenance ||
    posix.basename(selected.candidate.provenance) !== candidate.manifest.provenance ||
    selected.workflow.sourceKind !== "agent-skill-candidate-projection" ||
    selected.workflow.sourceSha256 !== candidate.baseline.workflow.sourceSha256 ||
    selected.workflow.workflowDigest !== candidate.baseline.workflow.workflowDigest ||
    selected.capabilitySnapshotDigest !== candidate.projectedSkill.capabilityDigest ||
    !sameSingleDigest(selected.capabilityPackageDigests, candidate.projectedSkill.packageDigest) ||
    baseline.candidate !== undefined ||
    baseline.workflow.sourceKind !== undefined ||
    baseline.workflow.provenance !== candidate.baseline.workflow.provenance ||
    baseline.workflow.sourceSha256 !== candidate.baseline.workflow.sourceSha256 ||
    baseline.workflow.workflowDigest !== candidate.baseline.workflow.workflowDigest ||
    baseline.capabilitySnapshotDigest !== candidate.baseline.skill.capabilityDigest ||
    !sameSingleDigest(baseline.capabilityPackageDigests, candidate.baseline.skill.packageDigest)
  ) {
    throw new AgentSkillActivationAdmissionError(
      "identity_mismatch",
      "the evaluation profiles do not match the live Agent Skill candidate",
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
  throw new AgentSkillActivationAdmissionError(
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
