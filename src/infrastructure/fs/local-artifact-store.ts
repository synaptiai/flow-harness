import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import type {
  ArtifactAvailability,
  ArtifactCatalogEntry,
  ArtifactInspection,
  ArtifactPrunePlan,
  ArtifactPruneResult,
  ArtifactReadWindow,
  ArtifactRetention,
  ArtifactStore,
} from "../../application/artifact-store.js";
import {
  type ArtifactDescriptor,
  type ArtifactProducer,
  type ArtifactReference,
  artifactReferenceSchema,
  createArtifactReference,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_READ_BYTES,
  validateArtifactReference,
} from "../../domain/artifact/reference.js";
import { parseStrictJson } from "../../domain/strict-json.js";

const MAX_CATALOG_REFERENCES = 4_096;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_PRUNED_DIGESTS = 4_096;
const MAX_BLOB_ENTRIES = MAX_CATALOG_REFERENCES + MAX_PRUNED_DIGESTS;

export interface LocalArtifactStoreTestHooks {
  readonly afterBlobPublished?: (descriptor: ArtifactDescriptor) => Promise<void>;
  readonly afterBlobOpened?: (descriptor: ArtifactDescriptor) => Promise<void>;
  readonly afterBlobUnlinked?: (descriptor: ArtifactDescriptor) => Promise<void>;
  readonly afterBlobRemoved?: (descriptor: ArtifactDescriptor) => Promise<void>;
  readonly beforeCatalogPublished?: (generation: number) => Promise<void>;
  readonly afterCatalogPublished?: (generation: number) => Promise<void>;
  readonly beforeLockAcquired?: () => Promise<void>;
}

export type LocalArtifactStoreErrorCode =
  | "busy"
  | "changed"
  | "commit_uncertain"
  | "corrupt_catalog"
  | "invalid_request"
  | "io"
  | "limit_exceeded"
  | "missing"
  | "not_found"
  | "pruned"
  | "settlement_uncertain"
  | "stale_plan"
  | "unauthorized"
  | "unsafe_state";

export class LocalArtifactStoreError extends Error {
  override readonly name = "LocalArtifactStoreError";

  constructor(readonly code: LocalArtifactStoreErrorCode) {
    super(publicMessage(code));
  }
}

const catalogReferenceSchema = z
  .object({
    reference: artifactReferenceSchema,
    retention: z.enum(["retained", "released"]),
  })
  .strict();
const catalogSchema = z
  .object({
    version: z.literal(1),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    references: z.array(catalogReferenceSchema).max(MAX_CATALOG_REFERENCES),
    prunedDigests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).max(MAX_PRUNED_DIGESTS),
    catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

interface CatalogReference {
  readonly reference: ArtifactReference;
  readonly retention: ArtifactRetention;
}

interface Catalog {
  readonly version: 1;
  readonly generation: number;
  readonly references: readonly CatalogReference[];
  readonly prunedDigests: readonly string[];
  readonly catalogDigest: string;
}

interface HeldLock {
  readonly path: string;
  readonly identity: Stats;
}

export class LocalArtifactStore implements ArtifactStore {
  readonly #projectRoot: string;
  readonly #flowRoot: string;
  readonly #storeRoot: string;
  readonly #blobRoot: string;
  readonly #catalogPath: string;
  readonly #lockPath: string;
  readonly #testHooks: LocalArtifactStoreTestHooks;

  constructor(projectRoot: string, testHooks: LocalArtifactStoreTestHooks = {}) {
    this.#projectRoot = resolve(projectRoot);
    this.#flowRoot = join(this.#projectRoot, ".flow");
    this.#storeRoot = join(this.#flowRoot, "artifacts");
    this.#blobRoot = join(this.#storeRoot, "blobs");
    this.#catalogPath = join(this.#storeRoot, "catalog.json");
    this.#lockPath = join(this.#storeRoot, "mutation.lock");
    this.#testHooks = testHooks;
  }

  async retain(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly producer: ArtifactProducer;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactReference> {
    input.signal?.throwIfAborted();
    if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new LocalArtifactStoreError("limit_exceeded");
    }
    const bytes = Buffer.from(input.bytes);
    const descriptor: ArtifactDescriptor = {
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.length,
      mediaType: input.mediaType,
    };
    const reference = createArtifactReference({ descriptor, producer: input.producer });
    return await this.#withLock(input.signal, async () => {
      input.signal?.throwIfAborted();
      const catalog = await this.#readCatalog(input.signal);
      const existing = findReference(catalog, reference.reference);
      if (existing === undefined && catalog.references.length >= MAX_CATALOG_REFERENCES) {
        throw new LocalArtifactStoreError("limit_exceeded");
      }
      await this.#publishBlob(reference.descriptor, bytes, input.signal);
      await this.#testHooks.afterBlobPublished?.(reference.descriptor);
      input.signal?.throwIfAborted();
      const wasPruned = catalog.prunedDigests.includes(reference.descriptor.digest);
      if (existing !== undefined && existing.retention === "retained" && !wasPruned) {
        return existing.reference;
      }
      const next = createCatalog({
        generation: nextGeneration(catalog.generation),
        references:
          existing === undefined
            ? [...catalog.references, { reference, retention: "retained" }]
            : catalog.references.map((record) =>
                record.reference.reference === reference.reference
                  ? { reference: record.reference, retention: "retained" }
                  : record,
              ),
        prunedDigests: catalog.prunedDigests.filter(
          (digest) => digest !== reference.descriptor.digest,
        ),
      });
      await this.#writeCatalog(next, catalog, input.signal);
      return reference;
    });
  }

  async read(input: {
    readonly reference: string;
    readonly runId: string;
    readonly offset: number;
    readonly maxBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactReadWindow> {
    validateReadRequest(input);
    return await this.#withLock(input.signal, async () => {
      input.signal?.throwIfAborted();
      const catalog = await this.#readCatalog(input.signal);
      const record = requireReference(catalog, input.reference);
      if (record.reference.producer.runId !== input.runId) {
        throw new LocalArtifactStoreError("unauthorized");
      }
      if (catalog.prunedDigests.includes(record.reference.descriptor.digest)) {
        throw new LocalArtifactStoreError("pruned");
      }
      if (input.offset > record.reference.descriptor.size) {
        throw new LocalArtifactStoreError("invalid_request");
      }
      const observation = await this.#readBlob(record.reference.descriptor, input.signal);
      requireAvailable(observation.availability);
      const end = Math.min(observation.bytes.length, input.offset + input.maxBytes);
      const bytes = Buffer.from(observation.bytes.subarray(input.offset, end));
      return Object.freeze({
        reference: record.reference,
        offset: input.offset,
        bytes,
        nextOffset: end,
        complete: end === observation.bytes.length,
      });
    });
  }

  async inspect(reference: string, signal?: AbortSignal): Promise<ArtifactInspection> {
    validateReferenceIdentifier(reference);
    return await this.#withLock(signal, async () => {
      const catalog = await this.#readCatalog(signal);
      return await this.#inspectRecord(catalog, requireReference(catalog, reference), signal);
    });
  }

  async list(signal?: AbortSignal): Promise<readonly ArtifactCatalogEntry[]> {
    return await this.#withLock(signal, async () => {
      const catalog = await this.#readCatalog(signal);
      return Object.freeze(
        catalog.references.map((record) =>
          Object.freeze({ reference: record.reference, retention: record.retention }),
        ),
      );
    });
  }

  async setRetention(input: {
    readonly reference: string;
    readonly retention: ArtifactRetention;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactInspection> {
    validateReferenceIdentifier(input.reference);
    if (input.retention !== "retained" && input.retention !== "released") {
      throw new LocalArtifactStoreError("invalid_request");
    }
    return await this.#withLock(input.signal, async () => {
      input.signal?.throwIfAborted();
      const catalog = await this.#readCatalog(input.signal);
      const record = requireReference(catalog, input.reference);
      const next =
        record.retention === input.retention
          ? catalog
          : createCatalog({
              generation: nextGeneration(catalog.generation),
              references: catalog.references.map((candidate) =>
                candidate.reference.reference === input.reference
                  ? { reference: candidate.reference, retention: input.retention }
                  : candidate,
              ),
              prunedDigests: catalog.prunedDigests,
            });
      if (next !== catalog) {
        await this.#writeCatalog(next, catalog, input.signal);
      }
      return await this.#inspectRecord(
        next,
        requireReference(next, input.reference),
        next === catalog ? input.signal : undefined,
      );
    });
  }

  async planPrune(signal?: AbortSignal): Promise<ArtifactPrunePlan> {
    return await this.#withLock(signal, async () => {
      const catalog = await this.#readCatalog(signal);
      return await this.#createPrunePlan(catalog, signal);
    });
  }

  async applyPrune(input: {
    readonly expectedPlanDigest: string;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactPruneResult> {
    if (!/^[a-f0-9]{64}$/.test(input.expectedPlanDigest)) {
      throw new LocalArtifactStoreError("stale_plan");
    }
    return await this.#withLock(input.signal, async () => {
      input.signal?.throwIfAborted();
      const catalog = await this.#readCatalog(input.signal);
      const plan = await this.#createPrunePlan(catalog, input.signal);
      if (plan.planDigest !== input.expectedPlanDigest) {
        throw new LocalArtifactStoreError("stale_plan");
      }
      let settlementStarted = false;
      for (const descriptor of plan.items) {
        const operationSignal = settlementStarted ? undefined : input.signal;
        operationSignal?.throwIfAborted();
        if (await this.#removeBlob(descriptor, operationSignal)) {
          settlementStarted = true;
          await this.#testHooks.afterBlobRemoved?.(descriptor);
        }
      }
      if (plan.items.length > 0) {
        const referencedDigests = new Set(
          catalog.references.map((record) => record.reference.descriptor.digest),
        );
        const next = createCatalog({
          generation: nextGeneration(catalog.generation),
          references: catalog.references,
          prunedDigests: [
            ...new Set([
              ...catalog.prunedDigests,
              ...plan.items
                .filter((item) => referencedDigests.has(item.digest))
                .map((item) => item.digest),
            ]),
          ],
        });
        await this.#writeCatalog(next, catalog, settlementStarted ? undefined : input.signal);
      }
      return Object.freeze({
        planDigest: plan.planDigest,
        pruned: Object.freeze(plan.items.map((item) => Object.freeze({ ...item }))),
      });
    });
  }

  blobPathForTest(digest: string): string {
    return this.#blobPath(digest);
  }

  async #inspectRecord(
    catalog: Catalog,
    record: CatalogReference,
    signal?: AbortSignal,
  ): Promise<ArtifactInspection> {
    const observation = await this.#readBlob(record.reference.descriptor, signal, true);
    const availability =
      observation.availability === "missing" &&
      catalog.prunedDigests.includes(record.reference.descriptor.digest)
        ? "pruned"
        : observation.availability;
    return Object.freeze({
      reference: record.reference,
      retention: record.retention,
      availability,
    });
  }

  async #createPrunePlan(catalog: Catalog, signal?: AbortSignal): Promise<ArtifactPrunePlan> {
    const byDigest = new Map<string, CatalogReference[]>();
    for (const record of catalog.references) {
      const records = byDigest.get(record.reference.descriptor.digest) ?? [];
      records.push(record);
      byDigest.set(record.reference.descriptor.digest, records);
    }
    const items: ArtifactDescriptor[] = [];
    for (const [, records] of [...byDigest.entries()].sort(([left], [right]) =>
      compareStrings(left, right),
    )) {
      signal?.throwIfAborted();
      if (records.some((record) => record.retention === "retained")) continue;
      const descriptor = records[0]?.reference.descriptor;
      if (descriptor === undefined) continue;
      const observation = await this.#readBlob(descriptor, signal, true);
      if (
        observation.availability === "available" ||
        (observation.availability === "missing" &&
          !catalog.prunedDigests.includes(descriptor.digest))
      ) {
        items.push(descriptor);
      }
      if (observation.availability === "changed") {
        throw new LocalArtifactStoreError("changed");
      }
    }
    for (const descriptor of await this.#listOrphanBlobs(byDigest, signal)) {
      items.push(descriptor);
    }
    items.sort((left, right) => compareStrings(left.digest, right.digest));
    const frozenItems = Object.freeze(items.map((item) => Object.freeze({ ...item })));
    const planDigest = calculatePrunePlanDigest(catalog.generation, frozenItems);
    return Object.freeze({
      version: 1,
      catalogGeneration: catalog.generation,
      items: frozenItems,
      planDigest,
    });
  }

  async #listOrphanBlobs(
    referenced: ReadonlyMap<string, readonly CatalogReference[]>,
    signal?: AbortSignal,
  ): Promise<readonly ArtifactDescriptor[]> {
    const directory = await opendir(this.#blobRoot);
    const orphans: ArtifactDescriptor[] = [];
    let entries = 0;
    try {
      for await (const entry of directory) {
        signal?.throwIfAborted();
        entries += 1;
        if (entries > MAX_BLOB_ENTRIES) throw new LocalArtifactStoreError("limit_exceeded");
        if (!/^[a-f0-9]{64}$/.test(entry.name)) {
          throw new LocalArtifactStoreError("unsafe_state");
        }
        const digest = `sha256:${entry.name}`;
        if (referenced.has(digest)) continue;
        const identity = await lstat(join(this.#blobRoot, entry.name), { bigint: true }).catch(
          () => undefined,
        );
        signal?.throwIfAborted();
        if (
          identity === undefined ||
          !isSafeFile(identity) ||
          identity.size > BigInt(MAX_ARTIFACT_BYTES)
        ) {
          throw new LocalArtifactStoreError("unsafe_state");
        }
        const descriptor: ArtifactDescriptor = {
          digest,
          size: Number(identity.size),
          mediaType: "application/octet-stream",
        };
        const observation = await this.#readBlob(descriptor, signal);
        requireAvailable(observation.availability);
        orphans.push(Object.freeze(descriptor));
      }
    } finally {
      await directory.close().catch((error: unknown) => {
        if (!isNodeError(error, "ERR_DIR_CLOSED")) throw error;
      });
      signal?.throwIfAborted();
    }
    return Object.freeze(orphans);
  }

  async #publishBlob(
    descriptor: ArtifactDescriptor,
    bytes: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    const existing = await this.#readBlob(descriptor, signal, true);
    if (existing.availability === "available") return;
    if (existing.availability === "changed") throw new LocalArtifactStoreError("changed");
    signal?.throwIfAborted();
    const temporary = join(this.#blobRoot, `.blob-${randomUUID()}`);
    let handle: FileHandle | undefined;
    let linked = false;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      signal?.throwIfAborted();
      await handle.writeFile(bytes);
      signal?.throwIfAborted();
      await handle.sync();
      const identity = await handle.stat({ bigint: true });
      if (!identity.isFile() || identity.nlink !== 1n || identity.size !== BigInt(bytes.length)) {
        throw new LocalArtifactStoreError("unsafe_state");
      }
      await handle.close();
      handle = undefined;
      signal?.throwIfAborted();
      try {
        await link(temporary, this.#blobPath(descriptor.digest));
        linked = true;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      await unlink(temporary);
      await syncDirectory(this.#blobRoot);
      const settled = await this.#readBlob(descriptor, undefined, true);
      if (settled.availability !== "available") {
        throw new LocalArtifactStoreError("commit_uncertain");
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      if (!linked) signal?.throwIfAborted();
      if (error instanceof LocalArtifactStoreError) throw error;
      throw new LocalArtifactStoreError("commit_uncertain");
    }
  }

  async #removeBlob(descriptor: ArtifactDescriptor, signal?: AbortSignal): Promise<boolean> {
    const path = this.#blobPath(descriptor.digest);
    const before = await lstat(path, { bigint: true }).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    signal?.throwIfAborted();
    if (before === undefined) return false;
    assertSafeFile(before, descriptor.size);
    const current = await lstat(path, { bigint: true });
    if (!sameFile(before, current)) throw new LocalArtifactStoreError("unsafe_state");
    let unlinked = false;
    try {
      await unlink(path);
      unlinked = true;
      await this.#testHooks.afterBlobUnlinked?.(descriptor);
      await syncDirectory(this.#blobRoot);
      return true;
    } catch (error) {
      if (unlinked) throw new LocalArtifactStoreError("commit_uncertain");
      throw error;
    }
  }

  async #readBlob(
    descriptor: ArtifactDescriptor,
    signal?: AbortSignal,
    allowMissing = false,
  ): Promise<{ readonly availability: ArtifactAvailability; readonly bytes: Buffer }> {
    const path = this.#blobPath(descriptor.digest);
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (isNodeError(error, "ENOENT") && allowMissing) {
        return { availability: "missing", bytes: Buffer.alloc(0) };
      }
      if (isNodeError(error, "ENOENT")) throw new LocalArtifactStoreError("missing");
      if (isUnsafeOpenError(error)) return { availability: "changed", bytes: Buffer.alloc(0) };
      throw new LocalArtifactStoreError("io");
    }
    try {
      signal?.throwIfAborted();
      await this.#testHooks.afterBlobOpened?.(descriptor);
      signal?.throwIfAborted();
      const before = await handle.stat({ bigint: true });
      if (!isSafeFile(before, descriptor.size)) {
        return { availability: "changed", bytes: Buffer.alloc(0) };
      }
      const bytes = await readBoundedHandle(handle, MAX_ARTIFACT_BYTES, signal);
      const after = await handle.stat({ bigint: true });
      const lexical = await lstat(path, { bigint: true }).catch(() => undefined);
      if (
        lexical === undefined ||
        !sameFile(before, after) ||
        !sameFile(before, lexical) ||
        bytes.length !== descriptor.size ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== descriptor.digest
      ) {
        return { availability: "changed", bytes: Buffer.alloc(0) };
      }
      return { availability: "available", bytes };
    } finally {
      await handle.close();
      signal?.throwIfAborted();
    }
  }

  async #readCatalog(signal?: AbortSignal): Promise<Catalog> {
    signal?.throwIfAborted();
    let raw: Buffer;
    try {
      raw = await readSafeFile(this.#catalogPath, MAX_CATALOG_BYTES, signal);
    } catch (error) {
      if (error instanceof LocalArtifactStoreError && error.code === "not_found") {
        return createCatalog({ generation: 0, references: [], prunedDigests: [] });
      }
      throw error;
    }
    try {
      const parsed = catalogSchema.parse(
        parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(raw), {
          maxDepth: 8,
          maxNodes: 100_000,
          valueLabel: "artifact catalog",
        }),
      );
      const references = parsed.references.map((record) => ({
        reference: validateArtifactReference(record.reference),
        retention: record.retention,
      }));
      assertSortedUniqueReferences(references);
      assertSortedUniqueStrings(parsed.prunedDigests);
      const catalog = createCatalog({
        generation: parsed.generation,
        references,
        prunedDigests: parsed.prunedDigests,
      });
      if (catalog.catalogDigest !== parsed.catalogDigest) {
        throw new LocalArtifactStoreError("corrupt_catalog");
      }
      return catalog;
    } catch (error) {
      if (error instanceof LocalArtifactStoreError) throw error;
      throw new LocalArtifactStoreError("corrupt_catalog");
    }
  }

  async #writeCatalog(catalog: Catalog, expected: Catalog, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const bytes = Buffer.from(`${JSON.stringify(catalog)}\n`, "utf8");
    if (bytes.length > MAX_CATALOG_BYTES) throw new LocalArtifactStoreError("limit_exceeded");
    const temporary = join(this.#storeRoot, `.catalog-${randomUUID()}`);
    let handle: FileHandle | undefined;
    let renamed = false;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(bytes);
      signal?.throwIfAborted();
      await handle.sync();
      await handle.close();
      handle = undefined;
      signal?.throwIfAborted();
      await this.#testHooks.beforeCatalogPublished?.(catalog.generation);
      const current = await this.#readCatalog(signal);
      if (current.catalogDigest !== expected.catalogDigest) {
        throw new LocalArtifactStoreError("unsafe_state");
      }
      await rename(temporary, this.#catalogPath);
      renamed = true;
      await this.#testHooks.afterCatalogPublished?.(catalog.generation);
      await syncDirectory(this.#storeRoot);
      const settled = await this.#readCatalog();
      if (settled.catalogDigest !== catalog.catalogDigest) {
        throw new LocalArtifactStoreError("commit_uncertain");
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      if (!renamed) signal?.throwIfAborted();
      if (error instanceof LocalArtifactStoreError) throw error;
      throw new LocalArtifactStoreError("commit_uncertain");
    }
  }

  async #withLock<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    try {
      signal?.throwIfAborted();
      await this.#ensureDirectories();
      const lock = await this.#acquireLock(signal);
      const outcome = await this.#reconcileBlobTemps(signal)
        .then(operation)
        .then(
          (value) => ({ status: "succeeded" as const, value }),
          (error: unknown) => ({ status: "failed" as const, error }),
        );
      const releaseError = await this.#releaseLock(lock).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (releaseError !== undefined) {
        if (outcome.status === "failed") {
          throw new AggregateError(
            [normalizeStoreFailure(outcome.error, signal), releaseError],
            "artifact operation and lock settlement both failed",
          );
        }
        throw releaseError;
      }
      if (outcome.status === "failed") throw outcome.error;
      return outcome.value;
    } catch (error) {
      throw normalizeStoreFailure(error, signal);
    }
  }

  async #reconcileBlobTemps(signal?: AbortSignal): Promise<void> {
    const directory = await opendir(this.#blobRoot);
    const pending: string[] = [];
    try {
      for await (const entry of directory) {
        signal?.throwIfAborted();
        if (/^\.(?:blob|reconcile)-[a-f0-9-]{36}$/.test(entry.name)) {
          pending.push(entry.name);
          if (pending.length > MAX_BLOB_ENTRIES) {
            throw new LocalArtifactStoreError("limit_exceeded");
          }
        }
      }
    } finally {
      await directory.close().catch((error: unknown) => {
        if (!isNodeError(error, "ERR_DIR_CLOSED")) throw error;
      });
      signal?.throwIfAborted();
    }
    for (const name of pending.sort(compareStrings)) {
      signal?.throwIfAborted();
      const source = join(this.#blobRoot, name);
      const claimed = join(this.#blobRoot, `.reconcile-${randomUUID()}`);
      try {
        await rename(source, claimed);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw new LocalArtifactStoreError("unsafe_state");
      }
      const identity = await lstat(claimed, { bigint: true }).catch(() => undefined);
      signal?.throwIfAborted();
      if (identity === undefined) throw new LocalArtifactStoreError("unsafe_state");
      if (identity.isSymbolicLink()) {
        await unlink(claimed);
        await syncDirectory(this.#blobRoot);
        continue;
      }
      if (!identity.isFile() || identity.size > BigInt(MAX_ARTIFACT_BYTES) || identity.nlink > 2n) {
        throw new LocalArtifactStoreError("unsafe_state");
      }
      const bytes = await readTemporaryBlob(claimed, identity, signal);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const target = await lstat(this.#blobPath(digest), { bigint: true }).catch(
        (error: unknown) => {
          if (isNodeError(error, "ENOENT")) return undefined;
          throw error;
        },
      );
      signal?.throwIfAborted();
      if (
        !(
          (identity.nlink === 1n && target === undefined) ||
          (identity.nlink === 2n && target !== undefined && sameFile(identity, target))
        )
      ) {
        throw new LocalArtifactStoreError("unsafe_state");
      }
      const current = await lstat(claimed, { bigint: true });
      if (!sameFile(identity, current)) throw new LocalArtifactStoreError("unsafe_state");
      await unlink(claimed);
      await syncDirectory(this.#blobRoot);
    }
  }

  async #ensureDirectories(): Promise<void> {
    await ensureDirectory(this.#projectRoot, false);
    await ensureDirectory(this.#flowRoot, true);
    await ensureDirectory(this.#storeRoot, true);
    await ensureDirectory(this.#blobRoot, true);
  }

  async #acquireLock(signal?: AbortSignal): Promise<HeldLock> {
    signal?.throwIfAborted();
    let handle: FileHandle | undefined;
    let createdIdentity: Stats | undefined;
    let identity: Stats | undefined;
    let created = false;
    try {
      handle = await open(
        this.#lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      createdIdentity = await handle.stat();
      if (!createdIdentity.isFile() || createdIdentity.nlink !== 1) {
        throw new LocalArtifactStoreError("unsafe_state");
      }
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
      identity = await handle.stat();
      await handle.close();
      handle = undefined;
      await syncDirectory(this.#storeRoot);
      await this.#testHooks.beforeLockAcquired?.();
      signal?.throwIfAborted();
      return { path: this.#lockPath, identity };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (created) {
        if (createdIdentity === undefined) {
          throw new LocalArtifactStoreError("settlement_uncertain");
        }
        await this.#discardCreatedLock(createdIdentity).catch(() => {
          throw new LocalArtifactStoreError("settlement_uncertain");
        });
        signal?.throwIfAborted();
      }
      if (isNodeError(error, "EEXIST")) throw new LocalArtifactStoreError("busy");
      if (error instanceof LocalArtifactStoreError) throw error;
      throw new LocalArtifactStoreError("io");
    }
  }

  async #releaseLock(lock: HeldLock): Promise<void> {
    try {
      const current = await lstat(lock.path);
      if (!sameFile(lock.identity, current)) {
        throw new LocalArtifactStoreError("settlement_uncertain");
      }
      await unlink(lock.path);
      await syncDirectory(this.#storeRoot);
    } catch (error) {
      if (error instanceof LocalArtifactStoreError) throw error;
      throw new LocalArtifactStoreError("settlement_uncertain");
    }
  }

  async #discardCreatedLock(identity: Stats): Promise<void> {
    const current = await lstat(this.#lockPath);
    if (!current.isFile() || current.nlink !== 1 || !sameInode(identity, current)) {
      throw new LocalArtifactStoreError("settlement_uncertain");
    }
    await unlink(this.#lockPath);
    await syncDirectory(this.#storeRoot);
  }

  #blobPath(digest: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new LocalArtifactStoreError("invalid_request");
    }
    return join(this.#blobRoot, digest.slice("sha256:".length));
  }
}

function createCatalog(input: {
  readonly generation: number;
  readonly references: readonly CatalogReference[];
  readonly prunedDigests: readonly string[];
}): Catalog {
  const references = Object.freeze(
    [...input.references]
      .sort((left, right) => compareStrings(left.reference.reference, right.reference.reference))
      .map((record) =>
        Object.freeze({
          reference: validateArtifactReference(record.reference),
          retention: record.retention,
        }),
      ),
  );
  const prunedDigests = Object.freeze([...new Set(input.prunedDigests)].sort(compareStrings));
  if (references.length > MAX_CATALOG_REFERENCES || prunedDigests.length > MAX_PRUNED_DIGESTS) {
    throw new LocalArtifactStoreError("limit_exceeded");
  }
  const canonical = {
    version: 1 as const,
    generation: input.generation,
    references,
    prunedDigests,
  };
  return Object.freeze({
    ...canonical,
    catalogDigest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  });
}

function findReference(catalog: Catalog, reference: string): CatalogReference | undefined {
  return catalog.references.find((record) => record.reference.reference === reference);
}

function requireReference(catalog: Catalog, reference: string): CatalogReference {
  validateReferenceIdentifier(reference);
  const record = findReference(catalog, reference);
  if (record === undefined) throw new LocalArtifactStoreError("not_found");
  return record;
}

function validateReferenceIdentifier(reference: string): void {
  if (!/^artifact:[a-f0-9]{64}$/.test(reference)) {
    throw new LocalArtifactStoreError("invalid_request");
  }
}

function validateReadRequest(input: {
  readonly reference: string;
  readonly runId: string;
  readonly offset: number;
  readonly maxBytes: number;
}): void {
  validateReferenceIdentifier(input.reference);
  if (
    input.runId.length === 0 ||
    input.runId.length > 256 ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0 ||
    input.maxBytes > MAX_ARTIFACT_READ_BYTES
  ) {
    throw new LocalArtifactStoreError("invalid_request");
  }
}

function calculatePrunePlanDigest(
  generation: number,
  items: readonly ArtifactDescriptor[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, catalogGeneration: generation, items }))
    .digest("hex");
}

async function ensureDirectory(path: string, create: boolean): Promise<void> {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (!isNodeError(error, "EEXIST")) throw error;
    });
  const stat = await lstat(path, { bigint: true }).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new LocalArtifactStoreError("unsafe_state");
  }
}

async function readSafeFile(path: string, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new LocalArtifactStoreError("not_found");
    if (isUnsafeOpenError(error)) throw new LocalArtifactStoreError("unsafe_state");
    throw new LocalArtifactStoreError("io");
  }
  try {
    signal?.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    if (!isSafeFile(before) || before.size > BigInt(maximum)) {
      throw new LocalArtifactStoreError(
        before.size > BigInt(maximum) ? "limit_exceeded" : "unsafe_state",
      );
    }
    const bytes = await readBoundedHandle(handle, maximum, signal);
    const after = await handle.stat({ bigint: true });
    const lexical = await lstat(path, { bigint: true }).catch(() => undefined);
    if (lexical === undefined || !sameFile(before, after) || !sameFile(before, lexical)) {
      throw new LocalArtifactStoreError("unsafe_state");
    }
    return bytes;
  } finally {
    await handle.close();
    signal?.throwIfAborted();
  }
}

async function readTemporaryBlob(
  path: string,
  expected: import("node:fs").BigIntStats,
  signal?: AbortSignal,
): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    signal?.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== expected.nlink ||
      before.size > BigInt(MAX_ARTIFACT_BYTES) ||
      !sameFile(before, expected)
    ) {
      throw new LocalArtifactStoreError("unsafe_state");
    }
    const bytes = await readBoundedHandle(handle, MAX_ARTIFACT_BYTES, signal);
    const after = await handle.stat({ bigint: true });
    const lexical = await lstat(path, { bigint: true }).catch(() => undefined);
    if (
      lexical === undefined ||
      after.nlink !== before.nlink ||
      !sameFile(before, after) ||
      !sameFile(before, lexical)
    ) {
      throw new LocalArtifactStoreError("unsafe_state");
    }
    return bytes;
  } catch (error) {
    if (error instanceof LocalArtifactStoreError) throw error;
    throw new LocalArtifactStoreError("unsafe_state");
  } finally {
    await handle?.close();
    signal?.throwIfAborted();
  }
}

async function readBoundedHandle(
  handle: Awaited<ReturnType<typeof open>>,
  maximum: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    signal?.throwIfAborted();
    const chunk = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximum) throw new LocalArtifactStoreError("limit_exceeded");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isSafeFile(stat: Stats | import("node:fs").BigIntStats, size?: number): boolean {
  return (
    stat.isFile() &&
    stat.nlink === (typeof stat.nlink === "bigint" ? 1n : 1) &&
    (size === undefined || stat.size === (typeof stat.size === "bigint" ? BigInt(size) : size))
  );
}

function assertSafeFile(stat: import("node:fs").BigIntStats, size: number): void {
  if (!isSafeFile(stat, size)) throw new LocalArtifactStoreError("unsafe_state");
}

function sameFile(
  left: Stats | import("node:fs").BigIntStats,
  right: Stats | import("node:fs").BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameInode(
  left: Stats | import("node:fs").BigIntStats,
  right: Stats | import("node:fs").BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireAvailable(availability: ArtifactAvailability): void {
  switch (availability) {
    case "available":
      return;
    case "missing":
      throw new LocalArtifactStoreError("missing");
    case "changed":
      throw new LocalArtifactStoreError("changed");
    case "pruned":
      throw new LocalArtifactStoreError("pruned");
  }
}

function assertSortedUniqueReferences(references: readonly CatalogReference[]): void {
  const values = references.map((record) => record.reference.reference);
  assertSortedUniqueStrings(values);
}

function assertSortedUniqueStrings(values: readonly string[]): void {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && compareStrings(values[index - 1] ?? "", values[index] ?? "") >= 0) {
      throw new LocalArtifactStoreError("corrupt_catalog");
    }
  }
}

function nextGeneration(current: number): number {
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
    throw new LocalArtifactStoreError("limit_exceeded");
  }
  return current + 1;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isUnsafeOpenError(error: unknown): boolean {
  return isNodeError(error, "ELOOP") || isNodeError(error, "EISDIR") || isNodeError(error, "ENXIO");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function publicMessage(code: LocalArtifactStoreErrorCode): string {
  switch (code) {
    case "busy":
      return "artifact store is busy";
    case "changed":
      return "artifact bytes changed after retention";
    case "commit_uncertain":
      return "artifact commit is uncertain";
    case "corrupt_catalog":
      return "artifact catalog is corrupt";
    case "invalid_request":
      return "artifact request is invalid";
    case "io":
      return "artifact store I/O failed";
    case "limit_exceeded":
      return "artifact store limit exceeded";
    case "missing":
      return "artifact bytes are missing";
    case "not_found":
      return "artifact reference was not found";
    case "pruned":
      return "artifact bytes were pruned";
    case "settlement_uncertain":
      return "artifact store settlement is uncertain";
    case "stale_plan":
      return "artifact prune plan is stale";
    case "unauthorized":
      return "artifact reference is not authorized for this run";
    case "unsafe_state":
      return "artifact store state is unsafe";
  }
}

function normalizeStoreFailure(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof LocalArtifactStoreError || error instanceof AggregateError) return error;
  if (signal?.aborted === true) return signal.reason;
  return new LocalArtifactStoreError("io");
}
