import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { runWorkflow } from "../../../src/application/run-workflow.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { JsonlAdmissionStore } from "../../../src/infrastructure/fs/jsonl-admission-store.js";
import {
  LocalSupervisorStore,
  LocalSupervisorStoreError,
} from "../../../src/infrastructure/fs/local-supervisor-store.js";
import {
  LocalSupervisorService,
  SupervisorServiceError,
  type WorkerLauncher,
} from "../../../src/supervisor/service.js";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  type WorkerResponse,
} from "../../../src/supervisor/protocol.js";
import {
  createActiveRunClaim,
  createJobRecord,
  createSubmissionCommandRecord,
  parseWorkerDescriptor,
  type JobRecord,
  type ActiveRunClaim,
  type SupervisorCommandRecord,
} from "../../../src/supervisor/records.js";
import {
  createAdmissionInitializedEvent,
  createDispatchReservedEvent,
  createJobEnqueuedEvent,
  createJobReleasedEvent,
  createQueueCancellationRecordedEvent,
} from "../../../src/supervisor/admission.js";

const temporaryDirectories: string[] = [];
const POLICY_DIGEST = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalSupervisorService", () => {
  it("validates before mutation and durably deduplicates exact submissions", async () => {
    const harness = await createHarness();
    const commandId = randomUUID();
    const command = submitCommand(commandId, harness.directory);

    await expect(
      harness.service.submit({ ...command, workflowSource: "kind: Invalid\n" }),
    ).rejects.toThrow(/compilation/i);
    await expect(harness.store.listActiveRunClaims()).resolves.toEqual([]);
    await expect(harness.store.listWorkerDescriptors()).resolves.toEqual([]);

    const [first, concurrent] = await Promise.all([
      harness.service.submit(command),
      harness.service.submit(command),
    ]);
    const duplicate = await harness.service.submit(command);

    expect(first).toEqual(concurrent);
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      type: "accepted",
      commandId,
      runId: "service-run",
    });
    expect(harness.launcher.jobs).toHaveLength(1);
    await expect(harness.store.listActiveRunClaims()).resolves.toHaveLength(1);
  });

  it("bounds active workers and the durable queue with exact retry outcomes", async () => {
    const harness = await createHarness(undefined, { maxActiveWorkers: 1, maxQueuedJobs: 1 });
    const firstCommand = submitCommand(randomUUID(), harness.directory, "run-1");
    const queuedCommand = submitCommand(randomUUID(), harness.directory, "run-2");
    const rejectedCommand = submitCommand(randomUUID(), harness.directory, "run-3");

    const accepted = await harness.service.submit(firstCommand);
    const queued = await harness.service.submit(queuedCommand);
    const rejected = await harness.service.submit(rejectedCommand);

    expect(accepted).toMatchObject({ type: "accepted", runId: "run-1" });
    expect(queued).toMatchObject({ type: "queued", runId: "run-2", queuePosition: 1 });
    expect(rejected).toMatchObject({ type: "rejected", runId: "run-3", reason: "queue_full" });
    await expect(harness.service.submit(queuedCommand)).resolves.toEqual(queued);
    await expect(harness.service.submit(rejectedCommand)).resolves.toEqual(rejected);
    expect(harness.launcher.jobs).toHaveLength(1);
    await expect(harness.store.readActiveRunClaim("run-2")).resolves.toBeNull();
    await expect(harness.store.readJob(rejectedCommand.commandId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(harness.service.status()).resolves.toMatchObject({
      policyDigest: POLICY_DIGEST,
      limits: { maxActiveWorkers: 1, maxQueuedJobs: 1 },
      admission: { activeWorkers: 1, queuedJobs: 1 },
    });
  });

  it("replays queue-full rejection after its command-journal commit initially fails", async () => {
    const harness = await createHarness(
      (runsDirectory, socketDirectory) =>
        new FailingQueueRejectionStore(runsDirectory, { socketDirectory }),
      { maxActiveWorkers: 1, maxQueuedJobs: 0 },
    );
    const active = submitCommand(randomUUID(), harness.directory, "active-run");
    const rejected = submitCommand(randomUUID(), harness.directory, "rejected-run");
    await harness.service.submit(active);

    await expect(harness.service.submit(rejected)).rejects.toThrow(/simulated rejection commit/);
    expect(harness.admissionStore.state.rejections[rejected.commandId]).toMatchObject({
      runId: rejected.runId,
      reason: "queue_full",
    });
    await expect(harness.service.prepareShutdown()).rejects.toMatchObject({ code: "conflict" });
    await harness.launcher.complete(active.commandId);
    await harness.service.reconcile();

    await expect(harness.service.submit(rejected)).resolves.toMatchObject({
      type: "rejected",
      runId: rejected.runId,
      reason: "queue_full",
    });
    expect(harness.admissionStore.state.rejections).toEqual({});
    expect(harness.launcher.jobs.map((job) => job.runId)).toEqual([active.runId]);
  });

  it("never oversubscribes concurrent submissions at active and queue boundaries", async () => {
    const harness = await createHarness(undefined, { maxActiveWorkers: 2, maxQueuedJobs: 3 });
    const commands = Array.from({ length: 12 }, (_, index) =>
      submitCommand(randomUUID(), harness.directory, `concurrent-${index}`),
    );

    const results = await Promise.all(
      commands.map(async (command) => await harness.service.submit(command)),
    );

    expect(results.filter((result) => result.type === "accepted")).toHaveLength(2);
    expect(results.filter((result) => result.type === "queued")).toHaveLength(3);
    expect(results.filter((result) => result.type === "rejected")).toHaveLength(7);
    expect(harness.launcher.jobs).toHaveLength(2);
    expect(harness.admissionStore.state).toMatchObject({ activeCount: 2, queuedCount: 3 });
  });

  it("releases terminal capacity and dispatches queued work in durable FIFO order", async () => {
    const harness = await createHarness(undefined, { maxActiveWorkers: 1, maxQueuedJobs: 2 });
    const first = submitCommand(randomUUID(), harness.directory, "run-1");
    const second = submitCommand(randomUUID(), harness.directory, "run-2");
    const third = submitCommand(randomUUID(), harness.directory, "run-3");
    await harness.service.submit(first);
    await harness.service.submit(second);
    await harness.service.submit(third);

    await harness.launcher.complete(first.commandId);
    await harness.service.reconcile();

    expect(harness.launcher.jobs.map((job) => job.runId)).toEqual(["run-1", "run-2"]);
    await expect(harness.store.readCommand(second.commandId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(harness.store.readCommand(third.commandId)).resolves.toMatchObject({
      status: "queued",
      result: { queuePosition: 2 },
    });

    await harness.launcher.complete(second.commandId);
    await harness.service.reconcile();

    expect(harness.launcher.jobs.map((job) => job.runId)).toEqual(["run-1", "run-2", "run-3"]);
    expect(harness.admissionStore.state).toMatchObject({ activeCount: 1, queuedCount: 0 });
  });

  it("continues independent FIFO launches after one queued launch becomes uncertain", async () => {
    const harness = await createHarness(undefined, { maxActiveWorkers: 2, maxQueuedJobs: 2 });
    const first = submitCommand(randomUUID(), harness.directory, "active-1");
    const second = submitCommand(randomUUID(), harness.directory, "active-2");
    const uncertain = submitCommand(randomUUID(), harness.directory, "queued-uncertain");
    const healthy = submitCommand(randomUUID(), harness.directory, "queued-healthy");
    await harness.service.submit(first);
    await harness.service.submit(second);
    await harness.service.submit(uncertain);
    await harness.service.submit(healthy);
    await harness.launcher.complete(first.commandId);
    await harness.launcher.complete(second.commandId);
    harness.launcher.failBeforeDescriptorRunIds.add(uncertain.runId);

    await expect(harness.service.reconcile()).resolves.toBeUndefined();

    expect(harness.admissionStore.state.jobs[uncertain.commandId]).toMatchObject({
      status: "uncertain",
    });
    expect(harness.admissionStore.state.jobs[healthy.commandId]).toMatchObject({
      status: "accepted",
    });
    await expect(harness.store.readCommand(uncertain.commandId)).resolves.toMatchObject({
      status: "uncertain",
    });
    await expect(harness.store.readCommand(healthy.commandId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("imports a legacy active claim before admitting new work", async () => {
    const harness = await createHarness(undefined, { maxActiveWorkers: 1, maxQueuedJobs: 1 });
    const legacyCommand = submitCommand(randomUUID(), harness.directory, "legacy-run");
    const recordedAt = "2026-08-07T12:00:00.000Z";
    await harness.store.recordCommand(
      createSubmissionCommandRecord({ ...legacyCommand, recordedAt }),
    );
    const legacyJob = createJobRecord({
      jobId: legacyCommand.commandId,
      workerId: randomUUID(),
      runId: legacyCommand.runId,
      mode: legacyCommand.mode,
      sourceName: legacyCommand.sourceName,
      workflowSource: legacyCommand.workflowSource,
      cwd: legacyCommand.cwd,
      token: "a".repeat(64),
      createdAt: recordedAt,
    });
    await harness.store.reserveSubmission(
      legacyJob,
      createActiveRunClaim({
        runId: legacyJob.runId,
        jobId: legacyJob.jobId,
        workerId: legacyJob.workerId,
        claimedAt: legacyJob.createdAt,
      }),
    );
    await harness.launcher.launch(legacyJob);

    await harness.service.reconcile();
    const queued = await harness.service.submit(
      submitCommand(randomUUID(), harness.directory, "new-run"),
    );

    expect(queued).toMatchObject({ type: "queued", queuePosition: 1 });
    expect(harness.admissionStore.state).toMatchObject({ activeCount: 1, queuedCount: 1 });
    expect(harness.launcher.jobs).toHaveLength(1);
  });

  it("restarts a durable pre-launch dispatch reservation with the same identity", async () => {
    const harness = await createHarness();
    const command = submitCommand(randomUUID(), harness.directory, "restart-run");
    const recordedAt = "2026-08-07T12:00:00.000Z";
    await harness.store.recordCommand(createSubmissionCommandRecord({ ...command, recordedAt }));
    const job = createJobRecord({
      jobId: command.commandId,
      workerId: randomUUID(),
      runId: command.runId,
      mode: command.mode,
      sourceName: command.sourceName,
      workflowSource: command.workflowSource,
      cwd: command.cwd,
      token: "b".repeat(64),
      createdAt: recordedAt,
    });
    await harness.store.reserveJob(job);
    await harness.admissionStore.append(
      createDispatchReservedEvent(
        harness.admissionStore.state,
        {
          jobId: job.jobId,
          workerId: job.workerId,
          runId: job.runId,
          jobDigest: job.digest,
        },
        recordedAt,
      ),
    );

    await harness.service.reconcile();

    expect(harness.launcher.jobs).toEqual([job]);
    await expect(harness.store.readCommand(command.commandId)).resolves.toMatchObject({
      status: "completed",
      result: { workerId: job.workerId },
    });
    expect(harness.admissionStore.state.jobs[job.jobId]).toMatchObject({ status: "accepted" });
  });

  it("continues restart adoption after one published worker becomes unreachable", async () => {
    const harness = await createHarness(undefined, { maxActiveWorkers: 2, maxQueuedJobs: 0 });
    const commands = [
      submitCommand(randomUUID(), harness.directory, "unreachable-run"),
      submitCommand(randomUUID(), harness.directory, "healthy-run"),
    ];
    const jobs: JobRecord[] = [];
    for (const [index, command] of commands.entries()) {
      if (command === undefined) {
        throw new Error("test requires two commands");
      }
      const recordedAt = `2026-08-07T12:00:0${index}.000Z`;
      await harness.store.recordCommand(createSubmissionCommandRecord({ ...command, recordedAt }));
      const job = createJobRecord({
        jobId: command.commandId,
        workerId: randomUUID(),
        runId: command.runId,
        mode: command.mode,
        sourceName: command.sourceName,
        workflowSource: command.workflowSource,
        cwd: command.cwd,
        token: `${index + 1}`.repeat(64),
        createdAt: recordedAt,
      });
      jobs.push(job);
      await harness.store.reserveJob(job);
      await harness.admissionStore.append(
        createDispatchReservedEvent(
          harness.admissionStore.state,
          {
            jobId: job.jobId,
            workerId: job.workerId,
            runId: job.runId,
            jobDigest: job.digest,
          },
          recordedAt,
        ),
      );
      await harness.launcher.launch(job);
    }
    harness.launcher.unreachableIdentityRunIds.add("unreachable-run");

    await expect(harness.service.reconcile()).resolves.toBeUndefined();

    expect(harness.admissionStore.state.jobs[jobs[0]?.jobId ?? ""]).toMatchObject({
      status: "uncertain",
    });
    expect(harness.admissionStore.state.jobs[jobs[1]?.jobId ?? ""]).toMatchObject({
      status: "accepted",
    });
    await expect(harness.store.readCommand(commands[0]?.commandId ?? "")).resolves.toMatchObject({
      status: "uncertain",
    });
    await expect(harness.store.readCommand(commands[1]?.commandId ?? "")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("rejects command-id reuse with different execution input", async () => {
    const harness = await createHarness();
    const command = submitCommand(randomUUID(), harness.directory);
    await harness.service.submit(command);

    await expect(
      harness.service.submit({ ...command, cwd: join(harness.directory, "other") }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(harness.launcher.jobs).toHaveLength(1);
  });

  it("rejects concurrent command-id reuse with different execution input", async () => {
    const harness = await createHarness();
    const command = submitCommand(randomUUID(), harness.directory);

    const accepted = harness.service.submit(command);
    const conflicting = expect(
      harness.service.submit({
        ...command,
        cwd: join(harness.directory, "different"),
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await Promise.all([expect(accepted).resolves.toMatchObject({ type: "accepted" }), conflicting]);
    expect(harness.launcher.jobs).toHaveLength(1);
  });

  it("durably replays a conflicting duplicate-run submission without launching it later", async () => {
    const harness = await createHarness();
    const acceptedCommand = submitCommand(randomUUID(), harness.directory);
    await harness.service.submit(acceptedCommand);
    const conflictingCommand = submitCommand(randomUUID(), harness.directory);

    await expect(harness.service.submit(conflictingCommand)).rejects.toMatchObject({
      code: "conflict",
    });

    await harness.store.releaseActiveRunClaim(acceptedCommand.runId, acceptedCommand.commandId);

    await expect(harness.service.submit(conflictingCommand)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(harness.launcher.jobs).toHaveLength(1);
  });

  it("reconciles a lost submission acknowledgement without launching a second worker", async () => {
    const harness = await createHarness();
    const command = submitCommand(randomUUID(), harness.directory);
    harness.launcher.loseLaunchAcknowledgement = true;

    await expect(harness.service.submit(command)).resolves.toMatchObject({
      type: "accepted",
      commandId: command.commandId,
      runId: command.runId,
    });
    await expect(harness.store.readCommand(command.commandId)).resolves.toMatchObject({
      type: "submit",
      status: "completed",
    });

    harness.launcher.loseLaunchAcknowledgement = false;
    await expect(harness.service.submit(command)).resolves.toMatchObject({
      type: "accepted",
      commandId: command.commandId,
      runId: command.runId,
    });
    expect(harness.launcher.jobs).toHaveLength(1);
    await expect(harness.store.readCommand(command.commandId)).resolves.toMatchObject({
      type: "submit",
      status: "completed",
    });
  });

  it("safely admits an exact inert job left before the admission decision", async () => {
    const harness = await createHarness();
    const command = submitCommand(randomUUID(), harness.directory);
    const recordedAt = "2026-08-07T12:00:00.000Z";
    await harness.store.recordCommand(createSubmissionCommandRecord({ ...command, recordedAt }));
    const job = createJobRecord({
      jobId: command.commandId,
      workerId: randomUUID(),
      runId: command.runId,
      mode: command.mode,
      sourceName: command.sourceName,
      workflowSource: command.workflowSource,
      cwd: command.cwd,
      token: "a".repeat(64),
      createdAt: recordedAt,
    });
    await harness.store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    await harness.store.releaseActiveRunClaim(job.runId, job.jobId);

    await expect(harness.service.submit(command)).resolves.toMatchObject({
      type: "accepted",
      commandId: command.commandId,
    });
    expect(harness.launcher.jobs).toHaveLength(1);
  });

  it("reports uncertain acceptance when the post-launch journal write fails", async () => {
    const harness = await createHarness(
      (runsDirectory, socketDirectory) =>
        new FailingSubmissionCompletionStore(runsDirectory, { socketDirectory }),
    );
    const command = submitCommand(randomUUID(), harness.directory);

    await expect(harness.service.submit(command)).rejects.toMatchObject({
      code: "command_uncertain",
    });
    await expect(harness.service.submit(command)).resolves.toMatchObject({
      type: "accepted",
      commandId: command.commandId,
    });
    expect(harness.launcher.jobs).toHaveLength(1);
  });

  it("reports active worker health only after identity verification", async () => {
    const harness = await createHarness();
    await harness.service.submit(submitCommand(randomUUID(), harness.directory));

    const status = await harness.service.status();

    expect(status).toMatchObject({
      type: "status",
      generation: harness.generation,
      pid: 9876,
      workers: [
        {
          runId: "service-run",
          pid: 4321,
          status: "running",
          runStatus: "running",
        },
      ],
    });

    harness.launcher.identityMismatch = true;
    const mismatched = await harness.service.status();
    expect(mismatched.workers).toEqual([
      expect.objectContaining({ runId: "service-run", status: "uncertain" }),
    ]);
  });

  it("never enumerates historical worker descriptors for status or reconciliation", async () => {
    const harness = await createHarness(
      (runsDirectory, socketDirectory) =>
        new NoHistoricalWorkerEnumerationStore(runsDirectory, { socketDirectory }),
    );
    await harness.service.submit(submitCommand(randomUUID(), harness.directory));

    await expect(harness.service.status()).resolves.toMatchObject({
      admission: { activeWorkers: 1, queuedJobs: 0 },
      workers: [expect.objectContaining({ runId: "service-run", status: "running" })],
    });
    await expect(harness.service.reconcile()).resolves.toBeUndefined();
  });

  it("checks bounded active worker health concurrently", async () => {
    const harness = await createHarness(undefined, { maxActiveWorkers: 2, maxQueuedJobs: 0 });
    await harness.service.submit(submitCommand(randomUUID(), harness.directory, "health-1"));
    await harness.service.submit(submitCommand(randomUUID(), harness.directory, "health-2"));
    harness.launcher.identityDelayMs = 20;
    harness.launcher.maxConcurrentIdentityRequests = 0;

    await expect(harness.service.status()).resolves.toMatchObject({
      admission: { activeWorkers: 2, queuedJobs: 0 },
      workers: [{ runId: "health-1" }, { runId: "health-2" }],
    });
    expect(harness.launcher.maxConcurrentIdentityRequests).toBe(2);
  });

  it("fences new submissions after an idle shutdown reservation", async () => {
    const harness = await createHarness();

    await expect(harness.service.prepareShutdown()).resolves.toBeUndefined();

    await expect(
      harness.service.submit(submitCommand(randomUUID(), harness.directory, "too-late")),
    ).rejects.toMatchObject({ code: "worker_unavailable" });
    expect(harness.admissionStore.state).toMatchObject({ activeCount: 0, queuedCount: 0 });
    await expect(harness.store.listActiveRunClaims()).resolves.toEqual([]);
  });

  it("refuses shutdown while a recovered queued cancellation remains incomplete", async () => {
    const harness = await createHarness(undefined, { maxActiveWorkers: 1, maxQueuedJobs: 1 });
    const active = admissionIdentity(1, "active-run");
    const cancelling = admissionIdentity(2, "cancelling-run");
    await harness.admissionStore.append(
      createDispatchReservedEvent(harness.admissionStore.state, active, at(1)),
    );
    await harness.admissionStore.append(
      createJobEnqueuedEvent(harness.admissionStore.state, cancelling, at(2)),
    );
    await harness.admissionStore.append(
      createQueueCancellationRecordedEvent(harness.admissionStore.state, cancelling.jobId, {
        commandId: randomUUID(),
        actor: "operator:test",
        at: at(3),
      }),
    );
    await harness.admissionStore.append(
      createJobReleasedEvent(harness.admissionStore.state, active.jobId, "succeeded", at(4)),
    );
    expect(harness.admissionStore.state).toMatchObject({ activeCount: 0, queuedCount: 0 });

    await expect(harness.service.prepareShutdown()).rejects.toMatchObject({ code: "conflict" });
  });

  it("routes attributable cancellation only through the claimed worker", async () => {
    const harness = await createHarness();
    await harness.service.submit(submitCommand(randomUUID(), harness.directory));
    const commandId = randomUUID();

    const result = await harness.service.cancel({
      type: "cancel",
      policyDigest: POLICY_DIGEST,
      commandId,
      runId: "service-run",
      actor: "operator:test",
      reason: "Stop it.",
    });

    expect(result).toEqual({
      type: "cancelled",
      commandId,
      runId: "service-run",
      runStatus: "cancelled",
      phase: "active",
      lastSequence: 4,
    });
    expect(harness.launcher.cancelCommands).toEqual([
      { type: "cancel", commandId, actor: "operator:test", reason: "Stop it." },
    ]);
    await expect(harness.store.readCommand(commandId)).resolves.toMatchObject({
      status: "completed",
      result: { runStatus: "cancelled", phase: "active", lastSequence: 4 },
    });
    await expect(
      harness.service.cancel({
        type: "cancel",
        policyDigest: POLICY_DIGEST,
        commandId,
        runId: "service-run",
        actor: "different",
        reason: "Stop it.",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps cancellation retryable while a dispatch reservation is creating its claim", async () => {
    const harness = await createHarness(
      (runsDirectory, socketDirectory) =>
        new DelayedActiveClaimStore(runsDirectory, { socketDirectory }),
    );
    const store = harness.store as DelayedActiveClaimStore;
    const submission = harness.service.submit(
      submitCommand(randomUUID(), harness.directory, "dispatching-run"),
    );
    await store.claimAttempted.promise;
    const command = {
      type: "cancel" as const,
      policyDigest: POLICY_DIGEST,
      commandId: randomUUID(),
      runId: "dispatching-run",
      actor: "operator:test",
    };

    try {
      await expect(harness.service.cancel(command)).rejects.toMatchObject({
        code: "worker_unavailable",
      });
    } finally {
      store.claimGate.resolve();
      await expect(submission).resolves.toMatchObject({ type: "accepted" });
    }
    await expect(harness.service.cancel(command)).resolves.toMatchObject({
      type: "cancelled",
      runId: "dispatching-run",
    });
  });

  it("cancels queued work durably without creating a claim, worker, or run ledger", async () => {
    const harness = await createHarness(undefined, { maxActiveWorkers: 1, maxQueuedJobs: 2 });
    const active = submitCommand(randomUUID(), harness.directory, "run-1");
    const queued = submitCommand(randomUUID(), harness.directory, "run-2");
    await harness.service.submit(active);
    await harness.service.submit(queued);
    const command = {
      type: "cancel" as const,
      policyDigest: POLICY_DIGEST,
      commandId: randomUUID(),
      runId: queued.runId,
      actor: "operator:test",
      reason: "No longer needed.",
    };

    const cancelled = await harness.service.cancel(command);

    expect(cancelled).toEqual({
      type: "cancelled",
      commandId: command.commandId,
      runId: queued.runId,
      runStatus: "cancelled",
      phase: "queued",
      lastSequence: null,
    });
    await expect(harness.service.cancel(command)).resolves.toEqual(cancelled);
    await expect(harness.store.readActiveRunClaim(queued.runId)).resolves.toBeNull();
    await expect(
      new JsonlRunStore(harness.store.runsDirectory).read(queued.runId),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(harness.store.readCommand(queued.commandId)).resolves.toMatchObject({
      status: "rejected",
      reason: "cancelled",
    });
    expect(harness.launcher.jobs.map((job) => job.runId)).toEqual(["run-1"]);
    expect(harness.admissionStore.state).toMatchObject({ activeCount: 1, queuedCount: 0 });

    await harness.launcher.complete(active.commandId);
    await harness.service.reconcile();
    expect(harness.launcher.jobs.map((job) => job.runId)).toEqual(["run-1"]);
  });

  it("coalesces concurrent exact queued-cancellation callers", async () => {
    const harness = await createHarness(
      (runsDirectory, socketDirectory) =>
        new DelayedQueuedCancellationStore(runsDirectory, { socketDirectory }),
      { maxActiveWorkers: 1, maxQueuedJobs: 1 },
    );
    const store = harness.store as DelayedQueuedCancellationStore;
    const active = submitCommand(randomUUID(), harness.directory, "active-run");
    const queued = submitCommand(randomUUID(), harness.directory, "queued-run");
    await harness.service.submit(active);
    await harness.service.submit(queued);
    const command = {
      type: "cancel" as const,
      policyDigest: POLICY_DIGEST,
      commandId: randomUUID(),
      runId: queued.runId,
      actor: "operator:test",
    };

    const first = harness.service.cancel(command);
    await store.submissionRejectionAttempted.promise;
    const second = harness.service.cancel(command);
    await store.secondCancellationRecorded.promise;
    store.submissionRejectionGate.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(firstResult).toMatchObject({
      type: "cancelled",
      runId: queued.runId,
      phase: "queued",
    });
    await expect(harness.store.readCommand(command.commandId)).resolves.toMatchObject({
      status: "completed",
      result: { phase: "queued" },
    });
    expect(harness.launcher.jobs.map((job) => job.runId)).toEqual([active.runId]);
  });

  it("does not recreate admission when an exact queued retry races cancellation", async () => {
    const harness = await createHarness(
      (runsDirectory, socketDirectory) =>
        new DelayedJobReadStore(runsDirectory, { socketDirectory }),
      { maxActiveWorkers: 1, maxQueuedJobs: 1 },
    );
    const store = harness.store as DelayedJobReadStore;
    const active = submitCommand(randomUUID(), harness.directory, "active-run");
    const queued = submitCommand(randomUUID(), harness.directory, "queued-run");
    await harness.service.submit(active);
    await harness.service.submit(queued);
    store.delayNextJobRead = true;

    const retry = harness.service.submit(queued);
    await store.jobReadStarted.promise;
    const cancelled = await harness.service.cancel({
      type: "cancel",
      policyDigest: POLICY_DIGEST,
      commandId: randomUUID(),
      runId: queued.runId,
      actor: "operator:test",
    });
    store.jobReadGate.resolve();

    await expect(retry).resolves.toMatchObject({
      type: "rejected",
      runId: queued.runId,
      reason: "cancelled",
    });
    expect(cancelled).toMatchObject({ type: "cancelled", phase: "queued" });
    expect(harness.admissionStore.state.jobs[queued.commandId]).toBeUndefined();
    expect(harness.launcher.jobs.map((job) => job.runId)).toEqual([active.runId]);
  });

  it("journals a lost cancellation acknowledgement as uncertain and does not redispatch it", async () => {
    const harness = await createHarness();
    await harness.service.submit(submitCommand(randomUUID(), harness.directory));
    const command = {
      type: "cancel" as const,
      policyDigest: POLICY_DIGEST,
      commandId: randomUUID(),
      runId: "service-run",
      actor: "operator:test",
      reason: "Stop it.",
    };
    harness.launcher.loseCancellationAcknowledgement = true;

    await expect(harness.service.cancel(command)).rejects.toMatchObject({
      code: "command_uncertain",
    });
    await expect(harness.store.readCommand(command.commandId)).resolves.toMatchObject({
      status: "uncertain",
    });

    harness.launcher.loseCancellationAcknowledgement = false;
    await expect(harness.service.cancel(command)).rejects.toMatchObject({
      code: "command_uncertain",
    });
    expect(harness.launcher.cancelCommands).toHaveLength(1);
  });

  it("replays bounded events from an exclusive sequence cursor", async () => {
    const harness = await createHarness();
    const workflow = compileWorkflowText(workflowSource(), "/workspace/workflow.yaml");
    const executor: NodeExecutor = {
      async execute(node) {
        return {
          status: "succeeded",
          evidence: {
            kind: "command",
            executable: node.type === "command" ? node.command.executable : "unexpected",
            args: [],
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            stdoutHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            stderrHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            durationMs: 1,
          },
        };
      },
    };
    await runWorkflow(workflow, {
      cwd: harness.directory,
      protectedPaths: [harness.store.runsDirectory],
      store: new JsonlRunStore(harness.store.runsDirectory),
      executor,
      runId: "event-run",
    });

    const first = await harness.service.events({
      type: "events",
      policyDigest: POLICY_DIGEST,
      runId: "event-run",
      afterSequence: 0,
      limit: 2,
    });
    const second = await harness.service.events({
      type: "events",
      policyDigest: POLICY_DIGEST,
      runId: "event-run",
      afterSequence: first.cursor,
      limit: 2,
    });

    expect(first.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(first).toMatchObject({ cursor: 2, terminal: false });
    expect(second.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect(second).toMatchObject({ cursor: 4, terminal: true });
    await expect(
      harness.service.events({
        type: "events",
        policyDigest: POLICY_DIGEST,
        runId: "event-run",
        afterSequence: 5,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(SupervisorServiceError);
  });
});

class RecordingWorkerLauncher implements WorkerLauncher {
  readonly jobs: JobRecord[] = [];
  readonly cancelCommands: unknown[] = [];
  readonly failBeforeDescriptorRunIds = new Set<string>();
  readonly unreachableIdentityRunIds = new Set<string>();
  identityMismatch = false;
  loseCancellationAcknowledgement = false;
  loseLaunchAcknowledgement = false;
  identityDelayMs = 0;
  activeIdentityRequests = 0;
  maxConcurrentIdentityRequests = 0;

  constructor(readonly store: LocalSupervisorStore) {}

  async complete(jobId: string): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.jobId === jobId);
    if (job === undefined) {
      throw new Error(`job "${jobId}" was not launched`);
    }
    const descriptor = await this.store.readWorkerDescriptor(job.workerId);
    await this.store.writeWorkerDescriptor(
      parseWorkerDescriptor({
        ...descriptor,
        status: "terminal",
        runStatus: "succeeded",
        exitCode: 0,
        updatedAt: "2026-08-07T12:00:10.000Z",
      }),
    );
    await this.store.releaseActiveRunClaim(job.runId, job.jobId);
  }

  async launch(job: JobRecord) {
    this.jobs.push(job);
    if (this.failBeforeDescriptorRunIds.has(job.runId)) {
      throw new Error(`simulated pre-descriptor failure for ${job.runId}`);
    }
    const descriptor = parseWorkerDescriptor({
      version: 1,
      workerId: job.workerId,
      jobId: job.jobId,
      runId: job.runId,
      pid: 4321,
      token: job.token,
      jobDigest: job.digest,
      socketPath: join(this.store.socketDirectory, "worker.sock"),
      status: "running",
      runStatus: "running",
      startedAt: job.createdAt,
      updatedAt: job.createdAt,
    });
    await this.store.writeWorkerDescriptor(descriptor);
    if (this.loseLaunchAcknowledgement) {
      throw new Error("simulated lost launch acknowledgement");
    }
    return descriptor;
  }

  async request(
    descriptor: Awaited<ReturnType<RecordingWorkerLauncher["launch"]>>,
    command: Parameters<WorkerLauncher["request"]>[1],
  ) {
    if (command.type === "cancel") {
      this.cancelCommands.push(command);
      if (this.loseCancellationAcknowledgement) {
        throw new Error("simulated lost acknowledgement");
      }
      return {
        version: SUPERVISOR_PROTOCOL_VERSION,
        requestId: randomUUID(),
        ok: true,
        result: {
          type: "cancelled",
          commandId: command.commandId,
          runId: descriptor.runId,
          runStatus: "cancelled",
          phase: "active",
          lastSequence: 4,
        },
      } satisfies WorkerResponse;
    }
    if (this.unreachableIdentityRunIds.has(descriptor.runId)) {
      throw new Error(`worker for ${descriptor.runId} is unreachable`);
    }
    const workerId = this.identityMismatch ? randomUUID() : descriptor.workerId;
    this.activeIdentityRequests += 1;
    this.maxConcurrentIdentityRequests = Math.max(
      this.maxConcurrentIdentityRequests,
      this.activeIdentityRequests,
    );
    try {
      if (this.identityDelayMs > 0) {
        await new Promise<void>((resolvePromise) => {
          setTimeout(resolvePromise, this.identityDelayMs);
        });
      }
      return {
        version: SUPERVISOR_PROTOCOL_VERSION,
        requestId: randomUUID(),
        ok: true,
        result: {
          type: "identity",
          workerId,
          runId: descriptor.runId,
          pid: descriptor.pid,
          jobDigest: descriptor.jobDigest,
          status: descriptor.status,
          runStatus: "running",
        },
      } satisfies WorkerResponse;
    } finally {
      this.activeIdentityRequests -= 1;
    }
  }
}

class FailingSubmissionCompletionStore extends LocalSupervisorStore {
  #failCompletion = true;

  override async updateCommand(input: SupervisorCommandRecord): Promise<void> {
    if (input.type === "submit" && input.status === "completed" && this.#failCompletion) {
      this.#failCompletion = false;
      throw new LocalSupervisorStoreError("io", "simulated journal fsync failure");
    }
    await super.updateCommand(input);
  }
}

class FailingQueueRejectionStore extends LocalSupervisorStore {
  #failRejection = true;

  override async updateCommand(input: SupervisorCommandRecord): Promise<void> {
    if (
      input.type === "submit" &&
      input.status === "rejected" &&
      input.reason === "queue_full" &&
      this.#failRejection
    ) {
      this.#failRejection = false;
      throw new LocalSupervisorStoreError("io", "simulated rejection commit failure");
    }
    await super.updateCommand(input);
  }
}

class NoHistoricalWorkerEnumerationStore extends LocalSupervisorStore {
  override async listWorkerDescriptors(): Promise<never> {
    throw new Error("historical worker descriptors must not be enumerated");
  }
}

class DelayedActiveClaimStore extends LocalSupervisorStore {
  readonly claimAttempted = deferred();
  readonly claimGate = deferred();

  override async reserveActiveRunClaim(claim: ActiveRunClaim): Promise<void> {
    this.claimAttempted.resolve();
    await this.claimGate.promise;
    await super.reserveActiveRunClaim(claim);
  }
}

class DelayedJobReadStore extends LocalSupervisorStore {
  readonly jobReadStarted = deferred();
  readonly jobReadGate = deferred();
  delayNextJobRead = false;

  override async readJob(jobId: string): Promise<JobRecord> {
    if (this.delayNextJobRead) {
      this.delayNextJobRead = false;
      this.jobReadStarted.resolve();
      await this.jobReadGate.promise;
    }
    return await super.readJob(jobId);
  }
}

class DelayedQueuedCancellationStore extends LocalSupervisorStore {
  readonly submissionRejectionAttempted = deferred();
  readonly submissionRejectionGate = deferred();
  readonly secondCancellationRecorded = deferred();
  #cancellationRecords = 0;
  #delaySubmissionRejection = true;

  override async recordCommand(input: SupervisorCommandRecord): Promise<SupervisorCommandRecord> {
    const recorded = await super.recordCommand(input);
    if (input.type === "cancel") {
      this.#cancellationRecords += 1;
      if (this.#cancellationRecords === 2) {
        this.secondCancellationRecorded.resolve();
      }
    }
    return recorded;
  }

  override async updateCommand(input: SupervisorCommandRecord): Promise<void> {
    if (
      input.type === "submit" &&
      input.status === "rejected" &&
      input.reason === "cancelled" &&
      this.#delaySubmissionRejection
    ) {
      this.#delaySubmissionRejection = false;
      this.submissionRejectionAttempted.resolve();
      await this.submissionRejectionGate.promise;
    }
    await super.updateCommand(input);
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolvePromise === undefined) {
        throw new Error("deferred promise was not initialized");
      }
      resolvePromise();
    },
  };
}

async function createHarness(
  createStore:
    | ((runsDirectory: string, socketDirectory: string) => LocalSupervisorStore)
    | undefined = (runsDirectory, socketDirectory) =>
    new LocalSupervisorStore(runsDirectory, { socketDirectory }),
  limits = { maxActiveWorkers: 1, maxQueuedJobs: 32 },
) {
  const directory = await mkdtemp(join(tmpdir(), "flow-supervisor-service-"));
  temporaryDirectories.push(directory);
  const store = createStore(join(directory, "runs"), join(directory, "sockets"));
  await store.initialize();
  const admissionStore = new JsonlAdmissionStore(store.runsDirectory);
  await admissionStore.open(
    createAdmissionInitializedEvent({
      policyDigest: POLICY_DIGEST,
      limits,
      at: "2026-08-07T12:00:00.000Z",
    }),
  );
  const launcher = new RecordingWorkerLauncher(store);
  const generation = randomUUID();
  const service = new LocalSupervisorService({
    store,
    admissionStore,
    launcher,
    generation,
    pid: 9876,
    startedAt: "2026-08-07T12:00:00.000Z",
  });
  return { directory, store, admissionStore, launcher, generation, service };
}

function admissionIdentity(index: number, runId: string) {
  return {
    jobId: randomUUID(),
    workerId: randomUUID(),
    runId,
    jobDigest: index.toString(16).repeat(64),
  };
}

function at(second: number): string {
  return `2026-08-07T12:00:${String(second).padStart(2, "0")}.000Z`;
}

function submitCommand(commandId: string, directory: string, runId = "service-run") {
  return {
    type: "submit" as const,
    policyDigest: POLICY_DIGEST,
    commandId,
    mode: "run" as const,
    runId,
    sourceName: "/workspace/workflow.yaml",
    workflowSource: workflowSource(),
    cwd: directory,
  };
}

function workflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: service-test }
nodes:
  - id: execute
    type: command
    command:
      executable: node
      args: [--version]
      timeoutMs: 10000
`;
}
