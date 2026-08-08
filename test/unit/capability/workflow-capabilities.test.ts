import { describe, expect, it } from "vitest";

import {
  createCapabilitySnapshot,
  type AgentSkillPackageSnapshotInput,
} from "../../../src/domain/capability/agent-skills.js";
import {
  bindWorkflowCapabilities,
  collectWorkflowAgentSkillNames,
  type WorkflowCapabilityError,
} from "../../../src/domain/capability/workflow-capabilities.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("workflow capability binding", () => {
  it("collects a unique sorted set recursively from root and child workflows", () => {
    const childSource = workflowSource(
      "child",
      `
  - id: child-agent
    type: agent
    agent:
      prompt: Test the child.
      model: { provider: anthropic, id: model }
      tools: [read]
      skills: [testing, shared]
  - id: publish
    type: result
    dependsOn: [child-agent]
    result:
      source: { nodeId: child-agent, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`,
    );
    const root = compileWorkflowText(
      workflowSource(
        "root",
        `
  - id: root-agent
    type: agent
    agent:
      prompt: Review the root.
      model: { provider: anthropic, id: model }
      tools: [read]
      skills: [shared, review]
  - id: child
    type: child
    dependsOn: [root-agent]
    child:
      resultNodeId: publish
      workflow: |${indent(childSource, 8)}
`,
      ),
    );

    expect(collectWorkflowAgentSkillNames(root)).toEqual(["review", "shared", "testing"]);
  });

  it("accepts exactly the immutable packages required by the workflow", () => {
    const workflow = skilledWorkflow(["review", "testing"]);
    const snapshot = createCapabilitySnapshot([skill("testing"), skill("review")]);

    expect(bindWorkflowCapabilities(workflow, snapshot)).toBe(snapshot);
  });

  it("allows a child workflow to bind its declared subset from the parent snapshot", () => {
    const child = skilledWorkflow(["testing"]);
    const parentSnapshot = createCapabilitySnapshot([skill("review"), skill("testing")]);

    expect(bindWorkflowCapabilities(child, parentSnapshot, { allowUnexpected: true })).toBe(
      parentSnapshot,
    );
  });

  it("preserves no-skills behavior without requiring or returning a snapshot", () => {
    const workflow = skilledWorkflow([]);

    expect(bindWorkflowCapabilities(workflow)).toBeUndefined();
  });

  it.each([
    {
      label: "missing snapshot",
      snapshot: undefined,
      code: "missing_snapshot" as const,
    },
    {
      label: "missing selected package",
      snapshot: createCapabilitySnapshot([skill("review")]),
      code: "missing_skill" as const,
    },
    {
      label: "unexpected package",
      snapshot: createCapabilitySnapshot([skill("review"), skill("testing"), skill("unused")]),
      code: "unexpected_skill" as const,
    },
  ])("fails closed for a $label", ({ snapshot, code }) => {
    const workflow = skilledWorkflow(["review", "testing"]);

    expect(() => bindWorkflowCapabilities(workflow, snapshot)).toThrowError(
      expect.objectContaining<Partial<WorkflowCapabilityError>>({ code }),
    );
  });
});

function skilledWorkflow(skills: readonly string[]) {
  return compileWorkflowText(
    workflowSource(
      "binding",
      `
  - id: agent
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: anthropic, id: model }
      tools: [read]
      ${skills.length === 0 ? "" : `skills: [${skills.join(", ")}]`}
  - id: verify
    type: command
    dependsOn: [agent]
    command: { executable: node, args: [--version] }
`,
    ),
  );
}

function skill(name: string): AgentSkillPackageSnapshotInput {
  return {
    kind: "agent-skill",
    name,
    description: `Use ${name} when the workflow explicitly selects it.`,
    metadata: { version: "1" },
    requestedTools: [],
    trust: "project-explicit",
    provenance: `.flow/skills/${name}`,
    files: [{ path: "SKILL.md", content: Buffer.from(`# ${name}\n`) }],
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
nodes:
${nodes}`;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return `\n${value
    .trimEnd()
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n")}`;
}
