import { type BigIntStats, constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_CONTENT_BYTES = 4_096;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export interface ImmutableInputFixturePaths {
  readonly root: string;
  readonly inputs: string;
  readonly readableFile: string;
  readonly deniedFile: string;
  readonly deniedParent: string;
  readonly deniedChild: string;
  readonly missingFile: string;
}

export type FixtureRetentionReason =
  | "invalid-lifecycle"
  | "execution-unconfirmed"
  | "integrity-drift"
  | "host-precondition-failed"
  | "descriptor-close-failed"
  | "cleanup-failed";

export interface RetainedInputFixture {
  /** No successful cleanup claim; a cleanup failure can leave a partial tree. */
  readonly status: "retained";
  readonly reason: FixtureRetentionReason;
}

export type InputFixtureIntegrity = { readonly status: "verified" } | RetainedInputFixture;
export type InputFixtureCleanup = { readonly status: "removed" } | RetainedInputFixture;

export interface ImmutableInputFixture {
  readonly paths: ImmutableInputFixturePaths;
  /** Host proof only; the observer must independently prove the sandbox's view. */
  verifyHostPreconditions(): Promise<InputFixtureIntegrity>;
  /** Call before every invocation, including trusted controls. */
  markExecutionStarted(): void;
  /** Only the trusted executor can attest that all descendants have settled. */
  confirmExecutionSettled(): void;
  verifyIntegrity(): Promise<InputFixtureIntegrity>;
  /** Always call, including after retention, to release host-owned descriptors. */
  cleanup(confirmation: "never-started" | "settled"): Promise<InputFixtureCleanup>;
}

interface OwnedEntry {
  readonly path: string;
  readonly handle: FileHandle;
  baseline: BigIntStats;
}

/**
 * The caller must protect the private parent from candidate access and exclude
 * concurrent host mutations. Candidate commands receive only the input paths.
 * Identity checks detect persistent drift, not transient changes between checks.
 */
export async function createImmutableInputFixture(options: {
  readonly privateParent: string;
  readonly candidateWorkspace: string;
  readonly contents: Uint8Array;
}): Promise<ImmutableInputFixture> {
  // Detach before the first await: caller mutation must not change the baseline.
  if (options.contents.byteLength === 0 || options.contents.byteLength > MAX_CONTENT_BYTES) {
    throw new Error("Fixture contents must contain between 1 and 4096 bytes");
  }
  const contents = Buffer.from(options.contents);
  const { privateParent, candidateWorkspace } = options;
  await requireCanonicalDirectory(privateParent);
  await requireCanonicalDirectory(candidateWorkspace);
  if (contains(privateParent, candidateWorkspace) || contains(candidateWorkspace, privateParent)) {
    throw new Error("Fixture private parent and candidate workspace must not overlap");
  }
  const parentInfo = await lstat(privateParent, { bigint: true });
  if (
    process.geteuid === undefined ||
    parentInfo.uid !== BigInt(process.geteuid()) ||
    (parentInfo.mode & 0o7777n) !== 0o700n
  ) {
    throw new Error("Fixture private parent must be owned by the host user with mode 0700");
  }

  const entries: OwnedEntry[] = [];
  const handles: FileHandle[] = [];
  let root: string | undefined;
  try {
    const parent = await ownDirectory(privateParent, entries, handles);
    if (!sameIdentity(parent.baseline, parentInfo)) throw new Error("Fixture parent changed");
    root = await mkdtemp(join(privateParent, "flow-input-"));
    const paths = Object.freeze({
      root,
      inputs: join(root, "inputs"),
      readableFile: join(root, "inputs", "readable.txt"),
      deniedFile: join(root, "inputs", "denied.txt"),
      deniedParent: join(root, "inputs", "denied-parent"),
      deniedChild: join(root, "inputs", "denied-parent", "child.txt"),
      missingFile: join(root, "inputs", "missing.txt"),
    });
    const rootEntry = await ownDirectory(root, entries, handles);
    await mkdir(paths.inputs, { mode: 0o700 });
    const inputs = await ownDirectory(paths.inputs, entries, handles);
    await mkdir(paths.deniedParent, { mode: 0o700 });
    const deniedParent = await ownDirectory(paths.deniedParent, entries, handles);
    const readable = await ownFile(paths.readableFile, contents, entries, handles);
    const denied = await ownFile(paths.deniedFile, contents, entries, handles);
    const child = await ownFile(paths.deniedChild, contents, entries, handles);
    await denied.handle.chmod(0);
    await deniedParent.handle.chmod(0);
    for (const entry of entries) entry.baseline = await entry.handle.stat({ bigint: true });

    let phase: "never-started" | "running" | "settled" | "removed" = "never-started";
    let verified = true;
    let busy = false;
    let retained: RetainedInputFixture | undefined;
    let closing: Promise<void> | undefined;
    const releaseHandles = (): Promise<void> => {
      closing ??= Promise.allSettled(handles.map((handle) => handle.close())).then((results) => {
        if (results.some((result) => result.status === "rejected")) {
          retained = Object.freeze({ status: "retained", reason: "descriptor-close-failed" });
        }
      });
      return closing;
    };
    const retain = (reason: FixtureRetentionReason): RetainedInputFixture => {
      retained ??= Object.freeze({ status: "retained", reason });
      if (!busy) void releaseHandles();
      return retained;
    };
    const invalidTransition = (): never => {
      retain("invalid-lifecycle");
      throw new Error("Invalid fixture lifecycle transition; fixture retained");
    };
    const checkEntry = async (entry: OwnedEntry, checkPath = true): Promise<void> => {
      if (!sameIdentity(await entry.handle.stat({ bigint: true }), entry.baseline)) {
        throw new Error("Fixture handle identity or metadata changed");
      }
      if (checkPath && !sameIdentity(await lstat(entry.path, { bigint: true }), entry.baseline)) {
        throw new Error("Fixture path identity or metadata changed");
      }
    };
    const checkIntegrity = async (): Promise<void> => {
      // The parent can host independent fixtures, so its directory link count is not frozen.
      await requireCanonicalDirectory(privateParent);
      await checkEntry(parent);
      for (const entry of [rootEntry, inputs, readable, denied, deniedParent]) {
        await checkEntry(entry);
      }
      await requireInventory(paths.root, ["inputs"]);
      await requireInventory(paths.inputs, ["denied-parent", "denied.txt", "readable.txt"]);
      // Original file handles allow bounded reads without loosening file permissions.
      for (const entry of [readable, denied, child]) {
        await checkEntry(entry, entry !== child);
        await requireBytes(entry.handle, contents);
      }
      // Only the original directory descriptor is changed, after visible identity checks.
      // This is safe only with settled execution and the caller's private-parent boundary.
      await deniedParent.handle.chmod(0o500);
      try {
        const accessibleInfo = await lstat(paths.deniedParent, { bigint: true });
        if (
          !sameIdentity(accessibleInfo, { ...deniedParent.baseline, mode: accessibleInfo.mode }) ||
          (accessibleInfo.mode & 0o7777n) !== 0o500n
        ) {
          throw new Error("Denied parent identity changed while checking inventory");
        }
        await requireInventory(paths.deniedParent, ["child.txt"]);
        await checkEntry(child);
      } finally {
        await deniedParent.handle.chmod(0);
      }
      await checkEntry(deniedParent);
    };
    const inspect = async (hostPreconditions: boolean): Promise<InputFixtureIntegrity> => {
      if (retained !== undefined) return retained;
      if (phase === "running") return retain("execution-unconfirmed");
      if (phase === "removed" || busy) return retain("invalid-lifecycle");
      busy = true;
      try {
        await checkIntegrity();
        if (hostPreconditions) {
          const results = await Promise.all([
            readOutcome(paths.deniedFile),
            readOutcome(paths.deniedChild),
            readOutcome(paths.missingFile),
          ]);
          if (results.join(",") !== "EACCES,EACCES,ENOENT") {
            return retain("host-precondition-failed");
          }
          const readableHandle = await open(
            paths.readableFile,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            await requireBytes(readableHandle, contents);
          } finally {
            await readableHandle.close();
          }
        }
        if (retained !== undefined) return retained;
        verified = true;
        return { status: "verified" };
      } catch {
        return retain("integrity-drift");
      } finally {
        busy = false;
        if (retained !== undefined) await releaseHandles();
      }
    };
    return Object.freeze({
      paths,
      verifyIntegrity: () => inspect(false),
      verifyHostPreconditions: () => inspect(true),
      markExecutionStarted(): void {
        if (
          retained !== undefined ||
          busy ||
          !verified ||
          phase === "running" ||
          phase === "removed"
        ) {
          invalidTransition();
        }
        phase = "running";
        verified = false;
      },
      confirmExecutionSettled(): void {
        if (retained !== undefined || busy || phase !== "running") invalidTransition();
        phase = "settled";
      },
      async cleanup(confirmation: "never-started" | "settled"): Promise<InputFixtureCleanup> {
        if (retained !== undefined) {
          if (!busy) await releaseHandles();
          return retained;
        }
        if (phase === "removed") return { status: "removed" };
        if (phase === "running") return retain("execution-unconfirmed");
        if (busy || phase !== confirmation) return retain("invalid-lifecycle");
        busy = true;
        try {
          // Keep the lifecycle locked continuously through verification and deletion.
          // Releasing it between awaits would permit a new command to start in that gap.
          try {
            await checkIntegrity();
          } catch {
            retain("integrity-drift");
          }
          if (retained === undefined) {
            await deniedParent.handle.chmod(0o700);
            // No recursive removal: only the exact verified inventory can be removed.
            for (const entry of [child, readable, denied]) await unlink(entry.path);
            for (const path of [paths.deniedParent, paths.inputs, paths.root]) await rmdir(path);
            phase = "removed";
          }
        } catch {
          retain("cleanup-failed");
        } finally {
          busy = false;
          await releaseHandles();
        }
        return retained ?? { status: "removed" };
      },
    });
  } catch (cause) {
    const releases = await Promise.allSettled(handles.map((handle) => handle.close()));
    const closureErrors = releases.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    // Setup errors do not justify walking or deleting an incompletely verified tree.
    throw new Error(
      root === undefined ? "Fixture setup failed" : `Fixture setup failed; retained ${root}`,
      {
        cause:
          closureErrors.length === 0
            ? cause
            : new AggregateError(
                [cause, ...closureErrors],
                "Fixture setup and descriptor release failed",
              ),
      },
    );
  }
}

async function requireCanonicalDirectory(path: string): Promise<void> {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (await realpath(path)) !== path ||
    !(await lstat(path)).isDirectory()
  ) {
    throw new Error("Fixture paths must be canonical absolute directories without symlinks");
  }
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

async function ownDirectory(
  path: string,
  entries: OwnedEntry[],
  handles: FileHandle[],
): Promise<OwnedEntry> {
  const handle = await open(path, DIRECTORY_FLAGS);
  handles.push(handle);
  const entry = { path, handle, baseline: await handle.stat({ bigint: true }) };
  entries.push(entry);
  return entry;
}

async function ownFile(
  path: string,
  contents: Buffer,
  entries: OwnedEntry[],
  handles: FileHandle[],
): Promise<OwnedEntry> {
  const handle = await open(path, FILE_FLAGS, 0o600);
  handles.push(handle);
  const entry = { path, handle, baseline: await handle.stat({ bigint: true }) };
  entries.push(entry);
  await handle.writeFile(contents);
  return entry;
}

function sameIdentity(actual: BigIntStats, expected: BigIntStats): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.mode === expected.mode &&
    actual.uid === expected.uid &&
    actual.gid === expected.gid &&
    (!actual.isFile() || (actual.nlink === expected.nlink && actual.size === expected.size))
  );
}

async function requireInventory(path: string, expected: readonly string[]): Promise<void> {
  const found: string[] = [];
  const directory = await opendir(path);
  for await (const entry of directory) {
    found.push(entry.name);
    if (found.length > expected.length)
      throw new Error("Fixture inventory exceeded its fixed bound");
  }
  if (found.sort().join("\0") !== expected.join("\0")) throw new Error("Fixture inventory changed");
}

async function requireBytes(handle: FileHandle, expected: Buffer): Promise<void> {
  const actual = Buffer.alloc(expected.length + 1);
  let offset = 0;
  while (offset < actual.length) {
    const { bytesRead } = await handle.read(actual, offset, actual.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== expected.length || !actual.subarray(0, offset).equals(expected)) {
    throw new Error("Fixture bytes changed or exceeded their fixed bound");
  }
}

async function readOutcome(path: string): Promise<string> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.read(Buffer.alloc(1), 0, 1, 0);
      return "readable";
    } finally {
      await handle.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "unknown";
  }
}
