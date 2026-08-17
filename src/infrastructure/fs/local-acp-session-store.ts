import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isValidApprovalActor } from "../../domain/approval/command-approval.js";
import {
  parseStrictJson,
  type StrictJsonObject,
  type StrictJsonValue,
} from "../../domain/strict-json.js";

export const ACP_SESSION_API_VERSION = "flow.acp.session/v1";
export const MAX_ACP_SESSION_RECORD_BYTES = 16_384;
export const MAX_ACP_SESSION_STORE_ENTRIES = 2_048;
export const MAX_ACP_SESSION_LIST_RESULTS = 256;

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RECORD_KEYS = [
  "actor",
  "apiVersion",
  "createdAt",
  "descriptorDigest",
  "policyDigest",
  "projectRoot",
  "runId",
  "sessionId",
] as const;
const sessionCreationTails = new Map<string, Promise<void>>();

export interface AcpSessionDescriptor {
  readonly apiVersion: typeof ACP_SESSION_API_VERSION;
  readonly sessionId: string;
  readonly runId: string;
  readonly projectRoot: string;
  readonly policyDigest: string;
  readonly actor: string;
  readonly createdAt: string;
  readonly descriptorDigest: string;
}

export interface CreateAcpSessionInput {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly policyDigest: string;
  readonly actor: string;
  readonly createdAt: string;
}

export interface AcpSessionExpectedIdentity {
  readonly projectRoot: string;
  readonly policyDigest: string;
}

export interface LocalAcpSessionStoreHooks {
  readonly afterCreationQueued?: () => void | Promise<void>;
  readonly beforePublish?: () => void | Promise<void>;
  readonly afterPublish?: () => void | Promise<void>;
}

export interface LocalAcpSessionStoreOptions extends LocalAcpSessionStoreHooks {
  readonly maxEntries?: number;
}

export interface AcpSessionListPage {
  readonly sessions: readonly AcpSessionDescriptor[];
  readonly cursor: string | undefined;
}

export type LocalAcpSessionStoreErrorCode =
  | "conflict"
  | "invalid_cursor"
  | "invalid_session"
  | "io"
  | "limit_exceeded"
  | "not_found"
  | "policy_mismatch"
  | "project_mismatch"
  | "publication_uncertain";

export class LocalAcpSessionStoreError extends Error {
  override readonly name = "LocalAcpSessionStoreError";

  constructor(readonly code: LocalAcpSessionStoreErrorCode) {
    super(storeMessage(code));
  }
}

export class LocalAcpSessionStore {
  readonly #hooks: LocalAcpSessionStoreHooks;
  readonly #maxEntries: number;
  readonly #sessionsRoot: string;

  constructor(rootDirectory: string, options: LocalAcpSessionStoreOptions = {}) {
    if (!isAbsolute(rootDirectory) || resolve(rootDirectory) !== rootDirectory) {
      throw new LocalAcpSessionStoreError("invalid_session");
    }
    this.#sessionsRoot = join(rootDirectory, ".acp-sessions");
    this.#maxEntries = parseMaximumEntries(options.maxEntries ?? MAX_ACP_SESSION_STORE_ENTRIES);
    this.#hooks = options;
  }

  async create(
    input: CreateAcpSessionInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AcpSessionDescriptor> {
    const descriptor = createDescriptor(input);
    const encoded = Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8");
    if (encoded.byteLength > MAX_ACP_SESSION_RECORD_BYTES) {
      throw new LocalAcpSessionStoreError("limit_exceeded");
    }
    options.signal?.throwIfAborted();
    await this.#ensureRoot(options.signal);
    options.signal?.throwIfAborted();

    return await withSessionCreationTurn(
      this.#sessionsRoot,
      options.signal,
      this.#hooks.afterCreationQueued,
      async () => {
        const existing = await this.#readExistingForCreate(descriptor, options.signal);
        if (existing !== undefined) {
          return existing;
        }
        await this.#assertCreationCapacity(options.signal);
        return await this.#publish(descriptor, encoded, options.signal);
      },
    );
  }

  async #publish(
    descriptor: AcpSessionDescriptor,
    encoded: Buffer,
    signal: AbortSignal | undefined,
  ): Promise<AcpSessionDescriptor> {
    signal?.throwIfAborted();

    const target = this.#recordPath(descriptor.sessionId);
    const temporary = join(this.#sessionsRoot, `.pending-${randomUUID()}`);
    let handle: FileHandle | undefined;
    let durable = false;
    let hasPrimaryError = false;
    let primaryError: unknown;
    let result: AcpSessionDescriptor | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      signal?.throwIfAborted();
      await handle.writeFile(encoded);
      signal?.throwIfAborted();
      await handle.sync();
      signal?.throwIfAborted();
      await handle.close();
      handle = undefined;
      await this.#hooks.beforePublish?.();
      signal?.throwIfAborted();
      try {
        await link(temporary, target);
        durable = true;
        result = descriptor;
      } catch (error) {
        if (!isFileExists(error)) {
          throw error;
        }
        const existing = await this.#readRecord(descriptor.sessionId, undefined);
        if (!isDeepStrictEqual(existing, descriptor)) {
          throw new LocalAcpSessionStoreError("conflict");
        }
        durable = true;
        result = existing;
      }
      if (result === descriptor) {
        await this.#hooks.afterPublish?.();
      }
    } catch (error) {
      hasPrimaryError = true;
      primaryError = error;
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          if (!hasPrimaryError) {
            hasPrimaryError = true;
            primaryError = new LocalAcpSessionStoreError("io");
          }
        }
      }
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isMissing(error) && !hasPrimaryError) {
          hasPrimaryError = true;
          primaryError = new LocalAcpSessionStoreError(durable ? "publication_uncertain" : "io");
        }
      }
    }

    if (hasPrimaryError) {
      if (durable) {
        throw new LocalAcpSessionStoreError("publication_uncertain");
      }
      signal?.throwIfAborted();
      throw normalizeStoreError(primaryError);
    }
    if (result === undefined) {
      throw new LocalAcpSessionStoreError("io");
    }
    return result;
  }

  async #readExistingForCreate(
    descriptor: AcpSessionDescriptor,
    signal: AbortSignal | undefined,
  ): Promise<AcpSessionDescriptor | undefined> {
    try {
      const existing = await this.#readRecord(descriptor.sessionId, signal);
      if (!isDeepStrictEqual(existing, descriptor)) {
        throw new LocalAcpSessionStoreError("conflict");
      }
      return existing;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof LocalAcpSessionStoreError && error.code === "not_found") {
        return undefined;
      }
      throw error;
    }
  }

  async #assertCreationCapacity(signal: AbortSignal | undefined): Promise<void> {
    let entries = 0;
    try {
      const directory = await opendir(this.#sessionsRoot);
      signal?.throwIfAborted();
      for await (const _entry of directory) {
        signal?.throwIfAborted();
        entries += 1;
        if (entries >= this.#maxEntries) {
          throw new LocalAcpSessionStoreError("limit_exceeded");
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      throw normalizeStoreError(error);
    }
  }

  async read(
    sessionId: string,
    expected: AcpSessionExpectedIdentity,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AcpSessionDescriptor> {
    parseSessionId(sessionId);
    parseExpected(expected);
    options.signal?.throwIfAborted();
    await this.#ensureRoot(options.signal);
    options.signal?.throwIfAborted();
    const descriptor = await this.#readRecord(sessionId, options.signal);
    assertExpected(descriptor, expected);
    return descriptor;
  }

  async list(
    input: AcpSessionExpectedIdentity & {
      readonly after?: string;
      readonly limit: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<AcpSessionListPage> {
    parseExpected(input);
    const limit = parseListLimit(input.limit);
    if (input.after !== undefined) {
      parseSessionId(input.after, "invalid_cursor");
    }
    input.signal?.throwIfAborted();
    await this.#ensureRoot(input.signal);
    input.signal?.throwIfAborted();

    const names: string[] = [];
    let entries = 0;
    try {
      const directory = await opendir(this.#sessionsRoot);
      input.signal?.throwIfAborted();
      for await (const entry of directory) {
        input.signal?.throwIfAborted();
        entries += 1;
        if (entries > this.#maxEntries) {
          throw new LocalAcpSessionStoreError("limit_exceeded");
        }
        const sessionId = sessionIdFromRecordName(entry.name);
        if (sessionId !== undefined) {
          names.push(sessionId);
        }
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      throw normalizeStoreError(error);
    }
    input.signal?.throwIfAborted();
    names.sort();

    let start = 0;
    if (input.after !== undefined) {
      const cursorIndex = names.indexOf(input.after);
      if (cursorIndex === -1) {
        throw new LocalAcpSessionStoreError("invalid_cursor");
      }
      start = cursorIndex + 1;
    }
    const selected = names.slice(start, start + limit);
    const sessions: AcpSessionDescriptor[] = [];
    for (const sessionId of selected) {
      input.signal?.throwIfAborted();
      const descriptor = await this.#readRecord(sessionId, input.signal);
      assertExpected(descriptor, input);
      sessions.push(descriptor);
    }
    return {
      sessions,
      cursor: start + selected.length < names.length ? selected.at(-1) : undefined,
    };
  }

  async #ensureRoot(signal: AbortSignal | undefined): Promise<void> {
    try {
      await mkdir(this.#sessionsRoot, { recursive: true, mode: 0o700 });
      signal?.throwIfAborted();
      const observed = await lstat(this.#sessionsRoot, { bigint: true });
      signal?.throwIfAborted();
      if (!observed.isDirectory() || observed.isSymbolicLink()) {
        throw new LocalAcpSessionStoreError("invalid_session");
      }
      if ((observed.mode & 0o077n) !== 0n) {
        throw new LocalAcpSessionStoreError("invalid_session");
      }
    } catch (error) {
      signal?.throwIfAborted();
      throw normalizeStoreError(error);
    }
  }

  async #readRecord(
    sessionId: string,
    signal: AbortSignal | undefined,
  ): Promise<AcpSessionDescriptor> {
    const path = this.#recordPath(sessionId);
    let bytes: Buffer;
    try {
      bytes = await readBoundedStableFile(path, MAX_ACP_SESSION_RECORD_BYTES, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof LocalAcpSessionStoreError) {
        throw error;
      }
      if (isMissing(error)) {
        throw new LocalAcpSessionStoreError("not_found");
      }
      if (isSymbolicLinkError(error)) {
        throw new LocalAcpSessionStoreError("invalid_session");
      }
      throw new LocalAcpSessionStoreError("io");
    }
    signal?.throwIfAborted();
    return parseDescriptor(bytes, sessionId);
  }

  #recordPath(sessionId: string): string {
    return join(this.#sessionsRoot, `${sessionId}.json`);
  }
}

async function withSessionCreationTurn<T>(
  key: string,
  signal: AbortSignal | undefined,
  afterQueued: (() => void | Promise<void>) | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sessionCreationTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = previous.then(() => turn);
  sessionCreationTails.set(key, tail);
  void tail.then(() => {
    if (sessionCreationTails.get(key) === tail) {
      sessionCreationTails.delete(key);
    }
  });
  try {
    await afterQueued?.();
    await waitForCreationTurn(previous, signal);
    signal?.throwIfAborted();
    return await operation();
  } finally {
    release();
  }
}

async function waitForCreationTurn(
  previous: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await previous;
    return;
  }
  signal.throwIfAborted();
  let rejectAbort = (_error: unknown): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([previous, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBoundedStableFile(
  path: string,
  maximumBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let hasPrimaryError = false;
  let primaryError: unknown;
  let result: Buffer | undefined;
  try {
    signal?.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    assertRecordMetadata(before, maximumBytes);
    const content = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < content.byteLength) {
      signal?.throwIfAborted();
      const read = await handle.read(content, offset, content.byteLength - offset, offset);
      signal?.throwIfAborted();
      if (read.bytesRead === 0) {
        break;
      }
      offset += read.bytesRead;
    }
    if (offset > maximumBytes) {
      throw new LocalAcpSessionStoreError("limit_exceeded");
    }
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    const current = await lstat(path, { bigint: true });
    signal?.throwIfAborted();
    if (!sameObservation(before, after) || !sameObservation(after, current)) {
      throw new LocalAcpSessionStoreError("invalid_session");
    }
    result = content.subarray(0, offset);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  try {
    await handle.close();
  } catch {
    if (!hasPrimaryError) {
      throw new LocalAcpSessionStoreError("io");
    }
  }
  if (hasPrimaryError) {
    signal?.throwIfAborted();
    throw primaryError;
  }
  signal?.throwIfAborted();
  if (result === undefined) {
    throw new LocalAcpSessionStoreError("io");
  }
  return result;
}

function assertRecordMetadata(observed: BigIntStats, maximumBytes: number): void {
  if (!observed.isFile()) {
    throw new LocalAcpSessionStoreError("invalid_session");
  }
  if (observed.size > BigInt(maximumBytes)) {
    throw new LocalAcpSessionStoreError("limit_exceeded");
  }
  if ((observed.mode & 0o022n) !== 0n) {
    throw new LocalAcpSessionStoreError("invalid_session");
  }
}

function sameObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function createDescriptor(input: CreateAcpSessionInput): AcpSessionDescriptor {
  const sessionId = parseSessionId(input.sessionId);
  const projectRoot = parseProjectRoot(input.projectRoot);
  const policyDigest = parseDigest(input.policyDigest);
  const actor = parseActor(input.actor);
  const createdAt = parseTimestamp(input.createdAt);
  const payload = {
    apiVersion: ACP_SESSION_API_VERSION,
    sessionId,
    runId: sessionId,
    projectRoot,
    policyDigest,
    actor,
    createdAt,
  } as const;
  return { ...payload, descriptorDigest: digestDescriptor(payload) };
}

function parseDescriptor(bytes: Buffer, expectedSessionId: string): AcpSessionDescriptor {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LocalAcpSessionStoreError("invalid_session");
  }
  let value: StrictJsonValue;
  try {
    value = parseStrictJson(source, {
      maxDepth: 4,
      maxNodes: 32,
      valueLabel: "ACP session record",
    });
  } catch {
    throw new LocalAcpSessionStoreError("invalid_session");
  }
  if (!isRecord(value) || !hasExactKeys(value, RECORD_KEYS)) {
    throw new LocalAcpSessionStoreError("invalid_session");
  }
  const descriptor = createDescriptor({
    sessionId: requireString(value.sessionId),
    projectRoot: requireString(value.projectRoot),
    policyDigest: requireString(value.policyDigest),
    actor: requireString(value.actor),
    createdAt: requireString(value.createdAt),
  });
  if (
    value.apiVersion !== ACP_SESSION_API_VERSION ||
    value.runId !== descriptor.runId ||
    value.descriptorDigest !== descriptor.descriptorDigest ||
    descriptor.sessionId !== expectedSessionId
  ) {
    throw new LocalAcpSessionStoreError("invalid_session");
  }
  return descriptor;
}

function assertExpected(
  descriptor: AcpSessionDescriptor,
  expected: AcpSessionExpectedIdentity,
): void {
  if (descriptor.projectRoot !== expected.projectRoot) {
    throw new LocalAcpSessionStoreError("project_mismatch");
  }
  if (descriptor.policyDigest !== expected.policyDigest) {
    throw new LocalAcpSessionStoreError("policy_mismatch");
  }
}

function parseExpected(expected: AcpSessionExpectedIdentity): void {
  parseProjectRoot(expected.projectRoot);
  parseDigest(expected.policyDigest);
}

function digestDescriptor(input: Omit<AcpSessionDescriptor, "descriptorDigest">): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

function parseSessionId(
  value: string,
  code: LocalAcpSessionStoreErrorCode = "invalid_session",
): string {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new LocalAcpSessionStoreError(code);
  }
  return value.toLowerCase();
}

function parseProjectRoot(value: string): string {
  if (
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    !hasValidUnicode(value)
  ) {
    throw new LocalAcpSessionStoreError("invalid_session");
  }
  return value;
}

function parseDigest(value: string): string {
  if (!DIGEST_PATTERN.test(value)) {
    throw new LocalAcpSessionStoreError("invalid_session");
  }
  return value;
}

function parseActor(value: string): string {
  if (!hasValidUnicode(value) || !isValidApprovalActor(value)) {
    throw new LocalAcpSessionStoreError("invalid_session");
  }
  return value;
}

function parseTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new LocalAcpSessionStoreError("invalid_session");
  }
  return value;
}

function parseListLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ACP_SESSION_LIST_RESULTS) {
    throw new LocalAcpSessionStoreError("limit_exceeded");
  }
  return value;
}

function parseMaximumEntries(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ACP_SESSION_STORE_ENTRIES) {
    throw new LocalAcpSessionStoreError("limit_exceeded");
  }
  return value;
}

function sessionIdFromRecordName(name: string): string | undefined {
  if (!name.endsWith(".json")) {
    return undefined;
  }
  const sessionId = name.slice(0, -5);
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId.toLowerCase() : undefined;
}

function isRecord(value: unknown): value is StrictJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: StrictJsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireString(value: StrictJsonValue | undefined): string {
  if (typeof value !== "string") {
    throw new LocalAcpSessionStoreError("invalid_session");
  }
  return value;
}

function hasValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeStoreError(error: unknown): LocalAcpSessionStoreError {
  return error instanceof LocalAcpSessionStoreError ? error : new LocalAcpSessionStoreError("io");
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isFileExists(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

function isSymbolicLinkError(error: unknown): boolean {
  return hasErrorCode(error, "ELOOP") || hasErrorCode(error, "EMLINK");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function storeMessage(code: LocalAcpSessionStoreErrorCode): string {
  switch (code) {
    case "conflict":
      return "ACP session identity conflicts with durable state";
    case "invalid_cursor":
      return "ACP session cursor is invalid";
    case "invalid_session":
      return "ACP session record is invalid";
    case "io":
      return "ACP session store failed";
    case "limit_exceeded":
      return "ACP session store exceeds its limit";
    case "not_found":
      return "ACP session is unavailable";
    case "policy_mismatch":
      return "ACP session policy identity does not match";
    case "project_mismatch":
      return "ACP session project identity does not match";
    case "publication_uncertain":
      return "ACP session publication is uncertain";
  }
}
