import { createHash } from "node:crypto";

import { createEffectiveHarnessState } from "../../src/domain/adaptation/effective-harness-state.js";
import { prepareSupplementalMemoryCandidateGeneration } from "../../src/domain/adaptation/supplemental-memory-candidate-generation.js";
import { promptCandidateTuningEvidence } from "./prompt-candidate-generation.js";

export function supplementalMemoryCandidateGenerationFixture() {
  const baseline = createEffectiveHarnessState({
    scopeDigest: "a".repeat(64),
    workflowSource: JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "Workflow",
      metadata: { id: "memory-workflow" },
      nodes: [
        {
          id: "implement",
          type: "agent",
          agent: {
            prompt: "Implement the requested change.",
            model: { provider: "test", id: "deterministic", thinking: "medium" },
            tools: [],
            skills: [],
            toolPackages: [],
            timeoutMs: 10_000,
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
    }),
    packages: [],
  });
  const evidence = promptCandidateTuningEvidence(baseline.workflow.workflowDigest);
  const input = {
    candidate: { id: "generated-memory", version: "1.0.0" },
    baseline,
    target: {
      workflowId: baseline.workflowId,
      childPath: [] as string[],
      agentNodeId: "implement",
      entryId: "reviewed-fixture",
      operation: "add" as const,
    },
    evidence: [
      {
        provenance: "tuning-evidence.json",
        sourceSha256: sha256(JSON.stringify(evidence)),
        packet: evidence,
      },
    ],
    model: { provider: "test", id: "deterministic", thinking: "medium" as const },
    limits: { timeoutMs: 300_000, maxOutputTokens: 8_192 },
  };
  return {
    baseline,
    evidence,
    input,
    prepared: prepareSupplementalMemoryCandidateGeneration(input),
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
