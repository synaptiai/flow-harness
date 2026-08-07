import { describe, expect, it } from "vitest";

import {
  type WorkflowCompilationError,
  compileWorkflowText,
} from "../../../src/domain/workflow/compiler.js";

describe("verifier node compilation", () => {
  it("compiles strict command and evidence-isolated model verifier drivers", () => {
    const workflow = compileWorkflowText(validWorkflow());

    expect(workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "verify-tests",
          type: "verifier",
          dependsOn: ["prepare"],
          verifier: {
            kind: "command",
            command: {
              executable: "npm",
              args: ["test"],
              timeoutMs: 120_000,
            },
          },
        }),
        expect.objectContaining({
          id: "review",
          type: "verifier",
          dependsOn: ["plan", "verify-tests"],
          verifier: {
            kind: "model",
            prompt: "Decide whether the evidence proves the plan is correct.",
            evidence: [
              { nodeId: "plan", field: "agent.text" },
              { nodeId: "verify-tests", field: "verifier.reason" },
            ],
            model: {
              provider: "test",
              id: "deterministic",
              thinking: "medium",
            },
            timeoutMs: 120_000,
          },
        }),
      ]),
    );
    const review = workflow.nodes.find((node) => node.id === "review");
    expect(Object.isFrozen(review)).toBe(true);
    expect(review?.type === "verifier" && Object.isFrozen(review.verifier)).toBe(true);
  });

  it("applies bounded defaults without importing a runtime type", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: verifier-defaults }
nodes:
  - id: prepare
    type: command
    command: { executable: node }
  - id: deterministic
    type: verifier
    dependsOn: [prepare]
    verifier:
      kind: command
      command: { executable: node }
  - id: review
    type: verifier
    dependsOn: [deterministic]
    verifier:
      kind: model
      prompt: Review the deterministic result.
      evidence: [{ nodeId: deterministic, field: verifier.verdict }]
      model: { provider: test, id: deterministic }
  - id: finish
    type: command
    dependsOn: [review]
    command: { executable: node }
`);

    expect(workflow.nodes.find((node) => node.id === "deterministic")).toMatchObject({
      verifier: { kind: "command", command: { args: [], timeoutMs: 60_000 } },
    });
    expect(workflow.nodes.find((node) => node.id === "review")).toMatchObject({
      verifier: {
        kind: "model",
        model: { thinking: "medium" },
        timeoutMs: 300_000,
      },
    });
  });

  it.each([
    [
      "model fields on a command driver",
      `kind: command
      prompt: Not allowed.
      command: { executable: node }`,
    ],
    [
      "command fields on a model driver",
      `kind: model
      prompt: Review.
      evidence: [{ nodeId: prepare, field: command.stdout }]
      model: { provider: test, id: deterministic }
      command: { executable: node }`,
    ],
    [
      "an unknown driver",
      `kind: package
      command: { executable: node }`,
    ],
    [
      "an empty model prompt",
      `kind: model
      prompt: '   '
      evidence: [{ nodeId: prepare, field: command.stdout }]
      model: { provider: test, id: deterministic }`,
    ],
    [
      "an empty evidence list",
      `kind: model
      prompt: Review.
      evidence: []
      model: { provider: test, id: deterministic }`,
    ],
    [
      "duplicate evidence",
      `kind: model
      prompt: Review.
      evidence:
        - { nodeId: prepare, field: command.stdout }
        - { nodeId: prepare, field: command.stdout }
      model: { provider: test, id: deterministic }`,
    ],
  ])("rejects %s at the strict schema boundary", (_name, verifier) => {
    expect(() => compileWorkflowText(workflowWithVerifier(verifier))).toThrow(
      /workflow compilation failed/i,
    );
  });

  it("rejects oversized model prompts and evidence declarations", () => {
    expect(() =>
      compileWorkflowText(
        workflowWithVerifier(`kind: model
      prompt: ${"x".repeat(16_385)}
      evidence: [{ nodeId: prepare, field: command.stdout }]
      model: { provider: test, id: deterministic }`),
      ),
    ).toThrow(/workflow compilation failed/i);

    expect(() => compileWorkflowText(oversizedEvidenceWorkflow())).toThrow(
      /workflow compilation failed/i,
    );
  });

  it.each([
    ["unknown source", "missing", "agent.text", ["prepare"], "verifier_source_unknown"],
    ["self source", "review", "agent.text", ["prepare", "review"], "verifier_source_self"],
    [
      "non-direct source",
      "prepare",
      "command.stdout",
      ["plan"],
      "verifier_source_requires_dependency",
    ],
    [
      "incompatible command field",
      "plan",
      "command.stdout",
      ["plan"],
      "verifier_source_field_mismatch",
    ],
    [
      "incompatible verifier field",
      "prepare",
      "verifier.reason",
      ["prepare"],
      "verifier_source_field_mismatch",
    ],
  ])("rejects an %s", (_name, sourceNodeId, sourceField, dependsOn, diagnosticCode) => {
    const error = captureCompilationError(
      modelVerifierWorkflow(sourceNodeId, sourceField, dependsOn),
    );

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: diagnosticCode })]),
    );
  });

  it("allows a goal criterion to bind a terminal verifier while retaining command compatibility", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: typed-goal-verifier }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: accepted-review }
  outcome: The verifier accepts the change.
  criteria:
    - id: reviewed
      description: The declared evidence is accepted.
      verifier: { nodeId: review }
nodes:
  - id: prepare
    type: command
    command: { executable: node, args: [--version] }
  - id: review
    type: verifier
    dependsOn: [prepare]
    verifier:
      kind: model
      prompt: Review the evidence.
      evidence: [{ nodeId: prepare, field: command.stdout }]
      model: { provider: test, id: deterministic }
`);

    expect(workflow.goal?.criteria[0]?.verifierNodeId).toBe("review");
    expect(workflow.nodes.at(-1)?.type).toBe("verifier");
  });

  it("still rejects a non-terminal criterion verifier", () => {
    const error = captureCompilationError(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: non-terminal-verifier }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: accepted-review }
  outcome: The verifier accepts the change.
  criteria:
    - id: reviewed
      description: The declared evidence is accepted.
      verifier: { nodeId: review }
nodes:
  - id: prepare
    type: command
    command: { executable: node }
  - id: review
    type: verifier
    dependsOn: [prepare]
    verifier:
      kind: command
      command: { executable: node }
  - id: finish
    type: command
    dependsOn: [review]
    command: { executable: node }
`);

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "criterion_verifier_requires_terminal" }),
      ]),
    );
  });

  it("remaps verifier evidence inside a bounded loop body", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: loop-verifier }
nodes:
  - id: review-loop
    type: loop
    loop:
      maxIterations: 2
      until:
        source: { nodeId: check, field: command.stdout }
        equals: pass
      body:
        nodes:
          - id: plan
            type: agent
            agent:
              prompt: Plan the repair.
              model: { provider: test, id: deterministic }
          - id: review
            type: verifier
            dependsOn: [plan]
            verifier:
              kind: model
              prompt: Review this iteration plan.
              evidence: [{ nodeId: plan, field: agent.text }]
              model: { provider: test, id: deterministic }
          - id: check
            type: command
            dependsOn: [review]
            command: { executable: node, args: [--version] }
  - id: verify
    type: command
    dependsOn: [review-loop]
    command: { executable: node, args: [--version] }
`);

    expect(workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "review-loop--i1--node--review",
          type: "verifier",
          verifier: expect.objectContaining({
            kind: "model",
            evidence: [{ nodeId: "review-loop--i1--node--plan", field: "agent.text" }],
          }),
          loopInstance: { loopId: "review-loop", iteration: 1, templateNodeId: "review" },
        }),
        expect.objectContaining({
          id: "review-loop--i2--node--review",
          type: "verifier",
          verifier: expect.objectContaining({
            evidence: [{ nodeId: "review-loop--i2--node--plan", field: "agent.text" }],
          }),
        }),
      ]),
    );
  });

  it("exposes accepted verifier fields to conditions, approvals, and loop checks", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: verifier-consumers }
nodes:
  - id: verify
    type: verifier
    verifier:
      kind: command
      command: { executable: node, args: [--version] }
  - id: route
    type: condition
    dependsOn: [verify]
    condition:
      source: { nodeId: verify, field: verifier.verdict }
      cases: [{ id: accepted, equals: accepted }]
      default: unexpected
  - id: accepted-path
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: accepted }
    command: { executable: node }
  - id: unexpected-path
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: unexpected }
    command: { executable: node }
  - id: joined
    type: join
    join:
      conditionId: route
      branches:
        - { case: accepted, nodeId: accepted-path }
        - { case: unexpected, nodeId: unexpected-path }
  - id: approve
    type: approval
    dependsOn: [verify, joined]
    approval:
      prompt: Confirm the deterministic verifier result.
      evidence: [{ nodeId: verify, field: verifier.reason }]
  - id: convergence
    type: loop
    dependsOn: [approve]
    loop:
      maxIterations: 2
      until:
        source: { nodeId: loop-verify, field: verifier.verdict }
        equals: accepted
      body:
        nodes:
          - id: loop-verify
            type: verifier
            verifier:
              kind: command
              command: { executable: node, args: [--version] }
  - id: finish
    type: command
    dependsOn: [convergence]
    command: { executable: node }
`);

    expect(workflow.nodes.find((node) => node.id === "route")).toMatchObject({
      condition: { source: { nodeId: "verify", field: "verifier.verdict" } },
    });
    expect(workflow.nodes.find((node) => node.id === "approve")).toMatchObject({
      approval: { evidence: [{ nodeId: "verify", field: "verifier.reason" }] },
    });
    expect(workflow.nodes.find((node) => node.id === "convergence--i1--check")).toMatchObject({
      loopCheck: {
        source: {
          nodeId: "convergence--i1--node--loop-verify",
          field: "verifier.verdict",
        },
      },
    });
  });
});

function validWorkflow(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: verifier-workflow }
nodes:
  - id: prepare
    type: command
    command: { executable: node, args: [--version] }
  - id: plan
    type: agent
    dependsOn: [prepare]
    agent:
      prompt: Produce a plan.
      model: { provider: test, id: deterministic }
  - id: verify-tests
    type: verifier
    dependsOn: [prepare]
    verifier:
      kind: command
      command:
        executable: npm
        args: [test]
        timeoutMs: 120000
  - id: review
    type: verifier
    dependsOn: [plan, verify-tests]
    verifier:
      kind: model
      prompt: Decide whether the evidence proves the plan is correct.
      evidence:
        - { nodeId: plan, field: agent.text }
        - { nodeId: verify-tests, field: verifier.reason }
      model: { provider: test, id: deterministic }
      timeoutMs: 120000
  - id: finish
    type: command
    dependsOn: [review]
    command: { executable: node, args: [--version] }
`;
}

function workflowWithVerifier(verifier: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: invalid-verifier }
nodes:
  - id: prepare
    type: command
    command: { executable: node, args: [--version] }
  - id: review
    type: verifier
    dependsOn: [prepare]
    verifier:
      ${verifier}
  - id: finish
    type: command
    dependsOn: [review]
    command: { executable: node, args: [--version] }
`;
}

function modelVerifierWorkflow(
  sourceNodeId: string,
  sourceField: string,
  dependsOn: readonly string[],
): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: invalid-verifier-source }
nodes:
  - id: prepare
    type: command
    command: { executable: node }
  - id: plan
    type: agent
    dependsOn: [prepare]
    agent:
      prompt: Plan.
      model: { provider: test, id: deterministic }
  - id: review
    type: verifier
    dependsOn: [${dependsOn.join(", ")}]
    verifier:
      kind: model
      prompt: Review.
      evidence: [{ nodeId: ${sourceNodeId}, field: ${sourceField} }]
      model: { provider: test, id: deterministic }
  - id: finish
    type: command
    dependsOn: [review]
    command: { executable: node }
`;
}

function oversizedEvidenceWorkflow(): string {
  const sourceIds = Array.from({ length: 17 }, (_, index) => `source-${index + 1}`);
  const sources = sourceIds
    .map(
      (id) => `  - id: ${id}
    type: command
    dependsOn: [root]
    command: { executable: node }`,
    )
    .join("\n");
  const evidence = sourceIds
    .map((id) => `        - { nodeId: ${id}, field: command.stdout }`)
    .join("\n");
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: oversized-verifier-evidence }
concurrency: { maxNodes: 16 }
nodes:
  - id: root
    type: command
    command: { executable: node }
${sources}
  - id: review
    type: verifier
    dependsOn: [${sourceIds.join(", ")}]
    verifier:
      kind: model
      prompt: Review all evidence.
      evidence:
${evidence}
      model: { provider: test, id: deterministic }
  - id: finish
    type: command
    dependsOn: [review]
    command: { executable: node }
`;
}

function captureCompilationError(source: string): WorkflowCompilationError {
  try {
    compileWorkflowText(source);
  } catch (error) {
    return error as WorkflowCompilationError;
  }
  throw new Error("expected workflow compilation to fail");
}
