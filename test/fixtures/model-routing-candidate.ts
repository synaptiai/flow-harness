import { createHash } from "node:crypto";

import {
  calculateModelRoutingCandidateDigest,
  type ModelRoutingCandidateIdentity,
  type ProjectedModelRoutingCandidate,
} from "../../src/domain/adaptation/model-routing-candidate.js";
import {
  compileWorkflowText,
  parseWorkflowSourceText,
} from "../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../src/domain/workflow/digest.js";

export function modelRoutingCandidateFixture(
  baselineText: string,
  nodeId = "implement",
): ProjectedModelRoutingCandidate {
  const baselineSource = parseWorkflowSourceText(baselineText, "baseline.workflow.yaml");
  const baselineCompiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  const node = baselineSource.nodes.find((item) => item.id === nodeId);
  if (node?.type !== "agent") throw new Error("routing fixture has no target agent");
  const projectedSource = structuredClone(baselineSource);
  const projectedNode = projectedSource.nodes.find((item) => item.id === nodeId);
  if (projectedNode?.type !== "agent") throw new Error("routing fixture target is unavailable");
  projectedNode.agent.model = { provider: "openai", id: "gpt-5.4", thinking: "high" };
  const source = JSON.stringify(projectedSource);
  const compiled = compileWorkflowText(source, "route.candidate.yaml");
  const withoutDigest: Omit<ModelRoutingCandidateIdentity, "candidateDigest"> = {
    version: 1,
    kind: "model-routing-candidate",
    id: "deterministic-to-gpt",
    candidateVersion: "1.0.0",
    scope: {
      kind: "workflow-model-route",
      workflowId: baselineCompiled.id,
      nodeId,
    },
    manifest: { provenance: "route.candidate.yaml", sourceSha256: "1".repeat(64) },
    baseline: {
      workflow: {
        provenance: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineText),
        workflowDigest: calculateWorkflowDigest(baselineCompiled),
      },
    },
    route: {
      before: node.agent.model,
      after: projectedNode.agent.model,
    },
    projectedWorkflow: {
      sourceSha256: sha256(source),
      workflowDigest: calculateWorkflowDigest(compiled),
    },
  };
  return Object.freeze({
    identity: Object.freeze({
      ...withoutDigest,
      candidateDigest: calculateModelRoutingCandidateDigest(withoutDigest),
    }),
    workflow: Object.freeze({
      source,
      sourceSha256: sha256(source),
      compiled,
      workflowDigest: calculateWorkflowDigest(compiled),
    }),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
