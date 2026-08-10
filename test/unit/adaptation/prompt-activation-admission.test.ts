import { describe, expect, it } from "vitest";

import { createPromptActivationFromEvaluation } from "../../../src/application/prepare-prompt-activation.js";
import { createPromptActivationSnapshot } from "../../../src/domain/adaptation/prompt-activation.js";
import { createEvaluationSchedule } from "../../../src/domain/evaluation/plan.js";
import { createEvaluationTrialRecord } from "../../../src/domain/evaluation/records.js";
import type { StoredEvaluation } from "../../../src/infrastructure/fs/local-evaluation-store.js";
import { promptActivationInput } from "../../fixtures/prompt-activation.js";

describe("prompt activation evaluation admission", () => {
  it("creates activation proof from the exact complete superior evaluation", () => {
    const candidate = createPromptActivationSnapshot(promptActivationInput());
    const stored = superiorStoredEvaluation(candidate);

    const activations = createPromptActivationFromEvaluation(
      {
        identity: candidate.candidate,
        baseline: {
          sourceText: promptActivationInput({ selection: "baseline" }).source,
          sourceSha256: candidate.candidate.baseline.sourceSha256,
          workflowDigest: candidate.candidate.baseline.workflowDigest,
        },
        workflow: {
          source: promptActivationInput().source,
          sourceSha256: candidate.source.sha256,
          workflowDigest: candidate.candidate.projectedWorkflow.workflowDigest,
        },
      },
      stored,
    );

    expect(activations).toMatchObject({
      candidate: {
        selection: "candidate",
        workflowId: "adaptive-workflow",
        candidateId: "better-instructions",
        candidateVersion: "1.0.0",
        evaluation: {
          evaluationId: "evaluation-1",
          planDigest: stored.header.planDigest,
          terminalRecordDigest: stored.records.at(-1)?.recordDigest,
          baselineProfileId: "baseline",
          candidateProfileId: "candidate",
          scheduledTrials: 4,
          committedTrials: 4,
          comparison: {
            verdict: "superior",
            scheduledPairs: 2,
            completePairs: 2,
            comparablePairs: 2,
          },
        },
      },
      baseline: { selection: "baseline", workflowId: "adaptive-workflow" },
    });
    expect(activations.candidate.evaluation.reportDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(activations.baseline.evaluation).toEqual(activations.candidate.evaluation);
  });

  it("rejects an incomplete evaluation before activation", () => {
    const candidate = createPromptActivationSnapshot(promptActivationInput());
    const stored = superiorStoredEvaluation(candidate);

    expect(() =>
      createPromptActivationFromEvaluation(liveCandidate(candidate), {
        ...stored,
        records: stored.records.slice(0, -1),
      }),
    ).toThrowError(expect.objectContaining({ code: "evaluation_incomplete" }));
  });

  it("rejects a complete evaluation that is not superior", () => {
    const candidate = createPromptActivationSnapshot(promptActivationInput());
    const stored = superiorStoredEvaluation(candidate, false);

    expect(() =>
      createPromptActivationFromEvaluation(liveCandidate(candidate), stored),
    ).toThrowError(expect.objectContaining({ code: "evaluation_not_superior" }));
  });

  it("rejects evaluation profiles that do not match the live candidate", () => {
    const candidate = createPromptActivationSnapshot(promptActivationInput());
    const stored = superiorStoredEvaluation(candidate);
    const baseline = stored.header.profiles[0];
    const selected = stored.header.profiles[1];
    if (
      baseline === undefined ||
      selected === undefined ||
      baseline.adapter !== "flow-workflow-v1" ||
      selected.adapter !== "flow-workflow-v1"
    ) {
      throw new Error("evaluation profile fixture is incomplete");
    }
    const changed = {
      ...stored,
      header: {
        ...stored.header,
        profiles: [
          {
            ...baseline,
            workflow: { ...baseline.workflow, sourceSha256: "0".repeat(64) },
          },
          selected,
        ],
      },
    };

    expect(() =>
      createPromptActivationFromEvaluation(liveCandidate(candidate), changed),
    ).toThrowError(expect.objectContaining({ code: "identity_mismatch" }));
  });
});

function liveCandidate(candidate: ReturnType<typeof createPromptActivationSnapshot>) {
  return {
    identity: candidate.candidate,
    baseline: {
      sourceText: promptActivationInput({ selection: "baseline" }).source,
      sourceSha256: candidate.candidate.baseline.sourceSha256,
      workflowDigest: candidate.candidate.baseline.workflowDigest,
    },
    workflow: {
      source: promptActivationInput().source,
      sourceSha256: candidate.source.sha256,
      workflowDigest: candidate.candidate.projectedWorkflow.workflowDigest,
    },
  };
}

function superiorStoredEvaluation(
  activation: ReturnType<typeof createPromptActivationSnapshot>,
  candidateWins = true,
): StoredEvaluation {
  const planDigest = "b".repeat(64);
  const schedule = createEvaluationSchedule(
    planDigest,
    ["holdout-task"],
    ["baseline", "candidate"],
    [1, 2],
  );
  let previousDigest: string | null = null;
  const records = schedule.map((item) => {
    const isCandidate = item.profileId === "candidate";
    const succeeds = isCandidate === candidateWins;
    const record = createEvaluationTrialRecord({
      schedule: item,
      planDigest,
      previousDigest,
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T00:00:01.000Z",
      environment: {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v22.19.0",
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
        : {
            outcome: "not_run",
            verifierDigest: "c".repeat(64),
            assertions: [],
          },
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
      createdAt: "2026-08-09T00:00:00.000Z",
      planDigest,
      apiVersion: "flow.synapti.ai/v1alpha1",
      planId: "activation-evaluation",
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
            provenance: activation.candidate.baseline.provenance,
            sourceSha256: activation.candidate.baseline.sourceSha256,
            workflowDigest: activation.candidate.baseline.workflowDigest,
          },
        },
        {
          id: "candidate",
          adapter: "flow-workflow-v1",
          workflow: {
            sourceKind: "prompt-candidate-projection",
            provenance: activation.candidate.manifest.provenance,
            sourceSha256: activation.candidate.projectedWorkflow.sourceSha256,
            workflowDigest: activation.candidate.projectedWorkflow.workflowDigest,
          },
          candidate: {
            provenance: activation.candidate.manifest.provenance,
            identity: activation.candidate,
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
