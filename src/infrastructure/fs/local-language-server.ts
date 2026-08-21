import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { dirname, parse, relative, resolve, sep } from "node:path";

import {
  createLanguageServerSnapshot,
  type LanguageServerSnapshot,
  MAX_LANGUAGE_SERVER_EXECUTABLE_BYTES,
  MAX_LANGUAGE_SERVER_MANIFEST_BYTES,
  parseLanguageServerManifest,
} from "../../domain/capability/language-server.js";

export type LocalLanguageServerErrorCode =
  | "invalid_manifest"
  | "invalid_executable"
  | "source_changed";

export class LocalLanguageServerError extends Error {
  override readonly name = "LocalLanguageServerError";

  constructor(readonly code: LocalLanguageServerErrorCode) {
    super(
      code === "invalid_manifest"
        ? "language server manifest is invalid"
        : code === "invalid_executable"
          ? "language server executable is invalid"
          : "language server source changed during admission",
    );
  }
}

export interface LocalLanguageServerOptions {
  readonly signal?: AbortSignal | undefined;
  /** @internal Deterministic cancellation and source-race seam. */
  readonly afterManifestRead?: () => void | Promise<void>;
  /** @internal Deterministic cancellation and source-race seam. */
  readonly afterExecutableRead?: () => void | Promise<void>;
  /** @internal Deterministic final revalidation seam. */
  readonly beforeReturn?: () => void | Promise<void>;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly identity: BigIntStats;
}

interface StableFile {
  readonly content: Buffer;
  readonly identity: BigIntStats;
}

export async function admitLocalLanguageServer(
  projectRoot: string,
  manifestPath: string,
  options: LocalLanguageServerOptions = {},
): Promise<LanguageServerSnapshot> {
  options.signal?.throwIfAborted();
  const root = resolve(projectRoot);
  const absoluteManifestPath = resolve(manifestPath);
  const provenance = relative(root, absoluteManifestPath).split(sep).join("/");
  if (!provenance.startsWith(".flow/language-servers/") || provenance.endsWith("/")) {
    throw new LocalLanguageServerError("invalid_manifest");
  }
  const manifestDirectories = await observeDirectories(
    root,
    dirname(absoluteManifestPath),
    options.signal,
  );
  const manifest = await readStableFile(
    absoluteManifestPath,
    MAX_LANGUAGE_SERVER_MANIFEST_BYTES,
    "invalid_manifest",
    options.signal,
  );
  await options.afterManifestRead?.();
  options.signal?.throwIfAborted();

  let definition: ReturnType<typeof parseLanguageServerManifest>;
  try {
    definition = parseLanguageServerManifest(manifest.content);
  } catch {
    throw new LocalLanguageServerError("invalid_manifest");
  }
  options.signal?.throwIfAborted();
  const executableDirectories = await observeDirectories(
    parse(definition.spec.executable).root,
    dirname(definition.spec.executable),
    options.signal,
  );
  const executable = await readStableFile(
    definition.spec.executable,
    MAX_LANGUAGE_SERVER_EXECUTABLE_BYTES,
    "invalid_executable",
    options.signal,
    true,
  );
  await options.afterExecutableRead?.();
  options.signal?.throwIfAborted();
  if (sha256(executable.content) !== definition.spec.executableSha256) {
    throw new LocalLanguageServerError("invalid_executable");
  }

  await options.beforeReturn?.();
  options.signal?.throwIfAborted();
  await revalidateDirectories(manifestDirectories, options.signal);
  await revalidateFile(absoluteManifestPath, manifest.identity, options.signal);
  await revalidateDirectories(executableDirectories, options.signal);
  await revalidateFile(definition.spec.executable, executable.identity, options.signal);
  options.signal?.throwIfAborted();
  return createLanguageServerSnapshot({
    provenance,
    manifest: manifest.content,
    executable: {
      path: definition.spec.executable,
      sha256: sha256(executable.content),
      bytes: executable.content.byteLength,
      device: String(executable.identity.dev),
      inode: String(executable.identity.ino),
    },
  });
}

export async function assertLocalLanguageServerCurrent(
  snapshot: LanguageServerSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  const executable = await readStableFile(
    snapshot.executable.path,
    MAX_LANGUAGE_SERVER_EXECUTABLE_BYTES,
    "invalid_executable",
    signal,
    true,
  );
  if (
    executable.content.byteLength !== snapshot.executable.bytes ||
    sha256(executable.content) !== snapshot.executable.sha256 ||
    String(executable.identity.dev) !== snapshot.executable.device ||
    String(executable.identity.ino) !== snapshot.executable.inode
  ) {
    throw new LocalLanguageServerError("source_changed");
  }
}

async function readStableFile(
  path: string,
  maximumBytes: number,
  invalidCode: "invalid_manifest" | "invalid_executable",
  signal?: AbortSignal,
  requireExecutable = false,
): Promise<StableFile> {
  signal?.throwIfAborted();
  let handle: FileHandle;
  let result: StableFile | undefined;
  let operationError: unknown;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    throw new LocalLanguageServerError(invalidCode);
  }
  try {
    const before = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > BigInt(maximumBytes) ||
      (requireExecutable && (before.mode & 0o111n) === 0n)
    ) {
      throw new LocalLanguageServerError(invalidCode);
    }
    const content = await readBounded(handle, Number(before.size), maximumBytes, signal);
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!sameIdentity(before, after) || content.byteLength !== Number(before.size)) {
      throw new LocalLanguageServerError("source_changed");
    }
    result = { content, identity: after };
  } catch (error) {
    signal?.throwIfAborted();
    operationError =
      error instanceof LocalLanguageServerError ? error : new LocalLanguageServerError(invalidCode);
  }
  let closeFailed = false;
  try {
    await handle.close();
  } catch {
    closeFailed = true;
  }
  signal?.throwIfAborted();
  if (operationError !== undefined) {
    throw operationError;
  }
  if (closeFailed || result === undefined) {
    throw new LocalLanguageServerError(invalidCode);
  }
  return result;
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  expectedBytes: number,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const output = Buffer.allocUnsafe(Math.min(maximumBytes + 1, expectedBytes + 1));
  let offset = 0;
  while (offset < output.byteLength) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(output, offset, output.byteLength - offset, offset);
    signal?.throwIfAborted();
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maximumBytes) {
    throw new LocalLanguageServerError("source_changed");
  }
  return output.subarray(0, offset);
}

async function observeDirectories(
  anchor: string,
  target: string,
  signal?: AbortSignal,
): Promise<readonly DirectoryIdentity[]> {
  const normalizedAnchor = resolve(anchor);
  const normalizedTarget = resolve(target);
  const pathFromAnchor = relative(normalizedAnchor, normalizedTarget);
  if (pathFromAnchor === ".." || pathFromAnchor.startsWith(`..${sep}`)) {
    throw new LocalLanguageServerError("invalid_executable");
  }
  const segments = pathFromAnchor === "" ? [] : pathFromAnchor.split(sep);
  const observations: DirectoryIdentity[] = [];
  let current = normalizedAnchor;
  for (const segment of segments) {
    current = resolve(current, segment);
    signal?.throwIfAborted();
    let identity: BigIntStats;
    try {
      identity = await lstat(current, { bigint: true });
      signal?.throwIfAborted();
    } catch {
      signal?.throwIfAborted();
      throw new LocalLanguageServerError("source_changed");
    }
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw new LocalLanguageServerError("source_changed");
    }
    observations.push({ path: current, identity });
  }
  return observations;
}

async function revalidateDirectories(
  observations: readonly DirectoryIdentity[],
  signal?: AbortSignal,
): Promise<void> {
  for (const observation of observations) {
    await revalidateFile(observation.path, observation.identity, signal, true);
  }
}

async function revalidateFile(
  path: string,
  expected: BigIntStats,
  signal?: AbortSignal,
  directory = false,
): Promise<void> {
  signal?.throwIfAborted();
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    throw new LocalLanguageServerError("source_changed");
  }
  if (
    !sameIdentity(expected, current) ||
    current.isSymbolicLink() ||
    (directory ? !current.isDirectory() : !current.isFile())
  ) {
    throw new LocalLanguageServerError("source_changed");
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
