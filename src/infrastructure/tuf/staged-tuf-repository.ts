import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Fetcher } from "tuf-js";
import { Updater } from "tuf-js";
import { DownloadHTTPError, DownloadLengthMismatchError } from "tuf-js/dist/error.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import { assertUnambiguousTufMetadata } from "./tuf-metadata-contract.js";

export const MAX_CAPABILITY_REPOSITORY_TRUSTED_ROOT_BYTES = 512 * 1024;
const MAX_ROOT_BYTES = MAX_CAPABILITY_REPOSITORY_TRUSTED_ROOT_BYTES;
const MAX_TIMESTAMP_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_TARGETS_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_FILES = 34;
const MAX_TARGET_BYTES = 8 * 1024 * 1024;
const MAX_ROOT_ROTATIONS = 32;
const MAX_DELEGATIONS = 31;

export type StagedTufRepositoryStage =
  | "validate trusted root"
  | "prepare staging"
  | "refresh metadata"
  | "resolve target"
  | "download target"
  | "read staged metadata";

export class StagedTufRepositoryError extends Error {
  override readonly name = "StagedTufRepositoryError";
  readonly code = "staged_tuf_repository_failed" as const;

  constructor(readonly stage: StagedTufRepositoryStage) {
    super(`Staged TUF repository failed during ${stage}`);
  }
}

export interface StagedTufReadResult {
  readonly statusCode: number;
  readonly bytes: Uint8Array;
}

export interface StagedTufTarget {
  readonly path: string;
  readonly source: string;
  readonly length: number;
  readonly hashes: Readonly<Record<string, string>>;
  readonly custom: Readonly<Record<string, unknown>>;
  bytes(): Buffer;
}

export interface StagedTufMetadataFile {
  readonly name: string;
  readonly length: number;
  readonly digest: `sha256:${string}`;
  bytes(): Buffer;
}

export interface CompletedStagedTufRepository {
  readonly metadata: readonly StagedTufMetadataFile[];
}

export interface StagedTufRepositorySession {
  readTarget(path: string): Promise<StagedTufTarget>;
  complete(): Promise<CompletedStagedTufRepository>;
}

export interface RefreshStagedTufRepositoryInput {
  readonly stagingDirectory: string;
  readonly metadataBaseUrl: string;
  readonly targetBaseUrl: string;
  readonly trustedMetadata: Readonly<Record<string, Uint8Array>>;
  readonly read: (
    url: string,
    maximumBytes: number,
    signal: AbortSignal,
  ) => Promise<StagedTufReadResult>;
  readonly signal?: AbortSignal;
  readonly hooks?: StagedTufRepositoryHooks;
}

export interface StagedTufRepositoryHooks {
  readonly afterTargetDownloaded?: (path: string) => void | Promise<void>;
}

export interface ValidateStagedTufTrustedRootInput {
  readonly stagingDirectory: string;
  readonly trustedRoot: Uint8Array;
  readonly signal?: AbortSignal;
}

export async function validateStagedTufTrustedRoot(
  input: ValidateStagedTufTrustedRootInput,
): Promise<StagedTufMetadataFile> {
  throwIfAborted(input.signal);
  const content = Buffer.from(input.trustedRoot);
  const metadataDirectory = join(input.stagingDirectory, "metadata");
  const targetDirectory = join(input.stagingDirectory, "targets");
  try {
    validateTrustedRootDocument(content);
    await requireStagingRoot(input.stagingDirectory, input.signal);
    await mkdir(metadataDirectory, { mode: 0o700 });
    throwIfAborted(input.signal);
    await mkdir(targetDirectory, { mode: 0o700 });
    throwIfAborted(input.signal);
    await writeFile(join(metadataDirectory, "root.json"), content, {
      flag: "wx",
      mode: 0o600,
    });
    throwIfAborted(input.signal);
    new Updater({
      metadataDir: metadataDirectory,
      metadataBaseUrl: "https://invalid.example/metadata/",
      targetDir: targetDirectory,
      targetBaseUrl: "https://invalid.example/targets/",
      fetcher: rejectingFetcher,
      config: {
        rootMaxLength: MAX_ROOT_BYTES,
        timestampMaxLength: MAX_TIMESTAMP_BYTES,
        snapshotMaxLength: MAX_SNAPSHOT_BYTES,
        targetsMaxLength: MAX_TARGETS_BYTES,
        maxRootRotations: MAX_ROOT_ROTATIONS,
        maxDelegations: MAX_DELEGATIONS,
        prefixTargetsWithHash: true,
        fetchRetries: 0,
        fetchRetry: false,
        userAgent: "flow-harness",
      },
    });
    throwIfAborted(input.signal);
    const reopened = await readRegularFile(
      join(metadataDirectory, "root.json"),
      content.byteLength,
      input.signal,
    );
    return new ImmutableStagedTufMetadataFile("root.json", reopened);
  } catch (error) {
    throwClosed(error, "validate trusted root", input.signal);
  }
}

export async function refreshStagedTufRepository(
  input: RefreshStagedTufRepositoryInput,
): Promise<StagedTufRepositorySession> {
  throwIfAborted(input.signal);
  const metadataDirectory = join(input.stagingDirectory, "metadata");
  const targetDirectory = join(input.stagingDirectory, "targets");
  try {
    await requireStagingRoot(input.stagingDirectory, input.signal);
    await mkdir(metadataDirectory, { mode: 0o700 });
    throwIfAborted(input.signal);
    await mkdir(targetDirectory, { mode: 0o700 });
    throwIfAborted(input.signal);
    await writeTrustedMetadata(metadataDirectory, input.trustedMetadata, input.signal);
  } catch (error) {
    throwClosed(error, "prepare staging", input.signal);
  }

  const operationSignal = input.signal ?? new AbortController().signal;
  const fetcher = new FlowTufFetcher(
    input.stagingDirectory,
    input.metadataBaseUrl,
    input.read,
    operationSignal,
  );
  let updater: Updater;
  try {
    updater = new Updater({
      metadataDir: metadataDirectory,
      metadataBaseUrl: input.metadataBaseUrl,
      targetDir: targetDirectory,
      targetBaseUrl: input.targetBaseUrl,
      fetcher,
      config: {
        maxRootRotations: MAX_ROOT_ROTATIONS,
        maxDelegations: MAX_DELEGATIONS,
        rootMaxLength: MAX_ROOT_BYTES,
        timestampMaxLength: MAX_TIMESTAMP_BYTES,
        snapshotMaxLength: MAX_SNAPSHOT_BYTES,
        targetsMaxLength: MAX_TARGETS_BYTES,
        prefixTargetsWithHash: true,
        fetchTimeout: 1,
        fetchRetries: 0,
        fetchRetry: false,
        userAgent: "flow-harness",
      },
    });
    await updater.refresh();
    throwIfAborted(input.signal);
    const finalRoot = await readRegularFile(
      join(metadataDirectory, "root.json"),
      MAX_ROOT_BYTES,
      input.signal,
      false,
    );
    validateTrustedRootDocument(finalRoot, false);
  } catch (error) {
    throwClosed(error, "refresh metadata", input.signal);
  }

  return Object.freeze({
    async readTarget(path: string): Promise<StagedTufTarget> {
      throwIfAborted(input.signal);
      let targetInfo: Awaited<ReturnType<Updater["getTargetInfo"]>>;
      try {
        targetInfo = await updater.getTargetInfo(path);
        throwIfAborted(input.signal);
        if (targetInfo === undefined) {
          throw new Error("target not found");
        }
        if (targetInfo.length < 1 || targetInfo.length > MAX_TARGET_BYTES) {
          throw new Error("target length violates its bound");
        }
      } catch (error) {
        throwClosed(error, "resolve target", input.signal);
      }

      const targetFile = join(targetDirectory, `${sha256(Buffer.from(path))}.target`);
      let content: Buffer;
      let source: string;
      try {
        fetcher.clearLastTargetUrl();
        await updater.downloadTarget(targetInfo, targetFile);
        await input.hooks?.afterTargetDownloaded?.(targetFile);
        throwIfAborted(input.signal);
        source = fetcher.takeLastTargetUrl();
        content = await readRegularFile(targetFile, targetInfo.length, input.signal);
      } catch (error) {
        throwClosed(error, "download target", input.signal);
      }

      return new ImmutableStagedTufTarget({
        path: targetInfo.path,
        source,
        length: targetInfo.length,
        hashes: targetInfo.hashes,
        custom: targetInfo.custom,
        content,
      });
    },

    async complete(): Promise<CompletedStagedTufRepository> {
      try {
        throwIfAborted(input.signal);
        const names = (await readdir(metadataDirectory)).sort();
        throwIfAborted(input.signal);
        const metadata: StagedTufMetadataFile[] = [];
        for (const name of names) {
          if (!isCanonicalMetadataName(name)) {
            throw new Error("metadata file name violates its contract");
          }
          const maximumBytes = maximumMetadataBytes(name);
          const content = await readRegularFile(
            join(metadataDirectory, name),
            maximumBytes,
            input.signal,
            false,
          );
          assertUnambiguousTufMetadata(content);
          metadata.push(new ImmutableStagedTufMetadataFile(name, content));
        }
        for (const root of fetcher.rootRotations()) {
          if (names.includes(root.name)) {
            throw new Error("root rotation duplicates staged metadata");
          }
          metadata.push(root);
        }
        metadata.sort((left, right) => left.name.localeCompare(right.name));
        if (metadata.length < 1 || metadata.length > MAX_METADATA_FILES) {
          throw new Error("metadata file count violates its bound");
        }
        return Object.freeze({ metadata: Object.freeze(metadata) });
      } catch (error) {
        throwClosed(error, "read staged metadata", input.signal);
      }
    },
  });
}

class FlowTufFetcher implements Fetcher {
  readonly #stagingDirectory: string;
  readonly #metadataBaseUrl: string;
  readonly #read: RefreshStagedTufRepositoryInput["read"];
  readonly #signal: AbortSignal;
  readonly #rootRotations = new Map<string, Buffer>();
  #lastTargetUrl: string | undefined;

  constructor(
    stagingDirectory: string,
    metadataBaseUrl: string,
    read: RefreshStagedTufRepositoryInput["read"],
    signal: AbortSignal,
  ) {
    this.#stagingDirectory = stagingDirectory;
    this.#metadataBaseUrl = metadataBaseUrl;
    this.#read = read;
    this.#signal = signal;
  }

  async downloadBytes(url: string, maximumBytes: number): Promise<Buffer> {
    throwIfAborted(this.#signal);
    const response = await this.#read(url, maximumBytes, this.#signal);
    throwIfAborted(this.#signal);
    if (response.statusCode !== 200) {
      throw new DownloadHTTPError("TUF repository request failed", response.statusCode);
    }
    const content = Buffer.from(response.bytes);
    if (content.byteLength > maximumBytes) {
      throw new DownloadLengthMismatchError("TUF repository response exceeds its bound");
    }
    if (url.startsWith(this.#metadataBaseUrl)) {
      assertUnambiguousTufMetadata(content);
    }
    const rootName = versionedRootName(url);
    if (rootName !== undefined) {
      this.#rootRotations.set(rootName, Buffer.from(content));
    }
    return content;
  }

  async downloadFile<T>(
    url: string,
    maximumBytes: number,
    handler: (file: string) => Promise<T>,
  ): Promise<T> {
    const content = await this.downloadBytes(url, maximumBytes);
    this.#lastTargetUrl = url;
    const temporaryDirectory = await mkdtemp(join(this.#stagingDirectory, ".target-download-"));
    const temporaryFile = join(temporaryDirectory, "content");
    try {
      throwIfAborted(this.#signal);
      await writeFile(temporaryFile, content, { flag: "wx", mode: 0o600 });
      throwIfAborted(this.#signal);
      return await handler(temporaryFile);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  clearLastTargetUrl(): void {
    this.#lastTargetUrl = undefined;
  }

  takeLastTargetUrl(): string {
    const value = this.#lastTargetUrl;
    this.#lastTargetUrl = undefined;
    if (value === undefined) {
      throw new Error("target download URL was not observed");
    }
    return value;
  }

  rootRotations(): readonly StagedTufMetadataFile[] {
    return Object.freeze(
      [...this.#rootRotations]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, content]) => new ImmutableStagedTufMetadataFile(name, content)),
    );
  }
}

class ImmutableStagedTufTarget implements StagedTufTarget {
  readonly path: string;
  readonly source: string;
  readonly length: number;
  readonly hashes: Readonly<Record<string, string>>;
  readonly custom: Readonly<Record<string, unknown>>;
  readonly #content: Buffer;

  constructor(input: {
    readonly path: string;
    readonly source: string;
    readonly length: number;
    readonly hashes: Record<string, string>;
    readonly custom: Record<string, unknown>;
    readonly content: Buffer;
  }) {
    this.path = input.path;
    this.source = input.source;
    this.length = input.length;
    this.hashes = deepFreeze({ ...input.hashes });
    this.custom = deepFreeze(normalizeJsonObject(input.custom));
    this.#content = Buffer.from(input.content);
    Object.freeze(this);
  }

  bytes(): Buffer {
    return Buffer.from(this.#content);
  }
}

class ImmutableStagedTufMetadataFile implements StagedTufMetadataFile {
  readonly name: string;
  readonly length: number;
  readonly digest: `sha256:${string}`;
  readonly #content: Buffer;

  constructor(name: string, content: Buffer) {
    this.name = name;
    this.length = content.byteLength;
    this.digest = `sha256:${sha256(content)}`;
    this.#content = Buffer.from(content);
    Object.freeze(this);
  }

  bytes(): Buffer {
    return Buffer.from(this.#content);
  }
}

async function requireStagingRoot(path: string, signal: AbortSignal | undefined): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  throwIfAborted(signal);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("staging root is not a direct directory");
  }
}

async function writeTrustedMetadata(
  directory: string,
  trusted: Readonly<Record<string, Uint8Array>>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const entries = Object.entries(trusted).sort(([left], [right]) => left.localeCompare(right));
  if (
    entries.length < 1 ||
    entries.length > MAX_METADATA_FILES ||
    !Object.hasOwn(trusted, "root.json")
  ) {
    throw new Error("trusted metadata set violates its contract");
  }
  for (const [name, source] of entries) {
    throwIfAborted(signal);
    if (!isCanonicalMetadataName(name)) {
      throw new Error("trusted metadata name violates its contract");
    }
    const content = Buffer.from(source);
    if (content.byteLength < 1 || content.byteLength > maximumMetadataBytes(name)) {
      throw new Error("trusted metadata bytes violate their bound");
    }
    assertUnambiguousTufMetadata(content);
    await writeFile(join(directory, name), content, { flag: "wx", mode: 0o600 });
    throwIfAborted(signal);
  }
}

async function readRegularFile(
  path: string,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  exactLength = true,
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    throwIfAborted(signal);
    const before = await handle.stat({ bigint: true });
    throwIfAborted(signal);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes) ||
      (exactLength && before.size !== BigInt(maximumBytes))
    ) {
      throw new Error("staged file violates its metadata contract");
    }
    const content = await handle.readFile();
    throwIfAborted(signal);
    const after = await handle.stat({ bigint: true });
    throwIfAborted(signal);
    const lexical = await lstat(path, { bigint: true });
    throwIfAborted(signal);
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(before, lexical) ||
      !lexical.isFile() ||
      lexical.isSymbolicLink() ||
      BigInt(content.byteLength) !== before.size
    ) {
      throw new Error("staged file changed while reading");
    }
    return content;
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isCanonicalMetadataName(name: string): boolean {
  return (
    Buffer.byteLength(name, "utf8") <= 256 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]*[a-zA-Z0-9])?\.json$/.test(name)
  );
}

function maximumMetadataBytes(name: string): number {
  if (name === "root.json" || /^[1-9][0-9]*\.root\.json$/.test(name)) {
    return MAX_ROOT_BYTES;
  }
  if (name === "timestamp.json") {
    return MAX_TIMESTAMP_BYTES;
  }
  if (name === "snapshot.json") {
    return MAX_SNAPSHOT_BYTES;
  }
  return MAX_TARGETS_BYTES;
}

function versionedRootName(url: string): string | undefined {
  try {
    const name = new URL(url).pathname.split("/").at(-1);
    return name !== undefined && /^[1-9][0-9]*\.root\.json$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

function normalizeJsonObject(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function validateTrustedRootDocument(content: Buffer, checkExpiry = true): void {
  if (content.byteLength < 1 || content.byteLength > MAX_ROOT_BYTES) {
    throw new Error("trusted root violates its byte bound");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const document = parseStrictJson(text, {
    maxDepth: 32,
    maxNodes: 16_384,
    valueLabel: "TUF trusted root",
  });
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.signed === null ||
    typeof document.signed !== "object" ||
    Array.isArray(document.signed) ||
    document.signed._type !== "root" ||
    document.signed.consistent_snapshot !== true ||
    typeof document.signed.expires !== "string"
  ) {
    throw new Error("trusted root shape violates its contract");
  }
  const expiresAt = Date.parse(document.signed.expires);
  if (!Number.isFinite(expiresAt) || (checkExpiry && Date.now() >= expiresAt)) {
    throw new Error("trusted root is expired");
  }
}

const rejectingFetcher: Fetcher = Object.freeze({
  async downloadBytes(): Promise<Buffer> {
    throw new Error("network access is forbidden during trusted-root validation");
  },
  async downloadFile<T>(): Promise<T> {
    throw new Error("network access is forbidden during trusted-root validation");
  },
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}

function throwClosed(
  error: unknown,
  stage: StagedTufRepositoryStage,
  signal: AbortSignal | undefined,
): never {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
  if (error instanceof StagedTufRepositoryError) {
    throw error;
  }
  throw new StagedTufRepositoryError(stage);
}
