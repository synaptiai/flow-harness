import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_EDIT_FILE_BYTES,
  MAX_EDIT_INPUT_BYTES,
  MAX_EDIT_REPLACEMENTS,
  HashAnchoredEditError,
  HashAnchoredEditUncertainError,
  editHashAnchoredTextFile,
} from "../../../../src/infrastructure/fs/hash-anchored-edit.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("editHashAnchoredTextFile", () => {
  it("commits exact disjoint replacements atomically and preserves the file mode", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "source.ts");
    const before = "const first = 1;\nconst second = 2;\n";
    const after = "const first = 10;\nconst second = 20;\n";
    await writeFile(target, before, "utf8");
    await chmod(target, 0o640);

    const result = await editHashAnchoredTextFile(target, {
      expectedSha256: sha256(before),
      edits: [
        { oldText: "first = 1", newText: "first = 10" },
        { oldText: "second = 2", newText: "second = 20" },
      ],
    });

    expect(await readFile(target, "utf8")).toBe(after);
    expect(result).toEqual({ beforeSha256: sha256(before), afterSha256: sha256(after) });
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(await editTemporaryFiles(directory, target)).toEqual([]);
  });

  it("rejects a stale version before changing the target", async () => {
    const { target, content } = await textFile("current\n");

    await expect(
      editHashAnchoredTextFile(target, {
        expectedSha256: sha256("older\n"),
        edits: [{ oldText: "current", newText: "changed" }],
      }),
    ).rejects.toMatchObject({ code: "stale_version" });
    expect(await readFile(target, "utf8")).toBe(content);
  });

  it.each([
    [
      "missing replacement",
      [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "absent", newText: "value" },
      ],
      "replacement_not_found",
    ],
    ["ambiguous replacement", [{ oldText: "repeat", newText: "value" }], "replacement_ambiguous"],
    [
      "overlapping replacements",
      [
        { oldText: "alpha repeat", newText: "value" },
        { oldText: "repeat beta", newText: "value" },
      ],
      "replacement_overlap",
    ],
    ["empty old text", [{ oldText: "", newText: "value" }], "invalid_input"],
    ["no change", [{ oldText: "alpha", newText: "alpha" }], "no_change"],
  ] as const)("rejects %s with all-or-nothing content", async (_case, edits, code) => {
    const { target, content } = await textFile("alpha repeat beta repeat\n");

    await expect(
      editHashAnchoredTextFile(target, { expectedSha256: sha256(content), edits }),
    ).rejects.toMatchObject({ code });
    expect(await readFile(target, "utf8")).toBe(content);
    expect(await editTemporaryFiles(dirname(target), target)).toEqual([]);
  });

  it("rejects invalid UTF-8 without rewriting replacement characters", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "binary.txt");
    const bytes = Buffer.from([0xc3, 0x28]);
    await writeFile(target, bytes);

    await expect(
      editHashAnchoredTextFile(target, {
        expectedSha256: sha256(bytes),
        edits: [{ oldText: "(", newText: ")" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_utf8" });
    expect(await readFile(target)).toEqual(bytes);
  });

  it("rejects malformed surrogate replacements instead of committing replacement characters", async () => {
    const { directory, target, content } = await textFile("before\n");

    await expect(
      editHashAnchoredTextFile(target, {
        expectedSha256: sha256(content),
        edits: [{ oldText: "before", newText: "\ud800" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readFile(target, "utf8")).toBe(content);
    expect(await editTemporaryFiles(directory, target)).toEqual([]);
  });

  it.each([
    ["an invalid version", { expectedSha256: "invalid", edits: [{ oldText: "a", newText: "b" }] }],
    ["an empty edit list", { expectedSha256: "a".repeat(64), edits: [] }],
    [
      "too many replacements",
      {
        expectedSha256: "a".repeat(64),
        edits: Array.from({ length: MAX_EDIT_REPLACEMENTS + 1 }, () => ({
          oldText: "a",
          newText: "b",
        })),
      },
    ],
    [
      "oversized replacement input",
      {
        expectedSha256: "a".repeat(64),
        edits: [{ oldText: "a".repeat(MAX_EDIT_INPUT_BYTES + 1), newText: "b" }],
      },
    ],
  ] as const)("rejects %s before reading or changing the target", async (_case, request) => {
    const { directory, target, content } = await textFile("a\n");

    await expect(editHashAnchoredTextFile(target, request)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await readFile(target, "utf8")).toBe(content);
    expect(await editTemporaryFiles(directory, target)).toEqual([]);
  });

  it.each(["missing file", "directory"] as const)(
    "rejects a %s target without creating an edit artifact",
    async (targetKind) => {
      const directory = await createTemporaryDirectory();
      const target = targetKind === "directory" ? directory : join(directory, "missing.txt");

      await expect(
        editHashAnchoredTextFile(target, {
          expectedSha256: sha256("before\n"),
          edits: [{ oldText: "before", newText: "after" }],
        }),
      ).rejects.toMatchObject({ code: "invalid_target" });
      expect(await editTemporaryFiles(directory, target)).toEqual([]);
    },
  );

  it("rejects a target above the file-size bound without changing it", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "large.txt");
    const content = Buffer.alloc(MAX_EDIT_FILE_BYTES + 1, 0x61);
    await writeFile(target, content);

    await expect(
      editHashAnchoredTextFile(target, {
        expectedSha256: sha256(content),
        edits: [{ oldText: "a", newText: "b" }],
      }),
    ).rejects.toMatchObject({ code: "file_too_large" });
    expect(sha256(await readFile(target))).toBe(sha256(content));
    expect(await editTemporaryFiles(directory, target)).toEqual([]);
  });

  it("rejects output above the file-size bound before creating a temporary file", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "boundary.txt");
    const content = `${"a".repeat(MAX_EDIT_FILE_BYTES - 1)}Z`;
    await writeFile(target, content, "utf8");

    await expect(
      editHashAnchoredTextFile(target, {
        expectedSha256: sha256(content),
        edits: [{ oldText: "Z", newText: "XYZ" }],
      }),
    ).rejects.toMatchObject({ code: "file_too_large" });
    expect(sha256(await readFile(target))).toBe(sha256(content));
    expect(await editTemporaryFiles(directory, target)).toEqual([]);
  });

  it("removes its temporary file when rename fails before commit", async () => {
    const { directory, target, content } = await textFile("before\n");

    await expect(
      editHashAnchoredTextFile(
        target,
        {
          expectedSha256: sha256(content),
          edits: [{ oldText: "before", newText: "after" }],
        },
        { rename: async () => Promise.reject(new Error("injected rename failure")) },
      ),
    ).rejects.toBeInstanceOf(HashAnchoredEditError);
    expect(await readFile(target, "utf8")).toBe(content);
    expect(await editTemporaryFiles(directory, target)).toEqual([]);
  });

  it("reports post-rename directory-sync failure as uncertain with both hashes", async () => {
    const { target, content } = await textFile("before\n");
    const after = "after\n";

    const operation = editHashAnchoredTextFile(
      target,
      {
        expectedSha256: sha256(content),
        edits: [{ oldText: "before", newText: "after" }],
      },
      { syncDirectory: async () => Promise.reject(new Error("injected sync failure")) },
    );

    await expect(operation).rejects.toBeInstanceOf(HashAnchoredEditUncertainError);
    await expect(operation).rejects.toMatchObject({
      result: { beforeSha256: sha256(content), afterSha256: sha256(after) },
    });
    expect(await readFile(target, "utf8")).toBe(after);
  });

  it("reports cancellation after rename as uncertain with both hashes", async () => {
    const { target, content } = await textFile("before\n");
    const controller = new AbortController();
    const operation = editHashAnchoredTextFile(
      target,
      {
        expectedSha256: sha256(content),
        edits: [{ oldText: "before", newText: "after" }],
      },
      {
        signal: controller.signal,
        rename: async (temporaryPath, targetPath) => {
          await import("node:fs/promises").then(({ rename }) => rename(temporaryPath, targetPath));
          controller.abort(new Error("operator cancelled after rename"));
        },
      },
    );

    await expect(operation).rejects.toMatchObject({
      code: "effect_uncertain",
      result: { beforeSha256: sha256(content), afterSha256: sha256("after\n") },
    });
    expect(await readFile(target, "utf8")).toBe("after\n");
  });

  it("acknowledges the effect boundary after revalidation and before rename", async () => {
    const { target, content } = await textFile("before\n");
    await chmod(target, 0o640);
    const order: string[] = [];

    const result = await editHashAnchoredTextFile(
      target,
      {
        expectedSha256: sha256(content),
        edits: [{ oldText: "before", newText: "after" }],
      },
      {
        effectLifecycle: {
          prepare: async (boundary) => {
            order.push("prepare");
            expect(await readFile(target, "utf8")).toBe(content);
            expect(boundary).toEqual({
              beforeSha256: sha256(content),
              afterSha256: sha256("after\n"),
              mode: 0o640,
            });
          },
          settle: async (settlement) => {
            order.push(`settle:${settlement.outcome}`);
          },
        },
        rename: async (temporaryPath, targetPath) => {
          order.push("rename");
          await import("node:fs/promises").then(({ rename }) => rename(temporaryPath, targetPath));
        },
        syncDirectory: async () => {
          order.push("sync");
        },
      },
    );

    expect(result).toEqual({
      beforeSha256: sha256(content),
      afterSha256: sha256("after\n"),
    });
    expect(order).toEqual(["prepare", "rename", "sync", "settle:committed"]);
  });

  it("does not rename when effect preparation rejects", async () => {
    const { directory, target, content } = await textFile("before\n");
    let renameCalled = false;
    const settlements: string[] = [];

    await expect(
      editHashAnchoredTextFile(
        target,
        {
          expectedSha256: sha256(content),
          edits: [{ oldText: "before", newText: "after" }],
        },
        {
          effectLifecycle: {
            prepare: async () => {
              throw new Error("injected journal failure");
            },
            settle: async (settlement) => {
              settlements.push(settlement.outcome);
            },
          },
          rename: async () => {
            renameCalled = true;
          },
        },
      ),
    ).rejects.toThrow(/injected journal failure/i);

    expect(renameCalled).toBe(false);
    expect(settlements).toEqual([]);
    expect(await readFile(target, "utf8")).toBe(content);
    expect(await editTemporaryFiles(directory, target)).toEqual([]);
  });

  it("settles not-applied when cancellation follows preparation but precedes rename", async () => {
    const { target, content } = await textFile("before\n");
    const controller = new AbortController();
    let renameCalled = false;
    const settlements: unknown[] = [];

    await expect(
      editHashAnchoredTextFile(
        target,
        {
          expectedSha256: sha256(content),
          edits: [{ oldText: "before", newText: "after" }],
        },
        {
          signal: controller.signal,
          effectLifecycle: {
            prepare: async () => {
              controller.abort(new Error("cancel after durable preparation"));
            },
            settle: async (settlement) => {
              settlements.push(settlement);
            },
          },
          rename: async () => {
            renameCalled = true;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "aborted" });

    expect(renameCalled).toBe(false);
    expect(settlements).toEqual([{ outcome: "not_applied", reason: "commit_not_entered" }]);
    expect(await readFile(target, "utf8")).toBe(content);
  });

  it("settles not-applied even when temporary cleanup also fails", async () => {
    const { target, content } = await textFile("before\n");
    const controller = new AbortController();
    const settlements: unknown[] = [];
    let cleanupCalled = false;
    const options = {
      signal: controller.signal,
      effectLifecycle: {
        prepare: async () => {
          controller.abort(new Error("cancel after durable preparation"));
        },
        settle: async (settlement: unknown) => {
          settlements.push(settlement);
        },
      },
      removeTemporary: async () => {
        cleanupCalled = true;
        throw new Error("injected cleanup failure");
      },
    };

    await expect(
      editHashAnchoredTextFile(
        target,
        {
          expectedSha256: sha256(content),
          edits: [{ oldText: "before", newText: "after" }],
        },
        options,
      ),
    ).rejects.toMatchObject({ code: "io_failure" });

    expect(cleanupCalled).toBe(true);
    expect(settlements).toEqual([{ outcome: "not_applied", reason: "commit_not_entered" }]);
    expect(await readFile(target, "utf8")).toBe(content);
  });

  it("settles unknown when directory sync fails after rename", async () => {
    const { target, content } = await textFile("before\n");
    const settlements: unknown[] = [];

    await expect(
      editHashAnchoredTextFile(
        target,
        {
          expectedSha256: sha256(content),
          edits: [{ oldText: "before", newText: "after" }],
        },
        {
          effectLifecycle: {
            prepare: async () => undefined,
            settle: async (settlement) => {
              settlements.push(settlement);
            },
          },
          syncDirectory: async () => {
            throw new Error("injected sync failure");
          },
        },
      ),
    ).rejects.toBeInstanceOf(HashAnchoredEditUncertainError);

    expect(settlements).toEqual([{ outcome: "unknown", reason: "post_commit_failure" }]);
    expect(await readFile(target, "utf8")).toBe("after\n");
  });

  it("serializes concurrent edits and makes the stale follower fail", async () => {
    const { target, content } = await textFile("before\n");
    const request = {
      expectedSha256: sha256(content),
      edits: [{ oldText: "before", newText: "after" }],
    } as const;

    const outcomes = await Promise.allSettled([
      editHashAnchoredTextFile(target, request),
      editHashAnchoredTextFile(target, request),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "stale_version" }) }),
    ]);
    expect(await readFile(target, "utf8")).toBe("after\n");
  });

  it("refuses an edit while another live Flow process owns the target lock", async () => {
    const { directory, target, content } = await textFile("before\n");
    const lockPath = join(directory, `.flow-edit-${sha256(target)}.lock`);
    await writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        hostname: hostname(),
        token: "00000000-0000-4000-8000-000000000000",
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      editHashAnchoredTextFile(target, {
        expectedSha256: sha256(content),
        edits: [{ oldText: "before", newText: "after" }],
      }),
    ).rejects.toMatchObject({ code: "target_busy" });
    expect(await readFile(target, "utf8")).toBe(content);
    expect(await readFile(lockPath, "utf8")).toContain(`"pid":${process.pid}`);
  });

  it("retires an edit lock left by an exited same-host Flow process", async () => {
    const { directory, target, content } = await textFile("before\n");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const exitedPid = child.pid;
    if (exitedPid === undefined) {
      throw new Error("test child process did not receive a process ID");
    }
    await once(child, "exit");

    const lockPath = join(directory, `.flow-edit-${sha256(target)}.lock`);
    await writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        pid: exitedPid,
        hostname: hostname(),
        token: "00000000-0000-4000-8000-000000000000",
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      editHashAnchoredTextFile(target, {
        expectedSha256: sha256(content),
        edits: [{ oldText: "before", newText: "after" }],
      }),
    ).resolves.toEqual({
      beforeSha256: sha256(content),
      afterSha256: sha256("after\n"),
    });
    expect(await readFile(target, "utf8")).toBe("after\n");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors cancellation before commit and leaves the target unchanged", async () => {
    const { target, content } = await textFile("before\n");
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));

    await expect(
      editHashAnchoredTextFile(
        target,
        {
          expectedSha256: sha256(content),
          edits: [{ oldText: "before", newText: "after" }],
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(await readFile(target, "utf8")).toBe(content);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-hash-edit-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function textFile(content: string): Promise<{
  directory: string;
  target: string;
  content: string;
}> {
  const directory = await createTemporaryDirectory();
  const target = join(directory, "source.ts");
  await writeFile(target, content, "utf8");
  return { directory, target, content };
}

async function editTemporaryFiles(directory: string, target: string): Promise<string[]> {
  const targetHashPrefix = `.flow-edit-${sha256(target).slice(0, 16)}-`;
  return (await readdir(directory)).filter(
    (entry) => entry.startsWith(targetHashPrefix) && entry.endsWith(".tmp"),
  );
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
