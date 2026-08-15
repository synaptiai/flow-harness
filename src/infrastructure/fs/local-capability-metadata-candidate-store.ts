import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, rm, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  type CapabilityMetadataCandidate,
  createCapabilityMetadataCandidate,
  encodeCapabilityMetadataCandidate,
  MAX_CAPABILITY_METADATA_CANDIDATE_RECORD_BYTES,
  parseCapabilityMetadataCandidate,
} from "../../application/capability-metadata-candidate.js";
import {
  type CapabilityMetadataCandidateStore,
  CapabilityMetadataCandidateStoreError,
  type CapabilityMetadataCandidateStoreStage,
  type CapabilityMetadataCheckObservation,
  MAX_STAGED_CAPABILITY_METADATA_CANDIDATES,
  type StageCapabilityMetadataCandidateInput,
  type StageCapabilityMetadataCandidateResult,
  StoredCapabilityMetadataCandidate,
} from "../../application/capability-metadata-candidate-store.js";
import {
  MAX_CAPABILITY_METADATA_BYTES,
  parseCapabilityMetadata,
} from "../../domain/capability/capability-metadata.js";
import { MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES } from "../../domain/capability/signed-capability-metadata-envelope.js";
import type { SigstoreCapabilityVerifier } from "../../domain/capability/sigstore-capability-verifier.js";

const MAX_SIGSTORE_BUNDLE_BYTES = 1024 * 1024;
const MAX_LOCK_RECORD_BYTES = 1_024;
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const lockOwnerSchema = z
  .object({
    version: z.literal(1),
    hostname: z.string().min(1).max(255),
    pid: z.number().int().positive().max(2_147_483_647),
    token: z.string().regex(/^[a-f0-9-]{36}$/),
  })
  .strict();
const observationSchema = z
  .object({
    apiVersion: z.literal("flow.synapti.ai/v1alpha1"),
    kind: z.literal("CapabilityMetadataCheckObservation"),
    checkedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      .refine((value) => {
        const instant = new Date(value);
        return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
      }),
    channel: z.string().min(1).max(4_096),
    envelopeBytes: z.number().int().positive().max(MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES),
    envelopeDigest: digestSchema,
    candidateDigest: digestSchema,
  })
  .strict();

export interface LocalCapabilityMetadataCandidateStoreHooks {
  readonly afterCandidateLockLinked?: () => void | Promise<void>;
  readonly afterCandidateRenamed?: () => void | Promise<void>;
  readonly afterLatestCheckRenamed?: () => void | Promise<void>;
  readonly beforeCandidateRenamed?: () => void | Promise<void>;
  readonly beforeLatestCheckRenamed?: () => void | Promise<void>;
  readonly beforeCandidateRemove?: () => void | Promise<void>;
  readonly candidateDirectoryEntries?: (path: string) => AsyncIterable<{
    readonly name: string;
    readonly isDirectory: () => boolean;
    readonly isSymbolicLink: () => boolean;
  }>;
}

interface StorePaths {
  readonly flowDirectory: string;
  readonly candidateDirectory: string;
  readonly digestDirectory: string;
  readonly latestCheckPath: string;
  readonly latestCheckPendingPath: string;
  readonly lockPath: string;
  readonly candidatePendingPath: string;
}

interface CandidateInput {
  readonly candidate: CapabilityMetadataCandidate;
  readonly candidateRecord: Buffer;
  readonly metadata: Buffer;
  readonly sigstoreBundle: Buffer;
  readonly observation: CapabilityMetadataCheckObservation;
}

interface CandidateStoreLock {
  readonly path: string;
  readonly content: Buffer;
}

export class LocalCapabilityMetadataCandidateStore implements CapabilityMetadataCandidateStore {
  readonly #paths: StorePaths;

  constructor(
    projectRoot: string,
    private readonly verifier: SigstoreCapabilityVerifier,
    private readonly hooks: LocalCapabilityMetadataCandidateStoreHooks = {},
  ) {
    const flowDirectory = join(projectRoot, ".flow");
    const candidateDirectory = join(flowDirectory, "packages.metadata.candidates");
    this.#paths = Object.freeze({
      flowDirectory,
      candidateDirectory,
      digestDirectory: join(candidateDirectory, "sha256"),
      latestCheckPath: join(flowDirectory, "packages.metadata.check.json"),
      latestCheckPendingPath: join(flowDirectory, ".packages.metadata.check.pending"),
      lockPath: join(flowDirectory, "packages.metadata.check.lock"),
      candidatePendingPath: join(flowDirectory, ".packages.metadata.candidate.pending"),
    });
  }

  async stage(
    input: StageCapabilityMetadataCandidateInput,
  ): Promise<StageCapabilityMetadataCandidateResult> {
    throwIfAborted(input.signal);
    const candidateInput = validateCandidateInput(input);
    return await this.#withLock(
      input.signal,
      async () => {
        throwIfAborted(input.signal);
        const candidateNames = await this.#candidateNames();
        const digestName = digestNameFor(candidateInput.candidate.candidateDigest);
        const exists = candidateNames.includes(digestName);
        let status: StageCapabilityMetadataCandidateResult["status"];
        let candidateCommitted = false;
        if (exists) {
          const stored = await this.#readCandidate(candidateInput.candidate.candidateDigest);
          if (
            !stored.metadataBytes().equals(candidateInput.metadata) ||
            !stored.sigstoreBundleBytes().equals(candidateInput.sigstoreBundle) ||
            stored.candidate.candidateDigest !== candidateInput.candidate.candidateDigest
          ) {
            throw new CapabilityMetadataCandidateStoreError("inspect candidate store");
          }
          status = "already_staged";
        } else {
          if (candidateNames.length >= MAX_STAGED_CAPABILITY_METADATA_CANDIDATES) {
            throw new CapabilityMetadataCandidateStoreError("enforce candidate capacity");
          }
          await this.#publishCandidate(candidateInput, input.signal);
          candidateCommitted = true;
          status = "staged";
        }
        try {
          throwIfAborted(input.signal);
          await this.#publishLatestCheck(candidateInput.observation, input.signal);
        } catch (error) {
          if (candidateCommitted) {
            throw new CapabilityMetadataCandidateStoreError("settle candidate commit");
          }
          throw error;
        }
        return Object.freeze({
          status,
          candidate: candidateInput.candidate,
          observation: candidateInput.observation,
        });
      },
      "settle candidate commit",
    );
  }

  async list(signal?: AbortSignal): Promise<readonly CapabilityMetadataCandidate[]> {
    throwIfAborted(signal);
    return await this.#withLock(signal, async () => {
      const candidates: CapabilityMetadataCandidate[] = [];
      for (const name of await this.#candidateNames()) {
        throwIfAborted(signal);
        candidates.push((await this.#readCandidate(`sha256:${name}`)).candidate);
      }
      return Object.freeze(candidates);
    });
  }

  async read(
    candidateDigest: string,
    signal?: AbortSignal,
  ): Promise<StoredCapabilityMetadataCandidate> {
    throwIfAborted(signal);
    validateCandidateDigest(candidateDigest, "read candidate");
    return await this.#withLock(signal, async () => {
      throwIfAborted(signal);
      return await this.#readCandidate(candidateDigest);
    });
  }

  async remove(candidateDigest: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    validateCandidateDigest(candidateDigest, "remove candidate");
    await this.#withLock(signal, async () => {
      throwIfAborted(signal);
      await this.#readCandidate(candidateDigest);
      await this.hooks.beforeCandidateRemove?.();
      throwIfAborted(signal);
      const directory = this.#candidatePath(candidateDigest);
      try {
        await rm(directory, { recursive: true });
        await syncDirectory(this.#paths.digestDirectory);
      } catch {
        throw new CapabilityMetadataCandidateStoreError("remove candidate");
      }
    });
  }

  async latestCheck(signal?: AbortSignal): Promise<CapabilityMetadataCheckObservation | null> {
    throwIfAborted(signal);
    return await this.#withLock(signal, async () => {
      throwIfAborted(signal);
      let content: Buffer;
      try {
        content = await readBoundedRegularFile(
          this.#paths.latestCheckPath,
          MAX_CAPABILITY_METADATA_CANDIDATE_RECORD_BYTES,
        );
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return null;
        }
        throw new CapabilityMetadataCandidateStoreError("inspect candidate store");
      }
      try {
        return parseObservation(content);
      } catch {
        throw new CapabilityMetadataCandidateStoreError("inspect candidate store");
      }
    });
  }

  async #withLock<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
    successfulOperationReleaseStage: CapabilityMetadataCandidateStoreStage = "release candidate store lock",
  ): Promise<T> {
    const lock = await this.#acquireLock(signal);
    let outcome:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown };
    try {
      await this.#assertNoPendingState(signal);
      throwIfAborted(signal);
      outcome = { ok: true, value: await operation() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      await releaseLock(lock, this.#paths.flowDirectory);
    } catch {
      if (outcome.ok) {
        throw new CapabilityMetadataCandidateStoreError(successfulOperationReleaseStage);
      }
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  async #acquireLock(signal: AbortSignal | undefined): Promise<CandidateStoreLock> {
    throwIfAborted(signal);
    try {
      await ensureDirectory(this.#paths.flowDirectory);
      await ensureDirectory(this.#paths.candidateDirectory);
      await ensureDirectory(this.#paths.digestDirectory);
      throwIfAborted(signal);
      return await this.#installLock(signal);
    } catch (error) {
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      if (error instanceof CapabilityMetadataCandidateStoreError) {
        throw error;
      }
      throw new CapabilityMetadataCandidateStoreError("acquire candidate store lock");
    }
  }

  async #installLock(signal: AbortSignal | undefined): Promise<CandidateStoreLock> {
    const token = randomUUID();
    const temporary = join(this.#paths.flowDirectory, `.packages.metadata.check.lock-${token}`);
    const lock = Object.freeze({
      path: this.#paths.lockPath,
      content: encodeLockOwner({ version: 1, hostname: hostname(), pid: process.pid, token }),
    });
    let linked = false;
    try {
      await writeDurableFile(temporary, lock.content);
      throwIfAborted(signal);
      await link(temporary, lock.path);
      linked = true;
      await this.hooks.afterCandidateLockLinked?.();
      throwIfAborted(signal);
      await unlink(temporary);
      await syncDirectory(this.#paths.flowDirectory);
      return lock;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (linked) {
        try {
          await releaseLock(lock, this.#paths.flowDirectory);
        } catch {
          throw new CapabilityMetadataCandidateStoreError("acquire candidate store lock");
        }
      }
      throw error;
    }
  }

  async #assertNoPendingState(signal: AbortSignal | undefined): Promise<void> {
    try {
      for (const path of [this.#paths.candidatePendingPath, this.#paths.latestCheckPendingPath]) {
        throwIfAborted(signal);
        try {
          await lstat(path);
          throw new Error("candidate store has unsettled pending state");
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
          }
        }
      }
    } catch {
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      throw new CapabilityMetadataCandidateStoreError("inspect candidate store");
    }
  }

  async #candidateNames(): Promise<readonly string[]> {
    try {
      const entries =
        this.hooks.candidateDirectoryEntries?.(this.#paths.digestDirectory) ??
        (await opendir(this.#paths.digestDirectory));
      const names: string[] = [];
      for await (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(entry.name)) {
          throw new Error("candidate directory contains an unknown entry");
        }
        names.push(entry.name);
        if (names.length > MAX_STAGED_CAPABILITY_METADATA_CANDIDATES) {
          throw new Error("candidate directory exceeds capacity");
        }
      }
      names.sort();
      return Object.freeze(names);
    } catch (error) {
      if (error instanceof CapabilityMetadataCandidateStoreError) {
        throw error;
      }
      throw new CapabilityMetadataCandidateStoreError("inspect candidate store");
    }
  }

  async #publishCandidate(input: CandidateInput, signal: AbortSignal | undefined): Promise<void> {
    const target = this.#candidatePath(input.candidate.candidateDigest);
    const temporary = this.#paths.candidatePendingPath;
    let renamed = false;
    try {
      await mkdir(temporary, { mode: 0o700 });
      await writeDurableFile(join(temporary, "metadata.json"), input.metadata);
      await writeDurableFile(join(temporary, "sigstore.bundle.json"), input.sigstoreBundle);
      await writeDurableFile(join(temporary, "candidate.json"), input.candidateRecord);
      await syncDirectory(temporary);
      await this.hooks.beforeCandidateRenamed?.();
      throwIfAborted(signal);
      await rename(temporary, target);
      renamed = true;
      await this.hooks.afterCandidateRenamed?.();
      await syncDirectory(this.#paths.digestDirectory);
    } catch {
      if (signal?.aborted === true && !renamed) {
        throw signal.reason;
      }
      throw new CapabilityMetadataCandidateStoreError(
        renamed ? "settle candidate commit" : "publish candidate",
      );
    }
  }

  async #publishLatestCheck(
    observation: CapabilityMetadataCheckObservation,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const content = canonicalObservationBytes(observation);
    const temporary = this.#paths.latestCheckPendingPath;
    let renamed = false;
    try {
      await writeDurableFile(temporary, content);
      await this.hooks.beforeLatestCheckRenamed?.();
      throwIfAborted(signal);
      await rename(temporary, this.#paths.latestCheckPath);
      renamed = true;
      await this.hooks.afterLatestCheckRenamed?.();
      await syncDirectory(this.#paths.flowDirectory);
    } catch {
      if (signal?.aborted === true && !renamed) {
        throw signal.reason;
      }
      throw new CapabilityMetadataCandidateStoreError(
        renamed ? "settle candidate commit" : "publish latest check",
      );
    }
  }

  async #readCandidate(candidateDigest: string): Promise<StoredCapabilityMetadataCandidate> {
    try {
      validateCandidateDigest(candidateDigest, "read candidate");
      const directory = this.#candidatePath(candidateDigest);
      const directoryMetadata = await lstat(directory, { bigint: true });
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        throw new Error("candidate path is not a directory");
      }
      const entries: string[] = [];
      for await (const entry of await opendir(directory)) {
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw new Error("candidate directory contains a non-file entry");
        }
        entries.push(entry.name);
        if (entries.length > 3) {
          throw new Error("candidate directory has too many entries");
        }
      }
      entries.sort();
      if (
        entries.length !== 3 ||
        entries[0] !== "candidate.json" ||
        entries[1] !== "metadata.json" ||
        entries[2] !== "sigstore.bundle.json"
      ) {
        throw new Error("candidate directory has unexpected content");
      }
      const [candidateRecord, metadata, sigstoreBundle] = await Promise.all([
        readBoundedRegularFile(
          join(directory, "candidate.json"),
          MAX_CAPABILITY_METADATA_CANDIDATE_RECORD_BYTES,
        ),
        readBoundedRegularFile(join(directory, "metadata.json"), MAX_CAPABILITY_METADATA_BYTES),
        readBoundedRegularFile(join(directory, "sigstore.bundle.json"), MAX_SIGSTORE_BUNDLE_BYTES),
      ]);
      const candidate = parseCapabilityMetadataCandidate(candidateRecord);
      const metadataFromBytes = parseCapabilityMetadata(
        metadata,
        new Date(Date.parse(candidate.metadata.expiresAt) - 1),
      );
      const verifiedPublisher = this.verifier.verify(metadata, sigstoreBundle, candidate.authority);
      const reconstructed = createCapabilityMetadataCandidate({
        metadata: metadataFromBytes,
        metadataBytes: metadata,
        sigstoreBundle,
        authority: {
          kind: "sigstore-keyless-v0.3",
          ...verifiedPublisher,
          signatureBundleDigest: candidate.sigstoreBundle.digest,
        },
      });
      if (
        !sameOpenedFile(directoryMetadata, await lstat(directory, { bigint: true })) ||
        candidate.candidateDigest !== candidateDigest ||
        candidate.metadata.bytes !== metadata.byteLength ||
        candidate.metadata.digest !== digest(metadata) ||
        candidate.sigstoreBundle.bytes !== sigstoreBundle.byteLength ||
        candidate.sigstoreBundle.digest !== digest(sigstoreBundle) ||
        !isDeepStrictEqual(reconstructed, candidate)
      ) {
        throw new Error("candidate content contradicts its identity");
      }
      return new StoredCapabilityMetadataCandidate({ candidate, metadata, sigstoreBundle });
    } catch {
      throw new CapabilityMetadataCandidateStoreError("read candidate");
    }
  }

  #candidatePath(candidateDigest: string): string {
    return join(this.#paths.digestDirectory, digestNameFor(candidateDigest));
  }
}

function validateCandidateInput(input: StageCapabilityMetadataCandidateInput): CandidateInput {
  try {
    const candidateRecord = encodeCapabilityMetadataCandidate(input.candidate);
    const metadata = Buffer.from(input.metadata);
    const sigstoreBundle = Buffer.from(input.sigstoreBundle);
    if (
      metadata.byteLength !== input.candidate.metadata.bytes ||
      digest(metadata) !== input.candidate.metadata.digest ||
      sigstoreBundle.byteLength !== input.candidate.sigstoreBundle.bytes ||
      digest(sigstoreBundle) !== input.candidate.sigstoreBundle.digest
    ) {
      throw new Error("candidate bytes contradict candidate identity");
    }
    const observation = canonicalObservation(
      observationSchema.parse({
        ...input.observation,
        candidateDigest: input.candidate.candidateDigest,
      }),
    );
    validateChannel(observation.channel);
    return Object.freeze({
      candidate: input.candidate,
      candidateRecord,
      metadata,
      sigstoreBundle,
      observation,
    });
  } catch {
    throw new CapabilityMetadataCandidateStoreError("validate candidate store input");
  }
}

function validateChannel(source: string): void {
  const url = new URL(source);
  if (
    source !== url.toString() ||
    source.includes("?") ||
    source.includes("#") ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === "" ||
    url.hostname !== url.hostname.toLowerCase()
  ) {
    throw new Error("invalid observation channel");
  }
}

function validateCandidateDigest(
  candidateDigest: string,
  stage: Extract<CapabilityMetadataCandidateStoreStage, "read candidate" | "remove candidate">,
): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(candidateDigest)) {
    throw new CapabilityMetadataCandidateStoreError(stage);
  }
}

function digestNameFor(candidateDigest: string): string {
  return candidateDigest.slice("sha256:".length);
}

function canonicalObservation(
  observation: z.infer<typeof observationSchema>,
): CapabilityMetadataCheckObservation {
  return Object.freeze({
    apiVersion: observation.apiVersion,
    kind: observation.kind,
    checkedAt: observation.checkedAt,
    channel: observation.channel,
    envelopeBytes: observation.envelopeBytes,
    envelopeDigest: observation.envelopeDigest,
    candidateDigest: observation.candidateDigest,
  });
}

function canonicalObservationBytes(observation: CapabilityMetadataCheckObservation): Buffer {
  return Buffer.from(JSON.stringify(canonicalObservation(observationSchema.parse(observation))));
}

function parseObservation(source: Buffer): CapabilityMetadataCheckObservation {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  const input = JSON.parse(text) as unknown;
  const observation = canonicalObservation(observationSchema.parse(input));
  if (!source.equals(canonicalObservationBytes(observation))) {
    throw new Error("observation is not canonical");
  }
  validateChannel(observation.channel);
  return observation;
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("candidate store path is not a directory");
  }
}

async function writeDurableFile(path: string, content: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBoundedRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new Error("candidate file violates its regular-file bound");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      total < 1 ||
      total > maximumBytes ||
      BigInt(total) !== before.size ||
      !sameOpenedFile(before, after)
    ) {
      throw new Error("candidate file changed while it was read");
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function sameOpenedFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
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

async function releaseLock(lock: CandidateStoreLock, flowDirectory: string): Promise<void> {
  const content = await readBoundedRegularFile(lock.path, MAX_LOCK_RECORD_BYTES);
  if (!content.equals(lock.content)) {
    throw new Error("candidate store lock ownership changed");
  }
  await unlink(lock.path);
  await syncDirectory(flowDirectory);
}

type LockOwner = z.infer<typeof lockOwnerSchema>;

function encodeLockOwner(owner: LockOwner): Buffer {
  return Buffer.from(`${JSON.stringify(lockOwnerSchema.parse(owner))}\n`);
}

function digest(source: Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
