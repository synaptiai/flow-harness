import { describe, expect, it, vi } from "vitest";

import {
  type EnvironmentDoctorDependencies,
  runEnvironmentDoctor,
} from "../../../src/application/environment-doctor.js";

describe("environment doctor", () => {
  it("checks only the base project and configured native sandbox in a stable order", async () => {
    const dependencies = passingDependencies();

    const report = await runEnvironmentDoctor(
      {
        target: "project",
        platform: "linux",
        nodeVersion: "26.7.0",
        invocationRoot: "/workspace/project",
      },
      dependencies,
    );

    expect(report).toEqual({
      version: 1,
      ok: true,
      target: "project",
      checks: [
        {
          category: "runtime.host",
          status: "pass",
          message: "The Flow host runtime is supported.",
        },
        {
          category: "project.configuration",
          status: "pass",
          message: "The effective Flow configuration is valid.",
        },
        {
          category: "project.discovery",
          status: "pass",
          message: "A Flow project is configured.",
        },
        {
          category: "project.filesystem",
          status: "pass",
          message: "The Flow project filesystem is accessible.",
        },
        {
          category: "sandbox.native",
          status: "pass",
          message: "The configured native sandbox is available.",
        },
      ],
    });
    expect(dependencies.inspectNativeSandbox).toHaveBeenCalledOnce();
    expect(dependencies.inspectContainerSandbox).not.toHaveBeenCalled();
    expect(dependencies.inspectWorkflow).not.toHaveBeenCalled();
    expect(dependencies.inspectProviders).not.toHaveBeenCalled();
    expect(dependencies.inspectPrime).not.toHaveBeenCalled();
  });

  it("reports an unsupported host as blocking with fixed remediation", async () => {
    const dependencies = passingDependencies();
    const report = await runEnvironmentDoctor(
      {
        target: "project",
        platform: "linux",
        nodeVersion: "26.6.99",
        invocationRoot: "/workspace/project",
      },
      dependencies,
    );

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toEqual({
      category: "runtime.host",
      status: "fail",
      message: "The Flow host runtime is unsupported.",
      remediation: "Use a supported operating system and Node.js version, then rerun flow doctor.",
    });
    expect(report.checks.slice(1).every((check) => check.status === "skip")).toBe(true);
    expect(dependencies.loadConfiguration).not.toHaveBeenCalled();
    expect(dependencies.inspectProjectFilesystem).not.toHaveBeenCalled();
    expect(dependencies.inspectNativeSandbox).not.toHaveBeenCalled();
  });

  it("reports a missing project without attempting project filesystem access", async () => {
    const dependencies = passingDependencies();
    dependencies.loadConfiguration = vi.fn(async () => ({
      projectRoot: null,
      sandbox: "native" as const,
    }));

    const report = await runEnvironmentDoctor(
      {
        target: "project",
        platform: "linux",
        nodeVersion: "26.7.0",
        invocationRoot: "/workspace/invocation",
      },
      dependencies,
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        {
          category: "project.discovery",
          status: "fail",
          message: "No Flow project is configured.",
          remediation: "Run flow init in the intended project, then rerun flow doctor.",
        },
        {
          category: "project.filesystem",
          status: "skip",
          message: "Project filesystem access was not checked because no project was found.",
        },
      ]),
    );
    expect(dependencies.inspectProjectFilesystem).not.toHaveBeenCalled();
    expect(dependencies.inspectNativeSandbox).toHaveBeenCalledWith(
      "/workspace/invocation",
      expect.any(AbortSignal),
    );
  });

  it("checks an admitted workflow and local provider configuration without Prime", async () => {
    const dependencies = passingDependencies();
    dependencies.inspectWorkflow = vi.fn(async () => ({
      modelRequirements: [{ provider: "anthropic", model: "claude-sonnet" }],
      requiresLinuxAgentCommands: false,
    }));

    const report = await runEnvironmentDoctor(
      {
        target: "workflow",
        platform: "darwin",
        nodeVersion: "27.0.0",
        invocationRoot: "/workspace/project",
      },
      dependencies,
    );

    expect(report.ok).toBe(true);
    expect(report.checks.slice(-3)).toEqual([
      {
        category: "workflow.admission",
        status: "pass",
        message: "The selected workflow is valid and admitted.",
      },
      {
        category: "workflow.host",
        status: "pass",
        message: "The selected workflow host requirements are supported.",
      },
      {
        category: "provider.configuration",
        status: "pass",
        message: "Every selected model and provider has local configuration.",
      },
    ]);
    expect(dependencies.inspectProviders).toHaveBeenCalledWith(
      [{ provider: "anthropic", model: "claude-sonnet" }],
      expect.any(AbortSignal),
    );
    expect(dependencies.inspectPrime).not.toHaveBeenCalled();
  });

  it("fails the selected workflow host check when agent commands require Linux", async () => {
    const dependencies = passingDependencies();
    dependencies.inspectWorkflow = vi.fn(async () => ({
      modelRequirements: [],
      requiresLinuxAgentCommands: true,
    }));

    const report = await runEnvironmentDoctor(
      {
        target: "workflow",
        platform: "darwin",
        nodeVersion: "27.0.0",
        invocationRoot: "/workspace/project",
      },
      dependencies,
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({
      category: "workflow.host",
      status: "fail",
      message: "The selected workflow host requirements are unsupported.",
      remediation: "Run this workflow on a supported Linux host, then rerun flow doctor.",
    });
    expect(dependencies.inspectProviders).not.toHaveBeenCalled();
  });

  it("does not inspect providers for a credential-free selected workflow", async () => {
    const dependencies = passingDependencies();

    const report = await runEnvironmentDoctor(
      {
        target: "workflow",
        platform: "linux",
        nodeVersion: "26.7.0",
        invocationRoot: "/workspace/project",
      },
      dependencies,
    );

    expect(report.ok).toBe(true);
    expect(report.checks.at(-1)).toEqual({
      category: "provider.configuration",
      status: "pass",
      message: "The selected workflow does not require a model provider.",
    });
    expect(dependencies.inspectProviders).not.toHaveBeenCalled();
  });

  it("checks the prepared Prime runtime only for the explicit Prime target", async () => {
    const dependencies = passingDependencies("container");

    const report = await runEnvironmentDoctor(
      {
        target: "prime-agent",
        platform: "linux",
        nodeVersion: "26.7.0",
        invocationRoot: "/workspace/project",
      },
      dependencies,
    );

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.category)).toEqual([
      "runtime.host",
      "project.configuration",
      "project.discovery",
      "project.filesystem",
      "sandbox.container",
      "prime.runtime",
    ]);
    expect(dependencies.inspectContainerSandbox).toHaveBeenCalledOnce();
    expect(dependencies.inspectPrime).toHaveBeenCalledOnce();
    expect(dependencies.inspectWorkflow).not.toHaveBeenCalled();
    expect(dependencies.inspectProviders).not.toHaveBeenCalled();
  });

  it("fails closed with fixed diagnostics and skips checks whose configuration is unavailable", async () => {
    const dependencies = passingDependencies();
    dependencies.loadConfiguration = vi.fn(async () => {
      throw new Error("PRIVATE_CONFIG_PATH_AND_CONTENT");
    });

    const report = await runEnvironmentDoctor(
      {
        target: "workflow",
        platform: "linux",
        nodeVersion: "26.7.0",
        invocationRoot: "/workspace/project",
      },
      dependencies,
    );

    expect(report.ok).toBe(false);
    expect(report.checks.slice(1)).toEqual([
      {
        category: "project.configuration",
        status: "fail",
        message: "The effective Flow configuration is unavailable.",
        remediation: "Fix the Flow configuration, then rerun flow doctor.",
      },
      {
        category: "project.discovery",
        status: "skip",
        message: "Project discovery was not checked because configuration failed.",
      },
      {
        category: "project.filesystem",
        status: "skip",
        message: "Project filesystem access was not checked because configuration failed.",
      },
      {
        category: "sandbox.configuration",
        status: "skip",
        message: "The sandbox was not checked because configuration failed.",
      },
      {
        category: "workflow.admission",
        status: "skip",
        message: "The workflow was not checked because configuration failed.",
      },
      {
        category: "workflow.host",
        status: "skip",
        message: "Workflow host requirements were not checked because admission did not run.",
      },
      {
        category: "provider.configuration",
        status: "skip",
        message: "Provider configuration was not checked because workflow admission did not run.",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_CONFIG");
    expect(dependencies.inspectProjectFilesystem).not.toHaveBeenCalled();
    expect(dependencies.inspectNativeSandbox).not.toHaveBeenCalled();
    expect(dependencies.inspectWorkflow).not.toHaveBeenCalled();
  });

  it("bounds a stalled probe and never retains its late private failure", async () => {
    const dependencies = passingDependencies();
    dependencies.inspectProjectFilesystem = vi.fn(
      async () => await new Promise<void>(() => undefined),
    );

    const report = await runEnvironmentDoctor(
      {
        target: "project",
        platform: "linux",
        nodeVersion: "26.7.0",
        invocationRoot: "/workspace/project",
        probeTimeoutMs: 5,
      },
      dependencies,
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({
      category: "project.filesystem",
      status: "fail",
      message: "The Flow project filesystem check did not complete.",
      remediation: "Confirm project read and write access, then rerun flow doctor.",
    });
  });

  it("preserves the exact caller cancellation before reporting a private probe failure", async () => {
    const cancellation = new Error("PRIVATE_CALLER_REASON");
    const controller = new AbortController();
    const dependencies = passingDependencies();
    dependencies.loadConfiguration = vi.fn(async () => {
      controller.abort(cancellation);
      throw new Error("PRIVATE_CONFIG_FAILURE");
    });

    await expect(
      runEnvironmentDoctor(
        {
          target: "project",
          platform: "linux",
          nodeVersion: "26.7.0",
          invocationRoot: "/workspace/project",
          signal: controller.signal,
        },
        dependencies,
      ),
    ).rejects.toBe(cancellation);
  });
});

function passingDependencies(
  sandbox: "native" | "container" = "native",
): EnvironmentDoctorDependencies & {
  loadConfiguration: ReturnType<typeof vi.fn>;
  inspectProjectFilesystem: ReturnType<typeof vi.fn>;
  inspectNativeSandbox: ReturnType<typeof vi.fn>;
  inspectContainerSandbox: ReturnType<typeof vi.fn>;
  inspectWorkflow: ReturnType<typeof vi.fn>;
  inspectProviders: ReturnType<typeof vi.fn>;
  inspectPrime: ReturnType<typeof vi.fn>;
} {
  return {
    loadConfiguration: vi.fn(async () => ({
      projectRoot: "/workspace/project",
      sandbox,
    })),
    inspectProjectFilesystem: vi.fn(async () => undefined),
    inspectNativeSandbox: vi.fn(async () => undefined),
    inspectContainerSandbox: vi.fn(async () => undefined),
    inspectWorkflow: vi.fn(async () => ({
      modelRequirements: [],
      requiresLinuxAgentCommands: false,
    })),
    inspectProviders: vi.fn(async () => undefined),
    inspectPrime: vi.fn(async () => undefined),
  };
}
