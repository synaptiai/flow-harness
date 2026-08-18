import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CapabilityRepositoryFirstActivationWaitingState } from "../../../../src/application/capability-repository-first-activation.js";
import {
  LocalCapabilityRepositoryFirstActivationStore,
  LocalCapabilityRepositoryFirstActivationStoreError,
  MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_RECORD_BYTES,
} from "../../../../src/infrastructure/fs/local-capability-repository-first-activation-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("local capability repository first activation store", () => {
  it("publishes and reopens one exact waiting intent", async () => {
    const project = await projectDirectory();
    const store = new LocalCapabilityRepositoryFirstActivationStore(project);
    const signal = new AbortController().signal;
    const state = waitingState();

    const published = await store.publish({ expectedRecordDigest: null, state, signal });

    expect(published).toEqual({
      ...state,
      recordDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    await expect(store.read(state.authorization, signal)).resolves.toEqual(published);
    const entries = await readdir(join(project, ".flow", "capability.repository"));
    expect(entries).toEqual([expect.stringMatching(/^first-activation-[a-f0-9]{64}\.json$/)]);
  });

  it("permits only waiting, prepared, and terminal settled transitions", async () => {
    const project = await projectDirectory();
    const store = new LocalCapabilityRepositoryFirstActivationStore(project);
    const signal = new AbortController().signal;
    const waiting = await store.publish({
      expectedRecordDigest: null,
      state: waitingState(),
      signal,
    });
    requireStatus(waiting, "waiting");
    const attempted = await store.publish({
      expectedRecordDigest: waiting.recordDigest,
      state: {
        ...withoutDigest(waiting),
        attempts: 1,
        lastObservedAt: "2027-01-01T00:01:00.000Z",
      },
      signal,
    });
    requireStatus(attempted, "waiting");
    const prepared = await store.publish({
      expectedRecordDigest: attempted.recordDigest,
      state: {
        ...withoutDigest(attempted),
        status: "prepared",
        lastObservedAt: "2027-01-01T00:01:01.000Z",
        receipt: receipt(),
      },
      signal,
    });
    requireStatus(prepared, "prepared");
    const settled = await store.publish({
      expectedRecordDigest: prepared.recordDigest,
      state: {
        ...withoutDigest(prepared),
        status: "settled",
        settledAt: "2027-01-01T00:01:02.000Z",
      },
      signal,
    });

    await expect(
      store.publish({
        expectedRecordDigest: settled.recordDigest,
        state: waitingState(),
        signal,
      }),
    ).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("publish activation state"),
    );
    await expect(store.read(waiting.authorization, signal)).resolves.toEqual(settled);
  });

  it("rejects a stale compare-and-swap without changing the record", async () => {
    const project = await projectDirectory();
    const store = new LocalCapabilityRepositoryFirstActivationStore(project);
    const signal = new AbortController().signal;
    const waiting = await store.publish({
      expectedRecordDigest: null,
      state: waitingState(),
      signal,
    });
    requireStatus(waiting, "waiting");

    await expect(
      store.publish({
        expectedRecordDigest: `sha256:${"7".repeat(64)}`,
        state: { ...withoutDigest(waiting), attempts: 1 },
        signal,
      }),
    ).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("publish activation state"),
    );
    await expect(store.read(waiting.authorization, signal)).resolves.toEqual(waiting);
  });

  it("preserves pre-rename cancellation evidence and blocks later inference", async () => {
    const project = await projectDirectory();
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    const store = new LocalCapabilityRepositoryFirstActivationStore(project, {
      beforeRecordRename: () => controller.abort(reason),
    });

    await expect(
      store.publish({
        expectedRecordDigest: null,
        state: waitingState(),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    const entries = await readdir(join(project, ".flow", "capability.repository"));
    expect(entries).toEqual([expect.stringMatching(/^\.first-activation-.+\.json\.pending$/)]);
    await expect(
      new LocalCapabilityRepositoryFirstActivationStore(project).read(
        waitingState().authorization,
        new AbortController().signal,
      ),
    ).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("inspect activation state"),
    );
  });

  it("reports post-rename settlement uncertainty while preserving the reopened record", async () => {
    const project = await projectDirectory();
    const store = new LocalCapabilityRepositoryFirstActivationStore(project, {
      afterRecordRenamed: () => {
        throw new Error("PRIVATE_DIRECTORY_SYNC_FAILURE");
      },
    });

    await expect(
      store.publish({
        expectedRecordDigest: null,
        state: waitingState(),
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("settle activation state"),
    );

    const reopened = await new LocalCapabilityRepositoryFirstActivationStore(project).read(
      waitingState().authorization,
      new AbortController().signal,
    );
    expect(reopened).toMatchObject({ status: "waiting", attempts: 0 });
  });

  it("rejects linked and oversized records without changing external files", async () => {
    const project = await projectDirectory();
    const store = new LocalCapabilityRepositoryFirstActivationStore(project);
    const signal = new AbortController().signal;
    await store.publish({ expectedRecordDigest: null, state: waitingState(), signal });
    const root = join(project, ".flow", "capability.repository");
    const recordName = (await readdir(root)).find((entry) => entry.startsWith("first-activation-"));
    if (recordName === undefined) {
      throw new Error("test requires a first activation record");
    }
    const recordPath = join(root, recordName);
    const external = join(project, "PRIVATE_EXTERNAL_CANARY");
    await writeFile(external, "PRIVATE_EXTERNAL_VALUE");
    await unlink(recordPath);
    await symlink(external, recordPath);

    await expect(store.read(waitingState().authorization, signal)).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("inspect activation state"),
    );
    await expect(readFile(external, "utf8")).resolves.toBe("PRIVATE_EXTERNAL_VALUE");

    await unlink(recordPath);
    await writeFile(
      recordPath,
      Buffer.alloc(MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_RECORD_BYTES + 1, 0x61),
    );
    expect((await lstat(recordPath)).size).toBe(
      MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_RECORD_BYTES + 1,
    );
    await expect(store.read(waitingState().authorization, signal)).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("inspect activation state"),
    );
  });
});

async function projectDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-first-activation-store-"));
  roots.push(root);
  await mkdir(join(root, ".flow", "capability.repository"), { recursive: true, mode: 0o700 });
  return root;
}

function waitingState(): CapabilityRepositoryFirstActivationWaitingState {
  return Object.freeze({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "CapabilityRepositoryFirstActivation",
    status: "waiting",
    authorization: Object.freeze({
      packageName: "review-suite",
      version: "1.0.0",
      certificateIssuer: "https://issuer.example.test/",
      certificateIdentity: "https://publisher.example.test/release",
    }),
    intervalMs: 60_000,
    maxChecks: 2,
    attempts: 0,
    createdAt: "2027-01-01T00:00:00.000Z",
    lastObservedAt: "2027-01-01T00:00:00.000Z",
  });
}

function receipt() {
  return Object.freeze({
    candidateDigest: `sha256:${"1".repeat(64)}` as const,
    checkedAt: "2027-01-01T00:01:00.000Z",
    source: "https://packages.example.test/targets/10/review-suite.flowpkg.json",
    bundle: Object.freeze({
      name: "review-suite",
      version: "1.0.0",
      bytes: 1,
      digest: `sha256:${"2".repeat(64)}`,
    }),
    publisher: Object.freeze({
      kind: "sigstore-keyless-v0.3" as const,
      certificateIssuer: "https://issuer.example.test/",
      certificateIdentity: "https://publisher.example.test/release",
      signatureBundleDigest: `sha256:${"3".repeat(64)}`,
    }),
  });
}

function withoutDigest<T extends { readonly recordDigest: string }>(
  state: T,
): Omit<T, "recordDigest"> {
  const { recordDigest: _recordDigest, ...content } = state;
  return content;
}

function requireStatus<S extends "waiting" | "prepared" | "settled">(
  state: { readonly status: "waiting" | "prepared" | "settled" },
  status: S,
): asserts state is typeof state & { readonly status: S } {
  if (state.status !== status) {
    throw new Error(`test requires ${status} state`);
  }
}
