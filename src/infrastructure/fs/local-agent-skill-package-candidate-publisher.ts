import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  type AgentSkillPackageCandidateSource,
  parseAgentSkillPackageCandidateText,
} from "../../domain/adaptation/agent-skill-package-candidate.js";
import {
  type AgentSkillPackageSnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../domain/capability/agent-skills.js";
import { admitLocalAgentSkillPackageCandidate } from "./local-agent-skill-package-candidate.js";

const RESERVED_OUTPUT_PATTERN = /^\..+\.generation\.(?:[0-9a-f-]+\.tmp|lock)$/;

export type LocalAgentSkillPackageCandidatePublisherErrorCode =
  | "cleanup_uncertain"
  | "invalid_output"
  | "invalid_source"
  | "io"
  | "output_exists"
  | "publication_uncertain";

export class LocalAgentSkillPackageCandidatePublisherError extends Error {
  override readonly name = "LocalAgentSkillPackageCandidatePublisherError";

  constructor(
    readonly code: LocalAgentSkillPackageCandidatePublisherErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface LocalAgentSkillPackageCandidatePublisherOptions {
  readonly signal?: AbortSignal;
  readonly revalidate?: () => Promise<void> | void;
  /** @internal Deterministic lock-acquisition cancellation seam. */
  readonly afterLockCreated?: () => Promise<void> | void;
  readonly beforePublish?: () => Promise<void> | void;
  readonly afterPublish?: () => Promise<void> | void;
}

export interface LocalAgentSkillPackageCandidatePublication {
  readonly outputPath: string;
  readonly status: "settled";
}

export async function assertLocalAgentSkillPackageCandidateOutputAvailable(
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const canonical = await canonicalOutputPath(outputPath, signal);
  await assertOutputAbsent(canonical, signal);
  const lockPath = join(dirname(canonical), `.${basename(canonical)}.generation.lock`);
  try {
    await lstat(lockPath);
  } catch (error) {
    signal?.throwIfAborted();
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw new LocalAgentSkillPackageCandidatePublisherError(
      "io",
      "candidate publication lock availability could not be checked",
    );
  }
  throw new LocalAgentSkillPackageCandidatePublisherError(
    "io",
    "candidate output has an active or unsettled publication",
  );
}

export async function publishLocalAgentSkillPackageCandidate(
  outputPath: string,
  rawSource: AgentSkillPackageCandidateSource,
  rawPackage: AgentSkillPackageSnapshot,
  options: LocalAgentSkillPackageCandidatePublisherOptions = {},
): Promise<LocalAgentSkillPackageCandidatePublication> {
  throwIfAborted(options.signal);
  const source = parseSource(rawSource);
  const skill = parsePackage(rawPackage);
  if (
    source.package.path !== skill.provenance ||
    source.package.packageDigest !== skill.digest ||
    source.scope.skillName !== skill.name
  ) {
    throw new LocalAgentSkillPackageCandidatePublisherError(
      "invalid_source",
      "candidate package identity does not match",
    );
  }
  const canonical = await canonicalOutputPath(outputPath, options.signal);
  const root = dirname(canonical);
  const outputName = basename(canonical);
  throwIfAborted(options.signal);
  await assertLocalAgentSkillPackageCandidateOutputAvailable(canonical, options.signal);
  const lockPath = join(root, `.${outputName}.generation.lock`);
  const lock = await acquireLock(lockPath, root, options.signal, options.afterLockCreated);
  const temporary = join(root, `.${outputName}.generation.${randomUUID()}.tmp`);
  let committed = false;
  let operationError: unknown;
  try {
    await assertOutputAbsent(canonical, options.signal);
    await mkdir(temporary, { mode: 0o700 });
    await writeCandidateTree(temporary, source, skill, options.signal);
    await options.revalidate?.();
    throwIfAborted(options.signal);
    await options.beforePublish?.();
    throwIfAborted(options.signal);
    const staged = await admitLocalAgentSkillPackageCandidate(temporary, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await staged.revalidate();
    await options.revalidate?.();
    throwIfAborted(options.signal);
    await staged.revalidate();
    throwIfAborted(options.signal);
    await assertOutputAbsent(canonical, options.signal);
    await rename(temporary, canonical);
    committed = true;
    await options.afterPublish?.();
    throwIfAborted(options.signal);
    await syncDirectory(root);
  } catch (error) {
    operationError = error;
  }

  if (!committed) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
  let lockError: unknown;
  try {
    await releaseLock(lockPath, lock, root);
  } catch (error) {
    lockError = error;
  }

  if (committed && (operationError !== undefined || lockError !== undefined)) {
    throw new LocalAgentSkillPackageCandidatePublisherError(
      "publication_uncertain",
      "candidate directory is complete but publication settlement is uncertain",
    );
  }
  if (operationError !== undefined) {
    if (lockError !== undefined) {
      throw new LocalAgentSkillPackageCandidatePublisherError(
        "cleanup_uncertain",
        "candidate directory was not committed and publication cleanup is uncertain",
      );
    }
    throwIfAborted(options.signal);
    if (operationError instanceof LocalAgentSkillPackageCandidatePublisherError) {
      throw operationError;
    }
    throw new LocalAgentSkillPackageCandidatePublisherError(
      "io",
      "candidate directory could not be published",
    );
  }
  if (lockError !== undefined) {
    throw new LocalAgentSkillPackageCandidatePublisherError(
      "cleanup_uncertain",
      "candidate publication lock cleanup is uncertain",
    );
  }
  return Object.freeze({ outputPath: canonical, status: "settled" });
}

function parseSource(
  rawSource: AgentSkillPackageCandidateSource,
): AgentSkillPackageCandidateSource {
  try {
    return parseAgentSkillPackageCandidateText(JSON.stringify(rawSource));
  } catch {
    throw new LocalAgentSkillPackageCandidatePublisherError(
      "invalid_source",
      "candidate manifest is invalid",
    );
  }
}

function parsePackage(rawPackage: AgentSkillPackageSnapshot): AgentSkillPackageSnapshot {
  try {
    const snapshot = validateCapabilitySnapshot({
      version: 1,
      packages: [rawPackage],
      digest: calculateCapabilitySnapshotDigest([rawPackage]),
    });
    const skill = snapshot.packages[0];
    if (snapshot.packages.length !== 1 || skill?.kind !== "agent-skill") {
      throw new Error("candidate package is unavailable");
    }
    return skill;
  } catch {
    throw new LocalAgentSkillPackageCandidatePublisherError(
      "invalid_source",
      "candidate package is invalid",
    );
  }
}

async function canonicalOutputPath(
  outputPath: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const absolute = resolve(outputPath);
  const outputName = basename(absolute);
  if (
    outputName.length === 0 ||
    outputName === "." ||
    outputName === ".." ||
    RESERVED_OUTPUT_PATTERN.test(outputName)
  ) {
    throw new LocalAgentSkillPackageCandidatePublisherError(
      "invalid_output",
      "candidate output name is invalid",
    );
  }
  let root: string;
  try {
    root = await realpath(dirname(absolute));
  } catch {
    signal?.throwIfAborted();
    throw new LocalAgentSkillPackageCandidatePublisherError(
      "invalid_output",
      "candidate output directory is invalid",
    );
  }
  signal?.throwIfAborted();
  return join(root, outputName);
}

async function assertOutputAbsent(
  outputPath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await lstat(outputPath);
  } catch (error) {
    signal?.throwIfAborted();
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw new LocalAgentSkillPackageCandidatePublisherError(
      "io",
      "candidate output availability could not be checked",
    );
  }
  throw new LocalAgentSkillPackageCandidatePublisherError(
    "output_exists",
    "candidate output already exists",
  );
}

async function acquireLock(
  lockPath: string,
  root: string,
  signal: AbortSignal | undefined,
  afterLockCreated: LocalAgentSkillPackageCandidatePublisherOptions["afterLockCreated"],
): Promise<BigIntStats> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  let identity: BigIntStats | undefined;
  try {
    handle = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    identity = await handle.stat({ bigint: true });
    await afterLockCreated?.();
    signal?.throwIfAborted();
    await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const current = await lstat(lockPath, { bigint: true });
    signal?.throwIfAborted();
    if (!sameIdentity(identity, current)) {
      throw new Error("publication lock identity changed during acquisition");
    }
    await syncDirectory(root);
    return identity;
  } catch (error) {
    if (created && identity === undefined && handle !== undefined) {
      identity = await handle.stat({ bigint: true }).catch(() => undefined);
    }
    await handle?.close().catch(() => undefined);
    if (created && identity === undefined) {
      throw new LocalAgentSkillPackageCandidatePublisherError(
        "cleanup_uncertain",
        "candidate publication lock ownership is uncertain after creation",
      );
    }
    if (identity !== undefined) {
      try {
        const current = await lstat(lockPath, { bigint: true });
        if (!sameIdentity(identity, current)) {
          throw new Error("publication lock identity changed before acquisition cleanup");
        }
        await unlink(lockPath);
        await syncDirectory(root);
      } catch {
        throw new LocalAgentSkillPackageCandidatePublisherError(
          "cleanup_uncertain",
          "candidate publication lock acquisition cleanup is uncertain",
        );
      }
    }
    signal?.throwIfAborted();
    if (errorCode(error) === "EEXIST") {
      throw new LocalAgentSkillPackageCandidatePublisherError(
        "io",
        "candidate output has an active or unsettled publication",
      );
    }
    throw new LocalAgentSkillPackageCandidatePublisherError(
      "io",
      "candidate publication lock could not be acquired",
    );
  }
}

async function releaseLock(lockPath: string, identity: BigIntStats, root: string): Promise<void> {
  const current = await lstat(lockPath, { bigint: true });
  if (!sameIdentity(identity, current)) {
    throw new Error("publication lock identity changed");
  }
  await unlink(lockPath);
  await syncDirectory(root);
}

async function writeCandidateTree(
  root: string,
  source: AgentSkillPackageCandidateSource,
  skill: AgentSkillPackageSnapshot,
  signal: AbortSignal | undefined,
): Promise<void> {
  await writeDurableFile(
    join(root, "CANDIDATE.json"),
    Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8"),
    signal,
  );
  const packageRoot = join(root, "skill", skill.name);
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  const directories = new Set<string>([root, join(root, "skill"), packageRoot]);
  for (const file of skill.files) {
    signal?.throwIfAborted();
    const segments = file.path.split("/");
    let parent = packageRoot;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      await mkdir(parent, { mode: 0o700 });
      directories.add(parent);
    }
    await writeDurableFile(
      join(packageRoot, ...segments),
      Buffer.from(file.contentBase64, "base64"),
      signal,
    );
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    signal?.throwIfAborted();
    await syncDirectory(directory);
  }
}

async function writeDurableFile(
  path: string,
  content: Buffer,
  signal: AbortSignal | undefined,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    signal?.throwIfAborted();
    await handle.writeFile(content);
    signal?.throwIfAborted();
    await handle.sync();
  } finally {
    await handle?.close();
  }
  signal?.throwIfAborted();
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}
