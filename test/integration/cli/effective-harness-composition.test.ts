import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type CliIo, main } from "../../../src/cli/main.js";
import { createPromptActivationSnapshot } from "../../../src/domain/adaptation/prompt-activation.js";
import { completePromptCandidateGeneration } from "../../../src/domain/adaptation/prompt-candidate-generation.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import { admitLocalAdaptationCandidate } from "../../../src/infrastructure/fs/local-adaptation-candidate.js";
import { admitLocalEffectiveHarnessCandidate } from "../../../src/infrastructure/fs/local-effective-harness-candidate.js";
import { LocalEffectiveHarnessStore } from "../../../src/infrastructure/fs/local-effective-harness-store.js";
import { LocalPromptActivationStore } from "../../../src/infrastructure/fs/local-prompt-activation-store.js";
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
});

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
