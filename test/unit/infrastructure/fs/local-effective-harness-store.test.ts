import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareEffectiveHarnessActivation } from "../../../../src/application/prepare-effective-harness-activation.js";
import {
  type EffectiveHarnessStoreHooks,
  LocalEffectiveHarnessStore,
} from "../../../../src/infrastructure/fs/local-effective-harness-store.js";
import {
  effectiveHarnessCandidateArtifactFixture,
  superiorEffectiveHarnessEvaluation,
} from "../../../fixtures/effective-harness-evaluation.js";

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
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "flow-effective-harness-store-"));
  await mkdir(join(path, ".flow"), { mode: 0o700 });
  temporaryDirectories.push(path);
  return path;
}
