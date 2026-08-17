import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { NodeExecutionOutcome, NodeExecutor } from "../../../src/application/ports.js";
import { prepareEffectiveHarnessActivation } from "../../../src/application/prepare-effective-harness-activation.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import { createEffectiveHarnessCandidateArtifact } from "../../../src/domain/adaptation/effective-harness-candidate.js";
import {
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
} from "../../../src/domain/adaptation/effective-harness-state.js";
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
import { LocalEffectiveHarnessStore } from "../../../src/infrastructure/fs/local-effective-harness-store.js";
import {
  effectiveHarnessCandidateArtifactFixture,
  superiorEffectiveHarnessEvaluation,
} from "../../fixtures/effective-harness-evaluation.js";
import { promptActivationInput } from "../../fixtures/prompt-activation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("effective harness runtime CLI", () => {
  it("runs the exact effective workflow and package closure", async () => {
    const project = await temporaryProject();
    const runsDirectory = join(project, "runs");
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const prepared = prepareEffectiveHarnessActivation({
      artifact,
      stored: superiorEffectiveHarnessEvaluation(artifact),
    });
    const store = new LocalEffectiveHarnessStore(project, {
      readInitialHead: async () => artifact.baselineHead,
    });
    const proposal = await store.previewActivate({ prepared, actor: "operator:test" });
    const applied = await store.applyActivate({
      prepared,
      actor: "operator:test",
      expectedDigest: proposal.proposalDigest,
    });
    const observedResources: string[] = [];
    const executor: NodeExecutor = {
      execute: async (node, context) => {
        if (node.type !== "agent" || context.capabilitySnapshot === undefined) {
          throw new Error("effective runtime fixture expected only Agent nodes");
        }
        const selected = node.agent.skills.map((name) => {
          const skill = context.capabilitySnapshot?.packages.find(
            (item): item is AgentSkillPackageSnapshot =>
              item.kind === "agent-skill" && item.name === name,
          );
          if (skill === undefined) throw new Error("effective runtime skill is missing");
          const resource = skill.files.find((file) => file.path !== "SKILL.md");
          if (resource !== undefined) {
            observedResources.push(Buffer.from(resource.contentBase64, "base64").toString("utf8"));
          }
          return skill.name;
        });
        return successfulAgentOutcome(
          selected.length === 0
            ? undefined
            : createAgentCapabilityEvidence(context.capabilitySnapshot, selected),
        );
      },
    };
    const runOutput = captureIo();

    expect(
      await main(
        [
          "run",
          `activation:${artifact.workflowId}`,
          "--run-id",
          "effective-runtime-run",
          "--runs-dir",
          runsDirectory,
        ],
        runOutput.io,
        dependencies(project, executor),
      ),
      JSON.stringify({ stdout: runOutput.stdout, stderr: runOutput.stderr }),
    ).toBe(0);
    expect(observedResources).not.toEqual([]);
    expectContentFree(runOutput, observedResources);
    const state = JSON.parse(runOutput.stdout.at(-1) ?? "null");
    expect(state.capabilitySnapshot).toMatchObject({
      effectiveHarness: {
        workflowId: artifact.workflowId,
        head: { headDigest: applied.head.headDigest },
        runtimeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      packages: artifact.candidateState.packages.map((item) => ({
        kind: item.kind,
        digest: item.digest,
      })),
    });
    expect(state.capabilitySnapshot.activations).toBeUndefined();
  });

  it("resumes from durable effective authority after the live store is removed", async () => {
    const project = await temporaryProject();
    const runsDirectory = join(project, "runs");
    const artifact = approvalEffectiveHarnessArtifact();
    await activateArtifact(project, artifact);
    const calls: string[] = [];
    const executor: NodeExecutor = {
      execute: async (node) => {
        calls.push(node.id);
        return node.type === "command"
          ? successfulCommandOutcome(node.command.executable, node.command.args)
          : successfulAgentOutcome(undefined);
      },
    };
    const runOutput = captureIo();

    expect(
      await main(
        [
          "run",
          `activation:${artifact.workflowId}`,
          "--run-id",
          "effective-runtime-recovery",
          "--runs-dir",
          runsDirectory,
        ],
        runOutput.io,
        dependencies(project, executor),
      ),
      JSON.stringify({ stdout: runOutput.stdout, stderr: runOutput.stderr }),
    ).toBe(3);
    expect(calls).toEqual([]);
    const waiting = JSON.parse(runOutput.stdout.at(-1) ?? "null");
    const requestId = waiting.nodes.gate.approval.requestId as string;

    await rm(join(project, ".flow", "effective-harness"), { recursive: true });
    const approvalOutput = captureIo();
    expect(
      await main(
        [
          "approve",
          "effective-runtime-recovery",
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
    const resumeOutput = captureIo();
    expect(
      await main(
        [
          "resume",
          `activation:${artifact.workflowId}`,
          "--run-id",
          "effective-runtime-recovery",
          "--runs-dir",
          runsDirectory,
        ],
        resumeOutput.io,
        dependencies(project, executor),
      ),
      resumeOutput.stderr.join("\n"),
    ).toBe(0);
    expect(calls).toEqual(["gate", "implement"]);
    expectContentFree(runOutput, []);
    expectContentFree(approvalOutput, []);
    expectContentFree(resumeOutput, []);
  });
});

async function activateArtifact(
  project: string,
  artifact: ReturnType<typeof approvalEffectiveHarnessArtifact>,
) {
  const prepared = prepareEffectiveHarnessActivation({
    artifact,
    stored: superiorEffectiveHarnessEvaluation(artifact),
  });
  const store = new LocalEffectiveHarnessStore(project, {
    readInitialHead: async () => artifact.baselineHead,
  });
  const proposal = await store.previewActivate({ prepared, actor: "operator:test" });
  return await store.applyActivate({
    prepared,
    actor: "operator:test",
    expectedDigest: proposal.proposalDigest,
  });
}

function approvalEffectiveHarnessArtifact() {
  const scopeDigest = "a".repeat(64);
  const baselineInput = promptActivationInput({
    requiresApproval: true,
    selection: "baseline",
  });
  const candidateInput = promptActivationInput({ requiresApproval: true });
  const baselineState = createEffectiveHarnessState({
    scopeDigest,
    workflowSource: baselineInput.source,
    packages: [],
  });
  const candidateState = createEffectiveHarnessState({
    scopeDigest,
    workflowSource: candidateInput.source,
    packages: [],
  });
  return createEffectiveHarnessCandidateArtifact({
    baselineHead: createEffectiveHarnessHeadIdentity({
      scopeDigest,
      workflowId: baselineState.workflowId,
      generation: 1,
      activationDigest: "b".repeat(64),
      transitionDigest: "c".repeat(64),
      stateDigest: baselineState.stateDigest,
    }),
    baselineState,
    candidateState,
    candidate: candidateInput.candidate,
  });
}

async function temporaryProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-effective-runtime-cli-")));
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
  capabilities: ReturnType<typeof createAgentCapabilityEvidence> | undefined,
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
      ...(capabilities === undefined ? {} : { capabilities }),
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

function expectContentFree(
  output: ReturnType<typeof captureIo>,
  privateValues: readonly string[],
): void {
  const text = [...output.stdout, ...output.stderr].join("\n");
  expect(text).not.toContain("contentBase64");
  for (const value of privateValues) {
    expect(text).not.toContain(value);
    expect(text).not.toContain(Buffer.from(value).toString("base64"));
  }
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
