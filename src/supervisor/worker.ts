import { createHash, randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { basename, join } from "node:path";

import type {
  NodeEffectReconciler,
  NodeExecutor,
  RecoverableRunEventStore,
  WorkspaceIsolator,
} from "../application/ports.js";
import {
  RunCancellation,
  RunRecoveryError,
  resumeWorkflow,
  runWorkflow,
} from "../application/run-workflow.js";
import { reduceRunEvents, type RunState } from "../domain/run/events.js";
import { compileWorkflowText } from "../domain/workflow/compiler.js";
import type { LocalSupervisorStore } from "../infrastructure/fs/local-supervisor-store.js";
import { createProductionWorkspaceIsolator } from "../infrastructure/runtime/production-workspace-isolator.js";
import {
  encodeSupervisorMessage,
  parseWorkerRequestFrame,
  parseWorkerResponseFrame,
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorErrorCode,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.js";
import { parseWorkerDescriptor, workerSocketPath, type WorkerDescriptor } from "./records.js";
import { closeServer, exchangeFrame, listen, readFrame } from "./socket-transport.js";

const CONTROL_TIMEOUT_MS = 5_000;
const ADOPTION_TIMEOUT_MS = 10_000;

export interface ExecuteWorkerJobOptions {
  readonly store: LocalSupervisorStore;
  readonly executor: NodeExecutor;
  readonly effectReconciler: NodeEffectReconciler;
  readonly createRunStore: (rootDirectory: string) => RecoverableRunEventStore;
  readonly createWorkspaceIsolator?: (runsDirectory: string) => WorkspaceIsolator;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

type WorkerCommand = WorkerRequest["command"];

interface WorkerCompletion {
  readonly state?: RunState;
  readonly error?: Error;
  readonly recoveryError?: RunRecoveryError;
}

export async function executeWorkerJob(
  jobId: string,
  options: ExecuteWorkerJobOptions,
): Promise<number> {
  const job = await options.store.readJob(jobId);
  const workflow = compileWorkflowText(job.workflowSource, job.sourceName);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const socketPath = join(options.store.socketDirectory, basename(workerSocketPath(job.workerId)));
  const controller = new AbortController();
  if (options.signal?.aborted === true) {
    controller.abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", () => controller.abort(options.signal?.reason), {
      once: true,
    });
  }
  let descriptor = parseWorkerDescriptor({
    version: 1,
    workerId: job.workerId,
    jobId: job.jobId,
    runId: job.runId,
    pid,
    token: job.token,
    jobDigest: job.digest,
    socketPath,
    status: "starting",
    startedAt,
    updatedAt: startedAt,
  });
  const cancellationCommands = new Map<
    string,
    {
      readonly actor: string;
      readonly reason: string | undefined;
      readonly completion: Promise<WorkerCompletion>;
    }
  >();
  let completionSettled = false;
  let resolveCompletion: (result: WorkerCompletion) => void = () => undefined;
  const completion = new Promise<WorkerCompletion>((resolvePromise) => {
    resolveCompletion = (result) => {
      if (!completionSettled) {
        completionSettled = true;
        resolvePromise(result);
      }
    };
  });
  let resolveAdoption: () => void = () => undefined;
  const adoption = new Promise<void>((resolvePromise) => {
    resolveAdoption = resolvePromise;
  });
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolvePromise) => {
    resolveReady = resolvePromise;
  });
  let resolveAdoptionAcknowledged: () => void = () => undefined;
  const adoptionAcknowledged = new Promise<void>((resolvePromise) => {
    resolveAdoptionAcknowledged = resolvePromise;
  });

  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    void handleWorkerConnection(socket, {
      jobToken: job.token,
      workerId: job.workerId,
      getDescriptor: () => descriptor,
      adopt: resolveAdoption,
      ready,
      acknowledgeAdoption: resolveAdoptionAcknowledged,
      cancel(command) {
        const existing = cancellationCommands.get(command.commandId);
        if (existing !== undefined) {
          return existing.actor === command.actor && existing.reason === command.reason
            ? existing.completion
            : Promise.resolve({
                error: new Error(
                  `cancellation command "${command.commandId}" was reused with different input`,
                ),
              });
        }
        const cancellation = completion.then((result) => result);
        cancellationCommands.set(command.commandId, {
          actor: command.actor,
          reason: command.reason,
          completion: cancellation,
        });
        controller.abort(
          new RunCancellation(
            command.reason ?? `run cancelled by ${command.actor}`,
            command.actor,
            command.commandId,
          ),
        );
        return cancellation;
      },
    });
  });

  await listen(server, socketPath);
  await chmod(socketPath, 0o600);

  await options.store.writeWorkerDescriptor(descriptor);

  let adoptionTimer: NodeJS.Timeout | undefined;
  let adopted = false;
  try {
    await Promise.race([
      adoption,
      new Promise<never>((_resolve, reject) => {
        adoptionTimer = setTimeout(
          () => reject(new Error(`worker was not adopted within ${ADOPTION_TIMEOUT_MS}ms`)),
          ADOPTION_TIMEOUT_MS,
        );
        adoptionTimer.unref();
      }),
    ]);
    adopted = true;
  } catch (error) {
    resolveCompletion({ error: error instanceof Error ? error : new Error(String(error)) });
  } finally {
    if (adoptionTimer !== undefined) {
      clearTimeout(adoptionTimer);
    }
  }

  if (adopted) {
    descriptor = parseWorkerDescriptor({
      ...descriptor,
      status: "running",
      updatedAt: now().toISOString(),
    });
    await options.store.writeWorkerDescriptor(descriptor);
    resolveReady();
    try {
      await promiseWithTimeout(
        adoptionAcknowledged,
        ADOPTION_TIMEOUT_MS,
        `worker adoption was not acknowledged within ${ADOPTION_TIMEOUT_MS}ms`,
      );
    } catch (error) {
      resolveCompletion({ error: error instanceof Error ? error : new Error(String(error)) });
    }

    if (!completionSettled) {
      const runStore = options.createRunStore(options.store.runsDirectory);
      const runOptions = {
        cwd: job.cwd,
        protectedPaths: [options.store.runsDirectory],
        store: runStore,
        executor: options.executor,
        effectReconciler: options.effectReconciler,
        workspaceIsolator: (options.createWorkspaceIsolator ?? createProductionWorkspaceIsolator)(
          options.store.runsDirectory,
        ),
        signal: controller.signal,
        now,
      } as const;
      const execution = (
        job.mode === "run"
          ? runWorkflow(workflow, {
              ...runOptions,
              runId: job.runId,
              ...(job.capabilitySnapshot === undefined
                ? {}
                : { capabilitySnapshot: job.capabilitySnapshot }),
            })
          : resumeWorkflow(workflow, { ...runOptions, runId: job.runId })
      ).then(
        (state) => ({ state }),
        async (error: unknown): Promise<WorkerCompletion> => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          if (!(normalized instanceof RunRecoveryError)) {
            return { error: normalized };
          }
          try {
            const state = reduceRunEvents(await runStore.read(job.runId));
            return { state, recoveryError: normalized };
          } catch (replayError) {
            return {
              error: new AggregateError(
                [normalized, replayError],
                `recovery failed and run "${job.runId}" could not be replayed`,
              ),
            };
          }
        },
      );
      void execution.then(resolveCompletion);
    }
  }

  const result = await completion;
  const exitCode =
    result.state === undefined || result.recoveryError !== undefined
      ? 1
      : runStateExitCode(result.state);
  descriptor = parseWorkerDescriptor({
    ...descriptor,
    status: result.state === undefined ? "failed" : "terminal",
    ...(result.state === undefined
      ? { failure: boundedMessage(result.error?.message ?? "worker execution failed") }
      : {
          runStatus: result.state.status,
          ...(result.recoveryError === undefined
            ? {}
            : {
                recoveryErrorCode: result.recoveryError.code,
                failure: boundedMessage(result.recoveryError.message),
              }),
        }),
    exitCode,
    updatedAt: now().toISOString(),
  });
  await options.store.writeWorkerDescriptor(descriptor);

  await closeServer(server);
  await rm(socketPath, { force: true });
  await options.store.releaseActiveRunClaim(job.runId, job.jobId);
  return exitCode;
}

export async function requestWorker(
  descriptor: WorkerDescriptor,
  command: WorkerCommand,
): Promise<WorkerResponse> {
  const requestId = randomUUID();
  const responseFrame = await exchangeFrame(
    descriptor.socketPath,
    encodeSupervisorMessage({
      version: SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      workerId: descriptor.workerId,
      token: descriptor.token,
      command,
    }),
    CONTROL_TIMEOUT_MS,
  );
  const response = parseWorkerResponseFrame(responseFrame);
  if (response.requestId !== requestId) {
    throw new Error(
      `worker response id "${response.requestId}" does not match request "${requestId}"`,
    );
  }
  return response;
}

async function handleWorkerConnection(
  socket: Socket,
  context: {
    readonly jobToken: string;
    readonly workerId: string;
    readonly getDescriptor: () => WorkerDescriptor;
    readonly adopt: () => void;
    readonly ready: Promise<void>;
    readonly acknowledgeAdoption: () => void;
    readonly cancel: (
      command: Extract<WorkerCommand, { readonly type: "cancel" }>,
    ) => Promise<WorkerCompletion>;
  },
): Promise<void> {
  let requestId: string = randomUUID();
  try {
    const request = parseWorkerRequestFrame(await readFrame(socket));
    requestId = request.requestId;
    if (request.workerId !== context.workerId || !sameToken(request.token, context.jobToken)) {
      writeResponse(
        socket,
        errorResponse(requestId, "identity_mismatch", "worker identity mismatch"),
      );
      return;
    }

    if (request.command.type === "identify") {
      context.adopt();
      await context.ready;
      const descriptor = context.getDescriptor();
      writeResponse(
        socket,
        {
          version: SUPERVISOR_PROTOCOL_VERSION,
          requestId,
          ok: true,
          result: {
            type: "identity",
            workerId: descriptor.workerId,
            runId: descriptor.runId,
            pid: descriptor.pid,
            jobDigest: descriptor.jobDigest,
            status: descriptor.status,
            ...(descriptor.runStatus === undefined ? {} : { runStatus: descriptor.runStatus }),
          },
        },
        context.acknowledgeAdoption,
      );
      return;
    }

    const result = await context.cancel(request.command);
    if (result.state?.status !== "cancelled") {
      writeResponse(
        socket,
        errorResponse(
          requestId,
          "conflict",
          result.error?.message ?? `run ended with status "${result.state?.status ?? "unknown"}"`,
        ),
      );
      return;
    }
    writeResponse(socket, {
      version: SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      ok: true,
      result: {
        type: "cancelled",
        commandId: request.command.commandId,
        runId: result.state.runId,
        runStatus: "cancelled",
        phase: "active",
        lastSequence: result.state.lastSequence,
      },
    });
  } catch (error) {
    writeResponse(
      socket,
      errorResponse(
        requestId,
        "protocol_invalid",
        boundedMessage(error instanceof Error ? error.message : String(error)),
      ),
    );
  }
}

function writeResponse(socket: Socket, response: WorkerResponse, flushed?: () => void): void {
  socket.end(encodeSupervisorMessage(response), flushed);
}

function errorResponse(
  requestId: string,
  code: SupervisorErrorCode,
  message: string,
): WorkerResponse {
  return {
    version: SUPERVISOR_PROTOCOL_VERSION,
    requestId: requestId as ReturnType<typeof randomUUID>,
    ok: false,
    error: { code, message: boundedMessage(message) },
  };
}

function sameToken(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return leftDigest.length === rightDigest.length && leftDigest.equals(rightDigest);
}

function runStateExitCode(state: RunState): number {
  if (state.status === "succeeded") {
    return 0;
  }
  return state.status === "waiting_for_approval" ? 3 : 1;
}

function boundedMessage(message: string): string {
  return message.length <= 16_384 ? message : `${message.slice(0, 16_350)}… [truncated]`;
}

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
