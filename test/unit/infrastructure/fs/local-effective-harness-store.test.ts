import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareEffectiveHarnessActivation } from "../../../../src/application/prepare-effective-harness-activation.js";
import { createPromptActivationSnapshot } from "../../../../src/domain/adaptation/prompt-activation.js";
import {
  type EffectiveHarnessStoreHooks,
  LocalEffectiveHarnessStore,
} from "../../../../src/infrastructure/fs/local-effective-harness-store.js";
import { LocalPromptActivationStore } from "../../../../src/infrastructure/fs/local-prompt-activation-store.js";
import {
  effectiveHarnessCandidateArtifactFixture,
  superiorEffectiveHarnessEvaluation,
} from "../../../fixtures/effective-harness-evaluation.js";
import { promptActivationInput } from "../../../fixtures/prompt-activation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local effective harness store", () => {
  it("publishes complete state before one authoritative transition and rolls back exactly", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const prepared = prepareEffectiveHarnessActivation({
      artifact,
      stored: superiorEffectiveHarnessEvaluation(artifact),
    });
    const order: string[] = [];
    const hooks: EffectiveHarnessStoreHooks = {
      afterBlobPublished: (kind) => {
        order.push(kind);
      },
      beforeIndexRenamed: () => {
        order.push("index");
      },
    };
    const store = new LocalEffectiveHarnessStore(root, {
      hooks,
      now: () => new Date("2026-08-17T18:00:00.000Z"),
      readInitialHead: async () => artifact.baselineHead,
    });
    const proposal = await store.previewActivate({
      prepared,
      actor: "operator:test",
      reason: "Compose the reviewed package.",
    });

    const activated = await store.applyActivate({
      prepared,
      actor: "operator:test",
      reason: "Compose the reviewed package.",
      expectedDigest: proposal.proposalDigest,
    });

    expect(activated).toMatchObject({
      status: "activated",
      head: {
        generation: artifact.baselineHead.generation + 1,
        activationDigest: artifact.artifactDigest,
        stateDigest: artifact.candidateState.stateDigest,
      },
      transition: { action: "activate", surface: artifact.surface },
    });
    expect(order.at(-1)).toBe("index");
    expect(order.slice(0, -1)).toEqual(
      expect.arrayContaining(["baseline-state", "candidate-state", "candidate-artifact"]),
    );
    await expect(store.loadActive(artifact.workflowId)).resolves.toMatchObject({
      head: activated.head,
      state: artifact.candidateState,
    });

    const rollback = await store.previewRollback({
      workflowId: artifact.workflowId,
      targetStateDigest: artifact.baselineState.stateDigest,
      actor: "operator:test",
      reason: "Restore the reviewed baseline.",
    });
    const rolledBack = await store.applyRollback({
      workflowId: artifact.workflowId,
      targetStateDigest: artifact.baselineState.stateDigest,
      actor: "operator:test",
      reason: "Restore the reviewed baseline.",
      expectedDigest: rollback.proposalDigest,
    });

    expect(rolledBack).toMatchObject({
      status: "rolled_back",
      transition: {
        action: "rollback",
        targetTransitionDigest: artifact.baselineHead.transitionDigest,
      },
      head: { stateDigest: artifact.baselineState.stateDigest },
    });
    await expect(store.loadActive(artifact.workflowId)).resolves.toMatchObject({
      head: rolledBack.head,
      state: artifact.baselineState,
    });
  });

  it("rejects a stale proposal before publishing a blob", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const prepared = prepareEffectiveHarnessActivation({
      artifact,
      stored: superiorEffectiveHarnessEvaluation(artifact),
    });
    let publications = 0;
    const store = new LocalEffectiveHarnessStore(root, {
      hooks: {
        afterBlobPublished: () => {
          publications += 1;
        },
      },
      readInitialHead: async () => artifact.baselineHead,
    });

    await expect(
      store.applyActivate({
        prepared,
        actor: "operator:test",
        expectedDigest: "9".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "stale_proposal" });
    expect(publications).toBe(0);
  });

  it("rejects a legacy activation after the effective workflow head exists", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const prepared = prepareEffectiveHarnessActivation({
      artifact,
      stored: superiorEffectiveHarnessEvaluation(artifact),
    });
    const effective = new LocalEffectiveHarnessStore(root, {
      readInitialHead: async () => artifact.baselineHead,
    });
    const proposal = await effective.previewActivate({ prepared, actor: "operator:test" });
    await effective.applyActivate({
      prepared,
      actor: "operator:test",
      expectedDigest: proposal.proposalDigest,
    });
    const candidate = createPromptActivationSnapshot(promptActivationInput());
    const baseline = createPromptActivationSnapshot(
      promptActivationInput({ selection: "baseline" }),
    );
    const legacy = new LocalPromptActivationStore(root);
    const legacyProposal = await legacy.previewActivate({
      snapshot: candidate,
      baselineSnapshot: baseline,
      actor: "operator:test",
    });

    await expect(
      legacy.applyActivate({
        snapshot: candidate,
        baselineSnapshot: baseline,
        actor: "operator:test",
        expectedDigest: legacyProposal.proposalDigest,
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    expect((await legacy.list()).activations).toHaveLength(0);
  });

  it("settles an exact apply retry without another transition", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const prepared = prepareEffectiveHarnessActivation({
      artifact,
      stored: superiorEffectiveHarnessEvaluation(artifact),
    });
    const store = new LocalEffectiveHarnessStore(root, {
      readInitialHead: async () => artifact.baselineHead,
    });
    const proposal = await store.previewActivate({ prepared, actor: "operator:test" });
    const first = await store.applyActivate({
      prepared,
      actor: "operator:test",
      expectedDigest: proposal.proposalDigest,
    });

    await expect(
      store.applyActivate({
        prepared,
        actor: "operator:test",
        expectedDigest: proposal.proposalDigest,
      }),
    ).resolves.toEqual({ ...first, status: "already_active" });
    expect((await store.list()).history).toHaveLength(1);
  });

  it("keeps the old head authoritative before rename and settles after rename", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const prepared = prepareEffectiveHarnessActivation({
      artifact,
      stored: superiorEffectiveHarnessEvaluation(artifact),
    });
    let beforeAttempts = 0;
    const preBoundary = new LocalEffectiveHarnessStore(root, {
      readInitialHead: async () => artifact.baselineHead,
      hooks: {
        beforeIndexRenamed: () => {
          beforeAttempts += 1;
          if (beforeAttempts === 1) throw new Error("PRIVATE_PRE_BOUNDARY");
        },
      },
    });
    const proposal = await preBoundary.previewActivate({ prepared, actor: "operator:test" });

    await expect(
      preBoundary.applyActivate({
        prepared,
        actor: "operator:test",
        expectedDigest: proposal.proposalDigest,
      }),
    ).rejects.toMatchObject({ code: "io" });
    await expect(preBoundary.loadActive(artifact.workflowId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      preBoundary.applyActivate({
        prepared,
        actor: "operator:test",
        expectedDigest: proposal.proposalDigest,
      }),
    ).resolves.toMatchObject({ status: "activated" });

    const secondRoot = await temporaryDirectory();
    let afterAttempts = 0;
    const postBoundary = new LocalEffectiveHarnessStore(secondRoot, {
      readInitialHead: async () => artifact.baselineHead,
      hooks: {
        afterIndexRenamed: () => {
          afterAttempts += 1;
          if (afterAttempts === 1) throw new Error("PRIVATE_POST_BOUNDARY");
        },
      },
    });
    const secondProposal = await postBoundary.previewActivate({
      prepared,
      actor: "operator:test",
    });
    await expect(
      postBoundary.applyActivate({
        prepared,
        actor: "operator:test",
        expectedDigest: secondProposal.proposalDigest,
      }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(postBoundary.loadActive(artifact.workflowId)).resolves.toMatchObject({
      state: artifact.candidateState,
    });
  });

  it("fails closed when a retained state or candidate artifact is missing", async () => {
    for (const missing of ["state", "artifact"] as const) {
      const root = await temporaryDirectory();
      const artifact = effectiveHarnessCandidateArtifactFixture();
      const prepared = prepareEffectiveHarnessActivation({
        artifact,
        stored: superiorEffectiveHarnessEvaluation(artifact),
      });
      const store = new LocalEffectiveHarnessStore(root, {
        readInitialHead: async () => artifact.baselineHead,
      });
      const proposal = await store.previewActivate({ prepared, actor: "operator:test" });
      await store.applyActivate({
        prepared,
        actor: "operator:test",
        expectedDigest: proposal.proposalDigest,
      });
      await unlink(
        missing === "state"
          ? join(
              root,
              ".flow/effective-harness/states",
              `${artifact.candidateState.stateDigest}.json`,
            )
          : join(root, ".flow/effective-harness/artifacts", `${artifact.artifactDigest}.json`),
      );

      await expect(store.loadActive(artifact.workflowId)).rejects.toMatchObject({
        code: "corrupt",
      });
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "flow-effective-harness-store-"));
  await mkdir(join(path, ".flow"), { mode: 0o700 });
  temporaryDirectories.push(path);
  return path;
}
