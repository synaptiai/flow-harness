import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename } from "node:path";

import type { PrimeOciLocalRuntimeAttestation } from "./local-prime-oci-attestation.js";

interface PrimeImageDeviceMetadata {
  readonly dev: bigint;
  readonly rdev: bigint;
  isBlockDevice(): boolean;
}

export interface PrimeImageDeviceResolverOptions {
  readonly realpath?: (path: string) => Promise<string>;
  readonly readMetadata?: (path: string) => Promise<PrimeImageDeviceMetadata>;
}

export async function resolvePrimeImageDevice(
  dockerRoot: string,
  options: PrimeImageDeviceResolverOptions = {},
): Promise<PrimeOciLocalRuntimeAttestation["imageDevice"]> {
  const resolveRealpath = options.realpath ?? realpath;
  const readMetadata = options.readMetadata ?? readBigIntMetadata;
  const canonicalRoot = await resolveRealpath(dockerRoot);
  const rootMetadata = await readMetadata(canonicalRoot);
  const { major, minor } = decodeLinuxDevice(rootMetadata.dev);
  const sysfsDevice = await resolveRealpath(`/sys/dev/block/${major}:${minor}`);
  const deviceName = basename(sysfsDevice);
  if (!/^[A-Za-z0-9._-]+$/.test(deviceName)) {
    throw new Error("Prime OCI image backing device has no bounded kernel name");
  }
  const devicePath = await resolveRealpath(`/dev/${deviceName}`);
  const deviceMetadata = await readMetadata(devicePath);
  if (!deviceMetadata.isBlockDevice()) {
    throw new Error("Prime OCI image backing path is not one block device");
  }
  const deviceIdentity = decodeLinuxDevice(deviceMetadata.rdev);
  if (deviceIdentity.major !== major || deviceIdentity.minor !== minor) {
    throw new Error("Prime OCI image backing path is not the exact block device");
  }
  return Object.freeze({ path: devicePath, major, minor });
}

async function readBigIntMetadata(path: string): Promise<BigIntStats> {
  return lstat(path, { bigint: true });
}

function decodeLinuxDevice(device: bigint): { readonly major: number; readonly minor: number } {
  const major = Number(((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n));
  const minor = Number((device & 0xffn) | ((device >> 12n) & 0xffffff00n));
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new Error("Prime OCI image device identity exceeds the integer range");
  }
  return Object.freeze({ major, minor });
}
