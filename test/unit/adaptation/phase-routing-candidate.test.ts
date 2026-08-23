import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAX_PHASE_ROUTING_CANDIDATE_BYTES,
  type PhaseRoutingCandidateError,
  parsePhaseRoutingCandidateIdentity,
  parsePhaseRoutingCandidateText,
  projectPhaseRoutingCandidate,
} from "../../../src/domain/adaptation/phase-routing-candidate.js";
import type { ModelRoute } from "../../../src/domain/adaptation/model-routing-candidate.js";
import {
  compileWorkflowText,
  parseWorkflowSourceText,
} from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";

const baselineRoute: ModelRoute = Object.freeze({
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  thinking: "medium" as const,
});

const childWorkflowText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "review-child" },
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
      dependsOn: [],
      agent: {
        prompt: "Review the implementation.",
        model: baselineRoute,
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
        schema: { type: "string", maxLength: 1_024 },
      },
    },
  ],
});

const baselineText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "phase-workflow" },
  budget: {
    maxNodeStarts: 6,
    maxModelTokens: 40_000,
    maxCostUsd: 4,
    maxExecutionMs: 900_000,
    maxArtifactBytes: 4_194_304,
  },
  nodes: [
    agentNode("plan", "Plan the task.", []),
    agentNode("implement", "Implement the plan.", ["plan"]),
    {
      id: "delegate-review",
      type: "child",
      dependsOn: ["implement"],
      child: { resultNodeId: "publish-review", workflow: childWorkflowText },
    },
    agentNode("escalate", "Resolve an explicit escalation.", ["delegate-review"]),
    {
      id: "publish",
      type: "result",
      dependsOn: ["escalate"],
      result: {
        source: { nodeId: "escalate", field: "agent.text" },
        schema: { type: "string", maxLength: 1_024 },
      },
    },
  ],
});

describe("phase-routing candidates", () => {
  it("projects exact root and nested phase routes while retaining both immutable profiles", () => {
    const input = projectionInput();
    const projected = projectPhaseRoutingCandidate(input);

    expect(parsePhaseRoutingCandidateIdentity(structuredClone(projected.identity))).toEqual(
      projected.identity,
    );
    expect(projected.identity).toMatchObject({
      version: 1,
      kind: "phase-routing-candidate",
      id: "phase-specialization",
      candidateVersion: "1.0.0",
      scope: { kind: "workflow-phase-routing", workflowId: "phase-workflow" },
      baseline: {
        workflow: {
          provenance: "baseline.workflow.yaml",
          sourceSha256: sha256(baselineText),
          workflowDigest: calculateWorkflowDigest(input.baseline.compiled),
        },
      },
      profiles: {
        before: {
          selectionRule: "exact-target-v1",
          fallback: "deny",
          profileDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        after: {
          selectionRule: "exact-target-v1",
          fallback: "deny",
          profileDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      projected: {
        baselineWorkflow: {
          sourceSha256: sha256(baselineText),
          workflowDigest: calculateWorkflowDigest(input.baseline.compiled),
        },
        candidateWorkflow: {
          sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(projected.workflows.baseline.source).toBe(baselineText);
    expect(modelAt(projected.workflows.candidate.compiled, [], "plan")).toEqual({
      provider: "openai",
      id: "gpt-5.4",
      thinking: "high",
    });
    expect(modelAt(projected.workflows.candidate.compiled, [], "implement")).toEqual(baselineRoute);
    expect(modelAt(projected.workflows.candidate.compiled, ["delegate-review"], "review")).toEqual({
      provider: "openai",
      id: "gpt-5.4-mini",
      thinking: "low",
    });
    expect(modelAt(projected.workflows.candidate.compiled, [], "escalate")).toEqual({
      provider: "openai",
      id: "gpt-5.4",
      thinking: "xhigh",
    });
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it("rejects incomplete, duplicate, stale, or role-changing target profiles", () => {
    for (const mutate of [
      (candidate: CandidateSource) => {
        candidate.profiles.after.assignments.pop();
      },
      (candidate: CandidateSource) => {
        required(candidate.profiles.after.assignments[1], "after assignment 1").target =
          structuredClone(
            required(candidate.profiles.after.assignments[0], "after assignment 0").target,
          );
      },
      (candidate: CandidateSource) => {
        required(candidate.profiles.after.assignments[0], "after assignment 0").phase = "executor";
      },
      (candidate: CandidateSource) => {
        required(candidate.profiles.before.assignments[0], "before assignment 0").route.id =
          "stale-model";
      },
    ]) {
      const input = projectionInput();
      mutate(input.source as CandidateSource);
      refreshSourceDigest(input);
      expect(() => projectPhaseRoutingCandidate(input)).toThrowError(
        expect.objectContaining<Partial<PhaseRoutingCandidateError>>({
          code: expect.stringMatching(/invalid_schema|identity_mismatch|invalid_projection/),
        }),
      );
    }
  });

  it("uses closed phases, exact-target selection, denied fallback, and bounded source bytes", () => {
    for (const mutate of [
      (candidate: CandidateSource) => {
        required(candidate.profiles.after.assignments[0], "after assignment 0").phase =
          "researcher";
      },
      (candidate: CandidateSource) => {
        candidate.profiles.after.selectionRule = "model-selected";
      },
      (candidate: CandidateSource) => {
        candidate.profiles.after.fallback = "next-model";
      },
      (candidate: CandidateSource) => {
        required(candidate.profiles.after.assignments[0], "after assignment 0").target.childPath = [
          "..",
        ];
      },
    ]) {
      const candidate = JSON.parse(candidateText()) as CandidateSource;
      mutate(candidate);
      expect(() => parsePhaseRoutingCandidateText(JSON.stringify(candidate))).toThrowError(
        expect.objectContaining<Partial<PhaseRoutingCandidateError>>({ code: "invalid_schema" }),
      );
    }

    const source = candidateText();
    const exact =
      source + " ".repeat(MAX_PHASE_ROUTING_CANDIDATE_BYTES - Buffer.byteLength(source));
    expect(Buffer.byteLength(exact)).toBe(MAX_PHASE_ROUTING_CANDIDATE_BYTES);
    expect(parsePhaseRoutingCandidateText(exact).kind).toBe("PhaseRoutingCandidate");
    expect(() => parsePhaseRoutingCandidateText(`${exact} `)).toThrowError(
      expect.objectContaining<Partial<PhaseRoutingCandidateError>>({ code: "limit_exceeded" }),
    );
  });
});

function agentNode(id: string, prompt: string, dependsOn: readonly string[]) {
  return {
    id,
    type: "agent",
    dependsOn,
    agent: {
      prompt,
      model: baselineRoute,
      tools: ["read"],
      skills: [],
      toolPackages: [],
      timeoutMs: 300_000,
    },
  };
}

function candidateText(): string {
  const compiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  const before = assignments().map((assignment) => ({
    ...assignment,
    target: structuredClone(assignment.target),
    route: structuredClone(baselineRoute),
  }));
  const after = structuredClone(before);
  required(after[0], "after assignment 0").route = {
    provider: "openai",
    id: "gpt-5.4",
    thinking: "high",
  };
  required(after[2], "after assignment 2").route = {
    provider: "openai",
    id: "gpt-5.4-mini",
    thinking: "low",
  };
  required(after[3], "after assignment 3").route = {
    provider: "openai",
    id: "gpt-5.4",
    thinking: "xhigh",
  };
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "PhaseRoutingCandidate",
    metadata: { id: "phase-specialization", version: "1.0.0" },
    scope: { kind: "workflow-phase-routing", workflowId: "phase-workflow" },
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineText),
        workflowDigest: calculateWorkflowDigest(compiled),
      },
    },
    profiles: {
      before: { selectionRule: "exact-target-v1", fallback: "deny", assignments: before },
      after: { selectionRule: "exact-target-v1", fallback: "deny", assignments: after },
    },
  });
}

function assignments() {
  const target = (childPath: readonly string[], nodeId: string) => ({
    workflowId: "phase-workflow",
    childPath,
    nodeId,
  });
  return [
    { phase: "planner", target: target([], "plan") },
    { phase: "executor", target: target([], "implement") },
    { phase: "verifier", target: target(["delegate-review"], "review") },
    { phase: "escalation", target: target([], "escalate") },
  ];
}

function projectionInput() {
  const sourceText = candidateText();
  return {
    manifestProvenance: "phase-routing.candidate.yaml",
    sourceSha256: sha256(sourceText),
    source: structuredClone(parsePhaseRoutingCandidateText(sourceText)),
    baseline: {
      provenance: "baseline.workflow.yaml",
      sourceText: baselineText,
      sourceSha256: sha256(baselineText),
      source: parseWorkflowSourceText(baselineText, "baseline.workflow.yaml"),
      compiled: compileWorkflowText(baselineText, "baseline.workflow.yaml"),
    },
  };
}

function refreshSourceDigest(input: ReturnType<typeof projectionInput>): void {
  const text = JSON.stringify(input.source);
  input.sourceSha256 = sha256(text);
}

function modelAt(
  workflow: ReturnType<typeof compileWorkflowText>,
  childPath: readonly string[],
  nodeId: string,
) {
  let current = workflow;
  for (const childId of childPath) {
    const child = current.nodes.find((node) => node.id === childId);
    if (child?.type !== "child") throw new Error("test target child is missing");
    current = child.child.workflow;
  }
  const node = current.nodes.find((item) => item.id === nodeId);
  if (node?.type !== "agent") throw new Error("test target agent is missing");
  return node.agent.model;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`test fixture is missing ${label}`);
  return value;
}

interface MutableAssignment {
  phase: string;
  target: { workflowId: string; childPath: string[]; nodeId: string };
  route: { provider: string; id: string; thinking: string };
}

interface CandidateSource {
  profiles: {
    before: {
      selectionRule: string;
      fallback: string;
      assignments: MutableAssignment[];
    };
    after: {
      selectionRule: string;
      fallback: string;
      assignments: MutableAssignment[];
    };
  };
}
