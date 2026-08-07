import { describe, expect, it } from "vitest";

import {
  type WorkflowCompilationError,
  compileWorkflowText,
} from "../../../src/domain/workflow/compiler.js";

describe("approval node compilation", () => {
  it("compiles a strict evidence-bound pure approval node", () => {
    const workflow = compileWorkflowText(validWorkflow());

    expect(workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "review",
          type: "approval",
          dependsOn: ["plan", "verify-plan"],
          approval: {
            prompt: "Approve the verified plan.",
            evidence: [
              { nodeId: "plan", field: "agent.text" },
              { nodeId: "verify-plan", field: "command.stdout" },
            ],
          },
        }),
      ]),
    );
    expect(Object.isFrozen(workflow.nodes.find((node) => node.id === "review"))).toBe(true);
  });

  it.each([
    ["empty prompt", "prompt: '   '", "evidence: [{ nodeId: plan, field: agent.text }]"],
    ["empty evidence", "prompt: Review.", "evidence: []"],
    [
      "duplicate evidence",
      "prompt: Review.",
      "evidence: [{ nodeId: plan, field: agent.text }, { nodeId: plan, field: agent.text }]",
    ],
  ])("rejects %s at the strict schema boundary", (_name, prompt, evidence) => {
    expect(() => compileWorkflowText(workflowWithApproval(`${prompt}\n      ${evidence}`))).toThrow(
      /workflow compilation failed/i,
    );
  });

  it("rejects oversized prompt and evidence declarations", () => {
    expect(() =>
      compileWorkflowText(
        workflowWithApproval(
          `prompt: ${"x".repeat(4097)}\n      evidence: [{ nodeId: plan, field: agent.text }]`,
        ),
      ),
    ).toThrow(/workflow compilation failed/i);

    expect(() => compileWorkflowText(oversizedEvidenceWorkflow())).toThrow(
      /workflow compilation failed/i,
    );
  });

  it.each([
    ["unknown source", "missing", "agent.text", ["plan", "verify-plan"], "approval_source_unknown"],
    ["self source", "review", "agent.text", ["plan", "review"], "approval_source_self"],
    [
      "non-direct source",
      "plan",
      "agent.text",
      ["verify-plan"],
      "approval_source_requires_dependency",
    ],
    [
      "incompatible field",
      "verify-plan",
      "agent.text",
      ["plan", "verify-plan"],
      "approval_source_field_mismatch",
    ],
  ])("rejects an %s", (_name, sourceNodeId, sourceField, dependsOn, diagnosticCode) => {
    const error = captureCompilationError(
      workflowWithApproval(
        `prompt: Review.\n      evidence: [{ nodeId: ${sourceNodeId}, field: ${sourceField} }]`,
        dependsOn,
      ),
    );

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: diagnosticCode })]),
    );
  });

  it("remaps approval evidence inside a bounded loop body", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: loop-review }
nodes:
  - id: repair
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
            type: approval
            dependsOn: [plan]
            approval:
              prompt: Approve this iteration plan.
              evidence: [{ nodeId: plan, field: agent.text }]
          - id: check
            type: command
            dependsOn: [review]
            command: { executable: node, args: [--version] }
  - id: verify
    type: command
    dependsOn: [repair]
    command: { executable: node, args: [--version] }
`);

    expect(workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "repair--i1--node--review",
          type: "approval",
          approval: {
            prompt: "Approve this iteration plan.",
            evidence: [{ nodeId: "repair--i1--node--plan", field: "agent.text" }],
          },
          loopInstance: { loopId: "repair", iteration: 1, templateNodeId: "review" },
        }),
        expect.objectContaining({
          id: "repair--i2--node--review",
          type: "approval",
          approval: expect.objectContaining({
            evidence: [{ nodeId: "repair--i2--node--plan", field: "agent.text" }],
          }),
          loopInstance: { loopId: "repair", iteration: 2, templateNodeId: "review" },
        }),
      ]),
    );
  });
});

function validWorkflow(): string {
  return workflowWithApproval(`prompt: Approve the verified plan.
      evidence:
        - { nodeId: plan, field: agent.text }
        - { nodeId: verify-plan, field: command.stdout }`);
}

function workflowWithApproval(
  approval: string,
  dependsOn: readonly string[] = ["plan", "verify-plan"],
): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: approval-workflow }
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
  - id: verify-plan
    type: command
    dependsOn: [prepare]
    command: { executable: node, args: [--version] }
  - id: review
    type: approval
    dependsOn: [${dependsOn.join(", ")}]
    approval:
      ${approval}
  - id: verify
    type: command
    dependsOn: [review]
    command: { executable: node, args: [--version] }
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

function oversizedEvidenceWorkflow(): string {
  const sourceIds = Array.from({ length: 17 }, (_, index) => `source-${index + 1}`);
  const sources = sourceIds
    .map(
      (id) => `  - id: ${id}
    type: command
    dependsOn: [root]
    command: { executable: node, args: [--version] }`,
    )
    .join("\n");
  const evidence = sourceIds
    .map((id) => `        - { nodeId: ${id}, field: command.stdout }`)
    .join("\n");
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: oversized-approval-evidence }
concurrency: { maxNodes: 16 }
nodes:
  - id: root
    type: command
    command: { executable: node, args: [--version] }
${sources}
  - id: review
    type: approval
    dependsOn: [${sourceIds.join(", ")}]
    approval:
      prompt: Review all evidence.
      evidence:
${evidence}
  - id: verify
    type: command
    dependsOn: [review]
    command: { executable: node, args: [--version] }
`;
}
