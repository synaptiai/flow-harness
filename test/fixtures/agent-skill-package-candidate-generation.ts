import { createHash } from "node:crypto";

import {
  type AgentSkillPackageCandidateGenerationInput,
  parseAgentSkillPackageBlueprintText,
  prepareAgentSkillPackageCandidateGeneration,
} from "../../src/domain/adaptation/agent-skill-package-candidate-generation.js";
import { promptCandidateGenerationFixture } from "./prompt-candidate-generation.js";

export const agentSkillPackageGenerationResponse = JSON.stringify({
  files: [
    {
      path: "SKILL.md",
      content: "# Review helper\n\nRead the checklist and report evidence-backed findings.\n",
    },
    {
      path: "references/checklist.md",
      content: "# Checklist\n\n- Check correctness.\n- Check privacy.\n",
    },
  ],
});

export function agentSkillPackageCandidateGenerationFixture() {
  const promptFixture = promptCandidateGenerationFixture();
  const blueprintText = JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "AgentSkillPackageBlueprint",
    scope: { workflowId: "adaptive-workflow", nodeId: "implement" },
    skill: {
      name: "review-helper",
      description: "Review an implementation against the task.",
      license: "MIT",
      compatibility: "Flow 1.x",
      metadata: { owner: "synapti", tier: "review" },
      requestedTools: ["Read"],
      trust: "project-explicit",
    },
    files: [
      {
        path: "SKILL.md",
        purpose: "Define the review procedure.",
        guidance: "Write concise instructions grounded in the tuning evidence.",
      },
      {
        path: "references/checklist.md",
        purpose: "Provide the detailed checklist.",
        guidance: "Cover the recurring evidence-backed failure modes.",
      },
    ],
  });
  const blueprint = parseAgentSkillPackageBlueprintText(blueprintText, "package blueprint");
  const input: AgentSkillPackageCandidateGenerationInput = {
    candidate: { id: "generated-review-helper", version: "1.0.0" },
    baseline: promptFixture.input.baseline,
    targetNodeId: "implement",
    blueprint: {
      provenance: "review-helper.blueprint.json",
      sourceSha256: sha256(blueprintText),
      document: blueprint,
    },
    evidence: promptFixture.input.evidence,
    model: { provider: "test", id: "deterministic", thinking: "medium" },
    limits: { timeoutMs: 300_000, maxOutputTokens: 8_192 },
  };
  return {
    blueprintText,
    input,
    prepared: prepareAgentSkillPackageCandidateGeneration(input),
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
