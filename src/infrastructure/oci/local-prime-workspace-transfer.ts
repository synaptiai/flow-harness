import { createHash, type Hash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { MAX_EVALUATION_INSTRUCTION_BYTES } from "../../domain/evaluation/plan.js";
import {
  createPrimeContainerManifestSha256,
  MAX_PRIME_CONTAINER_ENTRIES,
  MAX_PRIME_CONTAINER_FILE_CHUNK_BYTES,
  MAX_PRIME_CONTAINER_TRANSFER_BYTES,
  type PrimeContainerManifestEntry,
  type PrimeContainerTransferStart,
} from "../prime/prime-container-protocol.js";
import type {
  PrimeOciFixturePart,
  PrimeOciFixtureSource,
  PrimeOciResultSink,
} from "./attached-prime-oci-operator.js";

interface StableIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface FileObservation {
  readonly absolutePath: string;
  readonly entry: Extract<PrimeContainerManifestEntry, { readonly type: "file" }>;
  readonly identity: StableIdentity;
}

interface DirectoryObservation {
  readonly absolutePath: string;
  readonly entry?: Extract<PrimeContainerManifestEntry, { readonly type: "directory" }>;
  readonly identity: StableIdentity;
}

type TransferObservation =
  | { readonly type: "directory"; readonly value: DirectoryObservation }
  | { readonly type: "file"; readonly value: FileObservation };

export interface LocalPrimeOciFixtureSourceInput {
  readonly root: string;
  readonly instructionPath: string;
  readonly expectedSnapshotDigest: string;
}

export async function createLocalPrimeOciFixtureSource(
  input: LocalPrimeOciFixtureSourceInput,
): Promise<PrimeOciFixtureSource> {
  if (!/^[a-f0-9]{64}$/.test(input.expectedSnapshotDigest)) {
    throw new Error("Prime fixture snapshot digest must be one lowercase SHA-256 value");
  }
  const requestedRoot = resolve(input.root);
  const root = await realpath(requestedRoot);
  const rootMetadata = await lstat(root, { bigint: true });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Prime fixture root must be one no-follow directory");
  }
  const observations: TransferObservation[] = [];
  const rootObservation: DirectoryObservation = {
    absolutePath: root,
    identity: identity(rootMetadata),
  };
  const instructionChunks: Buffer[] = [];
  let instructionSeen = false;
  let totalBytes = 0;
  await scanDirectory(
    root,
    "",
    input.instructionPath,
    observations,
    async (observation, content) => {
      totalBytes += observation.entry.size;
      enforceFixtureLimits(observations.length, totalBytes);
      if (observation.entry.path === input.instructionPath) {
        if (observation.entry.size > MAX_EVALUATION_INSTRUCTION_BYTES) {
          throw new Error(
            `Prime fixture instruction exceeds ${MAX_EVALUATION_INSTRUCTION_BYTES} bytes`,
          );
        }
        instructionChunks.push(...content);
        instructionSeen = true;
      }
    },
  );
  if (!instructionSeen) {
    throw new Error("Prime fixture instruction is missing or is not a regular file");
  }
  const entries = observations.map((observation) => observation.value.entry).filter(isEntry);
  const manifestSha256 = createPrimeContainerManifestSha256(entries);
  if (manifestSha256 !== input.expectedSnapshotDigest) {
    throw new Error("Prime fixture manifest contradicts the admitted workspace snapshot");
  }
  const instructionText = decodeUtf8(Buffer.concat(instructionChunks), "Prime fixture instruction");
  const start = Object.freeze({
    entryCount: entries.length,
    totalBytes,
    manifestSha256,
  });

  return Object.freeze({
    start,
    instructionText,
    parts: (signal?: AbortSignal) => streamFixture(rootObservation, observations, signal),
  });
}

export interface PrimeWorkspaceResultPublishInput {
  readonly targetRoot: string;
  readonly stagingRoot: string;
  readonly entries: readonly PrimeContainerManifestEntry[];
  readonly manifestSha256: string;
}

export interface StagedPrimeOciResultSinkOptions {
  readonly targetRoot: string;
  readonly publish: (
    input: PrimeWorkspaceResultPublishInput,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly prepareStaging?: (input: {
    readonly targetRoot: string;
    readonly stagingRoot: string;
    readonly manifestSha256: string;
  }) => Promise<void>;
  readonly abortStaging?: (targetRoot: string) => Promise<void>;
}

export class StagedPrimeOciResultSink implements PrimeOciResultSink {
  readonly #publish: StagedPrimeOciResultSinkOptions["publish"];
  readonly #prepareStaging: StagedPrimeOciResultSinkOptions["prepareStaging"];
  readonly #abortStaging: StagedPrimeOciResultSinkOptions["abortStaging"];
  readonly #targetRoot: string;
  readonly #entries: PrimeContainerManifestEntry[] = [];
  readonly #directoryModes: { readonly path: string; readonly mode: number }[] = [];
  #current:
    | {
        readonly handle: FileHandle;
        readonly entry: Extract<PrimeContainerManifestEntry, { readonly type: "file" }>;
        readonly hash: Hash;
        bytes: number;
      }
    | undefined;
  #expected: PrimeContainerTransferStart | undefined;
  #publication: PrimeWorkspaceResultPublishInput | undefined;
  #stagingRoot: string | undefined;
  #committed = false;

  constructor(options: StagedPrimeOciResultSinkOptions) {
    this.#targetRoot = resolve(options.targetRoot);
    this.#publish = options.publish;
    this.#prepareStaging = options.prepareStaging;
    this.#abortStaging = options.abortStaging;
  }

  get stagingRoot(): string | undefined {
    return this.#stagingRoot;
  }

  async begin(start: PrimeContainerTransferStart, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.#expected !== undefined || this.#committed) {
      throw new Error("Prime result sink is already active");
    }
    const target = await lstat(this.#targetRoot);
    throwIfAborted(signal);
    if (!target.isDirectory() || target.isSymbolicLink()) {
      throw new Error("Prime result target must be one no-follow directory");
    }
    this.#expected = Object.freeze({ ...start });
    this.#stagingRoot = join(
      dirname(this.#targetRoot),
      `.${basename(this.#targetRoot)}.prime-result.${randomUUID()}`,
    );
    try {
      await this.#prepareStaging?.({
        targetRoot: this.#targetRoot,
        stagingRoot: this.#stagingRoot,
        manifestSha256: start.manifestSha256,
      });
      throwIfAborted(signal);
      await mkdir(this.#stagingRoot, { mode: 0o700 });
      throwIfAborted(signal);
      await chmod(this.#stagingRoot, 0o700);
      throwIfAborted(signal);
    } catch (error) {
      await this.#abortStaging?.(this.#targetRoot).catch(() => undefined);
      this.#stagingRoot = undefined;
      throw error;
    }
  }

  async addEntry(entry: PrimeContainerManifestEntry, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const stagingRoot = this.#requireStaging();
    if (this.#current !== undefined) {
      throw new Error("Prime result file must end before the next entry");
    }
    const absolutePath = join(stagingRoot, entry.path);
    assertBeneath(stagingRoot, absolutePath);
    if (entry.type === "directory") {
      await mkdir(absolutePath, { mode: 0o700 });
      throwIfAborted(signal);
      this.#directoryModes.push({ path: absolutePath, mode: entry.mode });
    } else {
      const handle = await open(
        absolutePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      this.#current = { handle, entry, hash: createHash("sha256"), bytes: 0 };
    }
    this.#entries.push(Object.freeze({ ...entry }));
  }

  async addChunk(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const current = this.#current;
    if (current === undefined) {
      throw new Error("Prime result chunk has no active file");
    }
    const chunk = Buffer.from(bytes);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const written = await current.handle.write(chunk, offset, chunk.byteLength - offset);
      throwIfAborted(signal);
      if (written.bytesWritten < 1) {
        throw new Error("Prime result file write made no progress");
      }
      offset += written.bytesWritten;
    }
    current.bytes += chunk.byteLength;
    current.hash.update(chunk);
  }

  async endFile(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const current = this.#current;
    if (current === undefined) {
      throw new Error("Prime result file end has no active file");
    }
    this.#current = undefined;
    try {
      if (
        current.bytes !== current.entry.size ||
        current.hash.digest("hex") !== current.entry.sha256
      ) {
        throw new Error("Prime staged result file contradicts its manifest entry");
      }
      await current.handle.sync();
      throwIfAborted(signal);
    } finally {
      await current.handle.close();
    }
  }

  async commit(
    entries: readonly PrimeContainerManifestEntry[],
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const stagingRoot = this.#requireStaging();
    const expected = this.#expected;
    if (expected === undefined || this.#current !== undefined || this.#committed) {
      throw new Error("Prime result sink cannot commit in its current state");
    }
    if (JSON.stringify(entries) !== JSON.stringify(this.#entries)) {
      throw new Error("Prime result sink entries contradict the validated transfer");
    }
    await syncDirectoryTree(
      stagingRoot,
      this.#directoryModes.map((item) => item.path),
      signal,
    );
    throwIfAborted(signal);
    this.#publication = Object.freeze({
      targetRoot: this.#targetRoot,
      stagingRoot,
      entries: Object.freeze([...this.#entries]),
      manifestSha256: expected.manifestSha256,
    });
    this.#committed = true;
  }

  async publishResult(signal?: AbortSignal): Promise<void> {
    const publication = this.#publication;
    if (!this.#committed || publication === undefined) {
      throw new Error("Prime result sink has no complete staging tree to publish");
    }
    throwIfAborted(signal);
    await this.#publish(publication, signal);
    this.#publication = undefined;
    this.#stagingRoot = undefined;
  }

  async abort(_error: unknown): Promise<void> {
    const current = this.#current;
    this.#current = undefined;
    if (current !== undefined) {
      await current.handle.close().catch(() => undefined);
    }
    const stagingRoot = this.#stagingRoot;
    this.#publication = undefined;
    this.#stagingRoot = undefined;
    if (stagingRoot !== undefined) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    await this.#abortStaging?.(this.#targetRoot);
  }

  #requireStaging(): string {
    if (this.#stagingRoot === undefined) {
      throw new Error("Prime result sink has no private staging directory");
    }
    return this.#stagingRoot;
  }
}

async function scanDirectory(
  root: string,
  relativeDirectory: string,
  instructionPath: string,
  observations: TransferObservation[],
  onFile: (observation: FileObservation, content: readonly Buffer[]) => Promise<void>,
): Promise<void> {
  const absoluteDirectory = relativeDirectory === "" ? root : join(root, relativeDirectory);
  const before = await lstat(absoluteDirectory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(
      `Prime fixture directory changed or became unsafe: ${relativeDirectory || "."}`,
    );
  }
  const names: string[] = [];
  const directory = await opendir(absoluteDirectory);
  for await (const entry of directory) {
    names.push(entry.name);
  }
  names.sort(compareUtf8);

  for (const name of names) {
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    if (relativePath === ".flow-prime" || relativePath.startsWith(".flow-prime/")) {
      throw new Error("Prime fixture uses the reserved .flow-prime path");
    }
    const absolutePath = join(root, relativePath);
    const metadata = await lstat(absolutePath, { bigint: true });
    if (metadata.isSymbolicLink()) {
      throw new Error(`Prime fixture entry is a symbolic link: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      const observation: DirectoryObservation = {
        absolutePath,
        entry: { path: relativePath, type: "directory", mode: Number(metadata.mode & 0o777n) },
        identity: identity(metadata),
      };
      observations.push({ type: "directory", value: observation });
      enforceFixtureLimits(observations.length, 0);
      await scanDirectory(root, relativePath, instructionPath, observations, onFile);
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Prime fixture entry is not a regular file or directory: ${relativePath}`);
    }
    const captured = await captureFile(
      absolutePath,
      relativePath,
      metadata,
      relativePath === instructionPath,
    );
    observations.push({ type: "file", value: captured.observation });
    enforceFixtureLimits(observations.length, 0);
    await onFile(captured.observation, captured.content);
  }
  const after = await lstat(absoluteDirectory, { bigint: true });
  if (!sameIdentity(identity(before), identity(after))) {
    throw new Error(`Prime fixture directory changed during capture: ${relativeDirectory || "."}`);
  }
}

async function captureFile(
  absolutePath: string,
  relativePath: string,
  initial: BigIntStats,
  retainContent: boolean,
): Promise<{ readonly observation: FileObservation; readonly content: readonly Buffer[] }> {
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  const content: Buffer[] = [];
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(identity(initial), identity(before))) {
      throw new Error(`Prime fixture file changed before capture: ${relativePath}`);
    }
    let offset = 0;
    while (offset < Number(before.size)) {
      const buffer = Buffer.allocUnsafe(
        Math.min(MAX_PRIME_CONTAINER_FILE_CHUNK_BYTES, Number(before.size) - offset),
      );
      const read = await handle.read(buffer, 0, buffer.byteLength, offset);
      if (read.bytesRead < 1) {
        throw new Error(`Prime fixture file ended during capture: ${relativePath}`);
      }
      const chunk = Buffer.from(buffer.subarray(0, read.bytesRead));
      hash.update(chunk);
      if (retainContent) {
        content.push(chunk);
      }
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(identity(before), identity(after))) {
      throw new Error(`Prime fixture file changed during capture: ${relativePath}`);
    }
    const sha256 = hash.digest("hex");
    return {
      observation: {
        absolutePath,
        entry: {
          path: relativePath,
          type: "file",
          mode: Number(before.mode & 0o777n),
          size: Number(before.size),
          sha256,
        },
        identity: identity(before),
      },
      content,
    };
  } finally {
    await handle.close();
  }
}

async function* streamFixture(
  root: DirectoryObservation,
  observations: readonly TransferObservation[],
  signal?: AbortSignal,
): AsyncIterable<PrimeOciFixturePart> {
  await assertObservationCurrent(root);
  for (const observation of observations) {
    throwIfAborted(signal);
    await assertObservationCurrent(observation.value);
    yield { type: "entry", entry: observation.value.entry as PrimeContainerManifestEntry };
    if (observation.type === "directory") {
      continue;
    }
    const file = observation.value;
    const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash("sha256");
    let offset = 0;
    try {
      const before = await handle.stat({ bigint: true });
      if (!sameIdentity(file.identity, identity(before))) {
        throw new Error(`Prime fixture file changed before transfer: ${file.entry.path}`);
      }
      while (offset < file.entry.size) {
        throwIfAborted(signal);
        const buffer = Buffer.allocUnsafe(
          Math.min(MAX_PRIME_CONTAINER_FILE_CHUNK_BYTES, file.entry.size - offset),
        );
        const read = await handle.read(buffer, 0, buffer.byteLength, offset);
        if (read.bytesRead < 1) {
          throw new Error(`Prime fixture file ended during transfer: ${file.entry.path}`);
        }
        const chunk = Buffer.from(buffer.subarray(0, read.bytesRead));
        hash.update(chunk);
        offset += read.bytesRead;
        yield { type: "chunk", bytes: chunk };
      }
      const after = await handle.stat({ bigint: true });
      if (
        !sameIdentity(file.identity, identity(after)) ||
        hash.digest("hex") !== file.entry.sha256
      ) {
        throw new Error(`Prime fixture file changed during transfer: ${file.entry.path}`);
      }
    } finally {
      await handle.close();
    }
    yield { type: "file-end" };
  }
  for (const observation of observations) {
    if (observation.type === "directory") {
      await assertObservationCurrent(observation.value);
    }
  }
  await assertObservationCurrent(root);
}

async function assertObservationCurrent(
  observation: FileObservation | DirectoryObservation,
): Promise<void> {
  const current = await lstat(observation.absolutePath, { bigint: true });
  if (current.isSymbolicLink() || !sameIdentity(observation.identity, identity(current))) {
    throw new Error(`Prime fixture source changed: ${observation.entry?.path ?? "."}`);
  }
}

function identity(metadata: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): StableIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

function sameIdentity(left: StableIdentity, right: StableIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function enforceFixtureLimits(entryCount: number, totalBytes: number): void {
  if (entryCount > MAX_PRIME_CONTAINER_ENTRIES) {
    throw new Error(`Prime fixture exceeds ${MAX_PRIME_CONTAINER_ENTRIES} entries`);
  }
  if (totalBytes > MAX_PRIME_CONTAINER_TRANSFER_BYTES) {
    throw new Error(`Prime fixture exceeds ${MAX_PRIME_CONTAINER_TRANSFER_BYTES} bytes`);
  }
}

function isEntry(
  entry: PrimeContainerManifestEntry | undefined,
): entry is PrimeContainerManifestEntry {
  return entry !== undefined;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

function assertBeneath(root: string, path: string): void {
  if (path === root || !path.startsWith(`${root}/`)) {
    throw new Error("Prime result path escapes its private staging root");
  }
}

async function syncDirectoryTree(
  root: string,
  directories: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  for (const directory of [...directories].reverse()) {
    throwIfAborted(signal);
    const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
      throwIfAborted(signal);
    } finally {
      await handle.close();
    }
  }
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await rootHandle.sync();
    throwIfAborted(signal);
  } finally {
    await rootHandle.close();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Prime transfer aborted");
  }
}
