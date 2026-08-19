import { createHash } from "node:crypto";
import {
  appendFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CapabilityRepositoryFirstActivationPreparedState,
  CapabilityRepositoryFirstActivationWaitingState,
} from "../../../../src/application/capability-repository-first-activation.js";
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
    await expect(
      store.publish({
        expectedRecordDigest: prepared.recordDigest,
        state: {
          ...withoutDigest(prepared),
          lastObservedAt: "2027-01-01T00:00:59.000Z",
        },
        signal,
      }),
    ).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("publish activation state"),
    );
    await expect(
      store.publish({
        expectedRecordDigest: prepared.recordDigest,
        state: {
          ...withoutDigest(prepared),
          receipt: { ...prepared.receipt, source: "https://packages.example.test/substitute" },
          lastObservedAt: "2027-01-01T00:02:00.000Z",
        },
        signal,
      }),
    ).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("publish activation state"),
    );
    await expect(store.read(prepared.authorization, signal)).resolves.toEqual(prepared);
    const advanced = await store.publish({
      expectedRecordDigest: prepared.recordDigest,
      state: {
        ...withoutDigest(prepared),
        lastObservedAt: "2027-01-01T00:02:00.000Z",
      },
      signal,
    });
    requireStatus(advanced, "prepared");
    expect(advanced.receipt).toEqual(prepared.receipt);
    const settled = await store.publish({
      expectedRecordDigest: advanced.recordDigest,
      state: {
        ...withoutDigest(advanced),
        status: "settled",
        settledAt: "2027-01-01T00:02:01.000Z",
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

  it("rejects a redigested prepared record without one consumed attempt", async () => {
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
    await store.publish({
      expectedRecordDigest: attempted.recordDigest,
      state: {
        ...withoutDigest(attempted),
        status: "prepared",
        lastObservedAt: "2027-01-01T00:01:01.000Z",
        receipt: receipt(),
      },
      signal,
    });
    const root = join(project, ".flow", "capability.repository");
    const recordName = (await readdir(root)).find((entry) => entry.startsWith("first-activation-"));
    if (recordName === undefined) {
      throw new Error("test requires a first activation record");
    }
    const recordPath = join(root, recordName);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    const tampered = Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, key === "attempts" ? 0 : value]),
    );
    const withoutRecordDigest = Object.fromEntries(
      Object.entries(tampered).filter(([key]) => key !== "recordDigest"),
    );
    tampered.recordDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(withoutRecordDigest))
      .digest("hex")}`;
    await writeFile(recordPath, JSON.stringify(tampered));

    await expect(store.read(waiting.authorization, signal)).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("inspect activation state"),
    );
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

  it("rejects a hard-linked durable activation record", async () => {
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
    const externalLink = join(project, "PRIVATE_ACTIVATION_RECORD_LINK");
    await link(recordPath, externalLink);
    const before = await readFile(externalLink);

    await expect(store.read(waitingState().authorization, signal)).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("inspect activation state"),
    );
    await expect(readFile(externalLink)).resolves.toEqual(before);
  });

  it("rejects a symbolic-link directory below the project trust anchor", async () => {
    const project = await projectDirectory();
    const flow = join(project, ".flow");
    const directFlow = join(project, ".flow-direct");
    await rename(flow, directFlow);
    await symlink(directFlow, flow, "dir");
    const store = new LocalCapabilityRepositoryFirstActivationStore(project);

    await expect(
      store.publish({
        expectedRecordDigest: null,
        state: waitingState(),
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("publish activation state"),
    );
    expect(await readdir(join(directFlow, "capability.repository"))).toEqual([]);
  });

  it("bounds a record that grows after the opened-file size observation", async () => {
    const project = await projectDirectory();
    const signal = new AbortController().signal;
    const direct = new LocalCapabilityRepositoryFirstActivationStore(project);
    await direct.publish({ expectedRecordDigest: null, state: waitingState(), signal });
    const root = join(project, ".flow", "capability.repository");
    const recordName = (await readdir(root)).find((entry) => entry.startsWith("first-activation-"));
    if (recordName === undefined) {
      throw new Error("test requires a first activation record");
    }
    const recordPath = join(root, recordName);
    const hooks = {
      afterRecordStat: async () => {
        await appendFile(
          recordPath,
          Buffer.alloc(MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_RECORD_BYTES, 0x61),
        );
      },
    };
    const raced = new LocalCapabilityRepositoryFirstActivationStore(project, hooks);

    await expect(raced.read(waitingState().authorization, signal)).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("inspect activation state"),
    );
    expect((await lstat(recordPath)).size).toBeGreaterThan(
      MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_RECORD_BYTES,
    );
  });

  it("accepts an exact maximum-size canonical record and rejects one additional byte", async () => {
    const signal = new AbortController().signal;
    let lower = "https://packages.example.test/".length;
    let upper = 4_096;
    let exact:
      | {
          readonly project: string;
          readonly sourceLength: number;
          readonly state: CapabilityRepositoryFirstActivationPreparedState;
        }
      | undefined;

    while (lower <= upper) {
      const sourceLength = Math.floor((lower + upper) / 2);
      const project = await projectDirectory();
      const state = maximumRecordState(sourceLength);
      const store = new LocalCapabilityRepositoryFirstActivationStore(project);
      try {
        const waiting = await store.publish({
          expectedRecordDigest: null,
          state: maximumRecordWaitingState(state),
          signal,
        });
        const attempted = await store.publish({
          expectedRecordDigest: waiting.recordDigest,
          state: maximumRecordAttemptedState(state),
          signal,
        });
        await store.publish({ expectedRecordDigest: attempted.recordDigest, state, signal });
        exact = { project, sourceLength, state };
        lower = sourceLength + 1;
      } catch (error) {
        expect(error).toEqual(
          new LocalCapabilityRepositoryFirstActivationStoreError("publish activation state"),
        );
        upper = sourceLength - 1;
      }
    }
    if (exact === undefined) {
      throw new Error("test requires one valid bounded activation record");
    }
    const exactRoot = join(exact.project, ".flow", "capability.repository");
    const exactName = (await readdir(exactRoot)).find((entry) =>
      entry.startsWith("first-activation-"),
    );
    if (exactName === undefined) {
      throw new Error("test requires one published activation record");
    }
    expect((await readFile(join(exactRoot, exactName))).byteLength).toBe(
      MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_RECORD_BYTES,
    );
    await expect(
      new LocalCapabilityRepositoryFirstActivationStore(exact.project).read(
        exact.state.authorization,
        signal,
      ),
    ).resolves.toMatchObject({ status: "prepared" });

    const excessiveProject = await projectDirectory();
    const excessiveState = maximumRecordState(exact.sourceLength + 1);
    const excessiveStore = new LocalCapabilityRepositoryFirstActivationStore(excessiveProject);
    const excessiveWaiting = await excessiveStore.publish({
      expectedRecordDigest: null,
      state: maximumRecordWaitingState(excessiveState),
      signal,
    });
    const excessiveAttempted = await excessiveStore.publish({
      expectedRecordDigest: excessiveWaiting.recordDigest,
      state: maximumRecordAttemptedState(excessiveState),
      signal,
    });
    await expect(
      excessiveStore.publish({
        expectedRecordDigest: excessiveAttempted.recordDigest,
        state: excessiveState,
        signal,
      }),
    ).rejects.toEqual(
      new LocalCapabilityRepositoryFirstActivationStoreError("publish activation state"),
    );
    await expect(excessiveStore.read(excessiveState.authorization, signal)).resolves.toMatchObject({
      status: "waiting",
      attempts: 1,
    });
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

function maximumRecordState(
  sourceLength: number,
): CapabilityRepositoryFirstActivationPreparedState {
  const issuerPrefix = "https://issuer.example.test/";
  const issuer = `${issuerPrefix}${"i".repeat(1_900 - issuerPrefix.length)}`;
  const identity = "p".repeat(3_736);
  const sourcePrefix = "https://packages.example.test/";
  if (sourceLength < sourcePrefix.length || sourceLength > 4_096) {
    throw new Error("test source length is outside the state schema");
  }
  return Object.freeze({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "CapabilityRepositoryFirstActivation",
    status: "prepared",
    authorization: Object.freeze({
      packageName: "review-suite",
      version: "1.0.0",
      certificateIssuer: issuer,
      certificateIdentity: identity,
    }),
    intervalMs: 60_000,
    maxChecks: 2,
    attempts: 1,
    createdAt: "2027-01-01T00:00:00.000Z",
    lastObservedAt: "2027-01-01T00:01:01.000Z",
    receipt: Object.freeze({
      candidateDigest: `sha256:${"1".repeat(64)}`,
      checkedAt: "2027-01-01T00:01:00.000Z",
      source: `${sourcePrefix}${"s".repeat(sourceLength - sourcePrefix.length)}`,
      bundle: Object.freeze({
        name: "review-suite",
        version: "1.0.0",
        bytes: 1,
        digest: `sha256:${"2".repeat(64)}`,
      }),
      publisher: Object.freeze({
        kind: "sigstore-keyless-v0.3",
        certificateIssuer: issuer,
        certificateIdentity: identity,
        signatureBundleDigest: `sha256:${"3".repeat(64)}`,
      }),
    }),
  });
}

function maximumRecordWaitingState(
  prepared: CapabilityRepositoryFirstActivationPreparedState,
): CapabilityRepositoryFirstActivationWaitingState {
  const { receipt: _receipt, ...waiting } = prepared;
  return Object.freeze({
    ...waiting,
    status: "waiting",
    attempts: 0,
    lastObservedAt: waiting.createdAt,
  });
}

function maximumRecordAttemptedState(
  prepared: CapabilityRepositoryFirstActivationPreparedState,
): CapabilityRepositoryFirstActivationWaitingState {
  const { receipt: _receipt, ...waiting } = prepared;
  return Object.freeze({ ...waiting, status: "waiting" });
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
