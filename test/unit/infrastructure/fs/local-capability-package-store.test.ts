import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
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

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCapabilityBundleSource } from "../../../../src/domain/capability/capability-bundles.js";
import { parseCapabilityMetadata } from "../../../../src/domain/capability/capability-metadata.js";
import {
  CapabilityPackageStoreError,
  type CapabilityPackageStoreHooks,
  LocalCapabilityPackageStore,
} from "../../../../src/infrastructure/fs/local-capability-package-store.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

interface CapabilityPackagePrunePreview {
  readonly status: "preview";
  readonly planDigest: string;
  readonly retiredBlobCount: number;
  readonly retiredBlobBytes: number;
}

interface CapabilityPackagePruneApplyResult {
  readonly status: "applied";
  readonly planDigest: string;
  readonly unlinkedBlobCount: number;
  readonly unlinkedBlobBytes: number;
}

interface PrunableCapabilityPackageStore {
  previewPrune(options?: { readonly signal?: AbortSignal }): Promise<CapabilityPackagePrunePreview>;
  applyPrune(input: {
    readonly expectedPlanDigest: string;
    readonly signal?: AbortSignal;
  }): Promise<CapabilityPackagePruneApplyResult>;
}

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

  it("requires active metadata for repository first activation under package mutation ownership", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review first activation evidence.");
    const source = "https://packages.example.test/targets/10/review-suite-1.0.0.flowpkg.json";
    const publisher = packagePublisher("1");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    const input = {
      source,
      expectedSha256: digest(created.content),
      content: created.content,
      publisher,
      ...repositoryInstallEvidence(),
    };

    await expect(store.installFromRepository(input)).rejects.toMatchObject({
      code: "metadata_target",
    });
    await expect(store.list()).resolves.toMatchObject({ bundles: [] });

    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, {
        version: 1,
        source,
        publisher: publisherPolicy(publisher),
      }),
      authority: metadataAuthority(),
    });
    await expect(store.installFromRepository(input)).resolves.toMatchObject({
      status: "installed",
      bundle: { name: "review-suite", version: "1.0.0" },
    });
  });

  it("rejects a repository install when another version of the package is already active", async () => {
    const projectRoot = await projectDirectory();
    const first = versionedBundle("1.0.0", "Review first activation evidence.");
    const existing = versionedBundle("2.0.0", "Review existing activation evidence.");
    const firstSource = "https://packages.example.test/targets/10/review-suite-1.0.0.flowpkg.json";
    const existingSource =
      "https://packages.example.test/targets/20/review-suite-2.0.0.flowpkg.json";
    const firstPublisher = packagePublisher("1");
    const existingPublisher = packagePublisher("2");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await store.refreshMetadata({
      metadata: capabilityMetadataForTargets(1, [
        {
          content: first.content,
          version: "1.0.0",
          source: firstSource,
          publisher: publisherPolicy(firstPublisher),
        },
        {
          content: existing.content,
          version: "2.0.0",
          source: existingSource,
          publisher: publisherPolicy(existingPublisher),
        },
      ]),
      authority: metadataAuthority(),
    });
    await store.installFromRepository({
      source: existingSource,
      expectedSha256: digest(existing.content),
      content: existing.content,
      publisher: existingPublisher,
      ...repositoryInstallEvidence(),
    });

    await expect(
      store.installFromRepository({
        source: firstSource,
        expectedSha256: digest(first.content),
        content: first.content,
        publisher: firstPublisher,
        ...repositoryInstallEvidence(),
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    await expect(store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "2.0.0" }],
    });
  });

  it("rejects repository clock rollback before publishing package bytes", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review repository clock evidence.");
    const source = "https://packages.example.test/targets/10/review-suite-1.0.0.flowpkg.json";
    const publisher = packagePublisher("1");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-13T23:59:59.000Z"),
    });
    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, {
        version: 1,
        source,
        publisher: publisherPolicy(publisher),
      }),
      authority: metadataAuthority(),
    });
    const assertCurrent = vi.fn().mockResolvedValue(undefined);
    const input = {
      source,
      expectedSha256: digest(created.content),
      content: created.content,
      publisher,
      signal: new AbortController().signal,
      trustedClockHighWater: "2026-08-14T00:00:00.000Z",
      advanceTrustedClockHighWater: async () => undefined,
      assertCurrent,
    };

    await expect(store.installFromRepository(input)).rejects.toMatchObject({
      code: "metadata_rollback",
    });
    expect(assertCurrent).not.toHaveBeenCalled();
    await expect(store.list()).resolves.toMatchObject({ bundles: [] });
  });

  it("rechecks repository currentness before active lock publication", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review repository currentness evidence.");
    const source = "https://packages.example.test/targets/10/review-suite-1.0.0.flowpkg.json";
    const publisher = packagePublisher("1");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, {
        version: 1,
        source,
        publisher: publisherPolicy(publisher),
      }),
      authority: metadataAuthority(),
    });
    const assertCurrent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("PRIVATE_REPOSITORY_CHANGED"));
    const input = {
      source,
      expectedSha256: digest(created.content),
      content: created.content,
      publisher,
      signal: new AbortController().signal,
      trustedClockHighWater: "2026-08-14T00:00:00.000Z",
      advanceTrustedClockHighWater: async () => undefined,
      assertCurrent,
    };

    const caught = await store.installFromRepository(input).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: "metadata_target" });
    expect(String(caught)).not.toContain("PRIVATE_REPOSITORY_CHANGED");
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    await expect(store.list()).resolves.toMatchObject({ bundles: [] });
  });

  it("requires current repository evidence before exact idempotent success", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review exact repository evidence.");
    const source = "https://packages.example.test/targets/10/review-suite-1.0.0.flowpkg.json";
    const publisher = packagePublisher("1");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, {
        version: 1,
        source,
        publisher: publisherPolicy(publisher),
      }),
      authority: metadataAuthority(),
    });
    await store.installFromRepository({
      source,
      expectedSha256: digest(created.content),
      content: created.content,
      publisher,
      ...repositoryInstallEvidence(),
    });
    const assertCurrent = vi.fn().mockRejectedValue(new Error("PRIVATE_STALE_CANDIDATE"));

    const caught = await store
      .installFromRepository({
        source,
        expectedSha256: digest(created.content),
        content: created.content,
        publisher,
        signal: new AbortController().signal,
        trustedClockHighWater: "2026-08-14T00:00:00.000Z",
        advanceTrustedClockHighWater: async () => undefined,
        assertCurrent,
      })
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: "metadata_target" });
    expect(String(caught)).not.toContain("PRIVATE_STALE_CANDIDATE");
    expect(assertCurrent).toHaveBeenCalledOnce();
    await expect(store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0" }],
    });
  });

  it("rechecks repository currentness after blob preparation and before blob publication", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review blob publication currentness.");
    const source = "https://packages.example.test/targets/10/review-suite-1.0.0.flowpkg.json";
    const publisher = packagePublisher("1");
    let current = true;
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforeCapabilityLockRename: async () => {
        current = false;
      },
    });
    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, {
        version: 1,
        source,
        publisher: publisherPolicy(publisher),
      }),
      authority: metadataAuthority(),
    });

    await expect(
      store.installFromRepository({
        source,
        expectedSha256: digest(created.content),
        content: created.content,
        publisher,
        signal: new AbortController().signal,
        trustedClockHighWater: "2026-08-14T00:00:00.000Z",
        advanceTrustedClockHighWater: async () => undefined,
        assertCurrent: async () => {
          if (!current) {
            throw new Error("PRIVATE_STALE_BLOB_CANDIDATE");
          }
        },
      }),
    ).rejects.toMatchObject({ code: "metadata_target" });
    await expect(readdir(join(projectRoot, ".flow", "packages", "sha256"))).resolves.toEqual([]);
    await expect(store.list()).resolves.toMatchObject({ bundles: [] });
  });

  it("rechecks repository currentness immediately before active-lock rename", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review active lock currentness.");
    const source = "https://packages.example.test/targets/10/review-suite-1.0.0.flowpkg.json";
    const publisher = packagePublisher("1");
    let current = true;
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforeCapabilityLockPublished: async () => {
        current = false;
      },
    });
    await store.refreshMetadata({
      metadata: capabilityMetadata(created.content, {
        version: 1,
        source,
        publisher: publisherPolicy(publisher),
      }),
      authority: metadataAuthority(),
    });

    await expect(
      store.installFromRepository({
        source,
        expectedSha256: digest(created.content),
        content: created.content,
        publisher,
        signal: new AbortController().signal,
        trustedClockHighWater: "2026-08-14T00:00:00.000Z",
        advanceTrustedClockHighWater: async () => undefined,
        assertCurrent: async () => {
          if (!current) {
            throw new Error("PRIVATE_STALE_LOCK_CANDIDATE");
          }
        },
      }),
    ).rejects.toMatchObject({ code: "metadata_target" });
    await expect(store.list()).resolves.toMatchObject({ bundles: [] });
  });

  it("advances the trusted clock high-water across repository fences", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review monotonic repository clock.");
    const source = "https://packages.example.test/targets/10/review-suite-1.0.0.flowpkg.json";
    const publisher = packagePublisher("1");
    await new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    }).refreshMetadata({
      metadata: capabilityMetadata(created.content, {
        version: 1,
        source,
        publisher: publisherPolicy(publisher),
      }),
      authority: metadataAuthority(),
    });
    const clock = vi.fn(
      sequenceClock([
        "2026-08-14T11:00:00.000Z",
        "2026-08-14T12:00:00.000Z",
        "2026-08-14T11:00:00.000Z",
        "2026-08-14T13:00:00.000Z",
        "2026-08-14T14:00:00.000Z",
        "2026-08-14T15:00:00.000Z",
        "2026-08-14T16:00:00.000Z",
      ]),
    );
    const store = new LocalCapabilityPackageStore(projectRoot, { now: clock });
    const advanceTrustedClockHighWater = vi.fn().mockResolvedValue(undefined);

    await expect(
      store.installFromRepository({
        source,
        expectedSha256: digest(created.content),
        content: created.content,
        publisher,
        signal: new AbortController().signal,
        trustedClockHighWater: "2026-08-14T10:00:00.000Z",
        advanceTrustedClockHighWater,
        assertCurrent: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "metadata_rollback" });
    expect(clock).toHaveBeenCalledTimes(3);
    expect(advanceTrustedClockHighWater.mock.calls).toEqual([
      ["2026-08-14T11:00:00.000Z"],
      ["2026-08-14T12:00:00.000Z"],
    ]);
    await expect(store.list()).resolves.toMatchObject({ bundles: [] });
  });

  it("withholds publication when trusted-clock persistence fails", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review durable repository clock evidence.");
    const source = "https://packages.example.test/targets/10/review-suite-1.0.0.flowpkg.json";
    const publisher = packagePublisher("1");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T11:00:00.000Z"),
    });
    await new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    }).refreshMetadata({
      metadata: capabilityMetadata(created.content, {
        version: 1,
        source,
        publisher: publisherPolicy(publisher),
      }),
      authority: metadataAuthority(),
    });

    const caught = await store
      .installFromRepository({
        source,
        expectedSha256: digest(created.content),
        content: created.content,
        publisher,
        signal: new AbortController().signal,
        trustedClockHighWater: "2026-08-14T10:00:00.000Z",
        advanceTrustedClockHighWater: async () => {
          throw new Error("PRIVATE_CLOCK_STORE_FAILURE");
        },
        assertCurrent: async () => undefined,
      })
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: "metadata_target" });
    expect(String(caught)).not.toContain("PRIVATE_CLOCK_STORE_FAILURE");
    await expect(store.list()).resolves.toMatchObject({ bundles: [] });
    await expect(readdir(join(projectRoot, ".flow", "packages"))).rejects.toMatchObject({
      code: "ENOENT",
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

  it("replaces one established publisher-verified bundle in a single active generation", async () => {
    const projectRoot = await projectDirectory();
    const current = versionedBundle("1.0.0", "Review original evidence.");
    const candidate = versionedBundle("1.1.0", "Review updated evidence.");
    const currentSource =
      "https://packages.example.test/targets/10/review-suite-1.0.0.flowpkg.json";
    const candidateSource =
      "https://packages.example.test/targets/11/review-suite-1.1.0.flowpkg.json";
    const currentPublisher = packagePublisher("1");
    const candidatePublisher = packagePublisher("2");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await store.refreshMetadata({
      metadata: capabilityMetadata(current.content, {
        version: 1,
        source: currentSource,
        publisher: publisherPolicy(currentPublisher),
      }),
      authority: metadataAuthority(),
    });
    await store.install({
      source: currentSource,
      expectedSha256: digest(current.content),
      content: current.content,
      publisher: currentPublisher,
    });
    await store.refreshMetadata({
      metadata: capabilityMetadataForTargets(2, [
        {
          content: current.content,
          version: "1.0.0",
          source: currentSource,
          publisher: publisherPolicy(currentPublisher),
        },
        {
          content: candidate.content,
          version: "1.1.0",
          source: candidateSource,
          publisher: publisherPolicy(candidatePublisher),
        },
      ]),
      authority: metadataAuthority(),
    });

    await expect(
      store.replace({
        expectedCurrentVersion: "1.0.0",
        source: candidateSource,
        expectedSha256: digest(candidate.content),
        content: candidate.content,
        publisher: candidatePublisher,
      }),
    ).resolves.toMatchObject({
      status: "replaced",
      cleanup: "retained",
      bundle: { name: "review-suite", version: "1.1.0" },
      previous: { name: "review-suite", version: "1.0.0" },
    });
    await expect(store.list()).resolves.toMatchObject({
      bundles: [
        {
          name: "review-suite",
          version: "1.1.0",
          digest: candidate.bundle.digest,
          publisher: candidatePublisher,
        },
      ],
    });
    await expect(
      stat(join(projectRoot, ".flow", "packages", "sha256", `${digest(current.content)}.flowpkg`)),
    ).resolves.toMatchObject({ size: current.content.byteLength });
  });

  it("previews one deterministic empty retired-blob maintenance plan without mutation", async () => {
    const projectRoot = await projectDirectory();
    const store = new LocalCapabilityPackageStore(
      projectRoot,
    ) as unknown as PrunableCapabilityPackageStore;

    const first = await store.previewPrune();
    const second = await store.previewPrune();

    expect(first).toEqual({
      status: "preview",
      planDigest: "sha256:c7509768378c08f5fc92c3bc461d298d1cf16dc827e33c4714732551e296e42e",
      retiredBlobCount: 0,
      retiredBlobBytes: 0,
    });
    expect(second).toEqual(first);
    await expect(readdir(join(projectRoot, ".flow"))).resolves.toEqual([]);
  });

  it("applies the exact empty plan without publishing package state", async () => {
    const projectRoot = await projectDirectory();
    const maintenance = new LocalCapabilityPackageStore(
      projectRoot,
    ) as unknown as PrunableCapabilityPackageStore;
    const preview = await maintenance.previewPrune();

    await expect(
      maintenance.applyPrune({ expectedPlanDigest: preview.planDigest }),
    ).resolves.toEqual({
      status: "applied",
      planDigest: preview.planDigest,
      unlinkedBlobCount: 0,
      unlinkedBlobBytes: 0,
    });
    await expect(readdir(join(projectRoot, ".flow"))).resolves.toEqual([]);
  });

  it("verifies one empty active generation without creating a blob store", async () => {
    const projectRoot = await projectDirectory();
    const store = new LocalCapabilityPackageStore(projectRoot);

    await expect(store.verify()).resolves.toEqual([]);
    await expect(readdir(join(projectRoot, ".flow"))).resolves.toEqual([]);
  });

  it("previews only the retired blob after replacement and leaves both generations unchanged", async () => {
    const fixture = await replacementFixture();
    await fixture.store.replace(fixture.input);
    const store = fixture.store as unknown as PrunableCapabilityPackageStore;
    const blobDirectory = join(fixture.projectRoot, ".flow", "packages", "sha256");
    const before = (await readdir(blobDirectory)).sort();

    const first = await store.previewPrune();
    const second = await store.previewPrune();

    expect(first).toEqual({
      status: "preview",
      planDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      retiredBlobCount: 1,
      retiredBlobBytes: fixture.current.content.byteLength,
    });
    expect(second).toEqual(first);
    await expect(readdir(blobDirectory)).resolves.toEqual(before);
    await expect(fixture.store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.1.0" }],
    });
  });

  it("applies one exact plan by unlinking only the retired blob", async () => {
    const fixture = await replacementFixture();
    await fixture.store.replace(fixture.input);
    const store = fixture.store as unknown as PrunableCapabilityPackageStore;
    const blobDirectory = join(fixture.projectRoot, ".flow", "packages", "sha256");
    const retiredPath = join(blobDirectory, `${digest(fixture.current.content)}.flowpkg`);
    const activePath = join(blobDirectory, `${digest(fixture.candidate.content)}.flowpkg`);
    const preview = await store.previewPrune();

    await expect(store.applyPrune({ expectedPlanDigest: preview.planDigest })).resolves.toEqual({
      status: "applied",
      planDigest: preview.planDigest,
      unlinkedBlobCount: 1,
      unlinkedBlobBytes: fixture.current.content.byteLength,
    });

    await expect(stat(retiredPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(activePath)).resolves.toMatchObject({
      size: fixture.candidate.content.length,
    });
    await expect(fixture.store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.1.0" }],
    });
    await expect(store.previewPrune()).resolves.toMatchObject({
      retiredBlobCount: 0,
      retiredBlobBytes: 0,
    });
  });

  it("rejects a stale plan when the retired candidate set changes before apply", async () => {
    const fixture = await replacementFixture();
    await fixture.store.replace(fixture.input);
    const store = fixture.store as unknown as PrunableCapabilityPackageStore;
    const preview = await store.previewPrune();
    const blobDirectory = join(fixture.projectRoot, ".flow", "packages", "sha256");
    const additional = bundle("PRIVATE_UNREVIEWED_RETIRED_BLOB", "other-suite");
    await writeFile(
      join(blobDirectory, `${digest(additional.content)}.flowpkg`),
      additional.content,
    );
    const before = (await readdir(blobDirectory)).sort();

    const failure = await store
      .applyPrune({ expectedPlanDigest: preview.planDigest })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "plan_mismatch" });
    expect((failure as Error).message).not.toContain("PRIVATE_UNREVIEWED_RETIRED_BLOB");
    await expect(readdir(blobDirectory)).resolves.toEqual(before);
    await expect(fixture.store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.1.0" }],
    });
  });

  it("rejects a stale plan when only the active lock generation changes", async () => {
    const projectRoot = await projectDirectory();
    const store = new LocalCapabilityPackageStore(projectRoot);
    const active = bundle("Review the active generation.");
    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: digest(active.content),
      content: active.content,
    });
    const retired = Buffer.from("PRIVATE_RETIRED_ACTIVE_LOCK_DRIFT");
    const retiredPath = join(
      projectRoot,
      ".flow",
      "packages",
      "sha256",
      `${digest(retired)}.flowpkg`,
    );
    await writeFile(retiredPath, retired);
    const maintenance = store as unknown as PrunableCapabilityPackageStore;
    const preview = await maintenance.previewPrune();
    const additional = bundle("Review another active package.", "other-suite");
    await store.install({
      source: "https://packages.example.test/other-suite-1.0.0.flowpkg",
      expectedSha256: digest(additional.content),
      content: additional.content,
    });

    await expect(
      maintenance.applyPrune({ expectedPlanDigest: preview.planDigest }),
    ).rejects.toMatchObject({ code: "plan_mismatch" });
    await expect(readFile(retiredPath)).resolves.toEqual(retired);
    await expect(maintenance.previewPrune()).resolves.toMatchObject({
      retiredBlobCount: 1,
      retiredBlobBytes: retired.byteLength,
    });
  });

  it("unlinks retired candidates in lexical digest order", async () => {
    const projectRoot = await projectDirectory();
    const blobDirectory = join(projectRoot, ".flow", "packages", "sha256");
    await mkdir(blobDirectory, { recursive: true });
    const contents = [Buffer.from("retired order one"), Buffer.from("retired order two")];
    const digests = contents.map((content) => `sha256:${digest(content)}`).sort();
    for (const candidateDigest of [...digests].reverse()) {
      const content = contents.find((item) => `sha256:${digest(item)}` === candidateDigest);
      if (content === undefined) {
        throw new Error("retired ordering fixture is incomplete");
      }
      await writeFile(
        join(blobDirectory, `${candidateDigest.slice("sha256:".length)}.flowpkg`),
        content,
      );
    }
    const observed: string[] = [];
    const maintenance = new LocalCapabilityPackageStore(projectRoot, {
      beforePruneCandidateUnlink: async (candidate) => {
        observed.push(candidate.digest);
      },
    }) as unknown as PrunableCapabilityPackageStore;
    const preview = await maintenance.previewPrune();

    await expect(
      maintenance.applyPrune({ expectedPlanDigest: preview.planDigest }),
    ).resolves.toMatchObject({ status: "applied", unlinkedBlobCount: 2 });
    expect(observed).toEqual(digests);
  });

  it("preserves exact cancellation before the first retired blob unlink", async () => {
    const fixture = await replacementFixture();
    await fixture.store.replace(fixture.input);
    const controller = new AbortController();
    const reason = new Error("PRIVATE_PRE_UNLINK_CANCELLATION");
    const hooks: CapabilityPackageStoreHooks & {
      readonly beforePruneCandidateUnlink: () => Promise<void>;
    } = {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforePruneCandidateUnlink: async () => controller.abort(reason),
    };
    const store = new LocalCapabilityPackageStore(
      fixture.projectRoot,
      hooks,
    ) as unknown as PrunableCapabilityPackageStore;
    const preview = await store.previewPrune();
    const retiredPath = join(
      fixture.projectRoot,
      ".flow",
      "packages",
      "sha256",
      `${digest(fixture.current.content)}.flowpkg`,
    );

    await expect(
      store.applyPrune({ expectedPlanDigest: preview.planDigest, signal: controller.signal }),
    ).rejects.toBe(reason);
    await expect(stat(retiredPath)).resolves.toMatchObject({
      size: fixture.current.content.byteLength,
    });
    await expect(
      stat(join(fixture.projectRoot, ".flow", "packages.mutation.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles one unlinked blob before restoring exact late cancellation", async () => {
    const fixture = await replacementFixture();
    await fixture.store.replace(fixture.input);
    const controller = new AbortController();
    const reason = new Error("PRIVATE_POST_UNLINK_CANCELLATION");
    let directorySynced = false;
    const hooks: CapabilityPackageStoreHooks & {
      readonly afterPruneCandidateUnlinked: () => Promise<void>;
      readonly afterPruneBlobDirectorySynced: () => Promise<void>;
    } = {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      afterPruneCandidateUnlinked: async () => controller.abort(reason),
      afterPruneBlobDirectorySynced: async () => {
        directorySynced = true;
      },
    };
    const store = new LocalCapabilityPackageStore(
      fixture.projectRoot,
      hooks,
    ) as unknown as PrunableCapabilityPackageStore;
    const preview = await store.previewPrune();
    const retiredPath = join(
      fixture.projectRoot,
      ".flow",
      "packages",
      "sha256",
      `${digest(fixture.current.content)}.flowpkg`,
    );

    await expect(
      store.applyPrune({ expectedPlanDigest: preview.planDigest, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(directorySynced).toBe(true);
    await expect(stat(retiredPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(fixture.projectRoot, ".flow", "packages.mutation.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.previewPrune()).resolves.toMatchObject({ retiredBlobCount: 0 });
  });

  it("settles partial progress and previews only remaining work after a later unlink failure", async () => {
    const fixture = await replacementFixture();
    await fixture.store.replace(fixture.input);
    const blobDirectory = join(fixture.projectRoot, ".flow", "packages", "sha256");
    const additional = bundle("PRIVATE_PARTIAL_PRUNE_CANDIDATE", "other-suite");
    await writeFile(
      join(blobDirectory, `${digest(additional.content)}.flowpkg`),
      additional.content,
    );
    let candidateNumber = 0;
    let directorySynced = false;
    const hooks: CapabilityPackageStoreHooks & {
      readonly beforePruneCandidateUnlink: () => Promise<void>;
      readonly afterPruneBlobDirectorySynced: () => Promise<void>;
    } = {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforePruneCandidateUnlink: async () => {
        candidateNumber += 1;
        if (candidateNumber === 2) {
          throw new Error("PRIVATE_SECOND_UNLINK_FAILURE");
        }
      },
      afterPruneBlobDirectorySynced: async () => {
        directorySynced = true;
      },
    };
    const store = new LocalCapabilityPackageStore(
      fixture.projectRoot,
      hooks,
    ) as unknown as PrunableCapabilityPackageStore;
    const preview = await store.previewPrune();
    expect(preview.retiredBlobCount).toBe(2);

    const failure = await store
      .applyPrune({ expectedPlanDigest: preview.planDigest })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "io" });
    expect((failure as Error).message).not.toContain("PRIVATE_SECOND_UNLINK_FAILURE");
    expect(directorySynced).toBe(true);
    await expect(store.previewPrune()).resolves.toMatchObject({ retiredBlobCount: 1 });
    await expect(fixture.store.verify()).resolves.toMatchObject([
      { bundle: { name: "review-suite", version: "1.1.0" } },
    ]);
  });

  it("reports settlement uncertainty when blob-directory persistence fails after unlink", async () => {
    const fixture = await replacementFixture();
    await fixture.store.replace(fixture.input);
    const hooks: CapabilityPackageStoreHooks & {
      readonly beforePruneBlobDirectorySync: () => Promise<void>;
    } = {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforePruneBlobDirectorySync: async () => {
        throw new Error("PRIVATE_PRUNE_DIRECTORY_SYNC_FAILURE");
      },
    };
    const store = new LocalCapabilityPackageStore(
      fixture.projectRoot,
      hooks,
    ) as unknown as PrunableCapabilityPackageStore;
    const preview = await store.previewPrune();

    const failure = await store
      .applyPrune({ expectedPlanDigest: preview.planDigest })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "settlement_uncertain" });
    expect((failure as Error).message).not.toContain("PRIVATE_PRUNE_DIRECTORY_SYNC_FAILURE");
    await expect(store.previewPrune()).resolves.toMatchObject({ retiredBlobCount: 0 });
    await expect(fixture.store.verify()).resolves.toMatchObject([
      { bundle: { name: "review-suite", version: "1.1.0" } },
    ]);
  });

  it("rejects installation before publication when the physical blob count is full", async () => {
    const projectRoot = await projectDirectory();
    const blobDirectory = join(projectRoot, ".flow", "packages", "sha256");
    await writeRetiredBlobs(blobDirectory, 256);
    const created = bundle("PRIVATE_PHYSICAL_LIMIT_PUBLICATION");
    const target = join(blobDirectory, `${digest(created.content)}.flowpkg`);
    const store = new LocalCapabilityPackageStore(projectRoot);

    const failure = await store
      .install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "physical_limit" });
    expect((failure as Error).message).not.toContain("PRIVATE_PHYSICAL_LIMIT_PUBLICATION");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(projectRoot, ".flow", "packages.lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(blobDirectory)).toHaveLength(256);
  });

  it("accepts installation at the exact physical blob count boundary", async () => {
    const projectRoot = await projectDirectory();
    const blobDirectory = join(projectRoot, ".flow", "packages", "sha256");
    await writeRetiredBlobs(blobDirectory, 255);
    const created = bundle("Review the exact physical boundary.");
    const store = new LocalCapabilityPackageStore(projectRoot);

    await expect(
      store.install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
      }),
    ).resolves.toMatchObject({ status: "installed" });

    expect(await readdir(blobDirectory)).toHaveLength(256);
    await expect(store.verify()).resolves.toMatchObject([
      { bundle: { name: "review-suite", version: "1.0.0" } },
    ]);
  });

  it("rejects replacement before publishing blob 257", async () => {
    const fixture = await replacementFixture();
    const blobDirectory = join(fixture.projectRoot, ".flow", "packages", "sha256");
    await writeRetiredBlobs(blobDirectory, 255);
    const target = join(blobDirectory, `${digest(fixture.candidate.content)}.flowpkg`);

    await expect(fixture.store.replace(fixture.input)).rejects.toMatchObject({
      code: "physical_limit",
    });

    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(blobDirectory)).toHaveLength(256);
    await expect(fixture.store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0" }],
    });
  });

  it("previews the exact recovery entry boundary and rejects entry 513", async () => {
    const projectRoot = await projectDirectory();
    const blobDirectory = join(projectRoot, ".flow", "packages", "sha256");
    await writeRetiredBlobs(blobDirectory, 512);
    const store = new LocalCapabilityPackageStore(
      projectRoot,
    ) as unknown as PrunableCapabilityPackageStore;

    await expect(store.previewPrune()).resolves.toMatchObject({ retiredBlobCount: 512 });

    await writeRetiredBlobs(blobDirectory, 1, 512);
    await expect(store.previewPrune()).rejects.toMatchObject({ code: "unsafe_state" });
    expect(await readdir(blobDirectory)).toHaveLength(513);
  });

  it.each(["symbolic link", "hard link", "directory"] as const)(
    "rejects a retired-blob %s without changing its external source",
    async (kind) => {
      const projectRoot = await projectDirectory();
      const blobDirectory = join(projectRoot, ".flow", "packages", "sha256");
      await mkdir(blobDirectory, { recursive: true });
      const externalPath = join(projectRoot, "PRIVATE_EXTERNAL_RETIRED_BLOB");
      const content = Buffer.from("PRIVATE_EXTERNAL_RETIRED_BLOB_CONTENT");
      await writeFile(externalPath, content);
      const blobPath = join(blobDirectory, `${digest(content)}.flowpkg`);
      if (kind === "symbolic link") {
        await symlink(externalPath, blobPath);
      } else if (kind === "hard link") {
        await link(externalPath, blobPath);
      } else {
        await mkdir(blobPath);
      }
      const store = new LocalCapabilityPackageStore(
        projectRoot,
      ) as unknown as PrunableCapabilityPackageStore;

      const failure = await store.previewPrune().catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: "unsafe_state" });
      expect((failure as Error).message).not.toContain("PRIVATE_EXTERNAL_RETIRED_BLOB");
      await expect(readFile(externalPath)).resolves.toEqual(content);
    },
  );

  it.each(["blob", "directory"] as const)(
    "reports fixed settlement uncertainty when a prune %s handle does not settle",
    async (failedKind) => {
      const projectRoot = await projectDirectory();
      const blobDirectory = join(projectRoot, ".flow", "packages", "sha256");
      await writeRetiredBlobs(blobDirectory, 1);
      const hooks: CapabilityPackageStoreHooks & {
        readonly settlePruneHandle: (
          kind: "blob" | "directory",
          close: () => Promise<void>,
        ) => Promise<void>;
      } = {
        settlePruneHandle: async (kind, close) => {
          await close();
          if (kind === failedKind) {
            throw new Error("PRIVATE_PRUNE_HANDLE_CLOSE_FAILURE");
          }
        },
      };
      const store = new LocalCapabilityPackageStore(projectRoot, hooks);

      const failure = await store.previewPrune().catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: "settlement_uncertain" });
      expect((failure as Error).message).not.toContain("PRIVATE_PRUNE_HANDLE_CLOSE_FAILURE");
    },
  );

  it("preserves a prune validation failure when directory handle settlement also fails", async () => {
    const projectRoot = await projectDirectory();
    const blobDirectory = join(projectRoot, ".flow", "packages", "sha256");
    await mkdir(blobDirectory, { recursive: true });
    const privateContent = Buffer.from("PRIVATE_CORRUPT_RETIRED_CONTENT");
    await writeFile(join(blobDirectory, `${"a".repeat(64)}.flowpkg`), privateContent);
    const hooks: CapabilityPackageStoreHooks & {
      readonly settlePruneHandle: (
        kind: "blob" | "directory",
        close: () => Promise<void>,
      ) => Promise<void>;
    } = {
      settlePruneHandle: async (kind, close) => {
        await close();
        if (kind === "directory") {
          throw new Error("PRIVATE_DIRECTORY_CLOSE_FAILURE");
        }
      },
    };
    const store = new LocalCapabilityPackageStore(projectRoot, hooks);

    const failure = await store.previewPrune().catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "settlement_uncertain" });
    expect((failure as Error).message).not.toContain("PRIVATE_");
    expect((failure as Error & { cause?: unknown }).cause).toBeInstanceOf(AggregateError);
    const causes = (failure as Error & { cause: AggregateError }).cause.errors;
    expect(causes[0]).toMatchObject({ code: "corrupt_blob" });
    expect(causes[1]).toMatchObject({ message: "PRIVATE_DIRECTORY_CLOSE_FAILURE" });
  });

  it("treats an exact repeated replacement as already current", async () => {
    const fixture = await replacementFixture();

    await fixture.store.replace(fixture.input);
    await expect(fixture.store.replace(fixture.input)).resolves.toMatchObject({
      status: "already_current",
      bundle: { name: "review-suite", version: "1.1.0" },
    });
    await expect(fixture.store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.1.0" }],
    });
  });

  it("requires transition metadata to authorize the established and candidate versions", async () => {
    const fixture = await replacementFixture();
    await fixture.store.refreshMetadata({
      metadata: capabilityMetadata(fixture.candidate.content, {
        version: 3,
        source: fixture.input.source,
        targetVersion: "1.1.0",
        publisher: publisherPolicy(fixture.input.publisher),
      }),
      authority: metadataAuthority(),
    });
    const lockBefore = await readFile(join(fixture.projectRoot, ".flow", "packages.lock.json"));

    await expect(fixture.store.replace(fixture.input)).rejects.toMatchObject({
      code: "metadata_target",
    });
    await expect(
      readFile(join(fixture.projectRoot, ".flow", "packages.lock.json")),
    ).resolves.toEqual(lockBefore);
    await expect(
      stat(
        join(
          fixture.projectRoot,
          ".flow",
          "packages",
          "sha256",
          `${fixture.input.expectedSha256}.flowpkg`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects publisher substitution before publishing candidate state", async () => {
    const fixture = await replacementFixture({
      candidatePublisher: {
        ...packagePublisher("2"),
        certificateIdentity:
          "https://github.com/synaptiai/flow-harness/.github/workflows/private.yml@refs/tags/v2",
      },
    });
    const lockBefore = await readFile(join(fixture.projectRoot, ".flow", "packages.lock.json"));

    const failure = await fixture.store.replace(fixture.input).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "identity_conflict" });
    expect((failure as Error).message).not.toContain("private");
    await expect(
      readFile(join(fixture.projectRoot, ".flow", "packages.lock.json")),
    ).resolves.toEqual(lockBefore);
    await expect(
      stat(
        join(
          fixture.projectRoot,
          ".flow",
          "packages",
          "sha256",
          `${digest(fixture.candidate.content)}.flowpkg`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes only the complete old or complete new active generation", async () => {
    const fixture = await replacementFixture();
    const observedVersions: string[][] = [];
    const observer = new LocalCapabilityPackageStore(fixture.projectRoot);
    const store = new LocalCapabilityPackageStore(fixture.projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforeCapabilityLockPublished: async () => {
        observedVersions.push((await observer.list()).bundles.map((entry) => entry.version));
      },
      afterCapabilityLockRenamed: async () => {
        observedVersions.push((await observer.list()).bundles.map((entry) => entry.version));
      },
    });

    await store.replace(fixture.input);

    expect(observedVersions).toEqual([["1.0.0"], ["1.1.0"]]);
  });

  it("pins the old blob for a reader after replacement and maintenance unlink its path", async () => {
    const fixture = await replacementFixture();
    let releaseReader: (() => void) | undefined;
    let markReaderReady: (() => void) | undefined;
    const readerReady = new Promise<void>((resolve) => {
      markReaderReady = resolve;
    });
    const readerReleased = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    const reader = new LocalCapabilityPackageStore(fixture.projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforeVerifyBundleRead: async (entry) => {
        if (entry.version === "1.0.0") {
          markReaderReady?.();
          await readerReleased;
        }
      },
    });

    const oldGeneration = reader.verify();
    await readerReady;
    await expect(fixture.store.replace(fixture.input)).resolves.toMatchObject({
      status: "replaced",
      cleanup: "retained",
    });
    const maintenance = fixture.store as unknown as PrunableCapabilityPackageStore;
    const preview = await maintenance.previewPrune();
    await expect(
      maintenance.applyPrune({ expectedPlanDigest: preview.planDigest }),
    ).resolves.toMatchObject({ status: "applied", unlinkedBlobCount: 1 });
    await expect(
      stat(
        join(
          fixture.projectRoot,
          ".flow",
          "packages",
          "sha256",
          `${digest(fixture.current.content)}.flowpkg`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    releaseReader?.();

    await expect(oldGeneration).resolves.toMatchObject([
      { bundle: { name: "review-suite", version: "1.0.0" } },
    ]);
    await expect(
      new LocalCapabilityPackageStore(fixture.projectRoot, {
        now: () => new Date("2026-08-14T00:00:00.000Z"),
      }).verify(),
    ).resolves.toMatchObject([{ bundle: { name: "review-suite", version: "1.1.0" } }]);
  });

  it("retries from the newer active generation when maintenance wins before blob open", async () => {
    const fixture = await replacementFixture();
    let raced = false;
    const hooks: CapabilityPackageStoreHooks & {
      readonly beforeVerifyBundleOpen: (entry: { readonly version: string }) => Promise<void>;
    } = {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforeVerifyBundleOpen: async (entry) => {
        if (entry.version !== "1.0.0" || raced) {
          return;
        }
        raced = true;
        await fixture.store.replace(fixture.input);
        const maintenance = fixture.store as unknown as PrunableCapabilityPackageStore;
        const preview = await maintenance.previewPrune();
        await maintenance.applyPrune({ expectedPlanDigest: preview.planDigest });
      },
    };
    const reader = new LocalCapabilityPackageStore(fixture.projectRoot, hooks);

    await expect(reader.verify()).resolves.toMatchObject([
      { bundle: { name: "review-suite", version: "1.1.0" } },
    ]);
    expect(raced).toBe(true);
  });

  it.each(["install", "remove", "replace"] as const)(
    "serializes replacement against a concurrent %s mutation",
    async (contender) => {
      const fixture = await replacementFixture();
      let releaseReplacement: (() => void) | undefined;
      let markReplacementReady: (() => void) | undefined;
      const replacementReady = new Promise<void>((resolve) => {
        markReplacementReady = resolve;
      });
      const replacementReleased = new Promise<void>((resolve) => {
        releaseReplacement = resolve;
      });
      const replacingStore = new LocalCapabilityPackageStore(fixture.projectRoot, {
        now: () => new Date("2026-08-14T00:00:00.000Z"),
        beforeCapabilityLockPublished: async () => {
          markReplacementReady?.();
          await replacementReleased;
        },
      });
      const replacement = replacingStore.replace(fixture.input);
      await replacementReady;
      const competingStore = new LocalCapabilityPackageStore(fixture.projectRoot, {
        now: () => new Date("2026-08-14T00:00:00.000Z"),
      });
      const competingMutation =
        contender === "install"
          ? competingStore.install({
              source: fixture.input.source,
              expectedSha256: fixture.input.expectedSha256,
              content: fixture.input.content,
              publisher: fixture.input.publisher,
            })
          : contender === "remove"
            ? competingStore.remove("review-suite", "1.0.0")
            : competingStore.replace(fixture.input);

      await expect(competingMutation).rejects.toMatchObject({ code: "busy" });
      releaseReplacement?.();
      await expect(replacement).resolves.toMatchObject({ status: "replaced" });
    },
  );

  it("reports replacement commit uncertainty after the new lock becomes visible", async () => {
    const fixture = await replacementFixture();
    const store = new LocalCapabilityPackageStore(fixture.projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      afterCapabilityLockRenamed: async () => {
        throw new Error("PRIVATE_REPLACEMENT_SETTLEMENT");
      },
    });

    await expect(store.replace(fixture.input)).rejects.toMatchObject({
      code: "commit_uncertain",
    });
    await expect(fixture.store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.1.0" }],
    });
  });

  it("reports replacement settlement uncertainty while retaining the primary failure", async () => {
    const fixture = await replacementFixture();
    const store = new LocalCapabilityPackageStore(fixture.projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforeMutationLockRelease: async () => {
        throw new Error("PRIVATE_REPLACEMENT_LOCK_RELEASE");
      },
    });

    const failure = await store
      .replace({ ...fixture.input, expectedCurrentVersion: "0.9.0" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "settlement_uncertain" });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors[0]).toMatchObject({
      code: "not_found",
    });
    await expect(fixture.store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0" }],
    });
  });

  it("preserves the old generation and exact reason for pre-commit cancellation", async () => {
    const fixture = await replacementFixture();
    const controller = new AbortController();
    const reason = new Error("PRIVATE_REPLACEMENT_CANCELLATION");
    const store = new LocalCapabilityPackageStore(fixture.projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      beforeCapabilityLockPublished: async () => {
        controller.abort(reason);
      },
    });

    await expect(store.replace({ ...fixture.input, signal: controller.signal })).rejects.toBe(
      reason,
    );
    await expect(store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0" }],
    });
  });

  it("settles a committed replacement when cancellation arrives after lock rename", async () => {
    const fixture = await replacementFixture();
    const controller = new AbortController();
    const reason = new Error("PRIVATE_POST_COMMIT_CANCELLATION");
    const store = new LocalCapabilityPackageStore(fixture.projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      afterCapabilityLockRenamed: async () => {
        controller.abort(reason);
      },
    });

    await expect(
      store.replace({ ...fixture.input, signal: controller.signal }),
    ).resolves.toMatchObject({ status: "replaced" });
    await expect(store.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.1.0" }],
    });
  });

  it("publishes no candidate blob or lock when the exact established version is missing", async () => {
    const projectRoot = await projectDirectory();
    const candidate = versionedBundle("1.1.0", "Review updated evidence.");
    const candidateSource =
      "https://packages.example.test/targets/11/review-suite-1.1.0.flowpkg.json";
    const publisher = packagePublisher("2");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    await store.refreshMetadata({
      metadata: capabilityMetadata(candidate.content, {
        version: 1,
        source: candidateSource,
        targetVersion: "1.1.0",
        publisher: publisherPolicy(publisher),
      }),
      authority: metadataAuthority(),
    });

    await expect(
      store.replace({
        expectedCurrentVersion: "1.0.0",
        source: candidateSource,
        expectedSha256: digest(candidate.content),
        content: candidate.content,
        publisher,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(store.list()).resolves.toMatchObject({ bundles: [] });
    await expect(
      stat(
        join(projectRoot, ".flow", "packages", "sha256", `${digest(candidate.content)}.flowpkg`),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
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
    ).rejects.toMatchObject({ code: "settlement_uncertain" });
    await expect(new LocalCapabilityPackageStore(projectRoot).list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite" }],
    });
    await expect(
      new LocalCapabilityPackageStore(projectRoot).settleMutation(new AbortController().signal),
    ).rejects.toMatchObject({ code: "busy" });
  });

  it("reports combined package-commit and mutation-lock-release uncertainty", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review combined package settlement.");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      afterCapabilityLockRenamed: async () => {
        throw new Error("PRIVATE_PACKAGE_COMMIT_SETTLEMENT");
      },
      beforeMutationLockRelease: async () => {
        throw new Error("PRIVATE_MUTATION_LOCK_RELEASE");
      },
    });

    const caught = await store
      .install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
      })
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: "settlement_uncertain" });
    expect((caught as Error).cause).toBeInstanceOf(AggregateError);
    expect(((caught as Error).cause as AggregateError).errors).toHaveLength(2);
    await expect(new LocalCapabilityPackageStore(projectRoot).list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite" }],
    });
  });

  it("reports combined cancellation and mutation-lock-release uncertainty", async () => {
    const projectRoot = await projectDirectory();
    const created = bundle("Review cancelled package settlement.");
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    const store = new LocalCapabilityPackageStore(projectRoot, {
      beforeCapabilityLockRename: async () => {
        controller.abort(reason);
      },
      beforeMutationLockRelease: async () => {
        throw new Error("PRIVATE_MUTATION_LOCK_RELEASE");
      },
    });

    const caught = await store
      .install({
        source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
        expectedSha256: digest(created.content),
        content: created.content,
        signal: controller.signal,
      })
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: "settlement_uncertain" });
    expect((caught as Error).cause).toBeInstanceOf(AggregateError);
    expect(((caught as Error).cause as AggregateError).errors[0]).toBe(reason);
    await expect(new LocalCapabilityPackageStore(projectRoot).list()).resolves.toMatchObject({
      bundles: [],
    });
  });

  it("reports settlement uncertainty while retaining a primary domain failure", async () => {
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

    expect(failure).toMatchObject({ code: "settlement_uncertain" });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toHaveLength(2);
    expect(((failure as Error).cause as AggregateError).errors[0]).toMatchObject({
      code: "identity_conflict",
    });
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

async function writeRetiredBlobs(
  blobDirectory: string,
  count: number,
  startIndex = 0,
): Promise<void> {
  await mkdir(blobDirectory, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const content = Buffer.from(`retired capability blob ${startIndex + index}`);
    await writeFile(join(blobDirectory, `${digest(content)}.flowpkg`), content, { mode: 0o600 });
  }
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

function versionedBundle(version: string, prompt: string) {
  return createCapabilityBundleSource({
    name: "review-suite",
    version,
    description: "Review capabilities for a Flow project.",
    license: "Apache-2.0",
    packages: [{ kind: "verifier-package", manifest: Buffer.from(verifierManifest(prompt)) }],
  });
}

function packagePublisher(marker: string) {
  return {
    kind: "sigstore-keyless-v0.3" as const,
    certificateIssuer: "https://token.actions.githubusercontent.com/",
    certificateIdentity:
      "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/v1",
    signatureBundleDigest: `sha256:${marker.repeat(64)}`,
  };
}

function repositoryInstallEvidence() {
  return {
    signal: new AbortController().signal,
    trustedClockHighWater: "2026-08-14T00:00:00.000Z",
    advanceTrustedClockHighWater: async () => undefined,
    assertCurrent: async () => undefined,
  } as const;
}

function sequenceClock(values: readonly string[]): () => Date {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error("clock fixture exhausted");
    }
    return new Date(value);
  };
}

function publisherPolicy(publisher: ReturnType<typeof packagePublisher>) {
  return {
    certificateIssuer: publisher.certificateIssuer,
    certificateIdentity: publisher.certificateIdentity,
  };
}

async function replacementFixture(
  options: { readonly candidatePublisher?: ReturnType<typeof packagePublisher> } = {},
) {
  const projectRoot = await projectDirectory();
  const current = versionedBundle("1.0.0", "Review original evidence.");
  const candidate = versionedBundle("1.1.0", "Review updated evidence.");
  const currentSource = "https://packages.example.test/targets/10/review-suite-1.0.0.flowpkg.json";
  const candidateSource =
    "https://packages.example.test/targets/11/review-suite-1.1.0.flowpkg.json";
  const currentPublisher = packagePublisher("1");
  const candidatePublisher = options.candidatePublisher ?? packagePublisher("2");
  const store = new LocalCapabilityPackageStore(projectRoot, {
    now: () => new Date("2026-08-14T00:00:00.000Z"),
  });
  await store.refreshMetadata({
    metadata: capabilityMetadata(current.content, {
      version: 1,
      source: currentSource,
      publisher: publisherPolicy(currentPublisher),
    }),
    authority: metadataAuthority(),
  });
  await store.install({
    source: currentSource,
    expectedSha256: digest(current.content),
    content: current.content,
    publisher: currentPublisher,
  });
  await store.refreshMetadata({
    metadata: capabilityMetadataForTargets(2, [
      {
        content: current.content,
        version: "1.0.0",
        source: currentSource,
        publisher: publisherPolicy(currentPublisher),
      },
      {
        content: candidate.content,
        version: "1.1.0",
        source: candidateSource,
        publisher: publisherPolicy(candidatePublisher),
      },
    ]),
    authority: metadataAuthority(),
  });
  return {
    projectRoot,
    current,
    candidate,
    store,
    input: {
      expectedCurrentVersion: "1.0.0",
      source: candidateSource,
      expectedSha256: digest(candidate.content),
      content: candidate.content,
      publisher: candidatePublisher,
    },
  };
}

function capabilityMetadataForTargets(
  version: number,
  targets: readonly {
    readonly content: Uint8Array;
    readonly version: string;
    readonly source: string;
    readonly publisher: {
      readonly certificateIssuer: string;
      readonly certificateIdentity: string;
    };
  }[],
) {
  return parseCapabilityMetadata(
    Buffer.from(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityMetadata",
        metadata: {
          name: "project-capabilities",
          version,
          expiresAt: "2026-08-15T00:00:00.000Z",
        },
        spec: {
          targets: targets.map((target) => ({
            name: "review-suite",
            version: target.version,
            digest: `sha256:${digest(target.content)}`,
            bytes: target.content.byteLength,
            source: target.source,
            status: "active",
            publisher: target.publisher,
          })),
        },
      }),
    ),
    new Date("2026-08-14T00:00:00.000Z"),
  );
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
