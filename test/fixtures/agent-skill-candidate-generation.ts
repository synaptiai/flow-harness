import { createHash } from "node:crypto";

import type { AgentSkillCandidateGenerationInput } from "../../src/domain/adaptation/agent-skill-candidate-generation.js";
import {
  type AgentSkillPackageSnapshot,
  createCapabilitySnapshot,
} from "../../src/domain/capability/agent-skills.js";
import { compileWorkflowText } from "../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../src/domain/workflow/digest.js";
import { promptCandidateTuningEvidence } from "./prompt-candidate-generation.js";

export const agentSkillGenerationWorkflowText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "adaptive-skill-workflow" },
  budget: {
    maxNodeStarts: 2,
    maxModelTokens: 10_000,
    maxCostUsd: 1,
    maxExecutionMs: 300_000,
    maxArtifactBytes: 1_048_576,
  },
  nodes: [
    {
      id: "review",
      type: "agent",
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

export const selectedResourceText = "# Review checklist\n\nCheck correctness.\n";
export const unrelatedResourceCanary = "PRIVATE_UNRELATED_RESOURCE_CONTENT";
export const executableScriptCanary = "PRIVATE_EXECUTABLE_SCRIPT_CONTENT";

export function agentSkillCandidateGenerationFixture(): {
  readonly input: AgentSkillCandidateGenerationInput;
  readonly skill: AgentSkillPackageSnapshot;
} {
  const compiled = compileWorkflowText(agentSkillGenerationWorkflowText, "baseline.workflow.yaml");
  const workflowDigest = calculateWorkflowDigest(compiled);
  const evidence = promptCandidateTuningEvidence(workflowDigest);
  const snapshot = createCapabilitySnapshot([
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
        {
          path: "SKILL.md",
          content: Buffer.from(
            `---\nname: review\ndescription: Review the result against the task.\nlicense: MIT\ncompatibility: Flow 1.x\nmetadata:\n  owner: synapti\nallowed-tools: Read\n---\n# Review\n\nUse references/checklist.md.\n`,
          ),
        },
        { path: "references/checklist.md", content: Buffer.from(selectedResourceText) },
        { path: "references/private.md", content: Buffer.from(unrelatedResourceCanary) },
        { path: "scripts/check.sh", content: Buffer.from(executableScriptCanary) },
        { path: "assets/binary.dat", content: Buffer.from([0xff, 0x00, 0xfe]) },
      ],
    },
  ]);
  const skill = snapshot.packages[0];
  if (skill?.kind !== "agent-skill") {
    throw new Error("Agent Skill generation fixture has no package");
  }
  return {
    skill,
    input: {
      candidate: { id: "generated-review", version: "1.0.0" },
      baseline: {
        provenance: "baseline.workflow.yaml",
        sourceSha256: sha256(agentSkillGenerationWorkflowText),
        workflowDigest,
        compiled,
      },
      skill,
      evidence: [
        {
          provenance: "tuning.json",
          sourceSha256: sha256(JSON.stringify(evidence)),
          packet: evidence,
        },
      ],
      allowedResourcePaths: ["references/checklist.md"],
      model: { provider: "test", id: "deterministic", thinking: "medium" },
      limits: { timeoutMs: 300_000, maxOutputTokens: 8_192 },
    },
  };
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
