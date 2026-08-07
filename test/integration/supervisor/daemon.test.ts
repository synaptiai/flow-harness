import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalSupervisorStore } from "../../../src/infrastructure/fs/local-supervisor-store.js";
import { requestSupervisor, startSupervisorServer } from "../../../src/supervisor/daemon.js";
import type { WorkerLauncher } from "../../../src/supervisor/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local supervisor daemon", () => {
  it("publishes its generation and performs an idle protocol shutdown", async () => {
    const { store } = await createStore();
    const running = await startSupervisorServer({
      store,
      launcher: unavailableLauncher,
      pid: 2468,
      startedAt: "2026-08-07T12:00:00.000Z",
    });

    const status = await requestSupervisor(store, { type: "status" });
    expect(status).toMatchObject({
      ok: true,
      result: {
        type: "status",
        generation: running.descriptor.generation,
        pid: 2468,
        workers: [],
      },
    });
    await expect(store.readSupervisorDescriptor()).resolves.toEqual(running.descriptor);

    const shutdown = await requestSupervisor(store, {
      type: "shutdown",
      commandId: randomUUID(),
    });
    expect(shutdown).toMatchObject({
      ok: true,
      result: { type: "shutdown", stopped: true },
    });
    await expect(running.completed).resolves.toBeUndefined();
  });

  it("refuses protocol shutdown while an active claim exists", async () => {
    const { directory, store } = await createStore();
    const launcher = new HoldingLauncher(store);
    const running = await startSupervisorServer({ store, launcher });
    const submitted = await requestSupervisor(store, {
      type: "submit",
      commandId: randomUUID(),
      mode: "run",
      runId: "active-run",
      sourceName: "/workspace/workflow.yaml",
      workflowSource: workflowSource(),
      cwd: directory,
    });
    expect(submitted).toMatchObject({ ok: true, result: { type: "accepted" } });

    const shutdown = await requestSupervisor(store, {
      type: "shutdown",
      commandId: randomUUID(),
    });
    expect(shutdown).toMatchObject({
      ok: false,
      error: { code: "active_workers" },
    });

    await running.close();
    await expect(running.completed).resolves.toBeUndefined();
  });
});

const unavailableLauncher: WorkerLauncher = {
  async launch() {
    throw new Error("not used");
  },
  async request() {
    throw new Error("not used");
  },
};

class HoldingLauncher implements WorkerLauncher {
  constructor(readonly store: LocalSupervisorStore) {}

  async launch(job: Parameters<WorkerLauncher["launch"]>[0]) {
    const descriptor = {
      version: 1 as const,
      workerId: job.workerId,
      jobId: job.jobId,
      runId: job.runId,
      pid: 4321,
      token: job.token,
      jobDigest: job.digest,
      socketPath: join(this.store.socketDirectory, "worker.sock"),
      status: "running" as const,
      runStatus: "running" as const,
      startedAt: job.createdAt,
      updatedAt: job.createdAt,
    };
    await this.store.writeWorkerDescriptor(descriptor);
    return descriptor;
  }

  async request(descriptor: Awaited<ReturnType<HoldingLauncher["launch"]>>) {
    return {
      version: 1 as const,
      requestId: randomUUID(),
      ok: true as const,
      result: {
        type: "identity" as const,
        workerId: descriptor.workerId,
        runId: descriptor.runId,
        pid: descriptor.pid,
        jobDigest: descriptor.jobDigest,
        status: descriptor.status,
        runStatus: descriptor.runStatus,
      },
    };
  }
}

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "flow-daemon-"));
  const socketDirectory = await mkdtemp("/private/tmp/flow-daemon-sockets-");
  temporaryDirectories.push(directory, socketDirectory);
  const store = new LocalSupervisorStore(join(directory, "runs"), { socketDirectory });
  await store.initialize();
  return { directory, store };
}

function workflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: daemon-test }
nodes:
  - id: execute
    type: command
    command: { executable: node, args: [--version] }
`;
}
