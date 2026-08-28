import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

import { GitHubIssueHostAdmissionError } from "../../application/github-issue-ports.js";

const MAX_SEARCH_DIRECTORIES = 64;
const MAX_PATH_BYTES = 16_384;
const pinnedExecutables = new WeakSet<object>();

export interface GitHubIssueHostExecutables {
  readonly git: PinnedGitHubIssueHostExecutable;
  readonly gh: PinnedGitHubIssueHostExecutable;
}

export interface PinnedGitHubIssueHostExecutable {
  readonly kind: "flow-pinned-host-executable-v1";
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly ownerId: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
  readonly directoryPath: string;
  readonly directoryDevice: number;
  readonly directoryInode: number;
  readonly directoryMode: number;
  readonly directoryOwnerId: number;
  readonly directoryChangedAtMs: number;
}

export interface GitHubIssueHostExecutableResolutionOptions {
  readonly projectRoot: string;
  readonly searchPath?: string;
}

export async function resolveGitHubIssueHostExecutables(
  options: GitHubIssueHostExecutableResolutionOptions,
): Promise<GitHubIssueHostExecutables> {
  const searchPath = options.searchPath ?? process.env.PATH;
  if (searchPath === undefined || Buffer.byteLength(searchPath, "utf8") > MAX_PATH_BYTES) {
    throw new GitHubIssueHostAdmissionError("executable_unavailable");
  }
  const sourceDirectories = searchPath.split(delimiter);
  if (sourceDirectories.length < 1 || sourceDirectories.length > MAX_SEARCH_DIRECTORIES) {
    throw new GitHubIssueHostAdmissionError("executable_unavailable");
  }
  const projectRoot = await canonicalDirectory(options.projectRoot);
  const directories = (
    await Promise.all(
      sourceDirectories.map((directory) => canonicalSearchDirectory(directory, projectRoot)),
    )
  ).filter((directory): directory is string => directory !== undefined);
  const [git, gh] = await Promise.all([
    resolveNamedExecutable("git", directories, projectRoot),
    resolveNamedExecutable("gh", directories, projectRoot),
  ]);
  return Object.freeze({ git, gh });
}

export async function pinGitHubIssueHostExecutable(
  path: string,
  projectRoot: string,
): Promise<PinnedGitHubIssueHostExecutable> {
  if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > 4_095) {
    throw new GitHubIssueHostAdmissionError("executable_unavailable");
  }
  try {
    const canonicalProjectRoot = await canonicalDirectory(projectRoot);
    const canonical = await realpath(path);
    if (isWithin(canonicalProjectRoot, canonical)) {
      throw new GitHubIssueHostAdmissionError("executable_unavailable");
    }
    await access(canonical, constants.X_OK);
    const directoryPath = await realpath(dirname(canonical));
    const directoryMetadata = await stat(directoryPath);
    const metadata = await stat(canonical);
    if (
      !directoryMetadata.isDirectory() ||
      !hasTrustedOwner(directoryMetadata.uid) ||
      hasUnsafeWriteBits(directoryMetadata.mode) ||
      !metadata.isFile() ||
      !hasTrustedOwner(metadata.uid) ||
      hasUnsafeWriteBits(metadata.mode)
    ) {
      throw new GitHubIssueHostAdmissionError("executable_unavailable");
    }
    const pinned = Object.freeze({
      kind: "flow-pinned-host-executable-v1",
      path: canonical,
      device: metadata.dev,
      inode: metadata.ino,
      mode: metadata.mode,
      ownerId: metadata.uid,
      size: metadata.size,
      modifiedAtMs: metadata.mtimeMs,
      changedAtMs: metadata.ctimeMs,
      directoryPath,
      directoryDevice: directoryMetadata.dev,
      directoryInode: directoryMetadata.ino,
      directoryMode: directoryMetadata.mode,
      directoryOwnerId: directoryMetadata.uid,
      directoryChangedAtMs: directoryMetadata.ctimeMs,
    });
    pinnedExecutables.add(pinned);
    return pinned;
  } catch (error) {
    if (error instanceof GitHubIssueHostAdmissionError) throw error;
    throw new GitHubIssueHostAdmissionError("executable_unavailable");
  }
}

export async function isPinnedGitHubIssueHostExecutableCurrent(
  executable: PinnedGitHubIssueHostExecutable,
): Promise<boolean> {
  try {
    if (
      !pinnedExecutables.has(executable) ||
      executable.kind !== "flow-pinned-host-executable-v1" ||
      !isAbsolute(executable.path) ||
      executable.path.includes("\0")
    ) {
      return false;
    }
    const canonical = await realpath(executable.path);
    const canonicalDirectory = await realpath(dirname(canonical));
    const directoryMetadata = await stat(canonicalDirectory);
    const metadata = await stat(canonical);
    await access(canonical, constants.X_OK);
    return (
      canonical === executable.path &&
      canonicalDirectory === executable.directoryPath &&
      directoryMetadata.isDirectory() &&
      !hasUnsafeWriteBits(directoryMetadata.mode) &&
      hasTrustedOwner(directoryMetadata.uid) &&
      directoryMetadata.dev === executable.directoryDevice &&
      directoryMetadata.ino === executable.directoryInode &&
      directoryMetadata.mode === executable.directoryMode &&
      directoryMetadata.uid === executable.directoryOwnerId &&
      directoryMetadata.ctimeMs === executable.directoryChangedAtMs &&
      metadata.isFile() &&
      !hasUnsafeWriteBits(metadata.mode) &&
      hasTrustedOwner(metadata.uid) &&
      metadata.dev === executable.device &&
      metadata.ino === executable.inode &&
      metadata.mode === executable.mode &&
      metadata.uid === executable.ownerId &&
      metadata.size === executable.size &&
      metadata.mtimeMs === executable.modifiedAtMs &&
      metadata.ctimeMs === executable.changedAtMs
    );
  } catch {
    return false;
  }
}

async function resolveNamedExecutable(
  name: "git" | "gh",
  directories: readonly string[],
  projectRoot: string,
): Promise<PinnedGitHubIssueHostExecutable> {
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      return await pinGitHubIssueHostExecutable(candidate, projectRoot);
    } catch {
      // Continue to the next fixed search directory.
    }
  }
  throw new GitHubIssueHostAdmissionError("executable_unavailable");
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > 4_095) {
      throw new Error("invalid directory");
    }
    const canonical = await realpath(path);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new Error("unsafe directory");
    }
    return canonical;
  } catch {
    throw new GitHubIssueHostAdmissionError("executable_unavailable");
  }
}

async function canonicalSearchDirectory(
  path: string,
  projectRoot: string,
): Promise<string | undefined> {
  try {
    if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > 4_095) {
      return undefined;
    }
    const canonical = await realpath(path);
    const metadata = await stat(canonical);
    if (
      !metadata.isDirectory() ||
      !hasTrustedOwner(metadata.uid) ||
      (metadata.mode & 0o002) !== 0 ||
      isWithin(projectRoot, canonical)
    ) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function hasUnsafeWriteBits(mode: number): boolean {
  return (mode & 0o022) !== 0;
}

function hasTrustedOwner(ownerId: number): boolean {
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
  return ownerId === 0 || (currentUserId !== undefined && ownerId === currentUserId);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
