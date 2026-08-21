import { describe, expect, it, vi } from "vitest";

import { main } from "../../../src/cli/main.js";
import { resolveFlowConfig } from "../../../src/domain/config/resolver.js";

const PROVIDER_WORKFLOW = `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: doctor-provider
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Inspect the fixture.
      model:
        provider: anthropic
        id: claude-sonnet-4-5
        thinking: low
      tools: []
      timeoutMs: 10000
  - id: verify
    type: verifier
    dependsOn: [implement]
    verifier:
      kind: command
      command:
        executable: node
        args: [--version]
        timeoutMs: 10000
`;

describe("flow doctor", () => {
  it("reports the configured native project path without optional probes", async () => {
    const output: string[] = [];
    const inspectNativeSandbox = vi.fn(async () => undefined);
    const inspectContainerSandbox = vi.fn(async () => undefined);
    const inspectProviders = vi.fn(async () => undefined);
    const inspectPrime = vi.fn(async () => undefined);

    const exitCode = await main(["doctor"], outputIo(output), {
      cwd: "/workspace/project",
      loadConfig: async () => resolveFlowConfig({ projectRoot: "/workspace/project" }),
      inspectProjectFilesystem: async () => undefined,
      inspectNativeSandbox,
      inspectContainerSandbox,
      inspectProviders,
      inspectPrime,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      version: 1,
      ok: true,
      target: "project",
    });
    expect(inspectNativeSandbox).toHaveBeenCalledOnce();
    expect(inspectContainerSandbox).not.toHaveBeenCalled();
    expect(inspectProviders).not.toHaveBeenCalled();
    expect(inspectPrime).not.toHaveBeenCalled();
  });

  it("admits the selected workflow and checks its exact local provider requirements", async () => {
    const output: string[] = [];
    const inspectProviders = vi.fn(async () => undefined);

    const exitCode = await main(["doctor", "provider.workflow.yaml"], outputIo(output), {
      cwd: "/workspace/project",
      loadConfig: async () => resolveFlowConfig({ projectRoot: "/workspace/project" }),
      readTextFile: async () => PROVIDER_WORKFLOW,
      inspectProjectFilesystem: async () => undefined,
      inspectNativeSandbox: async () => undefined,
      inspectProviders,
      inspectPrime: async () => {
        throw new Error("Prime must remain unselected");
      },
    });

    expect(exitCode).toBe(0);
    expect(inspectProviders).toHaveBeenCalledWith(
      [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
      expect.any(AbortSignal),
    );
    const report = JSON.parse(output.join("\n"));
    expect(report).toMatchObject({ ok: true, target: "workflow" });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "workflow.admission", status: "pass" }),
        expect.objectContaining({ category: "provider.configuration", status: "pass" }),
      ]),
    );
  });

  it("checks container and Prime currentness only for the explicit Prime profile", async () => {
    const output: string[] = [];
    const inspectContainerSandbox = vi.fn(async () => undefined);
    const inspectPrime = vi.fn(async () => undefined);

    const exitCode = await main(["doctor", "--profile", "prime-agent"], outputIo(output), {
      cwd: "/workspace/project",
      loadConfig: async () =>
        resolveFlowConfig({
          projectRoot: "/workspace/project",
          operator: {
            path: "/operator/config.yaml",
            config: {
              apiVersion: "flow.synapti.ai/v1alpha1",
              kind: "FlowOperatorConfig",
              sandbox: { profile: "container" },
            },
          },
        }),
      inspectProjectFilesystem: async () => undefined,
      inspectContainerSandbox,
      inspectNativeSandbox: async () => {
        throw new Error("native sandbox must remain unselected");
      },
      inspectPrime,
    });

    expect(exitCode).toBe(0);
    expect(inspectContainerSandbox).toHaveBeenCalledOnce();
    expect(inspectPrime).toHaveBeenCalledOnce();
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      target: "prime-agent",
      ok: true,
    });
  });

  it("rejects incompatible targets before configuration or host inspection", async () => {
    const output: string[] = [];
    const loadConfig = vi.fn();
    const inspectPrime = vi.fn();

    const exitCode = await main(
      ["doctor", "workflow.yaml", "--profile", "prime-agent"],
      outputIo(output),
      { loadConfig, inspectPrime },
    );

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain("cannot combine a workflow with --profile prime-agent");
    expect(loadConfig).not.toHaveBeenCalled();
    expect(inspectPrime).not.toHaveBeenCalled();
  });

  it("rejects a repeated profile before configuration or runtime inspection", async () => {
    const output: string[] = [];
    const loadConfig = vi.fn();
    const inspectPrime = vi.fn();

    const exitCode = await main(
      ["doctor", "--profile", "prime-agent", "--profile", "prime-agent"],
      outputIo(output),
      { loadConfig, inspectPrime },
    );

    expect(exitCode).toBe(2);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("--profile may be specified only once");
    expect(output[0]).toContain("flow doctor");
    expect(loadConfig).not.toHaveBeenCalled();
    expect(inspectPrime).not.toHaveBeenCalled();
  });

  it("returns fixed diagnostics without private infrastructure causes", async () => {
    const output: string[] = [];

    const exitCode = await main(["doctor"], outputIo(output), {
      cwd: "/workspace/project",
      loadConfig: async () => resolveFlowConfig({ projectRoot: "/workspace/project" }),
      inspectProjectFilesystem: async () => undefined,
      inspectNativeSandbox: async () => {
        throw new Error("PRIVATE_SANDBOX_PATH_AND_CAUSE");
      },
    });

    expect(exitCode).toBe(1);
    expect(output.join("\n")).not.toContain("PRIVATE");
    const report = JSON.parse(output.join("\n"));
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "sandbox.native",
          status: "fail",
          message: "The configured native sandbox is unavailable.",
        }),
      ]),
    );
  });

  it("publishes one fixed cancellation message without the caller reason", async () => {
    const output: string[] = [];
    const controller = new AbortController();

    const exitCode = await main(["doctor"], outputIo(output), {
      signal: controller.signal,
      loadConfig: async () => {
        controller.abort(new Error("PRIVATE_CALLER_REASON"));
        throw new Error("PRIVATE_CONFIG_ERROR");
      },
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual(["Flow diagnostics were cancelled."]);
  });
});

function outputIo(output: string[]) {
  return {
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => output.push(text),
  };
}
