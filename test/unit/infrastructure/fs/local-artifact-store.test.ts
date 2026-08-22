import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createArtifactReference,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_READ_BYTES,
} from "../../../../src/domain/artifact/reference.js";
import { LocalArtifactStore } from "../../../../src/infrastructure/fs/local-artifact-store.js";

describe("LocalArtifactStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "flow-artifacts-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("deduplicates exact bytes while retaining independent producer references", async () => {
    const store = new LocalArtifactStore(root);
    const bytes = Buffer.from("private artifact bytes", "utf8");
    const left = await store.retain({
      bytes,
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    const right = await store.retain({
      bytes,
      mediaType: "application/octet-stream",
      producer: producer("run-right"),
    });

    expect(left.descriptor).toEqual(right.descriptor);
    expect(left.reference).not.toBe(right.reference);
    expect(await store.inspect(left.reference)).toMatchObject({
      reference: left,
      retention: "retained",
      availability: "available",
    });
    expect(await store.inspect(right.reference)).toMatchObject({
      reference: right,
      retention: "retained",
      availability: "available",
    });
    expect(await readFile(store.blobPathForTest(left.descriptor.digest))).toEqual(bytes);
  });

  it("lists bounded catalog metadata without reading artifact bytes", async () => {
    const store = new LocalArtifactStore(root);
    const left = await store.retain({
      bytes: Buffer.from("left private bytes"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    const right = await store.retain({
      bytes: Buffer.from("right private bytes"),
      mediaType: "application/octet-stream",
      producer: producer("run-right"),
    });
    await store.setRetention({ reference: right.reference, retention: "released" });
    await unlink(store.blobPathForTest(left.descriptor.digest));

    await expect(store.list()).resolves.toEqual([
      { reference: left, retention: "retained" },
      { reference: right, retention: "released" },
    ]);
  });

  it("reads only a bounded window for the exact originating run", async () => {
    const store = new LocalArtifactStore(root);
    const reference = await store.retain({
      bytes: Buffer.from("0123456789", "utf8"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });

    await expect(
      store.read({ reference: reference.reference, runId: "run-right", offset: 0, maxBytes: 4 }),
    ).rejects.toThrow("artifact reference is not authorized for this run");
    await expect(
      store.read({ reference: reference.reference, runId: "run-left", offset: 2, maxBytes: 4 }),
    ).resolves.toEqual({
      reference,
      offset: 2,
      bytes: Buffer.from("2345", "utf8"),
      nextOffset: 6,
      complete: false,
    });
    await expect(
      store.read({ reference: reference.reference, runId: "run-left", offset: 10, maxBytes: 4 }),
    ).resolves.toMatchObject({ bytes: Buffer.alloc(0), nextOffset: 10, complete: true });
  });

  it("prunes only blobs whose complete shared reference set is released", async () => {
    const store = new LocalArtifactStore(root);
    const bytes = Buffer.from("shared", "utf8");
    const left = await store.retain({
      bytes,
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    const right = await store.retain({
      bytes,
      mediaType: "application/octet-stream",
      producer: producer("run-right"),
    });

    await store.setRetention({ reference: left.reference, retention: "released" });
    expect((await store.planPrune()).items).toEqual([]);
    await store.setRetention({ reference: right.reference, retention: "released" });
    const plan = await store.planPrune();
    expect(plan.items).toEqual([left.descriptor]);
    await expect(store.applyPrune({ expectedPlanDigest: "0".repeat(64) })).rejects.toThrow(
      "artifact prune plan is stale",
    );

    await expect(store.applyPrune({ expectedPlanDigest: plan.planDigest })).resolves.toEqual({
      planDigest: plan.planDigest,
      pruned: Object.freeze([left.descriptor]),
    });
    expect(await store.inspect(left.reference)).toMatchObject({
      retention: "released",
      availability: "pruned",
    });
    await expect(
      store.read({ reference: left.reference, runId: "run-left", offset: 0, maxBytes: 4 }),
    ).rejects.toThrow("artifact bytes were pruned");
    expect((await store.planPrune()).items).toEqual([]);
  });

  it("refuses pruning until an exact reader has settled", async () => {
    let holdRead = false;
    let releaseRead: (() => void) | undefined;
    let announceRead: (() => void) | undefined;
    const readOpened = new Promise<void>((resolve) => {
      announceRead = resolve;
    });
    const readRelease = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const store = new LocalArtifactStore(root, {
      afterBlobOpened: async () => {
        if (!holdRead) return;
        announceRead?.();
        await readRelease;
      },
    });
    const reference = await store.retain({
      bytes: Buffer.from("reader before prune"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    await store.setRetention({ reference: reference.reference, retention: "released" });
    const plan = await store.planPrune();
    holdRead = true;

    const read = store.read({
      reference: reference.reference,
      runId: "run-left",
      offset: 0,
      maxBytes: MAX_ARTIFACT_READ_BYTES,
    });
    await readOpened;
    await expect(store.applyPrune({ expectedPlanDigest: plan.planDigest })).rejects.toThrow(
      "artifact store is busy",
    );

    releaseRead?.();
    await expect(read).resolves.toMatchObject({ bytes: Buffer.from("reader before prune") });
    await expect(store.applyPrune({ expectedPlanDigest: plan.planDigest })).resolves.toMatchObject({
      pruned: [reference.descriptor],
    });
  });

  it("retaining a released reference invalidates an older prune plan", async () => {
    const store = new LocalArtifactStore(root);
    const reference = await store.retain({
      bytes: Buffer.from("retained", "utf8"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    await store.setRetention({ reference: reference.reference, retention: "released" });
    const plan = await store.planPrune();
    await store.setRetention({ reference: reference.reference, retention: "retained" });

    await expect(store.applyPrune({ expectedPlanDigest: plan.planDigest })).rejects.toThrow(
      "artifact prune plan is stale",
    );
    expect(await store.inspect(reference.reference)).toMatchObject({
      retention: "retained",
      availability: "available",
    });
  });

  it("restores retained catalog state when exact evidence is published again", async () => {
    const store = new LocalArtifactStore(root);
    const input = {
      bytes: Buffer.from("published again"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    } as const;
    const reference = await store.retain(input);
    await store.setRetention({ reference: reference.reference, retention: "released" });

    expect(await store.retain(input)).toEqual(reference);
    expect(await store.inspect(reference.reference)).toMatchObject({
      retention: "retained",
      availability: "available",
    });

    await store.setRetention({ reference: reference.reference, retention: "released" });
    const plan = await store.planPrune();
    await store.applyPrune({ expectedPlanDigest: plan.planDigest });

    expect(await store.retain(input)).toEqual(reference);
    expect(await store.inspect(reference.reference)).toMatchObject({
      retention: "retained",
      availability: "available",
    });
  });

  it("settles a released missing blob as pruned through an exact retry plan", async () => {
    const store = new LocalArtifactStore(root);
    const reference = await store.retain({
      bytes: Buffer.from("interrupted prune"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    await store.setRetention({ reference: reference.reference, retention: "released" });
    await unlink(store.blobPathForTest(reference.descriptor.digest));

    const plan = await store.planPrune();
    expect(plan.items).toEqual([reference.descriptor]);
    await store.applyPrune({ expectedPlanDigest: plan.planDigest });
    expect(await store.inspect(reference.reference)).toMatchObject({ availability: "pruned" });
  });

  it("plans exact bytes that reappear after a digest was settled as pruned", async () => {
    const store = new LocalArtifactStore(root);
    const bytes = Buffer.from("reappeared after prune");
    const reference = await store.retain({
      bytes,
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    await store.setRetention({ reference: reference.reference, retention: "released" });
    const initial = await store.planPrune();
    await store.applyPrune({ expectedPlanDigest: initial.planDigest });
    expect((await store.planPrune()).items).toEqual([]);

    await writeFile(store.blobPathForTest(reference.descriptor.digest), bytes, { mode: 0o600 });

    expect((await store.planPrune()).items).toEqual([reference.descriptor]);
  });

  it("preserves unresolved evidence when bytes are missing or changed", async () => {
    const store = new LocalArtifactStore(root);
    const missing = await store.retain({
      bytes: Buffer.from("missing", "utf8"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    await unlink(store.blobPathForTest(missing.descriptor.digest));

    expect(await store.inspect(missing.reference)).toMatchObject({ availability: "missing" });
    await expect(
      store.read({ reference: missing.reference, runId: "run-left", offset: 0, maxBytes: 4 }),
    ).rejects.toThrow("artifact bytes are missing");

    const changed = await store.retain({
      bytes: Buffer.from("original", "utf8"),
      mediaType: "application/octet-stream",
      producer: producer("run-right"),
    });
    await writeFile(store.blobPathForTest(changed.descriptor.digest), "changed!");
    expect(await store.inspect(changed.reference)).toMatchObject({ availability: "changed" });
    await expect(
      store.read({ reference: changed.reference, runId: "run-right", offset: 0, maxBytes: 4 }),
    ).rejects.toThrow("artifact bytes changed after retention");
  });

  it("rejects cancellation before publication without leaving catalog authority", async () => {
    const store = new LocalArtifactStore(root);
    const controller = new AbortController();
    const reason = new Error("private cancellation");
    controller.abort(reason);

    await expect(
      store.retain({
        bytes: Buffer.from("private", "utf8"),
        mediaType: "application/octet-stream",
        producer: producer("run-left"),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(await store.list()).toEqual([]);
  });

  it("settles its exact lock when cancellation arrives after lock publication", async () => {
    const controller = new AbortController();
    const reason = new Error("private cancellation after lock publication");
    const store = new LocalArtifactStore(root, {
      beforeLockAcquired: async () => controller.abort(reason),
    });

    await expect(
      store.retain({
        bytes: Buffer.from("cancelled after lock"),
        mediaType: "application/octet-stream",
        producer: producer("run-left"),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    await expect(new LocalArtifactStore(root).list()).resolves.toEqual([]);
  });

  it("reports fixed settlement uncertainty when its published lock disappears", async () => {
    const lockPath = join(root, ".flow", "artifacts", "mutation.lock");
    const store = new LocalArtifactStore(root, {
      afterBlobPublished: async () => {
        await unlink(lockPath);
      },
    });

    await expect(
      store.retain({
        bytes: Buffer.from("settled publication"),
        mediaType: "application/octet-stream",
        producer: producer("run-left"),
      }),
    ).rejects.toMatchObject({
      name: "LocalArtifactStoreError",
      code: "settlement_uncertain",
      message: "artifact store settlement is uncertain",
    });
  });

  it("keeps a fixed public message when operation and lock settlement both fail", async () => {
    const lockPath = join(root, ".flow", "artifacts", "mutation.lock");
    const store = new LocalArtifactStore(root, {
      afterBlobPublished: async () => {
        await unlink(lockPath);
        await writeFile(lockPath, "PRIVATE_REPLACEMENT_LOCK");
        throw new Error("PRIVATE_OPERATION_FAILURE");
      },
    });

    const error = await store
      .retain({
        bytes: Buffer.from("double failure"),
        mediaType: "application/octet-stream",
        producer: producer("run-left"),
      })
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(
      "artifact operation and lock settlement both failed",
    );
    expect((error as AggregateError).message).not.toContain("PRIVATE_");
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ code: "io", message: "artifact store I/O failed" }),
      expect.objectContaining({
        code: "settlement_uncertain",
        message: "artifact store settlement is uncertain",
      }),
    ]);
    expect((error as AggregateError).errors.map(String).join("\n")).not.toContain("PRIVATE_");
  });

  it("preserves exact cancellation before catalog publication and leaves a pruneable orphan", async () => {
    const controller = new AbortController();
    const reason = new Error("private cancellation before catalog publication");
    const store = new LocalArtifactStore(root, {
      beforeCatalogPublished: async (generation) => {
        if (generation === 1) controller.abort(reason);
      },
    });

    await expect(
      store.retain({
        bytes: Buffer.from("orphan after cancellation"),
        mediaType: "application/octet-stream",
        producer: producer("run-left"),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(await store.list()).toEqual([]);
    expect((await store.planPrune()).items).toEqual([
      expect.objectContaining({ size: Buffer.byteLength("orphan after cancellation") }),
    ]);
  });

  it("settles a catalog commit without restoring late caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("private cancellation after catalog publication");
    const store = new LocalArtifactStore(root, {
      afterCatalogPublished: async (generation) => {
        if (generation === 2) controller.abort(reason);
      },
    });
    const reference = await store.retain({
      bytes: Buffer.from("late catalog cancellation"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });

    await expect(
      store.setRetention({
        reference: reference.reference,
        retention: "released",
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ retention: "released", availability: "available" });
    expect(controller.signal.reason).toBe(reason);
  });

  it("settles an exact prune after cancellation crosses the first unlink boundary", async () => {
    const controller = new AbortController();
    const reason = new Error("private cancellation after blob removal");
    const store = new LocalArtifactStore(root, {
      afterBlobRemoved: async () => controller.abort(reason),
    });
    const reference = await store.retain({
      bytes: Buffer.from("settled prune cancellation"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    await store.setRetention({ reference: reference.reference, retention: "released" });
    const plan = await store.planPrune();

    await expect(
      store.applyPrune({
        expectedPlanDigest: plan.planDigest,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ planDigest: plan.planDigest, pruned: [reference.descriptor] });
    expect(controller.signal.reason).toBe(reason);
    expect(await store.inspect(reference.reference)).toMatchObject({ availability: "pruned" });
  });

  it("reports commit uncertainty after blob unlink and settles through an exact retry", async () => {
    let failAfterUnlink = true;
    const store = new LocalArtifactStore(root, {
      afterBlobUnlinked: async () => {
        if (!failAfterUnlink) return;
        failAfterUnlink = false;
        throw new Error("PRIVATE_POST_UNLINK_FAILURE");
      },
    });
    const reference = await store.retain({
      bytes: Buffer.from("uncertain prune settlement"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    await store.setRetention({ reference: reference.reference, retention: "released" });
    const plan = await store.planPrune();

    const failure = await store.applyPrune({ expectedPlanDigest: plan.planDigest }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "commit_uncertain",
      message: "artifact commit is uncertain",
    });
    expect(String(failure)).not.toContain("PRIVATE_POST_UNLINK_FAILURE");

    await expect(store.applyPrune({ expectedPlanDigest: plan.planDigest })).resolves.toMatchObject({
      planDigest: plan.planDigest,
      pruned: [reference.descriptor],
    });
    await expect(store.inspect(reference.reference)).resolves.toMatchObject({
      availability: "pruned",
    });
  });

  it("rejects a catalog replacement before atomic publication instead of overwriting it", async () => {
    const catalogPath = join(root, ".flow", "artifacts", "catalog.json");
    const replacement = "PRIVATE_REPLACED_CATALOG";
    const store = new LocalArtifactStore(root, {
      beforeCatalogPublished: async (generation) => {
        if (generation === 2) await writeFile(catalogPath, replacement);
      },
    });
    const reference = await store.retain({
      bytes: Buffer.from("catalog currentness"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });

    await expect(
      store.setRetention({ reference: reference.reference, retention: "released" }),
    ).rejects.toThrow("artifact catalog is corrupt");
    expect(await readFile(catalogPath, "utf8")).toBe(replacement);
  });

  it("rejects substituted producer metadata in the durable catalog", async () => {
    const store = new LocalArtifactStore(root);
    await store.retain({
      bytes: Buffer.from("metadata identity"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    const catalogPath = join(root, ".flow", "artifacts", "catalog.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
      references: Array<{ reference: { producer: { nodeId: string } } }>;
    };
    const record = catalog.references[0];
    if (record === undefined) throw new Error("test catalog is missing its reference");
    record.reference.producer.nodeId = "PRIVATE_SUBSTITUTED_NODE";
    await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);

    const error = await store.list().catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      name: "LocalArtifactStoreError",
      code: "corrupt_catalog",
      message: "artifact catalog is corrupt",
    });
    expect((error as Error).message).not.toContain("PRIVATE_");
  });

  it("rejects a catalog with duplicate keys before schema validation", async () => {
    const store = new LocalArtifactStore(root);
    await store.retain({
      bytes: Buffer.from("strict catalog"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    const catalogPath = join(root, ".flow", "artifacts", "catalog.json");
    const catalog = await readFile(catalogPath, "utf8");
    await writeFile(catalogPath, catalog.replace("{", '{"version":1,'));

    await expect(store.list()).rejects.toMatchObject({
      code: "corrupt_catalog",
      message: "artifact catalog is corrupt",
    });
  });

  it("rejects a catalog read through a symbolic link even when its bytes are exact", async () => {
    const store = new LocalArtifactStore(root);
    await store.retain({
      bytes: Buffer.from("linked catalog"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    const catalogPath = join(root, ".flow", "artifacts", "catalog.json");
    const externalPath = join(root, "PRIVATE_LINKED_CATALOG");
    await rename(catalogPath, externalPath);
    await symlink(externalPath, catalogPath);

    const failure = await store.list().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "unsafe_state",
      message: "artifact store state is unsafe",
    });
    expect(String(failure)).not.toContain("PRIVATE_LINKED_CATALOG");
  });

  it("accepts exact artifact and read-window bounds and rejects plus one", async () => {
    const store = new LocalArtifactStore(root);
    const exact = await store.retain({
      bytes: Buffer.alloc(MAX_ARTIFACT_BYTES, 0x61),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });

    await expect(
      store.read({
        reference: exact.reference,
        runId: "run-left",
        offset: 0,
        maxBytes: MAX_ARTIFACT_READ_BYTES,
      }),
    ).resolves.toMatchObject({ bytes: Buffer.alloc(MAX_ARTIFACT_READ_BYTES, 0x61) });
    await expect(
      store.read({
        reference: exact.reference,
        runId: "run-left",
        offset: 0,
        maxBytes: MAX_ARTIFACT_READ_BYTES + 1,
      }),
    ).rejects.toThrow("artifact request is invalid");
    await expect(
      store.retain({
        bytes: Buffer.alloc(MAX_ARTIFACT_BYTES + 1),
        mediaType: "application/octet-stream",
        producer: producer("run-right"),
      }),
    ).rejects.toThrow("artifact store limit exceeded");
  });

  it("rejects an oversized artifact before materializing caller bytes", async () => {
    const store = new LocalArtifactStore(root);
    let materialized = false;
    const oversized = {
      byteLength: MAX_ARTIFACT_BYTES + 1,
      length: 1,
      get 0(): number {
        materialized = true;
        throw new Error("PRIVATE_OVERSIZED_ARTIFACT");
      },
    } as unknown as Uint8Array;

    const failure = await store
      .retain({
        bytes: oversized,
        mediaType: "application/octet-stream",
        producer: producer("run-oversized"),
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "limit_exceeded",
      message: "artifact store limit exceeded",
    });
    expect(materialized).toBe(false);
    expect(String(failure)).not.toContain("PRIVATE_OVERSIZED_ARTIFACT");
  });

  it("accepts exactly 4096 catalog references and rejects one more", async () => {
    const store = new LocalArtifactStore(root);
    await store.list();
    const references = Array.from({ length: 4_096 }, (_unused, index) => ({
      reference: createArtifactReference({
        descriptor: {
          digest: `sha256:${"a".repeat(64)}`,
          size: 1,
          mediaType: "application/octet-stream",
        },
        producer: { ...producer("run-bound"), commandId: `command-${index + 1}` },
      }),
      retention: "retained" as const,
    })).sort((left, right) => left.reference.reference.localeCompare(right.reference.reference));
    const canonical = {
      version: 1 as const,
      generation: 1,
      references,
      prunedDigests: [] as const,
    };
    await writeFile(
      join(root, ".flow", "artifacts", "catalog.json"),
      `${JSON.stringify({
        ...canonical,
        catalogDigest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
      })}\n`,
    );

    await expect(store.list()).resolves.toHaveLength(4_096);
    const rejectedBytes = Buffer.from("new reference");
    await expect(
      store.retain({
        bytes: rejectedBytes,
        mediaType: "application/octet-stream",
        producer: producer("run-over"),
      }),
    ).rejects.toThrow("artifact store limit exceeded");
    await expect(store.list()).resolves.toHaveLength(4_096);
    await expect(
      readFile(
        store.blobPathForTest(`sha256:${createHash("sha256").update(rejectedBytes).digest("hex")}`),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("plans and removes a durable blob orphaned before catalog publication", async () => {
    let descriptor: { readonly digest: string; readonly size: number } | undefined;
    const store = new LocalArtifactStore(root, {
      afterBlobPublished: async (published) => {
        descriptor = published;
        throw new Error("injected process failure before catalog publication");
      },
    });

    const error = await store
      .retain({
        bytes: Buffer.from("orphaned bytes"),
        mediaType: "application/octet-stream",
        producer: producer("run-left"),
      })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      name: "LocalArtifactStoreError",
      code: "io",
      message: "artifact store I/O failed",
    });
    expect((error as Error).message).not.toContain("injected process failure");
    expect(await store.list()).toEqual([]);
    if (descriptor === undefined) throw new Error("orphan descriptor was not captured");

    const recovered = new LocalArtifactStore(root);
    const plan = await recovered.planPrune();
    expect(plan.items).toEqual([{ ...descriptor, mediaType: "application/octet-stream" }]);
    await recovered.applyPrune({ expectedPlanDigest: plan.planDigest });
    await expect(readFile(recovered.blobPathForTest(descriptor.digest))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const catalog = JSON.parse(
      await readFile(join(root, ".flow", "artifacts", "catalog.json"), "utf8"),
    ) as { readonly prunedDigests: readonly string[] };
    expect(catalog.prunedDigests).toEqual([]);
  });

  it("fails closed for hard-linked, symlink-substituted, and non-regular blob paths", async () => {
    const store = new LocalArtifactStore(root);
    const reference = await store.retain({
      bytes: Buffer.from("immutable"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    const blobPath = store.blobPathForTest(reference.descriptor.digest);
    const extraLink = join(root, "extra-link");
    await link(blobPath, extraLink);

    expect(await store.inspect(reference.reference)).toMatchObject({ availability: "changed" });
    await unlink(extraLink);
    expect(await store.inspect(reference.reference)).toMatchObject({ availability: "available" });

    const replacement = join(root, "replacement");
    await writeFile(replacement, "immutable");
    await unlink(blobPath);
    await symlink(replacement, blobPath);
    expect(await store.inspect(reference.reference)).toMatchObject({ availability: "changed" });

    await unlink(blobPath);
    await mkdir(blobPath);
    expect(await store.inspect(reference.reference)).toMatchObject({ availability: "changed" });
  });

  it("rejects a blob path replaced with identical bytes after the inode is opened", async () => {
    const original = new LocalArtifactStore(root);
    const bytes = Buffer.from("same bytes on a different inode");
    const reference = await original.retain({
      bytes,
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    const blobPath = original.blobPathForTest(reference.descriptor.digest);
    let replaced = false;
    const inspecting = new LocalArtifactStore(root, {
      afterBlobOpened: async () => {
        if (replaced) return;
        replaced = true;
        await rename(blobPath, `${blobPath}.PRIVATE_RETIRED`);
        await writeFile(blobPath, bytes);
      },
    });

    await expect(inspecting.inspect(reference.reference)).resolves.toMatchObject({
      availability: "changed",
    });
  });

  it("settles a crash-left publication link before opening the finalized blob", async () => {
    const store = new LocalArtifactStore(root);
    const reference = await store.retain({
      bytes: Buffer.from("settled after crash"),
      mediaType: "application/octet-stream",
      producer: producer("run-left"),
    });
    const blobPath = store.blobPathForTest(reference.descriptor.digest);
    const crashLink = join(blobPath, "..", `.blob-${randomUUID()}`);
    await link(blobPath, crashLink);

    expect(await new LocalArtifactStore(root).inspect(reference.reference)).toMatchObject({
      availability: "available",
    });
    await expect(readFile(crashLink)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(blobPath)).toEqual(Buffer.from("settled after crash"));
  });
});

function producer(runId: string) {
  return {
    kind: "agent-command" as const,
    runId,
    workflowId: "workflow",
    nodeId: "agent",
    attempt: 1,
    commandId: "command-7",
    commandSequence: 1,
    stream: "stdout" as const,
  };
}
