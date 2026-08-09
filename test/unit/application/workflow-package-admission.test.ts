import { describe, expect, it, vi } from "vitest";
import {
  admitWorkflowPackages,
  compileWorkflowFromSnapshot,
  createSnapshotWorkflowPackageResolver,
} from "../../../src/application/workflow-package-admission.js";
import { createPromptActivationSnapshot } from "../../../src/domain/adaptation/prompt-activation.js";
import {
  type CapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  createWorkflowPackageSnapshot,
  type WorkflowPackageSnapshot,
} from "../../../src/domain/capability/workflow-packages.js";
import {
  projectedPromptActivationSource,
  promptActivationInput,
} from "../../fixtures/prompt-activation.js";

describe("workflow package admission", () => {
  it("captures a transitive exact package set and recompiles from snapshot bytes", async () => {
    const first = packageSnapshot("first", packagedChildWorkflow("first", "second"));
    const second = packageSnapshot("second", childWorkflow("second"));
    const available = new Map([
      ["first@1.0.0", first],
      ["second@1.0.0", second],
    ]);
    const loadPackage = vi.fn(async ({ name, version }: { name: string; version: string }) => {
      const snapshot = available.get(`${name}@${version}`);
      if (snapshot === undefined) {
        throw new Error("missing fixture");
      }
      return snapshot;
    });

    const admitted = await admitWorkflowPackages({
      source: { kind: "inline", content: parentWorkflow("first"), sourceName: "parent.yaml" },
      loadPackage,
    });

    expect(loadPackage.mock.calls.map(([reference]) => reference)).toEqual([
      { name: "first", version: "1.0.0" },
      { name: "second", version: "1.0.0" },
    ]);
    expect(
      admitted.capabilitySnapshot?.packages.map(
        (item) => `${item.name}@${"version" in item ? item.version : ""}`,
      ),
    ).toEqual(["first@1.0.0", "second@1.0.0"]);
    const firstChild = admitted.workflow.nodes[0];
    if (firstChild?.type !== "child") {
      throw new Error("expected the root package fixture to compile as a child");
    }
    expect(firstChild.child.workflow.sourcePackage).toEqual({
      name: "first",
      version: "1.0.0",
      digest: first.digest,
    });
    const secondChild = firstChild.child.workflow.nodes[0];
    if (secondChild?.type !== "child") {
      throw new Error("expected the transitive package fixture to compile as a child");
    }
    expect(secondChild.child.workflow.sourcePackage).toEqual({
      name: "second",
      version: "1.0.0",
      digest: second.digest,
    });
    expect(() =>
      createSnapshotWorkflowPackageResolver(admitted.capabilitySnapshot).resolve({
        name: "unselected",
        version: "1.0.0",
      }),
    ).toThrow(/does not contain/i);
  });

  it("keeps an inline workflow without package references byte-compatible", async () => {
    const loadPackage = vi.fn();

    const admitted = await admitWorkflowPackages({
      source: {
        kind: "inline",
        content: childWorkflow("standalone"),
        sourceName: "standalone.yaml",
      },
      loadPackage,
    });

    expect(admitted.capabilitySnapshot).toBeUndefined();
    expect(admitted.rootPackage).toBeUndefined();
    expect(loadPackage).not.toHaveBeenCalled();
    expect(admitted.workflow).not.toHaveProperty("sourcePackage");
  });

  it("binds a packaged root and detects a package self-cycle without live fallback", async () => {
    const root = packageSnapshot("root-flow", parentWorkflow("root-flow"));
    const loadPackage = vi.fn();

    await expect(
      admitWorkflowPackages({ source: { kind: "package", snapshot: root }, loadPackage }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "workflow_package_cycle" }),
      ]),
    });
    expect(loadPackage).not.toHaveBeenCalled();
  });

  it("recompiles a locator-named root from exact detached snapshot bytes", () => {
    const root = packageSnapshot("root-flow", childWorkflow("root-flow"));
    const capabilitySnapshot = snapshotOf(root);

    const compiled = compileWorkflowFromSnapshot({
      source: childWorkflow("root-flow").trim(),
      sourceName: "workflow:root-flow@1.0.0",
      capabilitySnapshot,
    });

    expect(compiled.sourcePackage).toEqual({
      name: "root-flow",
      version: "1.0.0",
      digest: root.digest,
    });
    expect(() =>
      compileWorkflowFromSnapshot({
        source: childWorkflow("different").trim(),
        sourceName: "workflow:root-flow@1.0.0",
        capabilitySnapshot,
      }),
    ).toThrow(/source.*manifest|does not match/i);
  });

  it("requires exact activation evidence for an activation locator", () => {
    const activation = createPromptActivationSnapshot(promptActivationInput());
    const capabilitySnapshot = activationSnapshot(activation);

    expect(
      compileWorkflowFromSnapshot({
        source: projectedPromptActivationSource,
        sourceName: "activation:adaptive-workflow",
        capabilitySnapshot,
      }).id,
    ).toBe("adaptive-workflow");
    expect(() =>
      compileWorkflowFromSnapshot({
        source: projectedPromptActivationSource,
        sourceName: "activation:adaptive-workflow",
      }),
    ).toThrow(/does not contain.*activation/i);
    expect(() =>
      compileWorkflowFromSnapshot({
        source: projectedPromptActivationSource.replace("verify", "publish"),
        sourceName: "activation:adaptive-workflow",
        capabilitySnapshot,
      }),
    ).toThrow(/source does not match/i);
  });
});

function activationSnapshot(
  activation: ReturnType<typeof createPromptActivationSnapshot>,
): CapabilitySnapshot {
  return validateCapabilitySnapshot({
    version: 1,
    packages: [],
    activations: [activation],
    digest: calculateCapabilitySnapshotDigest([], [activation]),
  });
}

function snapshotOf(root: WorkflowPackageSnapshot): CapabilitySnapshot {
  return validateCapabilitySnapshot({
    version: 1,
    packages: [root],
    digest: calculateCapabilitySnapshotDigest([root]),
  });
}

function packageSnapshot(name: string, workflow: string): WorkflowPackageSnapshot {
  const indented = workflow
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return createWorkflowPackageSnapshot({
    kind: "workflow-package",
    trust: "project-explicit",
    provenance: `.flow/workflows/${name}`,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata:
  name: ${name}
  version: 1.0.0
  description: Reusable ${name} workflow.
spec:
  workflow: |-
${indented}
`),
    },
  });
}

function parentWorkflow(packageName: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: parent }
budget:
  maxNodeStarts: 32
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
nodes:
  - id: nested
    type: child
    child:
      resultNodeId: publish
      package: { name: ${packageName}, version: 1.0.0 }
`;
}

function packagedChildWorkflow(id: string, packageName: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 16
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 10000
nodes:
  - id: nested
    type: child
    child:
      resultNodeId: publish
      package: { name: ${packageName}, version: 1.0.0 }
  - id: publish
    type: result
    dependsOn: [nested]
    result:
      source: { nodeId: nested, field: result.value }
      schema: { type: boolean }
`;
}

function childWorkflow(id: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 8
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 10000
nodes:
  - id: produce
    type: command
    command: { executable: /usr/bin/true }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
`;
}
