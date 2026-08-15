import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import {
  BUILT_IN_FLOW_CONFIG,
  FLOW_CONFIG_API_VERSION,
  FlowConfigError,
  parseOperatorConfig,
  parseProjectConfig,
  resolveFlowConfig,
} from "../../../src/domain/config/resolver.js";

describe("Flow configuration resolution", () => {
  it("uses deterministic built-in limits when no files contribute", () => {
    const first = resolveFlowConfig({});
    const second = resolveFlowConfig({});
    const expectedPolicy = {
      apiVersion: FLOW_CONFIG_API_VERSION,
      supervisor: { maxActiveWorkers: 1, maxQueuedJobs: 32 },
      sandbox: { profile: "native" },
    };

    expect(first).toEqual({
      ...expectedPolicy,
      policyDigest: createHash("sha256").update(JSON.stringify(expectedPolicy)).digest("hex"),
      projectRoot: null,
      sources: {
        builtIn: BUILT_IN_FLOW_CONFIG,
        operator: null,
        project: null,
      },
    });
    expect(second.policyDigest).toBe(first.policyDigest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.supervisor)).toBe(true);
    expect(Object.isFrozen(first.sandbox)).toBe(true);
    expect(Object.isFrozen(first.sources)).toBe(true);
  });

  it("lets only operator configuration select the container sandbox profile", () => {
    const operator = parseOperatorConfig(
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowOperatorConfig",
        sandbox: { profile: "container" },
      },
      "/operator/config.yaml",
    );

    const effective = resolveFlowConfig({
      operator: { path: "/operator/config.yaml", config: operator },
    });

    expect(effective).toMatchObject({
      sandbox: { profile: "container" },
      sources: {
        operator: {
          path: "/operator/config.yaml",
          sandbox: { profile: "container" },
        },
      },
    });
    expect(Object.isFrozen(effective.sandbox)).toBe(true);
    expect(Object.isFrozen(effective.sources.operator?.sandbox)).toBe(true);
  });

  it("rejects a project sandbox profile selector", () => {
    expect(() =>
      parseProjectConfig(
        {
          apiVersion: FLOW_CONFIG_API_VERSION,
          kind: "FlowProjectConfig",
          sandbox: { profile: "container" },
        },
        "/workspace/.flow/config.yaml",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_config",
        sourcePath: "/workspace/.flow/config.yaml",
        fieldPath: "<root>",
      }),
    );
  });

  it("rejects an unknown operator sandbox profile", () => {
    expect(() =>
      parseOperatorConfig(
        {
          apiVersion: FLOW_CONFIG_API_VERSION,
          kind: "FlowOperatorConfig",
          sandbox: { profile: "private-host" },
        },
        "/operator/config.yaml",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_config",
        sourcePath: "/operator/config.yaml",
        fieldPath: "sandbox.profile",
      }),
    );
  });

  it("lets operator configuration change defaults within hard bounds", () => {
    const operator = parseOperatorConfig(
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowOperatorConfig",
        supervisor: { maxActiveWorkers: 8, maxQueuedJobs: 0 },
      },
      "/operator/config.yaml",
    );

    expect(
      resolveFlowConfig({ operator: { path: "/operator/config.yaml", config: operator } }),
    ).toMatchObject({
      supervisor: { maxActiveWorkers: 8, maxQueuedJobs: 0 },
      sources: {
        operator: {
          path: "/operator/config.yaml",
          values: { maxActiveWorkers: 8, maxQueuedJobs: 0 },
        },
      },
    });
  });

  it("lets project configuration narrow each operator ceiling", () => {
    const operator = parseOperatorConfig(
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowOperatorConfig",
        supervisor: { maxActiveWorkers: 8, maxQueuedJobs: 64 },
      },
      "/operator/config.yaml",
    );
    const project = parseProjectConfig(
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowProjectConfig",
        supervisor: { maxActiveWorkers: 3, maxQueuedJobs: 12 },
      },
      "/workspace/.flow/config.yaml",
    );

    expect(
      resolveFlowConfig({
        operator: { path: "/operator/config.yaml", config: operator },
        project: { path: "/workspace/.flow/config.yaml", config: project },
        projectRoot: "/workspace",
      }),
    ).toMatchObject({
      supervisor: { maxActiveWorkers: 3, maxQueuedJobs: 12 },
      projectRoot: "/workspace",
      sources: {
        project: {
          path: "/workspace/.flow/config.yaml",
          values: { maxActiveWorkers: 3, maxQueuedJobs: 12 },
        },
      },
    });
  });

  it.each([
    ["supervisor.maxActiveWorkers", { maxActiveWorkers: 5 }, { maxActiveWorkers: 4 }],
    ["supervisor.maxQueuedJobs", { maxQueuedJobs: 33 }, { maxQueuedJobs: 32 }],
  ])("rejects project widening at %s", (fieldPath, projectValues, operatorValues) => {
    const operator = parseOperatorConfig(
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowOperatorConfig",
        supervisor: operatorValues,
      },
      "/operator/config.yaml",
    );
    const project = parseProjectConfig(
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowProjectConfig",
        supervisor: projectValues,
      },
      "/workspace/.flow/config.yaml",
    );

    expect(() =>
      resolveFlowConfig({
        operator: { path: "/operator/config.yaml", config: operator },
        project: { path: "/workspace/.flow/config.yaml", config: project },
        projectRoot: "/workspace",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "unsafe_widening",
        sourcePath: "/workspace/.flow/config.yaml",
        fieldPath,
      }),
    );
  });

  it.each([
    [
      "unsupported version",
      { apiVersion: "flow.synapti.ai/v2", kind: "FlowProjectConfig" },
      "apiVersion",
    ],
    ["wrong kind", { apiVersion: FLOW_CONFIG_API_VERSION, kind: "FlowOperatorConfig" }, "kind"],
    [
      "unknown top-level field",
      { apiVersion: FLOW_CONFIG_API_VERSION, kind: "FlowProjectConfig", unknown: true },
      "<root>",
    ],
    [
      "zero active workers",
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowProjectConfig",
        supervisor: { maxActiveWorkers: 0 },
      },
      "supervisor.maxActiveWorkers",
    ],
    [
      "active worker hard cap",
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowProjectConfig",
        supervisor: { maxActiveWorkers: 65 },
      },
      "supervisor.maxActiveWorkers",
    ],
    [
      "negative queue depth",
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowProjectConfig",
        supervisor: { maxQueuedJobs: -1 },
      },
      "supervisor.maxQueuedJobs",
    ],
    [
      "queue hard cap",
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowProjectConfig",
        supervisor: { maxQueuedJobs: 1025 },
      },
      "supervisor.maxQueuedJobs",
    ],
    [
      "unknown supervisor field",
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowProjectConfig",
        supervisor: { secret: "not-allowed" },
      },
      "supervisor",
    ],
  ])("rejects invalid configuration: %s", (_case, input, fieldPath) => {
    expect(() => parseProjectConfig(input, "/workspace/.flow/config.yaml")).toThrowError(
      expect.objectContaining({
        code: "invalid_config",
        sourcePath: "/workspace/.flow/config.yaml",
        fieldPath,
      }),
    );
  });

  it("computes the digest from effective values rather than provenance", () => {
    const left = resolveFlowConfig({
      operator: {
        path: "/one/config.yaml",
        config: parseOperatorConfig(
          {
            apiVersion: FLOW_CONFIG_API_VERSION,
            kind: "FlowOperatorConfig",
            supervisor: { maxActiveWorkers: 2 },
          },
          "/one/config.yaml",
        ),
      },
    });
    const right = resolveFlowConfig({
      projectRoot: "/different/project",
      operator: {
        path: "/two/config.yaml",
        config: parseOperatorConfig(
          {
            kind: "FlowOperatorConfig",
            supervisor: { maxActiveWorkers: 2, maxQueuedJobs: 32 },
            apiVersion: FLOW_CONFIG_API_VERSION,
          },
          "/two/config.yaml",
        ),
      },
    });

    expect(right.policyDigest).toBe(left.policyDigest);
    expect(right.sources).not.toEqual(left.sources);
  });

  it("changes the policy digest when the effective sandbox profile changes", () => {
    const native = resolveFlowConfig({});
    const container = resolveFlowConfig({
      operator: {
        path: "/operator/config.yaml",
        config: parseOperatorConfig(
          {
            apiVersion: FLOW_CONFIG_API_VERSION,
            kind: "FlowOperatorConfig",
            sandbox: { profile: "container" },
          },
          "/operator/config.yaml",
        ),
      },
    });

    expect(container.supervisor).toEqual(native.supervisor);
    expect(container.policyDigest).not.toBe(native.policyDigest);
  });

  it("resolves exact operator-required and project-additional policy packages", () => {
    const operatorPackage = policySnapshot({
      name: "operator-baseline",
      version: "1.0.0",
      spec: "sandbox:\n  allowedProfiles: [container]\ntools:\n  allowed: [edit, read]\n",
    });
    const projectPackage = policySnapshot({
      name: "project-review",
      version: "2.1.0",
      spec: "tools:\n  allowed: [read]\ncommands:\n  requireApproval: true\n",
    });
    const operator = parseOperatorConfig(
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowOperatorConfig",
        sandbox: { profile: "container" },
        policies: {
          required: [exactReference(operatorPackage.packages[0])],
        },
      },
      "/operator/config.yaml",
    );
    const project = parseProjectConfig(
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowProjectConfig",
        policies: {
          additional: [exactReference(projectPackage.packages[0])],
        },
      },
      "/workspace/.flow/config.yaml",
    );
    const selected = createCapabilitySnapshot(
      [],
      [],
      [],
      [],
      [
        policyInput(
          "project-review",
          "2.1.0",
          "tools:\n  allowed: [read]\ncommands:\n  requireApproval: true\n",
        ),
        policyInput(
          "operator-baseline",
          "1.0.0",
          "sandbox:\n  allowedProfiles: [container]\ntools:\n  allowed: [edit, read]\n",
        ),
      ],
    );

    const effective = resolveFlowConfig({
      operator: { path: "/operator/config.yaml", config: operator },
      project: { path: "/workspace/.flow/config.yaml", config: project },
      projectRoot: "/workspace",
      policyPackages: selected,
    });

    expect(effective.policyPackages).toMatchObject({
      snapshot: selected,
      effective: {
        packages: [
          { name: "operator-baseline", version: "1.0.0" },
          { name: "project-review", version: "2.1.0" },
        ],
        constraints: {
          sandbox: { allowedProfiles: ["container"] },
          tools: { allowed: ["read"] },
          commands: { requireApproval: true },
        },
      },
    });
    expect(effective.sources.operator?.policies).toEqual(operator.policies?.required);
    expect(effective.sources.project?.policies).toEqual(project.policies?.additional);
    expect(effective.policyDigest).not.toBe(
      resolveFlowConfig({
        operator: {
          path: "/operator/config.yaml",
          config: parseOperatorConfig(
            {
              apiVersion: FLOW_CONFIG_API_VERSION,
              kind: "FlowOperatorConfig",
              sandbox: { profile: "container" },
            },
            "/operator/config.yaml",
          ),
        },
      }).policyDigest,
    );
    expect(Object.isFrozen(effective.policyPackages?.effective.constraints)).toBe(true);
  });

  it("rejects missing, substituted, duplicated, and sandbox-incompatible selections", () => {
    const selected = policySnapshot({
      name: "restricted-review",
      version: "1.2.3",
      spec: "sandbox:\n  allowedProfiles: [container]\n",
    });
    const policy = selected.packages[0];
    if (policy === undefined) {
      throw new Error("policy fixture is missing");
    }
    const cases = [
      {
        name: "missing snapshot",
        operatorReference: exactReference(policy),
        policyPackages: undefined,
        fieldPath: "policies.required",
      },
      {
        name: "substituted digest",
        operatorReference: { ...exactReference(policy), digest: "0".repeat(64) },
        policyPackages: selected,
        fieldPath: "policies.required.0.digest",
      },
    ];
    for (const testCase of cases) {
      const operator = parseOperatorConfig(
        {
          apiVersion: FLOW_CONFIG_API_VERSION,
          kind: "FlowOperatorConfig",
          sandbox: { profile: "container" },
          policies: { required: [testCase.operatorReference] },
        },
        "/operator/config.yaml",
      );
      expect(() =>
        resolveFlowConfig({
          operator: { path: "/operator/config.yaml", config: operator },
          projectRoot: "/workspace",
          ...(testCase.policyPackages === undefined
            ? {}
            : { policyPackages: testCase.policyPackages }),
        }),
      ).toThrowError(expect.objectContaining({ fieldPath: testCase.fieldPath }));
    }

    const reference = exactReference(policy);
    const operator = parseOperatorConfig(
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowOperatorConfig",
        policies: { required: [reference] },
      },
      "/operator/config.yaml",
    );
    const project = parseProjectConfig(
      {
        apiVersion: FLOW_CONFIG_API_VERSION,
        kind: "FlowProjectConfig",
        policies: { additional: [reference] },
      },
      "/workspace/.flow/config.yaml",
    );
    expect(() =>
      resolveFlowConfig({
        operator: { path: "/operator/config.yaml", config: operator },
        project: { path: "/workspace/.flow/config.yaml", config: project },
        projectRoot: "/workspace",
        policyPackages: selected,
      }),
    ).toThrowError(expect.objectContaining({ fieldPath: "policies.additional.0.name" }));

    expect(() =>
      resolveFlowConfig({
        operator: {
          path: "/operator/config.yaml",
          config: parseOperatorConfig(
            {
              apiVersion: FLOW_CONFIG_API_VERSION,
              kind: "FlowOperatorConfig",
              policies: { required: [reference] },
            },
            "/operator/config.yaml",
          ),
        },
        projectRoot: "/workspace",
        policyPackages: selected,
      }),
    ).toThrowError(expect.objectContaining({ fieldPath: "sandbox.profile" }));
  });
});

function policySnapshot(input: {
  readonly name: string;
  readonly version: string;
  readonly spec: string;
}) {
  return createCapabilitySnapshot(
    [],
    [],
    [],
    [],
    [policyInput(input.name, input.version, input.spec)],
  );
}

function policyInput(name: string, version: string, spec: string) {
  return {
    kind: "policy-package" as const,
    trust: "project-explicit" as const,
    provenance: `.flow/policies/${name}`,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: ${name}
  version: ${version}
  description: Policy fixture.
spec:
${spec
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => `  ${line}`)
  .join("\n")}
`),
    },
  };
}

function exactReference(
  value: { readonly name: string; readonly version: string; readonly digest: string } | undefined,
) {
  if (value === undefined) {
    throw new Error("policy fixture is missing");
  }
  return { name: value.name, version: value.version, digest: value.digest };
}

describe("FlowConfigError", () => {
  it("preserves structured diagnostics", () => {
    const error = new FlowConfigError("invalid_config", "bad config", {
      sourcePath: "/config.yaml",
      fieldPath: "supervisor.maxActiveWorkers",
    });

    expect(error).toMatchObject({
      name: "FlowConfigError",
      code: "invalid_config",
      sourcePath: "/config.yaml",
      fieldPath: "supervisor.maxActiveWorkers",
      message: "bad config",
    });
  });
});
