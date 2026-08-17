import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareEffectiveHarnessActivation } from "../../../../src/application/prepare-effective-harness-activation.js";
import { createEffectiveHarnessCandidateArtifact } from "../../../../src/domain/adaptation/effective-harness-candidate.js";
import {
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
} from "../../../../src/domain/adaptation/effective-harness-state.js";
import { createPromptActivationSnapshot } from "../../../../src/domain/adaptation/prompt-activation.js";
import { admitLocalEffectiveHarnessCandidate } from "../../../../src/infrastructure/fs/local-effective-harness-candidate.js";
import {
  calculateLocalEffectiveHarnessScopeDigest,
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
  it("rejects a complete candidate from another canonical project scope", async () => {
    const sourceRoot = await temporaryDirectory();
    const targetRoot = await temporaryDirectory();
    const sourceScope = await calculateLocalEffectiveHarnessScopeDigest(sourceRoot);
    const targetScope = await calculateLocalEffectiveHarnessScopeDigest(targetRoot);
    const artifact = effectiveArtifactForScope(sourceScope);
    const source = new LocalEffectiveHarnessStore(sourceRoot, {
      readInitialHead: async () => artifact.baselineHead,
    });
    const target = new LocalEffectiveHarnessStore(targetRoot, {
      readInitialHead: async () => artifact.baselineHead,
    });

    expect(sourceScope).not.toBe(targetScope);
    await expect(source.stageCandidate(artifact)).resolves.toMatchObject({
      artifactDigest: artifact.artifactDigest,
    });
    await expect(target.stageCandidate(artifact)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await target.list()).toMatchObject({ heads: [], history: [] });
  });

  it("stages a complete candidate without creating activation authority", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const store = new LocalEffectiveHarnessStore(root, {
      scopeDigest: artifact.scopeDigest,
      readInitialHead: async () => artifact.baselineHead,
    });

    const staged = await store.stageCandidate(artifact);

    expect(staged).toMatchObject({
      artifactDigest: artifact.artifactDigest,
      stateDigest: artifact.candidateState.stateDigest,
    });
    await expect(admitLocalEffectiveHarnessCandidate(staged.path)).resolves.toMatchObject({
      artifact,
    });
    expect(await store.list()).toMatchObject({ heads: [], history: [] });
  });

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
      scopeDigest: artifact.scopeDigest,
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
      scopeDigest: artifact.scopeDigest,
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
    const artifact = effectiveArtifactForScope(
      await calculateLocalEffectiveHarnessScopeDigest(root),
    );
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
      scopeDigest: artifact.scopeDigest,
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

  it("settles an exact rollback retry without another transition", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const prepared = prepareEffectiveHarnessActivation({
      artifact,
      stored: superiorEffectiveHarnessEvaluation(artifact),
    });
    const store = new LocalEffectiveHarnessStore(root, {
      scopeDigest: artifact.scopeDigest,
      readInitialHead: async () => artifact.baselineHead,
    });
    const activation = await store.previewActivate({ prepared, actor: "operator:test" });
    await store.applyActivate({
      prepared,
      actor: "operator:test",
      expectedDigest: activation.proposalDigest,
    });
    const input = {
      workflowId: artifact.workflowId,
      targetStateDigest: artifact.baselineState.stateDigest,
      actor: "operator:test",
      reason: "Restore exact reviewed authority.",
    };
    const proposal = await store.previewRollback(input);
    const first = await store.applyRollback({
      ...input,
      expectedDigest: proposal.proposalDigest,
    });

    await expect(
      store.applyRollback({ ...input, expectedDigest: proposal.proposalDigest }),
    ).resolves.toEqual({ ...first, status: "already_rolled_back" });
    expect((await store.list()).history).toHaveLength(2);
  });

  it("preserves pre-ownership cancellation and settles cancellation after ownership", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const prepared = prepareEffectiveHarnessActivation({
      artifact,
      stored: superiorEffectiveHarnessEvaluation(artifact),
    });
    const cancelled = new AbortController();
    const reason = new Error("PRIVATE_CANCEL_REASON");
    cancelled.abort(reason);
    const untouched = new LocalEffectiveHarnessStore(root, {
      scopeDigest: artifact.scopeDigest,
      readInitialHead: async () => artifact.baselineHead,
    });

    await expect(
      untouched.applyActivate({
        prepared,
        actor: "operator:test",
        expectedDigest: "9".repeat(64),
        signal: cancelled.signal,
      }),
    ).rejects.toBe(reason);
    expect((await untouched.list()).history).toEqual([]);

    const afterOwnership = new AbortController();
    const settling = new LocalEffectiveHarnessStore(root, {
      scopeDigest: artifact.scopeDigest,
      readInitialHead: async () => artifact.baselineHead,
      hooks: {
        afterBlobPublished: (kind) => {
          if (kind === "baseline-state") afterOwnership.abort(new Error("PRIVATE_LATE_CANCEL"));
        },
      },
    });
    const proposal = await settling.previewActivate({ prepared, actor: "operator:test" });
    await expect(
      settling.applyActivate({
        prepared,
        actor: "operator:test",
        expectedDigest: proposal.proposalDigest,
        signal: afterOwnership.signal,
      }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(settling.loadActive(artifact.workflowId)).resolves.toMatchObject({
      state: artifact.candidateState,
    });
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
      scopeDigest: artifact.scopeDigest,
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
      scopeDigest: artifact.scopeDigest,
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
        scopeDigest: artifact.scopeDigest,
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
