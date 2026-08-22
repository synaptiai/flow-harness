import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CAPABILITY_PACKAGE_FAMILY_REFERENCES } from "../../../src/domain/capability/capability-bundles.js";
import { EVALUATION_ADAPTER_REFERENCES } from "../../../src/domain/evaluation/plan.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import { AGENT_TOOL_NAMES } from "../../../src/domain/workflow/types.js";
import { createWorkspaceAgentTools } from "../../../src/infrastructure/pi/workspace-agent-tools.js";
import { PRODUCTION_AGENT_EXECUTOR_DESCRIPTOR } from "../../../src/infrastructure/runtime/production-node-executor.js";
import { createProductionPublicCapabilityCatalog } from "../../../src/infrastructure/runtime/production-public-capability-reference.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("production workspace-agent tool reference", () => {
  it("describes every closed production capability surface", () => {
    const catalog = createProductionPublicCapabilityCatalog();

    expect(catalog.tools.map((tool) => tool.selector)).toEqual([
      "artifact",
      "edit",
      "exec",
      "ls",
      "read",
      "semantic",
    ]);
    expect(catalog.capabilityFamilies.map((family) => family.kind)).toEqual([
      "agent-skill",
      "policy-package",
      "presentation-package",
      "tool-package",
      "verifier-package",
      "workflow-package",
    ]);
    expect(catalog.evaluationAdapters.map((adapter) => adapter.id)).toEqual([
      "flow-workflow-v1",
      "omp-native-v1",
      "pi-native-v1",
      "prime-agent-native-v1",
    ]);
    expect(catalog.executionSeams).toEqual([
      expect.objectContaining({ id: "model-provider", openness: "open", implementation: "pi" }),
    ]);
  });

  it("draws closed identifiers and the open provider seam from production registries", () => {
    const catalog = createProductionPublicCapabilityCatalog();

    expect(catalog.tools.map((tool) => tool.selector).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    expect(catalog.capabilityFamilies).toEqual(CAPABILITY_PACKAGE_FAMILY_REFERENCES);
    expect(catalog.evaluationAdapters).toEqual(EVALUATION_ADAPTER_REFERENCES);
    expect(catalog.executionSeams).toEqual([PRODUCTION_AGENT_EXECUTOR_DESCRIPTOR.reference]);
  });

  it("matches the final production-composed built-in tool surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-tool-reference-"));
    temporaryDirectories.push(root);
    const catalog = createProductionPublicCapabilityCatalog();
    const tools = await createWorkspaceAgentTools(
      root,
      ["read", "ls", "edit", "exec", "semantic", "artifact"],
      policyBroker(),
      {
        effectRecorder: {} as never,
        commandRecorder: {} as never,
        semanticSession: {} as never,
        artifactStore: {} as never,
      },
    );

    const actual = tools.definitions
      .map((definition) => ({
        selector: definition.name.replace(/^flow_/u, ""),
        name: definition.name,
        label: definition.label,
        description: definition.description,
        inputSchema: definition.parameters,
        executionMode: definition.executionMode ?? "default",
      }))
      .sort((left, right) => left.selector.localeCompare(right.selector));
    const expected = catalog.tools.map((tool) => ({
      selector: tool.selector,
      name: tool.name,
      label: tool.label,
      description: tool.description,
      inputSchema: tool.inputSchema,
      executionMode: tool.executionMode,
    }));

    expect(actual).toEqual(expected);
  });
});

function policyBroker(): PolicyBroker {
  return new PolicyBroker(
    {
      runId: "run-tool-reference",
      workflowId: "tool-reference-workflow",
      nodeId: "catalog",
      attempt: 1,
    },
    ["artifact.read", "filesystem.read", "filesystem.list", "filesystem.write", "process.execute"],
  );
}
