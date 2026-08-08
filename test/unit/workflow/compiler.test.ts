import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  compileWorkflowText,
  WorkflowCompilationError,
} from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";

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
    "agent-command.workflow.yaml",
    "approval-gated-command.workflow.yaml",
    "concurrent-fork.workflow.yaml",
    "isolated-child.workflow.yaml",
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

  it("compiles an immutable bounded node-concurrency contract", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: concurrent-workflow
concurrency:
  maxNodes: 4
nodes:
  - id: verify
    type: command
    command: { executable: npm, args: [test] }
`);

    expect(workflow.concurrency).toEqual({ maxNodes: 4 });
    expect(Object.isFrozen(workflow.concurrency)).toBe(true);
  });

  it("preserves the legacy compiled shape when concurrency is omitted", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: sequential-workflow
nodes:
  - id: verify
    type: command
    command: { executable: npm, args: [test] }
`);

    expect("concurrency" in workflow).toBe(false);
  });

  it.each([
    ["empty declaration", "{}", "concurrency.maxNodes"],
    ["unknown field", "{ maxNodes: 2, maxAgents: 1 }", "concurrency"],
    ["zero", "{ maxNodes: 0 }", "concurrency.maxNodes"],
    ["fractional", "{ maxNodes: 1.5 }", "concurrency.maxNodes"],
    ["over the hard cap", "{ maxNodes: 33 }", "concurrency.maxNodes"],
  ])("rejects node concurrency with %s", (_case, concurrency, path) => {
    const source = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: invalid-concurrency
concurrency: ${concurrency}
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

  it("compiles an immutable explicit agent exec selection", () => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Run the repository checks and report the evidence.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [read, ls, edit, exec]
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    const workflow = compileWorkflowText(source, "agent-exec.workflow.yaml");
    const node = workflow.nodes[0];

    expect(node).toMatchObject({
      type: "agent",
      agent: { tools: ["read", "ls", "edit", "exec"] },
    });
    expect(node?.type === "agent" && Object.isFrozen(node.agent.tools)).toBe(true);
  });

  it("compiles and digest-binds immutable per-call agent exec approval", () => {
    const approvedSource = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Run the repository checks after operator approval.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [read, exec]
      toolApproval:
        exec: { mode: required }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);
    const unapprovedSource = approvedSource.replace(
      "      toolApproval:\n        exec: { mode: required }\n",
      "",
    );

    const approved = compileWorkflowText(approvedSource, "agent-exec-approval.workflow.yaml");
    const unapproved = compileWorkflowText(unapprovedSource);
    const node = approved.nodes[0];

    expect(node).toMatchObject({
      type: "agent",
      agent: {
        toolApproval: { exec: { mode: "required", grantTtlMs: 300000 } },
      },
    });
    expect(node?.type === "agent" && Object.isFrozen(node.agent.toolApproval?.exec)).toBe(true);
    expect(calculateWorkflowDigest(approved)).not.toBe(calculateWorkflowDigest(unapproved));
  });

  it("keeps agent tool approval absent unless the workflow explicitly opts in", () => {
    const workflow = compileWorkflowText(
      workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Run the repository checks without a human gate.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [exec]
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`),
    );
    const node = workflow.nodes[0];

    expect(node?.type).toBe("agent");
    expect(node?.type === "agent" ? node.agent.toolApproval : undefined).toBeUndefined();
  });

  it.each([
    {
      label: "approval without exec authority",
      tools: "[read]",
      approval: "exec: { mode: required }",
      field: "nodes.0.agent.toolApproval",
    },
    {
      label: "unsupported mode",
      tools: "[exec]",
      approval: "exec: { mode: allow }",
      field: "nodes.0.agent.toolApproval.exec.mode",
    },
    {
      label: "non-positive lifetime",
      tools: "[exec]",
      approval: "exec: { mode: required, grantTtlMs: 0 }",
      field: "nodes.0.agent.toolApproval.exec.grantTtlMs",
    },
    {
      label: "oversized lifetime",
      tools: "[exec]",
      approval: "exec: { mode: required, grantTtlMs: 86400001 }",
      field: "nodes.0.agent.toolApproval.exec.grantTtlMs",
    },
    {
      label: "unknown tool",
      tools: "[exec]",
      approval: "edit: { mode: required }",
      field: "nodes.0.agent.toolApproval",
    },
  ])("rejects per-call agent tool approval with $label", ({ tools, approval, field }) => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Run a governed command.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: ${tools}
      toolApproval:
        ${approval}
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    expectCompilationFailure(source, "invalid_schema", field);
  });

  it("compiles an immutable explicit Agent Skills selection", () => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Analyze the repository with the selected guidance.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [read]
      skills: [security-review, testing]
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    const workflow = compileWorkflowText(source, "skilled-agent.workflow.yaml");
    const agent = workflow.nodes[0];

    expect(agent).toMatchObject({
      type: "agent",
      agent: { tools: ["read"], skills: ["security-review", "testing"] },
    });
    expect(agent?.type === "agent" && Object.isFrozen(agent.agent.skills)).toBe(true);
  });

  it("keeps omission of Agent Skills equivalent to an empty selection", () => {
    const workflow = compileWorkflowText(
      workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Analyze without skills.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`),
    );

    expect(workflow.nodes[0]).toMatchObject({ type: "agent", agent: { skills: [] } });
  });

  it.each([
    {
      label: "selection without read authority",
      fragment: "tools: [ls]\n      skills: [testing]",
      field: "nodes.0.agent.skills",
    },
    {
      label: "duplicate selection",
      fragment: "tools: [read]\n      skills: [testing, testing]",
      field: "nodes.0.agent.skills",
    },
    {
      label: "invalid skill name",
      fragment: "tools: [read]\n      skills: [Testing]",
      field: "nodes.0.agent.skills.0",
    },
  ])("rejects Agent Skills $label", ({ fragment, field }) => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      ${fragment}
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    expectCompilationFailure(source, "invalid_schema", field);
  });

  it("compiles an immutable opt-in fresh recovery policy", () => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Analyze the repository and report the relevant files.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      recovery: { mode: fresh, maxAttempts: 3 }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    const workflow = compileWorkflowText(source, "fresh-recovery.workflow.yaml");
    const node = workflow.nodes[0];

    expect(node).toMatchObject({
      type: "agent",
      agent: { recovery: { mode: "fresh", maxAttempts: 3 } },
    });
    expect(Object.isFrozen(node?.type === "agent" ? node.agent.recovery : undefined)).toBe(true);
  });

  it("keeps fresh recovery absent unless the workflow explicitly opts in", () => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Analyze the repository.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    const workflow = compileWorkflowText(source);
    const node = workflow.nodes[0];

    expect(node?.type).toBe("agent");
    expect(node?.type === "agent" ? node.agent.recovery : undefined).toBeUndefined();
  });

  it("rejects fresh recovery for an agent with arbitrary command execution", () => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Run a command and recover if the session is interrupted.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [exec]
      recovery: { mode: fresh, maxAttempts: 2 }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    expectCompilationFailure(source, "invalid_schema", "nodes.0.agent.recovery");
  });

  it.each([
    ["unsupported mode", "{ mode: resume, maxAttempts: 2 }", "nodes.0.agent.recovery.mode"],
    ["one attempt", "{ mode: fresh, maxAttempts: 1 }", "nodes.0.agent.recovery.maxAttempts"],
    ["too many attempts", "{ mode: fresh, maxAttempts: 17 }", "nodes.0.agent.recovery.maxAttempts"],
    ["unknown field", "{ mode: fresh, maxAttempts: 2, delayMs: 1000 }", "nodes.0.agent.recovery"],
  ])("rejects fresh recovery with %s", (_case, recovery, path) => {
    const source = workflowWithNodes(`
  - id: analyze
    type: agent
    agent:
      prompt: Analyze the repository.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      recovery: ${recovery}
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);

    expectCompilationFailure(source, "invalid_schema", path);
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
