import { mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LeanProofContainerLease } from "../../../../src/infrastructure/oci/local-lean-proof-driver.js";
import { LocalLeanProofLeaseStore } from "../../../../src/infrastructure/oci/local-lean-proof-lease-store.js";

describe("local Lean proof lease store", () => {
  it("atomically persists, advances, and removes one owner-private lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-proof-lease-test-"));
    const store = new LocalLeanProofLeaseStore({ directory: join(root, "leases") });
    const intent = lease("intent");

    await store.write(intent.leaseKey, intent);
    expect(await store.read(intent.leaseKey)).toEqual(intent);

    const created = { ...intent, state: "created", containerId: "f".repeat(64) } as const;
    await store.write(intent.leaseKey, created);
    expect(await store.read(intent.leaseKey)).toEqual(created);
    expect(
      JSON.parse(await readFile(join(root, "leases", `${intent.leaseKey}.json`), "utf8")),
    ).toEqual(created);

    await store.remove(intent.leaseKey);
    expect(await store.read(intent.leaseKey)).toBeNull();
  });

  it("does not follow a lease-record symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-proof-lease-symlink-"));
    const directory = join(root, "leases");
    const store = new LocalLeanProofLeaseStore({ directory });
    await store.initialize();
    const input = lease("intent");
    await symlink("/etc/passwd", join(directory, `${input.leaseKey}.json`));

    await expect(store.read(input.leaseKey)).rejects.toThrow(
      /regular file|symbolic link|nofollow/i,
    );
  });

  it("rejects a lease-directory symlink before changing its target permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-proof-lease-directory-symlink-"));
    const target = join(root, "target");
    await mkdir(target, { mode: 0o755 });
    await symlink(target, join(root, "leases"));
    const store = new LocalLeanProofLeaseStore({ directory: join(root, "leases") });

    await expect(store.initialize()).rejects.toThrow(/owner-private directory/i);
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });
});

function lease(state: "intent"): LeanProofContainerLease {
  const leaseKey = "a".repeat(64);
  return {
    version: 1,
    state,
    leaseKey,
    containerName: `flow-proof-${leaseKey.slice(0, 32)}`,
    requestDigest: "b".repeat(64),
    imageDigest: `sha256:${"c".repeat(64)}`,
    profileDigest: "d".repeat(64),
    runId: "run-1",
    workflowId: "proof-workflow",
    nodeId: "verify-proof",
    attempt: 1,
  };
}
