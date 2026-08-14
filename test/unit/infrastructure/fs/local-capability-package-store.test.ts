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
import {
  CapabilityPackageStoreError,
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

  it.each([
    {
      label: "an OCI source without publisher evidence",
      source: `registry.example.test/flow/review-suite@sha256:${"1".repeat(64)}`,
      publisher: undefined,
    },
    {
      label: "publisher evidence on an HTTPS source",
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      publisher: {
        kind: "sigstore-keyless-v0.3" as const,
        certificateIssuer: "https://token.actions.githubusercontent.com/",
        certificateIdentity: "PRIVATE_IDENTITY",
        signatureBundleDigest: `sha256:${"2".repeat(64)}`,
      },
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

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
