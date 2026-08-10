import type { ExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";

export interface ExternalHarnessLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly runtimeSupportPaths: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export interface ExternalHarnessDescriptor {
  readonly identity: ExternalHarnessIdentity;
  readonly identityDigest: string;
  readonly launch: ExternalHarnessLaunch;
  assertCurrent(): Promise<void>;
}
