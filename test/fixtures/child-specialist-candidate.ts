import { createHash } from "node:crypto";

import {
  type ProjectedChildSpecialistCandidate,
  parseChildSpecialistCandidateText,
  projectChildSpecialistCandidate,
} from "../../src/domain/adaptation/child-specialist-candidate.js";
import {
  calculateCapabilitySnapshotDigest,
  createCapabilitySnapshot,
} from "../../src/domain/capability/agent-skills.js";
import {
  compileWorkflowText,
  parseWorkflowSourceText,
} from "../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../src/domain/workflow/digest.js";

export const childSpecialistBaselineInstructions =
  "Review the implementation against the declared task.";
export const childSpecialistCandidateInstructions =
  "Review the implementation and identify unsupported claims.";

export function childSpecialistCandidateFixture(
  change: "instructions" | "skills" = "instructions",
): {
  readonly baselineText: string;
  readonly childText: string;
  readonly sourceText: string;
  readonly packages: ReturnType<typeof createCapabilitySnapshot>["packages"];
  readonly projected: ProjectedChildSpecialistCandidate;
} {
  const packages = createCapabilitySnapshot(
    ["review-checklist", "security-checklist"].map((name) => ({
      kind: "agent-skill" as const,
      name,
      description: `Review a result with ${name}.`,
      metadata: {},
      requestedTools: [],
      trust: "project-explicit" as const,
      provenance: `.flow/skills/${name}`,
      files: [{ path: "SKILL.md", content: Buffer.from(`# ${name}\n`) }],
    })),
  ).packages;
  const childText = JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "review-specialist" },
    budget: {
      maxNodeStarts: 3,
      maxModelTokens: 10_000,
      maxCostUsd: 1,
      maxExecutionMs: 300_000,
      maxArtifactBytes: 1_048_576,
    },
    nodes: [
      {
        id: "review",
        type: "agent",
        dependsOn: [],
        agent: {
          prompt: childSpecialistBaselineInstructions,
          model: { provider: "test", id: "deterministic", thinking: "medium" },
          tools: ["read"],
          skills: ["review-checklist"],
          toolPackages: [],
          timeoutMs: 300_000,
        },
      },
      {
        id: "security-reference",
        type: "agent",
        dependsOn: ["review"],
        agent: {
          prompt: "Retain the admitted security review capability.",
          model: { provider: "test", id: "deterministic", thinking: "medium" },
          tools: ["read"],
          skills: ["security-checklist"],
          toolPackages: [],
          timeoutMs: 300_000,
        },
      },
      {
        id: "publish",
        type: "result",
        dependsOn: ["review", "security-reference"],
        result: {
          source: { nodeId: "review", field: "agent.text" },
          schema: { type: "string", maxLength: 1_024 },
        },
      },
    ],
  });
  const baselineText = JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "specialist-harness" },
    budget: {
      maxNodeStarts: 4,
      maxModelTokens: 20_000,
      maxCostUsd: 2,
      maxExecutionMs: 600_000,
      maxArtifactBytes: 2_097_152,
    },
    nodes: [
      {
        id: "delegate-review",
        type: "child",
        dependsOn: [],
        child: { resultNodeId: "publish", workflow: childText },
      },
    ],
  });
  const compiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  const compiledChild = compiled.nodes.find((node) => node.id === "delegate-review");
  if (compiledChild?.type !== "child") throw new Error("child specialist fixture is invalid");
  const sourceDocument = {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "ChildSpecialistCandidate",
    metadata: { id: `review-${change}`, version: "1.0.0" },
    scope: {
      kind: "workflow-child-specialist",
      workflowId: "specialist-harness",
      childNodeId: "delegate-review",
      agentNodeId: "review",
    },
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineText),
        workflowDigest: calculateWorkflowDigest(compiled),
      },
      child: {
        sourceSha256: sha256(childText),
        workflowDigest: compiledChild.child.workflowDigest,
      },
      packageClosureDigest: calculateCapabilitySnapshotDigest(packages),
    },
    change:
      change === "instructions"
        ? {
            kind: "instructions",
            beforeSha256: sha256(childSpecialistBaselineInstructions),
            value: childSpecialistCandidateInstructions,
          }
        : {
            kind: "skills",
            before: ["review-checklist"],
            after: ["review-checklist", "security-checklist"],
          },
  };
  const sourceText = JSON.stringify(sourceDocument);
  const projected = projectChildSpecialistCandidate({
    manifestProvenance: "specialist.candidate.yaml",
    sourceSha256: sha256(sourceText),
    source: parseChildSpecialistCandidateText(sourceText, "specialist.candidate.yaml"),
    baseline: {
      provenance: "baseline.workflow.yaml",
      sourceText: baselineText,
      sourceSha256: sha256(baselineText),
      source: parseWorkflowSourceText(baselineText, "baseline.workflow.yaml"),
      compiled,
      packages,
    },
  });
  return Object.freeze({ baselineText, childText, sourceText, packages, projected });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
