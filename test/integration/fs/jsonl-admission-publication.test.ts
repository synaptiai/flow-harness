import { constants } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const publication = vi.hoisted(() => ({ hardLinks: 0 }));

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
        String(path).endsWith("/admission.jsonl") &&
        typeof flags === "number" &&
        (flags & constants.O_CREAT) !== 0
      ) {
        throw new Error("final ledger name became visible before its contents were synced");
      }
      return await original.open(path, flags, mode);
    },
    link: async (...args: Parameters<typeof original.link>) => {
      publication.hardLinks += 1;
      return await original.link(...args);
    },
  };
});

import { JsonlAdmissionStore } from "../../../src/infrastructure/fs/jsonl-admission-store.js";
import { createAdmissionInitializedEvent } from "../../../src/supervisor/admission.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  publication.hardLinks = 0;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("admission ledger publication", () => {
  it("publishes the synced initialization inode without creating the final path directly", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "flow-admission-publication-"));
    temporaryDirectories.push(runsDirectory);
    const store = new JsonlAdmissionStore(runsDirectory);

    await expect(
      store.open(
        createAdmissionInitializedEvent({
          policyDigest: "a".repeat(64),
          limits: { maxActiveWorkers: 1, maxQueuedJobs: 4 },
          at: "2026-08-07T00:00:00.000Z",
        }),
      ),
    ).resolves.toMatchObject({ lastSequence: 1 });

    expect(publication.hardLinks).toBe(1);
    await expect(
      readFile(join(runsDirectory, ".supervisor", "admission.jsonl"), "utf8"),
    ).resolves.toMatch(/"type":"admission_initialized"/);
  });
});
