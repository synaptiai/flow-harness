import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import {
  CAPABILITY_REPOSITORY_FIRST_ACTIVATION_API_VERSION,
  type CapabilityRepositoryFirstActivationAuthorization,
  type CapabilityRepositoryFirstActivationState,
  type CapabilityRepositoryFirstActivationStateContent,
  type CapabilityRepositoryFirstActivationStatePort,
  MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_CHECKS,
} from "../../application/capability-repository-first-activation.js";
import {
  MAX_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS,
  MIN_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS,
} from "../../application/capability-repository-scheduler.js";
import { validateSigstoreCapabilityPublisherPolicy } from "../../domain/capability/sigstore-capability-verifier.js";
import {
  verifierPackageNameSchema,
  verifierPackageVersionSchema,
} from "../../domain/capability/verifier-packages.js";
import { parseStrictJson } from "../../domain/strict-json.js";

export const MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_RECORD_BYTES = 16 * 1024;

export type LocalCapabilityRepositoryFirstActivationStoreStage =
  | "inspect activation state"
  | "publish activation state"
  | "settle activation state";

export class LocalCapabilityRepositoryFirstActivationStoreError extends Error {
  override readonly name = "LocalCapabilityRepositoryFirstActivationStoreError";
  readonly code = "capability_repository_first_activation_store_failed" as const;

  constructor(readonly stage: LocalCapabilityRepositoryFirstActivationStoreStage) {
    super(`Capability repository first activation store failed during ${stage}`);
  }
}

export interface LocalCapabilityRepositoryFirstActivationStoreHooks {
  readonly beforeRecordRename?: () => void | Promise<void>;
  readonly afterRecordRenamed?: () => void | Promise<void>;
}

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const authorizationSchema = z
  .object({
    packageName: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    certificateIssuer: z.string().min(1).max(2_048),
    certificateIdentity: z.string().min(1).max(4_096),
  })
  .strict();
const publisherSchema = z
  .object({
    kind: z.literal("sigstore-keyless-v0.3"),
    certificateIssuer: z.string().min(1).max(2_048),
    certificateIdentity: z.string().min(1).max(4_096),
    signatureBundleDigest: digestSchema,
  })
  .strict();
const receiptSchema = z
  .object({
    candidateDigest: digestSchema,
    checkedAt: z.string().min(1).max(64),
    source: z.string().min(1).max(4_096),
    bundle: z
      .object({
        name: verifierPackageNameSchema,
        version: verifierPackageVersionSchema,
        bytes: z
          .number()
          .int()
          .positive()
          .max(4 * 1024 * 1024),
        digest: digestSchema,
      })
      .strict(),
    publisher: publisherSchema,
  })
  .strict();
const recordBaseSchema = z
  .object({
    apiVersion: z.literal(CAPABILITY_REPOSITORY_FIRST_ACTIVATION_API_VERSION),
    kind: z.literal("CapabilityRepositoryFirstActivation"),
    authorization: authorizationSchema,
    intervalMs: z
      .number()
      .int()
      .min(MIN_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS)
      .max(MAX_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS),
    maxChecks: z.number().int().min(1).max(MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_CHECKS),
    attempts: z.number().int().min(0).max(MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_CHECKS),
    createdAt: z.string().min(1).max(64),
    lastObservedAt: z.string().min(1).max(64),
    identityDigest: digestSchema,
    recordDigest: digestSchema,
  })
  .strict();
const recordSchema = z.discriminatedUnion("status", [
  recordBaseSchema.extend({ status: z.literal("waiting") }).strict(),
  recordBaseSchema.extend({ status: z.literal("prepared"), receipt: receiptSchema }).strict(),
  recordBaseSchema
    .extend({
      status: z.literal("settled"),
      receipt: receiptSchema,
      settledAt: z.string().min(1).max(64),
    })
    .strict(),
]);

type StoredRecord = z.infer<typeof recordSchema>;

export class LocalCapabilityRepositoryFirstActivationStore
  implements CapabilityRepositoryFirstActivationStatePort
{
  readonly #root: string;

  constructor(
    projectRoot: string,
    private readonly hooks: LocalCapabilityRepositoryFirstActivationStoreHooks = {},
  ) {
    this.#root = join(resolve(projectRoot), ".flow", "capability.repository");
  }

  async read(
    authorization: CapabilityRepositoryFirstActivationAuthorization,
    signal: AbortSignal,
  ): Promise<CapabilityRepositoryFirstActivationState | undefined> {
    throwIfAborted(signal);
    const paths = statePaths(this.#root, authorization);
    try {
      await requireDirectRoot(this.#root);
      throwIfAborted(signal);
      if (await pathExists(paths.pending)) {
        throw new Error("first activation state has unsettled pending evidence");
      }
      const state = await readRecord(paths.record, authorization);
      throwIfAborted(signal);
      return state;
    } catch {
      throwIfAborted(signal);
      throw new LocalCapabilityRepositoryFirstActivationStoreError("inspect activation state");
    }
  }

  async publish(input: {
    readonly expectedRecordDigest: `sha256:${string}` | null;
    readonly state: CapabilityRepositoryFirstActivationStateContent;
    readonly signal: AbortSignal;
  }): Promise<CapabilityRepositoryFirstActivationState> {
    throwIfAborted(input.signal);
    const materialized = materializeState(input.state);
    const paths = statePaths(this.#root, materialized.state.authorization);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let pendingObservation: BigIntStats | undefined;
    let renamed = false;
    try {
      await requireDirectRoot(this.#root);
      throwIfAborted(input.signal);
      if (await pathExists(paths.pending)) {
        throw new Error("first activation state has unsettled pending evidence");
      }
      const current = await readRecord(paths.record, materialized.state.authorization);
      throwIfAborted(input.signal);
      if (
        (input.expectedRecordDigest === null && current !== undefined) ||
        (input.expectedRecordDigest !== null &&
          current?.recordDigest !== input.expectedRecordDigest)
      ) {
        throw new Error("first activation state changed");
      }
      assertTransition(current, materialized.state);

      handle = await open(
        paths.pending,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(materialized.bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      pendingObservation = await lstat(paths.pending, { bigint: true });
      if (
        !pendingObservation.isFile() ||
        pendingObservation.isSymbolicLink() ||
        pendingObservation.size !== BigInt(materialized.bytes.byteLength)
      ) {
        throw new Error("first activation pending state changed");
      }
      await this.hooks.beforeRecordRename?.();
      throwIfAborted(input.signal);
      const currentPending = await lstat(paths.pending, { bigint: true });
      if (!sameFile(pendingObservation, currentPending)) {
        throw new Error("first activation pending state changed");
      }
      await rename(paths.pending, paths.record);
      renamed = true;
      await this.hooks.afterRecordRenamed?.();
      await syncDirectory(this.#root);
      throwIfAborted(input.signal);
      return materialized.state;
    } catch {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (!renamed) {
        throwIfAborted(input.signal);
        throw new LocalCapabilityRepositoryFirstActivationStoreError("publish activation state");
      }
      throw new LocalCapabilityRepositoryFirstActivationStoreError("settle activation state");
    }
  }
}

function statePaths(
  root: string,
  authorization: CapabilityRepositoryFirstActivationAuthorization,
): { readonly record: string; readonly pending: string } {
  const identity = identityDigest(authorization).slice("sha256:".length);
  const basename = `first-activation-${identity}.json`;
  return Object.freeze({
    record: join(root, basename),
    pending: join(root, `.${basename}.pending`),
  });
}

function materializeState(state: CapabilityRepositoryFirstActivationStateContent): {
  readonly state: CapabilityRepositoryFirstActivationState;
  readonly bytes: Buffer;
} {
  const identity = identityDigest(state.authorization);
  const normalized = recordSchema.parse({
    ...state,
    identityDigest: identity,
    recordDigest: `sha256:${"0".repeat(64)}`,
  });
  const { recordDigest: _placeholder, ...withoutDigest } = normalized;
  const recordDigest = sha256(Buffer.from(JSON.stringify(withoutDigest)));
  const record = recordSchema.parse({ ...withoutDigest, recordDigest });
  validateRecord(record);
  const bytes = Buffer.from(JSON.stringify(record));
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_RECORD_BYTES
  ) {
    throw new LocalCapabilityRepositoryFirstActivationStoreError("publish activation state");
  }
  return Object.freeze({ state: publicState(record), bytes });
}

async function readRecord(
  path: string,
  authorization: CapabilityRepositoryFirstActivationAuthorization,
): Promise<CapabilityRepositoryFirstActivationState | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 1n ||
      before.size > BigInt(MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_RECORD_BYTES)
    ) {
      throw new Error("first activation record is not a bounded regular file");
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after) || after.size !== BigInt(content.byteLength)) {
      throw new Error("first activation record changed while reading");
    }
    await handle.close();
    handle = undefined;
    const pathObservation = await lstat(path, { bigint: true });
    if (!sameFile(after, pathObservation)) {
      throw new Error("first activation record path changed");
    }
    const parsed = recordSchema.parse(
      parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(content), {
        maxDepth: 16,
        maxNodes: 128,
        valueLabel: "first activation record",
      }),
    );
    validateRecord(parsed);
    if (!isDeepStrictEqual(parsed.authorization, authorization)) {
      throw new Error("first activation authority changed");
    }
    const canonical = materializeState(publicStateContent(parsed));
    if (!canonical.bytes.equals(content) || canonical.state.recordDigest !== parsed.recordDigest) {
      throw new Error("first activation record is not canonical");
    }
    return canonical.state;
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

function validateRecord(record: StoredRecord): void {
  validateSigstoreCapabilityPublisherPolicy(record.authorization);
  requireCanonicalTimestamp(record.createdAt);
  requireCanonicalTimestamp(record.lastObservedAt);
  if (
    record.identityDigest !== identityDigest(record.authorization) ||
    record.attempts > record.maxChecks ||
    Date.parse(record.lastObservedAt) < Date.parse(record.createdAt)
  ) {
    throw new Error("first activation record is inconsistent");
  }
  if (record.status !== "waiting") {
    validateSigstoreCapabilityPublisherPolicy(record.receipt.publisher);
    requireCanonicalTimestamp(record.receipt.checkedAt);
    if (
      record.receipt.bundle.name !== record.authorization.packageName ||
      record.receipt.bundle.version !== record.authorization.version ||
      record.receipt.publisher.certificateIssuer !== record.authorization.certificateIssuer ||
      record.receipt.publisher.certificateIdentity !== record.authorization.certificateIdentity ||
      !isCanonicalHttpsUrl(record.receipt.source)
    ) {
      throw new Error("first activation receipt contradicts its authority");
    }
  }
  if (record.status === "settled") {
    requireCanonicalTimestamp(record.settledAt);
    if (Date.parse(record.settledAt) < Date.parse(record.lastObservedAt)) {
      throw new Error("first activation settlement precedes observation");
    }
  }
}

function assertTransition(
  current: CapabilityRepositoryFirstActivationState | undefined,
  next: CapabilityRepositoryFirstActivationState,
): void {
  if (current === undefined) {
    if (next.status !== "waiting" || next.attempts !== 0) {
      throw new Error("first activation must begin waiting");
    }
    return;
  }
  const samePolicy =
    isDeepStrictEqual(current.authorization, next.authorization) &&
    current.intervalMs === next.intervalMs &&
    current.maxChecks === next.maxChecks &&
    current.createdAt === next.createdAt;
  const waitingAdvance =
    current.status === "waiting" &&
    next.status === "waiting" &&
    (next.attempts === current.attempts || next.attempts === current.attempts + 1);
  const preparation =
    current.status === "waiting" &&
    next.status === "prepared" &&
    next.attempts === current.attempts;
  const settlement =
    current.status === "prepared" &&
    next.status === "settled" &&
    next.attempts === current.attempts &&
    isDeepStrictEqual(next.receipt, current.receipt);
  if (
    !samePolicy ||
    Date.parse(next.lastObservedAt) < Date.parse(current.lastObservedAt) ||
    (!waitingAdvance && !preparation && !settlement)
  ) {
    throw new Error("first activation transition is invalid");
  }
}

function publicState(record: StoredRecord): CapabilityRepositoryFirstActivationState {
  return Object.freeze({
    ...publicStateContent(record),
    recordDigest: record.recordDigest as `sha256:${string}`,
  }) as CapabilityRepositoryFirstActivationState;
}

function publicStateContent(record: StoredRecord): CapabilityRepositoryFirstActivationStateContent {
  const { identityDigest: _identityDigest, recordDigest: _recordDigest, ...state } = record;
  return deepFreeze(state) as CapabilityRepositoryFirstActivationStateContent;
}

function identityDigest(
  authorization: CapabilityRepositoryFirstActivationAuthorization,
): `sha256:${string}` {
  const validated = authorizationSchema.parse(authorization);
  validateSigstoreCapabilityPublisherPolicy(validated);
  return sha256(Buffer.from(JSON.stringify(validated)));
}

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function requireCanonicalTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("first activation timestamp is invalid");
  }
}

function isCanonicalHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === "" &&
      parsed.toString() === value
    );
  } catch {
    return false;
  }
}

async function requireDirectRoot(path: string): Promise<void> {
  const observed = await lstat(path);
  if (!observed.isDirectory() || observed.isSymbolicLink()) {
    throw new Error("capability repository root is not a direct directory");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    right.isFile() &&
    !right.isSymbolicLink()
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
