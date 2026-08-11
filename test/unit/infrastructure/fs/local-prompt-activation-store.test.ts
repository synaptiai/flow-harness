import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPromptActivationSnapshot,
  MAX_PROMPT_ACTIVATION_SOURCE_BYTES,
} from "../../../../src/domain/adaptation/prompt-activation.js";
import {
  LocalPromptActivationStore,
  MAX_PROMPT_ACTIVATION_ARTIFACTS,
  MAX_PROMPT_ACTIVATION_HEADS,
  MAX_PROMPT_ACTIVATION_STORED_BYTES,
  MAX_PROMPT_ACTIVATION_TEMPORARY_FILES,
  MAX_PROMPT_ACTIVATION_TRANSITIONS,
} from "../../../../src/infrastructure/fs/local-prompt-activation-store.js";
import {
  baselinePromptActivationSource,
  promptActivationInput,
} from "../../../fixtures/prompt-activation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local prompt activation store", () => {
  it("previews one deterministic activation without changing store state", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = {
      snapshot,
      baselineSnapshot: baselineSnapshotFor(snapshot),
      actor: "release-operator",
      reason: "Candidate passed the declared evaluation.",
    };

    const first = await store.previewActivate(input);
    const second = await store.previewActivate(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: 1,
      action: "activate",
      workflowId: "adaptive-workflow",
      current: { generation: 0, activationDigest: null },
      target: {
        candidateId: "better-instructions",
        candidateVersion: "1.0.0",
        activationDigest: snapshot.activationDigest,
      },
      actor: "release-operator",
      reason: "Candidate passed the declared evaluation.",
    });
    expect(first.proposalDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.list()).resolves.toEqual({
      version: 1,
      activations: [],
      heads: [],
      history: [],
    });
  });

  it("applies only the exact reviewed activation proposal", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = {
      snapshot,
      baselineSnapshot: baselineSnapshotFor(snapshot),
      actor: "release-operator",
      reason: "Candidate passed the declared evaluation.",
    };
    const preview = await store.previewActivate(input);

    const result = await store.applyActivate({
      ...input,
      expectedDigest: preview.proposalDigest,
    });

    expect(result).toMatchObject({
      status: "activated",
      head: {
        workflowId: "adaptive-workflow",
        generation: 1,
        activationDigest: snapshot.activationDigest,
      },
      transition: {
        sequence: 1,
        workflowId: "adaptive-workflow",
        generation: 1,
        fromActivationDigest: null,
        toActivationDigest: snapshot.activationDigest,
        actor: "release-operator",
      },
    });
    await expect(store.list()).resolves.toMatchObject({
      activations: [
        {
          workflowId: "adaptive-workflow",
          candidateId: "better-instructions",
          candidateVersion: "1.0.0",
          selection: "baseline",
          activationDigest: baselineSnapshotFor(snapshot).activationDigest,
        },
        {
          workflowId: "adaptive-workflow",
          candidateId: "better-instructions",
          candidateVersion: "1.0.0",
          selection: "candidate",
          activationDigest: snapshot.activationDigest,
        },
      ],
      heads: [
        {
          workflowId: "adaptive-workflow",
          generation: 1,
          activationDigest: snapshot.activationDigest,
        },
      ],
      history: [
        {
          sequence: 1,
          fromActivationDigest: null,
          toActivationDigest: snapshot.activationDigest,
        },
      ],
    });
  });

  it("binds the preview digest to operator input and current state", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = {
      snapshot,
      baselineSnapshot: baselineSnapshotFor(snapshot),
      actor: "release-operator",
      reason: "Candidate passed the declared evaluation.",
    };
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({
        ...input,
        actor: "other-operator",
        expectedDigest: preview.proposalDigest,
      }),
    ).rejects.toMatchObject({ code: "stale_proposal" });
    await expect(
      store.applyActivate({
        ...input,
        reason: "Different reason.",
        expectedDigest: preview.proposalDigest,
      }),
    ).rejects.toMatchObject({ code: "stale_proposal" });
    await expect(store.list()).resolves.toEqual({
      version: 1,
      activations: [],
      heads: [],
      history: [],
    });
  });

  it("checks the reviewed digest before it returns an idempotent result", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);
    await store.applyActivate({ ...input, expectedDigest: preview.proposalDigest });

    await expect(
      store.applyActivate({ ...input, expectedDigest: "f".repeat(64) }),
    ).rejects.toMatchObject({ code: "stale_proposal" });
    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "already_active" });
    await expect(store.list()).resolves.toMatchObject({
      heads: [{ generation: 1 }],
      history: [{ sequence: 1 }],
    });
  });

  it("rejects different content under an admitted candidate version", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const original = createPromptActivationSnapshot(promptActivationInput());
    const conflict = createPromptActivationSnapshot(
      promptActivationInput({ prompt: "Use different instructions for the same version." }),
    );
    const input = storeActivationInput(original, "release-operator");
    const preview = await store.previewActivate(input);
    await store.applyActivate({ ...input, expectedDigest: preview.proposalDigest });

    await expect(
      store.previewActivate(storeActivationInput(conflict, "release-operator")),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    await expect(store.list()).resolves.toMatchObject({
      activations: [
        { selection: "baseline" },
        { selection: "candidate", activationDigest: original.activationDigest },
      ],
      heads: [{ generation: 1 }],
      history: [{ sequence: 1 }],
    });
  });

  it("rejects a proposal after another writer changes the head", async () => {
    const project = await temporaryProject();
    const firstStore = new LocalPromptActivationStore(project);
    const secondStore = new LocalPromptActivationStore(project);
    const first = createPromptActivationSnapshot(promptActivationInput());
    const second = createPromptActivationSnapshot(
      promptActivationInput({ candidateVersion: "2.0.0", prompt: "Use version two." }),
    );
    const firstInput = storeActivationInput(first, "first-operator");
    const secondInput = storeActivationInput(second, "second-operator");
    const firstPreview = await firstStore.previewActivate(firstInput);
    const stalePreview = await secondStore.previewActivate(secondInput);
    await firstStore.applyActivate({
      ...firstInput,
      expectedDigest: firstPreview.proposalDigest,
    });

    await expect(
      secondStore.applyActivate({
        ...secondInput,
        expectedDigest: stalePreview.proposalDigest,
      }),
    ).rejects.toMatchObject({ code: "stale_proposal" });
    await expect(secondStore.list()).resolves.toMatchObject({
      activations: [
        { selection: "baseline" },
        { selection: "candidate", activationDigest: first.activationDigest },
      ],
      heads: [{ generation: 1, activationDigest: first.activationDigest }],
      history: [{ sequence: 1 }],
    });
  });

  it("allows only one cross-process mutation at a time", async () => {
    const project = await temporaryProject();
    let enterHook!: () => void;
    let releaseHook!: () => void;
    const hookEntered = new Promise<void>((resolve) => {
      enterHook = resolve;
    });
    const hookRelease = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const firstStore = new LocalPromptActivationStore(project, {
      hooks: {
        beforeMutationLockRelease: async () => {
          enterHook();
          await hookRelease;
        },
      },
    });
    const secondStore = new LocalPromptActivationStore(project);
    const first = createPromptActivationSnapshot(promptActivationInput());
    const second = createPromptActivationSnapshot(
      promptActivationInput({ candidateVersion: "2.0.0", prompt: "Use version two." }),
    );
    const firstInput = storeActivationInput(first, "first-operator");
    const secondInput = storeActivationInput(second, "second-operator");
    const firstPreview = await firstStore.previewActivate(firstInput);
    const secondPreview = await secondStore.previewActivate(secondInput);

    const firstApply = firstStore.applyActivate({
      ...firstInput,
      expectedDigest: firstPreview.proposalDigest,
    });
    await hookEntered;
    await expect(
      secondStore.applyActivate({
        ...secondInput,
        expectedDigest: secondPreview.proposalDigest,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    releaseHook();
    await expect(firstApply).resolves.toMatchObject({ status: "activated" });
  });

  it("retires a mutation lock from an exited same-host process", async () => {
    const project = await temporaryProject();
    await writeFile(
      join(project, ".flow", "activations.mutation.lock"),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        hostname: hostname(),
        token: "00000000-0000-4000-8000-000000000000",
      })}\n`,
      { mode: 0o600 },
    );
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(
      readFile(join(project, ".flow", "activations.mutation.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires a lock temporary file from an exited same-host process", async () => {
    const project = await temporaryProject();
    const temporary = join(
      project,
      ".flow",
      ".activations.mutation.00000000-0000-4000-8000-000000000001.tmp",
    );
    await writeFile(
      temporary,
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        hostname: hostname(),
        token: "00000000-0000-4000-8000-000000000002",
      })}\n`,
      { mode: 0o600 },
    );
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires empty and partial lock temporary files from an exited same-host process", async () => {
    const project = await temporaryProject();
    const hostIdentity = createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
    const empty = join(
      project,
      ".flow",
      `.activations.mutation.2147483647.${hostIdentity}.00000000-0000-4000-8000-000000000005.tmp`,
    );
    const partial = join(
      project,
      ".flow",
      `.activations.mutation.2147483647.${hostIdentity}.00000000-0000-4000-8000-000000000006.tmp`,
    );
    await writeFile(empty, "", { mode: 0o600 });
    await writeFile(partial, '{"version":1', { mode: 0o600 });
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(readFile(empty)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(partial)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a partial lock temporary file from a live same-host process", async () => {
    const project = await temporaryProject();
    const hostIdentity = createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
    const temporary = join(
      project,
      ".flow",
      `.activations.mutation.${process.pid}.${hostIdentity}.00000000-0000-4000-8000-000000000007.tmp`,
    );
    await writeFile(temporary, '{"version":1', { mode: 0o600 });
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(readFile(temporary, "utf8")).resolves.toBe('{"version":1');
  });

  it("recovers the exact temporary-file count when every local owner exited", async () => {
    const project = await temporaryProject();
    for (let index = 0; index < MAX_PROMPT_ACTIVATION_TEMPORARY_FILES; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      await writeFile(
        join(project, ".flow", `.activations.mutation.00000000-0000-4000-8000-${suffix}.tmp`),
        `${JSON.stringify({
          version: 1,
          pid: 2_147_483_647,
          hostname: hostname(),
          token: `00000000-0000-4000-8000-${suffix}`,
        })}\n`,
        { mode: 0o600 },
      );
    }
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(readdir(join(project, ".flow"))).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.activations\.mutation\./)]),
    );
  }, 20_000);

  it("rejects one more mutation temporary file than the recovery limit", async () => {
    const project = await temporaryProject();
    for (let index = 0; index <= MAX_PROMPT_ACTIVATION_TEMPORARY_FILES; index += 1) {
      await writeFile(
        join(project, ".flow", `.activations.mutation.${testUuid(index)}.tmp`),
        "{}\n",
        { mode: 0o600 },
      );
    }
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("ignores a mutation temporary file removed during observation", async () => {
    const project = await temporaryProject();
    const temporary = join(project, ".flow", `.activations.mutation.${testUuid(1)}.tmp`);
    await writeFile(temporary, "{}\n", { mode: 0o600 });
    const store = new LocalPromptActivationStore(project, {
      hooks: {
        beforeMutationTemporaryObserved: async () => {
          await rm(temporary);
        },
      },
    });
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "activated" });
  });

  it("rejects a linked mutation-lock temporary file", async () => {
    const project = await temporaryProject();
    const outside = join(project, "outside-lock-owner.json");
    const temporary = join(
      project,
      ".flow",
      ".activations.mutation.00000000-0000-4000-8000-000000000003.tmp",
    );
    await writeFile(outside, "{}\n");
    await symlink(outside, temporary);
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "unsafe_state" });
    await expect(readFile(temporary)).resolves.toEqual(Buffer.from("{}\n"));
  });

  it("recovers an exact retry after an unclear index commit", async () => {
    const project = await temporaryProject();
    const uncertainStore = new LocalPromptActivationStore(project, {
      hooks: {
        afterIndexRenamed: async () => {
          throw new Error("simulated directory sync failure");
        },
      },
    });
    const retryStore = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator", "Approved after review.");
    const preview = await uncertainStore.previewActivate(input);

    await expect(
      uncertainStore.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "commit_uncertain" });
    await expect(
      retryStore.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "already_active" });
    await expect(retryStore.list()).resolves.toMatchObject({
      heads: [{ generation: 1, activationDigest: snapshot.activationDigest }],
      history: [{ sequence: 1 }],
    });
  });

  it("removes a new blob when publication fails after its hard link", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project, {
      hooks: {
        afterBlobLinked: async () => {
          throw new Error("simulated failure after blob link");
        },
      },
    });
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "io" });
    await expect(readdir(join(project, ".flow", "activations", "sha256"))).resolves.toEqual([]);
    await expect(store.list()).resolves.toEqual({
      version: 1,
      activations: [],
      heads: [],
      history: [],
    });
  });

  it("retires a crash-only index temporary file while holding the mutation lock", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    await activateFixture(store);
    const temporary = join(
      project,
      ".flow",
      "activations",
      ".index.00000000-0000-4000-8000-000000000004.tmp",
    );
    await writeFile(temporary, "incomplete index\n", { mode: 0o600 });
    const next = createPromptActivationSnapshot(
      promptActivationInput({ candidateVersion: "2.0.0", prompt: "Use version two." }),
    );
    const input = storeActivationInput(next, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires a crash-only blob temporary file before publication", async () => {
    const project = await temporaryProject();
    const blobDirectory = join(project, ".flow", "activations", "sha256");
    await mkdir(blobDirectory, { recursive: true });
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const temporary = join(
      blobDirectory,
      `.${snapshot.activationDigest}.00000000-0000-4000-8000-000000000008.tmp`,
    );
    await writeFile(temporary, "partial activation blob", { mode: 0o600 });
    const store = new LocalPromptActivationStore(project);
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires a post-link blob temporary file and keeps its exact final link", async () => {
    const project = await temporaryProject();
    const blobDirectory = join(project, ".flow", "activations", "sha256");
    await mkdir(blobDirectory, { recursive: true });
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const temporary = join(
      blobDirectory,
      `.${snapshot.activationDigest}.00000000-0000-4000-8000-000000000009.tmp`,
    );
    const target = join(blobDirectory, `${snapshot.activationDigest}.json`);
    await writeFile(temporary, `${canonicalJson(snapshot)}\n`, { mode: 0o600 });
    await link(temporary, target);
    const store = new LocalPromptActivationStore(project);
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(target, "utf8")).resolves.toBe(`${canonicalJson(snapshot)}\n`);
  });

  it("retires a maximum-source blob temporary file above the small-file recovery limit", async () => {
    const project = await temporaryProject();
    const blobDirectory = join(project, ".flow", "activations", "sha256");
    await mkdir(blobDirectory, { recursive: true });
    const snapshot = createPromptActivationSnapshot(
      promptActivationInput({ sourceBytes: MAX_PROMPT_ACTIVATION_SOURCE_BYTES }),
    );
    const temporary = join(
      blobDirectory,
      `.${snapshot.activationDigest}.00000000-0000-4000-8000-00000000000a.tmp`,
    );
    const content = `${canonicalJson(snapshot)}\n`;
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(8 * 1024 * 1024);
    await writeFile(temporary, content, { mode: 0o600 });
    const store = new LocalPromptActivationStore(project);
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("rejects one more index temporary file than the recovery limit", async () => {
    const project = await temporaryProject();
    const activationDirectory = join(project, ".flow", "activations");
    await mkdir(activationDirectory);
    for (let index = 0; index <= MAX_PROMPT_ACTIVATION_TEMPORARY_FILES; index += 1) {
      await writeFile(join(activationDirectory, `.index.${testUuid(index)}.tmp`), "{}\n");
    }
    await expect(applyFixtureActivation(project)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  });

  it("rejects aggregate index temporary bytes above the recovery limit", async () => {
    const project = await temporaryProject();
    const activationDirectory = join(project, ".flow", "activations");
    await mkdir(activationDirectory);
    for (let index = 0; index < 3; index += 1) {
      const path = join(activationDirectory, `.index.${testUuid(index)}.tmp`);
      await writeFile(path, "");
      await truncate(path, 3 * 1024 * 1024);
    }
    await expect(applyFixtureActivation(project)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  });

  it("rejects one more blob temporary file than the recovery limit", async () => {
    const project = await temporaryProject();
    const blobDirectory = join(project, ".flow", "activations", "sha256");
    await mkdir(blobDirectory, { recursive: true });
    for (let index = 0; index <= MAX_PROMPT_ACTIVATION_TEMPORARY_FILES; index += 1) {
      await writeFile(join(blobDirectory, `.${"a".repeat(64)}.${testUuid(index)}.tmp`), "{}\n");
    }
    await expect(applyFixtureActivation(project)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  });

  it("rejects aggregate blob temporary bytes above the recovery limit", async () => {
    const project = await temporaryProject();
    const blobDirectory = join(project, ".flow", "activations", "sha256");
    await mkdir(blobDirectory, { recursive: true });
    for (let index = 0; index < 17; index += 1) {
      const path = join(blobDirectory, `.${"a".repeat(64)}.${testUuid(index)}.tmp`);
      await writeFile(path, "");
      await truncate(path, 16 * 1024 * 1024);
    }
    await expect(applyFixtureActivation(project)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  });

  it("rejects a blob temporary file one byte above its recovery limit", async () => {
    const project = await temporaryProject();
    const blobDirectory = join(project, ".flow", "activations", "sha256");
    await mkdir(blobDirectory, { recursive: true });
    const path = join(blobDirectory, `.${"a".repeat(64)}.${testUuid(1)}.tmp`);
    await writeFile(path, "");
    await truncate(path, 16 * 1024 * 1024 + 1);
    await expect(applyFixtureActivation(project)).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("keeps an empty index when blob publication meets a linked directory", async () => {
    const project = await temporaryProject();
    const activationDirectory = join(project, ".flow", "activations");
    const outside = join(project, "outside-blobs");
    await mkdir(activationDirectory);
    await mkdir(outside);
    await symlink(outside, join(activationDirectory, "sha256"));
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "unsafe_state" });
    await expect(store.list()).resolves.toEqual({
      version: 1,
      activations: [],
      heads: [],
      history: [],
    });
  });

  it("keeps the old head when index publication fails before rename", async () => {
    const project = await temporaryProject();
    const firstStore = new LocalPromptActivationStore(project);
    const first = await activateFixture(firstStore);
    const failedStore = new LocalPromptActivationStore(project, {
      hooks: {
        beforeIndexRenamed: async () => {
          throw new Error("simulated index publication failure");
        },
      },
    });
    const second = createPromptActivationSnapshot(
      promptActivationInput({ candidateVersion: "2.0.0", prompt: "Use version two." }),
    );
    const input = storeActivationInput(second, "release-operator");
    const preview = await failedStore.previewActivate(input);

    await expect(
      failedStore.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "io" });
    await expect(firstStore.list()).resolves.toMatchObject({
      activations: [
        { selection: "baseline" },
        { selection: "candidate", activationDigest: first.activationDigest },
      ],
      heads: [{ generation: 1, activationDigest: first.activationDigest }],
      history: [{ sequence: 1 }],
    });
    await expect(
      readdir(join(project, ".flow", "activations", "sha256")).then((items) => items.sort()),
    ).resolves.toEqual(
      [
        `${baselineSnapshotFor(first).activationDigest}.json`,
        `${first.activationDigest}.json`,
      ].sort(),
    );
  });

  it("keeps foreign and invalid mutation-lock owners", async () => {
    const project = await temporaryProject();
    const lockPath = join(project, ".flow", "activations.mutation.lock");
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);
    const foreignOwner = `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      hostname: "other-host.example",
      token: "00000000-0000-4000-8000-000000000000",
    })}\n`;
    await writeFile(lockPath, foreignOwner, { mode: 0o600 });

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "busy" });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(foreignOwner);

    await writeFile(lockPath, "not-json\n", { mode: 0o600 });
    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "unsafe_state" });
    await expect(readFile(lockPath, "utf8")).resolves.toBe("not-json\n");
  });

  it("loads the exact active artifact as a durable capability snapshot", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);
    await store.applyActivate({ ...input, expectedDigest: preview.proposalDigest });

    const loaded = await store.loadActive("adaptive-workflow");

    expect(loaded.snapshot).toEqual(snapshot);
    expect(loaded.capabilitySnapshot).toMatchObject({
      version: 1,
      packages: [],
      activations: [snapshot],
    });
    expect(loaded.capabilitySnapshot.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rolls future runs back to the baseline without deleting the artifact", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const activationInput = storeActivationInput(snapshot, "release-operator");
    const activationPreview = await store.previewActivate(activationInput);
    await store.applyActivate({
      ...activationInput,
      expectedDigest: activationPreview.proposalDigest,
    });
    const rollbackInput = {
      workflowId: "adaptive-workflow",
      target: null,
      actor: "release-operator",
      reason: "Return future runs to the baseline.",
    };
    const rollbackPreview = await store.previewRollback(rollbackInput);

    const result = await store.applyRollback({
      ...rollbackInput,
      expectedDigest: rollbackPreview.proposalDigest,
    });

    expect(result).toMatchObject({
      status: "rolled_back",
      head: {
        workflowId: "adaptive-workflow",
        generation: 2,
        activationDigest: baselineSnapshotFor(snapshot).activationDigest,
      },
      transition: {
        sequence: 2,
        generation: 2,
        fromActivationDigest: snapshot.activationDigest,
        toActivationDigest: baselineSnapshotFor(snapshot).activationDigest,
      },
    });
    await expect(store.loadActive("adaptive-workflow")).resolves.toMatchObject({
      snapshot: {
        selection: "baseline",
        source: { sha256: snapshot.candidate.baseline.sourceSha256 },
      },
    });
    await expect(store.list()).resolves.toMatchObject({
      activations: [
        { selection: "baseline", activationDigest: baselineSnapshotFor(snapshot).activationDigest },
        { selection: "candidate", activationDigest: snapshot.activationDigest },
      ],
      heads: [{ generation: 2, activationDigest: baselineSnapshotFor(snapshot).activationDigest }],
      history: [{ sequence: 1 }, { sequence: 2 }],
    });

    await expect(
      store.applyRollback({ ...rollbackInput, expectedDigest: "f".repeat(64) }),
    ).rejects.toMatchObject({ code: "stale_proposal" });
    await expect(
      store.applyRollback({
        ...rollbackInput,
        expectedDigest: rollbackPreview.proposalDigest,
      }),
    ).resolves.toMatchObject({ status: "already_selected" });
  });

  it("rolls future runs back to an earlier stored candidate", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const first = createPromptActivationSnapshot(promptActivationInput());
    const second = createPromptActivationSnapshot(
      promptActivationInput({ candidateVersion: "2.0.0", prompt: "Use version two." }),
    );
    for (const snapshot of [first, second]) {
      const input = storeActivationInput(snapshot, "release-operator");
      const preview = await store.previewActivate(input);
      await store.applyActivate({ ...input, expectedDigest: preview.proposalDigest });
    }
    const rollbackInput = {
      workflowId: "adaptive-workflow",
      target: { candidateId: first.candidateId, candidateVersion: first.candidateVersion },
      actor: "release-operator",
      reason: "Return future runs to version one.",
    };
    const preview = await store.previewRollback(rollbackInput);

    await expect(
      store.applyRollback({ ...rollbackInput, expectedDigest: preview.proposalDigest }),
    ).resolves.toMatchObject({
      status: "rolled_back",
      head: { generation: 3, activationDigest: first.activationDigest },
    });
    await expect(store.loadActive("adaptive-workflow")).resolves.toMatchObject({
      snapshot: { activationDigest: first.activationDigest },
    });
    await expect(store.list()).resolves.toMatchObject({
      activations: [
        { candidateVersion: "1.0.0", selection: "baseline" },
        { candidateVersion: "1.0.0", selection: "candidate" },
        { candidateVersion: "2.0.0", selection: "baseline" },
        { candidateVersion: "2.0.0", selection: "candidate" },
      ],
      history: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
    });
  });

  it("keeps the current head when a rollback target blob is missing", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const first = createPromptActivationSnapshot(promptActivationInput());
    const second = createPromptActivationSnapshot(
      promptActivationInput({ candidateVersion: "2.0.0", prompt: "Use version two." }),
    );
    for (const snapshot of [first, second]) {
      const input = storeActivationInput(snapshot, "release-operator");
      const preview = await store.previewActivate(input);
      await store.applyActivate({ ...input, expectedDigest: preview.proposalDigest });
    }
    await rm(join(project, ".flow", "activations", "sha256", `${first.activationDigest}.json`));
    const input = {
      workflowId: first.workflowId,
      target: { candidateId: first.candidateId, candidateVersion: first.candidateVersion },
      actor: "release-operator",
    };
    const preview = await store.previewRollback(input);

    await expect(
      store.applyRollback({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "corrupt_blob" });
    await expect(store.list()).resolves.toMatchObject({
      heads: [{ generation: 2, activationDigest: second.activationDigest }],
      history: [{ sequence: 1 }, { sequence: 2 }],
    });
  });

  it("enforces actor and reason bounds on both sides", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());

    await expect(
      store.previewActivate(storeActivationInput(snapshot, "a".repeat(128), "r".repeat(1_024))),
    ).resolves.toMatchObject({ actor: "a".repeat(128), reason: "r".repeat(1_024) });
    await expect(
      store.previewActivate(storeActivationInput(snapshot, "a".repeat(129))),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.previewActivate(storeActivationInput(snapshot, "operator", "r".repeat(1_025))),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("counts unindexed files in the physical artifact limit", async () => {
    const project = await temporaryProject();
    const blobDirectory = join(project, ".flow", "activations", "sha256");
    await mkdir(blobDirectory, { recursive: true });
    for (let index = 0; index < MAX_PROMPT_ACTIVATION_ARTIFACTS; index += 1) {
      await writeFile(join(blobDirectory, `orphan-${index}.json`), "x");
    }
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(readdir(blobDirectory)).resolves.toHaveLength(MAX_PROMPT_ACTIVATION_ARTIFACTS);
    await expect(store.list()).resolves.toMatchObject({ activations: [], heads: [], history: [] });
  });

  it("counts unindexed files in the physical byte limit", async () => {
    const project = await temporaryProject();
    const blobDirectory = join(project, ".flow", "activations", "sha256");
    await mkdir(blobDirectory, { recursive: true });
    const fileBytes = 16 * 1024 * 1024;
    const fileCount = MAX_PROMPT_ACTIVATION_STORED_BYTES / fileBytes;
    for (let index = 0; index < fileCount; index += 1) {
      const handle = await open(join(blobDirectory, `orphan-${index}.json`), "w", 0o600);
      await handle.truncate(fileBytes);
      await handle.close();
    }
    const store = new LocalPromptActivationStore(project);
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);

    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(readdir(blobDirectory)).resolves.toHaveLength(fileCount);
    await expect(store.list()).resolves.toMatchObject({ activations: [], heads: [], history: [] });
  });

  it("accepts the head limit and rejects one new workflow without a blob write", async () => {
    const project = await temporaryProject();
    const activationDirectory = join(project, ".flow", "activations");
    await mkdir(activationDirectory);
    await writeFile(
      join(activationDirectory, "index.json"),
      `${JSON.stringify(headLimitIndex(MAX_PROMPT_ACTIVATION_HEADS))}\n`,
    );
    const store = new LocalPromptActivationStore(project);

    await expect(store.list()).resolves.toMatchObject({
      activations: { length: MAX_PROMPT_ACTIVATION_ARTIFACTS },
      heads: { length: MAX_PROMPT_ACTIVATION_HEADS },
    });
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const input = storeActivationInput(snapshot, "release-operator");
    const preview = await store.previewActivate(input);
    await expect(
      store.applyActivate({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(readdir(join(activationDirectory, "sha256"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(store.list()).resolves.toMatchObject({
      activations: { length: MAX_PROMPT_ACTIVATION_ARTIFACTS },
      heads: { length: MAX_PROMPT_ACTIVATION_HEADS },
    });
  });

  it("keeps the current head when rollback names an unknown version", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const snapshot = await activateFixture(store);

    await expect(
      store.previewRollback({
        workflowId: snapshot.workflowId,
        target: { candidateId: snapshot.candidateId, candidateVersion: "9.0.0" },
        actor: "release-operator",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(store.list()).resolves.toMatchObject({
      heads: [{ generation: 1, activationDigest: snapshot.activationDigest }],
      history: [{ sequence: 1 }],
    });
  });

  it("rejects a redigested index that selects another workflow artifact", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    await activateFixture(store);
    const path = join(project, ".flow", "activations", "index.json");
    const index = JSON.parse(await readFile(path, "utf8"));
    index.activations[0].workflowId = "other-workflow";
    index.digest = indexDigest(index);
    await writeFile(path, `${JSON.stringify(index)}\n`);

    await expect(store.list()).rejects.toMatchObject({ code: "invalid_index" });
  });

  it("rejects a redigested index with a discontinuous workflow generation", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    await activateFixture(store);
    const path = join(project, ".flow", "activations", "index.json");
    const index = JSON.parse(await readFile(path, "utf8"));
    index.history[0].generation = 2;
    index.history[0].transitionDigest = transitionDigest(index.history[0]);
    index.heads[0].generation = 2;
    index.heads[0].lastTransitionDigest = index.history[0].transitionDigest;
    index.digest = indexDigest(index);
    await writeFile(path, `${JSON.stringify(index)}\n`);

    await expect(store.list()).rejects.toMatchObject({ code: "invalid_index" });
  });

  it("keeps the current head when transition history is full", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const snapshot = await activateFixture(store);
    const path = join(project, ".flow", "activations", "index.json");
    const index = JSON.parse(await readFile(path, "utf8"));
    const baseline = baselineSnapshotFor(snapshot);
    let previousDigest: string | null = null;
    let selectedDigest: string | null = null;
    index.history = Array.from({ length: MAX_PROMPT_ACTIVATION_TRANSITIONS }, (_, offset) => {
      const nextDigest =
        selectedDigest === snapshot.activationDigest
          ? baseline.activationDigest
          : snapshot.activationDigest;
      const content = {
        sequence: offset + 1,
        workflowId: snapshot.workflowId,
        generation: offset + 1,
        fromActivationDigest: selectedDigest,
        toActivationDigest: nextDigest,
        actor: "release-operator",
        changedAt: "2026-08-09T00:00:00.000Z",
        previousDigest,
      };
      const transition = { ...content, transitionDigest: digest(content) };
      previousDigest = transition.transitionDigest;
      selectedDigest = nextDigest;
      return transition;
    });
    index.heads = [
      {
        workflowId: snapshot.workflowId,
        generation: MAX_PROMPT_ACTIVATION_TRANSITIONS,
        activationDigest: selectedDigest,
        lastTransitionDigest: previousDigest,
      },
    ];
    index.digest = indexDigest(index);
    await writeFile(path, `${JSON.stringify(index)}\n`);
    const input = {
      workflowId: snapshot.workflowId,
      target: {
        candidateId: snapshot.candidateId,
        candidateVersion: snapshot.candidateVersion,
      },
      actor: "release-operator",
    };
    const preview = await store.previewRollback(input);

    await expect(
      store.applyRollback({ ...input, expectedDigest: preview.proposalDigest }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(store.list()).resolves.toMatchObject({
      heads: [
        {
          generation: MAX_PROMPT_ACTIVATION_TRANSITIONS,
          activationDigest: baseline.activationDigest,
        },
      ],
      history: { length: MAX_PROMPT_ACTIVATION_TRANSITIONS },
    });
  });

  it("reports a missing selected blob as bounded store corruption", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const snapshot = await activateFixture(store);
    await rm(join(project, ".flow", "activations", "sha256", `${snapshot.activationDigest}.json`));

    const error = await store.loadActive("adaptive-workflow").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "corrupt_blob" });
    expect(Buffer.byteLength(String(error), "utf8")).toBeLessThanOrEqual(16 * 1024);
  });

  it("rejects an index symbolic link as unsafe state", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    await activateFixture(store);
    const activationDirectory = join(project, ".flow", "activations");
    const indexPath = join(activationDirectory, "index.json");
    const targetPath = join(activationDirectory, "other-index.json");
    await writeFile(targetPath, await readFile(indexPath));
    await rm(indexPath);
    await symlink(targetPath, indexPath);

    await expect(store.list()).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("rejects invalid UTF-8 and an oversized activation index", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    await activateFixture(store);
    const indexPath = join(project, ".flow", "activations", "index.json");
    await writeFile(indexPath, Buffer.from([0xff]));

    await expect(store.list()).rejects.toMatchObject({ code: "invalid_index" });

    await writeFile(indexPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    const error = await store.list().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "invalid_index" });
    expect(Buffer.byteLength(String(error), "utf8")).toBeLessThanOrEqual(16 * 1024);
  });

  it("rejects a changed or linked selected activation blob", async () => {
    const project = await temporaryProject();
    const store = new LocalPromptActivationStore(project);
    const snapshot = await activateFixture(store);
    const blobPath = join(
      project,
      ".flow",
      "activations",
      "sha256",
      `${snapshot.activationDigest}.json`,
    );
    const original = await readFile(blobPath);
    await writeFile(blobPath, Buffer.from("{}\n", "utf8"));

    await expect(store.loadActive("adaptive-workflow")).rejects.toMatchObject({
      code: "corrupt_blob",
    });

    const targetPath = join(project, ".flow", "activations", "sha256", "other.json");
    await writeFile(targetPath, original);
    await rm(blobPath);
    await symlink(targetPath, blobPath);
    await expect(store.loadActive("adaptive-workflow")).rejects.toMatchObject({
      code: "corrupt_blob",
    });
  });
});

async function activateFixture(
  store: LocalPromptActivationStore,
): Promise<ReturnType<typeof createPromptActivationSnapshot>> {
  const snapshot = createPromptActivationSnapshot(promptActivationInput());
  const input = storeActivationInput(snapshot, "release-operator");
  const preview = await store.previewActivate(input);
  await store.applyActivate({ ...input, expectedDigest: preview.proposalDigest });
  return snapshot;
}

function baselineSnapshotFor(
  snapshot: ReturnType<typeof createPromptActivationSnapshot>,
): ReturnType<typeof createPromptActivationSnapshot> {
  return createPromptActivationSnapshot({
    selection: "baseline",
    candidate: snapshot.candidate,
    evaluation: snapshot.evaluation,
    source: baselinePromptActivationSource,
  });
}

function storeActivationInput(
  snapshot: ReturnType<typeof createPromptActivationSnapshot>,
  actor: string,
  reason?: string,
) {
  return {
    snapshot,
    baselineSnapshot: baselineSnapshotFor(snapshot),
    actor,
    ...(reason === undefined ? {} : { reason }),
  };
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("fixture value is not canonical JSON");
}

function indexDigest(index: Record<string, unknown>): string {
  return digest({
    version: index.version,
    activations: index.activations,
    heads: index.heads,
    history: index.history,
  });
}

function headLimitIndex(count: number) {
  const activations: Record<string, unknown>[] = [];
  const heads: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  let previousDigest: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const suffix = index.toString().padStart(3, "0");
    const workflowId = `workflow-${suffix}`;
    const activationDigest = digest(`activation-${suffix}`);
    activations.push({
      workflowId,
      candidateId: `candidate-${suffix}`,
      candidateVersion: "1.0.0",
      selection: "candidate",
      activationDigest,
      bytes: 1,
    });
    const transitionContent = {
      sequence: index + 1,
      workflowId,
      generation: 1,
      fromActivationDigest: null,
      toActivationDigest: activationDigest,
      actor: "release-operator",
      changedAt: "2026-08-09T00:00:00.000Z",
      previousDigest,
    };
    const transitionDigestValue = digest(transitionContent);
    history.push({
      ...transitionContent,
      transitionDigest: transitionDigestValue,
    });
    heads.push({
      workflowId,
      generation: 1,
      activationDigest,
      lastTransitionDigest: transitionDigestValue,
    });
    previousDigest = transitionDigestValue;
  }
  const content = { version: 1 as const, activations, heads, history };
  return { ...content, digest: indexDigest(content) };
}

function transitionDigest(transition: Record<string, unknown>): string {
  const { transitionDigest: _transitionDigest, ...content } = transition;
  return digest(content);
}

function digest(value: unknown): string {
  const canonical = canonicalize(value);
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("test value is not canonical JSON");
}

async function temporaryProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-activation-store-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow"));
  return project;
}

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

async function applyFixtureActivation(project: string): Promise<unknown> {
  const store = new LocalPromptActivationStore(project);
  const snapshot = createPromptActivationSnapshot(promptActivationInput());
  const input = storeActivationInput(snapshot, "release-operator");
  const preview = await store.previewActivate(input);
  return await store.applyActivate({ ...input, expectedDigest: preview.proposalDigest });
}
