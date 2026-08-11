import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import type { PrimeExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import { DockerUnixApiClient } from "./docker-unix-api-client.js";
import type { PrimeOciLocalRuntimeAttestation } from "./local-prime-oci-attestation.js";
import { LocalPrimeOciRuntimeInspector } from "./local-prime-oci-runtime-inspector.js";

const CORE_PATTERN_PATH = "/proc/sys/kernel/core_pattern";
const MAX_CORE_PATTERN_BYTES = 4_096;

export interface PrimeOciCurrentStateClient {
  readVersion(signal?: AbortSignal): Promise<string>;
  readInfo(signal?: AbortSignal): Promise<string>;
  inspectImage(reference: string, signal?: AbortSignal): Promise<Record<string, unknown> | null>;
}

export async function assertPrimeOciRuntimeCurrent(input: {
  readonly runtime: PrimeExternalHarnessIdentity["runtime"];
  readonly image: PrimeExternalHarnessIdentity["image"];
  readonly local: PrimeOciLocalRuntimeAttestation;
  readonly client?: PrimeOciCurrentStateClient;
  readonly readCorePattern?: () => Promise<string>;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const client =
    input.client ??
    new DockerUnixApiClient({
      socketPath: input.local.socketPath,
      apiVersion: input.local.apiVersion,
    });
  const inspector = new LocalPrimeOciRuntimeInspector({
    run: async (args) => {
      if (args.length !== 3 || args[1] !== "--format" || args[2] !== "{{json .}}") {
        throw new Error("Prime OCI currentness received an unsupported Docker observation");
      }
      if (args[0] === "version") {
        return client.readVersion(input.signal);
      }
      if (args[0] === "info") {
        return client.readInfo(input.signal);
      }
      throw new Error("Prime OCI currentness received an unsupported Docker observation");
    },
    local: async () => input.local,
    dockerExecutableSha256: input.local.executables.docker.sha256,
    containerdExecutableSha256: input.local.executables.containerd.sha256,
    runcExecutableSha256: input.local.executables.runc.sha256,
  });
  const current = await inspector.inspect();
  if (!isDeepStrictEqual(current.runtime, input.runtime)) {
    throw new Error("Prime OCI runtime identity changed after admission");
  }
  const image = await client.inspectImage(input.image.id, input.signal);
  if (image?.Id !== input.image.id) {
    throw new Error("Prime OCI image identity changed after admission");
  }
  const corePattern = await (input.readCorePattern ?? readCorePattern)();
  if (corePattern.trim() !== input.local.corePattern) {
    throw new Error("Prime OCI host core policy changed after admission");
  }
}

async function readCorePattern(): Promise<string> {
  const handle = await open(CORE_PATTERN_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(MAX_CORE_PATTERN_BYTES + 1);
    const result = await handle.read(bytes, 0, bytes.byteLength, null);
    if (result.bytesRead < 1 || result.bytesRead > MAX_CORE_PATTERN_BYTES) {
      throw new Error("Prime OCI host core policy exceeds its byte limit");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, result.bytesRead));
  } finally {
    await handle.close();
  }
}
