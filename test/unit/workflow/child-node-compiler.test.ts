import { describe, expect, it } from "vitest";

import {
  compileWorkflowText,
  WorkflowCompilationError,
} from "../../../src/domain/workflow/compiler.js";

describe("child node compilation", () => {
  it("compiles a bounded embedded workflow with an unconditional typed result", () => {
    const workflow = compileWorkflowText(parentWorkflow(childWorkflow()));
    const child = workflow.nodes.find((node) => node.id === "delegate");

    expect(child).toMatchObject({
      id: "delegate",
      type: "child",
      dependsOn: [],
      child: {
        resultNodeId: "publish",
        workflow: {
          id: "child-analysis",
          budget: {
            maxNodeStarts: 8,
            maxModelTokens: 1000,
            maxCostUsdMicros: 250_000,
            maxExecutionMs: 60_000,
            maxArtifactBytes: 100_000,
          },
        },
        workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        resultSchemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(Object.isFrozen(child)).toBe(true);
    expect(child?.type === "child" && Object.isFrozen(child.child.workflow)).toBe(true);
  });

  it("allows existing graph consumers to read the child typed result", () => {
    const source = parentWorkflow(childWorkflow()).replace(
      /\n$/,
      `\n  - id: route
    type: condition
    dependsOn: [delegate]
    condition:
      source: { nodeId: delegate, field: result.value }
      cases: [{ id: accepted, equals: "true" }]
      default: rejected
  - id: accepted-path
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: accepted }
    command: { executable: node }
  - id: rejected-path
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: rejected }
    command: { executable: node }
  - id: joined
    type: join
    join:
      conditionId: route
      branches:
        - { case: accepted, nodeId: accepted-path }
        - { case: rejected, nodeId: rejected-path }
  - id: finish
    type: command
    dependsOn: [joined]
    command: { executable: node }
`,
    );

    expect(() => compileWorkflowText(source)).not.toThrow();
  });

  it.each([
    [
      "a complete five-dimensional budget",
      childWorkflow().replace("  maxArtifactBytes: 100000\n", ""),
      "child_budget_required",
    ],
    ["an unconditional result", childWithConditionalResult(), "child_result_not_unconditional"],
    ["a terminal result", childWithNonTerminalResult(), "child_result_not_terminal"],
    ["a wait-free workflow", childWithApprovalWait(), "child_wait_unsupported"],
  ])("requires %s", (_name, embedded, diagnosticCode) => {
    const error = captureCompilationError(parentWorkflow(embedded));
    expect(error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: diagnosticCode })]),
    );
  });

  it("rejects child nesting beyond the durable run-tree limit", () => {
    let nested = childWorkflow();
    for (let depth = 0; depth < 5; depth += 1) {
      nested = childWorkflowContaining(nested, `nested-${depth}`);
    }

    const error = captureCompilationError(parentWorkflow(nested));
    expect(error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "child_depth_exceeded" })]),
    );
  });

  it("rejects a sibling child tree above the total expanded-node limit", () => {
    const child = largeChildWorkflow();
    const children = Array.from(
      { length: 16 },
      (_, index) => `  - id: child-${index + 1}
    type: child
    dependsOn: [bootstrap]
    child:
      resultNodeId: publish
      workflow: |
${indent(child.trim(), 8)}`,
    ).join("\n");
    const source = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: oversized-tree }
budget:
  maxNodeStarts: 2048
  maxModelTokens: 10000
  maxCostUsd: 2
  maxExecutionMs: 300000
nodes:
  - id: bootstrap
    type: command
    command: { executable: node }
${children}
`;

    const error = captureCompilationError(source);
    expect(error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "child_tree_too_large" })]),
    );
  });
});

function parentWorkflow(embeddedWorkflow: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: parent-workflow }
budget:
  maxNodeStarts: 32
  maxModelTokens: 10000
  maxCostUsd: 2
  maxExecutionMs: 300000
nodes:
  - id: delegate
    type: child
    child:
      resultNodeId: publish
      workflow: |
${indent(embeddedWorkflow.trim(), 8)}
`;
}

function childWorkflow(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: child-analysis }
budget:
  maxNodeStarts: 8
  maxModelTokens: 1000
  maxCostUsd: 0.25
  maxExecutionMs: 60000
  maxArtifactBytes: 100000
nodes:
  - id: produce
    type: command
    command:
      executable: node
      args: [-e, "process.stdout.write('true')"]
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
`;
}

function childWithConditionalResult(): string {
  return childWorkflow()
    .replace(
      "  - id: publish\n    type: result\n    dependsOn: [produce]",
      `  - id: route
    type: condition
    dependsOn: [produce]
    condition:
      source: { nodeId: produce, field: command.stdout }
      cases: [{ id: selected, equals: "true" }]
      default: skipped
  - id: publish
    type: result
    dependsOn: [route, produce]
    when: { conditionId: route, case: selected }`,
    )
    .concat(`  - id: skipped-result
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: skipped }
    command: { executable: node }
  - id: joined
    type: join
    join:
      conditionId: route
      branches:
        - { case: selected, nodeId: publish }
        - { case: skipped, nodeId: skipped-result }
  - id: finish
    type: command
    dependsOn: [joined]
    command: { executable: node }
`);
}

function childWithNonTerminalResult(): string {
  return childWorkflow().concat(`  - id: consume
    type: command
    dependsOn: [publish]
    command: { executable: node }
`);
}

function childWithApprovalWait(): string {
  return childWorkflow().replace(
    "    type: command\n    command:",
    `    type: command
    approval: { mode: required }
    command:`,
  );
}

function childWorkflowContaining(nested: string, id: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 32
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 1000000
nodes:
  - id: nested-child
    type: child
    child:
      resultNodeId: publish
      workflow: |
${indent(nested.trim(), 8)}
  - id: publish
    type: result
    dependsOn: [nested-child]
    result:
      source: { nodeId: nested-child, field: result.value }
      schema: { type: boolean }
`;
}

function largeChildWorkflow(): string {
  const commands = Array.from({ length: 63 }, (_, index) => {
    const id = `step-${index + 1}`;
    const dependency = index === 0 ? "" : `    dependsOn: [step-${index}]\n`;
    return `  - id: ${id}
    type: command
${dependency}    command: { executable: node }`;
  }).join("\n");
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: large-child }
budget:
  maxNodeStarts: 64
  maxModelTokens: 1000
  maxCostUsd: 0.25
  maxExecutionMs: 60000
  maxArtifactBytes: 100000
nodes:
${commands}
  - id: publish
    type: result
    dependsOn: [step-63]
    result:
      source: { nodeId: step-63, field: command.stdout }
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
