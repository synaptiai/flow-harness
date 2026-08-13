import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { parseStrictJson } from "../../domain/strict-json.js";
import {
  type ContainerCommandIntent,
  type ContainerCommandProcessOwner,
  parseContainerCommandIntent,
  parseContainerCommandProcessOwner,
} from "./container-command-intent.js";

const MAX_RECORD_BYTES = 4_718_592;
const MAX_RECORDS = 4_096;
const NONCE_PATTERN = /^[a-f0-9]{64}$/;

export interface LocalContainerCommandIntentStoreOptions {
  readonly directory: string;
  readonly expectedUid?: number;
}

export interface ContainerCommandIntentClaim {
  readonly intent: ContainerCommandIntent;
  release(): Promise<void>;
  complete(): Promise<void>;
}

export class LocalContainerCommandIntentStore {
  readonly #directory: string;
  readonly #expectedUid: number;

  constructor(options: LocalContainerCommandIntentStoreOptions) {
    this.#directory = resolve(options.directory);
    this.#expectedUid = options.expectedUid ?? currentUid();
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.#directory, this.#expectedUid);
  }

  async writeIntent(input: ContainerCommandIntent): Promise<void> {
    const intent = parseContainerCommandIntent(input);
    if (intent.state !== "intent") {
      throw new Error("container command intent publication requires intent state");
    }
    await this.initialize();
    const path = this.#recordPath(intent.ownerNonce);
    const pending = join(this.#directory, `.${randomUUID()}.pending`);
    try {
      await writeSyncedRecord(pending, intent);
      try {
        await link(pending, path);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new Error("container command intent already exists", { cause: error });
        }
        throw error;
      }
      await syncDirectory(this.#directory);
      await rm(pending);
      await syncDirectory(this.#directory);
    } finally {
      await rm(pending, { force: true }).catch(() => undefined);
    }
  }

  async writeOwned(input: ContainerCommandIntent): Promise<void> {
    const owned = parseContainerCommandIntent(input);
    if (owned.state !== "owned") {
      throw new Error("container command owned publication requires owned state");
    }
    const existing = await this.#readRecord(this.#recordPath(owned.ownerNonce));
    if (!sameIntent(existing, owned)) {
      throw new Error("container command owned identity does not match its durable intent");
    }
    const path = this.#recordPath(owned.ownerNonce);
    const pending = join(this.#directory, `.${randomUUID()}.pending`);
    let published = false;
    try {
      await writeSyncedRecord(pending, owned);
      await rename(pending, path);
      published = true;
      await syncDirectory(this.#directory);
    } finally {
      if (!published) {
        await rm(pending, { force: true }).catch(() => undefined);
      }
    }
  }

  async readAll(): Promise<readonly ContainerCommandIntent[]> {
    await this.initialize();
    const names = (await readdir(this.#directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort();
    if (names.length > MAX_RECORDS) {
      throw new Error("container command intent store exceeds its record limit");
    }
    return Object.freeze(
      await Promise.all(names.map((name) => this.#readRecord(join(this.#directory, name)))),
    );
  }

  async claimOrphans(
    claimantInput: ContainerCommandProcessOwner,
    isOwnerAlive: (owner: ContainerCommandProcessOwner) => Promise<boolean>,
  ): Promise<readonly ContainerCommandIntentClaim[]> {
    const claimant = parseContainerCommandProcessOwner(claimantInput);
    const claims: ContainerCommandIntentClaim[] = [];
    for (const intent of await this.readAll()) {
      if (await isOwnerAlive(intent.owner)) {
        continue;
      }
      const claimed = await this.#claim(intent, claimant, isOwnerAlive);
      if (claimed !== null) {
        claims.push(claimed);
      }
    }
    return Object.freeze(claims);
  }

  async remove(ownerNonce: string): Promise<void> {
    const path = this.#recordPath(ownerNonce);
    await rm(path);
    await syncDirectory(this.#directory);
  }

  #recordPath(ownerNonce: string): string {
    if (!NONCE_PATTERN.test(ownerNonce)) {
      throw new Error("container command owner nonce is invalid");
    }
    return join(this.#directory, `${ownerNonce}.json`);
  }

  async #readRecord(path: string): Promise<ContainerCommandIntent> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.uid !== this.#expectedUid ||
        (metadata.mode & 0o077) !== 0
      ) {
        throw new Error("container command intent record is not an owner-only regular file");
      }
      if (metadata.size > MAX_RECORD_BYTES) {
        throw new Error("container command intent record exceeds its byte limit");
      }
      const bytes = await readBounded(handle, MAX_RECORD_BYTES);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new Error("container command intent record is not valid UTF-8", { cause: error });
      }
      return parseContainerCommandIntent(
        parseStrictJson(text, {
          maxDepth: 64,
          maxNodes: 200_000,
          valueLabel: "container command intent record",
        }),
      );
    } finally {
      await handle.close();
    }
  }

  async #claim(
    intent: ContainerCommandIntent,
    claimant: ContainerCommandProcessOwner,
    isOwnerAlive: (owner: ContainerCommandProcessOwner) => Promise<boolean>,
  ): Promise<ContainerCommandIntentClaim | null> {
    const claimPath = join(this.#directory, `${intent.ownerNonce}.claim`);
    const existing = await this.#readClaimOptional(claimPath);
    if (existing !== null) {
      if (await isOwnerAlive(existing)) {
        return null;
      }
      const retired = join(this.#directory, `.${intent.ownerNonce}.${randomUUID()}.retired`);
      try {
        await rename(claimPath, retired);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
      await syncDirectory(this.#directory);
      await rm(retired, { recursive: true, force: true });
      await syncDirectory(this.#directory);
    }

    const pending = join(this.#directory, `.${intent.ownerNonce}.${randomUUID()}.claim`);
    await mkdir(pending, { mode: 0o700 });
    let published = false;
    try {
      await writeSyncedJson(join(pending, "owner.json"), claimant);
      await syncDirectory(pending);
      try {
        await rename(pending, claimPath);
      } catch (error) {
        if (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY")) {
          return null;
        }
        throw error;
      }
      published = true;
      await syncDirectory(this.#directory);
    } finally {
      if (!published) {
        await rm(pending, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    let settled = false;
    const removeClaim = async () => {
      if (settled) {
        return;
      }
      const current = await this.#readClaimOptional(claimPath);
      if (current === null || !sameOwner(current, claimant)) {
        throw new Error("container command recovery claim identity changed");
      }
      await rm(claimPath, { recursive: true });
      await syncDirectory(this.#directory);
      settled = true;
    };
    return Object.freeze({
      intent,
      release: removeClaim,
      complete: async () => {
        if (settled) {
          return;
        }
        const current = await this.#readClaimOptional(claimPath);
        if (current === null || !sameOwner(current, claimant)) {
          throw new Error("container command recovery claim identity changed");
        }
        await this.remove(intent.ownerNonce);
        await rm(claimPath, { recursive: true });
        await syncDirectory(this.#directory);
        settled = true;
      },
    });
  }

  async #readClaimOptional(path: string): Promise<ContainerCommandProcessOwner | null> {
    try {
      const source = await readPrivateText(join(path, "owner.json"), this.#expectedUid);
      return parseContainerCommandProcessOwner(
        parseStrictJson(source, {
          maxDepth: 3,
          maxNodes: 8,
          valueLabel: "container command recovery claim",
        }),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
}

async function ensurePrivateDirectory(directory: string, expectedUid: number): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid) {
    throw new Error("container command intent directory is not a private real directory");
  }
  await chmod(directory, 0o700);
}

async function writeSyncedRecord(path: string, record: ContainerCommandIntent): Promise<void> {
  await writeSyncedJson(path, record);
}

async function writeSyncedJson(path: string, record: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPrivateText(path: string, expectedUid: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== expectedUid || (metadata.mode & 0o077) !== 0) {
      throw new Error("container command recovery claim is not an owner-only regular file");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(handle, 4_096));
  } finally {
    await handle.close();
  }
}

async function readBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(limit + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > limit) {
    throw new Error("container command intent record exceeds its byte limit");
  }
  return buffer.subarray(0, offset);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameIntent(left: ContainerCommandIntent, right: ContainerCommandIntent): boolean {
  const { state: _leftState, containerId: _leftId, ...leftIdentity } = left;
  const { state: _rightState, containerId: _rightId, ...rightIdentity } = right;
  return JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity);
}

function sameOwner(
  left: ContainerCommandProcessOwner,
  right: ContainerCommandProcessOwner,
): boolean {
  return (
    left.bootId === right.bootId && left.pid === right.pid && left.startTicks === right.startTicks
  );
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("container command intent store requires a POSIX user identity");
  }
  return uid;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
