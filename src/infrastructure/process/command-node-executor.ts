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
  readonly platform?: NodeJS.Platform;
  readonly terminationGraceMs?: number;
}

export class CommandNodeExecutor implements CommandExecutor {
  readonly #maxOutputBytes: number;
  readonly #platform: NodeJS.Platform;
  readonly #terminationGraceMs: number;

  constructor(options: CommandNodeExecutorOptions = {}) {
    this.#maxOutputBytes = options.maxOutputBytes ?? 32_768;
    this.#platform = options.platform ?? process.platform;
    this.#terminationGraceMs = options.terminationGraceMs ?? 2_000;
    if (
      !Number.isSafeInteger(this.#maxOutputBytes) ||
      this.#maxOutputBytes <= 0 ||
      this.#maxOutputBytes > 32_768
    ) {
      throw new RangeError("maxOutputBytes must be between 1 and 32768");
    }
    if (!Number.isSafeInteger(this.#terminationGraceMs) || this.#terminationGraceMs < 0) {
      throw new RangeError("terminationGraceMs must be a non-negative safe integer");
    }
  }

  async execute(
    node: CompiledCommandNode,
    context: NodeExecutionContext,
  ): Promise<NodeExecutionOutcome> {
    if (this.#platform === "win32") {
      return platformFailure();
    }

    const startedAt = process.hrtime.bigint();
    const stdout = new BoundedOutput(this.#maxOutputBytes);
    const stderr = new BoundedOutput(this.#maxOutputBytes);
    let child: ChildProcess;

    try {
      child = spawn(node.command.executable, [...node.command.args], {
        cwd: context.cwd,
        env: process.env,
        shell: false,
        detached: true,
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
      this.#platform,
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
  platform: NodeJS.Platform = process.platform,
): Promise<ExitResult> {
  return new Promise((resolve) => {
    let settled = false;
    let terminationCause: "abort" | "timeout" | null = null;
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
      if (settled || terminationCause !== null) {
        return;
      }
      terminationCause = reason;
      clearTimeout(timeoutTimer);
      terminate(child, "SIGTERM", platform);
      killTimer = setTimeout(() => terminate(child, "SIGKILL", platform), terminationGraceMs);
      killTimer.unref();
    }

    const abortHandler = () => beginTermination("abort");
    const timeoutTimer = setTimeout(() => beginTermination("timeout"), timeoutMs);
    timeoutTimer.unref();

    child.once("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut: terminationCause === "timeout",
        aborted: terminationCause === "abort",
        spawnError: error,
      });
    });
    child.once("close", (exitCode, exitSignal) => {
      finish({
        exitCode,
        signal: exitSignal,
        timedOut: terminationCause === "timeout",
        aborted: terminationCause === "abort",
        spawnError: null,
      });
    });
    signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted === true) {
      beginTermination("abort");
    }
  });
}

function terminate(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  try {
    if (platform === "win32") {
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

function platformFailure(): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code: "command_platform_unsupported",
      message:
        "command nodes are not supported on Windows until descendant process containment is available",
      retryable: false,
      sideEffectStatus: "none",
    },
    evidence: null,
  };
}

function spawnFailure(error: unknown): NodeExecutionOutcome {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message =
    rawMessage.length <= 16_384 ? rawMessage : `${rawMessage.slice(0, 16_350)}… [truncated]`;
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
    return decodeBoundedUtf8(Buffer.concat(this.#chunks), this.maxBytes);
  }

  digest(): string {
    this.#digest ??= this.#hash.digest("hex");
    return this.#digest;
  }
}

function decodeBoundedUtf8(buffer: Buffer, maxBytes: number): string {
  let end = buffer.length;
  while (end > 0) {
    const text = buffer.subarray(0, end).toString("utf8");
    if (Buffer.byteLength(text, "utf8") <= maxBytes) {
      return text;
    }
    end -= 1;
  }
  return "";
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
