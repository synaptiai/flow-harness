import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { resolveFlowConfig, type EffectiveFlowConfig } from "../domain/config/resolver.js";
import {
  AdmissionStoreError,
  JsonlAdmissionStore,
} from "../infrastructure/fs/jsonl-admission-store.js";
import {
  LocalSupervisorStoreError,
  type LocalSupervisorStore,
} from "../infrastructure/fs/local-supervisor-store.js";
import {
  encodeSupervisorMessage,
  parseSupervisorRequestFrame,
  parseSupervisorResponseFrame,
  SUPERVISOR_PROTOCOL_VERSION,
  SupervisorProtocolError,
  type SupervisorErrorCode,
  type SupervisorRequest,
  type SupervisorResponse,
  type SupervisorResult,
} from "./protocol.js";
import {
  createSupervisorStartLock,
  supervisorSocketPath,
  parseSupervisorDescriptor,
  type JobRecord,
  type SupervisorDescriptor,
  type WorkerDescriptor,
} from "./records.js";
import { LocalSupervisorService, SupervisorServiceError, type WorkerLauncher } from "./service.js";
import { closeServer, exchangeFrame, listen, readFrame } from "./socket-transport.js";
import { requestWorker } from "./worker.js";
import { createAdmissionInitializedEvent } from "./admission.js";

const SUPERVISOR_REQUEST_TIMEOUT_MS = 15_000;
const STARTUP_TIMEOUT_MS = 10_000;
const RECONCILIATION_INTERVAL_MS = 100;

export type SupervisorPolicy = Pick<EffectiveFlowConfig, "policyDigest" | "supervisor">;

export class SupervisorStartupTimeoutError extends Error {
  override readonly name = "SupervisorStartupTimeoutError";

  constructor(
    readonly pid: number | null,
    readonly timeoutMs: number,
  ) {
    super(
      pid === null
        ? `supervisor did not become ready within ${timeoutMs}ms`
        : `supervisor process ${pid} did not become ready within ${timeoutMs}ms`,
    );
  }
}

export interface StartSupervisorServerOptions {
  readonly store: LocalSupervisorStore;
  readonly launcher: WorkerLauncher;
  readonly generation?: string;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly policy?: SupervisorPolicy;
}

export interface RunningSupervisor {
  readonly descriptor: SupervisorDescriptor;
  readonly completed: Promise<void>;
  readonly close: () => Promise<void>;
}

export interface RunSupervisorDaemonOptions {
  readonly store: LocalSupervisorStore;
  readonly cliPath: string;
  readonly startupToken?: string;
  readonly startupOwnerToken?: string;
  readonly signal?: AbortSignal;
  readonly policy?: SupervisorPolicy;
}

export interface EnsureSupervisorOptions {
  readonly requirePolicyMatch?: boolean;
  readonly startupTimeoutMs?: number;
}

export class DetachedWorkerLauncher implements WorkerLauncher {
  constructor(
    readonly store: LocalSupervisorStore,
    readonly cliPath: string,
    readonly startupTimeoutMs = STARTUP_TIMEOUT_MS,
  ) {}

  async launch(job: JobRecord): Promise<WorkerDescriptor> {
    const child = spawn(
      process.execPath,
      [this.cliPath, "__worker", job.jobId, "--runs-dir", this.store.runsDirectory],
      {
        cwd: job.cwd,
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    const expectedPid = child.pid;
    if (expectedPid === undefined) {
      throw new Error(`worker process for job "${job.jobId}" has no process id`);
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError !== undefined) {
        throw spawnError;
      }
      try {
        const descriptor = await this.store.readWorkerDescriptor(job.workerId);
        if (
          descriptor.jobId !== job.jobId ||
          descriptor.runId !== job.runId ||
          descriptor.jobDigest !== job.digest ||
          descriptor.token !== job.token ||
          descriptor.pid !== expectedPid
        ) {
          throw new Error(`worker descriptor for job "${job.jobId}" has mismatched identity`);
        }
        return descriptor;
      } catch (error) {
        if (!(error instanceof LocalSupervisorStoreError && error.code === "not_found")) {
          throw error;
        }
      }
      if (child.exitCode !== null) {
        throw new Error(`worker for job "${job.jobId}" exited with code ${child.exitCode}`);
      }
      await delay(20);
    }
    throw new Error(
      `worker for job "${job.jobId}" did not publish readiness within ${this.startupTimeoutMs}ms`,
    );
  }

  async request(descriptor: WorkerDescriptor, command: Parameters<WorkerLauncher["request"]>[1]) {
    return await requestWorker(descriptor, command);
  }
}

export async function runSupervisorDaemon(options: RunSupervisorDaemonOptions): Promise<void> {
  if ((options.startupToken === undefined) !== (options.startupOwnerToken === undefined)) {
    throw new Error("supervisor startup transfer requires both source and owner tokens");
  }
  if (options.startupToken !== undefined && options.startupOwnerToken !== undefined) {
    await options.store.transferSupervisorStart(
      options.startupToken,
      process.pid,
      options.startupOwnerToken,
    );
  }
  const running = await startSupervisorServer({
    store: options.store,
    launcher: new DetachedWorkerLauncher(options.store, options.cliPath),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  if (options.signal?.aborted === true) {
    await running.close();
  } else {
    options.signal?.addEventListener("abort", () => void running.close(), { once: true });
  }
  await running.completed;
}

export async function ensureSupervisor(
  store: LocalSupervisorStore,
  cliPath: string,
  policy: SupervisorPolicy = resolveFlowConfig({}),
  options: EnsureSupervisorOptions = {},
): Promise<Extract<SupervisorResponse, { readonly ok: true }>> {
  await store.initialize();
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new RangeError("startupTimeoutMs must be a positive safe integer");
  }
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const status = await trySupervisorStatus(store);
    if (status !== null) {
      return acceptExistingSupervisor(status, policy, options);
    }

    const requestedLock = createSupervisorStartLock({
      pid: process.pid,
      token: randomUUID(),
      acquiredAt: new Date().toISOString(),
    });
    const reservation = await store.reserveSupervisorStart(requestedLock);
    if (!reservation.acquired) {
      if (!isProcessAlive(reservation.record.pid)) {
        await releaseStaleSupervisorStart(store, reservation.record.token);
        continue;
      }
      await delay(25);
      continue;
    }

    try {
      const ready = await trySupervisorStatus(store);
      if (ready !== null) {
        return acceptExistingSupervisor(ready, policy, options);
      }
      return await launchSupervisor(
        store,
        cliPath,
        deadline,
        startupTimeoutMs,
        requestedLock.token,
        policy,
        options,
      );
    } finally {
      await releaseStaleSupervisorStart(store, requestedLock.token);
    }
  }
  throw new Error(`supervisor did not become ready within ${startupTimeoutMs}ms`);
}

async function launchSupervisor(
  store: LocalSupervisorStore,
  cliPath: string,
  deadline: number,
  startupTimeoutMs: number,
  startupToken: string,
  policy: SupervisorPolicy,
  options: EnsureSupervisorOptions,
): Promise<Extract<SupervisorResponse, { readonly ok: true }>> {
  const descriptor = await store.readSupervisorDescriptor();
  if (descriptor !== null && isProcessAlive(descriptor.pid)) {
    const liveDeadline = Math.min(deadline, Date.now() + 1_000);
    while (Date.now() < liveDeadline) {
      await delay(25);
      const retry = await trySupervisorStatus(store);
      if (retry !== null) {
        return acceptExistingSupervisor(retry, policy, options);
      }
    }
    if (isProcessAlive(descriptor.pid)) {
      throw new Error(
        `recorded supervisor process ${descriptor.pid} is live but its control endpoint is unavailable`,
      );
    }
  }

  const admissionStore = new JsonlAdmissionStore(store.runsDirectory);
  try {
    await admissionStore.open(
      createAdmissionInitializedEvent({
        policyDigest: policy.policyDigest,
        limits: policy.supervisor,
        at: new Date().toISOString(),
      }),
    );
  } finally {
    admissionStore.close();
  }

  const socketPath = join(
    store.socketDirectory,
    basename(supervisorSocketPath(store.runsDirectory)),
  );
  await rm(socketPath, { force: true });
  const startupOwnerToken = randomUUID();
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "__supervisor",
      "--runs-dir",
      store.runsDirectory,
      "--startup-token",
      startupToken,
      "--startup-owner-token",
      startupOwnerToken,
      "--policy-digest",
      policy.policyDigest,
      "--max-active-workers",
      String(policy.supervisor.maxActiveWorkers),
      "--max-queued-jobs",
      String(policy.supervisor.maxQueuedJobs),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  try {
    if (child.pid === undefined) {
      throw new Error("supervisor process has no process id");
    }
    while (Date.now() < deadline) {
      if (spawnError !== undefined) {
        throw spawnError;
      }
      const status = await trySupervisorStatus(store);
      if (status !== null) {
        return assertSupervisorPolicy(status, policy);
      }
      if (child.exitCode !== null) {
        throw new Error(`supervisor process exited with code ${child.exitCode}`);
      }
      await delay(25);
    }
    throw new SupervisorStartupTimeoutError(child.pid ?? null, startupTimeoutMs);
  } catch (error) {
    await terminateDetachedChild(child);
    throw error;
  }
}

async function terminateDetachedChild(child: ChildProcess, graceMs = 1_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.ref();
  try {
    const exited = new Promise<void>((resolvePromise) =>
      child.once("exit", () => resolvePromise()),
    );
    signalDetachedChild(child, "SIGTERM");
    if (await settlesWithin(exited, graceMs)) {
      return;
    }
    signalDetachedChild(child, "SIGKILL");
    if (
      !(await settlesWithin(exited, graceMs)) &&
      child.pid !== undefined &&
      isProcessAlive(child.pid)
    ) {
      throw new Error(`timed out terminating supervisor process ${child.pid}`);
    }
  } finally {
    child.unref();
  }
}

function signalDetachedChild(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      child.kill(signal);
      return;
    }
    throw error;
  }
}

async function settlesWithin(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([completion.then(() => true), delay(timeoutMs, false, { ref: false })]);
}

async function releaseStaleSupervisorStart(
  store: LocalSupervisorStore,
  token: string,
): Promise<void> {
  try {
    await store.releaseSupervisorStart(token);
  } catch (error) {
    if (
      !(
        error instanceof LocalSupervisorStoreError &&
        (error.code === "not_found" || error.code === "identity_mismatch")
      )
    ) {
      throw error;
    }
  }
}

export async function startSupervisorServer(
  options: StartSupervisorServerOptions,
): Promise<RunningSupervisor> {
  await options.store.initialize();
  const policy = options.policy ?? resolveFlowConfig({});
  const generation = options.generation ?? randomUUID();
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const socketPath = join(
    options.store.socketDirectory,
    basename(supervisorSocketPath(options.store.runsDirectory)),
  );
  const admissionStore = new JsonlAdmissionStore(options.store.runsDirectory);
  await admissionStore.open(
    createAdmissionInitializedEvent({
      policyDigest: policy.policyDigest,
      limits: policy.supervisor,
      at: startedAt,
    }),
  );
  const service = new LocalSupervisorService({
    store: options.store,
    admissionStore,
    launcher: options.launcher,
    generation,
    pid,
    startedAt,
  });
  await service.reconcile();
  let closePromise: Promise<void> | undefined;
  let fatalError: Error | undefined;
  let reconciling = false;
  let reconciliationCompletion: Promise<void> = Promise.resolve();
  const activeHandlers = new Set<Promise<void>>();
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    const handler = handleConnection(socket, service, () => {
      clearInterval(reconciliationTimer);
      closePromise ??= closeSupervisorServer(server, socketPath);
    }).catch((error: unknown) => {
      fatalError = error instanceof Error ? error : new Error(String(error));
      closePromise ??= closeSupervisorServer(server, socketPath);
    });
    activeHandlers.add(handler);
    void handler.then(() => activeHandlers.delete(handler));
  });
  const reconciliationTimer = setInterval(() => {
    if (reconciling || service.isShuttingDown) {
      return;
    }
    reconciling = true;
    reconciliationCompletion = service.reconcile().then(
      () => {
        reconciling = false;
      },
      (error: unknown) => {
        reconciling = false;
        fatalError = error instanceof Error ? error : new Error(String(error));
        closePromise ??= closeSupervisorServer(server, socketPath);
      },
    );
  }, RECONCILIATION_INTERVAL_MS);
  reconciliationTimer.unref();

  await listen(server, socketPath);
  await chmod(socketPath, 0o600);
  const descriptor = parseSupervisorDescriptor({
    version: 1,
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    generation,
    pid,
    startedAt,
    runsDirectory: options.store.runsDirectory,
    socketPath,
    policyDigest: policy.policyDigest,
    limits: policy.supervisor,
  });
  try {
    await options.store.writeSupervisorDescriptor(descriptor);
  } catch (error) {
    await closeSupervisorServer(server, socketPath).catch(() => undefined);
    throw error;
  }

  const completed = new Promise<void>((resolvePromise, reject) => {
    server.once("close", () => {
      clearInterval(reconciliationTimer);
      void rm(socketPath, { force: true })
        .then(async () => {
          await Promise.all(activeHandlers);
          await reconciliationCompletion;
          await service.close();
          if (fatalError !== undefined) {
            throw fatalError;
          }
        })
        .then(resolvePromise, reject);
    });
    server.once("error", reject);
  });
  return {
    descriptor,
    completed,
    async close() {
      clearInterval(reconciliationTimer);
      closePromise ??= closeSupervisorServer(server, socketPath);
      await closePromise;
      await completed;
    },
  };
}

export async function requestSupervisor(
  store: LocalSupervisorStore,
  command: SupervisorRequest["command"],
): Promise<SupervisorResponse> {
  const requestId = randomUUID();
  const socketPath = join(
    store.socketDirectory,
    basename(supervisorSocketPath(store.runsDirectory)),
  );
  const response = parseSupervisorResponseFrame(
    await exchangeFrame(
      socketPath,
      encodeSupervisorMessage({
        version: SUPERVISOR_PROTOCOL_VERSION,
        requestId,
        command,
      }),
      SUPERVISOR_REQUEST_TIMEOUT_MS,
    ),
  );
  if (response.requestId !== requestId) {
    throw new Error(
      `supervisor response id "${response.requestId}" does not match request "${requestId}"`,
    );
  }
  return response;
}

async function handleConnection(
  socket: Socket,
  service: LocalSupervisorService,
  requestClose: () => void,
): Promise<void> {
  let requestId: string = randomUUID();
  try {
    const request = parseSupervisorRequestFrame(await readFrame(socket));
    requestId = request.requestId;
    const dispatched = await dispatch(request.command, service);
    const response: SupervisorResponse = {
      version: SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      ok: true,
      result: dispatched.result,
    } as SupervisorResponse;
    if (dispatched.shutdown) {
      requestClose();
    }
    socket.end(encodeSupervisorMessage(response));
  } catch (error) {
    socket.end(encodeSupervisorMessage(errorResponse(requestId, error)));
  }
}

async function dispatch(
  command: SupervisorRequest["command"],
  service: LocalSupervisorService,
): Promise<{ readonly result: SupervisorResult; readonly shutdown: boolean }> {
  if (command.type !== "status") {
    service.assertPolicy(command.policyDigest);
  }
  switch (command.type) {
    case "status":
      return { result: await service.status(), shutdown: false };
    case "submit":
      return { result: await service.submit(command), shutdown: false };
    case "events":
      return { result: (await service.events(command)) as SupervisorResult, shutdown: false };
    case "cancel":
      return { result: await service.cancel(command), shutdown: false };
    case "shutdown": {
      try {
        await service.prepareShutdown();
        await service.retirePolicy();
      } catch (error) {
        if (error instanceof SupervisorServiceError && error.code === "conflict") {
          throw new DaemonRequestError("active_workers", error.message);
        }
        throw error;
      }
      return { result: { type: "shutdown", stopped: true }, shutdown: true };
    }
  }
}

class DaemonRequestError extends Error {
  constructor(
    readonly code: SupervisorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function errorResponse(requestId: string, error: unknown): SupervisorResponse {
  const normalized = normalizeError(error);
  return {
    version: SUPERVISOR_PROTOCOL_VERSION,
    requestId: requestId as ReturnType<typeof randomUUID>,
    ok: false,
    error: normalized,
  };
}

function normalizeError(error: unknown): {
  readonly code: SupervisorErrorCode;
  readonly message: string;
} {
  if (error instanceof SupervisorServiceError || error instanceof DaemonRequestError) {
    return { code: error.code, message: boundedMessage(error.message) };
  }
  if (error instanceof SupervisorProtocolError) {
    return { code: "protocol_invalid", message: boundedMessage(error.message) };
  }
  if (error instanceof AdmissionStoreError) {
    return {
      code: error.code === "policy_mismatch" ? "policy_mismatch" : "internal",
      message: boundedMessage(error.message),
    };
  }
  if (error instanceof LocalSupervisorStoreError) {
    if (error.code === "not_found") {
      return { code: "not_found", message: boundedMessage(error.message) };
    }
    if (error.code === "identity_mismatch") {
      return { code: "identity_mismatch", message: boundedMessage(error.message) };
    }
    return { code: "internal", message: boundedMessage(error.message) };
  }
  return {
    code: "internal",
    message: boundedMessage(error instanceof Error ? error.message : String(error)),
  };
}

async function closeSupervisorServer(server: Server, socketPath: string): Promise<void> {
  if (server.listening) {
    await closeServer(server);
  }
  await rm(socketPath, { force: true });
}

function boundedMessage(message: string): string {
  return message.length <= 16_384 ? message : `${message.slice(0, 16_350)}… [truncated]`;
}

async function trySupervisorStatus(
  store: LocalSupervisorStore,
): Promise<Extract<SupervisorResponse, { readonly ok: true }> | null> {
  try {
    const response = await requestSupervisor(store, { type: "status" });
    return response.ok && response.result.type === "status" ? response : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function assertSupervisorPolicy(
  response: Extract<SupervisorResponse, { readonly ok: true }>,
  policy: SupervisorPolicy,
): Extract<SupervisorResponse, { readonly ok: true }> {
  if (
    response.result.type !== "status" ||
    response.result.policyDigest !== policy.policyDigest ||
    response.result.limits.maxActiveWorkers !== policy.supervisor.maxActiveWorkers ||
    response.result.limits.maxQueuedJobs !== policy.supervisor.maxQueuedJobs
  ) {
    throw new SupervisorServiceError(
      "policy_mismatch",
      `live supervisor policy does not match requested policy ${policy.policyDigest}; shut down the idle supervisor before applying configuration changes`,
    );
  }
  return response;
}

function acceptExistingSupervisor(
  response: Extract<SupervisorResponse, { readonly ok: true }>,
  policy: SupervisorPolicy,
  options: EnsureSupervisorOptions,
): Extract<SupervisorResponse, { readonly ok: true }> {
  return options.requirePolicyMatch === false ? response : assertSupervisorPolicy(response, policy);
}
