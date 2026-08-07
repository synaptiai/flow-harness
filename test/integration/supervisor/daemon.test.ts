import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  calculateFlowPolicyDigest,
  resolveFlowConfig,
} from "../../../src/domain/config/resolver.js";
import { LocalSupervisorStore } from "../../../src/infrastructure/fs/local-supervisor-store.js";
import { JsonlAdmissionStore } from "../../../src/infrastructure/fs/jsonl-admission-store.js";
import {
  ensureSupervisor,
  requestSupervisor,
  runSupervisorDaemon,
  startSupervisorServer,
  SupervisorStartupTimeoutError,
} from "../../../src/supervisor/daemon.js";
import { createAdmissionInitializedEvent } from "../../../src/supervisor/admission.js";
import { SUPERVISOR_PROTOCOL_VERSION } from "../../../src/supervisor/protocol.js";
import type { WorkerLauncher } from "../../../src/supervisor/service.js";

const temporaryDirectories: string[] = [];
const POLICY = resolveFlowConfig({});

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
        policyDigest: POLICY.policyDigest,
        limits: POLICY.supervisor,
        admission: { activeWorkers: 0, queuedJobs: 0 },
        workers: [],
      },
    });
    await expect(store.readSupervisorDescriptor()).resolves.toEqual(running.descriptor);

    const shutdown = await requestSupervisor(store, {
      type: "shutdown",
      commandId: randomUUID(),
      policyDigest: POLICY.policyDigest,
    });
    expect(shutdown).toMatchObject({
      ok: true,
      result: { type: "shutdown", stopped: true },
    });
    await expect(
      stat(join(store.runsDirectory, ".supervisor", "admission.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(running.completed).resolves.toBeUndefined();
  });

  it("claims startup ownership in the daemon before publishing readiness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-daemon-owner-"));
    const shortTemporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
    const socketDirectory = await mkdtemp(join(shortTemporaryRoot, "flow-daemon-owner-sockets-"));
    temporaryDirectories.push(directory, socketDirectory);
    const store = new OwnershipCheckingSupervisorStore(join(directory, "runs"), {
      socketDirectory,
    });
    const startupToken = randomUUID();
    const startupOwnerToken = randomUUID();
    await store.reserveSupervisorStart({
      version: 1,
      pid: 1234,
      token: startupToken,
      acquiredAt: "2026-08-07T12:00:00.000Z",
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runSupervisorDaemon({
        store,
        cliPath: "/unused/flow-cli.js",
        startupToken,
        startupOwnerToken,
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
    expect(store.transferredPid).toBe(process.pid);
    expect(store.transferredToken).toBe(startupOwnerToken);
  });

  it("waits for in-flight reconciliation before close resolves", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-daemon-reconcile-close-"));
    const shortTemporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
    const socketDirectory = await mkdtemp(
      join(shortTemporaryRoot, "flow-daemon-reconcile-close-sockets-"),
    );
    temporaryDirectories.push(directory, socketDirectory);
    const store = new DelayedReconciliationStore(join(directory, "runs"), { socketDirectory });
    const running = await startSupervisorServer({ store, launcher: unavailableLauncher });
    await store.reconciliationStarted.promise;

    const closing = running.close();
    await expect(Promise.race([closing.then(() => "closed"), delay(25, "pending")])).resolves.toBe(
      "pending",
    );
    store.reconciliationGate.resolve();

    await expect(closing).resolves.toBeUndefined();
    await expect(running.completed).resolves.toBeUndefined();
  });

  it("refuses protocol shutdown while an active claim exists", async () => {
    const { directory, store } = await createStore();
    const launcher = new HoldingLauncher(store);
    const running = await startSupervisorServer({ store, launcher });
    const submitted = await requestSupervisor(store, {
      type: "submit",
      policyDigest: POLICY.policyDigest,
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
      policyDigest: POLICY.policyDigest,
    });
    expect(shutdown).toMatchObject({
      ok: false,
      error: { code: "active_workers" },
    });

    await running.close();
    await expect(running.completed).resolves.toBeUndefined();
  });

  it("rejects a stateful request bound to a different effective policy", async () => {
    const { directory, store } = await createStore();
    const launcher = new HoldingLauncher(store);
    const running = await startSupervisorServer({ store, launcher });

    const response = await requestSupervisor(store, {
      type: "submit",
      policyDigest: "b".repeat(64),
      commandId: randomUUID(),
      mode: "run",
      runId: "mismatched-policy",
      sourceName: "/workspace/workflow.yaml",
      workflowSource: workflowSource(),
      cwd: directory,
    });

    expect(response).toMatchObject({ ok: false, error: { code: "policy_mismatch" } });
    await expect(store.listActiveRunClaims()).resolves.toEqual([]);
    await running.close();
  });

  it("retires an idle policy on explicit shutdown and permits a new binding", async () => {
    const { store } = await createStore();
    const first = await startSupervisorServer({ store, launcher: unavailableLauncher });
    await requestSupervisor(store, {
      type: "shutdown",
      commandId: randomUUID(),
      policyDigest: POLICY.policyDigest,
    });
    await first.completed;
    const supervisor = { maxActiveWorkers: 2, maxQueuedJobs: 4 };
    const policy = { policyDigest: calculateFlowPolicyDigest(supervisor), supervisor };

    const second = await startSupervisorServer({ store, launcher: unavailableLauncher, policy });

    await expect(requestSupervisor(store, { type: "status" })).resolves.toMatchObject({
      ok: true,
      result: { policyDigest: policy.policyDigest, limits: supervisor },
    });
    await requestSupervisor(store, {
      type: "shutdown",
      commandId: randomUUID(),
      policyDigest: policy.policyDigest,
    });
    await second.completed;
  });

  it("reports a stopped supervisor policy mismatch before spawning a replacement", async () => {
    const { store } = await createStore();
    const admission = new JsonlAdmissionStore(store.runsDirectory);
    await admission.open(
      createAdmissionInitializedEvent({
        policyDigest: POLICY.policyDigest,
        limits: POLICY.supervisor,
        at: "2026-08-07T12:00:00.000Z",
      }),
    );
    admission.close();
    const replacementLimits = { maxActiveWorkers: 2, maxQueuedJobs: 32 };
    const replacement = {
      policyDigest: calculateFlowPolicyDigest(replacementLimits),
      supervisor: replacementLimits,
    };

    await expect(
      ensureSupervisor(store, "/definitely/missing/flow-cli.js", replacement),
    ).rejects.toMatchObject({ code: "policy_mismatch" });
  });

  it("terminates and reaps a supervisor that misses its startup deadline", async () => {
    const { directory, store } = await createStore();
    const fixturePath = join(directory, "never-ready-supervisor.cjs");
    await writeFile(fixturePath, "setInterval(() => {}, 1000);", "utf8");
    let pid: number | undefined;

    try {
      const error: unknown = await ensureSupervisor(store, fixturePath, POLICY, {
        startupTimeoutMs: 100,
      }).then(
        () => new Error("the never-ready supervisor unexpectedly started"),
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(SupervisorStartupTimeoutError);
      if (!(error instanceof SupervisorStartupTimeoutError) || error.pid === null) {
        throw error;
      }
      expect(error).toMatchObject({ timeoutMs: 100, pid: expect.any(Number) });
      pid = error.pid;

      await expect(waitForProcessExit(pid, 1_000)).resolves.toBeUndefined();
    } finally {
      if (pid !== undefined && isProcessAlive(pid)) {
        process.kill(-pid, "SIGKILL");
      }
    }
  }, 15_000);
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
      version: SUPERVISOR_PROTOCOL_VERSION,
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

class OwnershipCheckingSupervisorStore extends LocalSupervisorStore {
  transferredPid: number | undefined;
  transferredToken: string | undefined;

  override async transferSupervisorStart(token: string, pid: number, ownerToken: string) {
    const transferred = await super.transferSupervisorStart(token, pid, ownerToken);
    this.transferredPid = pid;
    this.transferredToken = transferred.token;
    return transferred;
  }

  override async writeSupervisorDescriptor(
    descriptor: Parameters<LocalSupervisorStore["writeSupervisorDescriptor"]>[0],
  ): Promise<void> {
    if (this.transferredPid === undefined) {
      throw new Error("supervisor readiness was published before startup ownership transferred");
    }
    await super.writeSupervisorDescriptor(descriptor);
  }
}

class DelayedReconciliationStore extends LocalSupervisorStore {
  readonly reconciliationStarted = deferred();
  readonly reconciliationGate = deferred();
  #activeClaimReads = 0;

  override async listActiveRunClaims() {
    this.#activeClaimReads += 1;
    if (this.#activeClaimReads === 2) {
      this.reconciliationStarted.resolve();
      await this.reconciliationGate.promise;
    }
    return await super.listActiveRunClaims();
  }
}

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "flow-daemon-"));
  const shortTemporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const socketDirectory = await mkdtemp(join(shortTemporaryRoot, "flow-daemon-sockets-"));
  temporaryDirectories.push(directory, socketDirectory);
  const store = new LocalSupervisorStore(join(directory, "runs"), { socketDirectory });
  await store.initialize();
  return { directory, store };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromiseArgument) => {
    resolvePromise = resolvePromiseArgument;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
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
