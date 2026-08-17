import { projectEffectiveHarnessCandidate } from "../../src/application/prepare-effective-harness-candidate.js";
import {
  createEffectiveHarnessCandidateArtifact,
  type EffectiveHarnessCandidateArtifact,
} from "../../src/domain/adaptation/effective-harness-candidate.js";
import {
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
} from "../../src/domain/adaptation/effective-harness-state.js";
import { calculateCapabilitySnapshotDigest } from "../../src/domain/capability/agent-skills.js";
import {
  calculateEvaluationPlanDigest,
  createEvaluationSchedule,
  type EvaluationPlanIdentity,
} from "../../src/domain/evaluation/plan.js";
import { createEvaluationTrialRecord } from "../../src/domain/evaluation/records.js";
import type {
  PublicEvaluationHeader,
  StoredEvaluation,
} from "../../src/infrastructure/fs/local-evaluation-store.js";
import { agentSkillPackageActivationFixture } from "./agent-skill-package-activation.js";

const scopeDigest = "a".repeat(64);

export function effectiveHarnessCandidateArtifactFixture(): EffectiveHarnessCandidateArtifact {
  const fixture = agentSkillPackageActivationFixture();
  const baseline = createEffectiveHarnessState({
    scopeDigest,
    workflowSource: fixture.prompt.baselineText,
    packages: [],
  });
  const projected = projectEffectiveHarnessCandidate({
    baseline,
    candidate: {
      kind: "agent-skill-package",
      projection: fixture.projected,
      baselineWorkflowSource: fixture.prompt.baselineText,
    },
  });
  return createEffectiveHarnessCandidateArtifact({
    baselineHead: createEffectiveHarnessHeadIdentity({
      scopeDigest,
      workflowId: baseline.workflowId,
      generation: 3,
      activationDigest: "b".repeat(64),
      transitionDigest: "c".repeat(64),
      stateDigest: baseline.stateDigest,
    }),
    baselineState: baseline,
    candidateState: projected.state,
    candidate: fixture.projected.identity,
  });
}

export function superiorEffectiveHarnessEvaluation(
  artifact: EffectiveHarnessCandidateArtifact = effectiveHarnessCandidateArtifactFixture(),
  candidateWins = true,
): StoredEvaluation {
  const controls = {
    model: { provider: "test", id: "deterministic", thinking: "medium" as const },
    budget: {
      maxNodeStarts: 8,
      maxModelTokens: 10_000,
      maxCostUsdMicros: 1_000_000,
      maxExecutionMs: 300_000,
      maxArtifactBytes: 1_048_576,
    },
    network: "deny" as const,
    retry: { providerRetries: 0 as const, harnessRetries: 0 as const },
  };
  const task = {
    id: "holdout-task",
    partition: "holdout" as const,
    fixture: {
      provenance: "fixture",
      digest: "d".repeat(64),
      entryCount: 1,
      logicalBytes: 1,
      instructionPath: "TASK.md",
      instructionSha256: "e".repeat(64),
    },
    verifier: { kind: "filesystem-v1" as const, digest: "f".repeat(64), assertionCount: 1 },
  };
  const candidatePackageDigests = artifact.candidateState.packages.map((item) => item.digest);
  const profiles: EvaluationPlanIdentity["profiles"] = [
    {
      id: "baseline",
      adapter: "flow-workflow-v1",
      workflow: {
        sourceKind: "effective-harness-baseline",
        provenance: "candidate.effective-harness.json",
        sourceSha256: artifact.baselineState.workflow.sha256,
        workflowDigest: artifact.baselineState.workflow.workflowDigest,
      },
      effectiveHarness: effectiveBinding(artifact, "baseline"),
    },
    {
      id: "candidate",
      adapter: "flow-workflow-v1",
      workflow: {
        sourceKind: "effective-harness-candidate-projection",
        provenance: "candidate.effective-harness.json",
        sourceSha256: artifact.candidateState.workflow.sha256,
        workflowDigest: artifact.candidateState.workflow.workflowDigest,
      },
      ...(candidatePackageDigests.length === 0
        ? {}
        : {
            capabilitySnapshotDigest: calculateCapabilitySnapshotDigest(
              artifact.candidateState.packages,
            ),
            capabilityPackageDigests: candidatePackageDigests,
          }),
      candidate: {
        provenance: "candidate.effective-harness.json",
        identity: artifact.candidate,
      },
      effectiveHarness: effectiveBinding(artifact, "candidate"),
    },
  ];
  const identity: EvaluationPlanIdentity = {
    version: 1,
    apiVersion: "flow.synapti.ai/v1alpha1",
    id: "effective-harness-evaluation",
    suite: { id: "activation-suite", version: "1.0.0", tasks: [task] },
    profiles,
    controls,
    seeds: [1, 2],
    order: "paired-alternating-v1",
    comparison: {
      baselineProfileId: "baseline",
      candidateProfileId: "candidate",
      minimumPairedTrials: 2,
      confidenceLevel: 0.95,
      minimumEffect: 0,
      maxFalseCompletionRate: 0,
      maxPolicyViolations: 0,
      maxVerifiedSuccessRegression: 0,
    },
  };
  const planDigest = calculateEvaluationPlanDigest(identity);
  const schedule = createEvaluationSchedule(
    planDigest,
    [task.id],
    ["baseline", "candidate"],
    [1, 2],
  );
  const header: PublicEvaluationHeader = {
    version: 1,
    evaluationId: "effective-harness-evaluation",
    createdAt: "2026-08-17T00:00:00.000Z",
    planDigest,
    apiVersion: identity.apiVersion,
    planId: identity.id,
    suite: { ...identity.suite, tasks: [...identity.suite.tasks] },
    profiles: [...profiles],
    controls,
    seeds: [1, 2],
    order: identity.order,
    comparison: identity.comparison,
    schedule: [...schedule],
  };
  let previousDigest: string | null = null;
  const records = schedule.map((item) => {
    const succeeds = (item.profileId === "candidate") === candidateWins;
    const record = createEvaluationTrialRecord({
      schedule: item,
      planDigest,
      previousDigest,
      startedAt: "2026-08-17T00:00:00.000Z",
      completedAt: "2026-08-17T00:00:01.000Z",
      environment: {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v22.19.0",
        flowVersion: "0.0.0-test",
        workspaceBackend: "reflink-copy-v1",
        workspaceSnapshotDigest: "1".repeat(64),
      },
      harness: succeeds
        ? { outcome: "completed", runId: `run-${item.position}`, reason: null }
        : { outcome: "failed", runId: `run-${item.position}`, reason: "profile failed" },
      verification: succeeds
        ? {
            outcome: "accepted",
            verifierDigest: task.verifier.digest,
            assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
          }
        : { outcome: "not_run", verifierDigest: task.verifier.digest, assertions: [] },
      metrics: {
        costUsdMicros: 1,
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        turns: 1,
        toolCalls: 0,
        toolErrors: 0,
        wallTimeMs: 1,
        activeTimeMs: 1,
        interventions: 0,
        policyViolations: 0,
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
      },
    });
    previousDigest = record.recordDigest;
    return record;
  });
  return Object.freeze({ header, records: Object.freeze(records), activeAttempt: null });
}

function effectiveBinding(
  artifact: EffectiveHarnessCandidateArtifact,
  selection: "baseline" | "candidate",
) {
  const state = selection === "baseline" ? artifact.baselineState : artifact.candidateState;
  return {
    selection,
    artifactDigest: artifact.artifactDigest,
    stateDigest: state.stateDigest,
    baselineHeadDigest: artifact.baselineHead.headDigest,
    workflowSha256: state.workflow.sha256,
    workflowDigest: state.workflow.workflowDigest,
    packageDigests: state.packages.map((item) => item.digest),
    surface: artifact.surface,
    candidateDigest: artifact.candidate.candidateDigest,
  } as const;
}
