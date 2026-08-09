import { createHash } from "node:crypto";

import type { CreatePromptActivationSnapshotInput } from "../../src/domain/adaptation/prompt-activation.js";
import {
  calculatePromptCandidateIdentityDigest,
  type PromptCandidateIdentity,
} from "../../src/domain/adaptation/prompt-candidate.js";
import { compileWorkflowText } from "../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../src/domain/workflow/digest.js";

const defaultPrompt = "Read TASK.md and verify the result.";
const baselinePrompt = "Implement the task.";

export const projectedPromptActivationSource = projectedSource(defaultPrompt);
export const baselinePromptActivationSource = projectedSource(baselinePrompt);

export interface PromptActivationFixtureOptions {
  readonly candidateId?: string;
  readonly candidateVersion?: string;
  readonly prompt?: string;
  readonly requiresApproval?: boolean;
  readonly selection?: "baseline" | "candidate";
  readonly sourceBytes?: number;
}

export function promptActivationInput(
  options: PromptActivationFixtureOptions = {},
): CreatePromptActivationSnapshotInput {
  const candidateId = options.candidateId ?? "better-instructions";
  const candidateVersion = options.candidateVersion ?? "1.0.0";
  const prompt = options.prompt ?? defaultPrompt;
  const requiresApproval = options.requiresApproval ?? false;
  const baseProjected = projectedSource(prompt, requiresApproval);
  const projected =
    options.sourceBytes === undefined
      ? baseProjected
      : `${baseProjected}${" ".repeat(
          Math.max(0, options.sourceBytes - Buffer.byteLength(baseProjected, "utf8")),
        )}`;
  const baseline = projectedSource(baselinePrompt, requiresApproval);
  const selection = options.selection ?? "candidate";
  const source = selection === "candidate" ? projected : baseline;
  const projectedWorkflow = {
    sourceSha256: sha256(projected),
    workflowDigest: calculateWorkflowDigest(compileWorkflowText(projected, "candidate.yaml")),
  };
  const baselineWorkflow = compileWorkflowText(baseline, "baseline.workflow.yaml");
  const identityWithoutDigest: Omit<PromptCandidateIdentity, "candidateDigest"> = {
    version: 1,
    id: candidateId,
    candidateVersion,
    scope: { kind: "workflow", workflowId: "adaptive-workflow" },
    manifest: { provenance: "candidate.yaml", sourceSha256: "1".repeat(64) },
    baseline: {
      provenance: "baseline.workflow.yaml",
      sourceSha256: sha256(baseline),
      workflowDigest: calculateWorkflowDigest(baselineWorkflow),
    },
    evidence: [
      {
        provenance: "tuning.json",
        sourceSha256: "4".repeat(64),
        evidenceDigest: "5".repeat(64),
        planDigest: "6".repeat(64),
      },
    ],
    changes: [
      {
        nodeId: "implement",
        beforeSha256: sha256(baselinePrompt),
        afterSha256: sha256(prompt),
      },
    ],
    projectedWorkflow,
  };
  const candidate: PromptCandidateIdentity = {
    ...identityWithoutDigest,
    candidateDigest: calculatePromptCandidateIdentityDigest(identityWithoutDigest),
  };
  return {
    selection,
    candidate,
    evaluation: {
      evaluationId: "evaluation-1",
      planDigest: "8".repeat(64),
      terminalRecordDigest: "9".repeat(64),
      reportDigest: "a".repeat(64),
      baselineProfileId: "baseline",
      candidateProfileId: "candidate",
      scheduledTrials: 8,
      committedTrials: 8,
      criteria: {
        minimumPairedTrials: 2,
        confidenceLevel: 0.95,
        minimumEffect: 0,
        maxFalseCompletionRate: 0,
        maxPolicyViolations: 0,
        maxVerifiedSuccessRegression: 0,
      },
      comparison: {
        verdict: "superior",
        scheduledPairs: 2,
        completePairs: 2,
        comparablePairs: 2,
        pairedSuccessDelta: 1,
        confidenceInterval: { lower: 0.5, upper: 1, level: 0.95 },
        constraints: {
          falseCompletionRate: true,
          policyViolations: true,
          verifiedSuccessRegression: true,
        },
      },
    },
    source,
  };
}

export function promptActivationSelections(
  options: Omit<PromptActivationFixtureOptions, "selection"> = {},
) {
  return Object.freeze({
    candidate: promptActivationInput({ ...options, selection: "candidate" }),
    baseline: promptActivationInput({ ...options, selection: "baseline" }),
  });
}

function projectedSource(prompt: string, requiresApproval = false): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "adaptive-workflow" },
    nodes: [
      ...(requiresApproval
        ? [
            {
              id: "gate",
              type: "command",
              approval: { mode: "required", grantTtlMs: 60_000 },
              command: { executable: "/usr/bin/true", timeoutMs: 10_000 },
            },
          ]
        : []),
      {
        id: "implement",
        type: "agent",
        dependsOn: requiresApproval ? ["gate"] : [],
        agent: {
          prompt,
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
