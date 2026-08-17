import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareEffectiveHarnessActivation } from "../../../src/application/prepare-effective-harness-activation.js";
import { projectEffectiveHarnessCandidate } from "../../../src/application/prepare-effective-harness-candidate.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import {
  calculateAgentSkillCandidateIdentityDigest,
  type ProjectedAgentSkillCandidate,
} from "../../../src/domain/adaptation/agent-skill-candidate.js";
import { createEffectiveHarnessCandidateArtifact } from "../../../src/domain/adaptation/effective-harness-candidate.js";
import {
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
  type EffectiveHarnessState,
  effectiveHarnessWorkflowSource,
} from "../../../src/domain/adaptation/effective-harness-state.js";
import { createPromptActivationSnapshot } from "../../../src/domain/adaptation/prompt-activation.js";
import {
  calculatePromptCandidateIdentityDigest,
  type ProjectedPromptCandidate,
} from "../../../src/domain/adaptation/prompt-candidate.js";
import { completePromptCandidateGeneration } from "../../../src/domain/adaptation/prompt-candidate-generation.js";
import {
  type AgentSkillCapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import { admitLocalAdaptationCandidate } from "../../../src/infrastructure/fs/local-adaptation-candidate.js";
import { admitLocalEffectiveHarnessCandidate } from "../../../src/infrastructure/fs/local-effective-harness-candidate.js";
import {
  calculateLocalEffectiveHarnessScopeDigest,
  LocalEffectiveHarnessStore,
} from "../../../src/infrastructure/fs/local-effective-harness-store.js";
import { LocalPromptActivationStore } from "../../../src/infrastructure/fs/local-prompt-activation-store.js";
import { agentSkillActivationInput } from "../../fixtures/agent-skill-activation.js";
import { superiorEffectiveHarnessEvaluation } from "../../fixtures/effective-harness-evaluation.js";
import { promptActivationInput } from "../../fixtures/prompt-activation.js";
import { promptCandidateGenerationFixture } from "../../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("effective harness composition CLI", () => {
  it("stages one complete prompt candidate against the exact active baseline", async () => {
    const project = await realpath(await mkdtemp(join(tmpdir(), "flow-effective-compose-")));
    temporaryDirectories.push(project);
    await mkdir(join(project, ".flow"));
    const fixture = promptCandidateGenerationFixture();
    const baselinePath = join(project, fixture.input.baseline.provenance);
    const evidencePath = join(project, fixture.input.evidence[0]?.provenance ?? "missing.json");
    const candidatePath = join(project, "generated.prompt-candidate.json");
    const source = completePromptCandidateGeneration(
      fixture.prepared,
      JSON.stringify({
        changes: [{ nodeId: "implement", value: "Read TASK.md and verify the result." }],
      }),
      {
        inputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        costUsdMicros: 1,
      },
    );
    await writeFile(baselinePath, fixture.baselineText);
    await writeFile(evidencePath, JSON.stringify(fixture.evidence));
    await writeFile(candidatePath, JSON.stringify(source));
    const admitted = await admitLocalAdaptationCandidate(candidatePath);
    if (admitted.kind !== "prompt-candidate") {
      throw new Error("composition fixture is not a prompt candidate");
    }
    const proof = promptActivationInput().evaluation;
    const candidateSnapshot = createPromptActivationSnapshot({
      selection: "candidate",
      candidate: admitted.candidate.identity,
      evaluation: proof,
      source: admitted.candidate.workflow.source,
    });
    const baselineSnapshot = createPromptActivationSnapshot({
      selection: "baseline",
      candidate: admitted.candidate.identity,
      evaluation: proof,
      source: admitted.candidate.baseline.sourceText,
    });
    const legacy = new LocalPromptActivationStore(project);
    const activation = {
      snapshot: candidateSnapshot,
      baselineSnapshot,
      actor: "operator:legacy",
    };
    const activationProposal = await legacy.previewActivate(activation);
    await legacy.applyActivate({
      ...activation,
      expectedDigest: activationProposal.proposalDigest,
    });
    const rollback = {
      workflowId: baselineSnapshot.workflowId,
      target: null,
      actor: "operator:legacy",
    } as const;
    const rollbackProposal = await legacy.previewRollback(rollback);
    await legacy.applyRollback({ ...rollback, expectedDigest: rollbackProposal.proposalDigest });

    const output = captureIo();
    expect(
      await main(["candidate", "compose", candidatePath], output.io, {
        cwd: project,
        loadConfig: async () => effectiveConfig(project),
      }),
      output.stderr.join("\n"),
    ).toBe(0);
    const composed = JSON.parse(output.stdout.join("\n"));
    expect(composed).toMatchObject({
      composed: true,
      candidate: {
        kind: "effective-harness-candidate",
        workflowId: baselineSnapshot.workflowId,
        surface: "prompt",
        artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        baselineHeadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        baselineStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        candidateStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      staged: {
        path: expect.stringMatching(/^\.flow\/effective-harness\/artifacts\/[a-f0-9]{64}\.json$/),
        artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(composed.staged.artifactDigest).toBe(composed.candidate.artifactDigest);
    expect([...output.stdout, ...output.stderr].join("\n")).not.toContain(
      "Read TASK.md and verify the result.",
    );
    expect(await new LocalEffectiveHarnessStore(project).list()).toMatchObject({
      heads: [],
      history: [],
    });

    await Promise.all([rm(candidatePath), rm(baselinePath), rm(evidencePath)]);
    await expect(
      admitLocalEffectiveHarnessCandidate(join(project, composed.staged.path)),
    ).resolves.toMatchObject({
      artifact: {
        artifactDigest: composed.candidate.artifactDigest,
        baselineHead: { headDigest: composed.candidate.baselineHeadDigest },
        baselineState: { stateDigest: composed.candidate.baselineStateDigest },
        candidateState: { stateDigest: composed.candidate.candidateStateDigest },
        candidate: admitted.candidate.identity,
      },
    });
  });

  it.each([
    ["prompt then skill", ["prompt", "skill"] as const],
    ["skill then prompt", ["skill", "prompt"] as const],
  ])("retains both reviewed improvements after %s activation", async (_label, order) => {
    const project = await realpath(await mkdtemp(join(tmpdir(), "flow-effective-sequence-")));
    temporaryDirectories.push(project);
    await mkdir(join(project, ".flow"));
    const scopeDigest = await calculateLocalEffectiveHarnessScopeDigest(project);
    const skill = agentSkillActivationInput("baseline");
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: skill.workflowSource,
      packages: [skill.skill],
    });
    let head = createEffectiveHarnessHeadIdentity({
      scopeDigest,
      workflowId: baseline.workflowId,
      generation: 1,
      activationDigest: "a".repeat(64),
      transitionDigest: "b".repeat(64),
      stateDigest: baseline.stateDigest,
    });
    let state = baseline;
    const store = new LocalEffectiveHarnessStore(project, {
      readInitialHead: async () => head,
    });

    for (const surface of order) {
      const projection =
        surface === "prompt" ? promptProjectionFor(state) : skillProjectionFor(state);
      const projected = projectEffectiveHarnessCandidate({
        baseline: state,
        candidate:
          surface === "prompt"
            ? { kind: "prompt", projection: projection as ProjectedPromptCandidate }
            : {
                kind: "agent-skill-resource",
                projection: projection as ProjectedAgentSkillCandidate,
              },
      });
      const artifact = createEffectiveHarnessCandidateArtifact({
        baselineHead: head,
        baselineState: state,
        candidateState: projected.state,
        candidate: projection.identity,
      });
      const prepared = prepareEffectiveHarnessActivation({
        artifact,
        stored: superiorEffectiveHarnessEvaluation(artifact),
      });
      const proposal = await store.previewActivate({ prepared, actor: "operator:sequence" });
      const applied = await store.applyActivate({
        prepared,
        actor: "operator:sequence",
        expectedDigest: proposal.proposalDigest,
      });
      head = applied.head;
      state = projected.state;
    }

    const active = await store.loadActive(baseline.workflowId);
    const selectedSkill = active.state.packages.find(
      (item) => item.kind === "agent-skill" && item.name === "review",
    );
    expect(effectiveHarnessWorkflowSource(active.state)).toContain(
      "Use the refined review prompt.",
    );
    expect(selectedSkill).toMatchObject({
      kind: "agent-skill",
      digest: agentSkillActivationInput("candidate").skill.digest,
    });
    expect(active.head.stateDigest).toBe(active.state.stateDigest);
    expect((await store.list()).history.map((item) => item.surface)).toEqual(
      order.map((surface) => (surface === "skill" ? "agent-skill-resource" : surface)),
    );
  });
});

function promptProjectionFor(baseline: EffectiveHarnessState): ProjectedPromptCandidate {
  const sourceValue = JSON.parse(effectiveHarnessWorkflowSource(baseline)) as {
    nodes: Array<{ id: string; type: string; agent?: { prompt: string } }>;
  };
  const agent = sourceValue.nodes.find((node) => node.id === "review" && node.type === "agent");
  if (agent?.agent === undefined) throw new Error("composition prompt target is missing");
  const before = agent.agent.prompt;
  agent.agent.prompt = "Use the refined review prompt.";
  const source = JSON.stringify(sourceValue);
  const compiled = compileWorkflowText(source, "effective-state.json");
  const identityWithoutDigest = {
    version: 1 as const,
    id: "better-review-prompt",
    candidateVersion: "1.0.0",
    scope: { kind: "workflow" as const, workflowId: baseline.workflowId },
    manifest: { provenance: "candidate.yaml", sourceSha256: "1".repeat(64) },
    baseline: {
      provenance: "effective-state.json",
      sourceSha256: baseline.workflow.sha256,
      workflowDigest: baseline.workflow.workflowDigest,
    },
    evidence: [
      {
        provenance: "tuning.json",
        sourceSha256: "2".repeat(64),
        evidenceDigest: "3".repeat(64),
        planDigest: "4".repeat(64),
      },
    ],
    changes: [
      { nodeId: "review", beforeSha256: sha256(before), afterSha256: sha256(agent.agent.prompt) },
    ],
    projectedWorkflow: {
      sourceSha256: sha256(source),
      workflowDigest: calculateWorkflowDigest(compiled),
    },
  };
  return {
    identity: {
      ...identityWithoutDigest,
      candidateDigest: calculatePromptCandidateIdentityDigest(identityWithoutDigest),
    },
    workflow: {
      source,
      sourceSha256: sha256(source),
      compiled,
      workflowDigest: calculateWorkflowDigest(compiled),
    },
  };
}

function skillProjectionFor(baseline: EffectiveHarnessState): ProjectedAgentSkillCandidate {
  const fixture = agentSkillActivationInput();
  const baselineSkill = baseline.packages.find(
    (item) => item.kind === "agent-skill" && item.name === fixture.skill.name,
  );
  if (baselineSkill?.kind !== "agent-skill") {
    throw new Error("composition baseline skill is missing");
  }
  const baselineCapabilitySnapshot = validateCapabilitySnapshot({
    version: 1,
    packages: [baselineSkill],
    digest: calculateCapabilitySnapshotDigest([baselineSkill]),
  }) as AgentSkillCapabilitySnapshot;
  const candidateCapabilitySnapshot = validateCapabilitySnapshot({
    version: 1,
    packages: [fixture.skill],
    digest: calculateCapabilitySnapshotDigest([fixture.skill]),
  }) as AgentSkillCapabilitySnapshot;
  const { candidateDigest: _candidateDigest, ...fixtureIdentity } = fixture.candidate;
  const identityWithoutDigest = {
    ...fixtureIdentity,
    baseline: {
      workflow: {
        provenance: "effective-state.json",
        sourceSha256: baseline.workflow.sha256,
        workflowDigest: baseline.workflow.workflowDigest,
      },
      skill: {
        name: baselineSkill.name,
        provenance: baselineSkill.provenance,
        packageDigest: baselineSkill.digest,
        capabilityDigest: baselineCapabilitySnapshot.digest,
      },
    },
    projectedSkill: {
      packageDigest: fixture.skill.digest,
      capabilityDigest: candidateCapabilitySnapshot.digest,
    },
  };
  const source = effectiveHarnessWorkflowSource(baseline);
  return {
    identity: {
      ...identityWithoutDigest,
      candidateDigest: calculateAgentSkillCandidateIdentityDigest(identityWithoutDigest),
    },
    workflow: {
      sourceSha256: baseline.workflow.sha256,
      workflowDigest: baseline.workflow.workflowDigest,
      compiled: compileWorkflowText(source, "effective-state.json"),
    },
    baselineCapabilitySnapshot,
    candidateCapabilitySnapshot,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
