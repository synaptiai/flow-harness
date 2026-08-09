import { describe, expect, it } from "vitest";

import {
  type AgentSkillPackageSnapshotInput,
  createCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import type { VerifierPackageSnapshotInput } from "../../../src/domain/capability/verifier-packages.js";
import type { WorkflowPackageSnapshotInput } from "../../../src/domain/capability/workflow-packages.js";
import {
  bindWorkflowCapabilities,
  collectWorkflowAgentSkillNames,
  collectWorkflowPackageReferences,
  collectWorkflowVerifierPackageReferences,
  resolveVerifierPackageNode,
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

    expect(bindWorkflowCapabilities(workflow, snapshot)).toEqual(snapshot);
  });

  it("allows a child workflow to bind its declared subset from the parent snapshot", () => {
    const child = skilledWorkflow(["testing"]);
    const parentSnapshot = createCapabilitySnapshot([skill("review"), skill("testing")]);

    expect(bindWorkflowCapabilities(child, parentSnapshot, { allowUnexpected: true })).toEqual(
      parentSnapshot,
    );
  });

  it("preserves no-skills behavior without requiring or returning a snapshot", () => {
    const workflow = skilledWorkflow([]);

    expect(bindWorkflowCapabilities(workflow)).toBeUndefined();
  });

  it("collects and digest-binds a packaged root to its immutable snapshot", () => {
    const input = workflowPackage("release-check", "1.0.0");
    const snapshot = createCapabilitySnapshot([], [], [], [input]);
    const selected = snapshot.packages[0];
    if (selected?.kind !== "workflow-package") {
      throw new Error("workflow package fixture was not created");
    }
    const workflow = compileWorkflowText(
      workflowSource("release-check", terminalCommand()),
      "workflow",
      {
        sourcePackage: {
          name: selected.name,
          version: selected.version,
          digest: selected.digest,
        },
      },
    );

    expect(collectWorkflowPackageReferences(workflow)).toEqual([
      { name: "release-check", version: "1.0.0", digest: selected.digest },
    ]);
    expect(bindWorkflowCapabilities(workflow, snapshot)).toEqual(snapshot);

    const forged = compileWorkflowText(
      workflowSource("release-check", terminalCommand()),
      "workflow",
      {
        sourcePackage: { name: "release-check", version: "1.0.0", digest: "0".repeat(64) },
      },
    );
    expect(() => bindWorkflowCapabilities(forged, snapshot)).toThrowError(
      expect.objectContaining<Partial<WorkflowCapabilityError>>({ code: "digest_mismatch" }),
    );
  });

  it("classifies an unselected verifier package as an unexpected package", () => {
    const workflow = skilledWorkflow([]);
    const snapshot = createCapabilitySnapshot(
      [],
      [
        verifierPackage("release-tests", "1.0.0", {
          kind: "command",
          command: { executable: "node", args: ["--version"], timeoutMs: 30_000 },
        }),
      ],
    );

    expect(() => bindWorkflowCapabilities(workflow, snapshot)).toThrowError(
      expect.objectContaining<Partial<WorkflowCapabilityError>>({ code: "unexpected_package" }),
    );
  });

  it("rejects an invalid snapshot before capability selection", () => {
    const workflow = skilledWorkflow(["review"]);
    const snapshot = createCapabilitySnapshot([skill("review")]);
    const invalid = { ...snapshot, digest: "0".repeat(64) };

    expect(() => bindWorkflowCapabilities(workflow, invalid)).toThrowError(
      expect.objectContaining<Partial<WorkflowCapabilityError>>({ code: "invalid_snapshot" }),
    );
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

  it("collects exact verifier references recursively and binds a mixed capability snapshot", () => {
    const childSource = workflowSource(
      "package-child",
      `
  - id: verify-child
    type: verifier
    verifier:
      kind: packaged-command
      package: { name: release-tests, version: 1.0.0 }
  - id: publish
    type: result
    dependsOn: [verify-child]
    result:
      source: { nodeId: verify-child, field: verifier.reason }
      schema: { type: string, maxLength: 1024 }
`,
    );
    const workflow = compileWorkflowText(
      workflowSource(
        "package-root",
        `
  - id: prepare
    type: command
    command: { executable: node }
  - id: review
    type: verifier
    dependsOn: [prepare]
    verifier:
      kind: packaged-model
      package: { name: evidence-review, version: 1.2.0 }
      evidence: [{ nodeId: prepare, field: command.stdout }]
      model: { provider: test, id: deterministic }
  - id: child
    type: child
    dependsOn: [review]
    child:
      resultNodeId: publish
      workflow: |${indent(childSource, 8)}
`,
      ),
    );
    const snapshot = createCapabilitySnapshot(
      [],
      [
        verifierPackage("release-tests", "1.0.0", {
          kind: "command",
          command: { executable: "node", args: ["--version"], timeoutMs: 30_000 },
        }),
        verifierPackage("evidence-review", "1.2.0", {
          kind: "model",
          prompt: "Reject unsupported claims.",
        }),
      ],
    );

    expect(collectWorkflowVerifierPackageReferences(workflow)).toEqual([
      { name: "evidence-review", version: "1.2.0", kind: "model" },
      { name: "release-tests", version: "1.0.0", kind: "command" },
    ]);
    expect(bindWorkflowCapabilities(workflow, snapshot)).toEqual(snapshot);
  });

  it("resolves a packaged model into the ordinary verifier driver and exact use evidence", () => {
    const workflow = compileWorkflowText(
      workflowSource(
        "resolve-package",
        `
  - id: prepare
    type: command
    command: { executable: node }
  - id: review
    type: verifier
    dependsOn: [prepare]
    verifier:
      kind: packaged-model
      package: { name: evidence-review, version: 1.2.0 }
      evidence: [{ nodeId: prepare, field: command.stdout }]
      model: { provider: test, id: deterministic }
      timeoutMs: 120000
`,
      ),
    );
    const snapshot = createCapabilitySnapshot(
      [],
      [
        verifierPackage("evidence-review", "1.2.0", {
          kind: "model",
          prompt: "Reject unsupported claims.",
        }),
      ],
    );
    const node = workflow.nodes.find((item) => item.id === "review");
    if (node?.type !== "verifier") {
      throw new Error("verifier fixture was not compiled");
    }

    const resolved = resolveVerifierPackageNode(node, snapshot);

    expect(resolved.node.verifier).toEqual({
      kind: "model",
      prompt: "Reject unsupported claims.",
      evidence: [{ nodeId: "prepare", field: "command.stdout" }],
      model: { provider: "test", id: "deterministic", thinking: "medium" },
      timeoutMs: 120_000,
    });
    expect(resolved.package).toEqual({
      name: "evidence-review",
      version: "1.2.0",
      digest: snapshot.packages[0]?.digest,
    });
  });

  it("resolves the exact verifier version when a parent snapshot carries another version", () => {
    const workflow = packagedModelWorkflow("1.3.0");
    const snapshot = createCapabilitySnapshot(
      [],
      [
        verifierPackage("evidence-review", "1.2.0", {
          kind: "model",
          prompt: "Review using the old rubric.",
        }),
        verifierPackage("evidence-review", "1.3.0", {
          kind: "model",
          prompt: "Review using the selected rubric.",
        }),
      ],
    );
    const bound = bindWorkflowCapabilities(workflow, snapshot, { allowUnexpected: true });
    const node = workflow.nodes.find((item) => item.id === "review");
    if (node?.type !== "verifier") {
      throw new Error("verifier fixture was not compiled");
    }

    const resolved = resolveVerifierPackageNode(node, bound);

    expect(resolved.node.verifier).toMatchObject({
      kind: "model",
      prompt: "Review using the selected rubric.",
    });
    expect(resolved.package).toMatchObject({ name: "evidence-review", version: "1.3.0" });
  });

  it.each([
    {
      label: "missing package",
      workflowVersion: "1.2.0",
      input: [] as VerifierPackageSnapshotInput[],
      code: "missing_package" as const,
    },
    {
      label: "version mismatch",
      workflowVersion: "1.2.0",
      input: [
        verifierPackage("evidence-review", "1.3.0", {
          kind: "model",
          prompt: "Review.",
        }),
      ],
      code: "version_mismatch" as const,
    },
    {
      label: "kind mismatch",
      workflowVersion: "1.2.0",
      input: [
        verifierPackage("evidence-review", "1.2.0", {
          kind: "command",
          command: { executable: "node", args: [], timeoutMs: 30_000 },
        }),
      ],
      code: "package_kind_mismatch" as const,
    },
  ])("rejects a verifier $label before execution", ({ workflowVersion, input, code }) => {
    const workflow = packagedModelWorkflow(workflowVersion);
    const snapshot =
      input.length === 0
        ? createCapabilitySnapshot([skill("unrelated")])
        : createCapabilitySnapshot([], input);

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

function verifierPackage(
  name: string,
  version: string,
  definition: VerifierPackageSnapshotInput["definition"],
): VerifierPackageSnapshotInput {
  const spec =
    definition.kind === "command"
      ? `kind: command
  command:
    executable: ${definition.command.executable}
    args: [${definition.command.args.join(", ")}]
    timeoutMs: ${definition.command.timeoutMs}`
      : `kind: model
  prompt: ${definition.prompt}`;
  return {
    kind: "verifier-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name,
    version,
    description: `Reusable ${name} verifier.`,
    trust: "project-explicit",
    provenance: `.flow/verifiers/${name}`,
    definition,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: ${name}, version: ${version}, description: Reusable ${name} verifier. }
spec:
  ${spec}
`),
    },
  };
}

function workflowPackage(name: string, version: string): WorkflowPackageSnapshotInput {
  const workflow = workflowSource(name, terminalCommand());
  const indented = workflow
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return {
    kind: "workflow-package",
    trust: "project-explicit",
    provenance: `.flow/workflows/${name}`,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata: { name: ${name}, version: ${version}, description: Reusable ${name} workflow. }
spec:
  workflow: |-
${indented}
`),
    },
  };
}

function terminalCommand(): string {
  return `
  - id: finish
    type: command
    command: { executable: /usr/bin/true }
`;
}

function packagedModelWorkflow(version: string) {
  return compileWorkflowText(
    workflowSource(
      "package-binding",
      `
  - id: prepare
    type: command
    command: { executable: node }
  - id: review
    type: verifier
    dependsOn: [prepare]
    verifier:
      kind: packaged-model
      package: { name: evidence-review, version: ${version} }
      evidence: [{ nodeId: prepare, field: command.stdout }]
      model: { provider: test, id: deterministic }
`,
    ),
  );
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
