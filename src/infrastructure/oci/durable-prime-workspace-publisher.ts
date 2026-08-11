import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, link, lstat, open, opendir, rename, rm, unlink } from "node:fs/promises";
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

const MAX_JOURNAL_BYTES = 24 * 1_024 * 1_024;
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

  async publish(input: PrimeWorkspaceResultPublishInput): Promise<void> {
    const targetRoot = resolve(input.targetRoot);
    const stagingRoot = resolve(input.stagingRoot);
    assertSiblingPaths(targetRoot, stagingRoot);
    const entries = Object.freeze(input.entries.map(parsePrimeContainerManifestEntry));
    if (createPrimeContainerManifestSha256(entries) !== input.manifestSha256) {
      throw new Error("Prime workspace result manifest digest contradicts its entries");
    }

    const journalPath = journalPathFor(targetRoot);
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
    const targetSnapshot = await snapshotTree(targetRoot);
    const stagingSnapshot = await snapshotTree(stagingRoot);
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
    await this.options.afterJournalPrepared?.();

    const parent = dirname(targetRoot);
    await rename(targetRoot, journal.retiredRoot);
    await this.options.afterTargetRenamed?.();
    await syncDirectory(parent);
    await writeJournal(journalPath, { ...journal, phase: "retired" }, false);
    await this.options.afterTargetRetired?.();

    await rename(stagingRoot, targetRoot);
    await this.options.afterStagingRenamed?.();
    await syncDirectory(parent);
    await writeJournal(journalPath, { ...journal, phase: "switched" }, false);
    await this.options.afterTargetSwitched?.();

    await assertStagingTree(targetRoot, journal);
    await applyFinalModes(targetRoot, entries);
    await assertOriginalTree(journal.retiredRoot, journal, "retired target");
    await rm(journal.retiredRoot, { recursive: true });
    await this.options.afterRetiredRemoved?.();
    await syncDirectory(parent);
    await unlink(journalPath);
    await syncDirectory(parent);
  }

  async recover(targetInput: string): Promise<PrimeWorkspaceRecoveryOutcome> {
    const targetRoot = resolve(targetInput);
    const journalPath = journalPathFor(targetRoot);
    const journal = await readJournal(journalPath);
    if (journal === undefined) {
      return "none";
    }
    assertJournalPaths(journal, targetRoot);
    const parent = dirname(targetRoot);

    if (journal.phase === "staging") {
      const staging = await optionalDirectoryIdentity(journal.stagingRoot);
      if (staging !== undefined) {
        await rm(journal.stagingRoot, { recursive: true });
        await syncDirectory(parent);
      }
      await unlink(journalPath);
      await syncDirectory(parent);
      return "rolled_back";
    }

    if (journal.phase === "switched") {
      await restoreDirectorySearchAccess(targetRoot, journal.entries);
      await assertStagingTree(targetRoot, journal);
      await applyFinalModes(targetRoot, journal.entries);
      const retired = await optionalDirectoryIdentity(journal.retiredRoot);
      if (retired !== undefined) {
        await assertOriginalTree(journal.retiredRoot, journal, "retired target");
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
      await assertOriginalTree(targetRoot, journal, "target");
      if (retired !== undefined) {
        throw new Error("Prime replacement has both the original target and a retired target");
      }
      if (staging === undefined || !sameIdentity(staging, journal.stagingIdentity)) {
        throw new Error("Prime replacement staging identity changed before recovery");
      }
      await assertStagingTree(journal.stagingRoot, journal);
      await rm(journal.stagingRoot, { recursive: true });
    } else if (
      target === undefined &&
      staging !== undefined &&
      sameIdentity(staging, journal.stagingIdentity) &&
      retired !== undefined &&
      sameIdentity(retired, journal.targetIdentity)
    ) {
      await assertStagingTree(journal.stagingRoot, journal);
      await assertOriginalTree(journal.retiredRoot, journal, "retired target");
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
      await assertStagingTree(targetRoot, journal);
      await assertOriginalTree(journal.retiredRoot, journal, "retired target");
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

async function snapshotTree(root: string): Promise<TreeSnapshot> {
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
      const captured = await captureFile(absolutePath, metadata);
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
): Promise<void> {
  const identity = await directoryIdentity(path, label);
  if (!sameIdentity(identity, journal.targetIdentity)) {
    throw new Error(`Prime workspace ${label} identity changed`);
  }
  await assertTreeManifest(path, journal.targetManifestSha256, label);
}

async function assertStagingTree(path: string, journal: ReplacementJournal): Promise<void> {
  const identity = await directoryIdentity(path, "staged result");
  if (!sameIdentity(identity, journal.stagingIdentity)) {
    throw new Error("Prime workspace staged result identity changed");
  }
  const snapshot = await snapshotTree(path);
  if (snapshot.contentSha256 !== journal.stagingContentSha256) {
    throw new Error("Prime workspace staged result content changed");
  }
  assertExpectedContent(snapshot.entries, journal.entries);
}

async function assertTreeManifest(path: string, expected: string, label: string): Promise<void> {
  if ((await snapshotTree(path)).manifestSha256 !== expected) {
    throw new Error(`Prime workspace ${label} digest changed`);
  }
}

async function applyFinalModes(
  root: string,
  entries: readonly PrimeContainerManifestEntry[],
): Promise<void> {
  const opened: {
    readonly entry: PrimeContainerManifestEntry;
    readonly handle: FileHandle;
  }[] = [];
  try {
    for (const entry of entries) {
      opened.push({
        entry,
        handle: await open(
          join(root, entry.path),
          constants.O_RDONLY |
            constants.O_NOFOLLOW |
            (entry.type === "directory" ? constants.O_DIRECTORY : 0),
        ),
      });
    }
    const ordered = [...opened].sort((left, right) => {
      if (left.entry.type !== right.entry.type) {
        return left.entry.type === "file" ? -1 : 1;
      }
      return right.entry.path.split("/").length - left.entry.path.split("/").length;
    });
    for (const item of ordered) {
      await item.handle.chmod(item.entry.mode);
      const metadata = await item.handle.stat();
      if ((metadata.mode & 0o777) !== item.entry.mode) {
        throw new Error("Prime workspace entry mode did not settle");
      }
      await item.handle.sync();
    }
  } finally {
    await Promise.allSettled(opened.map((item) => item.handle.close()));
  }
}

async function restoreDirectorySearchAccess(
  root: string,
  entries: readonly PrimeContainerManifestEntry[],
): Promise<void> {
  const directories = entries
    .filter(
      (entry): entry is Extract<PrimeContainerManifestEntry, { readonly type: "directory" }> =>
        entry.type === "directory",
    )
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
  for (const entry of directories) {
    const path = join(root, entry.path);
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Prime workspace recovery directory changed type");
    }
    if ((metadata.mode & 0o700n) !== 0o700n) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.chmod(Number(metadata.mode & 0o777n) | 0o700);
        await handle.sync();
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
    const source = await handle.readFile("utf8");
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
  } finally {
    await handle.close();
  }
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

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
