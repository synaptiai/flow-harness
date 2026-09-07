import { describe, expect, it } from "vitest";

import { admitIssueWorkflow } from "../../../src/application/issue-workflow-admission.js";
import { parseRunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { projectCompiledControlGraph } from "../../../src/domain/workflow/control-graph.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import {
  type CompiledWorkflow,
  MAX_CONTROL_GRAPH_SERIALIZED_BYTES,
  MAX_ISSUE_REVIEW_CONTROL_GRAPH_SERIALIZED_BYTES,
  MAX_ISSUE_REVIEW_MODEL_VERIFIER_INPUT_BYTES,
} from "../../../src/domain/workflow/types.js";

describe("trusted issue repair verifier input policy", () => {
  it("replays a production-admitted repair policy with its exact workflow identity", () => {
    const admitted = repair();
    const event = parseRunEvent(started(admitted.workflow));
    const state = reduceRunEvents([event]);
    expect(state.workflowDigest).toBe(admitted.executionWorkflowDigest);
    expect(state.controlGraph?.nodes).toContainEqual(
      expect.objectContaining({
        nodeId: "verify-0",
        verifier: expect.objectContaining({
          inputPolicy: { kind: "issue-workflow", role: "repair", maxBytes: 786_432 },
        }),
      }),
    );
  });

  it("retains a real admitted repair graph above the ordinary serialized graph limit", () => {
    const admitted = repair(4, 150_000);
    const graph = projectCompiledControlGraph(admitted.workflow);
    expect(Buffer.byteLength(JSON.stringify(graph))).toBeGreaterThan(
      MAX_CONTROL_GRAPH_SERIALIZED_BYTES,
    );
    expect(() => reduceRunEvents([parseRunEvent(started(admitted.workflow, graph))])).not.toThrow();
  });

  it("accepts the exact repair verifier prompt ceiling", () => {
    const admitted = repair();
    const graph = replaceVerifierPrompt(
      admitted.workflow,
      "x".repeat(MAX_ISSUE_REVIEW_MODEL_VERIFIER_INPUT_BYTES),
    );
    expect(() => parseRunEvent(started(admitted.workflow, graph))).not.toThrow();
  });

  it("rejects a repair verifier prompt above the ceiling", () => {
    const admitted = repair();
    const graph = replaceVerifierPrompt(
      admitted.workflow,
      "x".repeat(MAX_ISSUE_REVIEW_MODEL_VERIFIER_INPUT_BYTES + 1),
    );
    expect(() => parseRunEvent(started(admitted.workflow, graph))).toThrow();
  });

  it.each([262_144, 786_431, 786_433])(
    "rejects repair maxBytes %s instead of the exact trusted constant",
    (maxBytes) => {
      const admitted = repair();
      const graph = projectCompiledControlGraph(admitted.workflow);
      const changed = {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.type === "verifier" && node.verifier.kind === "model"
            ? {
                ...node,
                verifier: {
                  ...node.verifier,
                  inputPolicy: { kind: "issue-workflow", role: "repair", maxBytes },
                },
              }
            : node,
        ),
      };
      expect(() => parseRunEvent(started(admitted.workflow, changed))).toThrow();
    },
  );

  it("accepts the exact expanded repair graph byte limit", () => {
    const admitted = repair(4);
    const graph = graphWithBytes(
      admitted.workflow,
      MAX_ISSUE_REVIEW_CONTROL_GRAPH_SERIALIZED_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(graph))).toBe(
      MAX_ISSUE_REVIEW_CONTROL_GRAPH_SERIALIZED_BYTES,
    );
    expect(() => parseRunEvent(started(admitted.workflow, graph))).not.toThrow();
  });

  it("rejects one byte above the expanded repair graph limit", () => {
    const admitted = repair(4);
    const graph = graphWithBytes(
      admitted.workflow,
      MAX_ISSUE_REVIEW_CONTROL_GRAPH_SERIALIZED_BYTES + 1,
    );
    expect(() => parseRunEvent(started(admitted.workflow, graph))).toThrow(/1048576/);
  });

  it("measures the expanded repair graph ceiling in UTF-8 bytes, not characters", () => {
    const admitted = repair(4);
    const graph = graphWithBytes(
      admitted.workflow,
      MAX_ISSUE_REVIEW_CONTROL_GRAPH_SERIALIZED_BYTES,
    );
    const changed = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.nodeId === "verify-0" && node.type === "verifier" && node.verifier.kind === "model"
          ? { ...node, verifier: { ...node.verifier, prompt: `é${node.verifier.prompt.slice(1)}` } }
          : node,
      ),
    };
    expect(JSON.stringify(changed).length).toBe(MAX_ISSUE_REVIEW_CONTROL_GRAPH_SERIALIZED_BYTES);
    expect(Buffer.byteLength(JSON.stringify(changed))).toBe(
      MAX_ISSUE_REVIEW_CONTROL_GRAPH_SERIALIZED_BYTES + 1,
    );
    expect(() => parseRunEvent(started(admitted.workflow, changed))).toThrow(/1048576/);
  });

  it.each([
    { kind: "authored-workflow", role: "repair", maxBytes: 786_432 },
    { kind: "issue-workflow", role: "repair", maxBytes: 786_432, approved: true },
  ])("rejects a malformed trusted repair policy: %j", (inputPolicy) => {
    const admitted = repair();
    const graph = projectCompiledControlGraph(admitted.workflow);
    const changed = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.type === "verifier" && node.verifier.kind === "model"
          ? { ...node, verifier: { ...node.verifier, inputPolicy } }
          : node,
      ),
    };
    expect(() => parseRunEvent(started(admitted.workflow, changed))).toThrow();
  });

  it.each(["implementation", "review", "repair"])(
    "does not allow authored YAML to grant the trusted %s policy",
    (role) => {
      const authored = source().replace(
        "      prompt: Check the admitted evidence.",
        `      prompt: Check the admitted evidence.\n      inputPolicy: { kind: issue-workflow, role: ${role}, maxBytes: 786432 }`,
      );
      expect(() => compileWorkflowText(authored)).toThrow(/inputPolicy/);
    },
  );

  it("does not enlarge an ordinary verifier graph without the trusted policy", () => {
    const workflow = compileWorkflowText(source(40));
    const graph = replaceVerifierPrompt(workflow, "x".repeat(16_384));
    expect(Buffer.byteLength(JSON.stringify(graph))).toBeGreaterThan(
      MAX_CONTROL_GRAPH_SERIALIZED_BYTES,
    );
    expect(() => parseRunEvent(started(workflow, graph))).toThrow(/524288/);
  });

  it("keeps ordinary authored verifier configuration free of an injected input policy", () => {
    const first = compileWorkflowText(source());
    const second = compileWorkflowText(source());
    const verifier = first.nodes.find((node) => node.type === "verifier");
    expect(
      verifier?.type === "verifier" && verifier.verifier.kind === "model"
        ? verifier.verifier.inputPolicy
        : null,
    ).toBeUndefined();
    expect(calculateWorkflowDigest(first)).toBe(calculateWorkflowDigest(second));
    expect(() => reduceRunEvents([parseRunEvent(started(first))])).not.toThrow();
  });
});

function repair(verifiers = 1, contextBytes = 100) {
  return admitIssueWorkflow({
    role: "repair",
    source: source(verifiers),
    sourceName: "repair-policy.workflow.yaml",
    model: { provider: "openrouter", id: "bound-model" },
    context: { kind: "repair", content: JSON.stringify({ evidence: "x".repeat(contextBytes) }) },
    allowedWritePrefixes: [],
    resultNodeId: "repair-agent",
  });
}

function started(
  workflow: CompiledWorkflow,
  graph: unknown = projectCompiledControlGraph(workflow),
) {
  return {
    version: 1,
    sequence: 1,
    at: "2026-09-06T18:00:00.000Z",
    runId: "issue-repair-policy",
    workflowId: workflow.id,
    type: "run_started",
    nodeIds: workflow.nodes.map((node) => node.id),
    workflowApiVersion: workflow.apiVersion,
    workflowDigest: calculateWorkflowDigest(workflow),
    controlGraph: graph,
    budget: workflow.budget,
    goal: workflow.goal,
  };
}

function replaceVerifierPrompt(workflow: CompiledWorkflow, prompt: string) {
  const graph = projectCompiledControlGraph(workflow);
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.type === "verifier" && node.verifier.kind === "model"
        ? { ...node, verifier: { ...node.verifier, prompt } }
        : node,
    ),
  };
}

function graphWithBytes(workflow: CompiledWorkflow, target: number) {
  const graph = replaceVerifierPrompt(workflow, "x");
  const count = graph.nodes.filter((node) => node.type === "verifier").length;
  const additional = target - Buffer.byteLength(JSON.stringify(graph));
  let index = 0;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.type !== "verifier" || node.verifier.kind !== "model") return node;
      const extra = Math.floor(additional / count) + (index++ < additional % count ? 1 : 0);
      return { ...node, verifier: { ...node.verifier, prompt: "x".repeat(1 + extra) } };
    }),
  };
}

function source(verifiers = 1) {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: repair-policy }
budget:
  maxNodeStarts: 64
  maxModelTokens: 1000000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 8388608
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: repair-policy }
  outcome: Repair the admitted candidate.
  criteria:
    - id: accepted-repair
      description: The repair evidence is accepted.
      verifier: { nodeId: verify-0 }
nodes:
  - id: repair-agent
    type: agent
    agent:
      prompt: Produce a bounded repair disposition.
      model: { provider: openrouter, id: bound-model }
      tools: [read]
${Array.from(
  { length: verifiers },
  (_, index) => `  - id: verify-${index}
    type: verifier
    dependsOn: [repair-agent]
    verifier:
      kind: model
      prompt: Check the admitted evidence.
      evidence: [{ nodeId: repair-agent, field: agent.text }]
      model: { provider: openrouter, id: bound-model }
`,
).join("")}`;
}
