import { spawn, type ChildProcess } from "node:child_process";
import { createHash, type Hash } from "node:crypto";

import type {
  CommandExecutor,
  NodeExecutionContext,
  NodeExecutionOutcome,
} from "../../application/ports.js";
import type { CommandEvidence, NodeFailure } from "../../domain/run/events.js";
import type { CompiledCommandNode } from "../../domain/workflow/types.js";

export interface CommandNodeExecutorOptions {
  readonly maxOutputBytes?: number;
  readonly terminationGraceMs?: number;
}

export class CommandNodeExecutor implements CommandExecutor {
  readonly #maxOutputBytes: number;
  readonly #terminationGraceMs: number;

  constructor(options: CommandNodeExecutorOptions = {}) {
    this.#maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
    this.#terminationGraceMs = options.terminationGraceMs ?? 2_000;
    if (!Number.isSafeInteger(this.#maxOutputBytes) || this.#maxOutputBytes <= 0) {
      throw new RangeError("maxOutputBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#terminationGraceMs) || this.#terminationGraceMs < 0) {
      throw new RangeError("terminationGraceMs must be a non-negative safe integer");
    }
  }

  async execute(
    node: CompiledCommandNode,
    context: NodeExecutionContext,
  ): Promise<NodeExecutionOutcome> {
    const startedAt = process.hrtime.bigint();
    const stdout = new BoundedOutput(this.#maxOutputBytes);
    const stderr = new BoundedOutput(this.#maxOutputBytes);
    let child: ChildProcess;

    try {
      child = spawn(node.command.executable, [...node.command.args], {
        cwd: context.cwd,
        env: process.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return spawnFailure(error);
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));

    const result = await waitForExit(
      child,
      node.command.timeoutMs,
      this.#terminationGraceMs,
      context.signal,
    );
    if (result.spawnError !== null) {
      return spawnFailure(result.spawnError);
    }

    const evidence: CommandEvidence = {
      kind: "command",
      executable: node.command.executable,
      args: Object.freeze([...node.command.args]),
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutHash: stdout.digest(),
      stderrHash: stderr.digest(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut: result.timedOut,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    };

    if (result.timedOut) {
      return failed(
        "command_timeout",
        `command exceeded timeout of ${node.command.timeoutMs}ms`,
        evidence,
      );
    }
    if (result.aborted) {
      return failed("command_aborted", "command was cancelled", evidence);
    }
    if (result.signal !== null) {
      return failed("command_signaled", `command terminated by signal ${result.signal}`, evidence);
    }
    if (result.exitCode !== 0) {
      return failed("command_failed", `command exited with code ${result.exitCode}`, evidence);
    }

    return { status: "succeeded", evidence };
  }
}

interface ExitResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError: Error | null;
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  terminationGraceMs: number,
  signal?: AbortSignal,
): Promise<ExitResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = signal?.aborted ?? false;
    let killTimer: NodeJS.Timeout | undefined;

    function finish(result: ExitResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      signal?.removeEventListener("abort", abortHandler);
      resolve(result);
    }

    function beginTermination(reason: "abort" | "timeout"): void {
      if (settled) {
        return;
      }
      if (reason === "timeout") {
        timedOut = true;
      } else {
        aborted = true;
      }
      terminate(child, "SIGTERM");
      killTimer = setTimeout(() => terminate(child, "SIGKILL"), terminationGraceMs);
      killTimer.unref();
    }

    const abortHandler = () => beginTermination("abort");
    const timeoutTimer = setTimeout(() => beginTermination("timeout"), timeoutMs);
    timeoutTimer.unref();

    child.once("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        aborted,
        spawnError: error,
      });
    });
    child.once("close", (exitCode, exitSignal) => {
      finish({
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        spawnError: null,
      });
    });
    signal?.addEventListener("abort", abortHandler, { once: true });
    if (aborted) {
      beginTermination("abort");
    }
  });
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      child.kill(signal);
    }
  }
}

function spawnFailure(error: unknown): NodeExecutionOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const failure: NodeFailure = {
    code: "command_spawn_failed",
    message,
    retryable: false,
    sideEffectStatus: "none",
  };
  return { status: "failed", error: failure, evidence: null };
}

function failed(code: string, message: string, evidence: CommandEvidence): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code,
      message,
      retryable: false,
      sideEffectStatus: "uncertain",
    },
    evidence,
  };
}

class BoundedOutput {
  readonly #hash: Hash = createHash("sha256");
  readonly #chunks: Buffer[] = [];
  #capturedBytes = 0;
  #totalBytes = 0;
  #digest: string | undefined;

  constructor(readonly maxBytes: number) {}

  get truncated(): boolean {
    return this.#totalBytes > this.maxBytes;
  }

  add(chunk: Buffer): void {
    this.#hash.update(chunk);
    this.#totalBytes += chunk.length;
    const remaining = this.maxBytes - this.#capturedBytes;
    if (remaining <= 0) {
      return;
    }
    const captured = chunk.subarray(0, remaining);
    this.#chunks.push(captured);
    this.#capturedBytes += captured.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }

  digest(): string {
    this.#digest ??= this.#hash.digest("hex");
    return this.#digest;
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
