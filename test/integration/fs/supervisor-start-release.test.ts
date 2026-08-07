import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

const releaseOrder = vi.hoisted(() => ({ active: false, claimed: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (
      path: Parameters<typeof original.open>[0],
      flags: Parameters<typeof original.open>[1],
      mode?: Parameters<typeof original.open>[2],
    ) => {
      if (
        releaseOrder.active &&
        String(path).endsWith("/supervisor-start.json") &&
        !releaseOrder.claimed
      ) {
        throw new Error("release read the mutable startup path before claiming its inode");
      }
      return await original.open(path, flags, mode);
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      if (
        releaseOrder.active &&
        String(args[0]).endsWith("/supervisor-start.json") &&
        String(args[1]).includes(".supervisor-start.")
      ) {
        releaseOrder.claimed = true;
      }
      return await original.rename(...args);
    },
  };
});

import { LocalSupervisorStore } from "../../../src/infrastructure/fs/local-supervisor-store.js";
import { createSupervisorStartLock } from "../../../src/supervisor/records.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  releaseOrder.active = false;
  releaseOrder.claimed = false;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("supervisor startup release ordering", () => {
  it("claims the published inode before validating release identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-supervisor-release-"));
    temporaryDirectories.push(directory);
    const store = new LocalSupervisorStore(join(directory, "runs"));
    const lock = createSupervisorStartLock({
      pid: 1234,
      token: randomUUID(),
      acquiredAt: "2026-08-07T12:00:00.000Z",
    });
    await store.reserveSupervisorStart(lock);

    releaseOrder.active = true;
    await expect(store.releaseSupervisorStart(lock.token)).resolves.toBeUndefined();
    expect(releaseOrder.claimed).toBe(true);
  });
});
