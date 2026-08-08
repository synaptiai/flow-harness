import { describe, expect, it } from "vitest";

import {
  compileWorkflowText,
  WorkflowCompilationError,
} from "../../../src/domain/workflow/compiler.js";

describe("agent tool package compilation", () => {
  it("compiles an immutable exact per-agent package selection", () => {
    const workflow = compileWorkflowText(
      workflowSource(`
  - id: analyze
    type: agent
    agent:
      prompt: Produce the selected report.
      model: { provider: test, id: deterministic }
      tools: [read]
      toolPackages:
        - { name: project-report, version: 1.2.3 }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: node, args: [--version] }
`),
    );

    expect(workflow.nodes[0]).toMatchObject({
      type: "agent",
      agent: {
        tools: ["read"],
        toolPackages: [{ name: "project-report", version: "1.2.3" }],
      },
    });
    const node = workflow.nodes[0];
    expect(node?.type === "agent" && Object.isFrozen(node.agent.toolPackages)).toBe(true);
    expect(node?.type === "agent" && Object.isFrozen(node.agent.toolPackages[0])).toBe(true);
  });

  it("keeps omission equivalent to an empty selection", () => {
    const workflow = compileWorkflowText(
      workflowSource(`
  - id: analyze
    type: agent
    agent:
      prompt: Analyze without package tools.
      model: { provider: test, id: deterministic }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: node }
`),
    );

    expect(workflow.nodes[0]).toMatchObject({ type: "agent", agent: { toolPackages: [] } });
  });

  it("allows command approval for selected package tools without exposing raw exec", () => {
    const workflow = compileWorkflowText(
      workflowSource(`
  - id: analyze
    type: agent
    agent:
      prompt: Produce the selected report with approval.
      model: { provider: test, id: deterministic }
      toolPackages: [{ name: project-report, version: 1.2.3 }]
      toolApproval:
        exec: { mode: required, grantTtlMs: 120000 }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: node }
`),
    );

    expect(workflow.nodes[0]).toMatchObject({
      type: "agent",
      agent: {
        tools: [],
        toolPackages: [{ name: "project-report", version: "1.2.3" }],
        toolApproval: { exec: { mode: "required", grantTtlMs: 120_000 } },
      },
    });
  });

  it.each([
    {
      label: "duplicate package name",
      fragment:
        "toolPackages: [{ name: project-report, version: 1.2.3 }, { name: project-report, version: 1.2.4 }]",
      field: "nodes.0.agent.toolPackages",
    },
    {
      label: "mutable version",
      fragment: "toolPackages: [{ name: project-report, version: latest }]",
      field: "nodes.0.agent.toolPackages.0.version",
    },
    {
      label: "invalid package name",
      fragment: "toolPackages: [{ name: ProjectReport, version: 1.2.3 }]",
      field: "nodes.0.agent.toolPackages.0.name",
    },
    {
      label: "approval without any command authority",
      fragment: "toolApproval: { exec: { mode: required } }",
      field: "nodes.0.agent.toolApproval",
    },
    {
      label: "fresh recovery with a package command",
      fragment:
        "toolPackages: [{ name: project-report, version: 1.2.3 }]\n      recovery: { mode: fresh, maxAttempts: 2 }",
      field: "nodes.0.agent.recovery",
    },
  ])("rejects $label", ({ fragment, field }) => {
    const source = workflowSource(`
  - id: analyze
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: test, id: deterministic }
      ${fragment}
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: node }
`);

    try {
      compileWorkflowText(source);
      throw new Error("expected compilation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowCompilationError);
      if (!(error instanceof WorkflowCompilationError)) {
        return;
      }
      expect(error.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "invalid_schema", path: field })]),
      );
    }
  });
});

function workflowSource(nodes: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: tool-package-compiler
nodes:
${nodes}
`;
}
