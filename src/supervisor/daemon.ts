import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  LocalSupervisorStoreError,
  type LocalSupervisorStore,
} from "../infrastructure/fs/local-supervisor-store.js";
import {
  encodeSupervisorMessage,
  parseSupervisorRequestFrame,
  parseSupervisorResponseFrame,
  SUPERVISOR_PROTOCOL_VERSION,
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

const SUPERVISOR_REQUEST_TIMEOUT_MS = 15_000;
const STARTUP_TIMEOUT_MS = 10_000;

export interface StartSupervisorServerOptions {
  readonly store: LocalSupervisorStore;
  readonly launcher: WorkerLauncher;
  readonly generation?: string;
  readonly pid?: number;
  readonly startedAt?: string;
}

export interface RunningSupervisor {
  readonly descriptor: SupervisorDescriptor;
  readonly completed: Promise<void>;
  readonly close: () => Promise<void>;
}

export interface RunSupervisorDaemonOptions {
  readonly store: LocalSupervisorStore;
  readonly cliPath: string;
  readonly signal?: AbortSignal;
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
  const running = await startSupervisorServer({
    store: options.store,
    launcher: new DetachedWorkerLauncher(options.store, options.cliPath),
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
): Promise<Extract<SupervisorResponse, { readonly ok: true }>> {
  await store.initialize();
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await trySupervisorStatus(store);
    if (status !== null) {
      return status;
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
        return ready;
      }
      return await launchSupervisor(store, cliPath, deadline);
    } finally {
      await store.releaseSupervisorStart(requestedLock.token);
    }
  }
  throw new Error(`supervisor did not become ready within ${STARTUP_TIMEOUT_MS}ms`);
}

async function launchSupervisor(
  store: LocalSupervisorStore,
  cliPath: string,
  deadline: number,
): Promise<Extract<SupervisorResponse, { readonly ok: true }>> {
  const descriptor = await store.readSupervisorDescriptor();
  if (descriptor !== null && isProcessAlive(descriptor.pid)) {
    const liveDeadline = Math.min(deadline, Date.now() + 1_000);
    while (Date.now() < liveDeadline) {
      await delay(25);
      const retry = await trySupervisorStatus(store);
      if (retry !== null) {
        return retry;
      }
    }
    if (isProcessAlive(descriptor.pid)) {
      throw new Error(
        `recorded supervisor process ${descriptor.pid} is live but its control endpoint is unavailable`,
      );
    }
  }

  const socketPath = join(
    store.socketDirectory,
    basename(supervisorSocketPath(store.runsDirectory)),
  );
  await rm(socketPath, { force: true });
  const child = spawn(
    process.execPath,
    [cliPath, "__supervisor", "--runs-dir", store.runsDirectory],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  while (Date.now() < deadline) {
    if (spawnError !== undefined) {
      throw spawnError;
    }
    const status = await trySupervisorStatus(store);
    if (status !== null) {
      return status;
    }
    if (child.exitCode !== null) {
      throw new Error(`supervisor process exited with code ${child.exitCode}`);
    }
    await delay(25);
  }
  throw new Error(`supervisor did not become ready within ${STARTUP_TIMEOUT_MS}ms`);
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
  const generation = options.generation ?? randomUUID();
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const socketPath = join(
    options.store.socketDirectory,
    basename(supervisorSocketPath(options.store.runsDirectory)),
  );
  const service = new LocalSupervisorService({
    store: options.store,
    launcher: options.launcher,
    generation,
    pid,
    startedAt,
  });
  let closePromise: Promise<void> | undefined;
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    void handleConnection(socket, service, options.store, () => {
      closePromise ??= closeSupervisorServer(server, socketPath);
    });
  });

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
  });
  try {
    await options.store.writeSupervisorDescriptor(descriptor);
  } catch (error) {
    await closeSupervisorServer(server, socketPath).catch(() => undefined);
    throw error;
  }

  const completed = new Promise<void>((resolvePromise, reject) => {
    server.once("close", () => {
      rm(socketPath, { force: true }).then(() => resolvePromise(), reject);
    });
    server.once("error", reject);
  });
  return {
    descriptor,
    completed,
    close() {
      closePromise ??= closeSupervisorServer(server, socketPath);
      return closePromise;
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
  store: LocalSupervisorStore,
  requestClose: () => void,
): Promise<void> {
  let requestId: string = randomUUID();
  try {
    const request = parseSupervisorRequestFrame(await readFrame(socket));
    requestId = request.requestId;
    const dispatched = await dispatch(request.command, service, store);
    const response: SupervisorResponse = {
      version: SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      ok: true,
      result: dispatched.result,
    } as SupervisorResponse;
    socket.end(encodeSupervisorMessage(response), () => {
      if (dispatched.shutdown) {
        requestClose();
      }
    });
  } catch (error) {
    socket.end(encodeSupervisorMessage(errorResponse(requestId, error)));
  }
}

async function dispatch(
  command: SupervisorRequest["command"],
  service: LocalSupervisorService,
  store: LocalSupervisorStore,
): Promise<{ readonly result: SupervisorResult; readonly shutdown: boolean }> {
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
      if ((await store.listActiveRunClaims()).length > 0) {
        throw new DaemonRequestError(
          "active_workers",
          "supervisor shutdown is refused while workers are active",
        );
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
  if (error instanceof LocalSupervisorStoreError) {
    if (error.code === "not_found") {
      return { code: "not_found", message: boundedMessage(error.message) };
    }
    if (error.code === "identity_mismatch") {
      return { code: "identity_mismatch", message: boundedMessage(error.message) };
    }
  }
  return {
    code: "protocol_invalid",
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
