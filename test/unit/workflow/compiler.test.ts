import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  WorkflowCompilationError,
  compileWorkflowText,
} from "../../../src/domain/workflow/compiler.js";

const validWorkflowUrl = new URL(
  "../../fixtures/workflows/valid-command.workflow.yaml",
  import.meta.url,
);

describe("compileWorkflowText", () => {
  it("compiles a strict workflow into an immutable ordered graph", async () => {
    const source = await readFile(validWorkflowUrl, "utf8");

    const workflow = compileWorkflowText(source, validWorkflowUrl.pathname);

    expect(workflow.apiVersion).toBe("flow.synapti.ai/v1alpha1");
    expect(workflow.id).toBe("verify-foundation");
    expect(workflow.nodes.map((node) => node.id)).toEqual(["node-version", "typecheck"]);
    expect(workflow.nodes[1]?.dependsOn).toEqual(["node-version"]);
    expect(Object.isFrozen(workflow)).toBe(true);
    expect(Object.isFrozen(workflow.nodes)).toBe(true);
    expect(workflow.nodes.every(Object.isFrozen)).toBe(true);
  });

  it("reports schema paths for malformed command definitions", () => {
    const source = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: unsafe-command
nodes:
  - id: verify
    type: command
    command: npm test
`;

    expectCompilationFailure(source, "invalid_schema", "nodes.0.command");
  });

  it("reports YAML syntax errors separately from schema errors", () => {
    expectCompilationFailure("nodes: [", "invalid_yaml", "$");
  });

  it("rejects duplicate node identifiers", () => {
    const source = workflowWithNodes(`
  - id: repeated
    type: command
    command: { executable: node, args: [--version] }
  - id: repeated
    type: command
    dependsOn: [repeated]
    command: { executable: node, args: [--version] }
`);

    expectCompilationFailure(source, "duplicate_node", "nodes.1.id");
  });

  it("rejects dependencies that do not exist", () => {
    const source = workflowWithNodes(`
  - id: verify
    type: command
    dependsOn: [missing]
    command: { executable: node, args: [--version] }
`);

    expectCompilationFailure(source, "unknown_dependency", "nodes.0.dependsOn.0");
  });

  it("rejects duplicate and self dependencies", () => {
    const source = workflowWithNodes(`
  - id: verify
    type: command
    dependsOn: [verify, verify]
    command: { executable: node, args: [--version] }
`);

    expectCompilationFailure(source, "self_dependency", "nodes.0.dependsOn.0");
    expectCompilationFailure(source, "duplicate_dependency", "nodes.0.dependsOn.1");
  });

  it("rejects cyclic graphs", () => {
    const source = workflowWithNodes(`
  - id: first
    type: command
    dependsOn: [second]
    command: { executable: node, args: [--version] }
  - id: second
    type: command
    dependsOn: [first]
    command: { executable: node, args: [--version] }
`);

    expectCompilationFailure(source, "cycle", "nodes");
  });

  it("requires exactly one entry node", () => {
    const source = workflowWithNodes(`
  - id: first
    type: command
    command: { executable: node, args: [--version] }
  - id: second
    type: command
    command: { executable: node, args: [--version] }
`);

    expectCompilationFailure(source, "entry_count", "nodes");
  });

  it("rejects unknown fields instead of silently ignoring them", () => {
    const source = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: strict-fields }
unexpected: true
nodes:
  - id: verify
    type: command
    command: { executable: node, args: [--version] }
`;

    expectCompilationFailure(source, "invalid_schema", "$");
  });

  it("rejects agent tools outside the read-only allowlist", () => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [bash]
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    expectCompilationFailure(source, "invalid_schema", "nodes.0.agent.tools.0");
  });

  it("accepts an agent node with an exact read-only tool allowlist", () => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Analyze the repository and report the relevant files.
      model:
        provider: anthropic
        id: claude-sonnet-4-5
        thinking: medium
      tools: [read, grep, find, ls]
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    const workflow = compileWorkflowText(source, "agent.workflow.yaml");

    expect(workflow.nodes[0]).toMatchObject({
      id: "analyze",
      type: "agent",
      agent: {
        tools: ["read", "grep", "find", "ls"],
        timeoutMs: 300000,
      },
    });
  });

  it("rejects an agent as a terminal node", () => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Claim that the work is complete.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
`);

    expectCompilationFailure(source, "terminal_requires_command", "nodes.0.type");
  });
});

function workflowWithNodes(nodes: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: compiler-test
nodes:
${nodes}`;
}

function expectCompilationFailure(source: string, code: string, path: string): void {
  try {
    compileWorkflowText(source, "invalid.workflow.yaml");
    throw new Error("Expected workflow compilation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowCompilationError);
    if (!(error instanceof WorkflowCompilationError)) {
      return;
    }

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code,
          path,
        }),
      ]),
    );
  }
}
