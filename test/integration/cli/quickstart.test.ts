import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import { resolveFlowConfig } from "../../../src/domain/config/resolver.js";
import { FlowConfigStoreError } from "../../../src/infrastructure/fs/flow-config-store.js";

const FOUNDATION_WORKFLOW = `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: verify-installation }
nodes:
  - id: node-version
    type: command
    command: { executable: node, args: [--version] }
  - id: installation-smoke
    type: command
    dependsOn: [node-version]
    command: { executable: node, args: [-e, "process.stdout.write('flow-preview-ready')"] }
`;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("flow quickstart", () => {
  it("creates a minimal project and completes the installed credential-free workflow", async () => {
    const project = await temporaryDirectory("flow-quickstart-default-");
    const readmePath = join(project, "README.md");
    await writeFile(readmePath, "existing project file\n", "utf8");
    const capture = createCapture();
    const browserHost = vi.fn(() => {
      throw new Error("the quick start must not open a browser");
    });

    const exitCode = await main(["quickstart", project], capture.io, {
      cwd: project,
      readTextFile: async (path) => {
        expect(path).toMatch(/examples\/verify-installation\.workflow\.yaml$/);
        return FOUNDATION_WORKFLOW;
      },
      loadConfig: async (options) => resolveFlowConfig({ projectRoot: options?.cwd ?? project }),
      executor: successfulExecutor(),
      inspectProviders: async () => {
        throw new Error("provider inspection must remain unselected");
      },
      inspectPrime: async () => {
        throw new Error("Prime must remain unselected");
      },
      createBrowserPresentationHost: browserHost,
    });

    expect(exitCode, capture.stderr.join("\n")).toBe(0);
    expect(capture.stderr).toEqual([]);
    expect(JSON.parse(capture.stdout.join("\n"))).toEqual({
      version: 1,
      mode: "foundation",
      project: { publication: "created" },
      run: {
        id: "quickstart-foundation",
        status: "succeeded",
        evidence: ".flow/runs/quickstart-foundation/events.jsonl",
      },
      commands: {
        inspect: ["flow", "inspect", "quickstart-foundation"],
        browser: ["flow", "web", "quickstart-foundation", "--actor", "operator:quickstart"],
      },
    });
    await expect(readFile(readmePath, "utf8")).resolves.toBe("existing project file\n");
    await expect(readFile(join(project, ".flow", "config.yaml"), "utf8")).resolves.toContain(
      "kind: FlowProjectConfig",
    );
    await expect(
      readFile(join(project, ".flow", "runs", "quickstart-foundation", "events.jsonl"), "utf8"),
    ).resolves.toContain('"type":"run_succeeded"');
    expect(browserHost).not.toHaveBeenCalled();
  });

  it("keeps an installed workflow read failure private and starts no mutation", async () => {
    const project = await temporaryDirectory("flow-quickstart-workflow-read-failure-");
    const capture = createCapture();
    const initializeProject = vi.fn();
    const executor = vi.fn();

    const exitCode = await main(["quickstart", project], capture.io, {
      cwd: project,
      readTextFile: async () => {
        throw new Error("PRIVATE_INSTALLED_WORKFLOW_READ_FAILURE");
      },
      initializeProject,
      executor: { execute: executor },
    });

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([
      "preparation_failed: Quick-start workflow preparation failed.",
    ]);
    expect(capture.stderr.join("\n")).not.toContain("PRIVATE");
    expect(initializeProject).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    await expect(lstat(join(project, ".flow"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks the exact provider configuration before the first model execution", async () => {
    const project = await temporaryDirectory("flow-quickstart-provider-");
    const phases: string[] = [];
    const capture = createCapture();

    const exitCode = await main(
      ["quickstart", project, "--provider", "anthropic", "--model", "claude-sonnet-4-6"],
      capture.io,
      {
        cwd: project,
        readTextFile: async () => {
          throw new Error("the provider path must not read the foundation workflow");
        },
        loadConfig: async (options) => resolveFlowConfig({ projectRoot: options?.cwd ?? project }),
        inspectProviders: async (requirements) => {
          phases.push(`inspect:${requirements[0]?.provider}/${requirements[0]?.model}`);
        },
        executor: providerExecutor(phases),
      },
    );

    expect(exitCode, capture.stderr.join("\n")).toBe(0);
    expect(phases).toEqual([
      "inspect:anthropic/claude-sonnet-4-6",
      "execute:anthropic/claude-sonnet-4-6",
    ]);
    expect(JSON.parse(capture.stdout.join("\n"))).toMatchObject({
      mode: "provider",
      run: { id: "quickstart-provider", status: "succeeded" },
    });
  });

  it("fails the selected provider path without executing a model or exposing the cause", async () => {
    const project = await temporaryDirectory("flow-quickstart-provider-failure-");
    const capture = createCapture();
    const executor = vi.fn();

    const exitCode = await main(
      ["quickstart", project, "--provider", "anthropic", "--model", "claude-sonnet-4-6"],
      capture.io,
      {
        cwd: project,
        loadConfig: async (options) => resolveFlowConfig({ projectRoot: options?.cwd ?? project }),
        inspectProviders: async () => {
          throw new Error("PRIVATE_PROVIDER_CONFIGURATION_CAUSE");
        },
        executor: { execute: executor },
      },
    );

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([
      "provider_unavailable: Quick-start provider configuration is unavailable.",
    ]);
    expect(capture.stderr.join("\n")).not.toContain("PRIVATE");
    expect(executor).not.toHaveBeenCalled();
    await expect(stat(join(project, ".flow", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects configuration discovery that no longer resolves to the published project", async () => {
    const project = await temporaryDirectory("flow-quickstart-config-drift-");
    const otherProject = await temporaryDirectory("flow-quickstart-config-drift-other-");
    const capture = createCapture();
    const executor = vi.fn();

    const exitCode = await main(["quickstart", project], capture.io, {
      cwd: project,
      readTextFile: async () => FOUNDATION_WORKFLOW,
      loadConfig: async () => resolveFlowConfig({ projectRoot: otherProject }),
      executor: { execute: executor },
    });

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(["execution_failed: Quick-start workflow execution failed."]);
    expect(executor).not.toHaveBeenCalled();
    await expect(stat(join(project, ".flow", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(otherProject, ".flow", "runs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    {
      label: "missing model",
      args: ["--provider", "anthropic"],
      message: "--provider and --model must be specified together",
    },
    {
      label: "missing provider",
      args: ["--model", "claude-sonnet-4-6"],
      message: "--provider and --model must be specified together",
    },
    {
      label: "repeated provider",
      args: ["--provider", "anthropic", "--provider", "anthropic", "--model", "model"],
      message: "--provider may be specified only once",
    },
    {
      label: "repeated model",
      args: ["--provider", "anthropic", "--model", "model", "--model", "model"],
      message: "--model may be specified only once",
    },
    {
      label: "repeated run id",
      args: ["--run-id", "one", "--run-id", "two"],
      message: "--run-id may be specified only once",
    },
    {
      label: "unsafe run id",
      args: ["--run-id", "../PRIVATE_RUN"],
      message: "Quick-start input is invalid",
    },
    {
      label: "extra directory",
      args: ["one", "two"],
      message: "quickstart accepts at most one directory",
    },
    {
      label: "unknown option",
      args: ["--PRIVATE-option"],
      message: "quickstart arguments are invalid",
    },
  ])("rejects $label before project mutation", async ({ args, message }) => {
    const capture = createCapture();
    const initializeProject = vi.fn();

    const exitCode = await main(["quickstart", ...args], capture.io, { initializeProject });

    expect(exitCode).toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("\n")).toContain(message);
    expect(capture.stderr.join("\n")).not.toContain("PRIVATE");
    expect(initializeProject).not.toHaveBeenCalled();
  });

  it.each([
    { storeCode: "already_exists" as const, publicCode: "project_exists" },
    { storeCode: "commit_uncertain" as const, publicCode: "publication_uncertain" },
    { storeCode: "settlement_uncertain" as const, publicCode: "publication_uncertain" },
    { storeCode: "io" as const, publicCode: "publication_failed" },
  ])("maps $storeCode project publication without private output", async (fixture) => {
    const capture = createCapture();
    const executor = vi.fn();

    const exitCode = await main(["quickstart", "/workspace/PRIVATE_PROJECT"], capture.io, {
      readTextFile: async () => FOUNDATION_WORKFLOW,
      initializeProject: async () => {
        throw new FlowConfigStoreError(fixture.storeCode, "PRIVATE_PROJECT_STORE_CAUSE");
      },
      executor: { execute: executor },
    });

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("\n")).toContain(`${fixture.publicCode}:`);
    expect(capture.stderr.join("\n")).not.toContain("PRIVATE");
    expect(executor).not.toHaveBeenCalled();
  });

  it("publishes fixed prepublication cancellation without calling the initializer", async () => {
    const controller = new AbortController();
    const reason = new Error("PRIVATE_PREPUBLICATION_REASON");
    controller.abort(reason);
    const initializeProject = vi.fn();
    const capture = createCapture();

    const exitCode = await main(["quickstart"], capture.io, {
      signal: controller.signal,
      initializeProject,
    });

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(["Quick start was cancelled before project publication."]);
    expect(initializeProject).not.toHaveBeenCalled();
  });

  it("reports cancellation after project publication without entering execution", async () => {
    const project = await temporaryDirectory("flow-quickstart-late-cancel-");
    const controller = new AbortController();
    const executor = vi.fn();
    const capture = createCapture();

    const exitCode = await main(["quickstart", project], capture.io, {
      signal: controller.signal,
      readTextFile: async () => FOUNDATION_WORKFLOW,
      initializeProject: async (directory) => {
        const { initializeFlowProject } = await import(
          "../../../src/infrastructure/fs/flow-config-store.js"
        );
        const published = await initializeFlowProject(directory);
        controller.abort(new Error("PRIVATE_POSTPUBLICATION_REASON"));
        return published;
      },
      executor: { execute: executor },
    });

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([
      "cancelled_after_publication: Quick start stopped after project publication; inspect the project before retrying.",
    ]);
    expect(executor).not.toHaveBeenCalled();
    await expect(lstat(join(project, ".flow", "config.yaml"))).resolves.toMatchObject({});
    await expect(stat(join(project, ".flow", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns durable follow-up commands for an accepted failed run", async () => {
    const project = await temporaryDirectory("flow-quickstart-failed-run-");
    const capture = createCapture();

    const exitCode = await main(
      ["quickstart", project, "--run-id", "accepted-failure"],
      capture.io,
      {
        cwd: project,
        readTextFile: async () => FOUNDATION_WORKFLOW,
        loadConfig: async (options) => resolveFlowConfig({ projectRoot: options?.cwd ?? project }),
        executor: failingExecutor(),
      },
    );

    expect(exitCode).toBe(1);
    const result = JSON.parse(capture.stdout.join("\n"));
    expect(result).toMatchObject({
      run: { id: "accepted-failure", status: "failed" },
      commands: {
        inspect: ["flow", "inspect", "accepted-failure"],
        browser: ["flow", "web", "accepted-failure", "--actor", "operator:quickstart"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});

function createCapture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

function successfulExecutor(): NodeExecutor {
  return {
    async execute(node) {
      return { status: "succeeded", evidence: commandEvidence(node.id) };
    },
  };
}

function providerExecutor(phases: string[]): NodeExecutor {
  return {
    async execute(node) {
      if (node.type === "command") {
        return { status: "succeeded", evidence: commandEvidence(node.id) };
      }
      if (node.type !== "agent") {
        throw new Error("unexpected quick-start provider node");
      }
      phases.push(`execute:${node.agent.model.provider}/${node.agent.model.id}`);
      const text = "Provider configuration is ready.";
      return {
        status: "succeeded",
        evidence: {
          kind: "agent",
          provider: node.agent.model.provider,
          model: node.agent.model.id,
          text,
          textHash: createHash("sha256").update(text).digest("hex"),
          textTruncated: false,
          durationMs: 1,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdMicros: 0,
          },
          policyDecisions: [],
          effectReceipts: [],
        },
      };
    },
  };
}

function failingExecutor(): NodeExecutor {
  return {
    async execute(node) {
      return {
        status: "failed",
        error: {
          code: "command_failed",
          message: "PRIVATE_COMMAND_FAILURE",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: commandEvidence(node.id),
      };
    },
  };
}

function commandEvidence(nodeId: string) {
  const stdout = nodeId;
  return {
    kind: "command" as const,
    executable: process.execPath,
    args: ["-e", nodeId],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: createHash("sha256").update(stdout).digest("hex"),
    stderrHash: createHash("sha256").update("").digest("hex"),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
