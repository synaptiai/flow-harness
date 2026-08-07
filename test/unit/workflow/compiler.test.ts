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

  it.each([
    "verify-foundation.workflow.yaml",
    "budgeted-foundation.workflow.yaml",
    "implement-and-verify.workflow.yaml",
    "approval-gated-command.workflow.yaml",
  ])("keeps published example %s compilable", async (fileName) => {
    const exampleUrl = new URL(`../../../examples/${fileName}`, import.meta.url);
    const source = await readFile(exampleUrl, "utf8");

    expect(() => compileWorkflowText(source, fileName)).not.toThrow();
  });

  it("compiles an immutable versioned goal with verifier-bound criteria", () => {
    const workflow = compileWorkflowText(
      workflowWithGoalAndNodes(
        goalWithCriteria(`
    - id: typecheck-passes
      description: The project passes static type checking.
      verifier: { nodeId: verify }
`),
        `
  - id: prepare
    type: command
    command: { executable: node, args: [--version] }
  - id: verify
    type: command
    dependsOn: [prepare]
    command: { executable: npm, args: [run, typecheck] }
`,
      ),
    );

    expect(workflow.goal).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      id: "verified-change",
      outcome: "The change is accepted from deterministic evidence.",
      criteria: [
        {
          id: "typecheck-passes",
          verifierNodeId: "verify",
        },
      ],
    });
    expect(Object.isFrozen(workflow.goal)).toBe(true);
    expect(Object.isFrozen(workflow.goal?.criteria)).toBe(true);
    expect(workflow.goal?.criteria.every(Object.isFrozen)).toBe(true);
  });

  it("rejects duplicate criterion identifiers", () => {
    const source = workflowWithGoalAndNodes(
      goalWithCriteria(`
    - id: tests-pass
      description: Tests pass.
      verifier: { nodeId: verify }
    - id: tests-pass
      description: Tests still pass.
      verifier: { nodeId: verify }
`),
      singleVerifierNode(),
    );

    expectCompilationFailure(source, "duplicate_criterion", "goal.criteria.1.id");
  });

  it("rejects an unsupported goal contract version", () => {
    const source = workflowWithGoalAndNodes(
      goalWithCriteria(`
    - id: tests-pass
      description: Tests pass.
      verifier: { nodeId: verify }
`).replace("flow.synapti.ai/v1alpha1", "flow.synapti.ai/v9"),
      singleVerifierNode(),
    );

    expectCompilationFailure(source, "invalid_schema", "goal.apiVersion");
  });

  it("rejects a goal whose aggregate serialized contract exceeds the ledger budget", () => {
    const description = "x".repeat(4096);
    const criteria = Array.from(
      { length: 64 },
      (_, index) => `
    - id: criterion-${index}
      description: ${JSON.stringify(description)}
      verifier: { nodeId: verify }
`,
    ).join("");
    const source = workflowWithGoalAndNodes(goalWithCriteria(criteria), singleVerifierNode());

    expectCompilationFailure(source, "invalid_schema", "goal");
  });

  it("rejects a criterion that references an unknown verifier", () => {
    const source = workflowWithGoalAndNodes(
      goalWithCriteria(`
    - id: tests-pass
      description: Tests pass.
      verifier: { nodeId: absent }
`),
      singleVerifierNode(),
    );

    expectCompilationFailure(
      source,
      "unknown_criterion_verifier",
      "goal.criteria.0.verifier.nodeId",
    );
  });

  it("rejects an agent node as a criterion verifier", () => {
    const source = workflowWithGoalAndNodes(
      goalWithCriteria(`
    - id: analysis-complete
      description: Analysis is complete.
      verifier: { nodeId: analyze }
`),
      `
  - id: analyze
    type: agent
    agent:
      prompt: Analyze the repository.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`,
    );

    expectCompilationFailure(
      source,
      "criterion_verifier_requires_command",
      "goal.criteria.0.verifier.nodeId",
    );
  });

  it("rejects a non-terminal command as a criterion verifier", () => {
    const source = workflowWithGoalAndNodes(
      goalWithCriteria(`
    - id: early-check
      description: The final state is verified.
      verifier: { nodeId: prepare }
`),
      `
  - id: prepare
    type: command
    command: { executable: node, args: [--version] }
  - id: final
    type: command
    dependsOn: [prepare]
    command: { executable: npm, args: [test] }
`,
    );

    expectCompilationFailure(
      source,
      "criterion_verifier_requires_terminal",
      "goal.criteria.0.verifier.nodeId",
    );
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

  it("compiles an immutable provider-neutral run budget", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: budgeted-workflow
budget:
  maxNodeStarts: 4
  maxModelTokens: 250000
  maxCostUsd: 2.5
  maxExecutionMs: 900000
nodes:
  - id: verify
    type: command
    command: { executable: npm, args: [test] }
`);

    expect(workflow.budget).toEqual({
      maxNodeStarts: 4,
      maxModelTokens: 250000,
      maxCostUsdMicros: 2500000,
      maxExecutionMs: 900000,
    });
    expect(Object.isFrozen(workflow.budget)).toBe(true);
  });

  it.each([
    ["empty declaration", "{}", "budget"],
    ["unknown field", "{ maxNodeStarts: 1, maxRequests: 2 }", "budget"],
    ["zero node starts", "{ maxNodeStarts: 0 }", "budget.maxNodeStarts"],
    ["fractional node starts", "{ maxNodeStarts: 1.5 }", "budget.maxNodeStarts"],
    ["unsafe model token count", "{ maxModelTokens: 9007199254740992 }", "budget.maxModelTokens"],
    ["negative active duration", "{ maxExecutionMs: -1 }", "budget.maxExecutionMs"],
    ["imprecise cost", "{ maxCostUsd: 0.0000001 }", "budget.maxCostUsd"],
    ["non-finite cost", "{ maxCostUsd: .inf }", "budget.maxCostUsd"],
  ])("rejects a run budget with %s", (_case, budget, path) => {
    const source = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: invalid-budget
budget: ${budget}
nodes:
  - id: verify
    type: command
    command: { executable: npm, args: [test] }
`;

    expectCompilationFailure(source, "invalid_schema", path);
  });

  it("compiles a required command approval with a bounded default grant lifetime", () => {
    const workflow = compileWorkflowText(
      workflowWithNodes(`
  - id: verify
    type: command
    approval: { mode: required }
    command: { executable: node, args: [--version] }
`),
    );

    expect(workflow.nodes[0]).toMatchObject({
      id: "verify",
      type: "command",
      approval: { mode: "required", grantTtlMs: 300000 },
    });
    const node = workflow.nodes[0];
    expect(node?.type).toBe("command");
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node?.type === "command" ? node.approval : undefined)).toBe(true);
  });

  it("preserves an explicit command approval grant lifetime", () => {
    const workflow = compileWorkflowText(
      workflowWithNodes(`
  - id: verify
    type: command
    approval:
      mode: required
      grantTtlMs: 60000
    command: { executable: node, args: [--version] }
`),
    );

    expect(workflow.nodes[0]).toMatchObject({
      approval: { mode: "required", grantTtlMs: 60000 },
    });
  });

  it.each([
    ["unsupported mode", "approval: { mode: prompt }", "nodes.0.approval.mode"],
    ["zero lifetime", "approval: { mode: required, grantTtlMs: 0 }", "nodes.0.approval.grantTtlMs"],
    [
      "oversized lifetime",
      "approval: { mode: required, grantTtlMs: 86400001 }",
      "nodes.0.approval.grantTtlMs",
    ],
    [
      "unknown field",
      "approval: { mode: required, grantTtlMs: 1000, bypass: true }",
      "nodes.0.approval",
    ],
  ])("rejects command approval with an %s", (_case, approval, path) => {
    const source = workflowWithNodes(`
  - id: verify
    type: command
    ${approval}
    command: { executable: node, args: [--version] }
`);

    expectCompilationFailure(source, "invalid_schema", path);
  });

  it("rejects approval declarations on agent nodes", () => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    approval: { mode: required }
    agent:
      prompt: Analyze the repository.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    expectCompilationFailure(source, "invalid_schema", "nodes.0");
  });

  it.each([
    ["executable", 'command: { executable: "node\\0shim", args: [] }'],
    ["argument", 'command: { executable: node, args: ["value\\0suffix"] }'],
  ])("rejects a NUL byte in a command %s", (_field, command) => {
    const source = workflowWithNodes(`
  - id: verify
    type: command
    ${command}
`);

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

  it("rejects agent tools outside the Flow-owned allowlist", () => {
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

  it("accepts an agent node with the hash-anchored edit tool explicitly declared", () => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Analyze the repository and report the relevant files.
      model:
        provider: anthropic
        id: claude-sonnet-4-5
        thinking: medium
      tools: [read, ls, edit]
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
        tools: ["read", "ls", "edit"],
        timeoutMs: 300000,
      },
    });
  });

  it("rejects duplicate agent tool declarations", () => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Edit the repository.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [read, edit, edit]
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    expectCompilationFailure(source, "invalid_schema", "nodes.0.agent.tools");
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

function workflowWithGoalAndNodes(goal: string, nodes: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: compiler-test
${goal}
nodes:
${nodes}`;
}

function goalWithCriteria(criteria: string): string {
  return `goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata:
    id: verified-change
  outcome: The change is accepted from deterministic evidence.
  criteria:
${criteria}`;
}

function singleVerifierNode(): string {
  return `
  - id: verify
    type: command
    command: { executable: npm, args: [test] }
`;
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
