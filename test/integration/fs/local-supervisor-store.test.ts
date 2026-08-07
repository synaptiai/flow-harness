import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalSupervisorStore,
  LocalSupervisorStoreError,
} from "../../../src/infrastructure/fs/local-supervisor-store.js";
import {
  completeSubmissionCommand,
  createActiveRunClaim,
  completeCancellationCommand,
  createCancellationCommandRecord,
  createJobRecord,
  createSubmissionCommandRecord,
  createSupervisorStartLock,
  parseSupervisorDescriptor,
  parseWorkerDescriptor,
  queueSubmissionCommand,
} from "../../../src/supervisor/records.js";
import { SUPERVISOR_PROTOCOL_VERSION } from "../../../src/supervisor/protocol.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalSupervisorStore", () => {
  it("creates owner-only control directories", async () => {
    const { store } = await createStore();

    await store.initialize();

    for (const directory of [
      store.controlDirectory,
      store.jobsDirectory,
      store.claimsDirectory,
      store.workersDirectory,
      store.commandsDirectory,
      store.socketDirectory,
    ]) {
      const metadata = await lstat(directory);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.mode & 0o777).toBe(0o700);
      expect(metadata.uid).toBe(process.getuid?.());
    }
  });

  it("durably reserves one job and active claim for a run", async () => {
    const { store } = await createStore();
    const job = jobRecord();
    const claim = createActiveRunClaim({
      runId: job.runId,
      jobId: job.jobId,
      workerId: job.workerId,
      claimedAt: job.createdAt,
    });

    await store.initialize();
    await store.reserveSubmission(job, claim);

    await expect(store.readJob(job.jobId)).resolves.toEqual(job);
    await expect(store.readActiveRunClaim(job.runId)).resolves.toEqual(claim);
    expect((await lstat(join(store.jobsDirectory, `${job.jobId}.json`))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(store.claimsDirectory, `${job.runId}.json`))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("persists an inert queued job before claiming it for later dispatch", async () => {
    const { store } = await createStore();
    const job = jobRecord();
    const claim = createActiveRunClaim({
      runId: job.runId,
      jobId: job.jobId,
      workerId: job.workerId,
      claimedAt: job.createdAt,
    });

    await store.reserveJob(job);
    await expect(store.readJob(job.jobId)).resolves.toEqual(job);
    await expect(store.readActiveRunClaim(job.runId)).resolves.toBeNull();

    await store.reserveActiveRunClaim(claim);
    await expect(store.readActiveRunClaim(job.runId)).resolves.toEqual(claim);
  });

  it("rejects duplicate active claims without replacing the established job", async () => {
    const { store } = await createStore();
    const first = jobRecord();
    const second = jobRecord({ runId: first.runId });
    await store.initialize();
    await store.reserveSubmission(
      first,
      createActiveRunClaim({
        runId: first.runId,
        jobId: first.jobId,
        workerId: first.workerId,
        claimedAt: first.createdAt,
      }),
    );

    await expect(
      store.reserveSubmission(
        second,
        createActiveRunClaim({
          runId: second.runId,
          jobId: second.jobId,
          workerId: second.workerId,
          claimedAt: second.createdAt,
        }),
      ),
    ).rejects.toMatchObject({ code: "run_claimed" });
    await expect(store.readActiveRunClaim(first.runId)).resolves.toMatchObject({
      jobId: first.jobId,
      workerId: first.workerId,
    });
  });

  it("updates a worker descriptor without allowing identity replacement", async () => {
    const { store } = await createStore();
    const job = jobRecord();
    await store.initialize();
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const descriptor = parseWorkerDescriptor({
      version: 1,
      workerId: job.workerId,
      jobId: job.jobId,
      runId: job.runId,
      pid: 1234,
      token: job.token,
      jobDigest: job.digest,
      socketPath: join(store.socketDirectory, "worker.sock"),
      status: "running",
      startedAt: job.createdAt,
      updatedAt: job.createdAt,
    });

    await store.writeWorkerDescriptor(descriptor);
    await store.writeWorkerDescriptor(
      parseWorkerDescriptor({
        ...descriptor,
        status: "terminal",
        runStatus: "succeeded",
        exitCode: 0,
        updatedAt: "2026-08-07T12:00:01.000Z",
      }),
    );

    await expect(store.readWorkerDescriptor(job.workerId)).resolves.toMatchObject({
      status: "terminal",
      runStatus: "succeeded",
      exitCode: 0,
    });
    await expect(
      store.writeWorkerDescriptor({ ...descriptor, token: "d".repeat(64) }),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
  });

  it("publishes one supervisor generation and enumerates validated active workers", async () => {
    const { store } = await createStore();
    const job = jobRecord();
    await store.initialize();
    const supervisor = parseSupervisorDescriptor({
      version: 1,
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      generation: randomUUID(),
      pid: 2345,
      startedAt: job.createdAt,
      runsDirectory: store.runsDirectory,
      socketPath: join(store.socketDirectory, "supervisor.sock"),
      policyDigest: "a".repeat(64),
      limits: { maxActiveWorkers: 1, maxQueuedJobs: 32 },
    });
    const claim = createActiveRunClaim({
      runId: job.runId,
      jobId: job.jobId,
      workerId: job.workerId,
      claimedAt: job.createdAt,
    });
    const worker = parseWorkerDescriptor({
      version: 1,
      workerId: job.workerId,
      jobId: job.jobId,
      runId: job.runId,
      pid: 1234,
      token: job.token,
      jobDigest: job.digest,
      socketPath: join(store.socketDirectory, "worker.sock"),
      status: "running",
      startedAt: job.createdAt,
      updatedAt: job.createdAt,
    });

    await store.writeSupervisorDescriptor(supervisor);
    await store.reserveSubmission(job, claim);
    await store.writeWorkerDescriptor(worker);

    await expect(store.readSupervisorDescriptor()).resolves.toEqual(supervisor);
    await expect(store.listActiveRunClaims()).resolves.toEqual([claim]);
    await expect(store.listWorkerDescriptors()).resolves.toEqual([worker]);
    expect((await lstat(join(store.controlDirectory, "supervisor.json"))).mode & 0o777).toBe(0o600);
  });

  it("serializes supervisor startup and releases only the matching lock", async () => {
    const { store } = await createStore();
    const first = createSupervisorStartLock({
      pid: 1234,
      token: randomUUID(),
      acquiredAt: "2026-08-07T12:00:00.000Z",
    });
    const second = createSupervisorStartLock({
      pid: 5678,
      token: randomUUID(),
      acquiredAt: "2026-08-07T12:00:01.000Z",
    });

    await expect(store.reserveSupervisorStart(first)).resolves.toEqual({
      acquired: true,
      record: first,
    });
    await expect(store.reserveSupervisorStart(second)).resolves.toEqual({
      acquired: false,
      record: first,
    });
    await expect(store.releaseSupervisorStart(second.token)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    await expect(store.releaseSupervisorStart(first.token)).resolves.toBeUndefined();
    await expect(store.reserveSupervisorStart(second)).resolves.toEqual({
      acquired: true,
      record: second,
    });
  });

  it("publishes one complete startup lock under concurrent reservation", async () => {
    const { store } = await createStore();
    const locks = Array.from({ length: 32 }, (_, index) =>
      createSupervisorStartLock({
        pid: 10_000 + index,
        token: randomUUID(),
        acquiredAt: new Date(Date.UTC(2026, 7, 7, 12, 0, index)).toISOString(),
      }),
    );

    const reservations = await Promise.all(
      locks.map(async (lock) => await store.reserveSupervisorStart(lock)),
    );
    const winner = reservations.find((reservation) => reservation.acquired);

    expect(winner).toBeDefined();
    expect(reservations.filter((reservation) => reservation.acquired)).toHaveLength(1);
    expect(
      reservations.every((reservation) => reservation.record.token === winner?.record.token),
    ).toBe(true);
  });

  it("releases only the matching active claim", async () => {
    const { store } = await createStore();
    const job = jobRecord();
    await store.initialize();
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );

    await expect(store.releaseActiveRunClaim(job.runId, randomUUID())).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    await expect(store.readActiveRunClaim(job.runId)).resolves.not.toBeNull();

    await store.releaseActiveRunClaim(job.runId, job.jobId);
    await expect(store.readActiveRunClaim(job.runId)).resolves.toBeNull();
  });

  it("fails closed on corrupt records and symlinked private roots", async () => {
    const { directory, store } = await createStore();
    await store.initialize();
    await writeFile(join(store.claimsDirectory, "run-1.json"), "{not-json\n", { mode: 0o600 });

    await expect(store.readActiveRunClaim("run-1")).rejects.toMatchObject({ code: "corrupt" });

    const target = join(directory, "socket-target");
    const linked = join(directory, "socket-link");
    await rm(store.socketDirectory, { recursive: true });
    await writeFile(target, "not a directory", "utf8");
    await symlink(target, linked);
    const unsafeStore = new LocalSupervisorStore(join(directory, "other-runs"), {
      socketDirectory: linked,
    });

    await expect(unsafeStore.initialize()).rejects.toBeInstanceOf(LocalSupervisorStoreError);
  });

  it("tightens an existing private directory instead of trusting ambient umask", async () => {
    const { store } = await createStore();
    await store.initialize();
    await chmod(store.controlDirectory, 0o755);

    await store.initialize();

    expect((await lstat(store.controlDirectory)).mode & 0o777).toBe(0o700);
  });

  it("journals cancellation before dispatch and permits only monotonic completion", async () => {
    const { store } = await createStore();
    await store.initialize();
    const recorded = createCancellationCommandRecord({
      commandId: randomUUID(),
      runId: "run-1",
      actor: "operator:test",
      reason: "Stop it.",
      recordedAt: "2026-08-07T12:00:00.000Z",
    });

    await expect(store.recordCommand(recorded)).resolves.toEqual(recorded);
    await expect(store.recordCommand(recorded)).resolves.toEqual(recorded);
    await expect(
      store.recordCommand(
        createCancellationCommandRecord({
          commandId: recorded.commandId,
          runId: recorded.runId,
          actor: "other",
          reason: recorded.reason,
          recordedAt: "2026-08-07T12:00:02.000Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "identity_mismatch" });

    const completed = completeCancellationCommand(
      recorded,
      { runStatus: "cancelled", phase: "active", lastSequence: 4 },
      "2026-08-07T12:00:01.000Z",
    );
    await store.updateCommand(completed);
    await expect(store.readCommand(recorded.commandId)).resolves.toEqual(completed);
    await expect(store.updateCommand(recorded)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(
      (await lstat(join(store.commandsDirectory, `${recorded.commandId}.json`))).mode & 0o777,
    ).toBe(0o600);
  });

  it("permits a durable queued submission to advance to accepted exactly once", async () => {
    const { store } = await createStore();
    await store.initialize();
    const recorded = createSubmissionCommandRecord({
      commandId: randomUUID(),
      policyDigest: "a".repeat(64),
      runId: "run-1",
      mode: "run",
      sourceName: "/workspace/workflow.yaml",
      workflowSource: "kind: Workflow\n",
      cwd: "/workspace",
      recordedAt: "2026-08-07T12:00:00.000Z",
    });
    const queued = queueSubmissionCommand(recorded, 1, "2026-08-07T12:00:01.000Z");
    const completed = completeSubmissionCommand(
      queued,
      { workerId: randomUUID(), acceptedAt: "2026-08-07T12:00:02.000Z" },
      "2026-08-07T12:00:02.000Z",
    );

    await store.recordCommand(recorded);
    await store.updateCommand(queued);
    await store.updateCommand(completed);

    await expect(store.readCommand(recorded.commandId)).resolves.toEqual(completed);
    await expect(store.updateCommand(queued)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
  });
});

async function createStore(): Promise<{
  readonly directory: string;
  readonly store: LocalSupervisorStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "flow-supervisor-store-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    store: new LocalSupervisorStore(join(directory, "runs"), {
      socketDirectory: join(directory, "sockets"),
    }),
  };
}

function jobRecord(overrides: { readonly runId?: string } = {}) {
  return createJobRecord({
    jobId: randomUUID(),
    workerId: randomUUID(),
    runId: overrides.runId ?? "run-1",
    mode: "run",
    sourceName: "/workspace/workflow.yaml",
    workflowSource: "kind: Workflow\n",
    cwd: "/workspace",
    token: "a".repeat(64),
    createdAt: "2026-08-07T12:00:00.000Z",
  });
}
