import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareEffectiveHarnessActivation } from "../../../../src/application/prepare-effective-harness-activation.js";
import { calculateAgentSkillPackageCandidateIdentityDigest } from "../../../../src/domain/adaptation/agent-skill-package-candidate.js";
import {
  calculateEffectiveHarnessCandidateDigest,
  createEffectiveHarnessCandidateArtifact,
  encodeEffectiveHarnessCandidateArtifact,
} from "../../../../src/domain/adaptation/effective-harness-candidate.js";
import {
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
} from "../../../../src/domain/adaptation/effective-harness-state.js";
import {
  calculateEffectiveHarnessTransitionDigest,
  type EffectiveHarnessRollbackTransition,
  effectiveHarnessHeadFromTransition,
} from "../../../../src/domain/adaptation/effective-harness-transition.js";
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
  supplementalMemoryEffectiveHarnessCandidateArtifactFixture,
} from "../../../fixtures/effective-harness-evaluation.js";
import { promptActivationInput } from "../../../fixtures/prompt-activation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local effective harness store", () => {
  it("rejects a symbolic-link store root before reading an index", async () => {
    const root = await temporaryDirectory();
    const external = await temporaryDirectory();
    await symlink(external, join(root, ".flow", "effective-harness"), "dir");

    await expect(new LocalEffectiveHarnessStore(root).list()).rejects.toMatchObject({
      code: "unsafe_state",
    });
  });

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

  it("rolls an activated supplemental-memory catalog back to its exact prior state", async () => {
    const root = await temporaryDirectory();
    const artifact = supplementalMemoryEffectiveHarnessCandidateArtifactFixture();
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

    await expect(store.loadActive(artifact.workflowId)).resolves.toMatchObject({
      state: {
        stateDigest: artifact.candidateState.stateDigest,
        supplementalMemory: artifact.candidateState.supplementalMemory,
      },
    });

    const rollback = await store.previewRollback({
      workflowId: artifact.workflowId,
      targetStateDigest: artifact.baselineState.stateDigest,
      actor: "operator:test",
    });
    await store.applyRollback({
      workflowId: artifact.workflowId,
      targetStateDigest: artifact.baselineState.stateDigest,
      actor: "operator:test",
      expectedDigest: rollback.proposalDigest,
    });

    await expect(store.loadActive(artifact.workflowId)).resolves.toEqual({
      head: expect.objectContaining({ stateDigest: artifact.baselineState.stateDigest }),
      state: artifact.baselineState,
    });
    expect(artifact.baselineState.supplementalMemory).toBeUndefined();
  });

  it("rejects unknown and over-budget physical blob inventories", async () => {
    const unknownRoot = await temporaryDirectory();
    const unknownArtifact = effectiveHarnessCandidateArtifactFixture();
    const unknownStore = new LocalEffectiveHarnessStore(unknownRoot, {
      scopeDigest: unknownArtifact.scopeDigest,
      readInitialHead: async () => unknownArtifact.baselineHead,
    });
    await unknownStore.stageCandidate(unknownArtifact);
    await writeFile(join(unknownRoot, ".flow/effective-harness/states/PRIVATE_UNKNOWN"), "x");

    await expect(unknownStore.list()).rejects.toMatchObject({ code: "corrupt" });

    const boundedRoot = await temporaryDirectory();
    const boundedArtifact = effectiveHarnessCandidateArtifactFixture();
    const boundedStore = new LocalEffectiveHarnessStore(boundedRoot, {
      scopeDigest: boundedArtifact.scopeDigest,
      readInitialHead: async () => boundedArtifact.baselineHead,
    });
    await boundedStore.stageCandidate(boundedArtifact);
    await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        writeFile(
          join(
            boundedRoot,
            ".flow/effective-harness/artifacts",
            `${index.toString(16).padStart(64, "0")}.json`,
          ),
          "{}\n",
        ),
      ),
    );

    await expect(boundedStore.list()).rejects.toMatchObject({ code: "corrupt" });
  });

  it("enforces the index byte limit while the opened file is changing", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const prepared = prepareEffectiveHarnessActivation({
      artifact,
      stored: superiorEffectiveHarnessEvaluation(artifact),
    });
    const initial = new LocalEffectiveHarnessStore(root, {
      scopeDigest: artifact.scopeDigest,
      readInitialHead: async () => artifact.baselineHead,
    });
    const proposal = await initial.previewActivate({ prepared, actor: "operator:test" });
    await initial.applyActivate({
      prepared,
      actor: "operator:test",
      expectedDigest: proposal.proposalDigest,
    });
    let changed = false;
    const raced = new LocalEffectiveHarnessStore(root, {
      scopeDigest: artifact.scopeDigest,
      hooks: {
        afterFileObserved: async (kind) => {
          if (kind !== "index" || changed) return;
          changed = true;
          await appendFile(
            join(root, ".flow/effective-harness/index.json"),
            Buffer.alloc(4 * 1024 * 1024, 0x20),
          );
        },
      },
    });

    await expect(raced.list()).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("rejects staging beyond the physical artifact limit before publication", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const directory = join(root, ".flow/effective-harness/artifacts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 256; index += 1) {
      const retained = distinctArtifact(artifact, `retained-${index}`);
      await writeFile(
        join(directory, `${retained.artifactDigest}.json`),
        encodeEffectiveHarnessCandidateArtifact(retained),
      );
    }
    const next = distinctArtifact(artifact, "next-artifact");
    const store = new LocalEffectiveHarnessStore(root, {
      scopeDigest: artifact.scopeDigest,
      readInitialHead: async () => artifact.baselineHead,
    });

    await expect(store.stageCandidate(next)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      import("node:fs/promises").then(({ lstat }) =>
        lstat(join(directory, `${next.artifactDigest}.json`)),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects staging beyond the physical state limit before publication", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const directory = join(root, ".flow/effective-harness/states");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 256; index += 1) {
      const state = createEffectiveHarnessState({
        scopeDigest: artifact.scopeDigest,
        workflowSource: workflowWithPrompt(artifact.baselineState, `Retained prompt ${index}.`),
        packages: artifact.baselineState.packages,
      });
      await writeFile(join(directory, `${state.stateDigest}.json`), `${JSON.stringify(state)}\n`);
    }
    const store = new LocalEffectiveHarnessStore(root, {
      scopeDigest: artifact.scopeDigest,
      readInitialHead: async () => artifact.baselineHead,
    });

    await expect(store.stageCandidate(artifact)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      import("node:fs/promises").then(({ lstat }) =>
        lstat(join(directory, `${artifact.candidateState.stateDigest}.json`)),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
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

  it("reports an uncertain commit when the index rename is not directory-synchronized", async () => {
    const root = await temporaryDirectory();
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const prepared = prepareEffectiveHarnessActivation({
      artifact,
      stored: superiorEffectiveHarnessEvaluation(artifact),
    });
    const store = new LocalEffectiveHarnessStore(root, {
      scopeDigest: artifact.scopeDigest,
      readInitialHead: async () => artifact.baselineHead,
      hooks: {
        beforeIndexDirectorySynced: () => {
          throw new Error("PRIVATE_DIRECTORY_SYNC_FAILURE");
        },
      },
    });
    const proposal = await store.previewActivate({ prepared, actor: "operator:test" });

    await expect(
      store.applyActivate({
        prepared,
        actor: "operator:test",
        expectedDigest: proposal.proposalDigest,
      }),
    ).rejects.toMatchObject({ code: "commit_uncertain" });
    await expect(store.loadActive(artifact.workflowId)).resolves.toMatchObject({
      state: artifact.candidateState,
    });
  });

  it("requires every retained history state and activation artifact in the index", async () => {
    for (const missing of ["historical-state", "activation-artifact"] as const) {
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
      const rollback = await store.previewRollback({
        workflowId: artifact.workflowId,
        targetStateDigest: artifact.baselineState.stateDigest,
        actor: "operator:test",
      });
      await store.applyRollback({
        workflowId: artifact.workflowId,
        targetStateDigest: artifact.baselineState.stateDigest,
        actor: "operator:test",
        expectedDigest: rollback.proposalDigest,
      });

      await mutateIndex(root, (index) => {
        if (missing === "historical-state") {
          index.states = index.states.filter(
            (entry) => entry.stateDigest !== artifact.candidateState.stateDigest,
          );
        } else {
          index.artifacts = index.artifacts.filter(
            (entry) => entry.artifactDigest !== artifact.artifactDigest,
          );
        }
      });

      await expect(store.list()).rejects.toMatchObject({ code: "corrupt" });
    }
  });

  it("binds rollback targets to an earlier retained state and activation", async () => {
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
    const rollback = await store.previewRollback({
      workflowId: artifact.workflowId,
      targetStateDigest: artifact.baselineState.stateDigest,
      actor: "operator:test",
    });
    await store.applyRollback({
      workflowId: artifact.workflowId,
      targetStateDigest: artifact.baselineState.stateDigest,
      actor: "operator:test",
      expectedDigest: rollback.proposalDigest,
    });

    await mutateIndex(root, (index) => {
      const activationTransition = index.history[0];
      const rollbackTransition = index.history[1] as MutableRollbackTransition | undefined;
      if (activationTransition === undefined || rollbackTransition === undefined) {
        throw new Error("transition fixture is incomplete");
      }
      rollbackTransition.targetTransitionDigest = activationTransition.transitionDigest;
      rollbackTransition.transitionDigest = calculateEffectiveHarnessTransitionDigest(
        rollbackTransition as unknown as EffectiveHarnessRollbackTransition,
      );
      index.heads = [
        effectiveHarnessHeadFromTransition(
          rollbackTransition as unknown as EffectiveHarnessRollbackTransition,
        ),
      ];
    });

    await expect(store.list()).rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects duplicate heads that omit another retained workflow", async () => {
    const root = await temporaryDirectory();
    const scope = await calculateLocalEffectiveHarnessScopeDigest(root);
    const first = effectiveArtifactForScope(scope).baselineState;
    const secondSource = JSON.parse(workflowWithPrompt(first, "Second workflow prompt.")) as {
      metadata: { id: string };
    };
    secondSource.metadata.id = "second-workflow";
    const second = createEffectiveHarnessState({
      scopeDigest: scope,
      workflowSource: JSON.stringify(secondSource),
      packages: first.packages,
    });
    const firstHead = createEffectiveHarnessHeadIdentity({
      scopeDigest: scope,
      workflowId: first.workflowId,
      generation: 1,
      activationDigest: "1".repeat(64),
      transitionDigest: "2".repeat(64),
      stateDigest: first.stateDigest,
    });
    const secondHead = createEffectiveHarnessHeadIdentity({
      scopeDigest: scope,
      workflowId: second.workflowId,
      generation: 1,
      activationDigest: "3".repeat(64),
      transitionDigest: "4".repeat(64),
      stateDigest: second.stateDigest,
    });
    const storeRoot = join(root, ".flow/effective-harness");
    const statesRoot = join(storeRoot, "states");
    await mkdir(statesRoot, { recursive: true, mode: 0o700 });
    await mkdir(join(storeRoot, "artifacts"), { recursive: true, mode: 0o700 });
    const firstContent = Buffer.from(`${JSON.stringify(first)}\n`);
    const secondContent = Buffer.from(`${JSON.stringify(second)}\n`);
    await writeFile(join(statesRoot, `${first.stateDigest}.json`), firstContent);
    await writeFile(join(statesRoot, `${second.stateDigest}.json`), secondContent);
    const index: MutableEffectiveHarnessIndex = {
      version: 1,
      origins: [firstHead, secondHead],
      states: [
        {
          scopeDigest: scope,
          workflowId: first.workflowId,
          stateDigest: first.stateDigest,
          bytes: firstContent.byteLength,
        },
        {
          scopeDigest: scope,
          workflowId: second.workflowId,
          stateDigest: second.stateDigest,
          bytes: secondContent.byteLength,
        },
      ],
      artifacts: [],
      heads: [firstHead, firstHead],
      history: [],
      digest: "0".repeat(64),
    };
    index.digest = calculateTestIndexDigest(index);
    await writeFile(join(storeRoot, "index.json"), `${JSON.stringify(index)}\n`);

    await expect(new LocalEffectiveHarnessStore(root).list()).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("binds each retained activation artifact to the head it reviewed", async () => {
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
    const substituted = createEffectiveHarnessCandidateArtifact({
      baselineHead: createEffectiveHarnessHeadIdentity({
        scopeDigest: artifact.scopeDigest,
        workflowId: artifact.workflowId,
        generation: artifact.baselineHead.generation + 2,
        activationDigest: artifact.baselineHead.activationDigest,
        transitionDigest: "9".repeat(64),
        stateDigest: artifact.baselineState.stateDigest,
      }),
      baselineState: artifact.baselineState,
      candidateState: artifact.candidateState,
      candidate: artifact.candidate,
    });
    const substitutedContent = encodeEffectiveHarnessCandidateArtifact(substituted);
    await writeFile(
      join(root, ".flow/effective-harness/artifacts", `${substituted.artifactDigest}.json`),
      substitutedContent,
    );

    await mutateIndex(root, (index) => {
      const entry = index.artifacts[0];
      const transition = index.history[0];
      if (entry === undefined || transition === undefined) {
        throw new Error("activation fixture is incomplete");
      }
      entry.artifactDigest = substituted.artifactDigest;
      entry.bytes = substitutedContent.byteLength;
      transition.toActivationDigest = substituted.artifactDigest;
      transition.transitionDigest = calculateEffectiveHarnessTransitionDigest(
        transition as unknown as EffectiveHarnessRollbackTransition,
      );
      index.heads = [
        effectiveHarnessHeadFromTransition(
          transition as unknown as EffectiveHarnessRollbackTransition,
        ),
      ];
    });

    await expect(store.list()).rejects.toMatchObject({ code: "corrupt" });
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

function distinctArtifact(
  artifact: ReturnType<typeof effectiveHarnessCandidateArtifactFixture>,
  id: string,
) {
  if (
    !("kind" in artifact.candidate) ||
    artifact.candidate.kind !== "agent-skill-package-candidate"
  ) {
    throw new Error("effective artifact fixture has an unexpected candidate kind");
  }
  const { candidateDigest: _candidateDigest, ...identity } = artifact.candidate;
  const candidate = {
    ...identity,
    id,
    candidateDigest: calculateAgentSkillPackageCandidateIdentityDigest({ ...identity, id }),
  };
  const { artifactDigest: _artifactDigest, ...content } = artifact;
  return {
    ...content,
    candidate,
    artifactDigest: calculateEffectiveHarnessCandidateDigest({ ...content, candidate }),
  };
}

function workflowWithPrompt(
  state: ReturnType<typeof createEffectiveHarnessState>,
  prompt: string,
): string {
  const source = JSON.parse(
    Buffer.from(state.workflow.contentBase64, "base64").toString("utf8"),
  ) as { nodes: Array<{ type: string; agent?: { prompt: string } }> };
  const agent = source.nodes.find((node) => node.type === "agent");
  if (agent?.agent === undefined) throw new Error("state fixture has no agent node");
  agent.agent.prompt = prompt;
  return JSON.stringify(source);
}

interface MutableEffectiveHarnessIndex {
  version: 1;
  origins: unknown[];
  states: Array<{ stateDigest: string; [key: string]: unknown }>;
  artifacts: Array<{ artifactDigest: string; [key: string]: unknown }>;
  heads: unknown[];
  history: Array<{ transitionDigest: string; [key: string]: unknown }>;
  digest: string;
}

interface MutableRollbackTransition extends Record<string, unknown> {
  targetTransitionDigest: string;
  transitionDigest: string;
}

async function mutateIndex(
  root: string,
  mutate: (index: MutableEffectiveHarnessIndex) => void,
): Promise<void> {
  const path = join(root, ".flow/effective-harness/index.json");
  const index = JSON.parse(await readFile(path, "utf8")) as MutableEffectiveHarnessIndex;
  mutate(index);
  index.digest = calculateTestIndexDigest(index);
  await writeFile(path, `${JSON.stringify(index)}\n`);
}

function calculateTestIndexDigest(index: MutableEffectiveHarnessIndex): string {
  return createHash("sha256")
    .update(
      canonicalize({
        domain: "flow-effective-harness-index-v1",
        version: index.version,
        origins: index.origins,
        states: index.states,
        artifacts: index.artifacts,
        heads: index.heads,
        history: index.history,
      }),
    )
    .digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("unsupported canonical value");
}
