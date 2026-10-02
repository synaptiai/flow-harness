import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

import {
  isPinnedGitHubIssueHostExecutableCurrent,
  type PinnedGitHubIssueHostExecutable,
} from "./fixed-host-executables.js";

export const MAX_STRICT_HOST_PROCESS_TIMEOUT_MS = 300_000;
export const MAX_STRICT_HOST_PROCESS_OUTPUT_BYTES = 1_048_576;

const MAX_EXECUTABLE_PATH_BYTES = 4_095;
const MAX_WORKING_DIRECTORY_BYTES = 4_095;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 16_384;
const MAX_ARGUMENT_VECTOR_BYTES = 131_072;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_ENTRY_BYTES = 65_536;
const MAX_ENVIRONMENT_BYTES = 131_072;
const MAX_STDIN_BYTES = 1_048_576;

export type StrictHostProcessTermination =
  | "exit"
  | "signal"
  | "timeout"
  | "abort"
  | "output_limit"
  | "launch_error";

export interface StrictHostProcessOptions {
  readonly executable: PinnedGitHubIssueHostExecutable;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface StrictHostProcessRequest {
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly stdin?: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface StrictHostProcessResult {
  readonly termination: StrictHostProcessTermination;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

/** Runs one preconfigured host executable without a shell or ambient environment inheritance. */
export class StrictHostProcess {
  readonly #environment: Readonly<Record<string, string>>;
  readonly #executable: PinnedGitHubIssueHostExecutable;
  readonly #maxStderrBytes: number;
  readonly #maxStdoutBytes: number;
  readonly #timeoutMs: number;

  constructor(options: StrictHostProcessOptions) {
    assertAbsoluteBoundedPath(options.executable.path, "executable");
    assertEnvironment(options.environment);
    assertBoundedPositiveInteger(options.timeoutMs, MAX_STRICT_HOST_PROCESS_TIMEOUT_MS, "timeout");
    assertBoundedPositiveInteger(
      options.maxStdoutBytes,
      MAX_STRICT_HOST_PROCESS_OUTPUT_BYTES,
      "standard output",
    );
    assertBoundedPositiveInteger(
      options.maxStderrBytes,
      MAX_STRICT_HOST_PROCESS_OUTPUT_BYTES,
      "standard error output",
    );
    this.#executable = options.executable;
    this.#environment = Object.freeze({ ...options.environment });
    this.#timeoutMs = options.timeoutMs;
    this.#maxStdoutBytes = options.maxStdoutBytes;
    this.#maxStderrBytes = options.maxStderrBytes;
  }

  run(request: StrictHostProcessRequest): Promise<StrictHostProcessResult> {
    assertRequest(request);
    if (request.signal?.aborted === true) {
      return Promise.resolve(emptyResult("abort"));
    }
    return this.#run(request);
  }

  async #run(request: StrictHostProcessRequest): Promise<StrictHostProcessResult> {
    const startedAt = performance.now();
    const deadline = startedAt + this.#timeoutMs;
    const admission = await admitExecutableWithinDeadline(
      this.#executable,
      this.#timeoutMs,
      request.signal,
    );
    if (admission !== "admitted") {
      return emptyResult(
        admission === "unavailable" ? "launch_error" : admission,
        elapsedMilliseconds(startedAt),
      );
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#executable.path, [...request.arguments], {
        cwd: request.cwd,
        detached: process.platform !== "win32",
        env: this.#environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return emptyResult("launch_error", elapsedMilliseconds(startedAt));
    }

    return await new Promise<StrictHostProcessResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let terminalCause: Exclude<StrictHostProcessTermination, "exit" | "signal"> | null = null;
      let settled = false;

      const stop = (cause: typeof terminalCause): void => {
        if (terminalCause !== null || settled || cause === null) return;
        terminalCause = cause;
        killProcessTree(child);
      };
      const remainingMs = deadline - performance.now();
      const timeout = setTimeout(() => stop("timeout"), Math.max(0, remainingMs));
      timeout.unref();
      const abort = (): void => stop("abort");
      request.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (raw: Buffer | string) => {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const remaining = this.#maxStdoutBytes - stdoutBytes;
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining);
          stdoutChunks.push(Buffer.from(retained));
          stdoutBytes += retained.byteLength;
        }
        if (chunk.byteLength > remaining) {
          stdoutTruncated = true;
          stop("output_limit");
        }
      });
      child.stderr.on("data", (raw: Buffer | string) => {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const remaining = this.#maxStderrBytes - stderrBytes;
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining);
          stderrChunks.push(Buffer.from(retained));
          stderrBytes += retained.byteLength;
        }
        if (chunk.byteLength > remaining) {
          stderrTruncated = true;
          stop("output_limit");
        }
      });
      child.once("error", () => {
        terminalCause ??= "launch_error";
      });
      child.once("close", (exitCode, exitSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abort);
        const termination =
          terminalCause ?? (exitSignal === null ? ("exit" as const) : ("signal" as const));
        resolve(
          Object.freeze({
            termination,
            exitCode: termination === "exit" ? exitCode : null,
            signal: exitSignal,
            stdout: Buffer.concat(stdoutChunks, stdoutBytes),
            stderr: Buffer.concat(stderrChunks, stderrBytes),
            stdoutTruncated,
            stderrTruncated,
            durationMs: elapsedMilliseconds(startedAt),
          }),
        );
      });

      child.stdin.on("error", () => {
        // The process outcome remains authoritative when it closes input before consuming it.
      });
      child.stdin.end(request.stdin === undefined ? undefined : Buffer.from(request.stdin));
      if (request.signal?.aborted === true) abort();
      if (performance.now() >= deadline) stop("timeout");
    });
  }
}

type ExecutableAdmission = "admitted" | "unavailable" | "timeout" | "abort";

function admitExecutableWithinDeadline(
  executable: PinnedGitHubIssueHostExecutable,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ExecutableAdmission> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ExecutableAdmission): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const timeout = setTimeout(() => finish("timeout"), timeoutMs);
    const abort = (): void => finish("abort");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
      return;
    }
    void isPinnedGitHubIssueHostExecutableCurrent(executable).then(
      (current) => finish(current ? "admitted" : "unavailable"),
      () => finish("unavailable"),
    );
  });
}

function assertRequest(request: StrictHostProcessRequest): void {
  assertAbsoluteBoundedPath(request.cwd, "working directory");
  if (
    request.arguments.length > MAX_ARGUMENTS ||
    request.arguments.some(
      (argument) =>
        argument.includes("\0") || Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES,
    ) ||
    request.arguments.reduce((total, argument) => total + Buffer.byteLength(argument, "utf8"), 0) >
      MAX_ARGUMENT_VECTOR_BYTES
  ) {
    throw new TypeError("Strict host process argument vector is invalid");
  }
  if (request.stdin !== undefined && request.stdin.byteLength > MAX_STDIN_BYTES) {
    throw new TypeError("Strict host process input exceeds its byte limit");
  }
}

function assertAbsoluteBoundedPath(value: string, label: string): void {
  const maximum = label === "executable" ? MAX_EXECUTABLE_PATH_BYTES : MAX_WORKING_DIRECTORY_BYTES;
  if (!isAbsolute(value) || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) {
    throw new TypeError(`Strict host process ${label} must be an absolute bounded path`);
  }
}

function assertEnvironment(environment: Readonly<Record<string, string>>): void {
  const entries = Object.entries(environment);
  if (
    entries.length > MAX_ENVIRONMENT_ENTRIES ||
    entries.some(
      ([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        value.includes("\0") ||
        Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") >
          MAX_ENVIRONMENT_ENTRY_BYTES,
    ) ||
    entries.reduce(
      (total, [name, value]) =>
        total + Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8"),
      0,
    ) > MAX_ENVIRONMENT_BYTES
  ) {
    throw new TypeError("Strict host process environment is invalid");
  }
}

function assertBoundedPositiveInteger(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`Strict host process ${label} limit is invalid`);
  }
}

function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // The process group can disappear between observation and termination.
    }
  }
  child.kill("SIGKILL");
}

function emptyResult(
  termination: "abort" | "launch_error" | "timeout",
  durationMs = 0,
): StrictHostProcessResult {
  return Object.freeze({
    termination,
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs,
  });
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.ceil(performance.now() - startedAt));
}
