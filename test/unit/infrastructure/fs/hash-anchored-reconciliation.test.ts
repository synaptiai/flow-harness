import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_EDIT_FILE_BYTES,
  editHashAnchoredTextFile,
  reconcileHashAnchoredEditEffect,
  type HashAnchoredEditReconciliationOptions,
} from "../../../../src/infrastructure/fs/hash-anchored-edit.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("reconcileHashAnchoredEditEffect", () => {
  it.each([
    ["before\n", "not_applied", "target_matches_before", "before\n"],
    ["after\n", "applied", "target_matches_after", "after\n"],
  ] as const)(
    "classifies an exact %s-state regular file without modifying it",
    async (content, outcome, reason, expectedContent) => {
      const { target } = await textFile(content, 0o640);
      const observations: unknown[] = [];

      await reconcileHashAnchoredEditEffect(descriptor(target, 0o640), async (observation) => {
        observations.push(observation);
      });

      expect(observations).toEqual([
        {
          outcome,
          reason,
          observedSha256: sha256(content),
          observedMode: 0o640,
        },
      ]);
      expect(await readFile(target, "utf8")).toBe(expectedContent);
      expect((await stat(target)).mode & 0o777).toBe(0o640);
    },
  );

  it("classifies content divergence with bounded hash and mode evidence", async () => {
    const { target } = await textFile("different\n", 0o600);

    await expect(observe(target, descriptor(target, 0o640))).resolves.toEqual({
      outcome: "unknown",
      reason: "target_content_diverged",
      observedSha256: sha256("different\n"),
      observedMode: 0o600,
    });
    expect(await readFile(target, "utf8")).toBe("different\n");
  });

  it("classifies mode divergence when content still matches a prepared state", async () => {
    const { target } = await textFile("after\n", 0o600);

    await expect(observe(target, descriptor(target, 0o640))).resolves.toEqual({
      outcome: "unknown",
      reason: "target_mode_diverged",
      observedSha256: sha256("after\n"),
      observedMode: 0o600,
    });
  });

  it("classifies a missing target without creating it", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "missing.ts");

    await expect(observe(target, descriptor(target))).resolves.toEqual({
      outcome: "unknown",
      reason: "target_missing",
    });
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["directory", "symlink"] as const)(
    "classifies a %s as non-regular without reading through it",
    async (kind) => {
      const directory = await createTemporaryDirectory();
      const target = join(directory, "target");
      if (kind === "directory") {
        await import("node:fs/promises").then(({ mkdir }) => mkdir(target));
      } else {
        const referent = join(directory, "referent.ts");
        await writeFile(referent, "after\n", "utf8");
        await symlink(referent, target);
      }

      await expect(observe(target, descriptor(target))).resolves.toEqual({
        outcome: "unknown",
        reason: "target_not_regular",
      });
    },
  );

  it("classifies a Unix socket as non-regular without opening it", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "target.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(target, resolve);
    });

    try {
      await expect(observe(target, descriptor(target))).resolves.toEqual({
        outcome: "unknown",
        reason: "target_not_regular",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it("classifies a known permission denial as unreadable without leaking its message", async () => {
    const { target } = await textFile("before\n");
    const options: HashAnchoredEditReconciliationOptions = {
      openTarget: async () => {
        throw Object.assign(new Error("secret host-specific permission detail"), {
          code: "EACCES",
        });
      },
    };

    await expect(observe(target, descriptor(target), options)).resolves.toEqual({
      outcome: "unknown",
      reason: "target_unreadable",
    });
  });

  it("classifies a regular-file I/O failure as unreadable without leaking its message", async () => {
    const { target } = await textFile("before\n");
    const options: HashAnchoredEditReconciliationOptions = {
      openTarget: async () => {
        throw Object.assign(new Error("secret device detail"), { code: "EIO" });
      },
    };

    await expect(observe(target, descriptor(target), options)).resolves.toEqual({
      outcome: "unknown",
      reason: "target_unreadable",
    });
  });

  it("classifies a missing target when its parent directory was removed", async () => {
    const directory = await createTemporaryDirectory();
    const removedParent = join(directory, "removed");
    const target = join(removedParent, "source.ts");

    await expect(observe(target, descriptor(target))).resolves.toEqual({
      outcome: "unknown",
      reason: "target_missing",
    });
  });

  it("classifies an oversized sparse regular file before reading it", async () => {
    const { target } = await textFile("before\n");
    const handle = await open(target, "r+");
    await handle.truncate(MAX_EDIT_FILE_BYTES + 1);
    await handle.close();

    await expect(observe(target, descriptor(target))).resolves.toEqual({
      outcome: "unknown",
      reason: "target_too_large",
    });
    expect((await stat(target)).size).toBe(MAX_EDIT_FILE_BYTES + 1);
  });

  it("never reads beyond the bounded size observed before target growth", async () => {
    const { target } = await textFile("a".repeat(64 * 1024));
    let totalRequestedBytes = 0;
    let grew = false;
    const options: HashAnchoredEditReconciliationOptions = {
      openTarget: async (path, flags) => {
        const handle = await open(path, flags);
        const boundedHandle = {
          stat: handle.stat.bind(handle),
          async read(buffer: Buffer, offset: number, length: number, position: number | null) {
            totalRequestedBytes += length;
            if (!grew) {
              grew = true;
              await writeFile(target, Buffer.alloc(MAX_EDIT_FILE_BYTES + 1));
            }
            return await handle.read(buffer, offset, length, position);
          },
          async readFile() {
            throw new Error("unbounded readFile path was used");
          },
          close: handle.close.bind(handle),
        } as unknown as FileHandle;
        return boundedHandle;
      },
    };

    await expect(observe(target, descriptor(target), options)).resolves.toEqual({
      outcome: "unknown",
      reason: "target_changed_during_observation",
    });
    expect(totalRequestedBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("classifies target replacement during observation as an unknown race", async () => {
    const { directory, target } = await textFile("before\n");
    const replacement = join(directory, "replacement.ts");
    await writeFile(replacement, "after\n", { mode: 0o644 });

    await expect(
      observe(target, descriptor(target), {
        beforeIdentityRecheck: async () => {
          await rename(replacement, target);
        },
      }),
    ).resolves.toEqual({
      outcome: "unknown",
      reason: "target_changed_during_observation",
    });
    expect(await readFile(target, "utf8")).toBe("after\n");
  });

  it("keeps the shared target lock until durable publication finishes", async () => {
    const { target } = await textFile("before\n");
    const lockPath = join(join(target, ".."), `.flow-edit-${sha256(target)}.lock`);
    let releasePublication: () => void = () => undefined;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let acknowledgeEntered: () => void = () => undefined;
    const publicationEntered = new Promise<void>((resolve) => {
      acknowledgeEntered = resolve;
    });

    const reconciliation = reconcileHashAnchoredEditEffect(
      descriptor(target),
      async (observation) => {
        expect(observation).toMatchObject({ outcome: "not_applied" });
        await expect(readFile(lockPath, "utf8")).resolves.toContain(`"pid":${process.pid}`);
        acknowledgeEntered();
        await publicationGate;
      },
    );
    await publicationEntered;

    let editSettled = false;
    const edit = editHashAnchoredTextFile(target, {
      expectedSha256: sha256("before\n"),
      edits: [{ oldText: "before", newText: "after" }],
    }).finally(() => {
      editSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(editSettled).toBe(false);
    expect(await readFile(target, "utf8")).toBe("before\n");

    releasePublication();
    await reconciliation;
    await edit;
    expect(await readFile(target, "utf8")).toBe("after\n");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases target coordination when durable publication rejects", async () => {
    const { target } = await textFile("before\n");

    await expect(
      reconcileHashAnchoredEditEffect(descriptor(target), async () => {
        throw new Error("injected ledger rejection");
      }),
    ).rejects.toThrow(/injected ledger rejection/i);

    await expect(
      editHashAnchoredTextFile(target, {
        expectedSha256: sha256("before\n"),
        edits: [{ oldText: "before", newText: "after" }],
      }),
    ).resolves.toMatchObject({ afterSha256: sha256("after\n") });
  });

  it("leaves the effect unpublished while another live Flow process owns the target", async () => {
    const { directory, target } = await textFile("before\n");
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
    let published = false;

    await expect(
      reconcileHashAnchoredEditEffect(descriptor(target), async () => {
        published = true;
      }),
    ).rejects.toMatchObject({ code: "target_busy" });
    expect(published).toBe(false);
    expect(await readFile(target, "utf8")).toBe("before\n");
  });

  it("honors cancellation before observation and appends nothing", async () => {
    const { target } = await textFile("before\n");
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));
    let published = false;

    await expect(
      reconcileHashAnchoredEditEffect(
        descriptor(target),
        async () => {
          published = true;
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(published).toBe(false);
  });
});

async function observe(
  target: string,
  effect = descriptor(target),
  options: HashAnchoredEditReconciliationOptions = {},
) {
  let result: unknown;
  await reconcileHashAnchoredEditEffect(
    effect,
    async (observation) => {
      result = observation;
    },
    options,
  );
  return result;
}

function descriptor(target: string, mode = 0o644) {
  return {
    kind: "filesystem.edit" as const,
    target,
    operationDigest: "a".repeat(64),
    beforeSha256: sha256("before\n"),
    afterSha256: sha256("after\n"),
    mode,
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-effect-reconcile-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function textFile(content: string, mode = 0o644) {
  const directory = await createTemporaryDirectory();
  const target = join(directory, "source.ts");
  await writeFile(target, content, { mode });
  await chmod(target, mode);
  return { directory, target };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
