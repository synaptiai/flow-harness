import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HashAnchoredEditError,
  HashAnchoredEditUncertainError,
  MAX_REPLACE_INPUT_BYTES,
  editHashAnchoredTextFile,
  replaceHashAnchoredTextFile,
} from "../../../../src/infrastructure/fs/hash-anchored-edit.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("replaceHashAnchoredTextFile", () => {
  it("atomically replaces a versioned UTF-8 file and preserves its mode", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "legacy.py");
    const before = "def legacy():\n    return 'large implementation'\n";
    const after = 'from synthesize.cli import main\n\nif __name__ == "__main__":\n    main()\n';
    await writeFile(target, before, { encoding: "utf8", mode: 0o640 });
    await chmod(target, 0o640);

    const result = await replaceHashAnchoredTextFile(target, {
      expectedSha256: sha256(before),
      content: after,
    });

    expect(result).toEqual({ beforeSha256: sha256(before), afterSha256: sha256(after) });
    expect(await readFile(target, "utf8")).toBe(after);
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it("refuses a stale version without changing the target", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "source.py");
    await writeFile(target, "current\n", "utf8");

    await expect(
      replaceHashAnchoredTextFile(target, {
        expectedSha256: sha256("stale\n"),
        content: "replacement\n",
      }),
    ).rejects.toMatchObject({ code: "stale_version" });
    expect(await readFile(target, "utf8")).toBe("current\n");
  });

  it("refuses a no-op replacement", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "source.py");
    await writeFile(target, "unchanged\n", "utf8");

    await expect(
      replaceHashAnchoredTextFile(target, {
        expectedSha256: sha256("unchanged\n"),
        content: "unchanged\n",
      }),
    ).rejects.toBeInstanceOf(HashAnchoredEditError);
    await expect(
      replaceHashAnchoredTextFile(target, {
        expectedSha256: sha256("unchanged\n"),
        content: "unchanged\n",
      }),
    ).rejects.toMatchObject({ code: "no_change" });
  });

  it("replaces an empty file without requiring nonempty old text", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "empty.py");
    await writeFile(target, "", "utf8");

    await replaceHashAnchoredTextFile(target, {
      expectedSha256: sha256(""),
      content: "from synthesize.cli import main\n",
    });

    expect(await readFile(target, "utf8")).toBe("from synthesize.cli import main\n");
  });

  it("refuses malformed Unicode before creating an effect", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "source.py");
    await writeFile(target, "before\n", "utf8");

    await expect(
      replaceHashAnchoredTextFile(target, {
        expectedSha256: sha256("before\n"),
        content: "\ud800",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readFile(target, "utf8")).toBe("before\n");
  });

  it("enforces the UTF-8 byte limit independently of the schema character limit", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "source.py");
    const before = "before\n";
    await writeFile(target, before, "utf8");

    await expect(
      replaceHashAnchoredTextFile(target, {
        expectedSha256: sha256(before),
        content: "é".repeat(MAX_REPLACE_INPUT_BYTES / 2 + 1),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readFile(target, "utf8")).toBe(before);
  });

  it("prepares exact identities and settles after directory synchronization", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "source.py");
    const before = "before\n";
    const after = "after\n";
    const events: unknown[] = [];
    await writeFile(target, before, "utf8");

    await replaceHashAnchoredTextFile(
      target,
      { expectedSha256: sha256(before), content: after },
      {
        effectLifecycle: {
          prepare: async (boundary) => {
            events.push({ type: "prepared", boundary });
          },
          settle: async (settlement) => {
            events.push({ type: "settled", settlement });
          },
        },
      },
    );

    expect(events).toEqual([
      {
        type: "prepared",
        boundary: {
          beforeSha256: sha256(before),
          afterSha256: sha256(after),
          mode: 0o644,
        },
      },
      {
        type: "settled",
        settlement: { outcome: "committed", reason: "directory_synced" },
      },
    ]);
  });

  it("settles not applied when cancellation follows preparation but precedes rename", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "source.py");
    const before = "before\n";
    const controller = new AbortController();
    const settlements: unknown[] = [];
    await writeFile(target, before, "utf8");

    await expect(
      replaceHashAnchoredTextFile(
        target,
        { expectedSha256: sha256(before), content: "after\n" },
        {
          signal: controller.signal,
          effectLifecycle: {
            prepare: async () => controller.abort("stop-before-rename"),
            settle: async (settlement) => {
              settlements.push(settlement);
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "aborted" });

    expect(settlements).toEqual([{ outcome: "not_applied", reason: "commit_not_entered" }]);
    expect(await readFile(target, "utf8")).toBe(before);
  });

  it("settles unknown when directory synchronization fails after rename", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "source.py");
    const before = "before\n";
    const after = "after\n";
    const settlements: unknown[] = [];
    await writeFile(target, before, "utf8");

    const operation = replaceHashAnchoredTextFile(
      target,
      { expectedSha256: sha256(before), content: after },
      {
        syncDirectory: async () => Promise.reject(new Error("injected sync failure")),
        effectLifecycle: {
          prepare: async () => undefined,
          settle: async (settlement) => {
            settlements.push(settlement);
          },
        },
      },
    );

    await expect(operation).rejects.toBeInstanceOf(HashAnchoredEditUncertainError);
    expect(settlements).toEqual([{ outcome: "unknown", reason: "post_commit_failure" }]);
    expect(await readFile(target, "utf8")).toBe(after);
  });

  it("serializes a replacement with an exact edit and makes one stale follower fail", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "source.py");
    const before = "before\n";
    await writeFile(target, before, "utf8");

    const outcomes = await Promise.allSettled([
      replaceHashAnchoredTextFile(target, {
        expectedSha256: sha256(before),
        content: "replaced\n",
      }),
      editHashAnchoredTextFile(target, {
        expectedSha256: sha256(before),
        edits: [{ oldText: "before", newText: "edited" }],
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "stale_version" },
    });
    expect(["replaced\n", "edited\n"]).toContain(await readFile(target, "utf8"));
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-hash-replace-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
