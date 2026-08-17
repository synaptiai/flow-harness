import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createCapabilityBundleSource } from "../../../../src/domain/capability/capability-bundles.js";
import { parseCapabilityMetadata } from "../../../../src/domain/capability/capability-metadata.js";
import {
  CapabilityPackageStoreError,
  type CapabilityPackageStoreHooks,
  LocalCapabilityPackageStore,
} from "../../../../src/infrastructure/fs/local-capability-package-store.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("local capability package store", () => {
  it("establishes and idempotently reopens one authenticated metadata state", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const now = new Date("2026-08-14T00:00:00.000Z");
    const metadata = capabilityMetadata(created.content, { version: 1 });
    const authority = metadataAuthority();
    const store = new LocalCapabilityPackageStore(projectRoot, { now: () => now });

    await expect(store.refreshMetadata({ metadata, authority })).resolves.toMatchObject({
      status: "established",
      state: { name: "project-capabilities", version: 1, authority },
    });
    await expect(store.refreshMetadata({ metadata, authority })).resolves.toMatchObject({
      status: "already_current",
    });
    await expect(store.inspectMetadata()).resolves.toMatchObject({
      name: "project-capabilities",
      version: 1,
      metadataDigest: metadata.digest,
      authority,
      targets: [{ name: "review-suite", version: "1.0.0", status: "active" }],
    });
    await expect(
      readFile(join(projectRoot, ".flow", "packages.metadata.json"), "utf8"),
    ).resolves.not.toContain("PRIVATE");
  });

  it("accepts a higher metadata version and rejects rollback or equal-version substitution", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const now = new Date("2026-08-14T00:00:00.000Z");
    const authority = metadataAuthority();
    const store = new LocalCapabilityPackageStore(projectRoot, { now: () => now });
    const first = capabilityMetadata(created.content, { version: 1 });
    const second = capabilityMetadata(created.content, { version: 2 });
    const substituted = capabilityMetadata(created.content, { version: 2, status: "revoked" });

    await store.refreshMetadata({ metadata: first, authority });
    await expect(store.refreshMetadata({ metadata: second, authority })).resolves.toMatchObject({
      status: "refreshed",
      state: { version: 2 },
    });
    await expect(store.refreshMetadata({ metadata: first, authority })).rejects.toMatchObject({
      code: "metadata_rollback",
    });
    await expect(store.refreshMetadata({ metadata: substituted, authority })).rejects.toMatchObject(
      { code: "metadata_rollback" },
    );
    await expect(store.inspectMetadata()).resolves.toMatchObject({
      version: 2,
      metadataDigest: second.digest,
      targets: [{ status: "active" }],
    });
  });

  it.each([
    ["metadata name", { metadataName: "private-substitute" }, {}],
    ["certificate issuer", {}, { certificateIssuer: "https://private-issuer.example.test/" }],
    [
      "certificate identity",
      {},
      { certificateIdentity: "https://publisher.example.test/PRIVATE_SUBSTITUTE" },
    ],
  ] as const)(
    "rejects a %s substitution at a higher version",
    async (_label, metadata, publisher) => {
      const projectRoot = await projectDirectory();
      const created = bundle("Review freshness evidence.");
      const authority = metadataAuthority();
      const store = new LocalCapabilityPackageStore(projectRoot, {
        now: () => new Date("2026-08-14T00:00:00.000Z"),
      });
      await store.refreshMetadata({
        metadata: capabilityMetadata(created.content, { version: 1 }),
        authority,
      });

      let caught: unknown;
      try {
        await store.refreshMetadata({
          metadata: capabilityMetadata(created.content, { version: 2, ...metadata }),
          authority: { ...authority, ...publisher },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "metadata_rollback" });
      expect((caught as Error).message).not.toContain("private");
      await expect(store.inspectMetadata()).resolves.toMatchObject({
        name: "project-capabilities",
        version: 1,
        authority,
      });
    },
  );

  it("rechecks candidate freshness after acquiring mutation ownership", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const observations = [
      new Date("2026-08-14T23:59:59.999Z"),
      new Date("2026-08-15T00:00:00.000Z"),
    ];
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => observations.shift() ?? new Date("2026-08-15T00:00:00.000Z"),
    });

    await expect(
      store.refreshMetadata({
        metadata: capabilityMetadata(created.content, { version: 1 }),
        authority: metadataAuthority(),
      }),
    ).rejects.toMatchObject({ code: "metadata_expired" });
    await expect(readdir(join(projectRoot, ".flow"))).resolves.toEqual([]);
  });

  it("publishes nothing for pre-rename cancellation and reports post-rename uncertainty", async () => {
    const cancelledProject = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const metadata = capabilityMetadata(created.content, { version: 1 });
    const authority = metadataAuthority();
    const cancellation = new Error("PRIVATE_METADATA_CANCELLATION");
    const cancelled = new AbortController();
    const cancelledStore = new LocalCapabilityPackageStore(cancelledProject, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforeCapabilityMetadataRename: async () => {
        cancelled.abort(cancellation);
      },
    });

    await expect(
      cancelledStore.refreshMetadata({ metadata, authority, signal: cancelled.signal }),
    ).rejects.toBe(cancellation);
    await expect(readdir(join(cancelledProject, ".flow"))).resolves.toEqual([]);

    const uncertainProject = await projectDirectory();
    const postRename = new AbortController();
    const uncertain = new LocalCapabilityPackageStore(uncertainProject, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      afterCapabilityMetadataRenamed: async () => {
        postRename.abort(cancellation);
        throw cancellation;
      },
    });
    await expect(
      uncertain.refreshMetadata({ metadata, authority, signal: postRename.signal }),
    ).rejects.toMatchObject({ code: "commit_uncertain" });
    await expect(uncertain.inspectMetadata()).resolves.toMatchObject({ version: 1 });
  });

  it("preserves prior trusted metadata when a pre-rename publication step fails", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const authority = metadataAuthority();
    const now = () => new Date("2026-08-14T00:00:00.000Z");
    const first = capabilityMetadata(created.content, { version: 1 });
    await new LocalCapabilityPackageStore(projectRoot, { now }).refreshMetadata({
      metadata: first,
      authority,
    });
    const failed = new LocalCapabilityPackageStore(projectRoot, {
      now,
      beforeCapabilityMetadataRename: async () => {
        throw new Error("PRIVATE_PRE_RENAME_WRITE_FAILURE");
      },
    });

    await expect(
      failed.refreshMetadata({
        metadata: capabilityMetadata(created.content, { version: 2 }),
        authority,
      }),
    ).rejects.toMatchObject({ code: "io" });
    await expect(failed.inspectMetadata()).resolves.toMatchObject({
      version: 1,
      metadataDigest: first.digest,
    });
  });

  it("allows an exact active target, then blocks new verification after revocation", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const now = new Date("2026-08-14T00:00:00.000Z");
    const store = new LocalCapabilityPackageStore(projectRoot, { now: () => now });
    const authority = metadataAuthority();
    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, { version: 1 }),
      authority,
    });

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
      }),
    ).resolves.toMatchObject({ status: "installed" });
    await expect(store.verify()).resolves.toMatchObject([
      { bundle: { name: "review-suite", version: "1.0.0" } },
    ]);

    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, { version: 2, status: "revoked" }),
      authority,
    });
    await expect(store.verify()).rejects.toMatchObject({ code: "metadata_target" });
    await expect(store.remove("review-suite", "1.0.0")).resolves.toMatchObject({
      status: "removed",
    });
  });

  it("preserves exact pre-abort before package installation mutation", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review cancellation evidence.");
    const controller = new AbortController();
    const reason = new Error("PRIVATE_INSTALL_CANCELLATION");
    controller.abort(reason);

    await expect(
      new LocalCapabilityPackageStore(projectRoot).install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    await expect(readdir(join(projectRoot, ".flow"))).resolves.toEqual([]);
  });

  it("cancels exactly before package-lock publication and leaves no active package", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review pre-commit cancellation.");
    const controller = new AbortController();
    const reason = new Error("PRIVATE_PRE_COMMIT_CANCELLATION");
    const hooks = {
      beforeCapabilityLockRename: async () => controller.abort(reason),
    } as CapabilityPackageStoreHooks;
    const store = new LocalCapabilityPackageStore(projectRoot, hooks);

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    await expect(store.list()).resolves.toMatchObject({ bundles: [] });
    await expect(stat(join(projectRoot, ".flow", "packages.lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports uncertainty when cancellation follows package-lock publication", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review post-commit cancellation.");
    const controller = new AbortController();
    const reason = new Error("PRIVATE_POST_COMMIT_CANCELLATION");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      afterCapabilityLockRenamed: async () => {
        controller.abort(reason);
        throw reason;
      },
    });

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "commit_uncertain" });
    await expect(store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0" }],
    });
  });

  it("establishes an empty deny-all target set and blocks legacy installation", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const source = "https://packages.example.test/review-suite-1.0.0.flowpkg";
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await store.install({
      source,
      expectedSha256: digest(created.content),
      content: created.content,
    });
    await expect(
      store.refreshMetadata({
        metadata: capabilityMetadata(created.content, { version: 1, empty: true }),
        authority: metadataAuthority(),
      }),
    ).resolves.toMatchObject({ status: "established", state: { targets: [] } });

    await expect(store.verify()).rejects.toMatchObject({ code: "metadata_target" });
    await expect(
      store.install({
        source,
        expectedSha256: digest(created.content),
        content: created.content,
      }),
    ).rejects.toMatchObject({ code: "metadata_target" });
    await expect(store.list()).resolves.toMatchObject({ bundles: [{ source }] });
  });

  it("rejects install before blob publication when trusted target evidence differs", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, {
        version: 1,
        source: "https://mirror.example.test/review-suite-1.0.0.flowpkg",
      }),
      authority: metadataAuthority(),
    });

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
      }),
    ).rejects.toMatchObject({ code: "metadata_target" });
    await expect(stat(join(projectRoot, ".flow", "packages.lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(join(projectRoot, ".flow"))).resolves.toEqual(["packages.metadata.json"]);
  });

  it("rejects legacy locked source evidence that contradicts newly established metadata", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const legacySource = "https://mirror.example.test/review-suite-1.0.0.flowpkg";
    const trustedSource = "https://packages.example.test/review-suite-1.0.0.flowpkg";
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await store.install({
      source: legacySource,
      expectedSha256: digest(created.content),
      content: created.content,
    });
    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, { version: 1, source: trustedSource }),
      authority: metadataAuthority(),
    });

    await expect(
      store.install({
        source: trustedSource,
        expectedSha256: digest(created.content),
        content: created.content,
      }),
    ).rejects.toMatchObject({ code: "metadata_target" });
    await expect(store.list()).resolves.toMatchObject({ bundles: [{ source: legacySource }] });
    await expect(store.verify()).rejects.toMatchObject({ code: "metadata_target" });
  });

  it("rejects every mismatched trusted target identity leaf before publication", async () => {
    const created = bundle("Review freshness evidence.");
    const mutations = [
      { label: "name", options: { targetName: "other-suite" } },
      { label: "version", options: { targetVersion: "2.0.0" } },
      { label: "digest", options: { targetDigest: `sha256:${"0".repeat(64)}` } },
      { label: "bytes", options: { targetBytes: created.content.byteLength + 1 } },
      { label: "status", options: { status: "revoked" as const } },
    ] as const;

    for (const mutation of mutations) {
      const projectRoot = await projectDirectory();
      const store = new LocalCapabilityPackageStore(projectRoot, {
        now: () => new Date("2026-08-14T00:00:00.000Z"),
      });
      await store.refreshMetadata({
        metadata: capabilityMetadata(created.content, { version: 1, ...mutation.options }),
        authority: metadataAuthority(),
      });

      await expect(
        store.install({
          source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
          expectedSha256: digest(created.content),
          content: created.content,
        }),
        mutation.label,
      ).rejects.toMatchObject({ code: "metadata_target" });
      await expect(
        stat(join(projectRoot, ".flow", "packages.lock.json")),
        mutation.label,
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["certificateIssuer", "certificateIdentity"] as const)(
    "binds signed OCI target publisher %s independently from proof bytes",
    async (field) => {
      const projectRoot = await projectDirectory();
      const created = bundle("Review freshness evidence.");
      const source = `registry.example.test/flow/review-suite@sha256:${"1".repeat(64)}`;
      const publisherPolicy = {
        certificateIssuer: "https://token.actions.githubusercontent.com/",
        certificateIdentity:
          "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/v1.0.0",
      };
      const publisher = {
        kind: "sigstore-keyless-v0.3" as const,
        ...publisherPolicy,
        signatureBundleDigest: `sha256:${"2".repeat(64)}`,
      };
      const store = new LocalCapabilityPackageStore(projectRoot, {
        now: () => new Date("2026-08-14T00:00:00.000Z"),
      });
      await store.refreshMetadata({
        metadata: capabilityMetadata(created.content, {
          version: 1,
          source,
          publisher: publisherPolicy,
        }),
        authority: metadataAuthority(),
      });

      await expect(
        store.install({
          source,
          expectedSha256: digest(created.content),
          content: created.content,
          publisher,
        }),
      ).resolves.toMatchObject({ status: "installed" });

      await store.refreshMetadata({
        metadata: capabilityMetadata(created.content, {
          version: 2,
          source,
          publisher: {
            ...publisherPolicy,
            [field]:
              field === "certificateIssuer"
                ? "https://issuer.example.test/PRIVATE_SUBSTITUTE"
                : "https://publisher.example.test/PRIVATE_REVOKED_IDENTITY",
          },
        }),
        authority: metadataAuthority(),
      });
      await expect(store.verify()).rejects.toMatchObject({ code: "metadata_target" });
    },
  );

  it("serializes metadata refresh with package mutation through one lock", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    let announceLockHeld: (() => void) | undefined;
    let releaseLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      announceLockHeld = resolve;
    });
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforeMutationLockRelease: async () => {
        announceLockHeld?.();
        await holdLock;
      },
    });
    const refresh = store.refreshMetadata({
      metadata: capabilityMetadata(created.content, { version: 1 }),
      authority: metadataAuthority(),
    });
    await lockHeld;

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    releaseLock?.();
    await expect(refresh).resolves.toMatchObject({ status: "established" });
    await expect(store.inspectMetadata()).resolves.toMatchObject({ version: 1 });
  });

  it("lets only one concurrent metadata refresh own the monotonic publication", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const authority = metadataAuthority();
    let announceLockHeld: (() => void) | undefined;
    let releaseLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      announceLockHeld = resolve;
    });
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const firstStore = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforeMutationLockRelease: async () => {
        announceLockHeld?.();
        await holdLock;
      },
    });
    const secondStore = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    const first = firstStore.refreshMetadata({
      metadata: capabilityMetadata(created.content, { version: 1 }),
      authority,
    });
    await lockHeld;

    await expect(
      secondStore.refreshMetadata({
        metadata: capabilityMetadata(created.content, { version: 2 }),
        authority,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    releaseLock?.();
    await expect(first).resolves.toMatchObject({ status: "established" });
    await expect(secondStore.inspectMetadata()).resolves.toMatchObject({ version: 1 });
  });

  it("rejects a metadata refresh that settles while installed bytes are being verified", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const source = "https://packages.example.test/review-suite-1.0.0.flowpkg";
    const authority = metadataAuthority();
    const authorityStore = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await authorityStore.install({
      source,
      expectedSha256: digest(created.content),
      content: created.content,
    });
    await authorityStore.refreshMetadata({
      metadata: capabilityMetadata(created.content, { version: 1 }),
      authority,
    });
    let refreshed = false;
    const verifyingStore = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforeVerifyBundleRead: async () => {
        if (!refreshed) {
          refreshed = true;
          await authorityStore.refreshMetadata({
            metadata: capabilityMetadata(created.content, { version: 2, status: "revoked" }),
            authority,
          });
        }
      },
    });

    await expect(verifyingStore.verify()).rejects.toMatchObject({ code: "metadata_target" });
    expect(refreshed).toBe(true);
  });

  it("rechecks metadata expiry after all installed bytes settle", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const source = "https://packages.example.test/review-suite-1.0.0.flowpkg";
    const authority = metadataAuthority();
    const setupStore = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await setupStore.refreshMetadata({
      metadata: capabilityMetadata(created.content, { version: 1 }),
      authority,
    });
    await setupStore.install({
      source,
      expectedSha256: digest(created.content),
      content: created.content,
    });
    let clockReads = 0;
    const verifyingStore = new LocalCapabilityPackageStore(projectRoot, {
      now: () => {
        clockReads += 1;
        return new Date(clockReads < 3 ? "2026-08-14T23:59:59.999Z" : "2026-08-15T00:00:00.000Z");
      },
    });

    await expect(verifyingStore.verify()).rejects.toMatchObject({ code: "metadata_expired" });
    expect(clockReads).toBe(3);
  });

  it("rejects new install after metadata expiry but keeps inspection available", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    let now = new Date("2026-08-14T00:00:00.000Z");
    const store = new LocalCapabilityPackageStore(projectRoot, { now: () => now });
    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, { version: 1 }),
      authority: metadataAuthority(),
    });
    now = new Date("2026-08-15T00:00:00.000Z");

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
      }),
    ).rejects.toMatchObject({ code: "metadata_expired" });
    await expect(store.inspectMetadata()).resolves.toMatchObject({ version: 1 });
  });

  it("withholds package activation when metadata expires after blob settlement", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review freshness evidence.");
    const source = "https://packages.example.test/review-suite-1.0.0.flowpkg";
    const setupStore = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await setupStore.refreshMetadata({
      metadata: capabilityMetadata(created.content, { version: 1 }),
      authority: metadataAuthority(),
    });
    let clockReads = 0;
    const installingStore = new LocalCapabilityPackageStore(projectRoot, {
      now: () => {
        clockReads += 1;
        return new Date(clockReads === 1 ? "2026-08-14T23:59:59.999Z" : "2026-08-15T00:00:00.000Z");
      },
    });

    await expect(
      installingStore.install({
        source,
        expectedSha256: digest(created.content),
        content: created.content,
      }),
    ).rejects.toMatchObject({ code: "metadata_expired" });
    expect(clockReads).toBe(2);
    await expect(installingStore.list()).resolves.toMatchObject({ bundles: [] });
  });

  it("publishes exact blob bytes before a deterministic lock entry", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const store = new LocalCapabilityPackageStore(projectRoot);

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: sha256,
        content: created.content,
      }),
    ).resolves.toMatchObject({
      status: "installed",
      bundle: { name: "review-suite", version: "1.0.0", digest: `sha256:${sha256}` },
    });

    const blobPath = join(projectRoot, ".flow", "packages", "sha256", `${sha256}.flowpkg`);
    await expect(readFile(blobPath)).resolves.toEqual(created.content);
    expect((await stat(blobPath)).mode & 0o777).toBe(0o600);
    await expect(readFile(join(projectRoot, ".flow", "packages.lock.json"), "utf8")).resolves.toBe(
      `${JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityLock",
        bundles: [
          {
            name: "review-suite",
            version: "1.0.0",
            source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
            digest: `sha256:${sha256}`,
            bytes: created.content.byteLength,
          },
        ],
      })}\n`,
    );
    await expect(store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0", digest: `sha256:${sha256}` }],
    });
  });

  it("round-trips signed OCI publisher provenance without changing offline verification", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review signed evidence.");
    const sha256 = digest(created.content);
    const manifestDigest = `sha256:${"1".repeat(64)}`;
    const signatureBundleDigest = `sha256:${"2".repeat(64)}`;
    const source = `registry.example.test/flow/review-suite@${manifestDigest}`;
    const publisher = {
      signatureBundleDigest,
      certificateIdentity:
        "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/v1.0.0",
      certificateIssuer: "https://token.actions.githubusercontent.com/",
      kind: "sigstore-keyless-v0.3" as const,
    };
    const store = new LocalCapabilityPackageStore(projectRoot);

    await expect(
      store.install({
        source,
        expectedSha256: sha256,
        content: created.content,
        publisher,
      }),
    ).resolves.toMatchObject({ status: "installed" });
    await expect(
      store.install({
        source,
        expectedSha256: sha256,
        content: created.content,
        publisher,
      }),
    ).resolves.toMatchObject({ status: "already_installed" });

    await expect(store.list()).resolves.toEqual({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityLock",
      bundles: [
        {
          name: "review-suite",
          version: "1.0.0",
          source,
          digest: `sha256:${sha256}`,
          bytes: created.content.byteLength,
          publisher,
        },
      ],
    });
    await expect(store.verify()).resolves.toMatchObject([
      {
        entry: { source, publisher },
        bundle: { name: "review-suite", version: "1.0.0" },
      },
    ]);
    await expect(readFile(join(projectRoot, ".flow", "packages.lock.json"), "utf8")).resolves.toBe(
      `${JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityLock",
        bundles: [
          {
            name: "review-suite",
            version: "1.0.0",
            source,
            digest: `sha256:${sha256}`,
            bytes: created.content.byteLength,
            publisher: {
              kind: "sigstore-keyless-v0.3",
              certificateIssuer: publisher.certificateIssuer,
              certificateIdentity: publisher.certificateIdentity,
              signatureBundleDigest,
            },
          },
        ],
      })}\n`,
    );
  });

  it("installs publisher-verified HTTPS bytes only under exact active metadata", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review repository evidence.");
    const source =
      "https://packages.example.test/targets/7f/7fd4c3.review-suite-1.0.0.flowpkg.json";
    const publisher = {
      kind: "sigstore-keyless-v0.3" as const,
      certificateIssuer: "https://token.actions.githubusercontent.com/",
      certificateIdentity:
        "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/v1.0.0",
      signatureBundleDigest: `sha256:${"2".repeat(64)}`,
    };
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, {
        version: 1,
        source,
        publisher: {
          certificateIssuer: publisher.certificateIssuer,
          certificateIdentity: publisher.certificateIdentity,
        },
      }),
      authority: metadataAuthority(),
    });

    await expect(
      store.install({
        source,
        expectedSha256: digest(created.content),
        content: created.content,
        publisher,
      }),
    ).resolves.toMatchObject({ status: "installed" });
    await expect(store.verify()).resolves.toMatchObject([{ entry: { source, publisher } }]);
  });

  it.each([
    {
      label: "an OCI source without publisher evidence",
      source: `registry.example.test/flow/review-suite@sha256:${"1".repeat(64)}`,
      publisher: undefined,
    },
    {
      label: "a malformed signature-bundle digest",
      source: `registry.example.test/flow/review-suite@sha256:${"1".repeat(64)}`,
      publisher: {
        kind: "sigstore-keyless-v0.3" as const,
        certificateIssuer: "https://token.actions.githubusercontent.com/",
        certificateIdentity: "PRIVATE_IDENTITY",
        signatureBundleDigest: "sha256:not-a-digest",
      },
    },
    {
      label: "a publisher identity beyond the UTF-8 byte bound",
      source: `registry.example.test/flow/review-suite@sha256:${"1".repeat(64)}`,
      publisher: {
        kind: "sigstore-keyless-v0.3" as const,
        certificateIssuer: "https://token.actions.githubusercontent.com/",
        certificateIdentity: "😀".repeat(2_048),
        signatureBundleDigest: `sha256:${"2".repeat(64)}`,
      },
    },
    {
      label: "a publisher identity that is not canonical UTF-8",
      source: `registry.example.test/flow/review-suite@sha256:${"1".repeat(64)}`,
      publisher: {
        kind: "sigstore-keyless-v0.3" as const,
        certificateIssuer: "https://token.actions.githubusercontent.com/",
        certificateIdentity: "\ud800",
        signatureBundleDigest: `sha256:${"2".repeat(64)}`,
      },
    },
  ])("rejects $label before publishing package state", async ({ source, publisher }) => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review signed evidence.");
    const store = new LocalCapabilityPackageStore(projectRoot);

    await expect(
      store.install({
        source,
        expectedSha256: digest(created.content),
        content: created.content,
        ...(publisher === undefined ? {} : { publisher }),
      }),
    ).rejects.toMatchObject({ code: "invalid_source" });
    await expect(readdir(join(projectRoot, ".flow"))).resolves.toEqual([]);
  });

  it("rejects a digest mismatch before creating package state", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const store = new LocalCapabilityPackageStore(projectRoot);

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: "0".repeat(64),
        content: created.content,
      }),
    ).rejects.toMatchObject({ name: "CapabilityPackageStoreError", code: "invalid_bundle" });
    await expect(readdir(join(projectRoot, ".flow"))).resolves.toEqual([]);
  });

  it("ignores an orphan blob until an exact install activates it", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const blobDirectory = join(projectRoot, ".flow", "packages", "sha256");
    await mkdir(blobDirectory, { recursive: true });
    await writeFile(join(blobDirectory, `${sha256}.flowpkg`), created.content, { mode: 0o600 });
    const store = new LocalCapabilityPackageStore(projectRoot);

    await expect(store.list()).resolves.toMatchObject({ bundles: [] });
    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: sha256,
        content: created.content,
      }),
    ).resolves.toMatchObject({ status: "installed" });
    await expect(store.list()).resolves.toMatchObject({ bundles: [{ name: "review-suite" }] });
  });

  it("fails a bundle identity collision without publishing the conflicting blob or lock", async () => {
    const projectRoot = await projectDirectory();
    const first = bundle("Review evidence.");
    const conflicting = bundle("Use a different rubric.");
    const firstDigest = digest(first.content);
    const conflictingDigest = digest(conflicting.content);
    const store = new LocalCapabilityPackageStore(projectRoot);
    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: firstDigest,
      content: first.content,
    });
    const lockBefore = await readFile(join(projectRoot, ".flow", "packages.lock.json"));

    await expect(
      store.install({
        source: "https://mirror.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: conflictingDigest,
        content: conflicting.content,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CapabilityPackageStoreError && error.code === "identity_conflict",
    );
    await expect(
      stat(join(projectRoot, ".flow", "packages", "sha256", `${conflictingDigest}.flowpkg`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(projectRoot, ".flow", "packages.lock.json"))).resolves.toEqual(
      lockBefore,
    );
  });

  it("treats exact bytes as idempotent without rewriting their original source", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const store = new LocalCapabilityPackageStore(projectRoot);
    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: sha256,
      content: created.content,
    });

    await expect(
      store.install({
        source: "https://mirror.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: sha256,
        content: created.content,
      }),
    ).resolves.toMatchObject({ status: "already_installed" });
    await expect(store.list()).resolves.toMatchObject({
      bundles: [{ source: "https://packages.example.test/review-suite-1.0.0.flowpkg" }],
    });
  });

  it("does not report a signed install when identical locked bytes lack its provenance", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const store = new LocalCapabilityPackageStore(projectRoot);
    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: sha256,
      content: created.content,
    });

    await expect(
      store.install({
        source: `registry.example.test/flow/review@sha256:${"1".repeat(64)}`,
        expectedSha256: sha256,
        content: created.content,
        publisher: {
          kind: "sigstore-keyless-v0.3",
          certificateIssuer: "https://token.actions.githubusercontent.com/",
          certificateIdentity: "PRIVATE_SIGNED_IDENTITY",
          signatureBundleDigest: `sha256:${"2".repeat(64)}`,
        },
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    await expect(store.list()).resolves.toMatchObject({
      bundles: [
        {
          source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        },
      ],
    });
    expect((await store.list()).bundles[0]).not.toHaveProperty("publisher");
  });

  it("refuses idempotent activation when the locked blob is corrupt", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const store = new LocalCapabilityPackageStore(projectRoot);
    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: sha256,
      content: created.content,
    });
    await writeFile(
      join(projectRoot, ".flow", "packages", "sha256", `${sha256}.flowpkg`),
      "corrupt",
    );

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: sha256,
        content: created.content,
      }),
    ).rejects.toMatchObject({ code: "corrupt_blob" });
  });

  it("rejects ambiguous and symlinked lock state", async () => {
    const projectRoot = await projectDirectory();
    const lockPath = join(projectRoot, ".flow", "packages.lock.json");
    const store = new LocalCapabilityPackageStore(projectRoot);
    await writeFile(
      lockPath,
      '{"apiVersion":"flow.synapti.ai/v1alpha1","kind":"CapabilityLock","kind":"CapabilityLock","bundles":[]}\n',
    );
    await expect(store.list()).rejects.toMatchObject({ code: "invalid_lock" });

    await rm(lockPath);
    const referent = join(projectRoot, "outside-lock.json");
    await writeFile(
      referent,
      '{"apiVersion":"flow.synapti.ai/v1alpha1","kind":"CapabilityLock","bundles":[]}\n',
    );
    await symlink(referent, lockPath);
    await expect(store.list()).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("rejects a FIFO lock path without blocking on open", async () => {
    const projectRoot = await projectDirectory();
    const lockPath = join(projectRoot, ".flow", "packages.lock.json");
    await execFileAsync("mkfifo", [lockPath]);
    const store = new LocalCapabilityPackageStore(projectRoot);
    const pending = store.list().then(
      () => ({ status: "settled" as const, error: undefined }),
      (error: unknown) => ({ status: "settled" as const, error }),
    );

    const first = await Promise.race([
      pending,
      delay(100).then(() => ({ status: "blocked" as const, error: undefined })),
    ]);
    if (first.status === "blocked") {
      await writeFile(lockPath, "release blocked reader");
    }
    const outcome = await pending;

    expect(first.status).toBe("settled");
    expect(outcome.error).toMatchObject({ code: "unsafe_state" });
  });

  it("fails closed when a mutation lock is owned by an exited same-host process", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    await writeFile(
      join(projectRoot, ".flow", "packages.mutation.lock"),
      `${JSON.stringify({ pid: 2_147_483_647, hostname: hostname(), token: "stale-owner" })}\n`,
      { mode: 0o600 },
    );
    const store = new LocalCapabilityPackageStore(projectRoot);

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: sha256,
        content: created.content,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    await expect(readdir(join(projectRoot, ".flow"))).resolves.toEqual(["packages.mutation.lock"]);
  });

  it("retries when an observed mutation-lock owner disappears before inspection", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const lockPath = join(projectRoot, ".flow", "packages.mutation.lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, hostname: hostname(), token: "departing-owner" })}\n`,
      { mode: 0o600 },
    );
    let collisions = 0;
    const store = new LocalCapabilityPackageStore(projectRoot, {
      afterMutationLockCollision: async () => {
        collisions += 1;
        await rm(lockPath);
      },
    });

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
      }),
    ).resolves.toMatchObject({ status: "installed" });
    expect(collisions).toBe(1);
  });

  it("rejects symlinked package-store ancestry before reading installed bytes", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const store = new LocalCapabilityPackageStore(projectRoot);
    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: sha256,
      content: created.content,
    });
    const packagesPath = join(projectRoot, ".flow", "packages");
    const referent = join(projectRoot, "outside-packages");
    await rename(packagesPath, referent);
    await symlink(referent, packagesPath);

    await expect(store.verify()).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("sorts independent bundle identities deterministically", async () => {
    const projectRoot = await projectDirectory();
    const zeta = bundle("Review zeta.", "zeta-suite");
    const alpha = bundle("Review alpha.", "alpha-suite");
    const store = new LocalCapabilityPackageStore(projectRoot);
    await store.install({
      source: "https://packages.example.test/zeta-suite-1.0.0.flowpkg",
      expectedSha256: digest(zeta.content),
      content: zeta.content,
    });
    await store.install({
      source: "https://packages.example.test/alpha-suite-1.0.0.flowpkg",
      expectedSha256: digest(alpha.content),
      content: alpha.content,
    });

    await expect(store.list()).resolves.toMatchObject({
      bundles: [{ name: "alpha-suite" }, { name: "zeta-suite" }],
    });
  });

  it("deactivates a removed bundle before deleting its orphan blob", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const store = new LocalCapabilityPackageStore(projectRoot);
    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: sha256,
      content: created.content,
    });

    await expect(store.remove("review-suite", "1.0.0")).resolves.toEqual({
      status: "removed",
      cleanup: "deleted",
      entry: expect.objectContaining({ digest: `sha256:${sha256}` }),
    });
    await expect(store.list()).resolves.toMatchObject({ bundles: [] });
    await expect(
      stat(join(projectRoot, ".flow", "packages", "sha256", `${sha256}.flowpkg`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports commit-uncertain when install lock replacement is visible but not synced", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const store = new LocalCapabilityPackageStore(projectRoot, {
      afterCapabilityLockRenamed: async () => {
        throw new Error("injected directory sync boundary failure");
      },
    });

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: sha256,
        content: created.content,
      }),
    ).rejects.toMatchObject({ code: "commit_uncertain" });
    await expect(new LocalCapabilityPackageStore(projectRoot).list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0" }],
    });
  });

  it.each(["packages", "sha256"])(
    "withholds activation when parent sync fails for %s",
    async (directoryName) => {
      const projectRoot = await projectDirectory();
      const created = bundle("Review evidence.");
      const store = new LocalCapabilityPackageStore(projectRoot, {
        beforeStoreDirectoryParentSync: async (path) => {
          if (path.endsWith(`/${directoryName}`)) {
            throw new Error(`injected ${directoryName} parent sync failure`);
          }
        },
      });

      await expect(
        store.install({
          source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
          expectedSha256: digest(created.content),
          content: created.content,
        }),
      ).rejects.toMatchObject({ code: "io" });
      await expect(stat(join(projectRoot, ".flow", "packages.lock.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(new LocalCapabilityPackageStore(projectRoot).list()).resolves.toMatchObject({
        bundles: [],
      });
    },
  );

  it("syncs store ancestry before making the activation lock visible", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const events: string[] = [];
    const store = new LocalCapabilityPackageStore(projectRoot, {
      afterStoreDirectoryParentSynced: async (path) => {
        events.push(`synced:${path.endsWith("/sha256") ? "sha256" : "packages"}`);
      },
      afterCapabilityLockRenamed: async () => {
        events.push("lock-visible");
      },
    });

    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: digest(created.content),
      content: created.content,
    });

    expect(events).toEqual(["synced:packages", "synced:sha256", "lock-visible"]);
  });

  it("reports commit-uncertain when remove lock replacement is visible but not synced", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    await new LocalCapabilityPackageStore(projectRoot).install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: sha256,
      content: created.content,
    });
    const store = new LocalCapabilityPackageStore(projectRoot, {
      afterCapabilityLockRenamed: async () => {
        throw new Error("injected directory sync boundary failure");
      },
    });

    await expect(store.remove("review-suite", "1.0.0")).rejects.toMatchObject({
      code: "commit_uncertain",
    });
    await expect(new LocalCapabilityPackageStore(projectRoot).list()).resolves.toMatchObject({
      bundles: [],
    });
  });

  it("reports a committed mutation as uncertain when lock release fails", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const store = new LocalCapabilityPackageStore(projectRoot, {
      beforeMutationLockRelease: async () => {
        throw new Error("injected release failure");
      },
    });

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: sha256,
        content: created.content,
      }),
    ).rejects.toMatchObject({ code: "commit_uncertain" });
    await expect(new LocalCapabilityPackageStore(projectRoot).list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite" }],
    });
  });

  it("preserves a primary domain failure when lock release also fails", async () => {
    const projectRoot = await projectDirectory();
    const first = bundle("Review evidence.");
    const conflicting = bundle("Use a different rubric.");
    await new LocalCapabilityPackageStore(projectRoot).install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: digest(first.content),
      content: first.content,
    });
    const store = new LocalCapabilityPackageStore(projectRoot, {
      beforeMutationLockRelease: async () => {
        throw new Error("injected release failure");
      },
    });

    const failure = await store
      .install({
        source: "https://mirror.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(conflicting.content),
        content: conflicting.content,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "identity_conflict" });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toHaveLength(2);
  });

  it("fails removal of an identity that is not installed", async () => {
    const store = new LocalCapabilityPackageStore(await projectDirectory());

    await expect(store.remove("missing-suite", "1.0.0")).rejects.toMatchObject({
      name: "CapabilityPackageStoreError",
      code: "not_found",
    });
  });

  it("reopens and verifies every lock-selected bundle without network access", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const store = new LocalCapabilityPackageStore(projectRoot);
    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: sha256,
      content: created.content,
    });

    await expect(store.verify()).resolves.toMatchObject([
      {
        entry: { name: "review-suite", version: "1.0.0", digest: `sha256:${sha256}` },
        bundle: { name: "review-suite", version: "1.0.0", digest: `sha256:${sha256}` },
      },
    ]);
  });

  it("fails verification for a missing blob or a lock identity not derived from its bytes", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const store = new LocalCapabilityPackageStore(projectRoot);
    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: sha256,
      content: created.content,
    });
    const blobPath = join(projectRoot, ".flow", "packages", "sha256", `${sha256}.flowpkg`);
    const lockPath = join(projectRoot, ".flow", "packages.lock.json");
    await rm(blobPath);
    await expect(store.verify()).rejects.toMatchObject({ code: "corrupt_blob" });

    await writeFile(blobPath, created.content, { mode: 0o600 });
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      bundles: Array<Record<string, unknown>>;
    };
    if (lock.bundles[0] === undefined) {
      throw new Error("expected installed test bundle");
    }
    lock.bundles[0].name = "other-suite";
    await writeFile(lockPath, `${JSON.stringify(lock)}\n`);
    await expect(store.verify()).rejects.toMatchObject({ code: "corrupt_blob" });
  });

  it("keeps a removal durable when orphan cleanup encounters unsafe blob state", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review evidence.");
    const sha256 = digest(created.content);
    const store = new LocalCapabilityPackageStore(projectRoot);
    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: sha256,
      content: created.content,
    });
    const blobPath = join(projectRoot, ".flow", "packages", "sha256", `${sha256}.flowpkg`);
    await rm(blobPath);
    await mkdir(blobPath);

    await expect(store.remove("review-suite", "1.0.0")).resolves.toMatchObject({
      status: "removed",
      cleanup: "failed",
    });
    await expect(store.list()).resolves.toMatchObject({ bundles: [] });
    expect((await stat(blobPath)).isDirectory()).toBe(true);
  });
});

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-capability-packages-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, ".flow"));
  return directory;
}

function bundle(prompt: string, name = "review-suite") {
  return createCapabilityBundleSource({
    name,
    version: "1.0.0",
    description: "Review capabilities for a Flow project.",
    license: "Apache-2.0",
    packages: [{ kind: "verifier-package", manifest: Buffer.from(verifierManifest(prompt)) }],
  });
}

function verifierManifest(prompt: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review
  version: 1.2.0
  description: Review declared evidence.
  license: Apache-2.0
spec:
  kind: model
  prompt: ${prompt}
`;
}

function capabilityMetadata(
  content: Uint8Array,
  options: {
    readonly version: number;
    readonly metadataName?: string;
    readonly status?: "active" | "revoked";
    readonly source?: string;
    readonly targetName?: string;
    readonly targetVersion?: string;
    readonly targetDigest?: string;
    readonly targetBytes?: number;
    readonly empty?: boolean;
    readonly publisher?: {
      readonly certificateIssuer: string;
      readonly certificateIdentity: string;
    };
  },
) {
  return parseCapabilityMetadata(
    Buffer.from(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityMetadata",
        metadata: {
          name: options.metadataName ?? "project-capabilities",
          version: options.version,
          expiresAt: "2026-08-15T00:00:00.000Z",
        },
        spec: {
          targets: options.empty
            ? []
            : [
                {
                  name: options.targetName ?? "review-suite",
                  version: options.targetVersion ?? "1.0.0",
                  digest: options.targetDigest ?? `sha256:${digest(content)}`,
                  bytes: options.targetBytes ?? content.byteLength,
                  source:
                    options.source ?? "https://packages.example.test/review-suite-1.0.0.flowpkg",
                  status: options.status ?? "active",
                  ...(options.publisher === undefined ? {} : { publisher: options.publisher }),
                },
              ],
        },
      }),
    ),
    new Date("2026-08-14T00:00:00.000Z"),
  );
}

function metadataAuthority() {
  return {
    kind: "sigstore-keyless-v0.3" as const,
    certificateIssuer: "https://token.actions.githubusercontent.com/",
    certificateIdentity:
      "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/metadata-v1",
    signatureBundleDigest: `sha256:${"f".repeat(64)}`,
  };
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
