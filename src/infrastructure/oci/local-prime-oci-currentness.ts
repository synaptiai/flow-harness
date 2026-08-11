import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import type { PrimeExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import { DockerUnixApiClient } from "./docker-unix-api-client.js";
import type { PrimeOciLocalRuntimeAttestation } from "./local-prime-oci-attestation.js";
import { LocalPrimeOciRuntimeInspector } from "./local-prime-oci-runtime-inspector.js";
import {
  type DockerManagedRuntimeExecutables,
  resolveDockerManagedRuntimeExecutables,
} from "./prime-oci-runtime-executables.js";

const CORE_PATTERN_PATH = "/proc/sys/kernel/core_pattern";
const MAX_CORE_PATTERN_BYTES = 4_096;
const CURRENT_CGROUP_PATH = "/proc/self/cgroup";
const MAX_CGROUP_MEMBERSHIP_BYTES = 65_536;
const currentInfoSchema = z.object({ DockerRootDir: z.string().min(1).max(4_095) }).passthrough();

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
  readonly readCurrentCgroup?: () => Promise<string>;
  readonly resolveImageDevice?: (
    dockerRoot: string,
  ) => Promise<PrimeOciLocalRuntimeAttestation["imageDevice"]>;
  readonly resolveRuntimeExecutables?: () => Promise<DockerManagedRuntimeExecutables>;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const client =
    input.client ??
    new DockerUnixApiClient({
      socketPath: input.local.socketPath,
      apiVersion: input.local.apiVersion,
    });
  let observedInfoSource: string | undefined;
  const inspector = new LocalPrimeOciRuntimeInspector({
    run: async (args) => {
      if (args.length !== 3 || args[1] !== "--format" || args[2] !== "{{json .}}") {
        throw new Error("Prime OCI currentness received an unsupported Docker observation");
      }
      if (args[0] === "version") {
        return client.readVersion(input.signal);
      }
      if (args[0] === "info") {
        observedInfoSource ??= await client.readInfo(input.signal);
        return observedInfoSource;
      }
      throw new Error("Prime OCI currentness received an unsupported Docker observation");
    },
    local: async () => input.local,
    dockerExecutableSha256: input.local.executables.docker.sha256,
    dockerdExecutableSha256: input.local.executables.dockerd.sha256,
    containerdExecutableSha256: input.local.executables.containerd.sha256,
    runcExecutableSha256: input.local.executables.runc.sha256,
  });
  const current = await inspector.inspect();
  const runtimeExecutables = await (
    input.resolveRuntimeExecutables ?? resolveDockerManagedRuntimeExecutables
  )();
  if (runtimeExecutables.containerd !== input.local.executables.containerd.path) {
    throw new Error("Prime OCI containerd executable path changed after admission");
  }
  if (runtimeExecutables.dockerd !== input.local.executables.dockerd.path) {
    throw new Error("Prime OCI dockerd executable path changed after admission");
  }
  if (
    runtimeExecutables.containerdSha256 !== undefined &&
    runtimeExecutables.containerdSha256 !== input.local.executables.containerd.sha256
  ) {
    throw new Error("Prime OCI containerd executable changed after admission");
  }
  if (
    runtimeExecutables.dockerdSha256 !== undefined &&
    runtimeExecutables.dockerdSha256 !== input.local.executables.dockerd.sha256
  ) {
    throw new Error("Prime OCI dockerd executable changed after admission");
  }
  const currentInfo = currentInfoSchema.parse(
    JSON.parse(observedInfoSource ?? (await client.readInfo(input.signal))),
  );
  const currentImageDevice = await (input.resolveImageDevice ?? resolvePrimeImageDevice)(
    currentInfo.DockerRootDir,
  );
  if (!isDeepStrictEqual(currentImageDevice, input.local.imageDevice)) {
    throw new Error("Prime OCI image device changed after admission");
  }
  const currentCgroup = await (input.readCurrentCgroup ?? readCurrentCgroup)();
  if (currentCgroup !== input.local.cgroupPath) {
    throw new Error("Prime OCI evaluator cgroup changed after admission");
  }
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

async function readCurrentCgroup(): Promise<string> {
  const handle = await open(CURRENT_CGROUP_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(MAX_CGROUP_MEMBERSHIP_BYTES + 1);
    const result = await handle.read(bytes, 0, bytes.byteLength, null);
    if (result.bytesRead < 1 || result.bytesRead > MAX_CGROUP_MEMBERSHIP_BYTES) {
      throw new Error("Prime OCI cgroup membership exceeds its byte limit");
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, result.bytesRead),
    );
    const matches = source
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("0::"));
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new Error("Prime OCI host does not expose one cgroup version two membership");
    }
    const member = matches[0].slice(3);
    if (!member.startsWith("/") || member.includes("..")) {
      throw new Error("Prime OCI cgroup membership is invalid");
    }
    const path = resolve("/sys/fs/cgroup", `.${member}`);
    if ((await realpath(path)) !== path) {
      throw new Error("Prime OCI cgroup membership path is not canonical");
    }
    return path;
  } finally {
    await handle.close();
  }
}

async function resolvePrimeImageDevice(
  dockerRoot: string,
): Promise<PrimeOciLocalRuntimeAttestation["imageDevice"]> {
  const canonicalRoot = await realpath(dockerRoot);
  const metadata = await lstat(canonicalRoot, { bigint: true });
  const { major, minor } = decodeLinuxDevice(metadata.dev);
  const path = await realpath(`/dev/block/${major}:${minor}`);
  if (!(await lstat(path)).isBlockDevice()) {
    throw new Error("Prime OCI image backing path is not one block device");
  }
  return Object.freeze({ path, major, minor });
}

function decodeLinuxDevice(device: bigint): { readonly major: number; readonly minor: number } {
  const major = Number(((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n));
  const minor = Number((device & 0xffn) | ((device >> 12n) & 0xffffff00n));
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new Error("Prime OCI image device identity exceeds the integer range");
  }
  return Object.freeze({ major, minor });
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
