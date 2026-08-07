import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { runWorkflow } from "../../../src/application/run-workflow.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import {
  LocalSupervisorStore,
  LocalSupervisorStoreError,
} from "../../../src/infrastructure/fs/local-supervisor-store.js";
import {
  LocalSupervisorService,
  SupervisorServiceError,
  type WorkerLauncher,
} from "../../../src/supervisor/service.js";
import type { WorkerResponse } from "../../../src/supervisor/protocol.js";
import {
  createActiveRunClaim,
  createJobRecord,
  createSubmissionCommandRecord,
  parseWorkerDescriptor,
  type JobRecord,
  type SupervisorCommandRecord,
} from "../../../src/supervisor/records.js";

const temporaryDirectories: string[] = [];

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

    await expect(harness.service.submit(command)).rejects.toMatchObject({
      code: "command_uncertain",
    });
    await expect(harness.store.readCommand(command.commandId)).resolves.toMatchObject({
      type: "submit",
      status: "uncertain",
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

  it("does not launch an existing unclaimed job whose prior reservation outcome is ambiguous", async () => {
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

    await expect(harness.service.submit(command)).rejects.toMatchObject({
      code: "command_uncertain",
    });
    expect(harness.launcher.jobs).toHaveLength(0);
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

  it("routes attributable cancellation only through the claimed worker", async () => {
    const harness = await createHarness();
    await harness.service.submit(submitCommand(randomUUID(), harness.directory));
    const commandId = randomUUID();

    const result = await harness.service.cancel({
      type: "cancel",
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
      lastSequence: 4,
    });
    expect(harness.launcher.cancelCommands).toEqual([
      { type: "cancel", commandId, actor: "operator:test", reason: "Stop it." },
    ]);
    await expect(harness.store.readCommand(commandId)).resolves.toMatchObject({
      status: "completed",
      result: { runStatus: "cancelled", lastSequence: 4 },
    });
    await expect(
      harness.service.cancel({
        type: "cancel",
        commandId,
        runId: "service-run",
        actor: "different",
        reason: "Stop it.",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("journals a lost cancellation acknowledgement as uncertain and does not redispatch it", async () => {
    const harness = await createHarness();
    await harness.service.submit(submitCommand(randomUUID(), harness.directory));
    const command = {
      type: "cancel" as const,
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
      runId: "event-run",
      afterSequence: 0,
      limit: 2,
    });
    const second = await harness.service.events({
      type: "events",
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
  identityMismatch = false;
  loseCancellationAcknowledgement = false;
  loseLaunchAcknowledgement = false;

  constructor(readonly store: LocalSupervisorStore) {}

  async launch(job: JobRecord) {
    this.jobs.push(job);
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
        version: 1,
        requestId: randomUUID(),
        ok: true,
        result: {
          type: "cancelled",
          commandId: command.commandId,
          runId: descriptor.runId,
          runStatus: "cancelled",
          lastSequence: 4,
        },
      } satisfies WorkerResponse;
    }
    const workerId = this.identityMismatch ? randomUUID() : descriptor.workerId;
    return {
      version: 1,
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

async function createHarness(
  createStore: (runsDirectory: string, socketDirectory: string) => LocalSupervisorStore = (
    runsDirectory,
    socketDirectory,
  ) => new LocalSupervisorStore(runsDirectory, { socketDirectory }),
) {
  const directory = await mkdtemp(join(tmpdir(), "flow-supervisor-service-"));
  temporaryDirectories.push(directory);
  const store = createStore(join(directory, "runs"), join(directory, "sockets"));
  await store.initialize();
  const launcher = new RecordingWorkerLauncher(store);
  const generation = randomUUID();
  const service = new LocalSupervisorService({
    store,
    launcher,
    generation,
    pid: 9876,
    startedAt: "2026-08-07T12:00:00.000Z",
  });
  return { directory, store, launcher, generation, service };
}

function submitCommand(commandId: string, directory: string) {
  return {
    type: "submit" as const,
    commandId,
    mode: "run" as const,
    runId: "service-run",
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
