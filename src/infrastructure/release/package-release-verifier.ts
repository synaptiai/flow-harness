import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_PACKAGE_RELEASE_ARCHIVE_BYTES,
  MAX_PACKAGE_RELEASE_FILES,
  type PackageReleaseEvidence,
  parsePackageReleaseEvidence,
} from "../../domain/release/package-release-evidence.js";
import { parseStrictJson, type StrictJsonObject } from "../../domain/strict-json.js";

const MAX_INSTALLED_PACKAGE_ENTRIES = MAX_PACKAGE_RELEASE_FILES * 2;
const MAX_INSTALLED_PACKAGE_DEPTH = 32;
const MAX_INSTALLED_PACKAGE_MANIFEST_BYTES = 256 * 1024;

export type PackageReleaseVerificationStage = "verify package archive" | "verify installed package";

export class PackageReleaseVerificationError extends Error {
  override readonly name = "PackageReleaseVerificationError";
  readonly code = "package_release_failed" as const;

  constructor(readonly stage: PackageReleaseVerificationStage) {
    super(`Package release failed during ${stage}`);
  }
}

export interface VerifyPackageReleaseArtifactInput {
  readonly archive: Uint8Array;
  readonly evidenceBytes: Uint8Array;
  readonly expectedSourceRevision: string;
}

interface InstalledFileObservation {
  readonly bytes: number;
  readonly mode: number;
}

export function verifyPackageReleaseArtifact(
  input: VerifyPackageReleaseArtifactInput,
): PackageReleaseEvidence {
  try {
    const archive = Buffer.from(input.archive);
    const evidence = parsePackageReleaseEvidence(input.evidenceBytes);
    if (
      !/^[a-f0-9]{40}$/.test(input.expectedSourceRevision) ||
      evidence.sourceRevision !== input.expectedSourceRevision ||
      archive.byteLength < 1 ||
      archive.byteLength > MAX_PACKAGE_RELEASE_ARCHIVE_BYTES ||
      archive.byteLength !== evidence.archive.bytes ||
      createHash("sha512").update(archive).digest("hex") !== evidence.archive.sha512
    ) {
      throw new Error("package archive does not match its release evidence");
    }
    return evidence;
  } catch (error) {
    if (error instanceof PackageReleaseVerificationError) throw error;
    throw new PackageReleaseVerificationError("verify package archive");
  }
}

export async function verifyInstalledPackageRelease(
  packageRoot: string,
  evidence: PackageReleaseEvidence,
): Promise<void> {
  try {
    const expectedFiles = new Map(
      evidence.files.map((file) => [
        file.path,
        {
          bytes: file.bytes,
          mode: file.path === "dist/cli/launcher.js" ? 0o777 & ~process.umask() : file.mode,
        },
      ]),
    );
    const expectedDirectories = expectedDirectoryPaths(evidence);
    const observedFiles = new Map<string, InstalledFileObservation>();
    const observedDirectories = new Set<string>();
    const state = { entries: 0 };
    await collectInstalledTree(packageRoot, "", 1, observedFiles, observedDirectories, state);
    if (
      !fileMapsEqual(expectedFiles, observedFiles) ||
      !setsEqual(expectedDirectories, observedDirectories)
    ) {
      throw new Error("installed package tree does not match the release manifest");
    }

    const manifestBytes = await readBoundedNoFollow(
      join(packageRoot, "package.json"),
      MAX_INSTALLED_PACKAGE_MANIFEST_BYTES,
    );
    const manifest = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
      {
        maxDepth: 8,
        maxNodes: 4_096,
        valueLabel: "installed package manifest",
      },
    );
    if (!isExpectedPackageManifest(manifest, evidence.packageVersion)) {
      throw new Error("installed package manifest contradicts the release contract");
    }
  } catch (error) {
    if (error instanceof PackageReleaseVerificationError) throw error;
    throw new PackageReleaseVerificationError("verify installed package");
  }
}

async function collectInstalledTree(
  directory: string,
  relativeDirectory: string,
  depth: number,
  files: Map<string, InstalledFileObservation>,
  directories: Set<string>,
  state: { entries: number },
): Promise<void> {
  if (depth > MAX_INSTALLED_PACKAGE_DEPTH) {
    throw new Error("installed package tree exceeds its depth limit");
  }
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("installed package directory is not a direct directory");
  }
  const handle = await opendir(directory);
  for await (const entry of handle) {
    state.entries += 1;
    if (state.entries > MAX_INSTALLED_PACKAGE_ENTRIES) {
      throw new Error("installed package tree exceeds its entry limit");
    }
    const relativePath =
      relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    const target = join(directory, entry.name);
    const observed = await lstat(target, { bigint: true });
    if (observed.isSymbolicLink()) {
      throw new Error("installed package tree contains a symbolic link");
    }
    if (observed.isDirectory()) {
      directories.add(relativePath);
      await collectInstalledTree(target, relativePath, depth + 1, files, directories, state);
      continue;
    }
    if (!observed.isFile()) {
      throw new Error("installed package tree contains a special file");
    }
    files.set(relativePath, await observeRegularFile(target));
  }
  const after = await lstat(directory, { bigint: true });
  if (!sameObservation(before, after)) {
    throw new Error("installed package directory changed during verification");
  }
}

async function observeRegularFile(path: string): Promise<InstalledFileObservation> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("installed package file is not a bounded regular file");
    }
    const after = await handle.stat({ bigint: true });
    if (!sameObservation(before, after)) {
      throw new Error("installed package file changed during verification");
    }
    return { bytes: Number(before.size), mode: Number(before.mode & 0o777n) };
  } finally {
    await handle.close();
  }
}

async function readBoundedNoFollow(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new Error("installed package file is outside its read bound");
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (content.byteLength !== Number(before.size) || !sameObservation(before, after)) {
      throw new Error("installed package file changed during read");
    }
    return content;
  } finally {
    await handle.close();
  }
}

function expectedDirectoryPaths(evidence: PackageReleaseEvidence): Set<string> {
  const directories = new Set<string>();
  for (const file of evidence.files) {
    const segments = file.path.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      directories.add(current);
    }
  }
  return directories;
}

function isExpectedPackageManifest(value: unknown, version: string): boolean {
  if (!isObject(value)) return false;
  return (
    value.name === "@synapti/flow-harness" &&
    value.version === version &&
    isExactObject(value.bin, { flow: "dist/cli/launcher.js" }) &&
    isExactObject(value.exports, {}) &&
    isExactObject(value.engines, { node: ">=26.7.0" }) &&
    Array.isArray(value.os) &&
    value.os.length === 2 &&
    value.os[0] === "darwin" &&
    value.os[1] === "linux" &&
    isExactObject(value.publishConfig, { access: "public" })
  );
}

function isObject(value: unknown): value is StrictJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactObject(value: unknown, expected: Readonly<Record<string, string>>): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => value[key] === expected[key])
  );
}

function fileMapsEqual(
  left: ReadonlyMap<string, InstalledFileObservation>,
  right: ReadonlyMap<string, InstalledFileObservation>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([key, value]) => {
      const observed = right.get(key);
      return observed?.bytes === value.bytes && observed.mode === value.mode;
    })
  );
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function sameObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
