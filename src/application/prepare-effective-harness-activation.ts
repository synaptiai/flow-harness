import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type EffectiveHarnessCandidateArtifact,
  parseEffectiveHarnessCandidateArtifact,
} from "../domain/adaptation/effective-harness-candidate.js";
import type { ModelRoute } from "../domain/adaptation/model-routing-candidate.js";
import {
  aggregateEvaluation,
  EvaluationAggregationError,
  type EvaluationReportInput,
} from "../domain/evaluation/aggregate.js";
import type { EvaluationTrialScheduleItem } from "../domain/evaluation/plan.js";
import type { EvaluationTrialRecord } from "../domain/evaluation/records.js";

export interface EffectiveHarnessStoredEvaluation {
  readonly header: {
    readonly evaluationId: string;
    readonly planDigest: string;
    readonly suite: {
      readonly tasks: readonly {
        readonly id: string;
        readonly partition: "tuning" | "regression" | "holdout";
        readonly verifier: { readonly digest: string; readonly assertionCount: number };
      }[];
    };
    readonly profiles: readonly (
      | {
          readonly id: string;
          readonly adapter: "flow-workflow-v1";
          readonly workflow: {
            readonly sourceKind?: string | undefined;
            readonly provenance: string;
            readonly sourceSha256: string;
            readonly workflowDigest: string;
          };
          readonly capabilitySnapshotDigest?: string | undefined;
          readonly capabilityPackageDigests?: readonly string[] | undefined;
          readonly candidate?:
            | { readonly provenance: string; readonly identity: unknown }
            | undefined;
          readonly effectiveHarness?:
            | {
                readonly selection: "baseline" | "candidate";
                readonly artifactDigest: string;
                readonly stateDigest: string;
                readonly baselineHeadDigest: string;
                readonly workflowSha256: string;
                readonly workflowDigest: string;
                readonly packageDigests: readonly string[];
                readonly surface:
                  | "prompt"
                  | "agent-skill-resource"
                  | "agent-skill-package"
                  | "model-routing";
                readonly candidateDigest: string;
              }
            | undefined;
        }
      | {
          readonly id: string;
          readonly adapter: "pi-native-v1" | "omp-native-v1" | "prime-agent-native-v1";
        }
    )[];
    readonly controls: {
      readonly modelRoutes?:
        | readonly [
            {
              readonly profileId: string;
              readonly nodeId: string;
              readonly route: ModelRoute;
            },
            {
              readonly profileId: string;
              readonly nodeId: string;
              readonly route: ModelRoute;
            },
          ]
        | undefined;
    };
    readonly comparison: EvaluationReportInput["comparison"];
    readonly schedule: readonly EvaluationTrialScheduleItem[];
  };
  readonly records: readonly EvaluationTrialRecord[];
}

export interface PreparedEffectiveHarnessActivation {
  readonly artifact: EffectiveHarnessCandidateArtifact;
  readonly evaluation: {
    readonly id: string;
    readonly planDigest: string;
    readonly terminalRecordDigest: string;
    readonly reportDigest: string;
  };
}

export type EffectiveHarnessActivationAdmissionErrorCode =
  | "evaluation_incomplete"
  | "evaluation_not_superior"
  | "identity_mismatch"
  | "invalid_evaluation";

export class EffectiveHarnessActivationAdmissionError extends Error {
  override readonly name = "EffectiveHarnessActivationAdmissionError";

  constructor(
    readonly code: EffectiveHarnessActivationAdmissionErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function prepareEffectiveHarnessActivation(input: {
  readonly artifact: EffectiveHarnessCandidateArtifact;
  readonly stored: EffectiveHarnessStoredEvaluation;
}): PreparedEffectiveHarnessActivation {
  const artifact = parseEffectiveHarnessCandidateArtifact(input.artifact);
  if (input.stored.records.length !== input.stored.header.schedule.length) {
    throw new EffectiveHarnessActivationAdmissionError(
      "evaluation_incomplete",
      "effective harness evaluation is incomplete",
    );
  }
  const report = aggregateStoredEvaluation(input.stored);
  if (
    report.comparison.verdict !== "superior" ||
    report.comparison.pairedSuccessDelta === null ||
    report.comparison.confidenceInterval === null ||
    report.comparison.constraints.falseCompletionRate !== true ||
    report.comparison.constraints.policyViolations !== true ||
    report.comparison.constraints.verifiedSuccessRegression !== true
  ) {
    throw new EffectiveHarnessActivationAdmissionError(
      "evaluation_not_superior",
      "effective harness evaluation is not superior",
    );
  }
  assertEvaluationProfiles(artifact, input.stored);
  const terminalRecord = input.stored.records.at(-1);
  if (terminalRecord === undefined) {
    throw new EffectiveHarnessActivationAdmissionError(
      "evaluation_incomplete",
      "effective harness evaluation has no terminal record",
    );
  }
  return deepFreeze({
    artifact,
    evaluation: {
      id: input.stored.header.evaluationId,
      planDigest: input.stored.header.planDigest,
      terminalRecordDigest: terminalRecord.recordDigest,
      reportDigest: sha256(canonicalize(report)),
    },
  });
}

function assertEvaluationProfiles(
  artifact: EffectiveHarnessCandidateArtifact,
  stored: EffectiveHarnessStoredEvaluation,
): void {
  const baseline = stored.header.profiles.find(
    (profile) => profile.id === stored.header.comparison.baselineProfileId,
  );
  const candidate = stored.header.profiles.find(
    (profile) => profile.id === stored.header.comparison.candidateProfileId,
  );
  const baselineBinding =
    baseline?.adapter === "flow-workflow-v1" ? baseline.effectiveHarness : undefined;
  const candidateBinding =
    candidate?.adapter === "flow-workflow-v1" ? candidate.effectiveHarness : undefined;
  assertEvaluationModelRoutes(artifact, stored, baseline?.id, candidate?.id);
  if (
    baseline?.adapter !== "flow-workflow-v1" ||
    candidate?.adapter !== "flow-workflow-v1" ||
    baseline.workflow.sourceKind !== "effective-harness-baseline" ||
    candidate.workflow.sourceKind !== "effective-harness-candidate-projection" ||
    baseline.candidate !== undefined ||
    candidate.candidate === undefined ||
    baselineBinding?.selection !== "baseline" ||
    candidateBinding?.selection !== "candidate" ||
    baselineBinding.artifactDigest !== artifact.artifactDigest ||
    candidateBinding.artifactDigest !== artifact.artifactDigest ||
    baselineBinding.stateDigest !== artifact.baselineState.stateDigest ||
    candidateBinding.stateDigest !== artifact.candidateState.stateDigest ||
    baselineBinding.baselineHeadDigest !== artifact.baselineHead.headDigest ||
    candidateBinding.baselineHeadDigest !== artifact.baselineHead.headDigest ||
    baselineBinding.surface !== artifact.surface ||
    candidateBinding.surface !== artifact.surface ||
    baselineBinding.candidateDigest !== artifact.candidate.candidateDigest ||
    candidateBinding.candidateDigest !== artifact.candidate.candidateDigest ||
    baselineBinding.workflowSha256 !== artifact.baselineState.workflow.sha256 ||
    baselineBinding.workflowDigest !== artifact.baselineState.workflow.workflowDigest ||
    candidateBinding.workflowSha256 !== artifact.candidateState.workflow.sha256 ||
    candidateBinding.workflowDigest !== artifact.candidateState.workflow.workflowDigest ||
    !isDeepStrictEqual(
      baselineBinding.packageDigests,
      artifact.baselineState.packages.map((item) => item.digest),
    ) ||
    !isDeepStrictEqual(
      candidateBinding.packageDigests,
      artifact.candidateState.packages.map((item) => item.digest),
    ) ||
    canonicalize(candidate.candidate.identity) !== canonicalize(artifact.candidate)
  ) {
    throw new EffectiveHarnessActivationAdmissionError(
      "identity_mismatch",
      "effective harness evaluation does not match its candidate artifact",
    );
  }
}

function assertEvaluationModelRoutes(
  artifact: EffectiveHarnessCandidateArtifact,
  stored: EffectiveHarnessStoredEvaluation,
  baselineProfileId: string | undefined,
  candidateProfileId: string | undefined,
): void {
  const routes = stored.header.controls.modelRoutes;
  if (artifact.surface !== "model-routing") {
    if (routes !== undefined) throwIdentityMismatch();
    return;
  }
  const identity = artifact.candidate;
  if (
    !("kind" in identity) ||
    identity.kind !== "model-routing-candidate" ||
    routes === undefined ||
    routes[0].profileId !== baselineProfileId ||
    routes[1].profileId !== candidateProfileId ||
    routes[0].nodeId !== identity.scope.nodeId ||
    routes[1].nodeId !== identity.scope.nodeId ||
    !sameModelRoute(routes[0].route, identity.route.before) ||
    !sameModelRoute(routes[1].route, identity.route.after)
  ) {
    throwIdentityMismatch();
  }
}

function sameModelRoute(left: ModelRoute, right: ModelRoute): boolean {
  return (
    left.provider === right.provider && left.id === right.id && left.thinking === right.thinking
  );
}

function throwIdentityMismatch(): never {
  throw new EffectiveHarnessActivationAdmissionError(
    "identity_mismatch",
    "effective harness evaluation does not match its candidate artifact",
  );
}

function aggregateStoredEvaluation(stored: EffectiveHarnessStoredEvaluation) {
  const [firstProfile, secondProfile] = stored.header.profiles;
  if (firstProfile === undefined || secondProfile === undefined) {
    throw new EffectiveHarnessActivationAdmissionError(
      "invalid_evaluation",
      "effective harness evaluation must contain two profiles",
    );
  }
  try {
    return aggregateEvaluation(
      {
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
      },
      stored.records,
    );
  } catch (error) {
    if (error instanceof EvaluationAggregationError) {
      throw new EffectiveHarnessActivationAdmissionError(
        "invalid_evaluation",
        "effective harness evaluation is invalid",
      );
    }
    throw error;
  }
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
  throw new EffectiveHarnessActivationAdmissionError(
    "invalid_evaluation",
    "effective harness evaluation report is invalid",
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
