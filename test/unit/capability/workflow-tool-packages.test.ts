import { describe, expect, it } from "vitest";

import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import type { ToolPackageSnapshotInput } from "../../../src/domain/capability/tool-packages.js";
import {
  bindWorkflowCapabilities,
  collectWorkflowToolPackageReferences,
  resolveAgentToolPackages,
  type WorkflowCapabilityError,
} from "../../../src/domain/capability/workflow-capabilities.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("workflow tool package binding", () => {
  it("collects exact references recursively and binds a mixed immutable snapshot", () => {
    const child = workflowSource(
      "child",
      `
  - id: child-agent
    type: agent
    agent:
      prompt: Summarize Git.
      model: { provider: test, id: deterministic }
      toolPackages: [{ name: git-summary, version: 2.0.0 }]
  - id: publish
    type: result
    dependsOn: [child-agent]
    result:
      source: { nodeId: child-agent, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`,
    );
    const workflow = compileWorkflowText(
      workflowSource(
        "root",
        `
  - id: root-agent
    type: agent
    agent:
      prompt: Produce a report.
      model: { provider: test, id: deterministic }
      toolPackages: [{ name: project-report, version: 1.2.3 }]
  - id: child
    type: child
    dependsOn: [root-agent]
    child:
      resultNodeId: publish
      workflow: |${indent(child, 8)}
`,
      ),
    );
    const snapshot = createCapabilitySnapshot(
      [],
      [],
      [
        toolPackage("git-summary", "2.0.0", "git_summary"),
        toolPackage("project-report", "1.2.3", "project_report"),
      ],
    );

    expect(collectWorkflowToolPackageReferences(workflow)).toEqual([
      { name: "git-summary", version: "2.0.0" },
      { name: "project-report", version: "1.2.3" },
    ]);
    expect(bindWorkflowCapabilities(workflow, snapshot)).toEqual(snapshot);
  });

  it("resolves only the exact tools selected by one agent in declaration order", () => {
    const workflow = agentWorkflow([
      { name: "project-report", version: "1.2.3" },
      { name: "git-summary", version: "2.0.0" },
    ]);
    const snapshot = createCapabilitySnapshot(
      [],
      [],
      [
        toolPackage("git-summary", "2.0.0", "git_summary"),
        toolPackage("project-report", "1.2.3", "project_report"),
      ],
    );
    const node = workflow.nodes[0];
    if (node?.type !== "agent") {
      throw new Error("agent fixture did not compile");
    }

    const selected = resolveAgentToolPackages(node, snapshot);

    expect(selected.map((item) => item.name)).toEqual(["project-report", "git-summary"]);
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it.each([
    {
      label: "missing snapshot",
      snapshot: undefined,
      code: "missing_snapshot" as const,
    },
    {
      label: "missing package",
      snapshot: createCapabilitySnapshot([], [], [toolPackage("other", "1.0.0", "other_tool")]),
      code: "missing_package" as const,
    },
    {
      label: "version mismatch",
      snapshot: createCapabilitySnapshot(
        [],
        [],
        [toolPackage("project-report", "1.2.4", "project_report")],
      ),
      code: "version_mismatch" as const,
    },
  ])("rejects a $label", ({ snapshot, code }) => {
    const workflow = agentWorkflow([{ name: "project-report", version: "1.2.3" }]);

    expect(() => bindWorkflowCapabilities(workflow, snapshot)).toThrowError(
      expect.objectContaining<Partial<WorkflowCapabilityError>>({ code }),
    );
  });

  it("rejects unselected packages and selected provider-tool name collisions", () => {
    const empty = agentWorkflow([]);
    const unexpected = createCapabilitySnapshot(
      [],
      [],
      [toolPackage("project-report", "1.2.3", "project_report")],
    );
    expect(() => bindWorkflowCapabilities(empty, unexpected)).toThrowError(
      expect.objectContaining<Partial<WorkflowCapabilityError>>({ code: "unexpected_package" }),
    );

    const workflow = agentWorkflow([
      { name: "project-report", version: "1.2.3" },
      { name: "git-summary", version: "2.0.0" },
    ]);
    const colliding = createCapabilitySnapshot(
      [],
      [],
      [
        toolPackage("project-report", "1.2.3", "project_report"),
        toolPackage("git-summary", "2.0.0", "project_report"),
      ],
    );

    expect(() => bindWorkflowCapabilities(workflow, colliding)).toThrowError(
      expect.objectContaining<Partial<WorkflowCapabilityError>>({ code: "tool_name_collision" }),
    );
  });

  it("rejects conflicting versions of one package across a workflow tree", () => {
    const workflow = compileWorkflowText(
      workflowSource(
        "conflict",
        `
  - id: first
    type: agent
    agent:
      prompt: First.
      model: { provider: test, id: deterministic }
      toolPackages: [{ name: project-report, version: 1.2.3 }]
  - id: second
    type: agent
    dependsOn: [first]
    agent:
      prompt: Second.
      model: { provider: test, id: deterministic }
      toolPackages: [{ name: project-report, version: 1.2.4 }]
  - id: verify
    type: command
    dependsOn: [second]
    command: { executable: node }
`,
      ),
    );

    expect(() => collectWorkflowToolPackageReferences(workflow)).toThrowError(
      expect.objectContaining<Partial<WorkflowCapabilityError>>({ code: "conflicting_package" }),
    );
  });
});

function agentWorkflow(references: readonly { readonly name: string; readonly version: string }[]) {
  return compileWorkflowText(
    workflowSource(
      "agent-tools",
      `
  - id: agent
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: test, id: deterministic }
      ${references.length === 0 ? "" : `toolPackages: [${references.map((item) => `{ name: ${item.name}, version: ${item.version} }`).join(", ")}]`}
  - id: verify
    type: command
    dependsOn: [agent]
    command: { executable: node }
`,
    ),
  );
}

function toolPackage(name: string, version: string, toolName: string): ToolPackageSnapshotInput {
  const definition: ToolPackageSnapshotInput["definition"] = {
    tool: {
      name: toolName,
      description: `Run ${toolName}.`,
      inputs: [{ name: "path", description: "Path to inspect.", type: "string" }],
    },
    driver: {
      kind: "command",
      version: "v1",
      profile: "posix-printf-v1",
      executable: "/usr/bin/printf",
      args: ["%s", "{input:path}"],
      timeoutMs: 10_000,
    },
    permissions: ["process.execute"],
  };
  return {
    kind: "tool-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name,
    version,
    description: `Reusable ${name} tool.`,
    trust: "project-explicit",
    provenance: `.flow/tools/${name}`,
    definition,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata: { name: ${name}, version: ${version}, description: Reusable ${name} tool. }
spec:
  tool:
    name: ${toolName}
    description: Run ${toolName}.
    inputs: [{ name: path, description: Path to inspect., type: string }]
  driver:
    kind: command
    version: v1
    profile: posix-printf-v1
    executable: /usr/bin/printf
    args: ["%s", "{input:path}"]
    timeoutMs: 10000
  permissions: [process.execute]
`),
    },
  };
}

function workflowSource(id: string, nodes: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 16
  maxModelTokens: 100000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 1000000
nodes:
${nodes}
`;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return `\n${value
    .trimEnd()
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n")}`;
}
