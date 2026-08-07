import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAdmissionInitializedEvent,
  createDispatchReservedEvent,
  createJobEnqueuedEvent,
  createJobReleasedEvent,
  type AdmissionJobIdentity,
} from "../../../src/supervisor/admission.js";
import {
  JsonlAdmissionStore,
  MAX_ADMISSION_EVENT_BYTES,
} from "../../../src/infrastructure/fs/jsonl-admission-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JsonlAdmissionStore", () => {
  it("creates an owner-private ledger and durably appends validated transitions", async () => {
    const runsDirectory = await createTemporaryDirectory();
    const store = new JsonlAdmissionStore(runsDirectory);
    let state = await store.open(initialized());

    state = await store.append(createDispatchReservedEvent(state, job(1), at(2)));
    state = await store.append(createJobEnqueuedEvent(state, job(2), at(3)));

    expect(state).toMatchObject({ activeCount: 1, queuedCount: 1, lastSequence: 3 });
    await expect(store.read()).resolves.toEqual(state);
    const ledgerPath = pathFor(runsDirectory);
    const contents = await readFile(ledgerPath, "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.trim().split("\n")).toHaveLength(3);
    expect((await stat(ledgerPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(runsDirectory, ".supervisor"))).mode & 0o777).toBe(0o700);
  });

  it("reopens an existing ledger under the identical policy and continues its sequence", async () => {
    const runsDirectory = await createTemporaryDirectory();
    const first = new JsonlAdmissionStore(runsDirectory);
    let state = await first.open(initialized());
    state = await first.append(createDispatchReservedEvent(state, job(1), at(2)));
    first.close();

    const recovered = new JsonlAdmissionStore(runsDirectory);
    state = await recovered.open(initialized());
    state = await recovered.append(createJobEnqueuedEvent(state, job(2), at(3)));

    expect(state).toMatchObject({ lastSequence: 3, activeCount: 1, queuedCount: 1 });
  });

  it("fails closed on a policy mismatch without changing the ledger", async () => {
    const runsDirectory = await createTemporaryDirectory();
    const original = new JsonlAdmissionStore(runsDirectory);
    await original.open(initialized());
    original.close();
    const before = await readFile(pathFor(runsDirectory), "utf8");

    const replacement = new JsonlAdmissionStore(runsDirectory);
    await expect(
      replacement.open(
        createAdmissionInitializedEvent({
          policyDigest: "b".repeat(64),
          limits: { maxActiveWorkers: 2, maxQueuedJobs: 4 },
          at: at(1),
        }),
      ),
    ).rejects.toMatchObject({ code: "policy_mismatch" });
    await expect(readFile(pathFor(runsDirectory), "utf8")).resolves.toBe(before);
  });

  it("ignores and repairs only an unterminated final record before appending", async () => {
    const runsDirectory = await createTemporaryDirectory();
    const original = new JsonlAdmissionStore(runsDirectory);
    let state = await original.open(initialized());
    state = await original.append(createDispatchReservedEvent(state, job(1), at(2)));
    original.close();
    const committed = await readFile(pathFor(runsDirectory), "utf8");
    await writeFile(pathFor(runsDirectory), `${committed}{"version":1`);

    const recovered = new JsonlAdmissionStore(runsDirectory);
    state = await recovered.open(initialized());
    await recovered.append(createJobEnqueuedEvent(state, job(2), at(3)));

    const repaired = await readFile(pathFor(runsDirectory), "utf8");
    expect(repaired).not.toContain('{"version":1\n');
    expect(repaired.endsWith("\n")).toBe(true);
    await expect(recovered.read()).resolves.toMatchObject({ lastSequence: 3, queuedCount: 1 });
  });

  it("rejects malformed committed prefixes and preserves their forensic bytes", async () => {
    const runsDirectory = await createTemporaryDirectory();
    const original = new JsonlAdmissionStore(runsDirectory);
    await original.open(initialized());
    original.close();
    const corrupt = `${await readFile(pathFor(runsDirectory), "utf8")}not-json\n`;
    await writeFile(pathFor(runsDirectory), corrupt);

    await expect(new JsonlAdmissionStore(runsDirectory).open(initialized())).rejects.toMatchObject({
      code: "corrupt",
    });
    await expect(readFile(pathFor(runsDirectory), "utf8")).resolves.toBe(corrupt);
  });

  it("atomically compacts to one replayable snapshot and continues FIFO counters", async () => {
    const runsDirectory = await createTemporaryDirectory();
    const store = new JsonlAdmissionStore(runsDirectory);
    let state = await store.open(initialized());
    state = await store.append(createDispatchReservedEvent(state, job(1), at(2)));
    state = await store.append(createJobEnqueuedEvent(state, job(2), at(3)));
    state = await store.append(createJobEnqueuedEvent(state, job(3), at(4)));
    state = await store.append(createJobReleasedEvent(state, job(1).jobId, "succeeded", at(5)));
    state = await store.append(createDispatchReservedEvent(state, job(2), at(6)));

    const compacted = await store.compact(at(7));
    expect(compacted).toEqual({ ...state, events: [] });
    const records = (await readFile(pathFor(runsDirectory), "utf8")).trim().split("\n");
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0] ?? "{}")).toMatchObject({
      type: "admission_snapshot",
      sequence: 6,
      lastQueueSequence: 2,
    });

    state = await store.append(createJobEnqueuedEvent(compacted, job(4), at(8)));
    expect(state).toMatchObject({ lastSequence: 7, lastQueueSequence: 3 });
    store.close();
    await expect(new JsonlAdmissionStore(runsDirectory).open(initialized())).resolves.toEqual(
      state,
    );
  });

  it("automatically compacts before the configured transition threshold is exceeded", async () => {
    const runsDirectory = await createTemporaryDirectory();
    const store = new JsonlAdmissionStore(
      runsDirectory,
      MAX_ADMISSION_EVENT_BYTES,
      2 * MAX_ADMISSION_EVENT_BYTES,
      2,
    );
    let state = await store.open(initialized());
    state = await store.append(createDispatchReservedEvent(state, job(1), at(2)));
    state = await store.append(createJobEnqueuedEvent(state, job(2), at(3)));

    state = await store.append(createJobEnqueuedEvent(state, job(3), at(4)));

    expect(state).toMatchObject({ lastSequence: 4, lastQueueSequence: 2, queuedCount: 2 });
    const records = (await readFile(pathFor(runsDirectory), "utf8")).trim().split("\n");
    expect(records).toHaveLength(2);
    expect(JSON.parse(records[0] ?? "{}")).toMatchObject({
      type: "admission_snapshot",
      sequence: 3,
      lastQueueSequence: 1,
    });
    expect(JSON.parse(records[1] ?? "{}")).toMatchObject({
      type: "job_enqueued",
      sequence: 4,
    });
    store.close();
    await expect(new JsonlAdmissionStore(runsDirectory).open(initialized())).resolves.toEqual(
      state,
    );
  });

  it("serializes concurrent appends and does not poison later operations after refusal", async () => {
    const runsDirectory = await createTemporaryDirectory();
    const store = new JsonlAdmissionStore(runsDirectory);
    const initial = await store.open(initialized());
    const first = createDispatchReservedEvent(initial, job(1), at(2));
    const afterFirst = await store.append(first);
    const valid = createJobEnqueuedEvent(afterFirst, job(2), at(3));
    const stale = { ...valid, sequence: 2 };

    const results = await Promise.allSettled([store.append(stale), store.append(valid)]);

    expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "corrupt" } });
    expect(results[1]).toMatchObject({
      status: "fulfilled",
      value: { lastSequence: 3, queuedCount: 1 },
    });
    await expect(store.read()).resolves.toMatchObject({ lastSequence: 3, queuedCount: 1 });
  });

  it("rejects oversized records and appends before open without filesystem mutation", async () => {
    const runsDirectory = await createTemporaryDirectory();
    const unopened = new JsonlAdmissionStore(runsDirectory);
    const state = stateForFactory();
    await expect(
      unopened.append(createDispatchReservedEvent(state, job(1), at(2))),
    ).rejects.toMatchObject({ code: "not_open" });

    const tooSmall = new JsonlAdmissionStore(runsDirectory, 32);
    await expect(tooSmall.open(initialized())).rejects.toMatchObject({ code: "limit" });
    await expect(stat(pathFor(runsDirectory))).rejects.toMatchObject({ code: "ENOENT" });
    expect(MAX_ADMISSION_EVENT_BYTES).toBeGreaterThan(1_024);
  });

  it("retires only an idle policy ledger so a new generation can rebind", async () => {
    const runsDirectory = await createTemporaryDirectory();
    const active = new JsonlAdmissionStore(runsDirectory);
    let state = await active.open(initialized());
    state = await active.append(createDispatchReservedEvent(state, job(1), at(2)));
    await expect(active.retire()).rejects.toMatchObject({ code: "not_idle" });
    state = await active.append(createJobReleasedEvent(state, job(1).jobId, "succeeded", at(3)));

    const retiredPath = await active.retire();

    expect(retiredPath).toMatch(/admission\..+\.retired\.jsonl$/);
    await expect(stat(retiredPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(stat(pathFor(runsDirectory))).rejects.toMatchObject({ code: "ENOENT" });
    const replacement = new JsonlAdmissionStore(runsDirectory);
    await expect(
      replacement.open(
        createAdmissionInitializedEvent({
          policyDigest: "b".repeat(64),
          limits: { maxActiveWorkers: 2, maxQueuedJobs: 4 },
          at: at(4),
        }),
      ),
    ).resolves.toMatchObject({ policyDigest: "b".repeat(64), activeCount: 0 });
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-admission-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function stateForFactory() {
  const event = initialized();
  return {
    policyDigest: event.policyDigest,
    limits: event.limits,
    lastSequence: 1,
    lastQueueSequence: 0,
    activeCount: 0,
    queuedCount: 0,
    jobs: {},
    rejections: {},
    events: [],
  } as const;
}

function initialized() {
  return createAdmissionInitializedEvent({
    policyDigest: "a".repeat(64),
    limits: { maxActiveWorkers: 1, maxQueuedJobs: 4 },
    at: at(1),
  });
}

function job(index: number): AdmissionJobIdentity {
  return {
    jobId: id(index),
    workerId: id(index + 20),
    runId: `run-${index}`,
    jobDigest: index.toString(16).padStart(64, "0"),
  };
}

function id(index: number): `${string}-${string}-${string}-${string}-${string}` {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function at(sequence: number): string {
  return new Date(Date.UTC(2026, 7, 7, 0, 0, sequence)).toISOString();
}

function pathFor(runsDirectory: string): string {
  return join(runsDirectory, ".supervisor", "admission.jsonl");
}
