import { createHash } from "node:crypto";

import {
  type PromptCandidateGenerationInput,
  preparePromptCandidateGeneration,
} from "../../src/domain/adaptation/prompt-candidate-generation.js";
import { createEvaluationSchedule } from "../../src/domain/evaluation/plan.js";
import { createEvaluationTrialRecord } from "../../src/domain/evaluation/records.js";
import { createTuningEvidencePacket } from "../../src/domain/evaluation/tuning-evidence.js";
import {
  compileWorkflowText,
  parseWorkflowSourceText,
} from "../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../src/domain/workflow/digest.js";

export function promptCandidateGenerationFixture() {
  const baselineText = promptCandidateWorkflowText();
  const baseline = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  const evidence = promptCandidateTuningEvidence(calculateWorkflowDigest(baseline));
  const input: PromptCandidateGenerationInput = {
    candidate: { id: "generated-instructions", version: "1.0.0" },
    baseline: {
      provenance: "baseline.workflow.yaml",
      sourceSha256: sha256(baselineText),
      workflowDigest: calculateWorkflowDigest(baseline),
      source: parseWorkflowSourceText(baselineText, "baseline.workflow.yaml"),
      compiled: baseline,
    },
    evidence: [
      {
        provenance: "tuning-evidence.json",
        sourceSha256: sha256(JSON.stringify(evidence)),
        packet: evidence,
      },
    ],
    allowedNodeIds: ["implement"],
    model: { provider: "test", id: "deterministic", thinking: "medium" },
    limits: { timeoutMs: 300_000, maxOutputTokens: 8_192 },
  };
  const prepared = preparePromptCandidateGeneration(input);
  return { baselineText, baseline, evidence, input, prepared };
}

export function promptCandidateWorkflowText(): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "adaptive-workflow" },
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
        id: "private-review",
        type: "agent",
        dependsOn: ["implement"],
        agent: {
          prompt: "Review the private result.",
          model: { provider: "test", id: "deterministic", thinking: "medium" },
          tools: ["read"],
          skills: [],
          toolPackages: [],
          timeoutMs: 300_000,
        },
      },
      {
        id: "publish",
        type: "result",
        dependsOn: ["private-review"],
        result: {
          source: { nodeId: "private-review", field: "agent.text" },
          schema: { type: "string", maxLength: 1_024 },
        },
      },
    ],
  });
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function promptCandidateTuningEvidence(
  workflowDigest: string,
  evaluationId = "source-evaluation",
) {
  const planDigest = "a".repeat(64);
  const schedule = createEvaluationSchedule(
    planDigest,
    ["tune-task", "private-holdout-task"],
    ["baseline", "candidate"],
    [7],
  );
  let previousDigest: string | null = null;
  const records = schedule.map((item) => {
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
        workspaceSnapshotDigest: "9".repeat(64),
      },
      harness: { outcome: "completed", runId: "private-run", reason: null },
      verification: {
        outcome: "accepted",
        verifierDigest: "b".repeat(64),
        assertions: [{ kind: "exists", path: "SECRET.md", outcome: true }],
      },
      metrics: {
        costUsdMicros: 10,
        inputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
        turns: 1,
        toolCalls: 0,
        toolErrors: 0,
        wallTimeMs: 1_000,
        activeTimeMs: 900,
        interventions: 0,
        policyViolations: 0,
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
      },
    });
    previousDigest = record.recordDigest;
    return record;
  });
  return createTuningEvidencePacket({
    evaluationId,
    planDigest,
    suite: { id: "adaptive-suite", version: "1.0.0" },
    tasks: [
      { id: "tune-task", partition: "tuning" },
      { id: "private-holdout-task", partition: "holdout" },
    ],
    profiles: [
      { id: "baseline", adapter: "flow-workflow-v1", workflowDigest },
      { id: "candidate", adapter: "flow-workflow-v1", workflowDigest: "c".repeat(64) },
    ],
    schedule,
    records,
  });
}
