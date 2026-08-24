import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  calculateDelegationExecutorIdentityDigest,
  type DelegationEvaluationCandidateError,
  type DelegationExecutorIdentity,
  MAX_DELEGATION_EVALUATION_CANDIDATE_BYTES,
  MAX_DELEGATION_OBJECTIVE_BYTES,
  parseDelegationEvaluationCandidateIdentity,
  parseDelegationEvaluationCandidateText,
  projectDelegationEvaluationCandidate,
} from "../../../src/domain/adaptation/delegation-evaluation-candidate.js";
import {
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  compileWorkflowText,
  parseWorkflowSourceText,
} from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";

const childBudget = Object.freeze({
  maxNodeStarts: 2,
  maxModelTokens: 10_000,
  maxCostUsdMicros: 1_000_000,
  maxExecutionMs: 300_000,
  maxArtifactBytes: 1_048_576,
});

const childWorkflowText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "review-specialist" },
  budget: {
    maxNodeStarts: childBudget.maxNodeStarts,
    maxModelTokens: childBudget.maxModelTokens,
    maxCostUsd: 1,
    maxExecutionMs: childBudget.maxExecutionMs,
    maxArtifactBytes: childBudget.maxArtifactBytes,
  },
  nodes: [
    {
      id: "review",
      type: "agent",
      dependsOn: [],
      agent: {
        prompt: "Review the supplied implementation against its constraints.",
        model: { provider: "test", id: "deterministic", thinking: "off" },
        tools: ["read"],
        skills: [],
        toolPackages: [],
        timeoutMs: 300_000,
      },
    },
    {
      id: "publish-review",
      type: "result",
      dependsOn: ["review"],
      result: {
        source: { nodeId: "review", field: "agent.text" },
        schema: {
          type: "object",
          required: ["verdict", "reason"],
          properties: {
            verdict: { type: "string", maxLength: 16 },
            reason: { type: "string", maxLength: 2_048 },
          },
        },
      },
    },
  ],
});

const baselineText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "delegation-harness" },
  budget: {
    maxNodeStarts: 6,
    maxModelTokens: 30_000,
    maxCostUsd: 3,
    maxExecutionMs: 900_000,
    maxArtifactBytes: 3_145_728,
  },
  concurrency: { maxNodes: 1 },
  nodes: [
    {
      id: "manager",
      type: "agent",
      dependsOn: [],
      agent: {
        prompt: "Complete the task. Delegate only when the sealed specialist is useful.",
        model: { provider: "test", id: "deterministic", thinking: "off" },
        tools: ["read", "edit"],
        skills: [],
        toolPackages: [],
        timeoutMs: 600_000,
      },
    },
    {
      id: "publish",
      type: "result",
      dependsOn: ["manager"],
      result: {
        source: { nodeId: "manager", field: "agent.text" },
        schema: { type: "string", maxLength: 65_536 },
      },
    },
  ],
});

describe("delegation evaluation candidates", () => {
  it("binds one exact manager, objective, child, result, budget, executor, and capability snapshot", () => {
    const input = projectionInput();
    const projected = projectDelegationEvaluationCandidate(input);

    expect(parseDelegationEvaluationCandidateIdentity(structuredClone(projected.identity))).toEqual(
      projected.identity,
    );
    expect(projected.identity).toMatchObject({
      version: 1,
      kind: "delegation-evaluation-candidate",
      id: "review-delegation",
      candidateVersion: "1.0.0",
      scope: {
        kind: "workflow-agent-delegation",
        workflowId: "delegation-harness",
        managerNodeId: "manager",
      },
      baseline: {
        workflow: {
          provenance: "baseline.workflow.yaml",
          sourceSha256: sha256(baselineText),
          workflowDigest: calculateWorkflowDigest(input.baseline.compiled),
        },
        packageClosureDigest: calculateCapabilitySnapshotDigest([]),
      },
      delegation: {
        objective: {
          bytes: Buffer.byteLength(candidateDocument().delegation.objective),
          sha256: sha256(candidateDocument().delegation.objective),
        },
        child: {
          provenance: "review.workflow.yaml",
          sourceSha256: sha256(childWorkflowText),
          workflowDigest: calculateWorkflowDigest(input.child.compiled),
          resultNodeId: "publish-review",
          resultSchemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          budget: childBudget,
        },
        executor: { identityDigest: executorIdentity().identityDigest },
        maxDepth: 1,
        maxCalls: 1,
      },
      snapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(projected.snapshot).toMatchObject({
      version: 1,
      kind: "delegation-evaluation-v1",
      candidateDigest: projected.identity.candidateDigest,
      target: { workflowId: "delegation-harness", managerNodeId: "manager" },
      objective: { text: candidateDocument().delegation.objective },
      child: {
        sourceText: childWorkflowText,
        workflowDigest: calculateWorkflowDigest(input.child.compiled),
        resultNodeId: "publish-review",
        budget: childBudget,
      },
      executor: executorIdentity(),
      maxDepth: 1,
      maxCalls: 1,
      snapshotDigest: projected.identity.snapshotDigest,
    });
    const capabilitySnapshot = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      delegation: projected.snapshot,
      digest: calculateCapabilitySnapshotDigest(
        [],
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        projected.snapshot,
      ),
    });
    expect(capabilitySnapshot.delegation?.snapshotDigest).toBe(projected.identity.snapshotDigest);
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it("rejects a missing manager, changed child budget, nested child, or executor drift", () => {
    const invalidInputs = [
      (input: ReturnType<typeof projectionInput>) => {
        input.source.scope.managerNodeId = "missing-manager";
      },
      (input: ReturnType<typeof projectionInput>) => {
        input.source.delegation.child.budget.maxModelTokens += 1;
      },
      (input: ReturnType<typeof projectionInput>) => {
        input.child.compiled = compileWorkflowText(
          nestedChildWorkflowText(),
          "review.workflow.yaml",
        );
        input.child.sourceText = nestedChildWorkflowText();
        input.child.sourceSha256 = sha256(input.child.sourceText);
        input.child.source = parseWorkflowSourceText(
          input.child.sourceText,
          "review.workflow.yaml",
        );
        input.source.delegation.child.sourceSha256 = input.child.sourceSha256;
        input.source.delegation.child.workflowDigest = calculateWorkflowDigest(
          input.child.compiled,
        );
      },
      (input: ReturnType<typeof projectionInput>) => {
        input.executor = executorIdentity("f".repeat(64));
      },
    ];

    for (const mutate of invalidInputs) {
      const input = projectionInput();
      mutate(input);
      refreshSourceIdentity(input);
      expect(() => projectDelegationEvaluationCandidate(input)).toThrowError(
        expect.objectContaining<Partial<DelegationEvaluationCandidateError>>({
          code: expect.stringMatching(/identity_mismatch|invalid_target|invalid_child/),
        }),
      );
    }
  });

  it("fixes depth and call ceilings and bounds the private objective and candidate source", () => {
    for (const mutate of [
      (candidate: CandidateDocument) => {
        candidate.delegation.maxDepth = 2;
      },
      (candidate: CandidateDocument) => {
        candidate.delegation.maxCalls = 2;
      },
      (candidate: CandidateDocument) => {
        candidate.delegation.objective = "x".repeat(MAX_DELEGATION_OBJECTIVE_BYTES + 1);
      },
    ]) {
      const candidate = candidateDocument();
      mutate(candidate);
      expect(() => parseDelegationEvaluationCandidateText(JSON.stringify(candidate))).toThrowError(
        expect.objectContaining<Partial<DelegationEvaluationCandidateError>>({
          code: expect.stringMatching(/invalid_schema|limit_exceeded/),
        }),
      );
    }

    const source = JSON.stringify(candidateDocument());
    const exact = `${source}${" ".repeat(
      MAX_DELEGATION_EVALUATION_CANDIDATE_BYTES - Buffer.byteLength(source),
    )}`;
    expect(parseDelegationEvaluationCandidateText(exact).kind).toBe(
      "DelegationEvaluationCandidate",
    );
    expect(() => parseDelegationEvaluationCandidateText(`${exact} `)).toThrowError(
      expect.objectContaining<Partial<DelegationEvaluationCandidateError>>({
        code: "limit_exceeded",
      }),
    );
  });

  it("rejects a modified durable identity digest", () => {
    const projected = projectDelegationEvaluationCandidate(projectionInput());
    const modified = structuredClone(projected.identity);
    modified.delegation.child.resultNodeId = "other-result";

    expect(() => parseDelegationEvaluationCandidateIdentity(modified)).toThrowError(
      expect.objectContaining<Partial<DelegationEvaluationCandidateError>>({
        code: "identity_mismatch",
      }),
    );
  });
});

function projectionInput() {
  const sourceText = JSON.stringify(candidateDocument());
  const childCompiled = compileWorkflowText(childWorkflowText, "review.workflow.yaml");
  return {
    manifestProvenance: "delegation.candidate.yaml",
    sourceSha256: sha256(sourceText),
    source: structuredClone(parseDelegationEvaluationCandidateText(sourceText)),
    baseline: {
      provenance: "baseline.workflow.yaml",
      sourceText: baselineText,
      sourceSha256: sha256(baselineText),
      source: parseWorkflowSourceText(baselineText, "baseline.workflow.yaml"),
      compiled: compileWorkflowText(baselineText, "baseline.workflow.yaml"),
      packages: [],
    },
    child: {
      provenance: "review.workflow.yaml",
      sourceText: childWorkflowText,
      sourceSha256: sha256(childWorkflowText),
      source: parseWorkflowSourceText(childWorkflowText, "review.workflow.yaml"),
      compiled: childCompiled,
    },
    executor: executorIdentity(),
  };
}

function candidateDocument(): CandidateDocument {
  const baseline = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  const child = compileWorkflowText(childWorkflowText, "review.workflow.yaml");
  const result = child.nodes.find((node) => node.id === "publish-review");
  if (result?.type !== "result") throw new Error("test child result is missing");
  return {
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
        workflowDigest: calculateWorkflowDigest(baseline),
      },
      packageClosureDigest: calculateCapabilitySnapshotDigest([]),
    },
    delegation: {
      objective: "Review the task independently and return a typed accept or reject verdict.",
      child: {
        path: "review.workflow.yaml",
        sourceSha256: sha256(childWorkflowText),
        workflowDigest: calculateWorkflowDigest(child),
        resultNodeId: "publish-review",
        resultSchemaDigest: result.result.schemaDigest,
        budget: { ...childBudget },
      },
      executor: executorIdentity(),
      maxDepth: 1,
      maxCalls: 1,
    },
  };
}

function executorIdentity(executableSha256 = "a".repeat(64)): DelegationExecutorIdentity {
  const content = {
    version: 1 as const,
    kind: "embedded-pi-v1" as const,
    adapterContractVersion: "1.0.0",
    node: { version: "27.0.0", executableSha256 },
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

function nestedChildWorkflowText(): string {
  const nested = JSON.parse(childWorkflowText) as {
    nodes: Array<Record<string, unknown>>;
  };
  nested.nodes.splice(1, 0, {
    id: "nested",
    type: "child",
    dependsOn: ["review"],
    child: { resultNodeId: "publish-review", workflow: childWorkflowText },
  });
  return JSON.stringify(nested);
}

function refreshSourceIdentity(input: ReturnType<typeof projectionInput>): void {
  const sourceText = JSON.stringify(input.source);
  input.sourceSha256 = sha256(sourceText);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface CandidateDocument {
  apiVersion: string;
  kind: string;
  metadata: { id: string; version: string };
  scope: { kind: string; workflowId: string; managerNodeId: string };
  baseline: {
    workflow: { path: string; sourceSha256: string; workflowDigest: string };
    packageClosureDigest: string;
  };
  delegation: {
    objective: string;
    child: {
      path: string;
      sourceSha256: string;
      workflowDigest: string;
      resultNodeId: string;
      resultSchemaDigest: string;
      budget: {
        maxNodeStarts: number;
        maxModelTokens: number;
        maxCostUsdMicros: number;
        maxExecutionMs: number;
        maxArtifactBytes: number;
      };
    };
    executor: DelegationExecutorIdentity;
    maxDepth: number;
    maxCalls: number;
  };
}
