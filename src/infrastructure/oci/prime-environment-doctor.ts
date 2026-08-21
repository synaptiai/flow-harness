import { join } from "node:path";

import { LocalPrimeOciAttestationStore } from "./local-prime-oci-attestation.js";

export interface PrimeEnvironmentDoctorOptions {
  readonly platform?: string;
  readonly architecture?: string;
  readonly readAttestation?: (path: string, signal: AbortSignal) => Promise<unknown>;
}

export async function inspectPreparedPrimeRuntime(
  projectRoot: string,
  signal: AbortSignal,
  options: PrimeEnvironmentDoctorOptions = {},
): Promise<void> {
  if (
    (options.platform ?? process.platform) !== "linux" ||
    (options.architecture ?? process.arch) !== "x64"
  ) {
    throw new Error("prepared Prime runtime requires Linux on x64");
  }
  signal.throwIfAborted();
  const descriptorPath = join(
    projectRoot,
    ".flow",
    "runtime",
    "prime-agent",
    "oci-attestation.json",
  );
  await (options.readAttestation ?? readPreparedAttestation)(descriptorPath, signal);
  signal.throwIfAborted();
}

async function readPreparedAttestation(path: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new LocalPrimeOciAttestationStore({ descriptorPath: path }).read();
  signal.throwIfAborted();
}
