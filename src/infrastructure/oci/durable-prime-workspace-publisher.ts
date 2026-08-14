import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  open,
  opendir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import { parseStrictJson } from "../../domain/strict-json.js";
import {
  createPrimeContainerManifestSha256,
  MAX_PRIME_CONTAINER_ENTRIES,
  MAX_PRIME_CONTAINER_FILE_CHUNK_BYTES,
  MAX_PRIME_CONTAINER_TRANSFER_BYTES,
  type PrimeContainerManifestEntry,
  parsePrimeContainerManifestEntry,
} from "../prime/prime-container-protocol.js";
import type { PrimeWorkspaceResultPublishInput } from "./local-prime-workspace-transfer.js";
import { PrimeOciUnsafeStateError } from "./prime-container-lifecycle.js";

const MAX_JOURNAL_BYTES = 24 * 1_024 * 1_024;
const MAX_JOURNAL_TEMPORARIES = 4;
const MAX_JOURNAL_TEMPORARY_BYTES = MAX_JOURNAL_BYTES * MAX_JOURNAL_TEMPORARIES;
const LINUX_O_PATH = 0o10000000;
const journalTemporaryToken =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z
  .object({
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
  })
  .strict();
const manifestEntrySchema = z.union([
  z
    .object({
      path: z.string().min(1).max(4_095),
      type: z.literal("directory"),
      mode: z.number().int().min(0).max(0o777),
    })
    .strict(),
  z
    .object({
      path: z.string().min(1).max(4_095),
      type: z.literal("file"),
      mode: z.number().int().min(0).max(0o777),
      size: z.number().int().min(0).max(MAX_PRIME_CONTAINER_TRANSFER_BYTES),
      sha256: sha256Schema,
    })
    .strict(),
]);
const stagingJournalSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("staging"),
    targetRoot: z.string().min(1).max(4_096),
    stagingRoot: z.string().min(1).max(4_096),
    retiredRoot: z.string().min(1).max(4_096),
    manifestSha256: sha256Schema,
  })
  .strict();
const replacementJournalSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(["prepared", "retired", "switched"]),
    targetRoot: z.string().min(1).max(4_096),
    stagingRoot: z.string().min(1).max(4_096),
    retiredRoot: z.string().min(1).max(4_096),
    targetIdentity: identitySchema,
    stagingIdentity: identitySchema,
    targetManifestSha256: sha256Schema,
    stagingContentSha256: sha256Schema,
    manifestSha256: sha256Schema,
    entries: z.array(manifestEntrySchema).max(MAX_PRIME_CONTAINER_ENTRIES),
  })
  .strict();
const journalSchema = z.discriminatedUnion("phase", [
  stagingJournalSchema,
  replacementJournalSchema,
]);

type Journal = z.infer<typeof journalSchema>;
type StagingJournal = z.infer<typeof stagingJournalSchema>;
type ReplacementJournal = z.infer<typeof replacementJournalSchema>;
type DirectoryIdentity = z.infer<typeof identitySchema>;

interface TreeSnapshot {
  readonly entries: readonly PrimeContainerManifestEntry[];
  readonly manifestSha256: string;
  readonly contentSha256: string;
}

export type PrimeWorkspaceRecoveryOutcome = "none" | "rolled_back" | "committed";

export interface DurablePrimeWorkspacePublisherOptions {
  readonly afterJournalPrepared?: () => void | Promise<void>;
  readonly afterTargetRenamed?: () => void | Promise<void>;
  readonly afterTargetRetired?: () => void | Promise<void>;
  readonly afterStagingRenamed?: () => void | Promise<void>;
  readonly afterTargetSwitched?: () => void | Promise<void>;
  readonly afterRetiredRemoved?: () => void | Promise<void>;
  readonly afterJournalRemoved?: () => void | Promise<void>;
}

export class DurablePrimeWorkspacePublisher {
  constructor(private readonly options: DurablePrimeWorkspacePublisherOptions = {}) {}

  async prepareStaging(input: {
    readonly targetRoot: string;
    readonly stagingRoot: string;
    readonly manifestSha256: string;
  }): Promise<void> {
    const targetRoot = resolve(input.targetRoot);
    const stagingRoot = resolve(input.stagingRoot);
    assertSiblingPaths(targetRoot, stagingRoot);
    await directoryIdentity(targetRoot, "target");
    const journalPath = journalPathFor(targetRoot);
    await recoverJournalTemporaries(journalPath, targetRoot);
    if ((await readJournal(journalPath)) !== undefined) {
      throw new Error("Prime workspace has an unresolved replacement journal");
    }
    const journal: StagingJournal = {
      version: 1,
      phase: "staging",
      targetRoot,
      stagingRoot,
      retiredRoot: retiredRootFor(targetRoot),
      manifestSha256: sha256Schema.parse(input.manifestSha256),
    };
    await writeJournal(journalPath, journal, true);
  }

  async abortStaging(targetInput: string): Promise<void> {
    const targetRoot = resolve(targetInput);
    const journalPath = journalPathFor(targetRoot);
    await recoverJournalTemporaries(journalPath, targetRoot);
    const journal = await readJournal(journalPath);
    if (journal === undefined) {
      return;
    }
    assertJournalPaths(journal, targetRoot);
    if (journal.phase !== "staging") {
      throw new Error("Prime workspace replacement cannot abort a published stage");
    }
    const staging = await optionalDirectoryIdentity(journal.stagingRoot);
    if (staging !== undefined) {
      await rm(journal.stagingRoot, { recursive: true });
      await syncDirectory(dirname(targetRoot));
    }
    await unlink(journalPath);
    await syncDirectory(dirname(targetRoot));
  }

  async publish(input: PrimeWorkspaceResultPublishInput, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const targetRoot = resolve(input.targetRoot);
    const stagingRoot = resolve(input.stagingRoot);
    assertSiblingPaths(targetRoot, stagingRoot);
    const entries = Object.freeze(input.entries.map(parsePrimeContainerManifestEntry));
    if (createPrimeContainerManifestSha256(entries) !== input.manifestSha256) {
      throw new Error("Prime workspace result manifest digest contradicts its entries");
    }

    const journalPath = journalPathFor(targetRoot);
    await recoverJournalTemporaries(journalPath, targetRoot, signal);
    const existing = await readJournal(journalPath);
    if (
      existing !== undefined &&
      (existing.phase !== "staging" ||
        existing.targetRoot !== targetRoot ||
        existing.stagingRoot !== stagingRoot ||
        existing.manifestSha256 !== input.manifestSha256)
    ) {
      throw new Error("Prime workspace has a different unresolved replacement journal");
    }
    const targetIdentity = await directoryIdentity(targetRoot, "target");
    const stagingIdentity = await directoryIdentity(stagingRoot, "staging");
    const targetSnapshot = await snapshotTree(targetRoot, signal);
    const stagingSnapshot = await snapshotTree(stagingRoot, signal);
    assertExpectedContent(stagingSnapshot.entries, entries);

    const journal: ReplacementJournal = {
      version: 1,
      phase: "prepared",
      targetRoot,
      stagingRoot,
      retiredRoot: existing?.retiredRoot ?? retiredRootFor(targetRoot),
      targetIdentity,
      stagingIdentity,
      targetManifestSha256: targetSnapshot.manifestSha256,
      stagingContentSha256: stagingSnapshot.contentSha256,
      manifestSha256: input.manifestSha256,
      entries: [...entries],
    };
    await writeJournal(journalPath, journal, existing === undefined);
    throwIfAborted(signal);
    await this.options.afterJournalPrepared?.();

    const parent = dirname(targetRoot);
    await rename(targetRoot, journal.retiredRoot);
    throwIfAborted(signal);
    await this.options.afterTargetRenamed?.();
    await syncDirectory(parent);
    throwIfAborted(signal);
    await writeJournal(journalPath, { ...journal, phase: "retired" }, false);
    throwIfAborted(signal);
    await this.options.afterTargetRetired?.();

    await rename(stagingRoot, targetRoot);
    throwIfAborted(signal);
    await this.options.afterStagingRenamed?.();
    await syncDirectory(parent);
    throwIfAborted(signal);
    await writeJournal(journalPath, { ...journal, phase: "switched" }, false);
    throwIfAborted(signal);
    await this.options.afterTargetSwitched?.();

    await assertStagingTree(targetRoot, journal, signal);
    await applyFinalModes(targetRoot, entries, signal);
    await assertOriginalTree(journal.retiredRoot, journal, "retired target", signal);
    throwIfAborted(signal);
    await rm(journal.retiredRoot, { recursive: true });
    throwIfAborted(signal);
    await this.options.afterRetiredRemoved?.();
    await syncDirectory(parent);
    throwIfAborted(signal);
    await unlink(journalPath);
    try {
      await this.options.afterJournalRemoved?.();
      await syncDirectory(parent);
    } catch (error) {
      let markerError: unknown;
      try {
        await writeJournal(journalPath, { ...journal, phase: "switched" }, true);
      } catch (recoveryError) {
        markerError = recoveryError;
      }
      throw new PrimeOciUnsafeStateError("Prime workspace publication durability is not proved", {
        cause:
          markerError === undefined
            ? error
            : new AggregateError(
                [error, markerError],
                "Prime workspace publication and recovery marker both failed",
              ),
      });
    }
  }

  async recover(targetInput: string, signal?: AbortSignal): Promise<PrimeWorkspaceRecoveryOutcome> {
    throwIfAborted(signal);
    const targetRoot = resolve(targetInput);
    const journalPath = journalPathFor(targetRoot);
    await recoverJournalTemporaries(journalPath, targetRoot, signal);
    const journal = await readJournal(journalPath);
    if (journal === undefined) {
      return "none";
    }
    assertJournalPaths(journal, targetRoot);
    const parent = dirname(targetRoot);

    if (journal.phase === "staging") {
      const staging = await optionalDirectoryIdentity(journal.stagingRoot);
      if (staging !== undefined) {
        throwIfAborted(signal);
        await rm(journal.stagingRoot, { recursive: true });
        await syncDirectory(parent);
      }
      await unlink(journalPath);
      await syncDirectory(parent);
      return "rolled_back";
    }

    if (journal.phase === "switched") {
      await restoreDirectorySearchAccess(targetRoot, journal.entries, signal);
      await assertStagingTree(targetRoot, journal, signal);
      await applyFinalModes(targetRoot, journal.entries, signal);
      const retired = await optionalDirectoryIdentity(journal.retiredRoot);
      if (retired !== undefined) {
        await assertOriginalTree(journal.retiredRoot, journal, "retired target", signal);
        throwIfAborted(signal);
        await rm(journal.retiredRoot, { recursive: true });
        await syncDirectory(parent);
      }
      await unlink(journalPath);
      await syncDirectory(parent);
      return "committed";
    }

    const target = await optionalDirectoryIdentity(targetRoot);
    const staging = await optionalDirectoryIdentity(journal.stagingRoot);
    const retired = await optionalDirectoryIdentity(journal.retiredRoot);
    if (target !== undefined && sameIdentity(target, journal.targetIdentity)) {
      await assertOriginalTree(targetRoot, journal, "target", signal);
      if (retired !== undefined) {
        throw new Error("Prime replacement has both the original target and a retired target");
      }
      if (staging === undefined || !sameIdentity(staging, journal.stagingIdentity)) {
        throw new Error("Prime replacement staging identity changed before recovery");
      }
      await assertStagingTree(journal.stagingRoot, journal, signal);
      throwIfAborted(signal);
      await rm(journal.stagingRoot, { recursive: true });
    } else if (
      target === undefined &&
      staging !== undefined &&
      sameIdentity(staging, journal.stagingIdentity) &&
      retired !== undefined &&
      sameIdentity(retired, journal.targetIdentity)
    ) {
      await assertStagingTree(journal.stagingRoot, journal, signal);
      await assertOriginalTree(journal.retiredRoot, journal, "retired target", signal);
      throwIfAborted(signal);
      await rename(journal.retiredRoot, targetRoot);
      await syncDirectory(parent);
      await rm(journal.stagingRoot, { recursive: true });
    } else if (
      target !== undefined &&
      sameIdentity(target, journal.stagingIdentity) &&
      staging === undefined &&
      retired !== undefined &&
      sameIdentity(retired, journal.targetIdentity)
    ) {
      await assertStagingTree(targetRoot, journal, signal);
      await assertOriginalTree(journal.retiredRoot, journal, "retired target", signal);
      throwIfAborted(signal);
      await rename(targetRoot, journal.stagingRoot);
      await syncDirectory(parent);
      await rename(journal.retiredRoot, targetRoot);
      await syncDirectory(parent);
      await rm(journal.stagingRoot, { recursive: true });
    } else {
      throw new Error("Prime replacement paths do not match the durable journal identities");
    }
    await syncDirectory(parent);
    await unlink(journalPath);
    await syncDirectory(parent);
    return "rolled_back";
  }
}

function journalPathFor(targetRoot: string): string {
  return join(dirname(targetRoot), `.${basename(targetRoot)}.prime-replacement-v1.json`);
}

function retiredRootFor(targetRoot: string): string {
  return join(dirname(targetRoot), `.${basename(targetRoot)}.prime-retired.${randomUUID()}`);
}

function assertSiblingPaths(targetRoot: string, stagingRoot: string): void {
  if (
    dirname(stagingRoot) !== dirname(targetRoot) ||
    stagingRoot === targetRoot ||
    !basename(stagingRoot).startsWith(`.${basename(targetRoot)}.prime-`)
  ) {
    throw new Error("Prime workspace staging and target roots must be distinct named siblings");
  }
}

async function directoryIdentity(path: string, label: string): Promise<DirectoryIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Prime workspace ${label} must be one no-follow directory`);
  }
  return { device: String(metadata.dev), inode: String(metadata.ino) };
}

async function optionalDirectoryIdentity(path: string): Promise<DirectoryIdentity | undefined> {
  try {
    return await directoryIdentity(path, "recovery path");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertJournalPaths(journal: Journal, expectedTargetRoot: string): void {
  const parent = dirname(expectedTargetRoot);
  if (
    journal.targetRoot !== expectedTargetRoot ||
    dirname(journal.stagingRoot) !== parent ||
    dirname(journal.retiredRoot) !== parent ||
    journal.stagingRoot === expectedTargetRoot ||
    journal.retiredRoot === expectedTargetRoot ||
    !basename(journal.stagingRoot).startsWith(`.${basename(expectedTargetRoot)}.prime-`) ||
    !basename(journal.retiredRoot).startsWith(`.${basename(expectedTargetRoot)}.prime-retired.`)
  ) {
    throw new Error("Prime replacement journal contains invalid workspace paths");
  }
}

async function snapshotTree(root: string, signal?: AbortSignal): Promise<TreeSnapshot> {
  throwIfAborted(signal);
  await directoryIdentity(root, "tree root");
  const entries: PrimeContainerManifestEntry[] = [];
  const content = createHash("sha256");
  let totalBytes = 0;

  const scan = async (relativeDirectory: string): Promise<void> => {
    const absoluteDirectory = relativeDirectory.length === 0 ? root : join(root, relativeDirectory);
    const before = await lstat(absoluteDirectory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error("Prime workspace tree contains an unsafe directory");
    }
    const names: string[] = [];
    const directory = await opendir(absoluteDirectory);
    for await (const entry of directory) {
      names.push(entry.name);
    }
    names.sort(compareUtf8);
    for (const name of names) {
      throwIfAborted(signal);
      const path = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
      const absolutePath = join(root, path);
      const metadata = await lstat(absolutePath, { bigint: true });
      if (metadata.isSymbolicLink()) {
        throw new Error("Prime workspace tree contains a symbolic link");
      }
      if (metadata.isDirectory()) {
        const parsed = parsePrimeContainerManifestEntry({
          path,
          type: "directory",
          mode: Number(metadata.mode & 0o777n),
        });
        entries.push(parsed);
        content.update(`directory\0${path}\0`);
        assertTreeLimits(entries.length, totalBytes);
        await scan(path);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("Prime workspace tree contains a special file");
      }
      const captured = await captureFile(absolutePath, metadata, signal);
      totalBytes += captured.size;
      const parsed = parsePrimeContainerManifestEntry({
        path,
        type: "file",
        mode: Number(metadata.mode & 0o777n),
        size: captured.size,
        sha256: captured.sha256,
      });
      entries.push(parsed);
      content.update(`file\0${path}\0${captured.size}\0${captured.sha256}\0`);
      assertTreeLimits(entries.length, totalBytes);
    }
    const after = await lstat(absoluteDirectory, { bigint: true });
    if (!sameStableIdentity(before, after)) {
      throw new Error("Prime workspace directory changed during digest capture");
    }
  };

  await scan("");
  return Object.freeze({
    entries: Object.freeze(entries),
    manifestSha256: createPrimeContainerManifestSha256(entries),
    contentSha256: content.digest("hex"),
  });
}

async function captureFile(
  path: string,
  initial: BigIntStats,
  signal?: AbortSignal,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameStableIdentity(initial, before)) {
      throw new Error("Prime workspace file changed before digest capture");
    }
    if (before.size > BigInt(MAX_PRIME_CONTAINER_TRANSFER_BYTES)) {
      throw new Error("Prime workspace file exceeds the result byte limit");
    }
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < Number(before.size)) {
      throwIfAborted(signal);
      const chunk = Buffer.allocUnsafe(
        Math.min(MAX_PRIME_CONTAINER_FILE_CHUNK_BYTES, Number(before.size) - offset),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
      if (bytesRead < 1) {
        throw new Error("Prime workspace file ended during digest capture");
      }
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStableIdentity(before, after)) {
      throw new Error("Prime workspace file changed during digest capture");
    }
    return Object.freeze({ size: offset, sha256: hash.digest("hex") });
  } finally {
    await handle.close();
  }
}

function assertExpectedContent(
  actual: readonly PrimeContainerManifestEntry[],
  expected: readonly PrimeContainerManifestEntry[],
): void {
  if (actual.length !== expected.length) {
    throw new Error("Prime staged result membership contradicts its manifest");
  }
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index];
    const right = expected[index];
    if (
      left === undefined ||
      right === undefined ||
      left.path !== right.path ||
      left.type !== right.type ||
      (left.type === "file" &&
        right.type === "file" &&
        (left.size !== right.size || left.sha256 !== right.sha256))
    ) {
      throw new Error("Prime staged result content contradicts its manifest");
    }
  }
}

async function assertOriginalTree(
  path: string,
  journal: ReplacementJournal,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  const identity = await directoryIdentity(path, label);
  if (!sameIdentity(identity, journal.targetIdentity)) {
    throw new Error(`Prime workspace ${label} identity changed`);
  }
  await assertTreeManifest(path, journal.targetManifestSha256, label, signal);
}

async function assertStagingTree(
  path: string,
  journal: ReplacementJournal,
  signal?: AbortSignal,
): Promise<void> {
  const identity = await directoryIdentity(path, "staged result");
  if (!sameIdentity(identity, journal.stagingIdentity)) {
    throw new Error("Prime workspace staged result identity changed");
  }
  const snapshot = await snapshotTree(path, signal);
  if (snapshot.contentSha256 !== journal.stagingContentSha256) {
    throw new Error("Prime workspace staged result content changed");
  }
  assertExpectedContent(snapshot.entries, journal.entries);
}

async function assertTreeManifest(
  path: string,
  expected: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  if ((await snapshotTree(path, signal)).manifestSha256 !== expected) {
    throw new Error(`Prime workspace ${label} digest changed`);
  }
}

async function applyFinalModes(
  root: string,
  entries: readonly PrimeContainerManifestEntry[],
  signal?: AbortSignal,
): Promise<void> {
  const ordered = [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "file" ? -1 : 1;
    }
    return right.path.split("/").length - left.path.split("/").length;
  });
  for (const entry of ordered) {
    throwIfAborted(signal);
    const handle = await open(
      join(root, entry.path),
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (entry.type === "directory" ? constants.O_DIRECTORY : 0),
    );
    try {
      await handle.chmod(entry.mode);
      throwIfAborted(signal);
      const metadata = await handle.stat();
      throwIfAborted(signal);
      if ((metadata.mode & 0o777) !== entry.mode) {
        throw new Error("Prime workspace entry mode did not settle");
      }
      await handle.sync();
      throwIfAborted(signal);
    } finally {
      await handle.close();
    }
  }
}

async function restoreDirectorySearchAccess(
  root: string,
  entries: readonly PrimeContainerManifestEntry[],
  signal?: AbortSignal,
): Promise<void> {
  const ordered = [...entries].sort((left, right) => {
    const depth = left.path.split("/").length - right.path.split("/").length;
    if (depth !== 0 || left.type === right.type) {
      return depth;
    }
    return left.type === "directory" ? -1 : 1;
  });
  for (const entry of ordered) {
    throwIfAborted(signal);
    const path = join(root, entry.path);
    const metadata = await lstat(path, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      (entry.type === "directory" ? !metadata.isDirectory() : !metadata.isFile())
    ) {
      throw new Error("Prime workspace recovery entry changed type");
    }
    const requiredMode = entry.type === "directory" ? 0o700n : 0o400n;
    if ((metadata.mode & requiredMode) !== requiredMode) {
      const identity = { device: String(metadata.dev), inode: String(metadata.ino) };
      if (process.platform !== "linux") {
        throw new PrimeOciUnsafeStateError(
          "Prime workspace recovery requires Linux descriptor-bound mode restoration",
        );
      }
      const bound = await open(path, LINUX_O_PATH | constants.O_NOFOLLOW);
      try {
        const current = await bound.stat({ bigint: true });
        if (
          current.isSymbolicLink() ||
          (entry.type === "directory" ? !current.isDirectory() : !current.isFile()) ||
          String(current.dev) !== identity.device ||
          String(current.ino) !== identity.inode
        ) {
          throw new PrimeOciUnsafeStateError(
            "Prime workspace recovery entry changed before access restoration",
          );
        }
        await chmod(
          `/proc/self/fd/${bound.fd}`,
          Number(metadata.mode & 0o777n) | Number(requiredMode),
        );
      } finally {
        await bound.close();
      }
      const handle = await open(
        path,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (entry.type === "directory" ? constants.O_DIRECTORY : 0),
      );
      try {
        const current = await handle.stat({ bigint: true });
        if (
          current.isSymbolicLink() ||
          (entry.type === "directory" ? !current.isDirectory() : !current.isFile()) ||
          String(current.dev) !== identity.device ||
          String(current.ino) !== identity.inode
        ) {
          throw new PrimeOciUnsafeStateError(
            "Prime workspace recovery entry changed during access restoration",
          );
        }
        throwIfAborted(signal);
        await handle.sync();
        throwIfAborted(signal);
      } finally {
        await handle.close();
      }
    }
  }
}

function assertTreeLimits(entries: number, totalBytes: number): void {
  if (entries > MAX_PRIME_CONTAINER_ENTRIES) {
    throw new Error("Prime workspace tree exceeds the entry limit");
  }
  if (totalBytes > MAX_PRIME_CONTAINER_TRANSFER_BYTES) {
    throw new Error("Prime workspace tree exceeds the byte limit");
  }
}

function sameStableIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function readJournal(path: string): Promise<Journal | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_JOURNAL_BYTES) {
      throw new Error("Prime replacement journal is not one bounded regular file");
    }
    return parseJournalSource(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function recoverJournalTemporaries(
  journalPath: string,
  targetRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const parent = dirname(journalPath);
  const prefix = `${basename(journalPath)}.`;
  const names: string[] = [];
  const directory = await opendir(parent);
  for await (const entry of directory) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) {
      continue;
    }
    const token = entry.name.slice(prefix.length, -".tmp".length);
    if (journalTemporaryToken.test(token)) {
      names.push(entry.name);
    }
  }
  names.sort(compareUtf8);
  if (names.length > MAX_JOURNAL_TEMPORARIES) {
    throw new Error("Prime replacement journal has too many recovery temporaries");
  }

  let totalBytes = 0;
  const validated: string[] = [];
  for (const name of names) {
    throwIfAborted(signal);
    const path = join(parent, name);
    const metadata = await lstat(path, { bigint: true });
    const currentUid =
      typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777n) !== 0o600n ||
      metadata.uid !== currentUid ||
      metadata.nlink < 1n ||
      metadata.nlink > 2n ||
      metadata.size < 1n ||
      metadata.size > BigInt(MAX_JOURNAL_BYTES)
    ) {
      throw new Error("Prime replacement journal temporary is unsafe");
    }
    totalBytes += Number(metadata.size);
    if (totalBytes > MAX_JOURNAL_TEMPORARY_BYTES) {
      throw new Error("Prime replacement journal temporaries exceed the recovery byte limit");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      const journal = parseJournalSource(await handle.readFile("utf8"));
      const after = await handle.stat({ bigint: true });
      if (!sameStableIdentity(metadata, before) || !sameStableIdentity(before, after)) {
        throw new Error("Prime replacement journal temporary changed during recovery");
      }
      assertJournalPaths(journal, targetRoot);
    } finally {
      await handle.close();
    }
    validated.push(path);
  }
  for (const path of validated) {
    throwIfAborted(signal);
    await unlink(path);
  }
  if (validated.length > 0) {
    await syncDirectory(parent);
  }
}

function parseJournalSource(source: string): Journal {
  const parsed = journalSchema.safeParse(
    parseStrictJson(source, {
      maxDepth: 8,
      maxNodes: 64_000,
      valueLabel: "Prime replacement journal",
    }),
  );
  if (!parsed.success) {
    throw new Error("Prime replacement journal violates the closed schema", {
      cause: parsed.error,
    });
  }
  if (parsed.data.phase !== "staging") {
    for (const entry of parsed.data.entries) {
      parsePrimeContainerManifestEntry(entry);
    }
    if (createPrimeContainerManifestSha256(parsed.data.entries) !== parsed.data.manifestSha256) {
      throw new Error("Prime replacement journal manifest digest is invalid");
    }
  }
  return Object.freeze(parsed.data);
}

async function writeJournal(path: string, journal: Journal, initial: boolean): Promise<void> {
  const parsed = journalSchema.parse(journal);
  const source = Buffer.from(`${JSON.stringify(parsed)}\n`);
  if (source.byteLength > MAX_JOURNAL_BYTES) {
    throw new Error("Prime replacement journal exceeds its byte limit");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(source);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (initial) {
      await link(temporary, path);
      await syncDirectory(dirname(path));
      await unlink(temporary);
    } else {
      await rename(temporary, path);
    }
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Prime result publication aborted");
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
