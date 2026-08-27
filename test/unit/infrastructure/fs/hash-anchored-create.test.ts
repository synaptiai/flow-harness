import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_CREATE_INPUT_BYTES,
  HashAnchoredCreateError,
  HashAnchoredCreateUncertainError,
  createHashAnchoredTextFile,
  reconcileHashAnchoredFilesystemEffect,
} from "../../../../src/infrastructure/fs/hash-anchored-edit.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("createHashAnchoredTextFile", () => {
  it("creates one new UTF-8 file durably without replacing an existing path", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "MIGRATIONS.md");
    const content = "# Migrations\n\nUse v0.4.\n";

    const result = await createHashAnchoredTextFile(target, { content });

    expect(result).toEqual({ afterSha256: sha256(content) });
    expect(await readFile(target, "utf8")).toBe(content);
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(await createTemporaryFiles(directory)).toEqual([]);
  });

  it("rejects an existing target without changing its bytes or mode", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "existing.md");
    await writeFile(target, "owner content\n", { encoding: "utf8", mode: 0o640 });

    await expect(
      createHashAnchoredTextFile(target, { content: "replacement\n" }),
    ).rejects.toMatchObject({ code: "target_exists" });
    expect(await readFile(target, "utf8")).toBe("owner content\n");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(await createTemporaryFiles(directory)).toEqual([]);
  });

  it("allows exactly one concurrent creator and never mixes their content", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "winner.md");

    const outcomes = await Promise.allSettled([
      createHashAnchoredTextFile(target, { content: "first\n" }),
      createHashAnchoredTextFile(target, { content: "second\n" }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "target_exists" },
    });
    expect(["first\n", "second\n"]).toContain(await readFile(target, "utf8"));
    expect(await createTemporaryFiles(directory)).toEqual([]);
  });

  it("prepares while the target is absent and settles after directory sync", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "new.md");
    const events: unknown[] = [];

    await createHashAnchoredTextFile(
      target,
      { content: "new\n" },
      {
        effectLifecycle: {
          prepare: async (boundary) => {
            await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
            events.push({ type: "prepared", boundary });
          },
          settle: async (settlement) => {
            events.push({ type: "settled", settlement, content: await readFile(target, "utf8") });
          },
        },
      },
    );

    expect(events).toEqual([
      {
        type: "prepared",
        boundary: { beforeSha256: null, afterSha256: sha256("new\n"), mode: 0o644 },
      },
      {
        type: "settled",
        settlement: { outcome: "committed", reason: "directory_synced" },
        content: "new\n",
      },
    ]);
  });

  it("settles not-applied and removes its temporary file when exclusive commit fails", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "new.md");
    const settlements: unknown[] = [];

    await expect(
      createHashAnchoredTextFile(
        target,
        { content: "new\n" },
        {
          commit: async () => Promise.reject(new Error("injected link failure")),
          effectLifecycle: {
            prepare: async () => undefined,
            settle: async (settlement) => {
              settlements.push(settlement);
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(HashAnchoredCreateError);
    expect(settlements).toEqual([{ outcome: "not_applied", reason: "commit_not_entered" }]);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await createTemporaryFiles(directory)).toEqual([]);
  });

  it("reports a post-commit sync failure as uncertain and preserves the new file", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "new.md");
    const operation = createHashAnchoredTextFile(
      target,
      { content: "new\n" },
      { syncDirectory: async () => Promise.reject(new Error("injected sync failure")) },
    );

    await expect(operation).rejects.toBeInstanceOf(HashAnchoredCreateUncertainError);
    await expect(operation).rejects.toMatchObject({ result: { afterSha256: sha256("new\n") } });
    expect(await readFile(target, "utf8")).toBe("new\n");
  });

  it.each([
    ["a malformed surrogate", "\ud800", "invalid_input"],
    ["oversized content", "a".repeat(MAX_CREATE_INPUT_BYTES + 1), "invalid_input"],
  ] as const)("rejects %s before creating an artifact", async (_case, content, code) => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "new.md");

    await expect(createHashAnchoredTextFile(target, { content })).rejects.toMatchObject({ code });
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await createTemporaryFiles(directory)).toEqual([]);
  });
});

describe("reconcileHashAnchoredFilesystemEffect for create", () => {
  it("classifies an absent target as unknown because post-create deletion is indistinguishable", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "missing.md");
    const observations: unknown[] = [];

    await reconcileHashAnchoredFilesystemEffect(createDescriptor(target), async (observation) => {
      observations.push(observation);
    });

    expect(observations).toEqual([{ outcome: "unknown", reason: "target_missing" }]);
  });

  it("classifies only the exact new digest and mode as applied", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "created.md");
    await writeFile(target, "new\n", { encoding: "utf8", mode: 0o644 });
    const observations: unknown[] = [];

    await reconcileHashAnchoredFilesystemEffect(createDescriptor(target), async (observation) => {
      observations.push(observation);
    });

    expect(observations).toEqual([
      {
        outcome: "applied",
        reason: "target_matches_after",
        observedSha256: sha256("new\n"),
        observedMode: 0o644,
      },
    ]);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-create-effect-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createTemporaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.startsWith(".flow-create-"));
}

function createDescriptor(target: string) {
  return {
    kind: "filesystem.create" as const,
    target,
    operationDigest: "a".repeat(64),
    beforeSha256: null,
    afterSha256: sha256("new\n"),
    mode: 0o644,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
