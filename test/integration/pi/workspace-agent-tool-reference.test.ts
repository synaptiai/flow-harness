import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CAPABILITY_PACKAGE_FAMILY_REFERENCES } from "../../../src/domain/capability/capability-bundles.js";
import { EVALUATION_ADAPTER_REFERENCES } from "../../../src/domain/evaluation/plan.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import { CommandNodeExecutor } from "../../../src/infrastructure/process/command-node-executor.js";
import { AGENT_TOOL_NAMES } from "../../../src/domain/workflow/types.js";
import {
  createWorkspaceAgentTools,
  WORKSPACE_AGENT_TOOL_REFERENCES,
} from "../../../src/infrastructure/pi/workspace-agent-tools.js";
import {
  PRODUCTION_AGENT_EXECUTOR_DESCRIPTOR,
  PRODUCTION_COMMAND_EXECUTOR_DESCRIPTOR,
  PRODUCTION_LEAN_PROOF_VERIFIER_DESCRIPTOR,
} from "../../../src/infrastructure/runtime/production-node-executor.js";
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
      "create",
      "edit",
      "exec",
      "ls",
      "mkdir",
      "read",
      "replace",
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
      expect.objectContaining({
        id: "lean-proof-verifier",
        openness: "open",
        implementation: "lean-proof-oci-v1",
      }),
      expect.objectContaining({
        id: "model-provider",
        openness: "open",
        implementation: "pi-acp",
      }),
    ]);
  });

  it("draws closed identifiers and the open provider seam from production registries", () => {
    const catalog = createProductionPublicCapabilityCatalog();

    expect(catalog.tools.map((tool) => tool.selector).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    expect(catalog.capabilityFamilies).toEqual(CAPABILITY_PACKAGE_FAMILY_REFERENCES);
    expect(catalog.evaluationAdapters).toEqual(EVALUATION_ADAPTER_REFERENCES);
    expect(catalog.executionSeams).toEqual([
      PRODUCTION_LEAN_PROOF_VERIFIER_DESCRIPTOR.reference,
      PRODUCTION_AGENT_EXECUTOR_DESCRIPTOR.reference,
    ]);
  });

  it("derives the exec sandbox prerequisite from production command composition", () => {
    const catalog = createProductionPublicCapabilityCatalog();
    const exec = catalog.tools.find((tool) => tool.selector === "exec");
    const sandbox = { prepare: () => Promise.reject(new Error("unused")) } as never;

    expect(PRODUCTION_COMMAND_EXECUTOR_DESCRIPTOR.availability).toEqual(["production-sandbox"]);
    expect(exec?.availability).toContain("production-sandbox");
    expect(PRODUCTION_COMMAND_EXECUTOR_DESCRIPTOR.create(sandbox)).toBeInstanceOf(
      CommandNodeExecutor,
    );
  });

  it("distinguishes schema character ceilings from stricter UTF-8 byte budgets", () => {
    const catalog = createProductionPublicCapabilityCatalog();
    const limits = Object.fromEntries(catalog.limits.map((limit) => [limit.id, limit]));

    expect(limits["edit-input-characters"]).toMatchObject({
      value: 262_144,
      unit: "characters",
      scope: "Maximum Unicode code points in one old or replacement text schema value.",
    });
    expect(limits["edit-input-total-bytes"]).toMatchObject({
      value: 262_144,
      unit: "bytes",
      scope: "Maximum combined UTF-8 bytes across every old and replacement text value.",
    });
    expect(limits["create-input-characters"]).toMatchObject({
      value: 262_144,
      unit: "characters",
    });
    expect(limits["create-input-bytes"]).toMatchObject({ value: 262_144, unit: "bytes" });
    expect(limits["semantic-path-characters"]).toMatchObject({
      value: 1_024,
      unit: "characters",
    });
    expect(limits["semantic-path-bytes"]).toMatchObject({ value: 1_024, unit: "bytes" });
    expect(limits["tool-path-characters"]).toMatchObject({
      value: 1_024,
      unit: "characters",
    });
    expect(limits["tool-path-bytes"]).toMatchObject({ value: 1_024, unit: "bytes" });

    const tools = Object.fromEntries(catalog.tools.map((tool) => [tool.selector, tool]));
    expect(tools.edit?.limitIds).toEqual(
      expect.arrayContaining(["edit-input-total-bytes", "tool-path-bytes"]),
    );
    expect(tools.semantic?.limitIds).toContain("semantic-path-bytes");
    expect(tools.ls?.limitIds).not.toContain("tool-path-bytes");
  });

  it("publishes every enforced per-attempt and mode-specific output ceiling", () => {
    const catalog = createProductionPublicCapabilityCatalog();
    const limits = Object.fromEntries(catalog.limits.map((limit) => [limit.id, limit]));

    expect(limits["agent-commands-per-attempt"]).toMatchObject({ value: 32, unit: "items" });
    expect(limits["agent-effects-per-attempt"]).toMatchObject({ value: 32, unit: "items" });
    expect(limits["exec-artifact-bytes-per-stream"]).toMatchObject({
      value: 1_048_576,
      unit: "bytes",
    });
    expect(limits["exec-output-bytes-per-stream"]).toMatchObject({
      value: 32_768,
      unit: "bytes",
    });
    expect(limits["read-distinct-skill-resources-per-attempt"]).toMatchObject({
      value: 128,
      unit: "items",
    });
    expect(limits["read-skill-resource-bytes"]).toMatchObject({
      value: 131_072,
      unit: "bytes",
    });
    expect(limits["semantic-result-bytes"]).toMatchObject({
      value: 1_048_576,
      unit: "bytes",
    });
    expect(limits["policy-decisions-per-attempt"]).toMatchObject({
      value: 128,
      default: 64,
      unit: "items",
    });
    expect(limits["policy-target-bytes"]).toMatchObject({ value: 1_024, unit: "bytes" });

    const tools = Object.fromEntries(catalog.tools.map((tool) => [tool.selector, tool]));
    expect(tools.edit?.limitIds).toContain("agent-effects-per-attempt");
    expect(tools.mkdir?.limitIds).toContain("agent-effects-per-attempt");
    expect(tools.exec?.limitIds).toEqual(
      expect.arrayContaining([
        "agent-commands-per-attempt",
        "exec-artifact-bytes-per-stream",
        "exec-output-bytes-per-stream",
      ]),
    );
    expect(tools.read?.limitIds).toEqual(
      expect.arrayContaining([
        "read-distinct-skill-resources-per-attempt",
        "read-skill-resource-bytes",
      ]),
    );
    expect(tools.semantic?.limitIds).toContain("semantic-result-bytes");
    expect(
      catalog.tools.every((tool) => tool.limitIds.includes("policy-decisions-per-attempt")),
    ).toBe(true);
    expect(catalog.tools.every((tool) => tool.limitIds.includes("policy-target-bytes"))).toBe(true);

    const execSchema = tools.exec?.inputSchema as {
      readonly properties?: { readonly args?: { readonly default?: unknown } };
    };
    expect(execSchema.properties?.args?.default).toEqual([]);
  });

  it("keeps production schemas and security metadata immutable and independently pinned", () => {
    expect(
      WORKSPACE_AGENT_TOOL_REFERENCES.every(
        (tool) => Object.isFrozen(tool.inputSchema) && nestedObjectsAreFrozen(tool.inputSchema),
      ),
    ).toBe(true);
    expect(CAPABILITY_PACKAGE_FAMILY_REFERENCES.every((family) => Object.isFrozen(family))).toBe(
      true,
    );
    expect(EVALUATION_ADAPTER_REFERENCES.every((adapter) => Object.isFrozen(adapter))).toBe(true);

    const catalog = createProductionPublicCapabilityCatalog();
    expect(
      catalog.tools.map(({ selector, authority, policyActions, availability, limitIds }) => ({
        selector,
        authority,
        policyActions,
        availability,
        limitIds,
      })),
    ).toEqual([
      {
        selector: "artifact",
        authority: ["read"],
        policyActions: ["artifact.read"],
        availability: ["artifact-store"],
        limitIds: [
          "artifact-maximum-bytes",
          "artifact-read-window-bytes",
          "policy-decisions-per-attempt",
          "policy-target-bytes",
        ],
      },
      {
        selector: "create",
        authority: ["write"],
        policyActions: ["filesystem.write"],
        availability: ["effect-recorder"],
        limitIds: [
          "agent-effects-per-attempt",
          "create-input-bytes",
          "create-input-characters",
          "policy-decisions-per-attempt",
          "policy-target-bytes",
          "tool-path-bytes",
          "tool-path-characters",
        ],
      },
      {
        selector: "edit",
        authority: ["write"],
        policyActions: ["filesystem.write"],
        availability: ["effect-recorder"],
        limitIds: [
          "agent-effects-per-attempt",
          "edit-file-bytes",
          "edit-input-characters",
          "edit-input-total-bytes",
          "edit-replacements",
          "policy-decisions-per-attempt",
          "policy-target-bytes",
          "tool-path-bytes",
          "tool-path-characters",
        ],
      },
      {
        selector: "exec",
        authority: ["execute"],
        policyActions: ["process.execute"],
        availability: ["command-recorder", "production-sandbox"],
        limitIds: [
          "agent-commands-per-attempt",
          "exec-argument-bytes",
          "exec-arguments",
          "exec-arguments-total-bytes",
          "exec-artifact-bytes-per-stream",
          "exec-executable-bytes",
          "exec-output-bytes-per-stream",
          "exec-timeout-milliseconds",
          "policy-decisions-per-attempt",
          "policy-target-bytes",
        ],
      },
      {
        selector: "ls",
        authority: ["read"],
        policyActions: ["filesystem.list"],
        availability: [],
        limitIds: [
          "ls-entries",
          "ls-output-bytes",
          "policy-decisions-per-attempt",
          "policy-target-bytes",
          "tool-path-characters",
        ],
      },
      {
        selector: "mkdir",
        authority: ["write"],
        policyActions: ["filesystem.write"],
        availability: ["effect-recorder"],
        limitIds: [
          "agent-effects-per-attempt",
          "policy-decisions-per-attempt",
          "policy-target-bytes",
          "tool-path-bytes",
          "tool-path-characters",
        ],
      },
      {
        selector: "read",
        authority: ["read"],
        policyActions: ["filesystem.read"],
        availability: [],
        limitIds: [
          "policy-decisions-per-attempt",
          "policy-target-bytes",
          "read-distinct-skill-resources-per-attempt",
          "read-output-bytes",
          "read-output-lines",
          "read-skill-resource-bytes",
        ],
      },
      {
        selector: "replace",
        authority: ["write"],
        policyActions: ["filesystem.write"],
        availability: ["effect-recorder"],
        limitIds: [
          "agent-effects-per-attempt",
          "edit-file-bytes",
          "policy-decisions-per-attempt",
          "policy-target-bytes",
          "replace-input-bytes",
          "replace-input-characters",
          "tool-path-bytes",
          "tool-path-characters",
        ],
      },
      {
        selector: "semantic",
        authority: ["read"],
        policyActions: ["filesystem.read"],
        availability: ["language-server"],
        limitIds: [
          "policy-decisions-per-attempt",
          "policy-target-bytes",
          "semantic-code-bytes",
          "semantic-hover-bytes",
          "semantic-message-bytes",
          "semantic-path-bytes",
          "semantic-path-characters",
          "semantic-position",
          "semantic-queries-per-attempt",
          "semantic-result-bytes",
          "semantic-result-items",
        ],
      },
    ]);
  });

  it.each([
    ["create", "effect recorder"],
    ["edit", "effect recorder"],
    ["mkdir", "effect recorder"],
    ["replace", "effect recorder"],
    ["exec", "command recorder"],
    ["semantic", "semantic service"],
    ["artifact", "artifact store"],
  ] as const)("enforces the declared %s prerequisite", async (selector, message) => {
    const root = await mkdtemp(join(tmpdir(), "flow-tool-prerequisite-"));
    temporaryDirectories.push(root);

    await expect(createWorkspaceAgentTools(root, [selector], policyBroker())).rejects.toThrowError(
      new RegExp(message, "iu"),
    );
  });

  it("matches the final production-composed built-in tool surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-tool-reference-"));
    temporaryDirectories.push(root);
    const catalog = createProductionPublicCapabilityCatalog();
    const tools = await createWorkspaceAgentTools(root, AGENT_TOOL_NAMES, policyBroker(), {
      effectRecorder: {} as never,
      commandRecorder: {} as never,
      semanticSession: {} as never,
      artifactStore: {} as never,
    });

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

function nestedObjectsAreFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(nestedObjectsAreFrozen);
}
