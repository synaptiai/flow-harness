import type { BigIntStats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { PrimeOciLocalRuntimeAttestation } from "./local-prime-oci-attestation.js";

interface PrimeImageDeviceMetadata {
  readonly dev: bigint;
  readonly rdev: bigint;
  isBlockDevice(): boolean;
}

export interface PrimeImageDeviceResolverOptions {
  readonly realpath?: (path: string) => Promise<string>;
  readonly readMetadata?: (path: string) => Promise<PrimeImageDeviceMetadata>;
  readonly readPartitionMarker?: (path: string) => Promise<string | null>;
}

export async function resolvePrimeImageDevice(
  dockerRoot: string,
  options: PrimeImageDeviceResolverOptions = {},
): Promise<PrimeOciLocalRuntimeAttestation["imageDevice"]> {
  const resolveRealpath = options.realpath ?? realpath;
  const readMetadata = options.readMetadata ?? readBigIntMetadata;
  const readPartitionMarker = options.readPartitionMarker ?? readSysfsPartitionMarker;
  const canonicalRoot = await resolveRealpath(dockerRoot);
  const rootMetadata = await readMetadata(canonicalRoot);
  const rootDevice = decodeLinuxDevice(rootMetadata.dev);
  const sysfsDevice = await resolveRealpath(
    `/sys/dev/block/${rootDevice.major}:${rootDevice.minor}`,
  );
  const partitionMarker = await readPartitionMarker(join(sysfsDevice, "partition"));
  let cgroupSysfsDevice = sysfsDevice;
  if (partitionMarker !== null) {
    if (!/^[1-9]\d{0,9}\n?$/.test(partitionMarker)) {
      throw new Error("Prime OCI image device has an invalid partition marker");
    }
    cgroupSysfsDevice = dirname(sysfsDevice);
    if (cgroupSysfsDevice === sysfsDevice) {
      throw new Error("Prime OCI image partition has no whole-disk parent");
    }
  }
  const deviceName = basename(cgroupSysfsDevice);
  if (!/^[A-Za-z0-9._-]+$/.test(deviceName)) {
    throw new Error("Prime OCI image backing device has no bounded kernel name");
  }
  const devicePath = await resolveRealpath(`/dev/${deviceName}`);
  const deviceMetadata = await readMetadata(devicePath);
  if (!deviceMetadata.isBlockDevice()) {
    throw new Error("Prime OCI image backing path is not one block device");
  }
  const deviceIdentity = decodeLinuxDevice(deviceMetadata.rdev);
  const canonicalDeviceSysfs = await resolveRealpath(
    `/sys/dev/block/${deviceIdentity.major}:${deviceIdentity.minor}`,
  );
  if (canonicalDeviceSysfs !== cgroupSysfsDevice) {
    throw new Error("Prime OCI image backing path has the wrong sysfs identity");
  }
  return Object.freeze({ path: devicePath, ...deviceIdentity });
}

async function readBigIntMetadata(path: string): Promise<BigIntStats> {
  return lstat(path, { bigint: true });
}

async function readSysfsPartitionMarker(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function decodeLinuxDevice(device: bigint): { readonly major: number; readonly minor: number } {
  const major = Number(((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n));
  const minor = Number((device & 0xffn) | ((device >> 12n) & 0xffffff00n));
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new Error("Prime OCI image device identity exceeds the integer range");
  }
  return Object.freeze({ major, minor });
}
