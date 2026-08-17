import { describe, expect, it } from "vitest";

import { createAgentSkillPackageActivationFromEvaluation } from "../../../src/application/prepare-agent-skill-package-activation.js";
import { createEvaluationSchedule } from "../../../src/domain/evaluation/plan.js";
import { createEvaluationTrialRecord } from "../../../src/domain/evaluation/records.js";
import type { StoredEvaluation } from "../../../src/infrastructure/fs/local-evaluation-store.js";
import { agentSkillPackageActivationFixture } from "../../fixtures/agent-skill-package-activation.js";

describe("Agent Skill package activation evaluation admission", () => {
  it("creates an exact generated-package activation and a package-free rollback", () => {
    const fixture = agentSkillPackageActivationFixture();
    const stored = superiorStoredEvaluation();

    const activations = createAgentSkillPackageActivationFromEvaluation(liveCandidate(), stored);

    expect(activations.candidate).toMatchObject({
      kind: "agent-skill-package-activation",
      selection: "candidate",
      skill: { digest: fixture.completed.package.digest },
      evaluation: {
        evaluationId: stored.header.evaluationId,
        terminalRecordDigest: stored.records.at(-1)?.recordDigest,
        comparison: { verdict: "superior" },
      },
    });
    expect(activations.baseline).toMatchObject({
      kind: "agent-skill-package-activation",
      selection: "baseline",
    });
    expect(activations.baseline).not.toHaveProperty("skill");
  });

  it.each([
    [
      "candidate provenance",
      (stored: MutableStoredEvaluation) => {
        const candidate = requiredProfile(stored, "candidate").candidate;
        if (candidate === undefined) {
          throw new Error("Agent Skill package activation fixture has no candidate identity");
        }
        candidate.provenance = "other-candidate";
      },
    ],
    [
      "candidate source kind",
      (stored: MutableStoredEvaluation) => {
        requiredProfile(stored, "candidate").workflow.sourceKind = "prompt-candidate-projection";
      },
    ],
    [
      "candidate workflow digest",
      (stored: MutableStoredEvaluation) => {
        requiredProfile(stored, "candidate").workflow.workflowDigest = "f".repeat(64);
      },
    ],
    [
      "candidate capability digest",
      (stored: MutableStoredEvaluation) => {
        requiredProfile(stored, "candidate").capabilitySnapshotDigest = "f".repeat(64);
      },
    ],
    [
      "candidate package list",
      (stored: MutableStoredEvaluation) => {
        requiredProfile(stored, "candidate").capabilityPackageDigests = [];
      },
    ],
    [
      "baseline workflow digest",
      (stored: MutableStoredEvaluation) => {
        requiredProfile(stored, "baseline").workflow.workflowDigest = "f".repeat(64);
      },
    ],
    [
      "baseline source kind",
      (stored: MutableStoredEvaluation) => {
        requiredProfile(stored, "baseline").workflow.sourceKind =
          "agent-skill-package-candidate-projection";
      },
    ],
    [
      "baseline capability digest",
      (stored: MutableStoredEvaluation) => {
        requiredProfile(stored, "baseline").capabilitySnapshotDigest = "f".repeat(64);
      },
    ],
    [
      "baseline package list",
      (stored: MutableStoredEvaluation) => {
        requiredProfile(stored, "baseline").capabilityPackageDigests = ["f".repeat(64)];
      },
    ],
  ])("rejects a substituted durable %s", (_label, mutate) => {
    const stored = structuredClone(superiorStoredEvaluation()) as MutableStoredEvaluation;
    mutate(stored);

    expect(() =>
      createAgentSkillPackageActivationFromEvaluation(liveCandidate(), stored),
    ).toThrowError(expect.objectContaining({ code: "identity_mismatch" }));
  });
});

type DeepMutable<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
      : Value;

type MutableStoredEvaluation = DeepMutable<StoredEvaluation>;

function requiredProfile(stored: MutableStoredEvaluation, id: "baseline" | "candidate") {
  const profile = stored.header.profiles.find((item) => item.id === id);
  if (profile?.adapter !== "flow-workflow-v1") {
    throw new Error(`Agent Skill package activation fixture has no ${id} profile`);
  }
  return profile;
}

function liveCandidate() {
  const fixture = agentSkillPackageActivationFixture();
  return Object.freeze({
    identity: fixture.projected.identity,
    baselineWorkflow: {
      source: fixture.prompt.baselineText,
      sourceSha256: fixture.projected.identity.baseline.workflow.sourceSha256,
      workflowDigest: fixture.projected.identity.baseline.workflow.workflowDigest,
    },
    candidateWorkflow: {
      source: fixture.projected.workflow.source,
      sourceSha256: fixture.projected.identity.projectedWorkflow.sourceSha256,
      workflowDigest: fixture.projected.identity.projectedWorkflow.workflowDigest,
    },
    candidateSkill: fixture.completed.package,
  });
}

function superiorStoredEvaluation(): StoredEvaluation {
  const live = liveCandidate();
  const planDigest = "b".repeat(64);
  const schedule = createEvaluationSchedule(
    planDigest,
    ["holdout-task"],
    ["baseline", "candidate"],
    [1, 2],
  );
  let previousDigest: string | null = null;
  const records = schedule.map((item) => {
    const succeeds = item.profileId === "candidate";
    const record = createEvaluationTrialRecord({
      schedule: item,
      planDigest,
      previousDigest,
      startedAt: "2026-08-17T00:00:00.000Z",
      completedAt: "2026-08-17T00:00:01.000Z",
      environment: {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v27.0.0",
        flowVersion: "0.0.0-test",
        workspaceBackend: "reflink-copy-v1",
        workspaceSnapshotDigest: "d".repeat(64),
      },
      harness: succeeds
        ? { outcome: "completed", runId: `run-${item.position}`, reason: null }
        : { outcome: "failed", runId: `run-${item.position}`, reason: "profile failed" },
      verification: succeeds
        ? {
            outcome: "accepted",
            verifierDigest: "c".repeat(64),
            assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
          }
        : { outcome: "not_run", verifierDigest: "c".repeat(64), assertions: [] },
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
  return {
    header: {
      version: 1,
      evaluationId: "evaluation-1",
      createdAt: "2026-08-17T00:00:00.000Z",
      planDigest,
      apiVersion: "flow.synapti.ai/v1alpha1",
      planId: "skill-package-activation-evaluation",
      suite: {
        id: "activation-suite",
        version: "1.0.0",
        tasks: [
          {
            id: "holdout-task",
            partition: "holdout",
            fixture: {
              provenance: "fixture",
              digest: "e".repeat(64),
              entryCount: 1,
              logicalBytes: 1,
              instructionPath: "TASK.md",
              instructionSha256: "f".repeat(64),
            },
            verifier: { kind: "filesystem-v1", digest: "c".repeat(64), assertionCount: 1 },
          },
        ],
      },
      profiles: [
        {
          id: "baseline",
          adapter: "flow-workflow-v1",
          workflow: {
            provenance: live.identity.baseline.workflow.provenance,
            sourceSha256: live.identity.baseline.workflow.sourceSha256,
            workflowDigest: live.identity.baseline.workflow.workflowDigest,
          },
        },
        {
          id: "candidate",
          adapter: "flow-workflow-v1",
          workflow: {
            sourceKind: "agent-skill-package-candidate-projection",
            provenance: "generated-review-helper",
            sourceSha256: live.identity.projectedWorkflow.sourceSha256,
            workflowDigest: live.identity.projectedWorkflow.workflowDigest,
          },
          capabilitySnapshotDigest: live.identity.package.capabilityDigest,
          capabilityPackageDigests: [live.identity.package.packageDigest],
          candidate: {
            provenance: "generated-review-helper",
            identity: live.identity,
          },
        },
      ],
      controls: {
        model: { provider: "test", id: "deterministic", thinking: "medium" },
        budget: {
          maxNodeStarts: 8,
          maxModelTokens: 10_000,
          maxCostUsdMicros: 1_000_000,
          maxExecutionMs: 300_000,
          maxArtifactBytes: 1_048_576,
        },
        network: "deny",
        retry: { providerRetries: 0, harnessRetries: 0 },
      },
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
      schedule: [...schedule],
    },
    records,
    activeAttempt: null,
  };
}
