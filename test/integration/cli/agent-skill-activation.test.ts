import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutionOutcome, NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import { createAgentSkillActivationSnapshot } from "../../../src/domain/adaptation/agent-skill-activation.js";
import {
  type AgentSkillPackageSnapshot,
  createAgentCapabilityEvidence,
} from "../../../src/domain/capability/agent-skills.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import { LocalPromptActivationStore } from "../../../src/infrastructure/fs/local-prompt-activation-store.js";
import { LocalSupervisorStore } from "../../../src/infrastructure/fs/local-supervisor-store.js";
import { startSupervisorServer } from "../../../src/supervisor/daemon.js";
import type { WorkerLauncher } from "../../../src/supervisor/service.js";
import { agentSkillActivationInput } from "../../fixtures/agent-skill-activation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Agent Skill activation CLI", () => {
  it("resumes from the durable workflow and package after the activation store is removed", async () => {
    const project = await temporaryProject();
    const runsDirectory = join(project, "runs");
    const store = new LocalPromptActivationStore(project);
    const snapshot = createAgentSkillActivationSnapshot(
      agentSkillActivationInput("candidate", { requiresApproval: true }),
    );
    const baselineSnapshot = createAgentSkillActivationSnapshot(
      agentSkillActivationInput("baseline", { requiresApproval: true }),
    );
    const activation = { snapshot, baselineSnapshot, actor: "release-operator" };
    const preview = await store.previewActivate(activation);
    await store.applyActivate({ ...activation, expectedDigest: preview.proposalDigest });

    const calls: string[] = [];
    const observedResources: string[] = [];
    const executor: NodeExecutor = {
      execute: async (node, context) => {
        calls.push(node.id);
        if (node.type === "command") {
          return successfulCommandOutcome(node.command.executable, node.command.args);
        }
        if (node.type !== "agent" || context.capabilitySnapshot === undefined) {
          throw new Error("Agent Skill recovery test expected an admitted agent snapshot");
        }
        const skill = context.capabilitySnapshot.packages.find(
          (item): item is AgentSkillPackageSnapshot => item.kind === "agent-skill",
        );
        const resource = skill?.files.find((file) => file.path === "references/checklist.md");
        if (skill === undefined || resource === undefined) {
          throw new Error("Agent Skill recovery test snapshot is incomplete");
        }
        observedResources.push(Buffer.from(resource.contentBase64, "base64").toString("utf8"));
        return successfulAgentOutcome(
          createAgentCapabilityEvidence(context.capabilitySnapshot, [skill.name]),
        );
      },
    };
    const runOutput = captureIo();

    expect(
      await main(
        [
          "run",
          "activation:adaptive-skill-workflow",
          "--run-id",
          "durable-skill-activation-run",
          "--runs-dir",
          runsDirectory,
        ],
        runOutput.io,
        dependencies(project, executor),
      ),
      runOutput.stderr.join("\n"),
    ).toBe(3);
    expect(calls).toEqual([]);
    const waitingState = JSON.parse(runOutput.stdout[0] ?? "null");
    const requestId = waitingState.nodes.gate.approval.requestId as string;
    expectPublicOutputContentFree(runOutput);

    await rm(join(project, ".flow", "activations"), { recursive: true });
    const approvalOutput = captureIo();
    expect(
      await main(
        [
          "approve",
          "durable-skill-activation-run",
          requestId,
          "--actor",
          "operator:test",
          "--runs-dir",
          runsDirectory,
        ],
        approvalOutput.io,
        dependencies(project, executor),
      ),
    ).toBe(0);
    expectPublicOutputContentFree(approvalOutput);
    const resumeOutput = captureIo();
    expect(
      await main(
        [
          "resume",
          "activation:adaptive-skill-workflow",
          "--run-id",
          "durable-skill-activation-run",
          "--runs-dir",
          runsDirectory,
        ],
        resumeOutput.io,
        dependencies(project, executor),
      ),
      resumeOutput.stderr.join("\n"),
    ).toBe(0);
    expect(calls).toEqual(["gate", "review"]);
    expect(observedResources).toEqual(["Check correctness, security, and evidence.\n"]);
    expectPublicOutputContentFree(resumeOutput);

    const inspectOutput = captureIo();
    expect(
      await main(
        ["inspect", "durable-skill-activation-run", "--runs-dir", runsDirectory],
        inspectOutput.io,
        dependencies(project, executor),
      ),
    ).toBe(0);
    expectPublicOutputContentFree(inspectOutput);

    const running = await startSupervisorServer({
      store: new LocalSupervisorStore(runsDirectory),
      launcher: unavailableLauncher,
      policy: effectiveConfig(project),
    });
    const pagedEventsOutput = captureIo();
    try {
      expect(
        await main(
          ["events", "durable-skill-activation-run", "--runs-dir", runsDirectory],
          pagedEventsOutput.io,
          dependencies(project, executor),
        ),
        pagedEventsOutput.stderr.join("\n"),
      ).toBe(0);
      expectPublicOutputContentFree(pagedEventsOutput);

      const followedEventsOutput = captureIo();
      expect(
        await main(
          ["events", "durable-skill-activation-run", "--runs-dir", runsDirectory, "--follow"],
          followedEventsOutput.io,
          dependencies(project, executor),
        ),
        followedEventsOutput.stderr.join("\n"),
      ).toBe(0);
      expectPublicOutputContentFree(followedEventsOutput);
    } finally {
      await running.close();
    }
  });

  function expectPublicOutputContentFree(output: ReturnType<typeof captureIo>): void {
    const text = [...output.stdout, ...output.stderr].join("\n");
    expect(text).not.toContain("contentBase64");
    expect(text).not.toContain("Check correctness, security, and evidence.");
    expect(text).not.toContain(
      Buffer.from("Check correctness, security, and evidence.\n").toString("base64"),
    );
  }
});

const unavailableLauncher: WorkerLauncher = {
  async launch() {
    throw new Error("not used");
  },
  async request() {
    throw new Error("not used");
  },
};

async function temporaryProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-agent-skill-activation-cli-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow"), { recursive: true });
  return project;
}

function dependencies(project: string, executor: NodeExecutor) {
  return {
    cwd: project,
    loadConfig: async () => effectiveConfig(project),
    executor,
  };
}

function effectiveConfig(projectRoot: string): EffectiveFlowConfig {
  const supervisor = { ...BUILT_IN_FLOW_CONFIG };
  return {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
    sandbox: { profile: "native" },
    policyDigest: calculateFlowPolicyDigest(supervisor),
    projectRoot,
    sources: {
      builtIn: BUILT_IN_FLOW_CONFIG,
      operator: null,
      project: { path: join(projectRoot, ".flow", "config.yaml"), values: {} },
    },
  };
}

function successfulAgentOutcome(
  capabilities: ReturnType<typeof createAgentCapabilityEvidence>,
): NodeExecutionOutcome {
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
      capabilities,
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

function captureIo(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}
