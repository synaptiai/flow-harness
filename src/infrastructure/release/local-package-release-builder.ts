import { type BigIntStats, constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  MAX_PACKAGE_RELEASE_ARCHIVE_BYTES,
  MAX_PACKAGE_RELEASE_EVIDENCE_BYTES,
  parsePackageReleaseEvidence,
} from "../../domain/release/package-release-evidence.js";
import { preparePackageReleaseEvidence } from "./package-release-artifact.js";

export const PACKAGE_RELEASE_EVIDENCE_FILE_NAME = "package-release-evidence.json";

export type LocalPackageReleaseBuilderStage =
  | "build package artifact"
  | "publish package artifact"
  | "settle package artifact";

export class LocalPackageReleaseBuilderError extends Error {
  override readonly name = "LocalPackageReleaseBuilderError";
  readonly code = "package_release_failed" as const;

  constructor(readonly stage: LocalPackageReleaseBuilderStage) {
    super(`Package release failed during ${stage}`);
  }
}

export interface LocalPackageReleaseBuildResult {
  readonly archivePath: string;
  readonly evidencePath: string;
  readonly settlement: "created" | "current";
}

export interface LocalPackageReleaseBuilderInput {
  readonly outputDirectory: string;
  readonly sourceRevision: string;
  readonly signal?: AbortSignal;
}

export interface LocalPackageReleaseBuilderDependencies {
  readonly buildArchive: (input: { readonly signal?: AbortSignal }) => Promise<{
    readonly archive: Uint8Array;
    readonly packOutput: unknown;
  }>;
  readonly beforeCommit?: (stagingDirectory: string) => Promise<void>;
  readonly syncDirectory?: (directory: string) => Promise<void>;
}

export async function buildLocalPackageRelease(
  input: LocalPackageReleaseBuilderInput,
  dependencies: LocalPackageReleaseBuilderDependencies,
): Promise<LocalPackageReleaseBuildResult> {
  const outputDirectory = resolve(input.outputDirectory);
  const parentDirectory = dirname(outputDirectory);
  const synchronizeDirectory = dependencies.syncDirectory ?? syncDirectory;
  let stage: LocalPackageReleaseBuilderStage = "publish package artifact";
  let stagingDirectory: string | undefined;
  let committed = false;
  let parentCreated = false;
  let result: LocalPackageReleaseBuildResult | undefined;
  let operationError: LocalPackageReleaseBuilderError | undefined;

  try {
    input.signal?.throwIfAborted();
    parentCreated = await ensureDirectory(parentDirectory);
    input.signal?.throwIfAborted();
    stagingDirectory = await mkdtemp(
      join(parentDirectory, `.${basename(outputDirectory)}.staging-`),
    );

    stage = "build package artifact";
    const built = await dependencies.buildArchive(
      input.signal === undefined ? {} : { signal: input.signal },
    );
    input.signal?.throwIfAborted();
    const evidenceBytes = preparePackageReleaseEvidence({
      archive: built.archive,
      packOutput: built.packOutput,
      sourceRevision: input.sourceRevision,
    });
    const evidence = parsePackageReleaseEvidence(evidenceBytes);
    const archive = Buffer.from(built.archive);

    stage = "publish package artifact";
    const stagingArchivePath = join(stagingDirectory, evidence.archive.fileName);
    const stagingEvidencePath = join(stagingDirectory, PACKAGE_RELEASE_EVIDENCE_FILE_NAME);
    await writeSettledFile(stagingArchivePath, archive);
    await writeSettledFile(stagingEvidencePath, evidenceBytes);
    await synchronizeDirectory(stagingDirectory);
    input.signal?.throwIfAborted();
    await dependencies.beforeCommit?.(stagingDirectory);
    input.signal?.throwIfAborted();

    const existing = await inspectExistingRelease(
      outputDirectory,
      evidence.archive.fileName,
      archive,
      evidenceBytes,
    );
    if (existing === "current") {
      result = releaseResult(outputDirectory, evidence.archive.fileName, "current");
    } else if (existing === "conflict") {
      throw new Error("package release target conflicts with the prepared artifact");
    } else {
      await rename(stagingDirectory, outputDirectory);
      committed = true;
      stage = "settle package artifact";
      await synchronizeDirectory(parentDirectory);
      result = releaseResult(outputDirectory, evidence.archive.fileName, "created");
    }
  } catch (error) {
    operationError =
      error instanceof LocalPackageReleaseBuilderError
        ? error
        : new LocalPackageReleaseBuilderError(committed ? "settle package artifact" : stage);
  }

  if (!committed && stagingDirectory !== undefined) {
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch {
      throw new LocalPackageReleaseBuilderError("settle package artifact");
    }
  }
  if (!committed && parentCreated) {
    try {
      await rmdir(parentDirectory);
    } catch (error) {
      if (!isDirectoryNotEmpty(error)) {
        throw new LocalPackageReleaseBuilderError("settle package artifact");
      }
    }
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  if (result === undefined) {
    throw new LocalPackageReleaseBuilderError("settle package artifact");
  }
  return result;
}

function releaseResult(
  outputDirectory: string,
  archiveFileName: string,
  settlement: "created" | "current",
): LocalPackageReleaseBuildResult {
  return {
    archivePath: join(outputDirectory, archiveFileName),
    evidencePath: join(outputDirectory, PACKAGE_RELEASE_EVIDENCE_FILE_NAME),
    settlement,
  };
}

async function writeSettledFile(path: string, content: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inspectExistingRelease(
  outputDirectory: string,
  archiveFileName: string,
  expectedArchive: Buffer,
  expectedEvidence: Buffer,
): Promise<"absent" | "current" | "conflict"> {
  let target: Stats;
  try {
    target = await lstat(outputDirectory);
  } catch (error) {
    if (isEnoent(error)) {
      return "absent";
    }
    throw error;
  }
  if (!target.isDirectory() || target.isSymbolicLink()) {
    return "conflict";
  }
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  const expectedNames = [PACKAGE_RELEASE_EVIDENCE_FILE_NAME, archiveFileName].sort();
  if (
    entries.length !== expectedNames.length ||
    entries.some((entry, index) => !entry.isFile() || entry.name !== expectedNames[index])
  ) {
    return "conflict";
  }
  try {
    const evidence = await readBoundedNoFollow(
      join(outputDirectory, PACKAGE_RELEASE_EVIDENCE_FILE_NAME),
      MAX_PACKAGE_RELEASE_EVIDENCE_BYTES,
    );
    const archive = await readBoundedNoFollow(
      join(outputDirectory, archiveFileName),
      MAX_PACKAGE_RELEASE_ARCHIVE_BYTES,
    );
    parsePackageReleaseEvidence(evidence);
    return evidence.equals(expectedEvidence) && archive.equals(expectedArchive)
      ? "current"
      : "conflict";
  } catch {
    return "conflict";
  }
}

async function readBoundedNoFollow(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new Error("release artifact file is outside its bound");
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (content.byteLength !== Number(before.size) || !sameFileObservation(before, after)) {
      throw new Error("release artifact file changed while it was read");
    }
    return content;
  } finally {
    await handle.close();
  }
}

function sameFileObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectory(directory: string): Promise<boolean> {
  try {
    await lstat(directory);
    return false;
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return true;
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { readonly code?: unknown }).code === "ENOTEMPTY" ||
      (error as { readonly code?: unknown }).code === "EEXIST")
  );
}
