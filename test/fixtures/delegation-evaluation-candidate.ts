import { createHash } from "node:crypto";

import {
  parseDelegationEvaluationCandidateText,
  projectDelegationEvaluationCandidate,
} from "../../src/domain/adaptation/delegation-evaluation-candidate.js";
import {
  calculateDelegationExecutorIdentityDigest,
  type DelegationExecutorIdentity,
} from "../../src/domain/adaptation/delegation-evaluation.js";
import { calculateCapabilitySnapshotDigest } from "../../src/domain/capability/agent-skills.js";
import {
  compileWorkflowText,
  parseWorkflowSourceText,
} from "../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../src/domain/workflow/digest.js";

export function delegationEvaluationCandidateFixture() {
  const baselineText = JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "delegation-harness" },
    budget: completeBudget(6, 30_000, 3, 900_000, 3_145_728),
    concurrency: { maxNodes: 1 },
    nodes: [agentNode("manager", "Complete the task."), resultNode("publish", "manager")],
  });
  const childText = JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "review-specialist" },
    budget: completeBudget(2, 10_000, 1, 300_000, 1_048_576),
    nodes: [agentNode("review", "Review independently."), resultNode("publish-review", "review")],
  });
  const baselineCompiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  const childCompiled = compileWorkflowText(childText, "review.workflow.yaml");
  const result = childCompiled.nodes.find((node) => node.id === "publish-review");
  if (result?.type !== "result" || childCompiled.budget === undefined) {
    throw new Error("delegation fixture child is incomplete");
  }
  const executor = delegationExecutorIdentityFixture();
  const document = {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "DelegationEvaluationCandidate",
    metadata: { id: "review-delegation", version: "1.0.0" },
    scope: {
      kind: "workflow-agent-delegation",
      workflowId: "delegation-harness",
      managerNodeId: "manager",
    },
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineText),
        workflowDigest: calculateWorkflowDigest(baselineCompiled),
      },
      packageClosureDigest: calculateCapabilitySnapshotDigest([]),
    },
    delegation: {
      objective: "Review the task independently and return a typed verdict.",
      child: {
        path: "review.workflow.yaml",
        sourceSha256: sha256(childText),
        workflowDigest: calculateWorkflowDigest(childCompiled),
        resultNodeId: result.id,
        resultSchemaDigest: result.result.schemaDigest,
        budget: childCompiled.budget,
      },
      executor,
      maxDepth: 1,
      maxCalls: 1,
    },
  };
  const sourceText = JSON.stringify(document);
  const source = parseDelegationEvaluationCandidateText(sourceText, "delegation.candidate.yaml");
  const projected = projectDelegationEvaluationCandidate({
    manifestProvenance: "delegation.candidate.yaml",
    sourceSha256: sha256(sourceText),
    source,
    baseline: {
      provenance: "baseline.workflow.yaml",
      sourceText: baselineText,
      sourceSha256: sha256(baselineText),
      source: parseWorkflowSourceText(baselineText, "baseline.workflow.yaml"),
      compiled: baselineCompiled,
      packages: [],
    },
    child: {
      provenance: "review.workflow.yaml",
      sourceText: childText,
      sourceSha256: sha256(childText),
      source: parseWorkflowSourceText(childText, "review.workflow.yaml"),
      compiled: childCompiled,
    },
    executor,
  });
  return Object.freeze({ sourceText, source, baselineText, childText, executor, projected });
}

export function delegationExecutorIdentityFixture(): DelegationExecutorIdentity {
  const content = {
    version: 1 as const,
    kind: "embedded-pi-v1" as const,
    adapterContractVersion: "1.0.0",
    node: { version: "27.0.0", executableSha256: "a".repeat(64) },
    harness: {
      package: "@earendil-works/pi-coding-agent" as const,
      version: "0.84.0",
      integrity: "sha512-test-coding-agent",
      packageContentSha256: "b".repeat(64),
    },
    inference: {
      package: "@earendil-works/pi-ai" as const,
      version: "0.84.0",
      integrity: "sha512-test-pi-ai",
      packageContentSha256: "c".repeat(64),
    },
    dependencyClosureSha256: "d".repeat(64),
  };
  return Object.freeze({
    ...content,
    identityDigest: calculateDelegationExecutorIdentityDigest(content),
  });
}

function completeBudget(
  maxNodeStarts: number,
  maxModelTokens: number,
  maxCostUsd: number,
  maxExecutionMs: number,
  maxArtifactBytes: number,
) {
  return { maxNodeStarts, maxModelTokens, maxCostUsd, maxExecutionMs, maxArtifactBytes };
}

function agentNode(id: string, prompt: string) {
  return {
    id,
    type: "agent",
    dependsOn: [],
    agent: {
      prompt,
      model: { provider: "test", id: "deterministic", thinking: "off" },
      tools: ["read"],
      skills: [],
      toolPackages: [],
      timeoutMs: 300_000,
    },
  };
}

function resultNode(id: string, sourceNodeId: string) {
  return {
    id,
    type: "result",
    dependsOn: [sourceNodeId],
    result: {
      source: { nodeId: sourceNodeId, field: "agent.text" },
      schema: { type: "string", maxLength: 2_048 },
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
