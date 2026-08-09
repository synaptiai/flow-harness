import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import { createPromptActivationSnapshot } from "../../../src/domain/adaptation/prompt-activation.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import type { RunEvent } from "../../../src/domain/run/events.js";
import { LocalPromptActivationStore } from "../../../src/infrastructure/fs/local-prompt-activation-store.js";
import { promptActivationInput } from "../../fixtures/prompt-activation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("prompt activation CLI", () => {
  it("requires one activation mutation mode", async () => {
    const project = await temporaryProject();
    const missing = captureIo();
    const conflicting = captureIo();
    const common = [
      "candidate",
      "activate",
      "candidate.yaml",
      "--evaluation",
      "evaluation-1",
      "--actor",
      "operator:test",
    ];

    expect(await main(common, missing.io, { cwd: project })).toBe(2);
    expect(missing.stderr.join("\n")).toMatch(/requires exactly one/);
    expect(
      await main([...common, "--dry-run", "--expected-digest", "f".repeat(64)], conflicting.io, {
        cwd: project,
      }),
    ).toBe(2);
    expect(conflicting.stderr.join("\n")).toMatch(/requires exactly one/);
  });

  it("runs the exact active source and saves it before a later rollback", async () => {
    const project = await temporaryProject();
    const baselinePath = join(project, "baseline.workflow.yaml");
    const baseline = "baseline remains unchanged\n";
    await writeFile(baselinePath, baseline, "utf8");
    const activationStore = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const activationInput = {
      snapshot,
      baselineSnapshot: createPromptActivationSnapshot(
        promptActivationInput({ selection: "baseline" }),
      ),
      actor: "release-operator",
    };
    const preview = await activationStore.previewActivate(activationInput);
    await activationStore.applyActivate({
      ...activationInput,
      expectedDigest: preview.proposalDigest,
    });
    const runStore = new MemoryStore();
    let observed: NodeExecutionContext | undefined;
    const observedPrompts: string[] = [];
    const executor: NodeExecutor = {
      execute: vi.fn(async (node, context) => {
        observed = context;
        if (node.type === "agent") {
          observedPrompts.push(node.agent.prompt);
        }
        return successfulAgentOutcome();
      }),
    };
    const output = captureIo();

    expect(
      await main(
        ["run", "activation:adaptive-workflow", "--run-id", "active-workflow-run"],
        output.io,
        dependencies(project, { executor, createStore: () => runStore }),
      ),
    ).toBe(0);
    expect(observed?.capabilitySnapshot?.activations).toEqual([snapshot]);
    expect(runStore.events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: { activations: [{ activationDigest: snapshot.activationDigest }] },
    });
    expect(await readFile(baselinePath, "utf8")).toBe(baseline);

    const rollbackInput = {
      workflowId: "adaptive-workflow",
      target: null,
      actor: "release-operator",
    };
    const rollbackPreview = await activationStore.previewRollback(rollbackInput);
    await activationStore.applyRollback({
      ...rollbackInput,
      expectedDigest: rollbackPreview.proposalDigest,
    });
    expect(runStore.events[0]).toMatchObject({
      capabilitySnapshot: { activations: [{ activationDigest: snapshot.activationDigest }] },
    });
    const baselineOutput = captureIo();
    expect(
      await main(
        ["run", "activation:adaptive-workflow", "--run-id", "baseline-workflow-run"],
        baselineOutput.io,
        dependencies(project, { executor, createStore: () => new MemoryStore() }),
      ),
      baselineOutput.stderr.join("\n"),
    ).toBe(0);
    expect(observedPrompts).toEqual(["Read TASK.md and verify the result.", "Implement the task."]);
  });

  it("resumes from durable source after rollback and live-store removal", async () => {
    const project = await temporaryProject();
    const runsDirectory = join(project, "runs");
    const activationStore = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(
      promptActivationInput({ requiresApproval: true }),
    );
    const activationInput = {
      snapshot,
      baselineSnapshot: createPromptActivationSnapshot(
        promptActivationInput({ requiresApproval: true, selection: "baseline" }),
      ),
      actor: "release-operator",
    };
    const activationPreview = await activationStore.previewActivate(activationInput);
    await activationStore.applyActivate({
      ...activationInput,
      expectedDigest: activationPreview.proposalDigest,
    });
    const calls: string[] = [];
    const executor: NodeExecutor = {
      execute: vi.fn(async (node) => {
        calls.push(node.id);
        if (node.type === "command") {
          return successfulCommandOutcome(node.command.executable, node.command.args);
        }
        return successfulAgentOutcome();
      }),
    };
    const runOutput = captureIo();

    expect(
      await main(
        [
          "run",
          "activation:adaptive-workflow",
          "--run-id",
          "durable-activation-run",
          "--runs-dir",
          runsDirectory,
        ],
        runOutput.io,
        dependencies(project, { executor }),
      ),
    ).toBe(3);
    expect(calls).toEqual([]);
    const waitingState = JSON.parse(runOutput.stdout[0] ?? "null");
    const requestId = waitingState.nodes.gate.approval.requestId as string;

    const rollbackInput = {
      workflowId: "adaptive-workflow",
      target: null,
      actor: "release-operator",
    };
    const rollbackPreview = await activationStore.previewRollback(rollbackInput);
    await activationStore.applyRollback({
      ...rollbackInput,
      expectedDigest: rollbackPreview.proposalDigest,
    });
    await rm(join(project, ".flow", "activations"), { recursive: true });

    expect(
      await main(
        [
          "approve",
          "durable-activation-run",
          requestId,
          "--actor",
          "operator:test",
          "--runs-dir",
          runsDirectory,
        ],
        captureIo().io,
        dependencies(project),
      ),
    ).toBe(0);
    const resumeOutput = captureIo();
    expect(
      await main(
        [
          "resume",
          "activation:adaptive-workflow",
          "--run-id",
          "durable-activation-run",
          "--runs-dir",
          runsDirectory,
        ],
        resumeOutput.io,
        dependencies(project, { executor }),
      ),
    ).toBe(0);
    expect(calls).toEqual(["gate", "implement"]);
    expect(JSON.parse(resumeOutput.stdout[0] ?? "null")).toMatchObject({ status: "succeeded" });
  });
});

class MemoryStore implements RecoverableRunEventStore {
  readonly events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async claim(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async release(): Promise<void> {}
}

async function temporaryProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-activation-cli-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow"), { recursive: true });
  return project;
}

function successfulAgentOutcome(): NodeExecutionOutcome {
  const text = JSON.stringify("done");
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text,
      textHash: createHash("sha256").update(text).digest("hex"),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [],
      effectReceipts: [],
    },
  };
}

function successfulCommandOutcome(
  executable: string,
  args: readonly string[],
): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: {
      kind: "command",
      executable,
      args,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutHash: createHash("sha256").update("").digest("hex"),
      stderrHash: createHash("sha256").update("").digest("hex"),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
    },
  };
}

function dependencies(project: string, extra: Record<string, unknown> = {}) {
  return {
    cwd: project,
    loadConfig: async () => effectiveConfig(project),
    ...extra,
  };
}

function effectiveConfig(projectRoot: string): EffectiveFlowConfig {
  const supervisor = { ...BUILT_IN_FLOW_CONFIG };
  return {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
    policyDigest: calculateFlowPolicyDigest(supervisor),
    projectRoot,
    sources: {
      builtIn: BUILT_IN_FLOW_CONFIG,
      operator: null,
      project: { path: join(projectRoot, ".flow", "config.yaml"), values: {} },
    },
  };
}

function captureIo(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
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
