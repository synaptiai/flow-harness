import { describe, expect, it } from "vitest";

import {
  compileWorkflowText,
  type WorkflowCompilationError,
} from "../../../src/domain/workflow/compiler.js";

describe("optimization node compilation", () => {
  it("expands a bounded optimization into deterministic candidate and check nodes", () => {
    const workflow = compileWorkflowText(optimizationWorkflow());

    expect(workflow.nodes.map((node) => node.id)).toEqual([
      "measure-baseline",
      "baseline",
      "optimize--c1--candidate",
      "optimize--c1--check",
      "optimize--c2--candidate",
      "optimize--c2--check",
      "optimize",
      "finish",
    ]);
    expect(workflow.nodes[2]).toMatchObject({
      id: "optimize--c1--candidate",
      type: "child",
      dependsOn: ["baseline"],
      optimizationCandidate: {
        optimizationId: "optimize",
        candidate: 1,
        checkNodeId: "optimize--c1--check",
      },
      child: {
        resultNodeId: "publish",
        resultSchemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(workflow.nodes[3]).toEqual(
      expect.objectContaining({
        id: "optimize--c1--check",
        type: "optimization-check",
        dependsOn: ["optimize--c1--candidate"],
        optimizationCheck: expect.objectContaining({
          optimizationId: "optimize",
          candidate: 1,
          candidateNodeId: "optimize--c1--candidate",
          baseline: { nodeId: "baseline", field: "result.value" },
          metric: { pointer: "/score", direction: "minimize" },
          invariants: [{ pointer: "/tests-passed", equals: true }],
          maxConsecutiveNonImproving: 1,
          rollback: "previous-best",
        }),
      }),
    );
    expect(workflow.nodes[4]).toMatchObject({
      dependsOn: ["optimize--c1--check"],
      optimizationGuard: {
        optimizationId: "optimize",
        candidate: 2,
        checkNodeId: "optimize--c1--check",
      },
    });
    expect(workflow.nodes[5]).toMatchObject({
      optimizationCheck: { priorCheckNodeId: "optimize--c1--check" },
      optimizationGuard: {
        optimizationId: "optimize",
        candidate: 2,
        checkNodeId: "optimize--c1--check",
      },
    });
    expect(workflow.nodes[6]).toEqual({
      id: "optimize",
      type: "optimization",
      dependsOn: ["optimize--c1--check", "optimize--c2--check"],
      optimization: {
        baseline: { nodeId: "baseline", field: "result.value" },
        baselineSchemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        metric: { pointer: "/score", direction: "minimize" },
        invariants: [{ pointer: "/tests-passed", equals: true }],
        maxCandidates: 2,
        maxConsecutiveNonImproving: 1,
        rollback: "previous-best",
        candidateNodeIds: ["optimize--c1--candidate", "optimize--c2--candidate"],
        checkNodeIds: ["optimize--c1--check", "optimize--c2--check"],
      },
    });
    expect(workflow.nodes[7]?.dependsOn).toEqual(["optimize"]);
    expect(workflow.nodes.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    [
      "zero candidates",
      "maxCandidates: 0\n      stagnation: { maxConsecutiveNonImproving: 1 }",
      "invalid_schema",
    ],
    [
      "too many candidates",
      "maxCandidates: 17\n      stagnation: { maxConsecutiveNonImproving: 1 }",
      "invalid_schema",
    ],
    [
      "stagnation beyond the candidate bound",
      "maxCandidates: 2\n      stagnation: { maxConsecutiveNonImproving: 3 }",
      "invalid_schema",
    ],
  ])("rejects %s", (_name, replacement, code) => {
    expectDiagnostic(
      optimizationWorkflow().replace(
        "maxCandidates: 2\n      stagnation: { maxConsecutiveNonImproving: 1 }",
        replacement,
      ),
      code,
      "nodes.2.optimization",
    );
  });

  it("rejects baseline and candidate result schema drift", () => {
    expectDiagnostic(
      optimizationWorkflow().replace("score: { type: number }", "score: { type: integer }"),
      "optimization_schema_mismatch",
      "nodes.2.optimization.candidate.resultNodeId",
    );
  });

  it.each([
    ["non-numeric metric", "/tests-passed", "optimization_metric_not_numeric"],
    ["unknown metric pointer", "/missing", "optimization_pointer_unresolved"],
    ["malformed metric pointer", "/score~2", "optimization_pointer_invalid"],
  ])("rejects a %s", (_name, pointer, code) => {
    expectDiagnostic(
      optimizationWorkflow().replace(
        "pointer: /score, direction",
        `pointer: ${pointer}, direction`,
      ),
      code,
      "nodes.2.optimization.metric.pointer",
    );
  });

  it("rejects an invariant expected value incompatible with its schema", () => {
    expectDiagnostic(
      optimizationWorkflow().replace("equals: true", 'equals: "true"'),
      "optimization_invariant_mismatch",
      "nodes.2.optimization.invariants.0.equals",
    );
  });

  it("rejects an optimization baseline that is not a direct unconditional result dependency", () => {
    expectDiagnostic(
      optimizationWorkflow().replace("dependsOn: [baseline]", "dependsOn: [measure-baseline]"),
      "optimization_baseline_requires_dependency",
      "nodes.2.optimization.baseline.nodeId",
    );
  });

  it("rejects a metric whose baseline result is model-authored rather than command-evaluated", () => {
    const source = optimizationWorkflow()
      .replace(
        "type: command\n    command: { executable: node, args: [measure-baseline] }",
        `type: agent
    agent:
      prompt: Score this workspace.
      model: { provider: test, id: model }
      tools: []`,
      )
      .replace("field: command.stdout", "field: agent.text");

    expectDiagnostic(
      source,
      "optimization_evaluator_not_deterministic",
      "nodes.2.optimization.baseline.nodeId",
    );
  });

  it("rejects a top-level sibling unordered with the optimization barrier", () => {
    const sibling = `  - id: unordered
    type: command
    dependsOn: [baseline]
    command: { executable: node, args: [unordered] }
`;

    expectDiagnostic(
      optimizationWorkflow().replace("  - id: finish", `${sibling}  - id: finish`),
      "optimization_barrier_unordered",
      "nodes.3.dependsOn",
    );
  });

  it("rejects nested optimization inside an embedded candidate workflow", () => {
    const nested = optimizationWorkflow("nested-optimize").trim();
    expectDiagnostic(
      optimizationWorkflow().replace(indent(candidateWorkflow().trim(), 10), indent(nested, 10)),
      "optimization_nested_unsupported",
      "nodes",
    );
  });

  it("preserves workflows without optimization nodes", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: unchanged }
nodes:
  - id: verify
    type: command
    command: { executable: npm, args: [test] }
`);

    expect(workflow.nodes).toEqual([
      {
        id: "verify",
        type: "command",
        dependsOn: [],
        command: { executable: "npm", args: ["test"], timeoutMs: 60_000 },
      },
    ]);
  });
});

function expectDiagnostic(source: string, code: string, pathPrefix: string): void {
  expect(() => compileWorkflowText(source)).toThrowError(
    expect.objectContaining<Partial<WorkflowCompilationError>>({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code, path: expect.stringMatching(`^${pathPrefix}`) }),
      ]),
    }),
  );
}

function optimizationWorkflow(id = "bounded-optimization"): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 64
  maxModelTokens: 10000
  maxCostUsd: 2
  maxExecutionMs: 300000
nodes:
  - id: measure-baseline
    type: command
    command: { executable: node, args: [measure-baseline] }
  - id: baseline
    type: result
    dependsOn: [measure-baseline]
    result:
      source: { nodeId: measure-baseline, field: command.stdout }
      schema:
        type: object
        properties:
          score: { type: number }
          tests-passed: { type: boolean }
        required: [score, tests-passed]
  - id: optimize
    type: optimization
    dependsOn: [baseline]
    optimization:
      baseline: { nodeId: baseline, field: result.value }
      metric: { pointer: /score, direction: minimize }
      invariants:
        - { pointer: /tests-passed, equals: true }
      maxCandidates: 2
      stagnation: { maxConsecutiveNonImproving: 1 }
      rollback: previous-best
      candidate:
        resultNodeId: publish
        workflow: |
${indent(candidateWorkflow().trim(), 10)}
  - id: finish
    type: command
    dependsOn: [optimize]
    command: { executable: node, args: [finish] }
`;
}

function candidateWorkflow(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: candidate }
budget:
  maxNodeStarts: 4
  maxModelTokens: 1000
  maxCostUsd: 0.25
  maxExecutionMs: 60000
nodes:
  - id: improve
    type: command
    command: { executable: node, args: [improve] }
  - id: publish
    type: result
    dependsOn: [improve]
    result:
      source: { nodeId: improve, field: command.stdout }
      schema:
        type: object
        properties:
          score: { type: number }
          tests-passed: { type: boolean }
        required: [score, tests-passed]
`;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
