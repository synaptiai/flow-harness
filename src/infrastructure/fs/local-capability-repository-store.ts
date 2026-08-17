import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  type CapabilityRepositoryCandidate,
  type CapabilityRepositoryCandidateIdentity,
  calculateCapabilityRepositoryStateDigest,
  encodeCapabilityRepositoryCandidateIdentity,
  parseCapabilityRepositoryCandidateIdentityRecord,
  toPublicCapabilityRepositoryCandidate,
} from "../../application/capability-repository-candidate.js";
import {
  type AuthenticateCapabilityRepositoryGenerationInput,
  type CapabilityRepositoryCheckPublication,
  type CapabilityRepositoryGenerationAuthenticator,
  type CapabilityRepositoryStore,
  type CapabilityRepositoryStoredFile,
  type CapabilityRepositoryStoredIndex,
  CapabilityRepositoryStoreError,
  type CapabilityRepositoryStoreStage,
  type InitializeCapabilityRepositoryInput,
  MAX_CAPABILITY_REPOSITORY_GENERATIONS,
  MAX_STAGED_CAPABILITY_REPOSITORY_CANDIDATES,
  type PublicCapabilityRepositoryState,
  type PublishCapabilityRepositoryCheckInput,
  type StoredCapabilityRepositoryCandidate,
} from "../../application/capability-repository-store.js";
import { parseStrictJson } from "../../domain/strict-json.js";

const MAX_GENERATION_RECORD_BYTES = 256 * 1024;
const MAX_CURRENT_RECORD_BYTES = 8 * 1024;
const MAX_LOCK_RECORD_BYTES = 1_024;
const MAX_METADATA_FILE_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_FILE_BYTES = 512 * 1024;
const MAX_ENVELOPE_FILE_BYTES = 8 * 1024 * 1024;
const API_VERSION = "flow.synapti.ai/v1alpha1" as const;

const digestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value): `sha256:${string}` => value as `sha256:${string}`);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);
const metadataDescriptorSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]*[a-zA-Z0-9])?\.json$/),
    length: z.number().int().positive().max(MAX_METADATA_FILE_BYTES),
    digest: digestSchema,
  })
  .strict();
const indexDescriptorSchema = z
  .object({
    path: z.literal("flow/capability-index.json"),
    length: z.number().int().positive().max(MAX_INDEX_FILE_BYTES),
    hashes: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  })
  .strict();
const generationRecordSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("CapabilityRepositoryGeneration"),
    repositoryBaseUrl: z.string().min(1).max(4_096),
    initializedAt: timestampSchema,
    trustedRoot: metadataDescriptorSchema,
    repositoryStateDigest: digestSchema,
    metadata: z.array(metadataDescriptorSchema).min(1).max(34),
    index: indexDescriptorSchema.optional(),
    candidates: z.array(z.unknown()).max(MAX_STAGED_CAPABILITY_REPOSITORY_CANDIDATES),
    generationDigest: digestSchema,
  })
  .strict();
const currentRecordSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("CapabilityRepositoryCurrent"),
    generationDigest: digestSchema,
    checkedAt: timestampSchema.optional(),
    previousGenerationDigest: digestSchema.optional(),
  })
  .strict();
const lockRecordSchema = z
  .object({
    version: z.literal(1),
    hostname: z.string().min(1).max(255),
    pid: z.number().int().positive().max(2_147_483_647),
    token: z.string().uuid(),
  })
  .strict();

export interface LocalCapabilityRepositoryStoreHooks {
  readonly beforeCurrentRenamed?: () => void | Promise<void>;
  readonly afterCurrentRenamed?: () => void | Promise<void>;
}

interface StorePaths {
  readonly flow: string;
  readonly root: string;
  readonly generations: string;
  readonly lock: string;
  readonly generationPending: string;
  readonly current: string;
  readonly currentPending: string;
}

interface StoreLock {
  readonly path: string;
  readonly content: Buffer;
}

interface MaterializedGeneration {
  readonly record: GenerationRecord;
  readonly recordBytes: Buffer;
  readonly checkedAt?: string;
  readonly previousGenerationDigest?: `sha256:${string}`;
  readonly trustedRoot: MaterializedFile;
  readonly metadata: readonly MaterializedFile[];
  readonly index?: MaterializedIndex;
  readonly candidates: readonly MaterializedCandidate[];
}

interface MaterializedFile {
  readonly name: string;
  readonly length: number;
  readonly digest: `sha256:${string}`;
  readonly content: Buffer;
}

interface MaterializedIndex {
  readonly path: "flow/capability-index.json";
  readonly length: number;
  readonly hashes: Readonly<{ readonly sha256: string }>;
  readonly content: Buffer;
}

interface MaterializedCandidate extends StoredCapabilityRepositoryCandidate {
  readonly record: Buffer;
  readonly envelope: Buffer;
}

interface GenerationRecordContent {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: "CapabilityRepositoryGeneration";
  readonly repositoryBaseUrl: string;
  readonly initializedAt: string;
  readonly trustedRoot: {
    readonly name: string;
    readonly length: number;
    readonly digest: `sha256:${string}`;
  };
  readonly repositoryStateDigest: `sha256:${string}`;
  readonly metadata: readonly {
    readonly name: string;
    readonly length: number;
    readonly digest: `sha256:${string}`;
  }[];
  readonly index?: {
    readonly path: "flow/capability-index.json";
    readonly length: number;
    readonly hashes: Readonly<{ readonly sha256: string }>;
  };
  readonly candidates: readonly CapabilityRepositoryCandidateIdentity[];
}

interface GenerationRecord extends GenerationRecordContent {
  readonly generationDigest: `sha256:${string}`;
}

export class LocalCapabilityRepositoryStore implements CapabilityRepositoryStore {
  readonly #paths: StorePaths;

  constructor(
    projectRoot: string,
    private readonly authenticator: CapabilityRepositoryGenerationAuthenticator,
    private readonly hooks: LocalCapabilityRepositoryStoreHooks = {},
  ) {
    const flow = join(resolve(projectRoot), ".flow");
    const root = join(flow, "capability.repository");
    this.#paths = Object.freeze({
      flow,
      root,
      generations: join(root, "generations"),
      lock: join(root, "repository.lock"),
      generationPending: join(root, ".generation.pending"),
      current: join(root, "current.json"),
      currentPending: join(root, ".current.pending"),
    });
  }

  async initialize(
    input: InitializeCapabilityRepositoryInput,
  ): Promise<PublicCapabilityRepositoryState> {
    throwIfAborted(input.signal);
    const repositoryBaseUrl = canonicalRepositoryBaseUrl(input.repositoryBaseUrl);
    const initializedAt = canonicalTimestamp(input.initializedAt);
    const trustedRoot = materializeStoredFile(input.trustedRoot);
    if (trustedRoot.name !== "root.json") {
      throw new CapabilityRepositoryStoreError("validate repository store input");
    }
    return await this.#withLock(input.signal, async () => {
      const existing = await this.#readCurrent(input.signal, true);
      if (existing !== undefined) {
        if (
          existing.record.repositoryBaseUrl !== repositoryBaseUrl ||
          existing.record.initializedAt !== initializedAt ||
          existing.checkedAt !== undefined ||
          existing.metadata.length !== 1 ||
          !existing.metadata[0]?.content.equals(trustedRoot.content)
        ) {
          throw new CapabilityRepositoryStoreError("validate repository store input");
        }
        return publicState(existing);
      }
      const generation = createGeneration({
        repositoryBaseUrl,
        initializedAt,
        trustedRoot,
        metadata: [trustedRoot],
        candidates: [],
      });
      await this.#authenticate(generation, input.signal);
      await this.#commitGeneration(generation, input.signal);
      return publicState(generation);
    });
  }

  async publish(
    input: PublishCapabilityRepositoryCheckInput,
  ): Promise<CapabilityRepositoryCheckPublication> {
    throwIfAborted(input.signal);
    const checkedAt = canonicalTimestamp(input.checkedAt);
    const metadata = materializeMetadata(input.metadata);
    const index = materializeIndex(input.index);
    const candidates = materializeCandidates(input.candidates);
    assertCheckedEvidence(metadata, index, candidates);
    return await this.#withLock(
      input.signal,
      async () => {
        const current = await this.#readCurrent(input.signal, false);
        if (current === undefined) {
          throw new CapabilityRepositoryStoreError("inspect repository store");
        }
        if (Date.parse(checkedAt) < Date.parse(current.checkedAt ?? current.record.initializedAt)) {
          throw new CapabilityRepositoryStoreError("validate repository store input");
        }
        const generation = createGeneration({
          repositoryBaseUrl: current.record.repositoryBaseUrl,
          initializedAt: current.record.initializedAt,
          trustedRoot: current.trustedRoot,
          checkedAt,
          metadata,
          index,
          candidates,
        });
        await this.#authenticate(generation, input.signal);
        if (generation.record.generationDigest === current.record.generationDigest) {
          const repeated = Object.freeze({
            ...generation,
            checkedAt,
            ...(current.previousGenerationDigest === undefined
              ? {}
              : { previousGenerationDigest: current.previousGenerationDigest }),
          });
          await this.#commitGeneration(repeated, input.signal, current);
          return Object.freeze({
            status: "already_current" as const,
            checkedAt,
            candidates: generation.candidates.map(({ identity }) => publicCandidate(identity)),
          });
        }
        await this.#commitGeneration(generation, input.signal, current);
        return Object.freeze({
          status: "staged" as const,
          checkedAt,
          candidates: generation.candidates.map(({ identity }) => publicCandidate(identity)),
        });
      },
      "settle repository store commit",
    );
  }

  async status(signal?: AbortSignal): Promise<PublicCapabilityRepositoryState | undefined> {
    throwIfAborted(signal);
    return await this.#withLock(signal, async () => {
      const current = await this.#readCurrent(signal, true);
      return current === undefined ? undefined : publicState(current);
    });
  }

  async listCandidates(signal?: AbortSignal) {
    throwIfAborted(signal);
    return await this.#withLock(signal, async () => {
      const current = await this.#readCurrent(signal, false);
      if (current === undefined) {
        throw new CapabilityRepositoryStoreError("inspect repository store");
      }
      return Object.freeze(current.candidates.map(({ identity }) => publicCandidate(identity)));
    });
  }

  async readTrustedState(signal?: AbortSignal) {
    throwIfAborted(signal);
    return await this.#withLock(signal, async () => {
      const current = await this.#readCurrent(signal, false);
      if (current === undefined) {
        throw new CapabilityRepositoryStoreError("inspect repository store");
      }
      return Object.freeze({
        repositoryBaseUrl: current.record.repositoryBaseUrl,
        metadata: Object.freeze(current.metadata.map(storedFile)),
      });
    });
  }

  async readCandidate(
    candidateDigest: string,
    signal?: AbortSignal,
  ): Promise<StoredCapabilityRepositoryCandidate> {
    throwIfAborted(signal);
    if (!/^sha256:[a-f0-9]{64}$/.test(candidateDigest)) {
      throw new CapabilityRepositoryStoreError("read repository candidate");
    }
    return await this.#withLock(signal, async () => {
      const current = await this.#readCurrent(signal, false);
      const candidate = current?.candidates.find(
        ({ identity }) => identity.candidateDigest === candidateDigest,
      );
      if (candidate === undefined) {
        throw new CapabilityRepositoryStoreError("read repository candidate");
      }
      return storedCandidate(candidate.identity, candidate.envelope);
    });
  }

  async removeCandidate(
    candidateDigest: string,
    signal?: AbortSignal,
  ): Promise<PublicCapabilityRepositoryState> {
    throwIfAborted(signal);
    if (!/^sha256:[a-f0-9]{64}$/.test(candidateDigest)) {
      throw new CapabilityRepositoryStoreError("remove repository candidate");
    }
    return await this.#withLock(
      signal,
      async () => {
        const current = await this.#readCurrent(signal, false);
        if (current?.index === undefined || current.checkedAt === undefined) {
          throw new CapabilityRepositoryStoreError("remove repository candidate");
        }
        const candidates = current.candidates.filter(
          ({ identity }) => identity.candidateDigest !== candidateDigest,
        );
        if (candidates.length === current.candidates.length) {
          throw new CapabilityRepositoryStoreError("remove repository candidate");
        }
        throwIfAborted(signal);
        const generation = createGeneration({
          repositoryBaseUrl: current.record.repositoryBaseUrl,
          initializedAt: current.record.initializedAt,
          trustedRoot: current.trustedRoot,
          checkedAt: current.checkedAt,
          metadata: current.metadata,
          index: current.index,
          candidates,
        });
        await this.#authenticate(generation, signal);
        await this.#commitGeneration(generation, signal, current);
        return publicState(generation);
      },
      "settle repository store commit",
    );
  }

  async #withLock<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
    successfulOperationReleaseStage: CapabilityRepositoryStoreStage = "release repository store lock",
  ): Promise<T> {
    const lock = await this.#acquireLock(signal);
    let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; error: unknown };
    try {
      await this.#assertNoPendingState(signal);
      throwIfAborted(signal);
      outcome = { ok: true, value: await operation() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      await releaseLock(lock, this.#paths.root);
    } catch {
      if (outcome.ok) {
        throw new CapabilityRepositoryStoreError(successfulOperationReleaseStage);
      }
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  async #acquireLock(signal: AbortSignal | undefined): Promise<StoreLock> {
    throwIfAborted(signal);
    try {
      await ensureDirectory(this.#paths.flow);
      await ensureDirectory(this.#paths.root);
      await ensureDirectory(this.#paths.generations);
      throwIfAborted(signal);
      const lock = Object.freeze({
        path: this.#paths.lock,
        content: canonicalBytes({
          version: 1,
          hostname: hostname(),
          pid: process.pid,
          token: randomUUID(),
        }),
      });
      const handle = await open(lock.path, "wx", 0o600);
      try {
        await handle.writeFile(lock.content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(this.#paths.root);
      return lock;
    } catch (error) {
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      if (error instanceof CapabilityRepositoryStoreError) {
        throw error;
      }
      throw new CapabilityRepositoryStoreError("acquire repository store lock");
    }
  }

  async #assertNoPendingState(signal: AbortSignal | undefined): Promise<void> {
    for (const path of [this.#paths.generationPending, this.#paths.currentPending]) {
      throwIfAborted(signal);
      try {
        await lstat(path);
        throw new CapabilityRepositoryStoreError("inspect repository store");
      } catch (error) {
        if (error instanceof CapabilityRepositoryStoreError) {
          throw error;
        }
        if (!isNodeError(error) || error.code !== "ENOENT") {
          if (signal?.aborted === true) {
            throw signal.reason;
          }
          throw new CapabilityRepositoryStoreError("inspect repository store");
        }
      }
    }
  }

  async #authenticate(
    generation: MaterializedGeneration,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    throwIfAborted(signal);
    try {
      await this.authenticator.authenticate(authenticationInput(generation, signal));
      throwIfAborted(signal);
    } catch (error) {
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      if (error instanceof CapabilityRepositoryStoreError) {
        throw error;
      }
      throw new CapabilityRepositoryStoreError("read repository generation");
    }
  }

  async #readCurrent(
    signal: AbortSignal | undefined,
    allowMissing: boolean,
  ): Promise<MaterializedGeneration | undefined> {
    let currentBytes: Buffer;
    try {
      currentBytes = await readBoundedRegularFile(this.#paths.current, MAX_CURRENT_RECORD_BYTES);
    } catch (error) {
      if (allowMissing && isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw new CapabilityRepositoryStoreError("inspect repository store");
    }
    throwIfAborted(signal);
    try {
      const current = parseCanonicalRecord(currentBytes, currentRecordSchema);
      if (current.checkedAt !== undefined && Date.now() < Date.parse(current.checkedAt)) {
        throw new Error("repository clock is behind its checked-state high-water");
      }
      const generation = await this.#readGeneration(
        current.generationDigest,
        current.checkedAt,
        current.previousGenerationDigest,
        signal,
      );
      if (generation.record.generationDigest !== current.generationDigest) {
        throw new Error("current record contradicts generation");
      }
      if (
        current.checkedAt === undefined &&
        Date.now() < Date.parse(generation.record.initializedAt)
      ) {
        throw new Error("repository clock is behind its initialization high-water");
      }
      return generation;
    } catch (error) {
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      if (error instanceof CapabilityRepositoryStoreError) {
        throw error;
      }
      throw new CapabilityRepositoryStoreError("inspect repository store");
    }
  }

  async #readGeneration(
    generationDigest: `sha256:${string}`,
    checkedAt: string | undefined,
    previousGenerationDigest: `sha256:${string}` | undefined,
    signal: AbortSignal | undefined,
  ): Promise<MaterializedGeneration> {
    try {
      const directory = generationPath(this.#paths.generations, generationDigest);
      const before = await lstat(directory, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error("generation is not a directory");
      }
      const recordBytes = await readBoundedRegularFile(
        join(directory, "generation.json"),
        MAX_GENERATION_RECORD_BYTES,
      );
      const parsed = parseCanonicalRecord(recordBytes, generationRecordSchema);
      const candidates = parsed.candidates.map((identity) =>
        parseCapabilityRepositoryCandidateIdentityRecord(
          encodeCanonicalCandidateIdentity(identity),
        ),
      );
      const content = generationContent({
        apiVersion: parsed.apiVersion,
        kind: parsed.kind,
        repositoryBaseUrl: parsed.repositoryBaseUrl,
        initializedAt: parsed.initializedAt,
        trustedRoot: parsed.trustedRoot,
        repositoryStateDigest: parsed.repositoryStateDigest,
        metadata: parsed.metadata,
        ...(parsed.index === undefined ? {} : { index: parsed.index }),
        candidates,
      });
      if (
        parsed.generationDigest !== generationDigest ||
        parsed.generationDigest !== digest(canonicalBytes(content))
      ) {
        throw new Error("generation digest is inconsistent");
      }
      const generationDirectory = await observeExactDirectory(
        directory,
        new Map([
          ["candidates", "directory"],
          ["generation.json", "file"],
          ...(parsed.index === undefined ? [] : ([["index.json", "file"]] as const)),
          ["metadata", "directory"],
          ["trusted-root.json", "file"],
        ]),
      );
      if (!sameOpenedFile(before, generationDirectory)) {
        throw new Error("generation changed before its inventory was read");
      }
      const metadataDirectory = join(directory, "metadata");
      const metadataDirectoryIdentity = await observeExactDirectory(
        metadataDirectory,
        new Map(parsed.metadata.map(({ name }) => [name, "file"] as const)),
      );
      const candidatesDirectory = join(directory, "candidates");
      const candidatesDirectoryIdentity = await observeExactDirectory(
        candidatesDirectory,
        new Map(
          candidates.map(({ candidateDigest }) => [
            candidateDigest.slice("sha256:".length),
            "directory" as const,
          ]),
        ),
      );
      const metadata = await Promise.all(
        parsed.metadata.map(async (descriptor) => {
          const content = await readBoundedRegularFile(
            join(metadataDirectory, descriptor.name),
            MAX_METADATA_FILE_BYTES,
          );
          return materializedFile(descriptor, content);
        }),
      );
      if (
        parsed.repositoryStateDigest !==
        calculateCapabilityRepositoryStateDigest(
          metadata.map(({ name, length, digest }) => ({ name, length, digest })),
        )
      ) {
        throw new Error("repository state digest contradicts reopened metadata");
      }
      const trustedRoot = materializedFile(
        parsed.trustedRoot,
        await readBoundedRegularFile(join(directory, "trusted-root.json"), MAX_METADATA_FILE_BYTES),
      );
      if (trustedRoot.name !== "root.json") {
        throw new Error("trusted root descriptor is invalid");
      }
      const index =
        parsed.index === undefined
          ? undefined
          : materializedIndex(
              parsed.index,
              await readBoundedRegularFile(join(directory, "index.json"), MAX_INDEX_FILE_BYTES),
            );
      const candidateDirectoryIdentities: {
        readonly path: string;
        readonly identity: BigIntStats;
      }[] = [];
      const materializedCandidates = await Promise.all(
        candidates.map(async (identity) => {
          const candidateDirectory = join(
            candidatesDirectory,
            identity.candidateDigest.slice("sha256:".length),
          );
          const candidateDirectoryIdentity = await observeExactDirectory(
            candidateDirectory,
            new Map([
              ["candidate.json", "file"],
              ["envelope.json", "file"],
            ]),
          );
          candidateDirectoryIdentities.push({
            path: candidateDirectory,
            identity: candidateDirectoryIdentity,
          });
          const record = await readBoundedRegularFile(
            join(candidateDirectory, "candidate.json"),
            MAX_GENERATION_RECORD_BYTES,
          );
          const reopenedIdentity = parseCapabilityRepositoryCandidateIdentityRecord(record);
          const envelope = await readBoundedRegularFile(
            join(candidateDirectory, "envelope.json"),
            MAX_ENVELOPE_FILE_BYTES,
          );
          if (!isDeepStrictEqual(reopenedIdentity, identity)) {
            throw new Error("candidate record contradicts generation");
          }
          return materializedCandidate(reopenedIdentity, record, envelope);
        }),
      );
      if (
        !sameOpenedFile(
          metadataDirectoryIdentity,
          await lstat(metadataDirectory, { bigint: true }),
        ) ||
        !sameOpenedFile(
          candidatesDirectoryIdentity,
          await lstat(candidatesDirectory, { bigint: true }),
        )
      ) {
        throw new Error("generation directories changed while being read");
      }
      for (const candidateDirectory of candidateDirectoryIdentities) {
        if (
          !sameOpenedFile(
            candidateDirectory.identity,
            await lstat(candidateDirectory.path, { bigint: true }),
          )
        ) {
          throw new Error("candidate directory changed while being read");
        }
      }
      const after = await lstat(directory, { bigint: true });
      if (!sameOpenedFile(before, after)) {
        throw new Error("generation changed while being read");
      }
      const generation: MaterializedGeneration = Object.freeze({
        record: Object.freeze({ ...content, generationDigest }),
        recordBytes,
        ...(checkedAt === undefined ? {} : { checkedAt }),
        ...(previousGenerationDigest === undefined ? {} : { previousGenerationDigest }),
        trustedRoot,
        metadata: Object.freeze(metadata),
        ...(index === undefined ? {} : { index }),
        candidates: Object.freeze(materializedCandidates),
      });
      if ((generation.index === undefined) !== (generation.checkedAt === undefined)) {
        throw new Error("current observation contradicts generation state");
      }
      assertCheckedEvidence(generation.metadata, generation.index, generation.candidates);
      await this.#authenticate(generation, signal);
      return generation;
    } catch (error) {
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      if (error instanceof CapabilityRepositoryStoreError) {
        throw error;
      }
      throw new CapabilityRepositoryStoreError("read repository generation");
    }
  }

  async #commitGeneration(
    generation: MaterializedGeneration,
    signal: AbortSignal | undefined,
    previous?: MaterializedGeneration,
  ): Promise<void> {
    const target = generationPath(this.#paths.generations, generation.record.generationDigest);
    let generationRenamed = false;
    let currentRenamed = false;
    const generationAlreadyCurrent =
      previous?.record.generationDigest === generation.record.generationDigest;
    try {
      if (!generationAlreadyCurrent) {
        await this.#writeGenerationPending(generation);
        throwIfAborted(signal);
        await rename(this.#paths.generationPending, target);
        generationRenamed = true;
        await syncDirectory(this.#paths.generations);
      }
      const previousGenerationDigest = generationAlreadyCurrent
        ? previous.previousGenerationDigest
        : previous?.record.generationDigest;
      await writeDurableFile(
        this.#paths.currentPending,
        canonicalBytes({
          apiVersion: API_VERSION,
          kind: "CapabilityRepositoryCurrent",
          generationDigest: generation.record.generationDigest,
          ...(generation.checkedAt === undefined ? {} : { checkedAt: generation.checkedAt }),
          ...(previousGenerationDigest === undefined ? {} : { previousGenerationDigest }),
        }),
      );
      await this.hooks.beforeCurrentRenamed?.();
      throwIfAborted(signal);
      await rename(this.#paths.currentPending, this.#paths.current);
      currentRenamed = true;
      await this.hooks.afterCurrentRenamed?.();
      await syncDirectory(this.#paths.root);
      await this.#enforceGenerationCapacity(
        generation.record.generationDigest,
        previousGenerationDigest,
      );
    } catch {
      if (!currentRenamed) {
        await rm(this.#paths.currentPending, { force: true }).catch(() => undefined);
        await rm(this.#paths.generationPending, { force: true, recursive: true }).catch(
          () => undefined,
        );
        if (generationRenamed) {
          await rm(target, { recursive: true }).catch(() => undefined);
        }
        if (signal?.aborted === true) {
          throw signal.reason;
        }
        throw new CapabilityRepositoryStoreError("publish repository current state");
      }
      throw new CapabilityRepositoryStoreError("settle repository store commit");
    }
  }

  async #writeGenerationPending(generation: MaterializedGeneration): Promise<void> {
    try {
      await mkdir(this.#paths.generationPending, { mode: 0o700 });
      const metadataDirectory = join(this.#paths.generationPending, "metadata");
      const candidatesDirectory = join(this.#paths.generationPending, "candidates");
      await mkdir(metadataDirectory, { mode: 0o700 });
      await mkdir(candidatesDirectory, { mode: 0o700 });
      await writeDurableFile(
        join(this.#paths.generationPending, "generation.json"),
        generation.recordBytes,
      );
      await writeDurableFile(
        join(this.#paths.generationPending, "trusted-root.json"),
        generation.trustedRoot.content,
      );
      for (const file of generation.metadata) {
        await writeDurableFile(join(metadataDirectory, file.name), file.content);
      }
      if (generation.index !== undefined) {
        await writeDurableFile(
          join(this.#paths.generationPending, "index.json"),
          generation.index.content,
        );
      }
      for (const candidate of generation.candidates) {
        const directory = join(
          candidatesDirectory,
          candidate.identity.candidateDigest.slice("sha256:".length),
        );
        await mkdir(directory, { mode: 0o700 });
        await writeDurableFile(join(directory, "candidate.json"), candidate.record);
        await writeDurableFile(join(directory, "envelope.json"), candidate.envelope);
        await syncDirectory(directory);
      }
      await syncDirectory(metadataDirectory);
      await syncDirectory(candidatesDirectory);
      await syncDirectory(this.#paths.generationPending);
    } catch (error) {
      if (error instanceof CapabilityRepositoryStoreError) {
        throw error;
      }
      throw new CapabilityRepositoryStoreError("publish repository generation");
    }
  }

  async #enforceGenerationCapacity(
    currentDigest: `sha256:${string}`,
    previousDigest: `sha256:${string}` | undefined,
  ): Promise<void> {
    const names: string[] = [];
    for await (const entry of await opendir(this.#paths.generations)) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(entry.name)) {
        throw new CapabilityRepositoryStoreError("enforce repository store capacity");
      }
      names.push(entry.name);
      if (names.length > MAX_CAPABILITY_REPOSITORY_GENERATIONS + 1) {
        throw new CapabilityRepositoryStoreError("enforce repository store capacity");
      }
    }
    if (names.length <= MAX_CAPABILITY_REPOSITORY_GENERATIONS) {
      return;
    }
    const retained = new Set([
      currentDigest.slice("sha256:".length),
      ...(previousDigest === undefined ? [] : [previousDigest.slice("sha256:".length)]),
    ]);
    const removable = names.filter((name) => !retained.has(name));
    if (removable.length !== names.length - MAX_CAPABILITY_REPOSITORY_GENERATIONS) {
      throw new CapabilityRepositoryStoreError("enforce repository store capacity");
    }
    for (const name of removable) {
      await rm(join(this.#paths.generations, name), { recursive: true });
    }
    await syncDirectory(this.#paths.generations);
  }
}

function createGeneration(input: {
  readonly repositoryBaseUrl: string;
  readonly initializedAt: string;
  readonly trustedRoot: MaterializedFile;
  readonly checkedAt?: string;
  readonly metadata: readonly MaterializedFile[];
  readonly index?: MaterializedIndex;
  readonly candidates: readonly MaterializedCandidate[];
}): MaterializedGeneration {
  const repositoryStateDigest = calculateCapabilityRepositoryStateDigest(
    input.metadata.map(({ name, length, digest }) => ({ name, length, digest })),
  );
  const content = generationContent({
    apiVersion: API_VERSION,
    kind: "CapabilityRepositoryGeneration",
    repositoryBaseUrl: input.repositoryBaseUrl,
    initializedAt: input.initializedAt,
    trustedRoot: {
      name: input.trustedRoot.name,
      length: input.trustedRoot.length,
      digest: input.trustedRoot.digest,
    },
    repositoryStateDigest,
    metadata: input.metadata.map(({ name, length, digest }) => ({ name, length, digest })),
    ...(input.index === undefined
      ? {}
      : {
          index: {
            path: input.index.path,
            length: input.index.length,
            hashes: input.index.hashes,
          },
        }),
    candidates: input.candidates.map(({ identity }) => identity),
  });
  const generationDigest = digest(canonicalBytes(content));
  const record = Object.freeze({ ...content, generationDigest });
  return Object.freeze({
    record,
    recordBytes: canonicalBytes(record),
    ...(input.checkedAt === undefined ? {} : { checkedAt: input.checkedAt }),
    trustedRoot: input.trustedRoot,
    metadata: Object.freeze([...input.metadata]),
    ...(input.index === undefined ? {} : { index: input.index }),
    candidates: Object.freeze([...input.candidates]),
  });
}

function generationContent(input: GenerationRecordContent): GenerationRecordContent {
  return Object.freeze({
    apiVersion: API_VERSION,
    kind: "CapabilityRepositoryGeneration",
    repositoryBaseUrl: input.repositoryBaseUrl,
    initializedAt: input.initializedAt,
    trustedRoot: Object.freeze({ ...input.trustedRoot }),
    repositoryStateDigest: input.repositoryStateDigest,
    metadata: Object.freeze(input.metadata.map((entry) => Object.freeze({ ...entry }))),
    ...(input.index === undefined
      ? {}
      : {
          index: Object.freeze({
            path: input.index.path,
            length: input.index.length,
            hashes: Object.freeze({ ...input.index.hashes }),
          }),
        }),
    candidates: Object.freeze(input.candidates.map((candidate) => candidate)),
  });
}

function materializeMetadata(
  files: readonly CapabilityRepositoryStoredFile[],
): readonly MaterializedFile[] {
  const materialized = files.map(materializeStoredFile);
  for (let index = 0; index < materialized.length; index += 1) {
    const current = materialized[index];
    const previous = materialized[index - 1];
    if (current === undefined || (previous !== undefined && previous.name >= current.name)) {
      throw new CapabilityRepositoryStoreError("validate repository store input");
    }
  }
  if (materialized.length < 1 || materialized.length > 34) {
    throw new CapabilityRepositoryStoreError("validate repository store input");
  }
  return Object.freeze(materialized);
}

function materializeStoredFile(file: CapabilityRepositoryStoredFile): MaterializedFile {
  try {
    const descriptor = metadataDescriptorSchema.parse({
      name: file.name,
      length: file.length,
      digest: file.digest,
    });
    const content = file.bytes();
    return materializedFile(descriptor, content);
  } catch {
    throw new CapabilityRepositoryStoreError("validate repository store input");
  }
}

function materializedFile(
  descriptor: { readonly name: string; readonly length: number; readonly digest: string },
  content: Buffer,
): MaterializedFile {
  const copy = Buffer.from(content);
  if (descriptor.length !== copy.byteLength || descriptor.digest !== digest(copy)) {
    throw new Error("metadata descriptor is inconsistent");
  }
  return Object.freeze({
    name: descriptor.name,
    length: descriptor.length,
    digest: descriptor.digest as `sha256:${string}`,
    content: copy,
  });
}

function materializeIndex(index: CapabilityRepositoryStoredIndex): MaterializedIndex {
  try {
    const descriptor = indexDescriptorSchema.parse({
      path: index.path,
      length: index.length,
      hashes: index.hashes,
    });
    return materializedIndex(descriptor, index.bytes());
  } catch {
    throw new CapabilityRepositoryStoreError("validate repository store input");
  }
}

function materializedIndex(
  descriptor: {
    readonly path: "flow/capability-index.json";
    readonly length: number;
    readonly hashes: Readonly<{ readonly sha256: string }>;
  },
  content: Buffer,
): MaterializedIndex {
  const copy = Buffer.from(content);
  if (descriptor.length !== copy.byteLength || descriptor.hashes.sha256 !== sha256Hex(copy)) {
    throw new Error("index descriptor is inconsistent");
  }
  return Object.freeze({
    path: descriptor.path,
    length: descriptor.length,
    hashes: Object.freeze({ sha256: descriptor.hashes.sha256 }),
    content: copy,
  });
}

function materializeCandidates(
  candidates: readonly CapabilityRepositoryCandidate[],
): readonly MaterializedCandidate[] {
  if (candidates.length > MAX_STAGED_CAPABILITY_REPOSITORY_CANDIDATES) {
    throw new CapabilityRepositoryStoreError("enforce repository store capacity");
  }
  const result = candidates.map((candidate) =>
    materializedCandidate(
      candidate.identity,
      encodeCapabilityRepositoryCandidateIdentity(candidate.identity),
      candidate.envelopeBytes(),
    ),
  );
  result.sort((left, right) =>
    left.identity.candidateDigest.localeCompare(right.identity.candidateDigest),
  );
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]?.identity.candidateDigest === result[index]?.identity.candidateDigest) {
      throw new CapabilityRepositoryStoreError("validate repository store input");
    }
  }
  return Object.freeze(result);
}

function materializedCandidate(
  identity: CapabilityRepositoryCandidateIdentity,
  record: Buffer,
  envelope: Buffer,
): MaterializedCandidate {
  const content = Buffer.from(envelope);
  if (
    identity.envelope.bytes !== content.byteLength ||
    identity.envelope.digest !== digest(content)
  ) {
    throw new Error("candidate envelope is inconsistent");
  }
  return Object.freeze({
    identity,
    record: Buffer.from(record),
    envelope: content,
    envelopeBytes: () => Buffer.from(content),
  });
}

function assertCheckedEvidence(
  metadata: readonly MaterializedFile[],
  index: MaterializedIndex | undefined,
  candidates: readonly MaterializedCandidate[],
): void {
  if (index === undefined) {
    if (candidates.length !== 0 || metadata.length !== 1 || metadata[0]?.name !== "root.json") {
      throw new CapabilityRepositoryStoreError("validate repository store input");
    }
    return;
  }
  const descriptors = metadata.map(({ name, length, digest }) => ({ name, length, digest }));
  const repositoryStateDigest = calculateCapabilityRepositoryStateDigest(descriptors);
  for (const candidate of candidates) {
    if (
      candidate.identity.repository.stateDigest !== repositoryStateDigest ||
      !isDeepStrictEqual(candidate.identity.repository.metadata, descriptors) ||
      candidate.identity.index.path !== index.path ||
      candidate.identity.index.bytes !== index.length ||
      candidate.identity.index.digest !== `sha256:${index.hashes.sha256}`
    ) {
      throw new CapabilityRepositoryStoreError("validate repository store input");
    }
  }
}

function authenticationInput(
  generation: MaterializedGeneration,
  signal: AbortSignal | undefined,
): AuthenticateCapabilityRepositoryGenerationInput {
  return Object.freeze({
    repositoryBaseUrl: generation.record.repositoryBaseUrl,
    initializedAt: generation.record.initializedAt,
    ...(generation.checkedAt === undefined ? {} : { checkedAt: generation.checkedAt }),
    trustedRoot: storedFile(generation.trustedRoot),
    metadata: generation.metadata.map(storedFile),
    ...(generation.index === undefined ? {} : { index: storedIndex(generation.index) }),
    candidates: generation.candidates.map((candidate) =>
      storedCandidate(candidate.identity, candidate.envelope),
    ),
    ...(signal === undefined ? {} : { signal }),
  });
}

function storedFile(file: MaterializedFile): CapabilityRepositoryStoredFile {
  return Object.freeze({
    name: file.name,
    length: file.length,
    digest: file.digest,
    bytes: () => Buffer.from(file.content),
  });
}

function storedIndex(index: MaterializedIndex): CapabilityRepositoryStoredIndex {
  return Object.freeze({
    path: index.path,
    length: index.length,
    hashes: Object.freeze({ ...index.hashes }),
    bytes: () => Buffer.from(index.content),
  });
}

function storedCandidate(
  identity: CapabilityRepositoryCandidateIdentity,
  envelope: Buffer,
): StoredCapabilityRepositoryCandidate {
  const content = Buffer.from(envelope);
  return Object.freeze({ identity, envelopeBytes: () => Buffer.from(content) });
}

function publicCandidate(identity: CapabilityRepositoryCandidateIdentity) {
  return toPublicCapabilityRepositoryCandidate(Object.freeze({ identity }));
}

function publicState(generation: MaterializedGeneration): PublicCapabilityRepositoryState {
  return Object.freeze({
    apiVersion: API_VERSION,
    kind: "CapabilityRepositoryState",
    status: generation.checkedAt === undefined ? "initialized" : "checked",
    generationDigest: generation.record.generationDigest,
    repositoryStateDigest: generation.record.repositoryStateDigest,
    initializedAt: generation.record.initializedAt,
    ...(generation.checkedAt === undefined ? {} : { checkedAt: generation.checkedAt }),
    metadata: Object.freeze(
      generation.metadata.map(({ name, length, digest }) =>
        Object.freeze({ name, length, digest }),
      ),
    ),
    candidates: Object.freeze(
      generation.candidates.map(({ identity }) => publicCandidate(identity)),
    ),
  });
}

function canonicalRepositoryBaseUrl(input: string): string {
  try {
    const parsed = new URL(input);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.pathname === "" ||
      !parsed.pathname.endsWith("/") ||
      parsed.toString() !== input
    ) {
      throw new Error("repository base URL is not canonical public HTTPS");
    }
    return input;
  } catch {
    throw new CapabilityRepositoryStoreError("validate repository store input");
  }
}

function canonicalTimestamp(input: string): string {
  try {
    return timestampSchema.parse(input);
  } catch {
    throw new CapabilityRepositoryStoreError("validate repository store input");
  }
}

function parseCanonicalRecord<T>(content: Buffer, schema: z.ZodType<T>): T {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const parsed = schema.parse(
    parseStrictJson(decoded, { maxDepth: 64, maxNodes: 200_000, valueLabel: "repository record" }),
  );
  if (!content.equals(canonicalBytes(parsed))) {
    throw new Error("repository record is not canonical");
  }
  return parsed;
}

function encodeCanonicalCandidateIdentity(input: unknown): Buffer {
  return canonicalBytes(input);
}

function canonicalBytes(input: unknown): Buffer {
  return Buffer.from(JSON.stringify(input));
}

function generationPath(root: string, digest: `sha256:${string}`): string {
  return join(root, digest.slice("sha256:".length));
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("store path is not a directory");
  }
}

async function observeExactDirectory(
  path: string,
  expectedEntries: ReadonlyMap<string, "directory" | "file">,
): Promise<BigIntStats> {
  const identity = await lstat(path, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error("repository path is not an ordinary directory");
  }
  const observed = new Map<string, "directory" | "file">();
  for await (const entry of await opendir(path)) {
    if (entry.isSymbolicLink()) {
      throw new Error("repository directory contains a symbolic link");
    }
    const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : undefined;
    if (kind === undefined || observed.has(entry.name)) {
      throw new Error("repository directory contains an unsupported entry");
    }
    observed.set(entry.name, kind);
    if (observed.size > expectedEntries.size) {
      throw new Error("repository directory contains too many entries");
    }
  }
  if (observed.size !== expectedEntries.size) {
    throw new Error("repository directory is incomplete");
  }
  for (const [name, kind] of expectedEntries) {
    if (observed.get(name) !== kind) {
      throw new Error("repository directory contradicts its record");
    }
  }
  return identity;
}

async function writeDurableFile(path: string, content: Buffer): Promise<void> {
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
      throw new Error("repository file is not a bounded regular file");
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const lexical = await lstat(path, { bigint: true });
    if (
      content.byteLength !== Number(before.size) ||
      !sameOpenedFile(before, after) ||
      !sameOpenedFile(after, lexical)
    ) {
      throw new Error("repository file changed while being read");
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function releaseLock(lock: StoreLock, root: string): Promise<void> {
  const observed = await readBoundedRegularFile(lock.path, MAX_LOCK_RECORD_BYTES);
  lockRecordSchema.parse(
    parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(observed), {
      maxDepth: 4,
      maxNodes: 16,
      valueLabel: "repository lock",
    }),
  );
  if (!observed.equals(lock.content)) {
    throw new Error("repository lock ownership changed");
  }
  await unlink(lock.path);
  await syncDirectory(root);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameOpenedFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(content)}`;
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
