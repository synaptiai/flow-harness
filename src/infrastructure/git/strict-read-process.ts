import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

import {
  isPinnedGitHubIssueHostExecutableCurrent,
  type PinnedGitHubIssueHostExecutable,
} from "./fixed-host-executables.js";

export type StrictReadProcessErrorCode =
  | "executable_unavailable"
  | "command_failed"
  | "command_timed_out"
  | "command_output_limit_exceeded"
  | "command_response_invalid"
  | "operation_aborted";

export class StrictReadProcessError extends Error {
  override readonly name = "StrictReadProcessError";

  constructor(readonly code: StrictReadProcessErrorCode) {
    super(`Strict read process failed: ${code}`);
  }
}

export interface StrictReadProcessRequest {
  readonly executable: string | PinnedGitHubIssueHostExecutable;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal?: AbortSignal;
}

export async function runStrictReadProcess(request: StrictReadProcessRequest): Promise<string> {
  validateRequest(request);
  if (isSignalAborted(request.signal)) {
    throw new StrictReadProcessError("operation_aborted");
  }
  const executable = executablePath(request.executable);
  if (
    typeof request.executable !== "string" &&
    !(await isPinnedGitHubIssueHostExecutableCurrent(request.executable))
  ) {
    throw new StrictReadProcessError("executable_unavailable");
  }
  if (isSignalAborted(request.signal)) {
    throw new StrictReadProcessError("operation_aborted");
  }

  return await new Promise<string>((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...request.arguments], {
        cwd: request.cwd,
        detached: useProcessGroup,
        env: request.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(new StrictReadProcessError("command_failed"));
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminalError: StrictReadProcessError | undefined;

    const stop = (error: StrictReadProcessError): void => {
      terminalError ??= error;
      if (useProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall back to the direct child when its process group is already unavailable.
        }
      }
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(
      () => stop(new StrictReadProcessError("command_timed_out")),
      request.timeoutMs,
    );
    timeout.unref();
    const abort = (): void => stop(new StrictReadProcessError("operation_aborted"));
    request.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > request.maxStdoutBytes) {
        stop(new StrictReadProcessError("command_output_limit_exceeded"));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > request.maxStderrBytes) {
        stop(new StrictReadProcessError("command_output_limit_exceeded"));
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      terminalError = new StrictReadProcessError(
        error.code === "ENOENT" || error.code === "EACCES"
          ? "executable_unavailable"
          : "command_failed",
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      if (terminalError !== undefined) {
        reject(terminalError);
        return;
      }
      if (code !== 0) {
        reject(new StrictReadProcessError("command_failed"));
        return;
      }
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)));
      } catch {
        reject(new StrictReadProcessError("command_response_invalid"));
      }
    });

    child.stdin.once("error", () => {
      stop(new StrictReadProcessError("command_failed"));
    });
    child.stdin.end(request.stdin ?? "");
  });
}

function validateRequest(request: StrictReadProcessRequest): void {
  const executable = executablePath(request.executable);
  if (
    !isAbsolute(executable) ||
    executable.includes("\0") ||
    Buffer.byteLength(executable, "utf8") > 4_095 ||
    !isAbsolute(request.cwd) ||
    request.cwd.includes("\0") ||
    Buffer.byteLength(request.cwd, "utf8") > 4_095 ||
    request.arguments.length > 64 ||
    request.arguments.some(
      (argument) => argument.includes("\0") || Buffer.byteLength(argument, "utf8") > 4_095,
    ) ||
    request.arguments.reduce((bytes, argument) => bytes + Buffer.byteLength(argument, "utf8"), 0) >
      65_536 ||
    !isBoundedEnvironment(request.environment) ||
    (request.stdin !== undefined && Buffer.byteLength(request.stdin, "utf8") > 16_384) ||
    !isBound(request.timeoutMs, 30_000) ||
    !isBound(request.maxStdoutBytes, 1_048_576) ||
    !isBound(request.maxStderrBytes, 1_048_576)
  ) {
    throw new StrictReadProcessError("command_failed");
  }
}

function executablePath(executable: StrictReadProcessRequest["executable"]): string {
  return typeof executable === "string" ? executable : executable.path;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isBoundedEnvironment(environment: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(environment);
  return (
    entries.length <= 64 &&
    entries.every(
      ([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        !value.includes("\0") &&
        Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") <= 65_536,
    ) &&
    entries.reduce(
      (bytes, [name, value]) =>
        bytes + Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8"),
      0,
    ) <= 131_072
  );
}

function isBound(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}
