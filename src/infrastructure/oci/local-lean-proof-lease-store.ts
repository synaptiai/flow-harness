import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parseStrictJson } from "../../domain/strict-json.js";
import {
  type LeanProofContainerLease,
  type LeanProofLeaseStore,
  parseLeanProofContainerLease,
} from "./local-lean-proof-driver.js";

const MAX_LEASE_BYTES = 16_384;

export interface LocalLeanProofLeaseStoreOptions {
  readonly directory: string;
  readonly expectedUid?: number;
}

export class LocalLeanProofLeaseStore implements LeanProofLeaseStore {
  readonly #directory: string;
  readonly #expectedUid: number;

  constructor(options: LocalLeanProofLeaseStoreOptions) {
    this.#directory = resolve(options.directory);
    this.#expectedUid = options.expectedUid ?? currentUid();
  }

  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== this.#expectedUid
    ) {
      throw new Error("Lean proof lease directory is not an owner-private directory");
    }
    await chmod(this.#directory, 0o700);
    const privateMetadata = await lstat(this.#directory);
    if (
      !privateMetadata.isDirectory() ||
      privateMetadata.isSymbolicLink() ||
      privateMetadata.uid !== this.#expectedUid ||
      (privateMetadata.mode & 0o077) !== 0
    ) {
      throw new Error("Lean proof lease directory is not an owner-private directory");
    }
  }

  async read(leaseKey: string): Promise<LeanProofContainerLease | null> {
    const path = await this.#path(leaseKey);
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw new Error("Lean proof lease is not a regular file and symbolic links are refused", {
        cause: error,
      });
    }
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.uid !== this.#expectedUid ||
        (metadata.mode & 0o077) !== 0
      ) {
        throw new Error("Lean proof lease is not an owner-private regular file");
      }
      if (metadata.size > MAX_LEASE_BYTES) {
        throw new Error(`Lean proof lease exceeds ${MAX_LEASE_BYTES} bytes`);
      }
      const bytes = Buffer.alloc(metadata.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset !== bytes.byteLength) throw new Error("Lean proof lease ended before its size");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new Error("Lean proof lease is not valid UTF-8", { cause: error });
      }
      const lease = parseLeanProofContainerLease(
        parseStrictJson(text, {
          maxDepth: 16,
          maxNodes: 128,
          valueLabel: "Lean proof lease",
        }),
      );
      if (lease.leaseKey !== leaseKey) {
        throw new Error("Lean proof lease key contradicts its file name");
      }
      return lease;
    } finally {
      await handle.close();
    }
  }

  async write(leaseKey: string, input: LeanProofContainerLease): Promise<void> {
    const path = await this.#path(leaseKey);
    const lease = parseLeanProofContainerLease(input);
    if (lease.leaseKey !== leaseKey) {
      throw new Error("Lean proof lease key contradicts its record");
    }
    const bytes = Buffer.from(JSON.stringify(lease), "utf8");
    if (bytes.byteLength > MAX_LEASE_BYTES) {
      throw new Error(`Lean proof lease exceeds ${MAX_LEASE_BYTES} bytes`);
    }
    const pending = join(this.#directory, `.${leaseKey}.${randomUUID()}.pending`);
    let published = false;
    try {
      const handle = await open(
        pending,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(pending, path);
      published = true;
      await syncDirectory(this.#directory);
    } finally {
      if (!published) await rm(pending, { force: true }).catch(() => undefined);
    }
  }

  async remove(leaseKey: string): Promise<void> {
    const path = await this.#path(leaseKey);
    await rm(path, { force: true });
    await syncDirectory(this.#directory);
  }

  async #path(leaseKey: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(leaseKey)) {
      throw new Error("Lean proof lease key is invalid");
    }
    await this.initialize();
    return join(this.#directory, `${leaseKey}.json`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Lean proof lease store requires a POSIX user identity");
  return uid;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
