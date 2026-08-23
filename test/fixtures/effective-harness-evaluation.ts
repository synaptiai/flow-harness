import { createHash } from "node:crypto";

import { projectEffectiveHarnessCandidate } from "../../src/application/prepare-effective-harness-candidate.js";
import {
  createEffectiveHarnessCandidateArtifact,
  type EffectiveHarnessCandidateArtifact,
} from "../../src/domain/adaptation/effective-harness-candidate.js";
import {
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
} from "../../src/domain/adaptation/effective-harness-state.js";
import {
  parseSupplementalMemoryCandidateText,
  projectSupplementalMemoryCandidate,
} from "../../src/domain/adaptation/supplemental-memory-candidate.js";
import {
  completeSupplementalMemoryCandidateGeneration,
  prepareSupplementalMemoryCandidateGeneration,
} from "../../src/domain/adaptation/supplemental-memory-candidate-generation.js";
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
import { childSpecialistCandidateFixture } from "./child-specialist-candidate.js";
import { modelRoutingCandidateFixture } from "./model-routing-candidate.js";
import {
  promptCandidateTuningEvidence,
  promptCandidateWorkflowText,
} from "./prompt-candidate-generation.js";

const scopeDigest = "a".repeat(64);
export const supplementalMemoryGenerationEvidenceProvenance = "PRIVATE_MEMORY_TUNING_EVIDENCE.json";
export const supplementalMemoryRelationshipEvidenceRunId = "PRIVATE_RELATIONSHIP_PROOF_RUN";

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

export function childSpecialistEffectiveHarnessCandidateArtifactFixture(
  candidateScopeDigest = scopeDigest,
): EffectiveHarnessCandidateArtifact {
  const fixture = childSpecialistCandidateFixture();
  const baseline = createEffectiveHarnessState({
    scopeDigest: candidateScopeDigest,
    workflowSource: fixture.baselineText,
    packages: fixture.packages,
  });
  const projected = projectEffectiveHarnessCandidate({
    baseline,
    candidate: {
      kind: "child-specialist",
      projection: fixture.projected,
      baselineWorkflowSource: fixture.baselineText,
    },
  });
  return createEffectiveHarnessCandidateArtifact({
    baselineHead: createEffectiveHarnessHeadIdentity({
      scopeDigest: candidateScopeDigest,
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

export function modelRoutingEffectiveHarnessCandidateArtifactFixture(): EffectiveHarnessCandidateArtifact {
  const baselineSource = promptCandidateWorkflowText();
  const baseline = createEffectiveHarnessState({
    scopeDigest,
    workflowSource: baselineSource,
    packages: [],
  });
  const route = modelRoutingCandidateFixture(baselineSource);
  const projected = projectEffectiveHarnessCandidate({
    baseline,
    candidate: {
      kind: "model-routing",
      projection: route,
      baselineWorkflowSource: baselineSource,
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
    candidate: route.identity,
  });
}

export function supplementalMemoryEffectiveHarnessCandidateArtifactFixture(
  candidateScopeDigest = scopeDigest,
): EffectiveHarnessCandidateArtifact {
  const baselineSource = supplementalMemoryWorkflowText();
  const baseline = createEffectiveHarnessState({
    scopeDigest: candidateScopeDigest,
    workflowSource: baselineSource,
    packages: [],
  });
  const evidence = promptCandidateTuningEvidence(baseline.workflow.workflowDigest);
  const admittedEvidence = [
    {
      provenance: supplementalMemoryGenerationEvidenceProvenance,
      sourceSha256: sha256(JSON.stringify(evidence)),
      packet: evidence,
    },
  ];
  const prepared = prepareSupplementalMemoryCandidateGeneration({
    candidate: { id: "reviewed-fixture-memory", version: "1.0.0" },
    baseline,
    target: {
      workflowId: baseline.workflowId,
      childPath: [],
      agentNodeId: "implement",
      entryId: "reviewed-fixture",
      operation: "add",
    },
    evidence: admittedEvidence,
    model: { provider: "test", id: "deterministic", thinking: "medium" },
    limits: { timeoutMs: 300_000, maxOutputTokens: 8_192 },
  });
  const source = completeSupplementalMemoryCandidateGeneration(
    prepared,
    JSON.stringify({ value: "PRIVATE_MEMORY_USE_THE_REVIEWED_FIXTURE" }),
    {
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
      costUsdMicros: 10,
    },
  );
  const sourceText = JSON.stringify(source);
  const projected = projectSupplementalMemoryCandidate({
    manifestProvenance: "memory.candidate.json",
    sourceSha256: sha256(sourceText),
    source: parseSupplementalMemoryCandidateText(sourceText),
    baseline,
    evidence: admittedEvidence,
  });
  return createEffectiveHarnessCandidateArtifact({
    baselineHead: createEffectiveHarnessHeadIdentity({
      scopeDigest: candidateScopeDigest,
      workflowId: baseline.workflowId,
      generation: 3,
      activationDigest: "b".repeat(64),
      transitionDigest: "c".repeat(64),
      stateDigest: baseline.stateDigest,
    }),
    baselineState: baseline,
    candidateState: projected.state,
    candidate: projected.identity,
  });
}

export function supplementalMemoryRelationshipEffectiveHarnessCandidateArtifactFixture(
  candidateScopeDigest = scopeDigest,
): EffectiveHarnessCandidateArtifact {
  const baselineSource = supplementalMemoryWorkflowText();
  const target = {
    workflowId: "memory-evaluation-workflow",
    childPath: [] as string[],
    agentNodeId: "implement",
  };
  const existingContent = "Use the retained relationship baseline.";
  const candidateContent = "PRIVATE_MEMORY_USE_THE_REVIEWED_FIXTURE";
  const baseline = createEffectiveHarnessState({
    scopeDigest: candidateScopeDigest,
    workflowSource: baselineSource,
    packages: [],
    supplementalMemory: [{ id: "existing-fact", target, content: existingContent }],
  });
  const sourceValue = {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "SupplementalMemoryCandidate",
    metadata: { id: "reviewed-fixture-memory", version: "1.0.0" },
    scope: {
      kind: "workflow-agent-memory",
      ...target,
      entryId: "reviewed-fixture",
    },
    baseline: {
      stateDigest: baseline.stateDigest,
      workflowDigest: baseline.workflow.workflowDigest,
      packageClosureDigest: calculateCapabilitySnapshotDigest(baseline.packages),
    },
    change: { kind: "add", value: candidateContent },
    relationships: {
      remove: [],
      add: [
        {
          id: "fixture-support",
          predicate: "supports",
          from: { entryId: "reviewed-fixture", entrySha256: sha256(candidateContent) },
          to: { entryId: "existing-fact", entrySha256: sha256(existingContent) },
          evidence: [
            {
              runId: supplementalMemoryRelationshipEvidenceRunId,
              nodeId: "implement",
              attempt: 1,
            },
          ],
        },
      ],
    },
  };
  const sourceText = JSON.stringify(sourceValue);
  const projected = projectSupplementalMemoryCandidate({
    manifestProvenance: "memory-relationship.candidate.json",
    sourceSha256: sha256(sourceText),
    source: parseSupplementalMemoryCandidateText(sourceText),
    baseline,
    relationshipEvidence: [
      {
        runId: supplementalMemoryRelationshipEvidenceRunId,
        nodeId: "implement",
        attempt: 1,
        sequence: 7,
        eventDigest: "7".repeat(64),
      },
    ],
  });
  return createEffectiveHarnessCandidateArtifact({
    baselineHead: createEffectiveHarnessHeadIdentity({
      scopeDigest: candidateScopeDigest,
      workflowId: baseline.workflowId,
      generation: 3,
      activationDigest: "b".repeat(64),
      transitionDigest: "c".repeat(64),
      stateDigest: baseline.stateDigest,
    }),
    baselineState: baseline,
    candidateState: projected.state,
    candidate: projected.identity,
  });
}

export function superiorEffectiveHarnessEvaluation(
  artifact: EffectiveHarnessCandidateArtifact = effectiveHarnessCandidateArtifactFixture(),
  candidateWins = true,
): StoredEvaluation {
  const controls: EvaluationPlanIdentity["controls"] = {
    model: { provider: "test", id: "deterministic", thinking: "medium" as const },
    ...(artifact.surface === "model-routing" &&
    "kind" in artifact.candidate &&
    artifact.candidate.kind === "model-routing-candidate"
      ? {
          modelRoutes: [
            {
              profileId: "baseline",
              nodeId: artifact.candidate.scope.nodeId,
              route: artifact.candidate.route.before,
            },
            {
              profileId: "candidate",
              nodeId: artifact.candidate.scope.nodeId,
              route: artifact.candidate.route.after,
            },
          ] as const,
        }
      : {}),
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
    suite: { id: identity.suite.id, version: identity.suite.version, tasks: [task] },
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
    workflowId: state.workflowId,
    workflowSha256: state.workflow.sha256,
    workflowDigest: state.workflow.workflowDigest,
    packageDigests: state.packages.map((item) => item.digest),
    surface: artifact.surface,
    candidateDigest: artifact.candidate.candidateDigest,
  } as const;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function supplementalMemoryWorkflowText(): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "memory-evaluation-workflow" },
    budget: {
      maxNodeStarts: 8,
      maxModelTokens: 10_000,
      maxCostUsd: 1,
      maxExecutionMs: 300_000,
      maxArtifactBytes: 1_048_576,
    },
    nodes: [
      {
        id: "implement",
        type: "agent",
        agent: {
          prompt: "Implement the task.",
          model: { provider: "test", id: "deterministic", thinking: "medium" },
          tools: ["read", "edit"],
          skills: [],
          toolPackages: [],
          timeoutMs: 300_000,
        },
      },
      {
        id: "publish",
        type: "result",
        dependsOn: ["implement"],
        result: {
          source: { nodeId: "implement", field: "agent.text" },
          schema: { type: "string", maxLength: 1_024 },
        },
      },
    ],
  });
}
