import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, lstat, open, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import { parseStrictJson } from "../../domain/strict-json.js";
import type { PrimeWorkspaceResultPublishInput } from "./local-prime-workspace-transfer.js";

const MAX_JOURNAL_BYTES = 8_192;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z
  .object({
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(["prepared", "retired", "switched"]),
    targetRoot: z.string().min(1).max(4_096),
    stagingRoot: z.string().min(1).max(4_096),
    retiredRoot: z.string().min(1).max(4_096),
    targetIdentity: identitySchema,
    stagingIdentity: identitySchema,
    manifestSha256: sha256Schema,
  })
  .strict();

type Journal = z.infer<typeof journalSchema>;
type DirectoryIdentity = z.infer<typeof identitySchema>;

export type PrimeWorkspaceRecoveryOutcome = "none" | "rolled_back" | "committed";

export interface DurablePrimeWorkspacePublisherOptions {
  readonly afterJournalPrepared?: () => void | Promise<void>;
  readonly afterTargetRetired?: () => void | Promise<void>;
  readonly afterTargetSwitched?: () => void | Promise<void>;
}

export class DurablePrimeWorkspacePublisher {
  constructor(private readonly options: DurablePrimeWorkspacePublisherOptions = {}) {}

  async publish(input: PrimeWorkspaceResultPublishInput): Promise<void> {
    const targetRoot = resolve(input.targetRoot);
    const stagingRoot = resolve(input.stagingRoot);
    const parent = dirname(targetRoot);
    if (dirname(stagingRoot) !== parent || stagingRoot === targetRoot) {
      throw new Error("Prime workspace staging and target roots must be distinct siblings");
    }
    if ((await this.recover(targetRoot)) !== "none") {
      throw new Error("Prime workspace publisher recovered an earlier interrupted replacement");
    }
    const targetIdentity = await directoryIdentity(targetRoot, "target");
    const stagingIdentity = await directoryIdentity(stagingRoot, "staging");
    const retiredRoot = join(parent, `.${basename(targetRoot)}.prime-retired.${randomUUID()}`);
    const journalPath = journalPathFor(targetRoot);
    const journal: Journal = {
      version: 1,
      phase: "prepared",
      targetRoot,
      stagingRoot,
      retiredRoot,
      targetIdentity,
      stagingIdentity,
      manifestSha256: input.manifestSha256,
    };
    await writeJournal(journalPath, journal, true);
    await this.options.afterJournalPrepared?.();

    await rename(targetRoot, retiredRoot);
    await syncDirectory(parent);
    await writeJournal(journalPath, { ...journal, phase: "retired" }, false);
    await this.options.afterTargetRetired?.();

    await rename(stagingRoot, targetRoot);
    await syncDirectory(parent);
    await writeJournal(journalPath, { ...journal, phase: "switched" }, false);
    await this.options.afterTargetSwitched?.();

    await assertDirectoryIdentity(targetRoot, stagingIdentity, "published target");
    await assertDirectoryIdentity(retiredRoot, targetIdentity, "retired target");
    await rm(retiredRoot, { recursive: true });
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

    if (journal.phase === "switched") {
      await assertDirectoryIdentity(targetRoot, journal.stagingIdentity, "published target");
      await assertDirectoryIdentity(journal.retiredRoot, journal.targetIdentity, "retired target");
      await rm(journal.retiredRoot, { recursive: true });
      await syncDirectory(parent);
      await unlink(journalPath);
      await syncDirectory(parent);
      return "committed";
    }

    const target = await optionalDirectoryIdentity(targetRoot);
    const staging = await optionalDirectoryIdentity(journal.stagingRoot);
    const retired = await optionalDirectoryIdentity(journal.retiredRoot);
    if (target !== undefined && sameIdentity(target, journal.targetIdentity)) {
      if (retired !== undefined) {
        throw new Error("Prime replacement has both the original target and a retired target");
      }
      if (staging === undefined || !sameIdentity(staging, journal.stagingIdentity)) {
        throw new Error("Prime replacement staging identity changed before recovery");
      }
      await rm(journal.stagingRoot, { recursive: true });
    } else if (
      target === undefined &&
      staging !== undefined &&
      sameIdentity(staging, journal.stagingIdentity) &&
      retired !== undefined &&
      sameIdentity(retired, journal.targetIdentity)
    ) {
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

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  label: string,
): Promise<void> {
  if (!sameIdentity(await directoryIdentity(path, label), expected)) {
    throw new Error(`Prime workspace ${label} identity changed`);
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
    !basename(journal.retiredRoot).startsWith(`.${basename(expectedTargetRoot)}.prime-retired.`)
  ) {
    throw new Error("Prime replacement journal contains invalid workspace paths");
  }
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
        maxDepth: 4,
        maxNodes: 32,
        valueLabel: "Prime replacement journal",
      }),
    );
    if (!parsed.success) {
      throw new Error("Prime replacement journal violates the closed schema", {
        cause: parsed.error,
      });
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
