import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_PACKAGE_RELEASE_ARCHIVE_BYTES } from "../../domain/release/package-release-evidence.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import {
  buildLocalPackageRelease,
  LocalPackageReleaseBuilderError,
  type LocalPackageReleaseBuildResult,
} from "./local-package-release-builder.js";

export const PACKAGE_RELEASE_COMMAND_TIMEOUT_MS = 120_000;
export const PACKAGE_RELEASE_COMMAND_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type PackageReleaseCommandStage =
  | "parse release command"
  | "inspect release source"
  | "build package artifact"
  | "publish package artifact"
  | "settle package artifact";

export class PackageReleaseCommandError extends Error {
  override readonly name = "PackageReleaseCommandError";
  readonly code = "package_release_failed" as const;

  constructor(readonly stage: PackageReleaseCommandStage) {
    super(`Package release failed during ${stage}`);
  }
}

export interface PackageReleaseCommandExecuteOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv & { readonly npm_config_cache: string };
  readonly maxBuffer: number;
  readonly signal?: AbortSignal;
  readonly timeout: number;
}

export type PackageReleaseCommandExecute = (
  command: string,
  args: readonly string[],
  options: PackageReleaseCommandExecuteOptions,
) => Promise<{ readonly stdout: string }>;

export interface PackageReleaseCommandDependencies {
  readonly execute?: PackageReleaseCommandExecute;
  readonly repositoryRoot: string;
  readonly signal?: AbortSignal;
}

export async function runPackageReleaseCommand(
  args: readonly string[],
  dependencies: PackageReleaseCommandDependencies,
): Promise<LocalPackageReleaseBuildResult> {
  const parsed = parseCommandArguments(args);
  const repositoryRoot = resolve(dependencies.repositoryRoot);
  const execute = dependencies.execute ?? executeCommand;
  const baseOptions = {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_cache: join(tmpdir(), "flow-release-command-npm-cache") },
    maxBuffer: PACKAGE_RELEASE_COMMAND_MAX_OUTPUT_BYTES,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    timeout: PACKAGE_RELEASE_COMMAND_TIMEOUT_MS,
  } satisfies PackageReleaseCommandExecuteOptions;

  try {
    dependencies.signal?.throwIfAborted();
    const head = await execute("git", ["rev-parse", "HEAD"], baseOptions);
    dependencies.signal?.throwIfAborted();
    if (head.stdout.trim() !== parsed.sourceRevision) {
      throw new PackageReleaseCommandError("inspect release source");
    }
    const status = await execute(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      baseOptions,
    );
    dependencies.signal?.throwIfAborted();
    if (status.stdout.length !== 0) {
      throw new PackageReleaseCommandError("inspect release source");
    }
  } catch (error) {
    if (error instanceof PackageReleaseCommandError) throw error;
    throw new PackageReleaseCommandError("inspect release source");
  }

  try {
    return await buildLocalPackageRelease(
      {
        outputDirectory: resolve(repositoryRoot, parsed.outputDirectory),
        sourceRevision: parsed.sourceRevision,
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      },
      {
        buildArchive: async () =>
          await buildArchiveFromNpm(repositoryRoot, execute, dependencies.signal),
      },
    );
  } catch (error) {
    if (error instanceof LocalPackageReleaseBuilderError) {
      throw new PackageReleaseCommandError(error.stage);
    }
    if (error instanceof PackageReleaseCommandError) {
      throw error;
    }
    throw new PackageReleaseCommandError("build package artifact");
  }
}

function parseCommandArguments(args: readonly string[]): {
  readonly outputDirectory: "release/package";
  readonly sourceRevision: string;
} {
  if (
    args.length !== 4 ||
    args[0] !== "--output" ||
    args[1] !== "release/package" ||
    args[2] !== "--revision" ||
    args[3] === undefined ||
    !/^[a-f0-9]{40}$/.test(args[3])
  ) {
    throw new PackageReleaseCommandError("parse release command");
  }
  return { outputDirectory: "release/package", sourceRevision: args[3] };
}

async function buildArchiveFromNpm(
  repositoryRoot: string,
  execute: PackageReleaseCommandExecute,
  signal: AbortSignal | undefined,
): Promise<{ readonly archive: Buffer; readonly packOutput: unknown }> {
  const workspace = await mkdtemp(join(tmpdir(), "flow-package-release-"));
  let result: { readonly archive: Buffer; readonly packOutput: unknown } | undefined;
  let failed = false;
  try {
    const archiveDirectory = join(workspace, "archive");
    const npmCacheDirectory = join(workspace, "npm-cache");
    await mkdir(archiveDirectory, { mode: 0o700 });
    signal?.throwIfAborted();
    const packed = await execute(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", archiveDirectory],
      {
        cwd: repositoryRoot,
        env: { ...process.env, npm_config_cache: npmCacheDirectory },
        maxBuffer: PACKAGE_RELEASE_COMMAND_MAX_OUTPUT_BYTES,
        ...(signal === undefined ? {} : { signal }),
        timeout: PACKAGE_RELEASE_COMMAND_TIMEOUT_MS,
      },
    );
    signal?.throwIfAborted();
    if (Buffer.byteLength(packed.stdout, "utf8") > PACKAGE_RELEASE_COMMAND_MAX_OUTPUT_BYTES) {
      throw new Error("npm pack output exceeds its limit");
    }
    const packOutput = parseStrictJson(packed.stdout, {
      maxDepth: 8,
      maxNodes: 32_768,
      valueLabel: "npm pack output",
    });
    const entries = await readdir(archiveDirectory, { withFileTypes: true });
    if (
      entries.length !== 1 ||
      entries[0] === undefined ||
      !entries[0].isFile() ||
      !entries[0].name.endsWith(".tgz")
    ) {
      throw new Error("npm pack did not produce one regular archive");
    }
    const archive = await readBoundedArchive(join(archiveDirectory, entries[0].name));
    result = { archive, packOutput };
  } catch {
    failed = true;
  }

  try {
    await rm(workspace, { recursive: true, force: true });
  } catch {
    throw new PackageReleaseCommandError("settle package artifact");
  }
  if (failed || result === undefined) {
    throw new PackageReleaseCommandError("build package artifact");
  }
  return result;
}

async function readBoundedArchive(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat({ bigint: true });
    if (!file.isFile() || file.size < 1n || file.size > BigInt(MAX_PACKAGE_RELEASE_ARCHIVE_BYTES)) {
      throw new Error("packed archive is outside its byte limit");
    }
    const content = await handle.readFile();
    if (content.byteLength !== Number(file.size)) {
      throw new Error("packed archive changed while it was read");
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function executeCommand(
  command: string,
  args: readonly string[],
  options: PackageReleaseCommandExecuteOptions,
): Promise<{ readonly stdout: string }> {
  return await new Promise((resolveCommand, rejectCommand) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: options.env,
        maxBuffer: options.maxBuffer,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeout: options.timeout,
      },
      (error, stdout) => {
        if (error !== null) {
          rejectCommand(error);
          return;
        }
        resolveCommand({ stdout });
      },
    );
  });
}
