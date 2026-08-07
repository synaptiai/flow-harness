import { describe, expect, it } from "vitest";

import {
  WorkflowCompilationError,
  compileWorkflowText,
} from "../../../src/domain/workflow/compiler.js";

describe("conditional control-flow compilation", () => {
  it("compiles immutable exact conditions, guarded branches, and an explicit join", () => {
    const workflow = compileWorkflowText(validControlWorkflow(), "conditional.workflow.yaml");

    expect(workflow.nodes).toHaveLength(7);
    expect(workflow.nodes[1]).toEqual({
      id: "route",
      type: "condition",
      dependsOn: ["classify"],
      condition: {
        source: { nodeId: "classify", field: "command.stdout" },
        cases: [{ id: "needs-work", equals: "needs-work\n" }],
        default: "already-clean",
      },
    });
    expect(workflow.nodes[2]).toMatchObject({
      id: "implement",
      when: { conditionId: "route", case: "needs-work" },
    });
    expect(workflow.nodes[5]).toEqual({
      id: "converge",
      type: "join",
      dependsOn: ["verify-change", "inspect-clean"],
      join: {
        conditionId: "route",
        branches: [
          { case: "needs-work", nodeId: "verify-change" },
          { case: "already-clean", nodeId: "inspect-clean" },
        ],
      },
    });
    expect(Object.isFrozen(workflow.nodes[1])).toBe(true);
    const guarded = workflow.nodes[2];
    expect(Object.isFrozen(guarded?.type === "join" ? undefined : guarded?.when)).toBe(true);
    expect(Object.isFrozen(workflow.nodes[5]?.dependsOn)).toBe(true);
    const join = workflow.nodes[5];
    expect(Object.isFrozen(join?.type === "join" ? join.join : undefined)).toBe(true);
    expect(Object.isFrozen(join?.type === "join" ? join.join.branches : undefined)).toBe(true);
  });

  it("keeps a legacy command node representation unchanged", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: legacy-shape }
nodes:
  - id: verify
    type: command
    command: { executable: npm, args: [test] }
`);

    expect(workflow.nodes[0]).toEqual({
      id: "verify",
      type: "command",
      dependsOn: [],
      command: { executable: "npm", args: ["test"], timeoutMs: 60000 },
    });
    expect("when" in (workflow.nodes[0] ?? {})).toBe(false);
  });

  it("rejects a control graph whose serialized run-start projection is too large", () => {
    expectCompilationFailure(oversizedControlWorkflow(), "control_graph_too_large", "nodes");
  });

  it.each([
    [
      "duplicate case identifiers",
      (source: string) =>
        source.replace(
          'cases:\n        - { id: needs-work, equals: "needs-work\\n" }',
          'cases:\n        - { id: duplicate, equals: "one" }\n        - { id: duplicate, equals: "two" }',
        ),
      "invalid_schema",
      "nodes.1.condition.cases",
    ],
    [
      "duplicate exact values",
      (source: string) =>
        source.replace(
          'cases:\n        - { id: needs-work, equals: "needs-work\\n" }',
          'cases:\n        - { id: first, equals: "same" }\n        - { id: second, equals: "same" }',
        ),
      "invalid_schema",
      "nodes.1.condition.cases",
    ],
    [
      "a default that duplicates an exact case",
      (source: string) => source.replace("default: already-clean", "default: needs-work"),
      "invalid_schema",
      "nodes.1.condition.default",
    ],
    [
      "an unknown condition source",
      (source: string) => source.replace("nodeId: classify", "nodeId: absent"),
      "condition_source_unknown",
      "nodes.1.condition.source.nodeId",
    ],
    [
      "a source outside the condition dependencies",
      (source: string) =>
        source.replace(
          "- id: route\n    type: condition\n    dependsOn: [classify]",
          "- id: middle\n    type: command\n    dependsOn: [classify]\n    command: { executable: node, args: [--version] }\n  - id: route\n    type: condition\n    dependsOn: [middle]",
        ),
      "condition_source_requires_dependency",
      "nodes.2.condition.source.nodeId",
    ],
    [
      "a source field incompatible with its node",
      (source: string) => source.replace("field: command.stdout", "field: agent.text"),
      "condition_source_field_mismatch",
      "nodes.1.condition.source.field",
    ],
    [
      "a guard that references a non-condition",
      (source: string) => source.replace("conditionId: route", "conditionId: classify"),
      "branch_guard_requires_condition",
      "nodes.2.when.conditionId",
    ],
    [
      "a condition outside guarded-node dependencies",
      (source: string) =>
        source.replace(
          "- id: implement\n    type: agent\n    dependsOn: [route]",
          "- id: implement\n    type: agent\n    dependsOn: [classify]",
        ),
      "branch_guard_requires_dependency",
      "nodes.2.when.conditionId",
    ],
    [
      "an unknown guarded case",
      (source: string) => source.replace("case: needs-work", "case: missing-case"),
      "branch_guard_unknown_case",
      "nodes.2.when.case",
    ],
  ])("rejects %s", (_name, mutate, code, path) => {
    expectCompilationFailure(mutate(validControlWorkflow()), code, path);
  });

  it("requires every condition case to have a guarded branch", () => {
    const source = validControlWorkflow().replace(
      `  - id: inspect-clean
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: already-clean }
    command: { executable: node, args: [--version] }
`,
      "",
    );

    expectCompilationFailure(source, "condition_case_requires_branch", "nodes.1.condition.default");
  });

  it("requires one explicit join for each condition", () => {
    const source = validControlWorkflow()
      .replace(
        `  - id: converge
    type: join
    join:
      conditionId: route
      branches:
        - { case: needs-work, nodeId: verify-change }
        - { case: already-clean, nodeId: inspect-clean }
`,
        "",
      )
      .replace("dependsOn: [converge]", "dependsOn: [verify-change, inspect-clean]");

    expectCompilationFailure(source, "condition_join_count", "nodes.1.condition");
  });

  it("requires a join to cover each case exactly once", () => {
    const source = validControlWorkflow().replace(
      "        - { case: already-clean, nodeId: inspect-clean }\n",
      "",
    );

    expectCompilationFailure(source, "join_case_coverage", "nodes.5.join.branches");
  });

  it("rejects a join terminal from the wrong condition case", () => {
    const source = validControlWorkflow().replace(
      "{ case: needs-work, nodeId: verify-change }",
      "{ case: needs-work, nodeId: inspect-clean }",
    );

    expectCompilationFailure(source, "join_branch_membership", "nodes.5.join.branches.0.nodeId");
  });

  it("rejects ordinary dependencies that cross condition cases", () => {
    const source = validControlWorkflow().replace(
      "dependsOn: [implement]",
      "dependsOn: [implement, inspect-clean]",
    );

    expectCompilationFailure(source, "branch_cross_dependency", "nodes.3.dependsOn");
  });

  it("rejects branch work that can bypass its mapped join terminal", () => {
    const source = validControlWorkflow().replace(
      "  - id: converge\n",
      `  - id: audit-change
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: needs-work }
    command: { executable: node, args: [--version] }
  - id: converge
`,
    );

    expectCompilationFailure(source, "join_branch_incomplete", "nodes.6.join.branches.0.nodeId");
  });

  it("includes derived join dependencies in cycle detection", () => {
    const source = validControlWorkflow().replace(
      "dependsOn: [implement]",
      "dependsOn: [implement, converge]",
    );

    expectCompilationFailure(source, "cycle", "nodes");
  });

  it("rejects a condition or join as the terminal verifier", () => {
    const source = validControlWorkflow().replace(
      `  - id: verify-final
    type: command
    dependsOn: [converge]
    command: { executable: npm, args: [test] }
`,
      "",
    );

    expectCompilationFailure(source, "terminal_requires_command", "nodes.5.type");
  });
});

function validControlWorkflow(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: conditional-control }
nodes:
  - id: classify
    type: command
    command: { executable: node, args: [scripts/classify.mjs] }
  - id: route
    type: condition
    dependsOn: [classify]
    condition:
      source: { nodeId: classify, field: command.stdout }
      cases:
        - { id: needs-work, equals: "needs-work\\n" }
      default: already-clean
  - id: implement
    type: agent
    dependsOn: [route]
    when: { conditionId: route, case: needs-work }
    agent:
      prompt: Implement the requested change.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
  - id: verify-change
    type: command
    dependsOn: [implement]
    command: { executable: npm, args: [test] }
  - id: inspect-clean
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: already-clean }
    command: { executable: node, args: [--version] }
  - id: converge
    type: join
    join:
      conditionId: route
      branches:
        - { case: needs-work, nodeId: verify-change }
        - { case: already-clean, nodeId: inspect-clean }
  - id: verify-final
    type: command
    dependsOn: [converge]
    command: { executable: npm, args: [test] }
`;
}

function oversizedControlWorkflow(): string {
  const exactValue = "x".repeat(65_536);
  const nodes: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const priorJoin = index === 0 ? undefined : `join-${index - 1}`;
    nodes.push(`  - id: source-${index}
    type: command
    ${priorJoin === undefined ? "" : `dependsOn: [${priorJoin}]\n    `}command: { executable: node, args: [source-${index}] }
  - id: route-${index}
    type: condition
    dependsOn: [source-${index}]
    condition:
      source: { nodeId: source-${index}, field: command.stdout }
      cases:
        - { id: matched, equals: ${JSON.stringify(exactValue)} }
      default: fallback
  - id: selected-${index}
    type: command
    dependsOn: [route-${index}]
    when: { conditionId: route-${index}, case: matched }
    command: { executable: node, args: [selected-${index}] }
  - id: fallback-${index}
    type: command
    dependsOn: [route-${index}]
    when: { conditionId: route-${index}, case: fallback }
    command: { executable: node, args: [fallback-${index}] }
  - id: join-${index}
    type: join
    join:
      conditionId: route-${index}
      branches:
        - { case: matched, nodeId: selected-${index} }
        - { case: fallback, nodeId: fallback-${index} }`);
  }
  nodes.push(`  - id: verify-final
    type: command
    dependsOn: [join-7]
    command: { executable: node, args: [verify-final] }`);
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: oversized-control }
nodes:
${nodes.join("\n")}
`;
}

function expectCompilationFailure(source: string, code: string, path: string): void {
  try {
    compileWorkflowText(source, "invalid-control.workflow.yaml");
    throw new Error("Expected workflow compilation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowCompilationError);
    if (!(error instanceof WorkflowCompilationError)) {
      return;
    }
    expect(error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, path })]),
    );
  }
}
