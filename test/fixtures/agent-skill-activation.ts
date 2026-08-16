import { createHash } from "node:crypto";

import {
  type AgentSkillCandidateIdentity,
  calculateAgentSkillCandidateIdentityDigest,
} from "../../src/domain/adaptation/agent-skill-candidate.js";
import type { PromptActivationEvaluationProof } from "../../src/domain/adaptation/prompt-activation.js";
import {
  type AgentSkillPackageSnapshot,
  createCapabilitySnapshot,
} from "../../src/domain/capability/agent-skills.js";
import { compileWorkflowText } from "../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../src/domain/workflow/digest.js";

export const agentSkillActivationWorkflowSource = activationWorkflowSource(
  false,
  "adaptive-skill-workflow",
);

const skillManifest = `---
name: review
description: Review the result against the task.
license: MIT
compatibility: Flow 1.x
metadata:
  owner: synapti
allowed-tools: Read
---
# Review

Use the review checklist.
`;

const baselineChecklist = "Check correctness and evidence.\n";
const projectedChecklist = "Check correctness, security, and evidence.\n";

export function agentSkillActivationInput(
  selection: "baseline" | "candidate" = "candidate",
  options: {
    readonly requiresApproval?: boolean;
    readonly sourceBytes?: number;
    readonly workflowId?: string;
  } = {},
) {
  const workflowId = options.workflowId ?? "adaptive-skill-workflow";
  const baseWorkflowSource = activationWorkflowSource(
    options.requiresApproval ?? false,
    workflowId,
  );
  const workflowSource =
    options.sourceBytes === undefined
      ? baseWorkflowSource
      : `${baseWorkflowSource}${" ".repeat(
          Math.max(0, options.sourceBytes - Buffer.byteLength(baseWorkflowSource, "utf8")),
        )}`;
  const baselineSnapshot = skillCapabilitySnapshot(baselineChecklist);
  const candidateSnapshot = skillCapabilitySnapshot(projectedChecklist);
  const baselineSkill = requiredSkill(baselineSnapshot.packages);
  const candidateSkill = requiredSkill(candidateSnapshot.packages);
  const workflowDigest = calculateWorkflowDigest(
    compileWorkflowText(workflowSource, "baseline.workflow.yaml"),
  );
  const candidateWithoutDigest: Omit<AgentSkillCandidateIdentity, "candidateDigest"> = {
    version: 1,
    kind: "agent-skill-candidate",
    id: "better-review",
    candidateVersion: "1.0.0",
    scope: {
      kind: "workflow-agent-skill",
      workflowId,
      skillName: "review",
    },
    manifest: { provenance: "candidate.yaml", sourceSha256: "1".repeat(64) },
    baseline: {
      workflow: {
        provenance: "baseline.workflow.yaml",
        sourceSha256: sha256(workflowSource),
        workflowDigest,
      },
      skill: {
        name: baselineSkill.name,
        provenance: baselineSkill.provenance,
        packageDigest: baselineSkill.digest,
        capabilityDigest: baselineSnapshot.digest,
      },
    },
    evidence: [
      {
        provenance: "tuning.json",
        sourceSha256: "2".repeat(64),
        evidenceDigest: "3".repeat(64),
        planDigest: "4".repeat(64),
      },
    ],
    changes: [
      {
        path: "references/checklist.md",
        beforeSha256: sha256(baselineChecklist),
        afterSha256: sha256(projectedChecklist),
      },
    ],
    projectedSkill: {
      packageDigest: candidateSkill.digest,
      capabilityDigest: candidateSnapshot.digest,
    },
  };
  const candidate: AgentSkillCandidateIdentity = {
    ...candidateWithoutDigest,
    candidateDigest: calculateAgentSkillCandidateIdentityDigest(candidateWithoutDigest),
  };
  return Object.freeze({
    selection,
    candidate,
    evaluation: activationEvaluationProof(),
    workflowSource,
    skill: selection === "candidate" ? candidateSkill : baselineSkill,
  });
}

function activationWorkflowSource(requiresApproval: boolean, workflowId: string): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: workflowId },
    budget: {
      maxNodeStarts: 3,
      maxModelTokens: 10_000,
      maxCostUsd: 1,
      maxExecutionMs: 300_000,
      maxArtifactBytes: 1_048_576,
    },
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
        id: "review",
        type: "agent",
        dependsOn: requiresApproval ? ["gate"] : [],
        agent: {
          prompt: "Review TASK.md.",
          model: { provider: "test", id: "deterministic", thinking: "medium" },
          tools: ["read"],
          skills: ["review"],
          toolPackages: [],
          timeoutMs: 300_000,
        },
      },
      {
        id: "publish",
        type: "result",
        dependsOn: ["review"],
        result: {
          source: { nodeId: "review", field: "agent.text" },
          schema: { type: "string", maxLength: 1_024 },
        },
      },
    ],
  });
}

function skillCapabilitySnapshot(checklist: string) {
  return createCapabilitySnapshot([
    {
      kind: "agent-skill",
      name: "review",
      description: "Review the result against the task.",
      license: "MIT",
      compatibility: "Flow 1.x",
      metadata: { owner: "synapti" },
      requestedTools: ["Read"],
      trust: "project-explicit",
      provenance: ".flow/skills/review",
      files: [
        { path: "SKILL.md", content: Buffer.from(skillManifest) },
        { path: "references/checklist.md", content: Buffer.from(checklist) },
      ],
    },
  ]);
}

function requiredSkill(packages: readonly AgentSkillPackageSnapshot[]): AgentSkillPackageSnapshot {
  const skill = packages[0];
  if (skill === undefined) {
    throw new Error("Agent Skill activation fixture is missing its package");
  }
  return skill;
}

function activationEvaluationProof(): PromptActivationEvaluationProof {
  return {
    evaluationId: "evaluation-1",
    planDigest: "5".repeat(64),
    terminalRecordDigest: "6".repeat(64),
    reportDigest: "7".repeat(64),
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
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
