import type { SandboxEvidence } from "../domain/run/events.js";

export interface CommandSandboxRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly protectedPaths: readonly string[];
  readonly signal?: AbortSignal;
}

export interface SandboxLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface PreparedCommand {
  readonly launch: SandboxLaunch;
  readonly evidence: SandboxEvidence;
  release(): Promise<void>;
}

export interface CommandSandbox {
  prepare(request: CommandSandboxRequest): Promise<PreparedCommand>;
}
