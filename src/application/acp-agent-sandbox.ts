import type { PreparedCommand } from "./command-sandbox.js";

export interface AcpAgentSandboxRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly projectRoot: string;
  readonly protectedPaths: readonly string[];
  readonly runtimeSupportPaths: readonly string[];
  readonly providerDomain: string;
  readonly credentialEnvironmentVariable: string;
  readonly signal?: AbortSignal;
}

export interface AcpAgentSandbox {
  prepareAcpAgent(request: AcpAgentSandboxRequest): Promise<PreparedCommand>;
}
