import { describe, expect, it } from "vitest";

import {
  compileWorkflowText,
  WorkflowCompilationError,
} from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";

describe("artifact budget compilation", () => {
  it("compiles, freezes, and digest-binds a positive safe artifact ceiling", () => {
    const small = compileWorkflowText(rootWorkflow("maxArtifactBytes: 12"));
    const large = compileWorkflowText(rootWorkflow("maxArtifactBytes: 13"));

    expect(small.budget).toEqual({ maxArtifactBytes: 12 });
    expect(Object.isFrozen(small.budget)).toBe(true);
    expect(calculateWorkflowDigest(small)).not.toBe(calculateWorkflowDigest(large));
  });

  it("preserves backward compatibility when a root omits the artifact ceiling", () => {
    const workflow = compileWorkflowText(rootWorkflow("maxNodeStarts: 1"));

    expect(workflow.budget).toEqual({ maxNodeStarts: 1 });
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["unsafe", "9007199254740992"],
  ])("rejects a %s artifact ceiling", (_case, value) => {
    const error = captureCompilationError(rootWorkflow(`maxArtifactBytes: ${value}`));

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_schema", path: "budget.maxArtifactBytes" }),
      ]),
    );
  });

  it("requires every child workflow to declare the fifth ceiling", () => {
    const error = captureCompilationError(parentWorkflow(childWorkflow("")));

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "child_budget_required" })]),
    );
  });

  it("compiles a child workflow with all five ceilings", () => {
    const workflow = compileWorkflowText(
      parentWorkflow(childWorkflow("  maxArtifactBytes: 100\n")),
    );
    const child = workflow.nodes.find((node) => node.id === "delegate");

    expect(child).toMatchObject({
      type: "child",
      child: { workflow: { budget: { maxArtifactBytes: 100 } } },
    });
  });
});

function rootWorkflow(budget: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: root-artifact-budget }
budget: { ${budget} }
nodes:
  - id: verify
    type: command
    command: { executable: node }
`;
}

function parentWorkflow(embeddedWorkflow: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: parent-artifact-budget }
budget:
  maxNodeStarts: 16
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 1000
nodes:
  - id: delegate
    type: child
    child:
      resultNodeId: publish
      workflow: |
${indent(embeddedWorkflow.trim(), 8)}
`;
}

function childWorkflow(artifactBudget: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: child-artifact-budget }
budget:
  maxNodeStarts: 4
  maxModelTokens: 1000
  maxCostUsd: 0.25
  maxExecutionMs: 10000
${artifactBudget}nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
`;
}

function captureCompilationError(source: string): WorkflowCompilationError {
  try {
    compileWorkflowText(source);
  } catch (error) {
    if (error instanceof WorkflowCompilationError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected workflow compilation to fail");
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
