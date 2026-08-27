import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeExecutorRouter } from "../../../src/application/node-executor-router.js";
import type {
  AgentExecutor,
  CommandExecutor,
  NodeExecutor,
} from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import { resolveFlowConfig } from "../../../src/domain/config/resolver.js";
import {
  FlowConfigStoreError,
  QUICKSTART_CODING_EXPECTED_SOURCE,
  QUICKSTART_CODING_FIXTURE_PATH,
  QUICKSTART_CODING_FIXTURE_SOURCE,
} from "../../../src/infrastructure/fs/flow-config-store.js";
import {
  EmbeddedPiAgentRunner,
  PiAgentExecutor,
} from "../../../src/infrastructure/pi/pi-agent-executor.js";

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

  it("runs the explicit coding path and exposes deterministic durable evidence", async () => {
    const project = await temporaryDirectory("flow-quickstart-coding-");
    const phases: string[] = [];
    const capture = createCapture();

    const exitCode = await main(
      ["quickstart", project, "--coding", "--provider", "openai", "--model", "gpt-5.6-luna"],
      capture.io,
      {
        cwd: project,
        loadConfig: async (options) => resolveFlowConfig({ projectRoot: options?.cwd ?? project }),
        inspectProviders: async (requirements) => {
          phases.push(`inspect:${requirements[0]?.provider}/${requirements[0]?.model}`);
        },
        executor: codingExecutor(phases, "exact"),
      },
    );

    expect(exitCode, capture.stderr.join("\n")).toBe(0);
    expect(phases).toEqual([
      "inspect:openai/gpt-5.6-luna",
      "agent:read,ls,edit",
      "verifier:exact-bytes",
    ]);
    expect(JSON.parse(capture.stdout.join("\n"))).toEqual({
      version: 1,
      mode: "coding",
      project: { publication: "created", fixture: QUICKSTART_CODING_FIXTURE_PATH },
      run: {
        id: "quickstart-coding",
        status: "succeeded",
        evidence: ".flow/runs/quickstart-coding/events.jsonl",
      },
      commands: {
        inspect: ["flow", "inspect", "quickstart-coding"],
        browser: ["flow", "web", "quickstart-coding", "--actor", "operator:quickstart"],
      },
    });
    await expect(readFile(join(project, QUICKSTART_CODING_FIXTURE_PATH), "utf8")).resolves.toBe(
      QUICKSTART_CODING_EXPECTED_SOURCE,
    );

    const inspect = createCapture();
    expect(
      await main(["inspect", "quickstart-coding"], inspect.io, {
        cwd: project,
        loadConfig: async (options) => resolveFlowConfig({ projectRoot: options?.cwd ?? project }),
      }),
    ).toBe(0);
    expect(JSON.parse(inspect.stdout.join("\n"))).toMatchObject({
      status: "succeeded",
      budget: {
        limits: {
          maxNodeStarts: 2,
          maxModelTokens: 8_192,
          maxCostUsdMicros: 250_000,
          maxExecutionMs: 120_000,
          maxArtifactBytes: 131_072,
        },
      },
      goal: {
        status: "accepted",
        criteria: { "fixture-is-exact": { status: "accepted" } },
      },
      nodes: {
        implement: {
          status: "succeeded",
          evidence: {
            kind: "agent",
            provider: "openai",
            model: "gpt-5.6-luna",
            usage: { inputTokens: 10, outputTokens: 4, costUsdMicros: 1_000 },
          },
        },
        verify: {
          status: "succeeded",
          evidence: { kind: "verifier", driver: "command", verdict: "accepted" },
        },
      },
    });
  });

  it("records real Pi read and edit evidence before deterministic coding verification", async () => {
    const project = await temporaryDirectory("flow-quickstart-coding-effects-");
    const capture = createCapture();
    const runtime = await deterministicCodingRuntime();
    const executor = new NodeExecutorRouter(
      codingCommandExecutor([]),
      new PiAgentExecutor(new EmbeddedPiAgentRunner(async () => runtime)),
    );

    const exitCode = await main(
      [
        "quickstart",
        project,
        "--coding",
        "--provider",
        "openai",
        "--model",
        "deterministic",
        "--run-id",
        "quickstart-coding-effects",
      ],
      capture.io,
      {
        cwd: project,
        loadConfig: async (options) => resolveFlowConfig({ projectRoot: options?.cwd ?? project }),
        inspectProviders: async () => undefined,
        executor,
      },
    );

    expect(exitCode, [...capture.stderr, ...capture.stdout].join("\n")).toBe(0);
    const inspect = createCapture();
    expect(
      await main(["inspect", "quickstart-coding-effects"], inspect.io, {
        cwd: project,
        loadConfig: async (options) => resolveFlowConfig({ projectRoot: options?.cwd ?? project }),
      }),
    ).toBe(0);
    expect(JSON.parse(inspect.stdout.join("\n"))).toMatchObject({
      status: "succeeded",
      goal: {
        status: "accepted",
        criteria: { "fixture-is-exact": { status: "accepted" } },
      },
      nodes: {
        implement: {
          evidence: {
            kind: "agent",
            provider: "openai",
            model: "deterministic",
            policyDecisions: [
              expect.objectContaining({ action: "filesystem.read", outcome: "allowed" }),
              expect.objectContaining({ action: "filesystem.write", outcome: "allowed" }),
            ],
            effectReceipts: [
              expect.objectContaining({
                kind: "filesystem.edit",
                beforeSha256: sha256(QUICKSTART_CODING_FIXTURE_SOURCE),
                afterSha256: sha256(QUICKSTART_CODING_EXPECTED_SOURCE),
                outcome: "committed",
              }),
            ],
          },
        },
        verify: {
          evidence: { kind: "verifier", driver: "command", verdict: "accepted" },
        },
      },
    });
  });

  it.each([
    { label: "unchanged fixture", behavior: "claim-only" as const, canary: "status: pending" },
    { label: "one changed byte", behavior: "one-byte" as const, canary: "status: Verified" },
    { label: "extra trailing bytes", behavior: "extra-bytes" as const, canary: "PRIVATE_EXTRA" },
  ])("rejects a model completion claim with $label", async ({ behavior, canary }) => {
    const project = await temporaryDirectory("flow-quickstart-coding-unverified-");
    const capture = createCapture();

    const exitCode = await main(
      [
        "quickstart",
        project,
        "--coding",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-6",
      ],
      capture.io,
      {
        cwd: project,
        loadConfig: async (options) => resolveFlowConfig({ projectRoot: options?.cwd ?? project }),
        inspectProviders: async () => undefined,
        executor: codingExecutor([], behavior),
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(capture.stdout.join("\n"))).toMatchObject({
      mode: "coding",
      run: { id: "quickstart-coding", status: "failed" },
    });
    const inspect = createCapture();
    expect(
      await main(["inspect", "quickstart-coding"], inspect.io, {
        cwd: project,
        loadConfig: async (options) => resolveFlowConfig({ projectRoot: options?.cwd ?? project }),
      }),
    ).toBe(0);
    expect(JSON.parse(inspect.stdout.join("\n"))).toMatchObject({
      status: "failed",
      goal: {
        status: "not_accepted",
        criteria: { "fixture-is-exact": { status: "rejected" } },
      },
      nodes: {
        implement: { status: "succeeded" },
        verify: {
          status: "failed",
          evidence: { kind: "verifier", driver: "command", verdict: "rejected" },
        },
      },
    });
    expect(capture.stderr.join("\n")).not.toContain(canary);
    expect(inspect.stdout.join("\n")).not.toContain(canary);
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
    {
      label: "coding without provider",
      args: ["--coding"],
      message: "--coding requires --provider and --model",
    },
    {
      label: "repeated coding mode",
      args: ["--coding", "--coding", "--provider", "openai", "--model", "gpt-5.6-luna"],
      message: "--coding may be specified only once",
    },
    {
      label: "unsupported coding provider",
      args: ["--coding", "--provider", "google", "--model", "gemini-3.1-pro-preview"],
      message: "Quick-start input is invalid",
    },
  ])("rejects $label before project mutation", async ({ args, message }) => {
    const capture = createCapture();
    const initializeProject = vi.fn();
    const initializeCodingProject = vi.fn();

    const exitCode = await main(["quickstart", ...args], capture.io, {
      initializeProject,
      initializeCodingProject,
    });

    expect(exitCode).toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("\n")).toContain(message);
    expect(capture.stderr.join("\n")).not.toContain("PRIVATE");
    expect(initializeProject).not.toHaveBeenCalled();
    expect(initializeCodingProject).not.toHaveBeenCalled();
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

type CodingAgentBehavior = "claim-only" | "exact" | "extra-bytes" | "one-byte";

function codingExecutor(phases: string[], behavior: CodingAgentBehavior): NodeExecutor {
  const agent: AgentExecutor = {
    async execute(node, context) {
      phases.push(`agent:${node.agent.tools.join(",")}`);
      expect(node.id).toBe("implement");
      expect(node.agent.tools).toEqual(["read", "ls", "edit"]);
      expect(node.agent.timeoutMs).toBe(90_000);
      if (behavior === "exact") {
        await writeFile(
          join(context.cwd, QUICKSTART_CODING_FIXTURE_PATH),
          QUICKSTART_CODING_EXPECTED_SOURCE,
          "utf8",
        );
      } else if (behavior === "one-byte") {
        await writeFile(
          join(context.cwd, QUICKSTART_CODING_FIXTURE_PATH),
          QUICKSTART_CODING_EXPECTED_SOURCE.replace("status: verified", "status: Verified"),
          "utf8",
        );
      } else if (behavior === "extra-bytes") {
        await writeFile(
          join(context.cwd, QUICKSTART_CODING_FIXTURE_PATH),
          `${QUICKSTART_CODING_EXPECTED_SOURCE}PRIVATE_EXTRA\n`,
          "utf8",
        );
      }
      const text = "The requested edit is complete.";
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
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdMicros: 1_000,
          },
          policyDecisions: [],
          effectReceipts: [],
        },
      };
    },
  };
  return new NodeExecutorRouter(codingCommandExecutor(phases), agent);
}

function codingCommandExecutor(phases: string[]): CommandExecutor {
  return {
    async execute(node, context) {
      expect(node.command.executable).toBe("node");
      expect(node.command.args[0]).toBe("-e");
      expect(node.command.args.join(" ")).toContain(QUICKSTART_CODING_FIXTURE_PATH);
      expect(node.command.timeoutMs).toBe(10_000);
      const result = await executeCompiledVerifier(node.command, context.cwd);
      const exact = result.exitCode === 0;
      phases.push(`verifier:${exact ? "exact-bytes" : "rejected"}`);
      const evidence = commandEvidenceWithExit(
        node.id,
        result.exitCode,
        node.command.executable,
        node.command.args,
        result.stdout,
        result.stderr,
      );
      if (exact) {
        return { status: "succeeded", evidence };
      }
      return {
        status: "failed",
        error: {
          code: "command_failed",
          message: "coding quick-start fixture verification failed",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence,
      };
    },
  };
}

async function executeCompiledVerifier(
  command: { readonly executable: string; readonly args: readonly string[] },
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      command.executable,
      command.args,
      { cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        let exitCode = 0;
        if (error !== null) {
          if (typeof error.code !== "number") {
            reject(error);
            return;
          }
          exitCode = error.code;
        }
        resolve({
          exitCode,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function deterministicCodingRuntime(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  runtime.registerProvider("openai", {
    name: "Flow deterministic coding provider",
    api: "openai-completions",
    baseUrl: "https://flow.test.invalid/v1",
    apiKey: "test-only-key",
    models: [
      {
        id: "deterministic",
        name: "Deterministic coding model",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65_536,
        maxTokens: 256,
      },
    ],
    streamSimple: (model, context) => {
      const stream = createAssistantMessageEventStream();
      const invocation = context.messages.filter((message) => message.role === "assistant").length;
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (invocation < 2) {
          const toolCall = {
            type: "toolCall" as const,
            id: `flow-quickstart-call-${invocation + 1}`,
            name: invocation === 0 ? "flow_read" : "flow_edit",
            arguments:
              invocation === 0
                ? { path: QUICKSTART_CODING_FIXTURE_PATH }
                : {
                    path: QUICKSTART_CODING_FIXTURE_PATH,
                    expectedSha256: extractReadVersionFromContext(context.messages),
                    edits: [{ oldText: "status: pending", newText: "status: verified" }],
                  },
          };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          const block = { type: "text" as const, text: "FLOW_CODING_QUICKSTART_OK" };
          message.content.push(block);
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: block.text,
            partial: message,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: block.text,
            partial: message,
          });
          message.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end();
      });
      return stream;
    },
  });
  return runtime;
}

function extractReadVersionFromContext(
  messages: readonly { readonly role: string; readonly content?: unknown }[],
): string {
  const readResult = [...messages]
    .reverse()
    .find(
      (message): message is { readonly role: "toolResult"; readonly content: unknown } =>
        message.role === "toolResult",
    );
  const match = JSON.stringify(readResult?.content).match(/sha256:([a-f0-9]{64})/);
  if (match?.[1] === undefined) {
    throw new Error("deterministic coding provider did not observe the Flow read version");
  }
  return match[1];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandEvidence(nodeId: string) {
  return commandEvidenceWithExit(nodeId, 0);
}

function commandEvidenceWithExit(
  nodeId: string,
  exitCode: number,
  executable = process.execPath,
  args: readonly string[] = ["-e", nodeId],
  stdout = nodeId,
  stderr = "",
) {
  return {
    kind: "command" as const,
    executable,
    args,
    exitCode,
    signal: null,
    stdout,
    stderr,
    stdoutHash: createHash("sha256").update(stdout).digest("hex"),
    stderrHash: createHash("sha256").update(stderr).digest("hex"),
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
