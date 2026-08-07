import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

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
    expect(Object.isFrozen(first.sources)).toBe(true);
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

  it("rejects wrong kinds, unknown fields, and values outside hard bounds with paths", () => {
    expect(() =>
      parseOperatorConfig(
        {
          apiVersion: FLOW_CONFIG_API_VERSION,
          kind: "FlowProjectConfig",
        },
        "/operator/config.yaml",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_config",
        sourcePath: "/operator/config.yaml",
        fieldPath: "kind",
      }),
    );

    expect(() =>
      parseProjectConfig(
        {
          apiVersion: FLOW_CONFIG_API_VERSION,
          kind: "FlowProjectConfig",
          supervisor: { maxActiveWorkers: 65, maxQueuedJobs: -1, secret: "not-allowed" },
        },
        "/workspace/.flow/config.yaml",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_config",
        sourcePath: "/workspace/.flow/config.yaml",
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
});

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
