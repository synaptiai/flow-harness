import type { SandboxEvidence } from "../domain/run/events.js";

export interface CommandSandboxRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly protectedPaths: readonly string[];
  readonly runtimeSupportPaths?: readonly string[];
  readonly runtimeEnvironment?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface SandboxLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface ManagedCommandExecutionInput {
  readonly signal: AbortSignal;
  stdout(chunk: Uint8Array): void;
  stderr(chunk: Uint8Array): void;
}

export interface ManagedCommandExecutionResult {
  readonly exitCode: number;
}

export type CommandSandboxExecutionStage =
  | "attach execution output"
  | "start execution"
  | "wait for execution"
  | "read execution output"
  | "release execution output"
  | "run managed execution";

export class CommandSandboxExecutionError extends Error {
  override readonly name = "CommandSandboxExecutionError";

  constructor(
    readonly stage: CommandSandboxExecutionStage,
    cause?: unknown,
  ) {
    super(`Command sandbox execution failed during ${stage}`, {
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export interface PreparedCommand {
  readonly processContainment: "linux-pid-namespace" | "process-group";
  readonly launch: SandboxLaunch;
  readonly evidence: SandboxEvidence;
  beforeLaunch?(): Promise<void>;
  run?(input: ManagedCommandExecutionInput): Promise<ManagedCommandExecutionResult>;
  release(): Promise<void>;
}

export interface CommandSandbox {
  prepare(request: CommandSandboxRequest): Promise<PreparedCommand>;
}
