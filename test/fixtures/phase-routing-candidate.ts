import { createHash } from "node:crypto";

import {
  parsePhaseRoutingCandidateText,
  projectPhaseRoutingCandidate,
} from "../../src/domain/adaptation/phase-routing-candidate.js";
import {
  compileWorkflowText,
  parseWorkflowSourceText,
} from "../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../src/domain/workflow/digest.js";
import type { ModelRoute } from "../../src/domain/adaptation/model-routing-candidate.js";

export function phaseRoutingCandidateFixture(
  baselineText: string,
  nodeId = "implement",
  afterRoute: ModelRoute = { provider: "openai", id: "gpt-5.4", thinking: "high" },
) {
  const baselineSource = parseWorkflowSourceText(baselineText, "baseline.workflow.yaml");
  const baselineCompiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  const node = baselineSource.nodes.find((item) => item.id === nodeId);
  if (node?.type !== "agent") throw new Error("phase-routing fixture target is not an agent");
  const target = { workflowId: baselineCompiled.id, childPath: [], nodeId };
  const before = {
    selectionRule: "exact-target-v1" as const,
    fallback: "deny" as const,
    assignments: [{ phase: "executor" as const, target, route: node.agent.model }],
  };
  const after = {
    selectionRule: "exact-target-v1" as const,
    fallback: "deny" as const,
    assignments: [
      {
        phase: "executor" as const,
        target,
        route: afterRoute,
      },
    ],
  };
  const sourceText = JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "PhaseRoutingCandidate",
    metadata: { id: "phase-specialization", version: "1.0.0" },
    scope: { kind: "workflow-phase-routing", workflowId: baselineCompiled.id },
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineText),
        workflowDigest: calculateWorkflowDigest(baselineCompiled),
      },
    },
    profiles: { before, after },
  });
  return projectPhaseRoutingCandidate({
    manifestProvenance: "phase-routing.candidate.yaml",
    sourceSha256: sha256(sourceText),
    source: parsePhaseRoutingCandidateText(sourceText),
    baseline: {
      provenance: "baseline.workflow.yaml",
      sourceText: baselineText,
      sourceSha256: sha256(baselineText),
      source: baselineSource,
      compiled: baselineCompiled,
    },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
