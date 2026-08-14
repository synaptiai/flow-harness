import { type BigIntStats, constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { parseStrictJson } from "../../domain/strict-json.js";
import {
  PrimeGlobalAdmissionUnsafeStateError,
  type PrimeGlobalSlotLease,
  type PrimeGlobalSlotStore,
  parsePrimeGlobalSlotLease,
} from "./prime-global-admission.js";

const MAX_LEASE_BYTES = 8_192;
const MAX_TEMPORARY_FILES = 32;

interface LeaseSnapshot {
  readonly lease: PrimeGlobalSlotLease;
  readonly bytes: Buffer;
  readonly identity: BigIntStats;
}

export interface LocalPrimeGlobalSlotStoreOptions {
  readonly leasePath: string;
}

export class LocalPrimeGlobalSlotStore implements PrimeGlobalSlotStore {
  readonly #requestedPath: string;

  constructor(options: LocalPrimeGlobalSlotStoreOptions) {
    this.#requestedPath = resolve(options.leasePath);
  }

  async read(): Promise<PrimeGlobalSlotLease | null> {
    const path = await this.#canonicalPath();
    const snapshot = await readLeaseSnapshot(path);
    if (snapshot === null) {
      await retireUnpublishedIntentTemporaries(path);
      return null;
    }
    await retirePublishedIntentTemporary(path, snapshot);
    return snapshot.lease;
  }

  async writeIntent(leaseInput: PrimeGlobalSlotLease): Promise<void> {
    const lease = parsePrimeGlobalSlotLease(leaseInput);
    if (lease.state !== "intent") {
      throw new Error("Prime global slot intent writer requires intent state");
    }
    const path = await this.#canonicalPath();
    if ((await readLeaseSnapshot(path)) !== null) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot durable owner already exists",
      );
    }
    await retireUnpublishedIntentTemporaries(path);
    const temporary = intentTemporaryPath(path, lease.ownerNonce);
    await writeExclusiveDurableFile(temporary, encodeLease(lease));
    try {
      await link(temporary, path);
      await syncDirectory(dirname(path));
      await unlink(temporary);
      await syncDirectory(dirname(path));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      await syncDirectory(dirname(path)).catch(() => undefined);
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new PrimeGlobalAdmissionUnsafeStateError(
          "Prime global slot durable owner appeared during intent publication",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async writeOwned(leaseInput: PrimeGlobalSlotLease): Promise<void> {
    const lease = parsePrimeGlobalSlotLease(leaseInput);
    if (lease.state !== "owned") {
      throw new Error("Prime global slot owned writer requires owned state");
    }
    const path = await this.#canonicalPath();
    const current = await readLeaseSnapshot(path);
    if (
      current === null ||
      current.lease.state !== "intent" ||
      !sameLeaseOwner(current.lease, lease)
    ) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot intent changed before owned publication",
      );
    }
    const temporary = ownedTemporaryPath(path, lease.ownerNonce);
    await writeExclusiveDurableFile(temporary, encodeLease(lease));
    try {
      const rechecked = await readLeaseSnapshot(path);
      if (
        rechecked === null ||
        !rechecked.bytes.equals(current.bytes) ||
        !sameFileIdentity(rechecked.identity, current.identity)
      ) {
        throw new PrimeGlobalAdmissionUnsafeStateError(
          "Prime global slot intent changed during owned publication",
        );
      }
      await rename(temporary, path);
      await syncDirectory(dirname(path));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      await syncDirectory(dirname(path)).catch(() => undefined);
      throw error;
    }
  }

  async confirmIntentDurable(leaseInput: PrimeGlobalSlotLease): Promise<void> {
    const lease = parsePrimeGlobalSlotLease(leaseInput);
    if (lease.state !== "intent") {
      throw new Error("Prime global slot durability check requires intent state");
    }
    const path = await this.#canonicalPath();
    await syncDirectory(dirname(path));
    const current = await readLeaseSnapshot(path);
    if (current === null || !current.bytes.equals(encodeLease(lease))) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot intent changed during durability confirmation",
      );
    }
  }

  async remove(leaseInput: PrimeGlobalSlotLease): Promise<void> {
    const lease = parsePrimeGlobalSlotLease(leaseInput);
    const path = await this.#canonicalPath();
    const current = await readLeaseSnapshot(path);
    if (current === null || !current.bytes.equals(encodeLease(lease))) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot lease does not match the requested removal",
      );
    }
    const pathIdentity = await lstat(path, { bigint: true });
    if (!sameFileIdentity(pathIdentity, current.identity)) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot lease changed before removal",
      );
    }
    await unlink(path);
    await syncDirectory(dirname(path));
    await retireOwnerTemporaries(path, lease.ownerNonce);
  }

  async #canonicalPath(): Promise<string> {
    const parent = await realpath(dirname(this.#requestedPath));
    return join(parent, basename(this.#requestedPath));
  }
}

async function readLeaseSnapshot(path: string): Promise<LeaseSnapshot | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_LEASE_BYTES)) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot lease is not a bounded regular file",
      );
    }
    const bytes = await readBounded(handle, MAX_LEASE_BYTES);
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new PrimeGlobalAdmissionUnsafeStateError("Prime global slot lease changed while read");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new PrimeGlobalAdmissionUnsafeStateError("Prime global slot lease is not valid UTF-8", {
        cause: error,
      });
    }
    try {
      const lease = parsePrimeGlobalSlotLease(
        parseStrictJson(text, {
          maxDepth: 4,
          maxNodes: 16,
          valueLabel: "Prime global slot lease",
        }),
      );
      return Object.freeze({ lease, bytes, identity: after });
    } catch (error) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot lease violates strict JSON or its closed schema",
        { cause: error },
      );
    }
  } finally {
    await handle.close();
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw new PrimeGlobalAdmissionUnsafeStateError(
      `Prime global slot lease exceeds ${maxBytes} bytes`,
    );
  }
  return buffer.subarray(0, offset);
}

async function writeExclusiveDurableFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o660,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
      if (bytesWritten < 1) {
        throw new Error("Prime global slot lease write made no progress");
      }
      offset += bytesWritten;
    }
    await handle.chmod(0o660);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function retireUnpublishedIntentTemporaries(path: string): Promise<void> {
  const parent = dirname(path);
  const prefix = `${basename(path)}.intent.`;
  const directory = await opendir(parent);
  const candidates: string[] = [];
  try {
    for await (const entry of directory) {
      if (
        entry.name.startsWith(prefix) &&
        new RegExp(`^${escapeRegex(prefix)}[a-f0-9]{64}\\.tmp$`).test(entry.name)
      ) {
        candidates.push(join(parent, entry.name));
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  if (candidates.length > MAX_TEMPORARY_FILES) {
    throw new PrimeGlobalAdmissionUnsafeStateError(
      "Prime global slot has too many unpublished intent files",
    );
  }
  for (const candidate of candidates) {
    const snapshot = await readLeaseSnapshot(candidate);
    if (
      snapshot === null ||
      snapshot.lease.state !== "intent" ||
      candidate !== intentTemporaryPath(path, snapshot.lease.ownerNonce)
    ) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot has an invalid unpublished intent file",
      );
    }
    await unlink(candidate);
  }
  if (candidates.length > 0) {
    await syncDirectory(parent);
  }
}

async function retirePublishedIntentTemporary(
  path: string,
  snapshot: LeaseSnapshot,
): Promise<void> {
  if (snapshot.lease.state !== "intent") {
    return;
  }
  const temporary = intentTemporaryPath(path, snapshot.lease.ownerNonce);
  let temporaryIdentity: BigIntStats;
  try {
    temporaryIdentity = await lstat(temporary, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!temporaryIdentity.isFile() || !sameInode(temporaryIdentity, snapshot.identity)) {
    throw new PrimeGlobalAdmissionUnsafeStateError(
      "Prime global slot published intent temporary is unsafe",
    );
  }
  await unlink(temporary);
  await syncDirectory(dirname(path));
}

async function retireOwnerTemporaries(path: string, ownerNonce: string): Promise<void> {
  for (const temporary of [
    intentTemporaryPath(path, ownerNonce),
    ownedTemporaryPath(path, ownerNonce),
  ]) {
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
  }
  await syncDirectory(dirname(path));
}

function encodeLease(lease: PrimeGlobalSlotLease): Buffer {
  return Buffer.from(`${JSON.stringify(lease)}\n`, "utf8");
}

function intentTemporaryPath(path: string, ownerNonce: string): string {
  return `${path}.intent.${ownerNonce}.tmp`;
}

function ownedTemporaryPath(path: string, ownerNonce: string): string {
  return `${path}.owned.${ownerNonce}.tmp`;
}

function sameLeaseOwner(left: PrimeGlobalSlotLease, right: PrimeGlobalSlotLease): boolean {
  return (
    left.lockName === right.lockName &&
    left.ownerNonce === right.ownerNonce &&
    left.policyDigest === right.policyDigest &&
    left.daemonId === right.daemonId
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameInode(left, right) &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
