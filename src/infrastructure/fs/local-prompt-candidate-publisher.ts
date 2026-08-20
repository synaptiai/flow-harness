import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { link, lstat, open, readdir, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseAgentSkillCandidateText } from "../../domain/adaptation/agent-skill-candidate.js";
import {
  MAX_PROMPT_CANDIDATE_BYTES,
  parsePromptCandidateText,
} from "../../domain/adaptation/prompt-candidate.js";
import { parseSupplementalMemoryCandidateText } from "../../domain/adaptation/supplemental-memory-candidate.js";

const MAX_TEMPORARY_FILES = 16;
const MAX_TEMPORARY_BYTES = MAX_TEMPORARY_FILES * MAX_PROMPT_CANDIDATE_BYTES;
const STALE_TEMPORARY_MS = 60 * 60 * 1_000;
const UUID_V4_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RESERVED_OUTPUT_PATTERN = new RegExp(
  `^\\..+\\.generation\\.(?:${UUID_V4_PATTERN}\\.tmp|lock)$`,
);
const MAX_LOCK_BYTES = 512;

interface PublicationLock {
  readonly path: string;
  readonly identity: BigIntStats;
}

type PublicationLockRecovery = "active" | "recovered" | "retry";

export type LocalPromptCandidatePublisherErrorCode =
  | "cleanup_uncertain"
  | "invalid_output"
  | "invalid_source"
  | "io"
  | "output_exists"
  | "publication_uncertain"
  | "temporary_limit";

export class LocalPromptCandidatePublisherError extends Error {
  override readonly name = "LocalPromptCandidatePublisherError";

  constructor(
    readonly code: LocalPromptCandidatePublisherErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${boundedMessage(message)}`, options);
  }
}

export interface LocalPromptCandidatePublisherOptions {
  readonly afterPublishLink?: () => Promise<void> | void;
  readonly beforePublish?: () => Promise<void> | void;
  readonly beforeRecoverPublicationLock?: (path: string) => Promise<void> | void;
  readonly beforeReleaseLock?: (
    path: string,
    phase: "before-unlink" | "before-directory-sync",
  ) => Promise<void> | void;
  readonly beforeRetireTemporary?: (path: string) => Promise<void> | void;
  readonly duringAcquirePublicationLock?: (
    path: string,
    phase: "before-directory-sync" | "before-cleanup-unlink" | "before-cleanup-sync",
  ) => Promise<void> | void;
  readonly duringCompletedPublicationRecovery?: (
    phase: "after-dead-lock-validation" | "before-lock-release",
  ) => Promise<void> | void;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export async function assertLocalPromptCandidateOutputAvailable(
  outputPath: string,
  options: LocalPromptCandidatePublisherOptions = {},
): Promise<void> {
  const canonical = await canonicalOutputPath(outputPath);
  try {
    await lstat(canonical);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw new LocalPromptCandidatePublisherError(
      "io",
      `output path cannot be checked: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
  try {
    await recoverCompletedPublication(canonical, options);
  } catch (error) {
    throw new LocalPromptCandidatePublisherError(
      "publication_uncertain",
      `candidate output exists but publication cleanup did not settle: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
  throw new LocalPromptCandidatePublisherError(
    "output_exists",
    `output path "${canonical}" already exists`,
  );
}

export async function publishLocalPromptCandidate(
  outputPath: string,
  sourceText: string,
  options: LocalPromptCandidatePublisherOptions = {},
): Promise<void> {
  if (!isStrictGeneratedCandidate(sourceText)) {
    throw new LocalPromptCandidatePublisherError(
      "invalid_source",
      "generated candidate is invalid",
    );
  }
  const canonical = await canonicalOutputPath(outputPath);
  const root = dirname(canonical);
  const name = basename(canonical);
  throwIfAborted(options.signal);
  await assertLocalPromptCandidateOutputAvailable(canonical, options);
  const publicationLock = await acquirePublicationLock(
    root,
    name,
    options.beforeRecoverPublicationLock,
    options.duringAcquirePublicationLock,
  );
  let publicationCommitted = false;
  let publicationError: unknown;
  try {
    await assertLocalPromptCandidateOutputAvailable(canonical);
    await retireStaleTemporaryFiles(
      root,
      name,
      options.now?.() ?? Date.now(),
      Buffer.byteLength(sourceText, "utf8"),
      options,
    );
    throwIfAborted(options.signal);
    const temporary = join(root, `.${name}.generation.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let openedIdentity: BigIntStats | undefined;
    let writtenIdentity: BigIntStats | undefined;
    let linked = false;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      openedIdentity = await handle.stat({ bigint: true });
      await handle.writeFile(sourceText, "utf8");
      await handle.sync();
      writtenIdentity = await handle.stat({ bigint: true });
      await options.beforePublish?.();
      throwIfAborted(options.signal);
      const temporaryBeforeLink = await lstat(temporary, { bigint: true });
      if (!sameFileIdentity(writtenIdentity, temporaryBeforeLink)) {
        throw new LocalPromptCandidatePublisherError(
          "io",
          "candidate temporary file changed before publication",
        );
      }
      await link(temporary, canonical);
      linked = true;
      publicationCommitted = true;
      await options.afterPublishLink?.();
      throwIfAborted(options.signal);
      const finalIdentity = await lstat(canonical, { bigint: true });
      if (!samePublishedFileIdentity(writtenIdentity, finalIdentity)) {
        if (!(await unlinkFileWithIdentity(canonical, finalIdentity, samePublishedFileIdentity))) {
          throw new LocalPromptCandidatePublisherError(
            "publication_uncertain",
            "candidate final file changed before publication identity verification",
          );
        }
        await syncDirectory(root);
        linked = false;
        publicationCommitted = false;
        throw new LocalPromptCandidatePublisherError(
          "io",
          "candidate final file does not match the validated temporary file",
        );
      }
      await handle.close();
      handle = undefined;
      await syncDirectory(root);
      if (!(await unlinkFileWithIdentity(temporary, writtenIdentity, samePublishedFileIdentity))) {
        throw new LocalPromptCandidatePublisherError(
          "publication_uncertain",
          "candidate temporary file changed before cleanup",
        );
      }
      await syncDirectory(root);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (openedIdentity !== undefined) {
        await unlinkFileWithIdentity(temporary, openedIdentity, sameFileNodeIdentity).catch(
          () => false,
        );
      }
      if (!linked && options.signal?.aborted === true) {
        throw options.signal.reason ?? new Error("candidate publication was cancelled");
      }
      if (!linked && errorCode(error) === "EEXIST") {
        throw new LocalPromptCandidatePublisherError(
          "output_exists",
          `output path "${canonical}" already exists`,
          { cause: error },
        );
      }
      if (linked) {
        throw new LocalPromptCandidatePublisherError(
          "publication_uncertain",
          `candidate output is complete but directory synchronization did not settle: ${boundedMessage(error)}`,
          { cause: error },
        );
      }
      if (error instanceof LocalPromptCandidatePublisherError) {
        throw error;
      }
      throw new LocalPromptCandidatePublisherError(
        "io",
        `candidate output could not be published: ${boundedMessage(error)}`,
        { cause: error },
      );
    }
  } catch (error) {
    publicationError = error;
  }
  try {
    await releasePublicationLock(publicationLock, options.beforeReleaseLock);
  } catch (error) {
    if (publicationCommitted) {
      publicationError = new LocalPromptCandidatePublisherError(
        "publication_uncertain",
        `candidate output is complete but publication lock cleanup did not settle: ${boundedMessage(error)}`,
        { cause: error },
      );
    } else if (publicationError !== undefined) {
      publicationError = new LocalPromptCandidatePublisherError(
        "cleanup_uncertain",
        `candidate output was not committed after ${boundedMessage(publicationError)}, and publication lock cleanup did not settle: ${boundedMessage(error)}`,
        { cause: error },
      );
    } else if (publicationError === undefined) {
      publicationError = new LocalPromptCandidatePublisherError(
        "io",
        `candidate publication lock could not be released: ${boundedMessage(error)}`,
        { cause: error },
      );
    }
  }
  if (publicationError === undefined && options.signal?.aborted === true) {
    publicationError = publicationCommitted
      ? new LocalPromptCandidatePublisherError(
          "publication_uncertain",
          `candidate output is complete but cancellation was observed after commit: ${boundedMessage(options.signal.reason)}`,
          { cause: options.signal.reason },
        )
      : (options.signal.reason ?? new Error("candidate publication was cancelled"));
  }
  if (publicationError !== undefined) {
    throw publicationError;
  }
}

function isStrictGeneratedCandidate(sourceText: string): boolean {
  try {
    parsePromptCandidateText(sourceText, "generated prompt candidate");
    return true;
  } catch {
    try {
      parseAgentSkillCandidateText(sourceText, "generated Agent Skill candidate");
      return true;
    } catch {
      try {
        return (
          parseSupplementalMemoryCandidateText(
            sourceText,
            "generated supplemental-memory candidate",
          ).generation !== undefined
        );
      } catch {
        return false;
      }
    }
  }
}

async function canonicalOutputPath(outputPath: string): Promise<string> {
  const absolute = resolve(outputPath);
  const outputName = basename(absolute);
  if (RESERVED_OUTPUT_PATTERN.test(outputName)) {
    throw new LocalPromptCandidatePublisherError(
      "invalid_output",
      "output name is reserved for candidate publication recovery",
    );
  }
  let root: string;
  try {
    root = await realpath(dirname(absolute));
  } catch (error) {
    throw new LocalPromptCandidatePublisherError(
      "io",
      `output directory cannot be resolved: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
  return join(root, outputName);
}

async function recoverCompletedPublication(
  canonical: string,
  options: LocalPromptCandidatePublisherOptions,
): Promise<void> {
  const root = dirname(canonical);
  const outputName = basename(canonical);
  const lockPath = join(root, `.${outputName}.generation.lock`);
  let observed: Awaited<ReturnType<typeof readPublicationLock>>;
  try {
    observed = await readPublicationLock(lockPath);
  } catch (error) {
    if (causedByErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (observed.record.hostname !== hostname() || isProcessAlive(observed.record.pid)) {
    return;
  }
  const currentLock = await lstat(lockPath, { bigint: true });
  if (!sameSymbolicLinkIdentity(observed.identity, currentLock)) {
    return;
  }
  await options.beforeRecoverPublicationLock?.(lockPath);
  await options.duringCompletedPublicationRecovery?.("after-dead-lock-validation");
  const finalIdentity = await lstat(canonical, { bigint: true });
  const pattern = new RegExp(
    `^\\.${escapeRegularExpression(outputName)}\\.generation\\.${UUID_V4_PATTERN}\\.tmp$`,
  );
  const temporaryNames = (await readdir(root)).filter((name) => pattern.test(name));
  if (temporaryNames.length > MAX_TEMPORARY_FILES) {
    throw new LocalPromptCandidatePublisherError(
      "temporary_limit",
      `completed candidate has ${temporaryNames.length} temporary files, above the ${MAX_TEMPORARY_FILES} file limit`,
    );
  }
  let removed = false;
  for (const name of temporaryNames) {
    removed =
      (await unlinkFileWithIdentity(join(root, name), finalIdentity, samePublishedFileIdentity)) ||
      removed;
  }
  if (removed) {
    await syncDirectory(root);
  }
  await options.duringCompletedPublicationRecovery?.("before-lock-release");
  try {
    await releasePublicationLock({ path: lockPath, identity: observed.identity });
  } catch (error) {
    if (!causedByErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function acquirePublicationLock(
  root: string,
  outputName: string,
  beforeRecover?: LocalPromptCandidatePublisherOptions["beforeRecoverPublicationLock"],
  duringAcquire?: LocalPromptCandidatePublisherOptions["duringAcquirePublicationLock"],
): Promise<PublicationLock> {
  const path = join(root, `.${outputName}.generation.lock`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    const owner = JSON.stringify({ version: 1, hostname: hostname(), pid: process.pid, token });
    if (Buffer.byteLength(owner, "utf8") > MAX_LOCK_BYTES) {
      throw new LocalPromptCandidatePublisherError(
        "io",
        "candidate publication lock owner metadata exceeds its byte limit",
      );
    }
    let created = false;
    try {
      await symlink(owner, path);
      created = true;
      const identity = await lstat(path, { bigint: true });
      await duringAcquire?.(path, "before-directory-sync");
      await syncDirectory(root);
      return { path, identity };
    } catch (error) {
      if (created) {
        try {
          await duringAcquire?.(path, "before-cleanup-unlink");
          await unlink(path);
          await duringAcquire?.(path, "before-cleanup-sync");
          await syncDirectory(root);
        } catch (cleanupError) {
          throw new LocalPromptCandidatePublisherError(
            "cleanup_uncertain",
            `candidate publication lock acquisition failed after ${boundedMessage(error)}, and lock cleanup did not settle: ${boundedMessage(cleanupError)}`,
            { cause: cleanupError },
          );
        }
      }
      if (errorCode(error) !== "EEXIST") {
        throw new LocalPromptCandidatePublisherError(
          "io",
          `candidate publication lock cannot be created: ${boundedMessage(error)}`,
          { cause: error },
        );
      }
      const recovery = await recoverPublicationLock(path, beforeRecover);
      if (recovery === "active") {
        throw new LocalPromptCandidatePublisherError(
          "temporary_limit",
          "candidate output has an active publication",
        );
      }
    }
  }
  throw new LocalPromptCandidatePublisherError(
    "temporary_limit",
    "candidate publication lock changed repeatedly during recovery",
  );
}

async function recoverPublicationLock(
  path: string,
  beforeRecover?: LocalPromptCandidatePublisherOptions["beforeRecoverPublicationLock"],
): Promise<PublicationLockRecovery> {
  try {
    const { identity, record } = await readPublicationLock(path);
    if (record.hostname !== hostname() || isProcessAlive(record.pid)) {
      return "active";
    }
    const current = await lstat(path, { bigint: true });
    if (!sameSymbolicLinkIdentity(identity, current)) {
      return "retry";
    }
    await beforeRecover?.(path);
    await unlink(path);
    await syncDirectory(dirname(path));
    return "recovered";
  } catch (error) {
    if (causedByErrorCode(error, "ENOENT")) {
      return "retry";
    }
    if (error instanceof LocalPromptCandidatePublisherError) {
      throw error;
    }
    throw new LocalPromptCandidatePublisherError(
      "temporary_limit",
      `candidate publication lock cannot be recovered safely: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
}

async function readPublicationLock(path: string): Promise<{
  readonly identity: BigIntStats;
  readonly record: { readonly hostname: string; readonly pid: number };
}> {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    throw new LocalPromptCandidatePublisherError(
      "temporary_limit",
      `candidate publication lock cannot be read safely: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
  if (!before.isSymbolicLink() || before.size > BigInt(MAX_LOCK_BYTES)) {
    throw new LocalPromptCandidatePublisherError(
      "temporary_limit",
      "candidate publication lock has an invalid file type or size",
    );
  }
  const owner = await readlink(path, "utf8");
  const after = await lstat(path, { bigint: true });
  if (
    Buffer.byteLength(owner, "utf8") > MAX_LOCK_BYTES ||
    !sameSymbolicLinkIdentity(before, after)
  ) {
    throw new LocalPromptCandidatePublisherError(
      "temporary_limit",
      "candidate publication lock changed while it was read",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(owner);
  } catch (error) {
    throw new LocalPromptCandidatePublisherError(
      "temporary_limit",
      `candidate publication lock is invalid: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Object.keys(raw).sort().join(",") !== "hostname,pid,token,version" ||
    (raw as { version?: unknown }).version !== 1 ||
    typeof (raw as { hostname?: unknown }).hostname !== "string" ||
    !Number.isSafeInteger((raw as { pid?: unknown }).pid) ||
    Number((raw as { pid?: unknown }).pid) <= 0 ||
    typeof (raw as { token?: unknown }).token !== "string" ||
    !new RegExp(`^${UUID_V4_PATTERN}$`).test(String((raw as { token?: unknown }).token))
  ) {
    throw new LocalPromptCandidatePublisherError(
      "temporary_limit",
      "candidate publication lock has invalid owner metadata",
    );
  }
  return {
    identity: before,
    record: {
      hostname: String((raw as { hostname: string }).hostname),
      pid: Number((raw as { pid: number }).pid),
    },
  };
}

async function releasePublicationLock(
  lock: PublicationLock,
  beforeRelease?: LocalPromptCandidatePublisherOptions["beforeReleaseLock"],
): Promise<void> {
  await beforeRelease?.(lock.path, "before-unlink");
  const current = await lstat(lock.path, { bigint: true });
  if (!sameSymbolicLinkIdentity(lock.identity, current)) {
    throw new LocalPromptCandidatePublisherError(
      "publication_uncertain",
      "candidate publication lock changed before release",
    );
  }
  await unlink(lock.path);
  await beforeRelease?.(lock.path, "before-directory-sync");
  await syncDirectory(dirname(lock.path));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function retireStaleTemporaryFiles(
  root: string,
  outputName: string,
  now: number,
  reservedBytes: number,
  options: LocalPromptCandidatePublisherOptions,
): Promise<void> {
  const pattern = new RegExp(
    `^\\.${escapeRegularExpression(outputName)}\\.generation\\.${UUID_V4_PATTERN}\\.tmp$`,
  );
  const names = (await readdir(root)).filter((name) => pattern.test(name));
  if (names.length > MAX_TEMPORARY_FILES) {
    throw new LocalPromptCandidatePublisherError(
      "temporary_limit",
      `candidate output has ${names.length} temporary files, above the ${MAX_TEMPORARY_FILES} file limit`,
    );
  }

  const observations: Array<{
    readonly path: string;
    readonly observation: BigIntStats;
  }> = [];
  let totalBytes = 0n;
  for (const name of names) {
    const path = join(root, name);
    const observation = await lstat(path, { bigint: true });
    if (!observation.isFile() || observation.isSymbolicLink()) {
      throw new LocalPromptCandidatePublisherError(
        "temporary_limit",
        `candidate temporary path "${path}" is not a regular no-follow file`,
      );
    }
    if (observation.size > BigInt(MAX_PROMPT_CANDIDATE_BYTES)) {
      throw new LocalPromptCandidatePublisherError(
        "temporary_limit",
        `candidate temporary path "${path}" exceeds the per-file byte limit`,
      );
    }
    totalBytes += observation.size;
    if (totalBytes > BigInt(MAX_TEMPORARY_BYTES)) {
      throw new LocalPromptCandidatePublisherError(
        "temporary_limit",
        `candidate temporary files exceed the ${MAX_TEMPORARY_BYTES} byte limit`,
      );
    }
    observations.push({ path, observation });
  }

  let retained = observations.length;
  let retainedBytes = totalBytes;
  const nowNanoseconds = BigInt(Math.trunc(now)) * 1_000_000n;
  for (const entry of observations) {
    if (nowNanoseconds - entry.observation.mtimeNs < BigInt(STALE_TEMPORARY_MS) * 1_000_000n) {
      continue;
    }
    await options.beforeRetireTemporary?.(entry.path);
    const current = await lstat(entry.path, { bigint: true });
    if (!sameFileIdentity(entry.observation, current)) {
      throw new LocalPromptCandidatePublisherError(
        "io",
        `candidate temporary path "${entry.path}" changed during stale recovery`,
      );
    }
    await unlink(entry.path);
    retained -= 1;
    retainedBytes -= entry.observation.size;
  }
  if (retained >= MAX_TEMPORARY_FILES) {
    throw new LocalPromptCandidatePublisherError(
      "temporary_limit",
      `candidate output has ${retained} active or recent temporary files`,
    );
  }
  if (retainedBytes + BigInt(reservedBytes) > BigInt(MAX_TEMPORARY_BYTES)) {
    throw new LocalPromptCandidatePublisherError(
      "temporary_limit",
      "candidate output and retained temporary files exceed their total byte limit",
    );
  }
}

function sameSymbolicLinkIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isSymbolicLink() &&
    right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileNodeIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function samePublishedFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileNodeIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs
  );
}

async function unlinkFileWithIdentity(
  path: string,
  identity: BigIntStats,
  matches: (left: BigIntStats, right: BigIntStats) => boolean,
): Promise<boolean> {
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!matches(identity, current)) {
    return false;
  }
  await unlink(path);
  return true;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("candidate publication was cancelled");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function causedByErrorCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (errorCode(current) === code) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
    if (current === undefined) {
      return false;
    }
  }
  return false;
}

function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048);
}
