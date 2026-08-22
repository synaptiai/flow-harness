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
  type EffectiveHarnessState,
} from "../../../src/domain/adaptation/effective-harness-state.js";
import { createPromptActivationSnapshot } from "../../../src/domain/adaptation/prompt-activation.js";
import {
  parseSupplementalMemoryCandidateText,
  projectSupplementalMemoryCandidate,
} from "../../../src/domain/adaptation/supplemental-memory-candidate.js";
import {
  type AgentSkillPackageSnapshot,
  calculateCapabilitySnapshotDigest,
  createAgentCapabilityEvidence,
} from "../../../src/domain/capability/agent-skills.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { admitLocalEffectiveHarnessCandidate } from "../../../src/infrastructure/fs/local-effective-harness-candidate.js";
import {
  calculateLocalEffectiveHarnessScopeDigest,
  LocalEffectiveHarnessStore,
} from "../../../src/infrastructure/fs/local-effective-harness-store.js";
import { LocalEvaluationStore } from "../../../src/infrastructure/fs/local-evaluation-store.js";
import { LocalPromptActivationStore } from "../../../src/infrastructure/fs/local-prompt-activation-store.js";
import { childSpecialistCandidateInstructions } from "../../fixtures/child-specialist-candidate.js";
import {
  childSpecialistEffectiveHarnessCandidateArtifactFixture,
  effectiveHarnessCandidateArtifactFixture,
  superiorEffectiveHarnessEvaluation,
  supplementalMemoryGenerationEvidenceProvenance,
  supplementalMemoryRelationshipEffectiveHarnessCandidateArtifactFixture,
  supplementalMemoryRelationshipEvidenceRunId,
} from "../../fixtures/effective-harness-evaluation.js";
import { modelRoutingCandidateSourceFixture } from "../../fixtures/model-routing-candidate.js";
import { promptActivationInput } from "../../fixtures/prompt-activation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("effective harness runtime CLI", () => {
  it("runs an activated child specialist from immutable state without live candidate input", async () => {
    const project = await temporaryProject();
    const runsDirectory = join(project, "runs");
    const artifact = childSpecialistEffectiveHarnessCandidateArtifactFixture(
      await calculateLocalEffectiveHarnessScopeDigest(project),
    );
    await activateArtifact(project, artifact);
    const candidatePath = join(project, "PRIVATE_SPECIALIST_CANDIDATE");
    const baselinePath = join(project, "PRIVATE_SPECIALIST_BASELINE");
    await writeFile(candidatePath, childSpecialistCandidateInstructions);
    await writeFile(baselinePath, "PRIVATE_BASELINE_CONTENT");
    await Promise.all([rm(candidatePath), rm(baselinePath)]);
    const observed: Array<{
      readonly id: string;
      readonly prompt: string;
      readonly skills: string[];
    }> = [];

    const output = captureIo();
    const exitCode = await main(
      [
        "run",
        `activation:${artifact.workflowId}`,
        "--run-id",
        "child-specialist-runtime",
        "--runs-dir",
        runsDirectory,
      ],
      output.io,
      dependencies(project, {
        execute: async (node, context) => {
          if (node.type !== "agent" || context.capabilitySnapshot === undefined) {
            throw new Error("child-specialist runtime expected only Agent execution");
          }
          observed.push({
            id: node.id,
            prompt: node.agent.prompt,
            skills: [...node.agent.skills],
          });
          return successfulAgentOutcome(
            createAgentCapabilityEvidence(context.capabilitySnapshot, node.agent.skills),
          );
        },
      }),
    );
    const publicState = JSON.parse(output.stdout.at(-1) ?? "null");
    expect({
      exitCode,
      stderr: output.stderr,
      state: publicState,
    }).toMatchObject({ exitCode: 0, stderr: [], state: { status: "succeeded" } });
    expect(observed).toEqual([
      {
        id: "review",
        prompt: childSpecialistCandidateInstructions,
        skills: ["review-checklist"],
      },
      {
        id: "security-reference",
        prompt: "Retain the admitted security review capability.",
        skills: ["security-checklist"],
      },
    ]);
    expectContentFree(output, [childSpecialistCandidateInstructions, "PRIVATE_BASELINE_CONTENT"]);
  });

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

  it("activates and rolls back a composed model route without live candidate sources", async () => {
    const project = await temporaryProject();
    const evaluations = join(project, "evaluations");
    const baselineInput = promptActivationInput({ selection: "baseline" });
    const candidateInput = promptActivationInput({ selection: "candidate" });
    const baselineSnapshot = createPromptActivationSnapshot(baselineInput);
    const candidateSnapshot = createPromptActivationSnapshot(candidateInput);
    const legacy = new LocalPromptActivationStore(project);
    const legacyActivation = {
      snapshot: candidateSnapshot,
      baselineSnapshot,
      actor: "operator:legacy",
    };
    const legacyProposal = await legacy.previewActivate(legacyActivation);
    await legacy.applyActivate({
      ...legacyActivation,
      expectedDigest: legacyProposal.proposalDigest,
    });
    const legacyRollback = {
      workflowId: baselineSnapshot.workflowId,
      target: null,
      actor: "operator:legacy",
    } as const;
    const legacyRollbackProposal = await legacy.previewRollback(legacyRollback);
    await legacy.applyRollback({
      ...legacyRollback,
      expectedDigest: legacyRollbackProposal.proposalDigest,
    });

    const routeSource = modelRoutingCandidateSourceFixture(baselineInput.source);
    const baselinePath = join(project, routeSource.baseline.workflow.path);
    const routePath = join(project, "private-route.candidate.yaml");
    await writeFile(baselinePath, baselineInput.source);
    await writeFile(routePath, JSON.stringify(routeSource));
    const composeOutput = captureIo();
    expect(
      await main(["candidate", "compose", routePath], composeOutput.io, {
        cwd: project,
        loadConfig: async () => effectiveConfig(project),
      }),
      composeOutput.stderr.join("\n"),
    ).toBe(0);
    const composed = JSON.parse(composeOutput.stdout.join("\n"));
    const stagedPath = join(project, composed.staged.path);
    const admitted = await admitLocalEffectiveHarnessCandidate(stagedPath);
    const artifact = admitted.artifact;
    await persistEvaluation(evaluations, superiorEffectiveHarnessEvaluation(artifact));
    await Promise.all([rm(routePath), rm(baselinePath)]);

    const previewOutput = captureIo();
    const cliDependencies = { cwd: project, loadConfig: async () => effectiveConfig(project) };
    expect(
      await main(
        [
          "candidate",
          "activate",
          stagedPath,
          "--evaluation",
          "effective-harness-evaluation",
          "--evaluations-dir",
          evaluations,
          "--actor",
          "operator:route",
          "--dry-run",
        ],
        previewOutput.io,
        cliDependencies,
      ),
      previewOutput.stderr.join("\n"),
    ).toBe(0);
    const preview = JSON.parse(previewOutput.stdout.join("\n"));
    expect(preview).toMatchObject({
      dryRun: true,
      activation: {
        surface: "model-routing",
        candidate: {
          kind: "model-routing-candidate",
          route: routeSource.route,
        },
      },
      proposal: {
        action: "activate",
        artifactDigest: artifact.artifactDigest,
        proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const applyOutput = captureIo();
    expect(
      await main(
        [
          "candidate",
          "activate",
          stagedPath,
          "--evaluation",
          "effective-harness-evaluation",
          "--evaluations-dir",
          evaluations,
          "--actor",
          "operator:route",
          "--expected-digest",
          preview.proposal.proposalDigest,
        ],
        applyOutput.io,
        cliDependencies,
      ),
      applyOutput.stderr.join("\n"),
    ).toBe(0);
    await rm(evaluations, { recursive: true });

    const active = await new LocalEffectiveHarnessStore(project).loadActive(artifact.workflowId);
    expect(
      compileWorkflowText(
        Buffer.from(active.state.workflow.contentBase64, "base64").toString("utf8"),
        "active model route",
      ).nodes.find((node) => node.id === routeSource.scope.nodeId),
    ).toMatchObject({ type: "agent", agent: { model: routeSource.route.after } });

    const observedRoutes: unknown[] = [];
    const runOutput = captureIo();
    expect(
      await main(
        [
          "run",
          `activation:${artifact.workflowId}`,
          "--run-id",
          "model-routing-runtime",
          "--runs-dir",
          join(project, "route-runs"),
        ],
        runOutput.io,
        dependencies(project, {
          execute: async (node) => {
            if (node.type !== "agent") throw new Error("routing runtime expected an Agent node");
            observedRoutes.push(node.agent.model);
            return successfulAgentOutcome(undefined);
          },
        }),
      ),
      runOutput.stderr.join("\n"),
    ).toBe(0);
    expect(observedRoutes).toEqual([routeSource.route.after]);
    expectContentFree(runOutput, [baselineInput.source, candidateInput.source]);
    expect([...runOutput.stdout, ...runOutput.stderr].join("\n")).not.toContain(routePath);

    const inspectOutput = captureIo();
    expect(
      await main(["activation", "inspect", artifact.workflowId], inspectOutput.io, cliDependencies),
    ).toBe(0);
    expect(JSON.parse(inspectOutput.stdout.join("\n"))).toMatchObject({
      effectiveHarness: {
        head: { stateDigest: artifact.candidateState.stateDigest },
        history: [{ surface: "model-routing" }],
      },
    });

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
          "operator:route",
          "--dry-run",
        ],
        rollbackPreviewOutput.io,
        cliDependencies,
      ),
    ).toBe(0);
    const rollbackPreview = JSON.parse(rollbackPreviewOutput.stdout.join("\n"));
    const rollbackOutput = captureIo();
    expect(
      await main(
        [
          "activation",
          "rollback",
          artifact.workflowId,
          "--to",
          `state:${artifact.baselineState.stateDigest}`,
          "--actor",
          "operator:route",
          "--expected-digest",
          rollbackPreview.proposal.proposalDigest,
        ],
        rollbackOutput.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(rollbackOutput.stdout.join("\n"))).toMatchObject({
      status: "rolled_back",
      head: { stateDigest: artifact.baselineState.stateDigest },
    });
    for (const output of [
      composeOutput,
      previewOutput,
      applyOutput,
      runOutput,
      inspectOutput,
      rollbackOutput,
    ]) {
      expectContentFree(output, [baselineInput.source, candidateInput.source]);
      expect([...output.stdout, ...output.stderr].join("\n")).not.toContain(routePath);
    }
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

  it("runs activated supplemental-memory relationships and exposes only review identities", async () => {
    const project = await temporaryProject();
    const privateMemory = "PRIVATE_MEMORY_USE_THE_REVIEWED_FIXTURE";
    const artifact = supplementalMemoryRelationshipEffectiveHarnessCandidateArtifactFixture(
      await calculateLocalEffectiveHarnessScopeDigest(project),
    );
    await activateArtifact(project, artifact);
    const observedMemory: Array<string | undefined> = [];
    const runOutput = captureIo();

    expect(
      await main(
        [
          "run",
          `activation:${artifact.workflowId}`,
          "--run-id",
          "supplemental-memory-runtime",
          "--runs-dir",
          join(project, "memory-runs"),
        ],
        runOutput.io,
        dependencies(project, {
          execute: async (node, context) => {
            if (node.type !== "agent") {
              throw new Error("supplemental-memory runtime expected one Agent node");
            }
            observedMemory.push(context.agentSupplementalMemory);
            return successfulAgentOutcome(undefined);
          },
        }),
      ),
      runOutput.stderr.join("\n"),
    ).toBe(0);
    expect(observedMemory).toEqual([expect.stringContaining("<supplemental_memory>")]);
    expect(observedMemory[0]).toContain(privateMemory);
    expect(observedMemory[0]).toContain("<supplemental_memory_relationships>");
    expect(observedMemory[0]).toContain('predicate="supports"');
    expect(observedMemory[0]).not.toContain(supplementalMemoryRelationshipEvidenceRunId);
    expect(observedMemory[0]).not.toContain("eventDigest");
    const publicState = JSON.parse(runOutput.stdout.at(-1) ?? "null");
    expect(publicState.capabilitySnapshot.effectiveHarness.supplementalMemory).toEqual(
      expect.arrayContaining([
        {
          id: "reviewed-fixture",
          target: {
            workflowId: artifact.workflowId,
            childPath: [],
            agentNodeId: "implement",
          },
          bytes: Buffer.byteLength(privateMemory),
          sha256: sha256(privateMemory),
        },
      ]),
    );
    expect(publicState.capabilitySnapshot.effectiveHarness.supplementalMemoryRelationships).toEqual(
      relationshipSummary(artifact.candidateState),
    );
    expectContentFree(runOutput, [
      privateMemory,
      supplementalMemoryGenerationEvidenceProvenance,
      supplementalMemoryRelationshipEvidenceRunId,
    ]);

    const inspectOutput = captureIo();
    expect(
      await main(["activation", "inspect", artifact.workflowId], inspectOutput.io, {
        cwd: project,
        loadConfig: async () => effectiveConfig(project),
      }),
      inspectOutput.stderr.join("\n"),
    ).toBe(0);
    const inspected = JSON.parse(inspectOutput.stdout.join("\n"));
    expect(inspected.effectiveHarness.active.supplementalMemory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reviewed-fixture",
          target: expect.objectContaining({
            workflowId: artifact.workflowId,
            agentNodeId: "implement",
          }),
          bytes: Buffer.byteLength(privateMemory),
          sha256: sha256(privateMemory),
        }),
      ]),
    );
    expect(inspected.effectiveHarness.active.supplementalMemoryRelationships).toEqual(
      relationshipSummary(artifact.candidateState),
    );
    expectContentFree(inspectOutput, [
      privateMemory,
      supplementalMemoryGenerationEvidenceProvenance,
      supplementalMemoryRelationshipEvidenceRunId,
    ]);
  });

  it("resumes from durable effective authority after the live store is removed", async () => {
    const project = await temporaryProject();
    const runsDirectory = join(project, "runs");
    const artifact = approvalSupplementalMemoryArtifact(
      await calculateLocalEffectiveHarnessScopeDigest(project),
    );
    const privateMemory = "PRIVATE_DURABLE_APPROVAL_MEMORY";
    await activateArtifact(project, artifact);
    const calls: string[] = [];
    const observedMemory: string[] = [];
    const executor: NodeExecutor = {
      execute: async (node, context) => {
        calls.push(node.id);
        if (node.type === "agent" && context.agentSupplementalMemory !== undefined) {
          observedMemory.push(context.agentSupplementalMemory);
        }
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
    expect(observedMemory).toHaveLength(1);
    expect(observedMemory[0]).toContain(privateMemory);
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
    expectContentFree(runOutput, [privateMemory]);
    expectContentFree(approvalOutput, [privateMemory]);
    expectContentFree(resumeOutput, [privateMemory]);
    expectContentFree(inspectOutput, [privateMemory]);
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

function approvalSupplementalMemoryArtifact(scopeDigest: string) {
  const baselineInput = promptActivationInput({
    requiresApproval: true,
    selection: "baseline",
  });
  const baselineState = createEffectiveHarnessState({
    scopeDigest,
    workflowSource: baselineInput.source,
    packages: [],
  });
  const privateMemory = "PRIVATE_DURABLE_APPROVAL_MEMORY";
  const sourceText = JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "SupplementalMemoryCandidate",
    metadata: { id: "durable-approval-memory", version: "1.0.0" },
    scope: {
      kind: "workflow-agent-memory",
      workflowId: baselineState.workflowId,
      childPath: [],
      agentNodeId: "implement",
      entryId: "approval-guidance",
    },
    baseline: {
      stateDigest: baselineState.stateDigest,
      workflowDigest: baselineState.workflow.workflowDigest,
      packageClosureDigest: calculateCapabilitySnapshotDigest(baselineState.packages),
    },
    change: { kind: "add", value: privateMemory },
  });
  const projected = projectSupplementalMemoryCandidate({
    manifestProvenance: "PRIVATE_MEMORY_CANDIDATE_PATH",
    sourceSha256: sha256(sourceText),
    source: parseSupplementalMemoryCandidateText(sourceText),
    baseline: baselineState,
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
    candidateState: projected.state,
    candidate: projected.identity,
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function relationshipSummary(state: EffectiveHarnessState) {
  const assessment = state.supplementalMemoryRelationships?.assessment;
  if (assessment === undefined) throw new Error("relationship assessment fixture is missing");
  return {
    relationshipCount: assessment.relationshipCount,
    evidenceReferenceCount: assessment.evidenceReferenceCount,
    unresolvedContradictionCount: assessment.unresolvedContradictionCount,
    relationshipSetDigest: assessment.relationshipSetDigest,
    assessmentDigest: assessment.digest,
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
