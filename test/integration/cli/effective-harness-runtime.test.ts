import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { NodeExecutionOutcome, NodeExecutor } from "../../../src/application/ports.js";
import { prepareEffectiveHarnessActivation } from "../../../src/application/prepare-effective-harness-activation.js";
import {
  loadEffectiveHarnessCandidateBaseline,
  projectEffectiveHarnessCandidate,
} from "../../../src/application/prepare-effective-harness-candidate.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import {
  createEffectiveHarnessCandidateArtifact,
  encodeEffectiveHarnessCandidateArtifact,
} from "../../../src/domain/adaptation/effective-harness-candidate.js";
import {
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
} from "../../../src/domain/adaptation/effective-harness-state.js";
import { createPromptActivationSnapshot } from "../../../src/domain/adaptation/prompt-activation.js";
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
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import {
  calculateLocalEffectiveHarnessScopeDigest,
  LocalEffectiveHarnessStore,
} from "../../../src/infrastructure/fs/local-effective-harness-store.js";
import { LocalEvaluationStore } from "../../../src/infrastructure/fs/local-evaluation-store.js";
import { LocalPromptActivationStore } from "../../../src/infrastructure/fs/local-prompt-activation-store.js";
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
  it("validates an effective harness artifact through a content-free public view", async () => {
    const project = await temporaryProject();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const candidatePath = join(project, "candidate.effective-harness.json");
    await writeFile(candidatePath, encodeEffectiveHarnessCandidateArtifact(artifact));
    const output = captureIo();

    expect(
      await main(["candidate", "validate", candidatePath], output.io, { cwd: project }),
      output.stderr.join("\n"),
    ).toBe(0);
    expect(JSON.parse(output.stdout.join("\n"))).toEqual({
      valid: true,
      candidate: {
        kind: artifact.kind,
        artifactDigest: artifact.artifactDigest,
        scopeDigest: artifact.scopeDigest,
        workflowId: artifact.workflowId,
        surface: artifact.surface,
        candidate: artifact.candidate,
        baselineHeadDigest: artifact.baselineHead.headDigest,
        baselineStateDigest: artifact.baselineState.stateDigest,
        candidateStateDigest: artifact.candidateState.stateDigest,
      },
    });
    expectContentFree(output, [
      Buffer.from(artifact.baselineState.workflow.contentBase64, "base64").toString("utf8"),
      Buffer.from(artifact.candidateState.workflow.contentBase64, "base64").toString("utf8"),
    ]);
  });

  it("previews and activates an evaluated effective harness artifact", async () => {
    const project = await temporaryProject();
    const evaluations = join(project, "evaluations");
    const legacy = new LocalPromptActivationStore(project);
    const candidateSnapshot = createPromptActivationSnapshot(promptActivationInput());
    const baselineSnapshot = createPromptActivationSnapshot(
      promptActivationInput({ selection: "baseline" }),
    );
    const legacyProposal = await legacy.previewActivate({
      snapshot: candidateSnapshot,
      baselineSnapshot,
      actor: "operator:legacy",
    });
    await legacy.applyActivate({
      snapshot: candidateSnapshot,
      baselineSnapshot,
      actor: "operator:legacy",
      expectedDigest: legacyProposal.proposalDigest,
    });
    const rollbackInput = {
      workflowId: baselineSnapshot.workflowId,
      target: null,
      actor: "operator:legacy",
    } as const;
    const rollbackProposal = await legacy.previewRollback(rollbackInput);
    await legacy.applyRollback({
      ...rollbackInput,
      expectedDigest: rollbackProposal.proposalDigest,
    });
    const baseline = await loadEffectiveHarnessCandidateBaseline({
      scopeDigest: await calculateLocalEffectiveHarnessScopeDigest(project),
      workflowId: baselineSnapshot.workflowId,
      store: legacy,
    });
    const next = promptActivationInput();
    const projected = projectEffectiveHarnessCandidate({
      baseline: baseline.state,
      candidate: {
        kind: "prompt",
        baselineWorkflowSource: promptActivationInput({ selection: "baseline" }).source,
        projection: {
          identity: next.candidate,
          workflow: {
            source: next.source,
            sourceSha256: next.candidate.projectedWorkflow.sourceSha256,
            compiled: compileWorkflowText(next.source, "candidate.effective-harness.json"),
            workflowDigest: next.candidate.projectedWorkflow.workflowDigest,
          },
        },
      },
    });
    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead: baseline.head,
      baselineState: baseline.state,
      candidateState: projected.state,
      candidate: next.candidate,
    });
    const candidatePath = join(project, "candidate.effective-harness.json");
    await writeFile(candidatePath, encodeEffectiveHarnessCandidateArtifact(artifact));
    await persistEvaluation(evaluations, superiorEffectiveHarnessEvaluation(artifact));

    const previewOutput = captureIo();
    expect(
      await main(
        [
          "candidate",
          "activate",
          candidatePath,
          "--evaluation",
          "effective-harness-evaluation",
          "--evaluations-dir",
          evaluations,
          "--actor",
          "operator:test",
          "--dry-run",
        ],
        previewOutput.io,
        { cwd: project, loadConfig: async () => effectiveConfig(project) },
      ),
      previewOutput.stderr.join("\n"),
    ).toBe(0);
    const preview = JSON.parse(previewOutput.stdout.join("\n"));
    expect(preview).toMatchObject({
      dryRun: true,
      activation: {
        kind: artifact.kind,
        artifactDigest: artifact.artifactDigest,
        candidateStateDigest: artifact.candidateState.stateDigest,
      },
      proposal: {
        action: "activate",
        workflowId: artifact.workflowId,
        artifactDigest: artifact.artifactDigest,
        proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expectContentFree(previewOutput, [next.source]);

    const applyOutput = captureIo();
    expect(
      await main(
        [
          "candidate",
          "activate",
          candidatePath,
          "--evaluation",
          "effective-harness-evaluation",
          "--evaluations-dir",
          evaluations,
          "--actor",
          "operator:test",
          "--expected-digest",
          preview.proposal.proposalDigest,
        ],
        applyOutput.io,
        { cwd: project, loadConfig: async () => effectiveConfig(project) },
      ),
      applyOutput.stderr.join("\n"),
    ).toBe(0);
    expect(JSON.parse(applyOutput.stdout.join("\n"))).toMatchObject({
      status: "activated",
      head: {
        workflowId: artifact.workflowId,
        stateDigest: artifact.candidateState.stateDigest,
      },
    });
    expectContentFree(applyOutput, [next.source]);

    const listOutput = captureIo();
    const inspectOutput = captureIo();
    const cliDependencies = {
      cwd: project,
      loadConfig: async () => effectiveConfig(project),
    };
    expect(await main(["activation", "list"], listOutput.io, cliDependencies)).toBe(0);
    expect(
      await main(["activation", "inspect", artifact.workflowId], inspectOutput.io, cliDependencies),
    ).toBe(0);
    expect(JSON.parse(listOutput.stdout.join("\n"))).toMatchObject({
      effectiveHarness: {
        heads: [
          {
            workflowId: artifact.workflowId,
            stateDigest: artifact.candidateState.stateDigest,
          },
        ],
        history: [{ action: "activate", artifactDigest: artifact.artifactDigest }],
      },
    });
    expect(JSON.parse(inspectOutput.stdout.join("\n"))).toMatchObject({
      workflowId: artifact.workflowId,
      effectiveHarness: {
        head: { stateDigest: artifact.candidateState.stateDigest },
        active: {
          kind: "effective-harness-state",
          stateDigest: artifact.candidateState.stateDigest,
          workflow: {
            bytes: artifact.candidateState.workflow.bytes,
            sha256: artifact.candidateState.workflow.sha256,
          },
        },
      },
    });
    expectContentFree(listOutput, [next.source]);
    expectContentFree(inspectOutput, [next.source]);

    const rollbackPreviewOutput = captureIo();
    expect(
      await main(
        [
          "activation",
          "rollback",
          artifact.workflowId,
          "--to",
          `state:${artifact.baselineState.stateDigest}`,
          "--actor",
          "operator:test",
          "--dry-run",
        ],
        rollbackPreviewOutput.io,
        cliDependencies,
      ),
    ).toBe(0);
    const rollbackPreview = JSON.parse(rollbackPreviewOutput.stdout.join("\n"));
    expect(rollbackPreview).toMatchObject({
      dryRun: true,
      proposal: {
        action: "rollback",
        targetStateDigest: artifact.baselineState.stateDigest,
        proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const rollbackApplyOutput = captureIo();
    expect(
      await main(
        [
          "activation",
          "rollback",
          artifact.workflowId,
          "--to",
          `state:${artifact.baselineState.stateDigest}`,
          "--actor",
          "operator:test",
          "--expected-digest",
          rollbackPreview.proposal.proposalDigest,
        ],
        rollbackApplyOutput.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(rollbackApplyOutput.stdout.join("\n"))).toMatchObject({
      status: "rolled_back",
      head: { stateDigest: artifact.baselineState.stateDigest },
    });
    expectContentFree(rollbackPreviewOutput, [next.source]);
    expectContentFree(rollbackApplyOutput, [next.source]);
  });

  it("runs the exact effective workflow and package closure", async () => {
    const project = await temporaryProject();
    const runsDirectory = join(project, "runs");
    const artifact = effectiveArtifactForScope(
      await calculateLocalEffectiveHarnessScopeDigest(project),
    );
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
    const artifact = approvalEffectiveHarnessArtifact(
      await calculateLocalEffectiveHarnessScopeDigest(project),
    );
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
    const inspectOutput = captureIo();
    expect(
      await main(
        ["inspect", "effective-runtime-recovery", "--runs-dir", runsDirectory],
        inspectOutput.io,
        { cwd: project, loadConfig: async () => effectiveConfig(project) },
      ),
    ).toBe(0);
    expect(JSON.parse(inspectOutput.stdout.join("\n"))).toMatchObject({
      status: "succeeded",
      capabilitySnapshot: {
        effectiveHarness: {
          workflowId: artifact.workflowId,
          runtimeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expectContentFree(runOutput, []);
    expectContentFree(approvalOutput, []);
    expectContentFree(resumeOutput, []);
    expectContentFree(inspectOutput, []);
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

async function persistEvaluation(
  directory: string,
  stored: ReturnType<typeof superiorEffectiveHarnessEvaluation>,
): Promise<void> {
  const store = new LocalEvaluationStore(directory);
  await store.create(stored.header);
  await store.claim(stored.header.evaluationId, stored.header.planDigest);
  for (const record of stored.records) {
    await store.append(stored.header.evaluationId, record);
  }
  await store.release(stored.header.evaluationId);
}

function approvalEffectiveHarnessArtifact(scopeDigest: string) {
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

function effectiveArtifactForScope(scopeDigest: string) {
  const fixture = effectiveHarnessCandidateArtifactFixture();
  const baselineState = createEffectiveHarnessState({
    scopeDigest,
    workflowSource: Buffer.from(fixture.baselineState.workflow.contentBase64, "base64").toString(
      "utf8",
    ),
    packages: fixture.baselineState.packages,
  });
  const candidateState = createEffectiveHarnessState({
    scopeDigest,
    workflowSource: Buffer.from(fixture.candidateState.workflow.contentBase64, "base64").toString(
      "utf8",
    ),
    rootPackage: fixture.candidateState.rootPackage,
    packages: fixture.candidateState.packages,
  });
  return createEffectiveHarnessCandidateArtifact({
    baselineHead: createEffectiveHarnessHeadIdentity({
      scopeDigest,
      workflowId: baselineState.workflowId,
      generation: fixture.baselineHead.generation,
      activationDigest: fixture.baselineHead.activationDigest,
      transitionDigest: fixture.baselineHead.transitionDigest,
      stateDigest: baselineState.stateDigest,
    }),
    baselineState,
    candidateState,
    candidate: fixture.candidate,
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
