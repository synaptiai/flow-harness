import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  calculateJobDigest,
  completeSubmissionCommand,
  completeCancellationCommand,
  createSubmissionCommandRecord,
  createCancellationCommandRecord,
  rejectSubmissionCommand,
  createSupervisorStartLock,
  createActiveRunClaim,
  createJobRecord,
  parseActiveRunClaim,
  parseJobRecord,
  parseSupervisorCommandRecord,
  parseSupervisorDescriptor,
  parseSupervisorStartLock,
  parseWorkerDescriptor,
  queueSubmissionCommand,
  supervisorSocketPath,
  workerSocketPath,
} from "../../../src/supervisor/records.js";
import { SUPERVISOR_PROTOCOL_VERSION } from "../../../src/supervisor/protocol.js";

describe("supervisor durable records", () => {
  it("creates an immutable job snapshot with a reproducible digest", () => {
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "run-1",
      mode: "run",
      sourceName: "/workspace/workflow.yaml",
      workflowSource: "kind: Workflow\n",
      cwd: "/workspace",
      token: "a".repeat(64),
      createdAt: "2026-08-07T12:00:00.000Z",
    });

    expect(job.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(calculateJobDigest(job)).toBe(job.digest);
    expect(Object.isFrozen(job)).toBe(true);
    expect(parseJobRecord(JSON.parse(JSON.stringify(job)))).toEqual(job);
  });

  it("rejects a changed job snapshot even when the persisted digest is retained", () => {
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "run-1",
      mode: "resume",
      sourceName: "/workspace/workflow.yaml",
      workflowSource: "kind: Workflow\n",
      cwd: "/workspace",
      token: "b".repeat(64),
      createdAt: "2026-08-07T12:00:00.000Z",
    });

    expect(() => parseJobRecord({ ...job, cwd: "/other" })).toThrow(/digest/i);
    expect(() => parseJobRecord({ ...job, extra: true })).toThrow(/unrecognized/i);
  });

  it("binds an active run claim to one job and worker", () => {
    const jobId = randomUUID();
    const workerId = randomUUID();
    const claim = createActiveRunClaim({
      runId: "run-1",
      jobId,
      workerId,
      claimedAt: "2026-08-07T12:00:00.000Z",
    });

    expect(parseActiveRunClaim(claim)).toEqual(claim);
    expect(() => parseActiveRunClaim({ ...claim, runId: "../escape" })).toThrow(/runId/i);
  });

  it("requires worker descriptors to retain token, job digest, and endpoint identity", () => {
    const workerId = randomUUID();
    const descriptor = parseWorkerDescriptor({
      version: 1,
      workerId,
      jobId: randomUUID(),
      runId: "run-1",
      pid: 1234,
      token: "c".repeat(64),
      jobDigest: createHash("sha256").update("job").digest("hex"),
      socketPath: `/tmp/flow-harness-501/w-${workerId}.sock`,
      status: "running",
      startedAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:01.000Z",
    });

    expect(descriptor).toMatchObject({ workerId, status: "running", pid: 1234 });
    expect(() => parseWorkerDescriptor({ ...descriptor, token: "short" })).toThrow(/token/i);
  });

  it("binds a terminal recovery refusal to its replayed running run", () => {
    const workerId = randomUUID();
    const input = {
      version: 1 as const,
      workerId,
      jobId: randomUUID(),
      runId: "run-1",
      pid: 1234,
      token: "d".repeat(64),
      jobDigest: createHash("sha256").update("job").digest("hex"),
      socketPath: `/tmp/flow-harness-501/w-${workerId}.sock`,
      status: "terminal" as const,
      runStatus: "running" as const,
      recoveryErrorCode: "uncertain_operation" as const,
      failure: "node attempt has no committed outcome",
      exitCode: 1,
      startedAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:01.000Z",
    };

    expect(parseWorkerDescriptor(input)).toMatchObject({
      status: "terminal",
      runStatus: "running",
      recoveryErrorCode: "uncertain_operation",
    });
    expect(() => parseWorkerDescriptor({ ...input, recoveryErrorCode: undefined })).toThrow(
      /recovery error code/i,
    );
    expect(() => parseWorkerDescriptor({ ...input, failure: undefined })).toThrow(/failure/i);
    expect(() => parseWorkerDescriptor({ ...input, status: "failed" })).toThrow(
      /recovery error code/i,
    );
  });

  it("derives short deterministic sockets independent of run-directory depth", () => {
    const runsDirectory = `/${"deep/".repeat(80)}runs`;
    const first = supervisorSocketPath(runsDirectory, 501);
    const second = supervisorSocketPath(runsDirectory, 501);
    const worker = workerSocketPath(randomUUID(), 501);

    expect(first).toBe(second);
    expect(first).toMatch(/^\/(?:private\/)?tmp\/flow-harness-501\/s-[a-f0-9]{24}\.sock$/);
    expect(worker).toMatch(/^\/(?:private\/)?tmp\/flow-harness-501\/w-[a-f0-9]{24}\.sock$/);
    expect(Buffer.byteLength(first, "utf8")).toBeLessThan(104);
    expect(Buffer.byteLength(worker, "utf8")).toBeLessThan(104);
  });

  it("binds cancellation journals to exact attribution and a durable result", () => {
    const command = createCancellationCommandRecord({
      commandId: randomUUID(),
      runId: "run-1",
      actor: "operator:test",
      reason: "Stop the run.",
      recordedAt: "2026-08-07T12:00:00.000Z",
    });
    const completed = completeCancellationCommand(
      command,
      { runStatus: "cancelled", phase: "active", lastSequence: 4 },
      "2026-08-07T12:00:01.000Z",
    );

    expect(command).toMatchObject({ status: "recorded", requestDigest: expect.any(String) });
    expect(completed).toMatchObject({
      status: "completed",
      result: { runStatus: "cancelled", phase: "active", lastSequence: 4 },
    });
    expect(parseSupervisorCommandRecord(completed)).toEqual(completed);
    expect(() => parseSupervisorCommandRecord({ ...completed, actor: "other" })).toThrow(/digest/i);
  });

  it("binds submission journals to exact input and terminal acceptance or rejection", () => {
    const command = createSubmissionCommandRecord({
      commandId: randomUUID(),
      policyDigest: "a".repeat(64),
      runId: "run-1",
      mode: "run",
      sourceName: "/workspace/workflow.yaml",
      workflowSource: "kind: Workflow\n",
      cwd: "/workspace",
      recordedAt: "2026-08-07T12:00:00.000Z",
    });
    const workerId = randomUUID();
    const queued = queueSubmissionCommand(command, 7, "2026-08-07T12:00:00.500Z");
    const completed = completeSubmissionCommand(
      queued,
      { workerId, acceptedAt: "2026-08-07T12:00:01.000Z" },
      "2026-08-07T12:00:01.000Z",
    );
    const rejected = rejectSubmissionCommand(
      command,
      "admission queue is full",
      "2026-08-07T12:00:01.000Z",
      "queue_full",
    );

    expect(command).toMatchObject({ type: "submit", status: "recorded" });
    expect(queued).toMatchObject({
      type: "submit",
      status: "queued",
      result: { queuePosition: 7 },
    });
    expect(completed).toMatchObject({
      type: "submit",
      status: "completed",
      result: { workerId, acceptedAt: "2026-08-07T12:00:01.000Z" },
    });
    expect(rejected).toMatchObject({
      type: "submit",
      status: "rejected",
      reason: "queue_full",
    });
    expect(parseSupervisorCommandRecord(completed)).toEqual(completed);
    expect(() => parseSupervisorCommandRecord({ ...completed, cwd: "/other" })).toThrow(/digest/i);
  });

  it("binds a supervisor descriptor to one effective admission policy", () => {
    const descriptor = parseSupervisorDescriptor({
      version: 1,
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      generation: randomUUID(),
      pid: 1234,
      startedAt: "2026-08-07T12:00:00.000Z",
      runsDirectory: "/workspace/.flow/runs",
      socketPath: "/tmp/flow-harness-501/s-test.sock",
      policyDigest: "a".repeat(64),
      limits: { maxActiveWorkers: 2, maxQueuedJobs: 8 },
    });

    expect(descriptor).toMatchObject({
      policyDigest: "a".repeat(64),
      limits: { maxActiveWorkers: 2, maxQueuedJobs: 8 },
    });
    expect(() => parseSupervisorDescriptor({ ...descriptor, policyDigest: "short" })).toThrow(
      /policyDigest/i,
    );
  });

  it("binds a supervisor startup lock to one process and random token", () => {
    const lock = createSupervisorStartLock({
      pid: 1234,
      token: randomUUID(),
      acquiredAt: "2026-08-07T12:00:00.000Z",
    });

    expect(parseSupervisorStartLock(lock)).toEqual(lock);
    expect(() => parseSupervisorStartLock({ ...lock, pid: 0 })).toThrow(/pid/i);
    expect(() => parseSupervisorStartLock({ ...lock, extra: true })).toThrow(/unrecognized/i);
  });
});
