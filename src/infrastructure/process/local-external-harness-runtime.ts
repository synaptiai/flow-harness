import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";

import type { CommandSandbox, PreparedCommand } from "../../application/command-sandbox.js";
import type { HarnessEvaluationResult } from "../../application/evaluation-adapter.js";
import type {
  ExternalHarnessRuntime,
  ExternalHarnessRuntimeRequest,
} from "../../application/external-harness-adapter.js";
import {
  ExternalHarnessProtocolSession,
  MAX_EXTERNAL_HARNESS_FRAME_BYTES,
  signExternalHarnessParentFrame,
} from "../../domain/evaluation/external-harness-protocol.js";
import { MAX_EVALUATION_INSTRUCTION_BYTES } from "../../domain/evaluation/plan.js";
import {
  parseEvaluationHarnessOutcome,
  unavailableEvaluationMetrics,
} from "../../domain/evaluation/records.js";
import { type ProcessTreeExitResult, waitForProcessTreeExit } from "./command-node-executor.js";
import type { ExternalHarnessDescriptor } from "./external-harness-descriptor.js";

const MAX_EXTERNAL_HARNESS_EVENTS = 256;
const MAX_RETAINED_EXTERNAL_HARNESS_STDERR_BYTES = 16_384;
export const MAX_EXTERNAL_HARNESS_STDERR_BYTES = 64 * 1_024;

type ProcessExternalHarnessIdentity = Exclude<
  ExternalHarnessRuntimeRequest["identity"],
  { readonly adapter: "prime-agent-native-v1" }
>;

export interface ExternalHarnessDescriptorRegistry {
  resolveAdmitted(identity: ProcessExternalHarnessIdentity): Promise<ExternalHarnessDescriptor>;
}

export interface ExternalHarnessInferenceRequest {
  readonly identity: ExternalHarnessRuntimeRequest["identity"];
  readonly evaluation: ExternalHarnessRuntimeRequest["evaluation"];
  readonly requestId: string;
  readonly body: string;
}

export interface ExternalHarnessInferenceBroker {
  infer(request: ExternalHarnessInferenceRequest, signal?: AbortSignal): Promise<string>;
  close?(evaluation: ExternalHarnessRuntimeRequest["evaluation"]): Promise<void>;
}

export interface ExternalHarnessExecutionDeadline {
  readonly signal: AbortSignal;
  readonly reason: Error;
  readonly expired: boolean;
  remainingMs(): number;
  dispose(): void;
}

export interface LocalExternalHarnessRuntimeOptions {
  readonly registry: ExternalHarnessDescriptorRegistry;
  readonly sandbox: CommandSandbox;
  readonly inferenceBroker: ExternalHarnessInferenceBroker;
  readonly platform?: NodeJS.Platform;
  readonly terminationGraceMs?: number;
  readonly terminationConfirmationMs?: number;
  readonly beforeHelloWrite?: (child: ChildProcess) => void | Promise<void>;
  readonly deadlineFactory?: (maxMs: number) => ExternalHarnessExecutionDeadline;
}

export class LocalExternalHarnessRuntime implements ExternalHarnessRuntime {
  readonly #inferenceBroker: ExternalHarnessInferenceBroker;
  readonly #platform: NodeJS.Platform;
  readonly #registry: ExternalHarnessDescriptorRegistry;
  readonly #sandbox: CommandSandbox;
  readonly #terminationConfirmationMs: number;
  readonly #terminationGraceMs: number;
  readonly #beforeHelloWrite: ((child: ChildProcess) => void | Promise<void>) | undefined;
  readonly #deadlineFactory: (maxMs: number) => ExternalHarnessExecutionDeadline;

  constructor(options: LocalExternalHarnessRuntimeOptions) {
    this.#registry = options.registry;
    this.#sandbox = options.sandbox;
    this.#inferenceBroker = options.inferenceBroker;
    this.#platform = options.platform ?? process.platform;
    this.#terminationGraceMs = options.terminationGraceMs ?? 2_000;
    this.#terminationConfirmationMs = options.terminationConfirmationMs ?? 10_000;
    this.#beforeHelloWrite = options.beforeHelloWrite;
    this.#deadlineFactory = options.deadlineFactory ?? ((maxMs) => new ExecutionDeadline(maxMs));
    if (!Number.isSafeInteger(this.#terminationGraceMs) || this.#terminationGraceMs < 0) {
      throw new RangeError("terminationGraceMs must be a non-negative safe integer");
    }
    if (
      !Number.isSafeInteger(this.#terminationConfirmationMs) ||
      this.#terminationConfirmationMs <= 0
    ) {
      throw new RangeError("terminationConfirmationMs must be a positive safe integer");
    }
  }

  async execute(
    request: ExternalHarnessRuntimeRequest,
    signal?: AbortSignal,
  ): Promise<HarnessEvaluationResult> {
    const identity = request.identity;
    if (identity.adapter === "prime-agent-native-v1") {
      throw new Error("Prime Agent requires the OCI external harness runtime");
    }
    if (this.#platform !== "linux") {
      throw new Error(`external harness runtime is not supported on ${this.#platform}`);
    }
    try {
      const deadline = this.#deadlineFactory(request.evaluation.controls.budget.maxExecutionMs);
      try {
        const operationSignal =
          signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
        const descriptor = await waitForAbortable(
          this.#registry.resolveAdmitted(identity),
          operationSignal,
        );
        const instructionPath = resolveInstructionPath(
          request.evaluation.workspace.cwd,
          request.evaluation.instruction.path,
        );
        const instructionText = await waitForAbortable(
          readInstruction(instructionPath, request.evaluation.instruction.sha256),
          operationSignal,
        );
        const preparePromise = this.#sandbox.prepare({
          executable: descriptor.launch.executable,
          args: descriptor.launch.args,
          cwd: request.evaluation.workspace.cwd,
          projectRoot: request.isolation.projectRoot,
          protectedPaths: [...new Set([...request.isolation.protectedPaths, instructionPath])],
          runtimeSupportPaths: descriptor.launch.runtimeSupportPaths,
          ...(descriptor.launch.environment === undefined
            ? {}
            : { runtimeEnvironment: descriptor.launch.environment }),
          signal: operationSignal,
        });
        let prepared: PreparedCommand;
        try {
          prepared = await waitForAbortable(preparePromise, operationSignal);
        } catch (error) {
          if (operationSignal.aborted) {
            void preparePromise
              .then((latePrepared) => latePrepared.release())
              .catch(() => undefined);
          }
          throw error;
        }
        const runtimeContractError = preparedRuntimeContractError(identity, prepared);
        if (runtimeContractError !== undefined) {
          let releaseError: unknown;
          try {
            await prepared.release();
          } catch (error) {
            releaseError = error;
          }
          throw combinedError(runtimeContractError, releaseError);
        }

        let result: HarnessEvaluationResult | undefined;
        let operationError: unknown;
        try {
          result = await this.#runPrepared(
            request,
            identity,
            descriptor,
            instructionText,
            prepared,
            deadline,
            signal,
          );
        } catch (error) {
          operationError = error;
        }
        try {
          const closePromise = this.#inferenceBroker.close?.(request.evaluation);
          if (closePromise !== undefined) {
            await waitForAbortable(closePromise, operationSignal);
          }
        } catch (error) {
          if (!deadline.expired && signal?.aborted !== true) {
            operationError =
              operationError === undefined ? error : combinedError(operationError, error);
          }
        }
        let releaseError: unknown;
        try {
          await prepared.release();
        } catch (error) {
          releaseError = error;
        }
        if (operationError !== undefined) {
          throw combinedError(operationError, releaseError);
        }
        if (releaseError !== undefined) {
          const runtime = result?.harness.runtime;
          if (runtime !== undefined) {
            return failureResult(
              "crashed",
              `sandbox cleanup failed: ${boundedReason(releaseError)}`,
              runtime,
            );
          }
          throw releaseError;
        }
        if (result === undefined) {
          throw new Error("external harness runtime did not produce a result");
        }
        return result;
      } catch (error) {
        if (deadline.expired) {
          return failureResultWithoutRuntime(
            "timed_out",
            `external harness exceeded ${request.evaluation.controls.budget.maxExecutionMs}ms`,
          );
        }
        throw error;
      } finally {
        deadline.dispose();
      }
    } catch (error) {
      if (signal?.aborted === true) {
        return failureResultWithoutRuntime("cancelled", boundedAbortReason(signal));
      }
      throw error;
    }
  }

  async #runPrepared(
    request: ExternalHarnessRuntimeRequest,
    identity: ProcessExternalHarnessIdentity,
    descriptor: ExternalHarnessDescriptor,
    instructionText: string,
    prepared: PreparedCommand,
    deadline: ExternalHarnessExecutionDeadline,
    signal?: AbortSignal,
  ): Promise<HarnessEvaluationResult> {
    if (deadline.remainingMs() <= 0) {
      throw deadline.reason;
    }
    const assertionSignal =
      signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    await waitForAbortable(descriptor.assertCurrent(), assertionSignal);
    if (prepared.beforeLaunch !== undefined) {
      await waitForAbortable(prepared.beforeLaunch(), assertionSignal);
    }
    assertOperationActive(signal);
    const remainingMs = deadline.remainingMs();
    if (remainingMs <= 0) {
      throw deadline.reason;
    }
    const child = spawn(prepared.launch.executable, [...prepared.launch.args], {
      cwd: request.evaluation.workspace.cwd,
      env: prepared.launch.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill("SIGKILL");
      throw new Error("external harness process did not provide private control pipes");
    }
    const protocolAbort = new AbortController();
    const processSignal =
      signal === undefined ? protocolAbort.signal : AbortSignal.any([signal, protocolAbort.signal]);
    const exitPromise = waitForProcessTreeExit(
      child,
      remainingMs,
      this.#terminationGraceMs,
      processSignal,
      this.#platform,
      this.#terminationConfirmationMs,
      true,
    );
    const sessionId = randomUUID();
    const secretHex = randomBytes(32).toString("hex");
    const session = new ExternalHarnessProtocolSession({
      sessionId,
      secretHex,
      trialId: request.evaluation.trial.trialId,
      identityDigest: descriptor.identityDigest,
    });
    const stderr = new BoundedText(MAX_RETAINED_EXTERNAL_HARNESS_STDERR_BYTES);
    let stderrBytes = 0;
    let stderrError: Error | undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.add(chunk);
      if (stderrError !== undefined) {
        return;
      }
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_EXTERNAL_HARNESS_STDERR_BYTES) {
        stderrError = new Error(
          `external harness standard error exceeds ${MAX_EXTERNAL_HARNESS_STDERR_BYTES} bytes`,
        );
        protocolAbort.abort(stderrError);
      }
    });
    let parentSequence = 1;
    let controlError: unknown;
    try {
      await this.#beforeHelloWrite?.(child);
      await writeParentFrame(
        child,
        signExternalHarnessParentFrame(
          {
            version: 1,
            sequence: parentSequence,
            sessionId,
            type: "hello",
            payload: {
              secretHex,
              trialId: request.evaluation.trial.trialId,
              identityDigest: descriptor.identityDigest,
              evaluation: request.evaluation,
              instructionText,
            },
          },
          secretHex,
        ),
      );
    } catch (error) {
      controlError = error;
      protocolAbort.abort(error);
    }
    let terminal:
      | Extract<
          ReturnType<ExternalHarnessProtocolSession["acceptDriverLine"]>,
          { type: "terminal" }
        >
      | undefined;
    let protocolError: unknown;
    let eventCount = 0;
    try {
      if (controlError !== undefined) {
        throw controlError;
      }
      for await (const line of boundedLines(child.stdout, MAX_EXTERNAL_HARNESS_FRAME_BYTES)) {
        const event = session.acceptDriverLine(line);
        if (event.type === "event") {
          eventCount += 1;
          if (eventCount > MAX_EXTERNAL_HARNESS_EVENTS) {
            throw new Error(`external harness exceeds ${MAX_EXTERNAL_HARNESS_EVENTS} events`);
          }
        } else if (event.type === "inference_request") {
          const inferenceSignal =
            signal === undefined
              ? AbortSignal.any([deadline.signal, protocolAbort.signal])
              : AbortSignal.any([signal, deadline.signal, protocolAbort.signal]);
          const body = await waitForAbortable(
            this.#inferenceBroker.infer(
              {
                identity,
                evaluation: request.evaluation,
                requestId: event.requestId,
                body: event.body,
              },
              inferenceSignal,
            ),
            inferenceSignal,
          );
          parentSequence += 1;
          await writeParentFrame(
            child,
            signExternalHarnessParentFrame(
              {
                version: 1,
                sequence: parentSequence,
                sessionId,
                type: "inference_response",
                payload: {
                  requestId: event.requestId,
                  body,
                  bodySha256: sha256(body),
                },
              },
              secretHex,
            ),
          );
          session.completeInference(event.requestId);
        } else if (event.type === "terminal") {
          terminal = event;
          child.stdin.end();
        }
      }
    } catch (error) {
      protocolError = error;
      protocolAbort.abort(error);
    }
    protocolError ??= stderrError;
    const exit = await exitPromise;
    const runtime = processEvidence(identity.adapter, prepared, exit, deadline.expired);
    if (exit.terminationIncomplete) {
      return failureResult(
        "crashed",
        "external harness process-tree termination could not be confirmed",
        runtime,
      );
    }
    if (controlError !== undefined) {
      return failureResult("crashed", boundedReason(controlError), runtime);
    }
    if (deadline.expired || exit.timedOut) {
      return failureResult(
        "timed_out",
        `external harness exceeded ${request.evaluation.controls.budget.maxExecutionMs}ms`,
        runtime,
      );
    }
    if (signal?.aborted === true) {
      return failureResult("cancelled", boundedAbortReason(signal), runtime);
    }
    if (protocolError !== undefined) {
      return failureResult("malformed_output", boundedReason(protocolError), runtime);
    }
    if (exit.aborted) {
      return failureResult("crashed", "external harness process was aborted", runtime);
    }
    if (exit.spawnError !== null) {
      return failureResult("crashed", boundedReason(exit.spawnError), runtime);
    }
    if (exit.signal !== null) {
      return failureResult("crashed", `external harness received ${exit.signal}`, runtime);
    }
    if (exit.exitCode !== 0) {
      const diagnostic = stderr.text();
      return failureResult(
        "crashed",
        `external harness exited with code ${String(exit.exitCode)}${diagnostic === "" ? "" : `: ${diagnostic}`}`,
        runtime,
      );
    }
    if (terminal === undefined) {
      return failureResult(
        "missing_output",
        "external harness exited without a terminal frame",
        runtime,
      );
    }
    return Object.freeze({
      harness: parseEvaluationHarnessOutcome({ ...terminal.harness, runtime }),
      metrics: terminal.metrics,
    });
  }
}

function preparedRuntimeContractError(
  identity: ProcessExternalHarnessIdentity,
  prepared: PreparedCommand,
): Error | undefined {
  const mismatches: string[] = [];
  if (prepared.processContainment !== identity.runtime.containment) {
    mismatches.push("PID namespace containment");
  }
  if (prepared.evidence.backend !== "anthropic-sandbox-runtime") {
    mismatches.push("backend");
  }
  if (prepared.evidence.backendVersion !== identity.runtime.version) {
    mismatches.push("backend version");
  }
  if (prepared.evidence.profile !== "workspace-write-network-deny-v1") {
    mismatches.push("profile");
  }
  if (prepared.evidence.policyDigest !== identity.runtime.policyDigest) {
    mismatches.push("policy digest");
  }
  return mismatches.length === 0
    ? undefined
    : new Error(
        `external harness sandbox evidence does not match the admitted runtime policy: ${mismatches.join(", ")}`,
      );
}

function processEvidence(
  adapter: ProcessExternalHarnessIdentity["adapter"],
  prepared: PreparedCommand,
  exit: ProcessTreeExitResult,
  deadlineExpired: boolean,
): NonNullable<ReturnType<typeof parseEvaluationHarnessOutcome>["runtime"]> {
  return Object.freeze({
    adapter,
    containment: prepared.processContainment,
    exitCode: exit.exitCode,
    signal: exit.signal,
    timedOut: deadlineExpired || exit.timedOut,
    aborted: deadlineExpired ? false : exit.aborted,
    treeTermination: exit.terminationIncomplete ? "unconfirmed" : "confirmed",
  });
}

function failureResult(
  outcome: "timed_out" | "crashed" | "cancelled" | "malformed_output" | "missing_output",
  reason: string,
  runtime: NonNullable<ReturnType<typeof parseEvaluationHarnessOutcome>["runtime"]>,
): HarnessEvaluationResult {
  return Object.freeze({
    harness: parseEvaluationHarnessOutcome({
      outcome,
      runId: null,
      reason: reason.slice(0, 4_096),
      runtime,
    }),
    metrics: unavailableEvaluationMetrics(),
  });
}

function failureResultWithoutRuntime(
  outcome: "timed_out" | "cancelled",
  reason: string,
): HarnessEvaluationResult {
  return Object.freeze({
    harness: parseEvaluationHarnessOutcome({ outcome, runId: null, reason }),
    metrics: unavailableEvaluationMetrics(),
  });
}

async function writeParentFrame(child: ChildProcess, frame: object): Promise<void> {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
    throw new Error(`parent frame exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
  }
  const stdin = child.stdin;
  if (stdin === null || stdin.destroyed) {
    throw new Error("external harness control input is closed");
  }
  await new Promise<void>((resolvePromise, reject) => {
    stdin.write(`${line}\n`, (error) => {
      if (error === null || error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
  });
}

async function* boundedLines(
  stream: NonNullable<ChildProcess["stdout"]>,
  maxBytes: number,
): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    pending = Buffer.concat([pending, chunk], pending.length + chunk.length);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) {
        if (pending.length > maxBytes) {
          throw new Error(`driver frame exceeds ${maxBytes} bytes`);
        }
        break;
      }
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length === 0 || line.length > maxBytes) {
        throw new Error(`driver frame must contain 1 to ${maxBytes} bytes`);
      }
      yield decodeUtf8(line);
    }
  }
  if (pending.length > 0) {
    if (pending.length > maxBytes) {
      throw new Error(`driver frame exceeds ${maxBytes} bytes`);
    }
    yield decodeUtf8(pending);
  }
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new Error("external harness driver frame is not valid UTF-8", { cause: error });
  }
}

async function readInstruction(path: string, expectedSha256: string): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error("evaluation instruction cannot be opened without following links", {
      cause: error,
    });
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error("evaluation instruction is not a regular file");
    }
    if (before.size > MAX_EVALUATION_INSTRUCTION_BYTES) {
      throw new Error(`evaluation instruction exceeds ${MAX_EVALUATION_INSTRUCTION_BYTES} bytes`);
    }
    const content = await readBounded(handle, MAX_EVALUATION_INSTRUCTION_BYTES);
    const after = await handle.stat();
    if (content.byteLength !== before.size || !sameFileIdentity(before, after)) {
      throw new Error("evaluation instruction changed while Flow read it");
    }
    if (sha256(content) !== expectedSha256) {
      throw new Error("evaluation instruction digest does not match admission");
    }
    return decodeUtf8(content);
  } finally {
    await handle.close();
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    total += bytesRead;
    if (total > maxBytes) {
      throw new Error(`evaluation instruction exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
}

function resolveInstructionPath(workspace: string, instructionPath: string): string {
  if (isAbsolute(instructionPath)) {
    throw new Error("evaluation instruction path must be relative to the workspace");
  }
  const path = join(workspace, instructionPath);
  const fromWorkspace = relative(workspace, path);
  if (fromWorkspace === "" || fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`)) {
    throw new Error("evaluation instruction path escapes the workspace");
  }
  return path;
}

function sameFileIdentity(before: Awaited<ReturnType<FileHandle["stat"]>>, after: typeof before) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedAbortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  return boundedReason(reason ?? "external harness was cancelled");
}

function assertOperationActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error(boundedAbortReason(signal));
  }
}

function boundedReason(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
  } catch {
    return "unprintable external harness error";
  }
}

function combinedError(primary: unknown, secondary: unknown): Error {
  if (secondary === undefined) {
    return primary instanceof Error ? primary : new Error(boundedReason(primary));
  }
  return new Error(
    `${boundedReason(primary)}; sandbox cleanup also failed: ${boundedReason(secondary)}`,
    { cause: primary },
  );
}

class ExecutionDeadline {
  readonly #controller = new AbortController();
  readonly #startedAt = Date.now();
  readonly #timer: NodeJS.Timeout;
  readonly reason: Error;

  constructor(readonly maxMs: number) {
    this.reason = new Error(`external harness exceeded ${maxMs}ms`);
    this.#timer = setTimeout(() => this.#controller.abort(this.reason), maxMs);
    this.#timer.unref();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get expired(): boolean {
    return this.signal.aborted;
  }

  remainingMs(): number {
    return Math.max(0, this.maxMs - (Date.now() - this.#startedAt));
  }

  dispose(): void {
    clearTimeout(this.#timer);
  }
}

async function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(boundedReason(signal.reason ?? "external harness operation was aborted"));
}

class BoundedText {
  readonly #chunks: Buffer[] = [];
  #captured = 0;

  constructor(readonly maxBytes: number) {}

  add(chunk: Buffer): void {
    const remaining = this.maxBytes - this.#captured;
    if (remaining <= 0) {
      return;
    }
    const retained = chunk.subarray(0, remaining);
    this.#chunks.push(retained);
    this.#captured += retained.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}
