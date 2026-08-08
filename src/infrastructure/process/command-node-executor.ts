import { type ChildProcess, spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import type { CommandSandbox, PreparedCommand } from "../../application/command-sandbox.js";
import type {
  AgentCommandExecutor,
  CommandExecutor,
  NodeExecutionContext,
  NodeExecutionOutcome,
} from "../../application/ports.js";
import type { AgentCommandRequest } from "../../domain/agent-command.js";
import type {
  AgentCommandEvidence,
  AgentCommandSettlementOutcome,
  CommandEvidence,
  NodeFailure,
} from "../../domain/run/events.js";
import type { CompiledCommandNode } from "../../domain/workflow/types.js";

export interface CommandNodeExecutorOptions {
  readonly sandbox: CommandSandbox;
  readonly maxOutputBytes?: number;
  readonly platform?: NodeJS.Platform;
  readonly terminationGraceMs?: number;
  readonly terminationConfirmationMs?: number;
}

export class CommandNodeExecutor implements CommandExecutor, AgentCommandExecutor {
  readonly #maxOutputBytes: number;
  readonly #platform: NodeJS.Platform;
  readonly #sandbox: CommandSandbox;
  readonly #terminationConfirmationMs: number;
  readonly #terminationGraceMs: number;

  constructor(options: CommandNodeExecutorOptions) {
    this.#maxOutputBytes = options.maxOutputBytes ?? 32_768;
    this.#platform = options.platform ?? process.platform;
    this.#sandbox = options.sandbox;
    this.#terminationConfirmationMs = options.terminationConfirmationMs ?? 2_000;
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
    if (
      !Number.isSafeInteger(this.#terminationConfirmationMs) ||
      this.#terminationConfirmationMs <= 0
    ) {
      throw new RangeError("terminationConfirmationMs must be a positive safe integer");
    }
  }

  async execute(
    node: CompiledCommandNode,
    context: NodeExecutionContext,
  ): Promise<NodeExecutionOutcome> {
    return this.#execute(node, context, false);
  }

  async #execute(
    node: CompiledCommandNode,
    context: NodeExecutionContext,
    requireKernelContainment: boolean,
  ): Promise<NodeExecutionOutcome> {
    if (this.#platform === "win32") {
      return platformFailure();
    }

    const startedAt = process.hrtime.bigint();
    const deadline = commandDeadline(node.command.timeoutMs, context.signal);
    const preparation = this.#sandbox.prepare({
      executable: node.command.executable,
      args: node.command.args,
      cwd: context.cwd,
      protectedPaths: context.protectedPaths,
      signal: deadline.signal,
    });
    const preparationResult = await Promise.race([
      preparation.then(
        (prepared) => ({ status: "prepared" as const, prepared }),
        (error: unknown) => ({ status: "failed" as const, error }),
      ),
      deadline.interruption.then((cause) => ({ status: "interrupted" as const, cause })),
    ]);
    if (preparationResult.status === "interrupted") {
      deadline.dispose();
      releaseLatePreparation(preparation);
      return preLaunchInterruption(preparationResult.cause, node.command.timeoutMs);
    }
    if (preparationResult.status === "failed") {
      deadline.dispose();
      const preparationFailureCause = deadline.cause ?? (deadline.expired() ? "timeout" : null);
      if (preparationFailureCause !== null) {
        return preLaunchInterruption(preparationFailureCause, node.command.timeoutMs);
      }
      return sandboxFailure(preparationResult.error);
    }
    const prepared = preparationResult.prepared;

    const preparationCause = deadline.cause ?? (deadline.expired() ? "timeout" : null);
    if (preparationCause !== null) {
      deadline.dispose();
      releaseLatePreparation(Promise.resolve(prepared));
      return preLaunchInterruption(preparationCause, node.command.timeoutMs);
    }

    if (requireKernelContainment && prepared.processContainment !== "linux-pid-namespace") {
      deadline.dispose();
      const cleanupError = await release(prepared);
      if (cleanupError !== null) {
        return sandboxCleanupFailure(cleanupError, null, "none");
      }
      return insufficientContainmentFailure();
    }

    const stdout = new BoundedOutput(this.#maxOutputBytes);
    const stderr = new BoundedOutput(this.#maxOutputBytes);
    let child: ChildProcess;

    if (deadline.expired()) {
      deadline.dispose();
      const cleanupError = await release(prepared);
      if (cleanupError !== null) {
        return sandboxCleanupFailure(cleanupError, null, "none");
      }
      return preLaunchInterruption("timeout", node.command.timeoutMs);
    }

    try {
      child = spawn(prepared.launch.executable, [...prepared.launch.args], {
        cwd: context.cwd,
        env: prepared.launch.env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      deadline.dispose();
      const cleanupError = await release(prepared);
      if (cleanupError !== null) {
        return sandboxCleanupFailure(cleanupError, null, "none");
      }
      return spawnFailure(error);
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));

    const remainingTimeoutMs = deadline.remainingMs();
    deadline.dispose();
    const result = await waitForExit(
      child,
      remainingTimeoutMs,
      this.#terminationGraceMs,
      context.signal,
      this.#platform,
      this.#terminationConfirmationMs,
    );
    if (result.spawnError !== null) {
      const cleanupError = await release(prepared);
      if (cleanupError !== null) {
        return sandboxCleanupFailure(cleanupError, null, "none");
      }
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
      aborted: result.aborted,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      terminationStatus: result.terminationIncomplete
        ? "unconfirmed"
        : result.timedOut || result.aborted
          ? "confirmed"
          : "not-required",
      sandbox: prepared.evidence,
    };

    const cleanupError = await release(prepared);
    if (result.terminationIncomplete) {
      return failed(
        "command_termination_failed",
        cleanupError === null
          ? "command process group termination could not be confirmed"
          : `command process group termination could not be confirmed; sandbox cleanup also failed: ${boundedMessage(cleanupError)}`,
        evidence,
      );
    }
    if (cleanupError !== null) {
      return sandboxCleanupFailure(cleanupError, evidence, "uncertain");
    }
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

  async executeAgentCommand(
    command: AgentCommandRequest,
    context: NodeExecutionContext,
  ): Promise<AgentCommandSettlementOutcome> {
    const outcome = await this.#execute(
      {
        id: "agent-command",
        type: "command",
        dependsOn: [],
        command: {
          executable: command.executable,
          args: command.args,
          timeoutMs: command.timeoutMs,
        },
      },
      context,
      true,
    );
    const commandEvidence = outcome.evidence;
    if (commandEvidence !== null && commandEvidence.kind !== "command") {
      throw new TypeError("command executor returned non-command evidence");
    }
    const evidence = commandEvidence === null ? null : toAgentCommandEvidence(commandEvidence);
    if (outcome.status === "succeeded") {
      if (evidence === null) {
        throw new TypeError("successful command executor outcome is missing evidence");
      }
      return { status: "succeeded", evidence };
    }
    return { status: "failed", error: outcome.error, evidence };
  }
}

function toAgentCommandEvidence(evidence: CommandEvidence): AgentCommandEvidence {
  if (evidence.sandbox === undefined) {
    throw new TypeError("agent command evidence is missing sandbox provenance");
  }
  return {
    ...evidence,
    stdoutRetainedHash: hashText(evidence.stdout),
    stderrRetainedHash: hashText(evidence.stderr),
    stdoutRetainedBytes: Buffer.byteLength(evidence.stdout, "utf8"),
    stderrRetainedBytes: Buffer.byteLength(evidence.stderr, "utf8"),
    processContainment: "linux-pid-namespace",
    aborted: evidence.aborted ?? false,
    terminationStatus: requiredTerminationStatus(evidence),
    sandbox: evidence.sandbox,
  };
}

function requiredTerminationStatus(
  evidence: CommandEvidence,
): AgentCommandEvidence["terminationStatus"] {
  if (evidence.terminationStatus === undefined) {
    throw new TypeError("agent command evidence is missing termination status");
  }
  return evidence.terminationStatus;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface CommandDeadline {
  readonly signal: AbortSignal;
  readonly cause: "abort" | "timeout" | null;
  readonly interruption: Promise<"abort" | "timeout">;
  expired(): boolean;
  remainingMs(): number;
  dispose(): void;
}

function commandDeadline(timeoutMs: number, signal?: AbortSignal): CommandDeadline {
  const expiresAt = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  const controller = new AbortController();
  let cause: "abort" | "timeout" | null = null;
  let resolveInterruption: (cause: "abort" | "timeout") => void = () => undefined;
  const interruption = new Promise<"abort" | "timeout">((resolve) => {
    resolveInterruption = resolve;
  });
  const trigger = (nextCause: "abort" | "timeout") => {
    if (cause !== null) {
      return;
    }
    cause = nextCause;
    controller.abort(nextCause);
    resolveInterruption(nextCause);
  };
  const abortHandler = () => trigger("abort");
  const timer = setTimeout(() => trigger("timeout"), timeoutMs);
  timer.unref();
  signal?.addEventListener("abort", abortHandler, { once: true });
  if (signal?.aborted === true) {
    trigger("abort");
  }
  return {
    signal: controller.signal,
    interruption,
    expired: () => process.hrtime.bigint() >= expiresAt,
    remainingMs: () => Math.max(0, Number(expiresAt - process.hrtime.bigint()) / 1_000_000),
    get cause() {
      return cause;
    },
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
    },
  };
}

function releaseLatePreparation(preparation: Promise<PreparedCommand>): void {
  void preparation
    .then(async (prepared) => {
      await release(prepared);
    })
    .catch(() => undefined);
}

function preLaunchInterruption(
  cause: "abort" | "timeout",
  timeoutMs: number,
): NodeExecutionOutcome {
  const timeout = cause === "timeout";
  return {
    status: "failed",
    error: {
      code: timeout ? "command_timeout" : "command_aborted",
      message: timeout
        ? `command exceeded timeout of ${timeoutMs}ms before process launch`
        : "command was cancelled before process launch",
      retryable: false,
      sideEffectStatus: "none",
    },
    evidence: null,
  };
}

async function release(prepared: PreparedCommand): Promise<unknown | null> {
  try {
    await prepared.release();
    return null;
  } catch (error) {
    return error;
  }
}

interface ExitResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError: Error | null;
  readonly terminationIncomplete: boolean;
}

const TERMINATION_POLL_MS = 10;

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  terminationGraceMs: number,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  terminationConfirmationMs = 2_000,
): Promise<ExitResult> {
  return new Promise((resolve) => {
    let settled = false;
    let terminationCause: "abort" | "timeout" | null = null;
    let leaderResult: ExitResult | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let groupCheckTimer: NodeJS.Timeout | undefined;
    let confirmationDeadline = 0;

    function finish(result: ExitResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      if (groupCheckTimer !== undefined) {
        clearTimeout(groupCheckTimer);
      }
      signal?.removeEventListener("abort", abortHandler);
      resolve(result);
    }

    function confirmTermination(): void {
      if (settled || terminationCause === null) {
        return;
      }
      const pid = child.pid;
      if (pid !== undefined && !processGroupIsAlive(pid, platform) && leaderResult !== null) {
        finish(leaderResult);
        return;
      }
      if (Date.now() >= confirmationDeadline) {
        finish({
          ...(leaderResult ?? {
            exitCode: null,
            signal: null,
            timedOut: terminationCause === "timeout",
            aborted: terminationCause === "abort",
            spawnError: null,
          }),
          terminationIncomplete: true,
        });
        return;
      }
      groupCheckTimer = setTimeout(confirmTermination, TERMINATION_POLL_MS);
    }

    function beginTermination(reason: "abort" | "timeout"): void {
      if (settled || terminationCause !== null) {
        return;
      }
      terminationCause = reason;
      clearTimeout(timeoutTimer);
      terminate(child, "SIGTERM", platform);
      killTimer = setTimeout(() => {
        const pid = child.pid;
        if (pid !== undefined && processGroupIsAlive(pid, platform)) {
          terminate(child, "SIGKILL", platform);
        }
        confirmationDeadline = Date.now() + terminationConfirmationMs;
        confirmTermination();
      }, terminationGraceMs);
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
        terminationIncomplete: false,
      });
    });
    child.once("close", (exitCode, exitSignal) => {
      leaderResult = {
        exitCode,
        signal: exitSignal,
        timedOut: terminationCause === "timeout",
        aborted: terminationCause === "abort",
        spawnError: null,
        terminationIncomplete: false,
      };
      if (terminationCause === null) {
        finish(leaderResult);
        return;
      }
      const pid = child.pid;
      if (pid !== undefined && !processGroupIsAlive(pid, platform)) {
        finish(leaderResult);
      }
    });
    signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted === true) {
      beginTermination("abort");
    }
  });
}

function processGroupIsAlive(pid: number, platform: NodeJS.Platform): boolean {
  try {
    if (platform === "win32") {
      process.kill(pid, 0);
    } else {
      process.kill(-pid, 0);
    }
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
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

function sandboxFailure(error: unknown): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code: "command_sandbox_unavailable",
      message: boundedMessage(error),
      retryable: false,
      sideEffectStatus: "none",
    },
    evidence: null,
  };
}

function insufficientContainmentFailure(): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code: "command_sandbox_unavailable",
      message: "agent commands require kernel-backed descendant containment",
      retryable: false,
      sideEffectStatus: "none",
    },
    evidence: null,
  };
}

function sandboxCleanupFailure(
  error: unknown,
  evidence: CommandEvidence | null,
  sideEffectStatus: NodeFailure["sideEffectStatus"],
): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code: "command_sandbox_cleanup_failed",
      message: boundedMessage(error),
      retryable: false,
      sideEffectStatus,
    },
    evidence,
  };
}

function boundedMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  return rawMessage.length <= 16_384 ? rawMessage : `${rawMessage.slice(0, 16_350)}… [truncated]`;
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
