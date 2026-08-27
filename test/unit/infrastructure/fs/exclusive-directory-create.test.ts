import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DIRECTORY_CREATE_MODE,
  EMPTY_DIRECTORY_SHA256,
  ExclusiveDirectoryCreateError,
  ExclusiveDirectoryCreateUncertainError,
  createExclusiveDirectory,
  reconcileExclusiveDirectoryCreateEffect,
} from "../../../../src/infrastructure/fs/exclusive-directory-create.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("createExclusiveDirectory", () => {
  it("creates exactly one empty directory with the fixed mode", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "synthesize");

    const result = await createExclusiveDirectory(target);

    expect(result).toEqual({ afterSha256: EMPTY_DIRECTORY_SHA256 });
    expect((await stat(target)).isDirectory()).toBe(true);
    expect((await stat(target)).mode & 0o777).toBe(DIRECTORY_CREATE_MODE);
    expect(await readdir(target)).toEqual([]);
  });

  it.each(["file", "directory", "symlink"] as const)(
    "rejects an existing %s without replacing it",
    async (kind) => {
      const parent = await createTemporaryDirectory();
      const target = join(parent, "existing");
      if (kind === "file") {
        await writeFile(target, "owner\n", "utf8");
      } else if (kind === "directory") {
        await mkdir(target);
      } else {
        await symlink(parent, target);
      }

      await expect(createExclusiveDirectory(target)).rejects.toMatchObject({
        code: "target_exists",
      });
      expect((await stat(target)).isDirectory()).toBe(kind !== "file");
    },
  );

  it("rejects a missing parent without creating ancestors", async () => {
    const parent = await createTemporaryDirectory();
    const missing = join(parent, "missing");
    const target = join(missing, "nested");

    await expect(createExclusiveDirectory(target)).rejects.toMatchObject({
      code: "invalid_target",
    });
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows exactly one concurrent creator", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "winner");

    const outcomes = await Promise.allSettled([
      createExclusiveDirectory(target),
      createExclusiveDirectory(target),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "target_exists" },
    });
    expect(await readdir(target)).toEqual([]);
  });

  it("prepares while absent and settles only after parent synchronization", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "synthesize");
    const events: unknown[] = [];

    await createExclusiveDirectory(target, {
      effectLifecycle: {
        prepare: async (boundary) => {
          await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
          events.push({ type: "prepared", boundary });
        },
        settle: async (settlement) => {
          events.push({
            type: "settled",
            settlement,
            empty: (await readdir(target)).length === 0,
            mode: (await stat(target)).mode & 0o777,
          });
        },
      },
    });

    expect(events).toEqual([
      {
        type: "prepared",
        boundary: {
          beforeSha256: null,
          afterSha256: EMPTY_DIRECTORY_SHA256,
          mode: DIRECTORY_CREATE_MODE,
        },
      },
      {
        type: "settled",
        settlement: { outcome: "committed", reason: "directory_synced" },
        empty: true,
        mode: DIRECTORY_CREATE_MODE,
      },
    ]);
  });

  it("settles not applied when cancellation occurs after prepare but before mkdir", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "cancelled");
    const controller = new AbortController();
    const settlements: unknown[] = [];

    await expect(
      createExclusiveDirectory(target, {
        signal: controller.signal,
        effectLifecycle: {
          prepare: async () => controller.abort("stop-before-mkdir"),
          settle: async (settlement) => {
            settlements.push(settlement);
          },
        },
      }),
    ).rejects.toMatchObject({ code: "aborted" });

    expect(settlements).toEqual([{ outcome: "not_applied", reason: "commit_not_entered" }]);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles unknown and preserves the directory after post-mkdir cancellation", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "cancelled-late");
    const controller = new AbortController();
    const settlements: unknown[] = [];

    const operation = createExclusiveDirectory(target, {
      signal: controller.signal,
      create: async (path, mode) => {
        await mkdir(path, { mode, recursive: false });
        controller.abort("stop-after-mkdir");
      },
      effectLifecycle: {
        prepare: async () => undefined,
        settle: async (settlement) => {
          settlements.push(settlement);
        },
      },
    });

    await expect(operation).rejects.toBeInstanceOf(ExclusiveDirectoryCreateUncertainError);
    expect(settlements).toEqual([{ outcome: "unknown", reason: "post_commit_failure" }]);
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it("settles not applied when the exclusive mkdir syscall fails", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "failed");
    const settlements: unknown[] = [];

    await expect(
      createExclusiveDirectory(target, {
        create: async () => Promise.reject(new Error("injected mkdir failure")),
        effectLifecycle: {
          prepare: async () => undefined,
          settle: async (settlement) => {
            settlements.push(settlement);
          },
        },
      }),
    ).rejects.toBeInstanceOf(ExclusiveDirectoryCreateError);

    expect(settlements).toEqual([{ outcome: "not_applied", reason: "commit_not_entered" }]);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports parent-sync failure as uncertain and preserves the directory", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "uncertain");
    const operation = createExclusiveDirectory(target, {
      syncParent: async () => Promise.reject(new Error("injected sync failure")),
    });

    await expect(operation).rejects.toBeInstanceOf(ExclusiveDirectoryCreateUncertainError);
    await expect(operation).rejects.toMatchObject({
      result: { afterSha256: EMPTY_DIRECTORY_SHA256 },
    });
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it("settles unknown when the created directory becomes nonempty before verification", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "populated-before-verification");
    const settlements: unknown[] = [];

    const operation = createExclusiveDirectory(target, {
      setMode: async (path, mode) => {
        await chmod(path, mode);
        await writeFile(join(path, "external.txt"), "external\n", "utf8");
      },
      effectLifecycle: {
        prepare: async () => undefined,
        settle: async (settlement) => {
          settlements.push(settlement);
        },
      },
    });

    await expect(operation).rejects.toBeInstanceOf(ExclusiveDirectoryCreateUncertainError);
    expect(settlements).toEqual([{ outcome: "unknown", reason: "post_commit_failure" }]);
    expect(await readdir(target)).toEqual(["external.txt"]);
  });

  it("settles unknown when cancellation arrives during parent synchronization", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "cancelled-during-sync");
    const controller = new AbortController();
    const settlements: unknown[] = [];

    const operation = createExclusiveDirectory(target, {
      signal: controller.signal,
      syncParent: async () => controller.abort("stop-during-parent-sync"),
      effectLifecycle: {
        prepare: async () => undefined,
        settle: async (settlement) => {
          settlements.push(settlement);
        },
      },
    });

    await expect(operation).rejects.toBeInstanceOf(ExclusiveDirectoryCreateUncertainError);
    expect(settlements).toEqual([{ outcome: "unknown", reason: "post_commit_failure" }]);
    expect((await stat(target)).isDirectory()).toBe(true);
  });
});

describe("reconcileExclusiveDirectoryCreateEffect", () => {
  it("classifies only an unchanged empty directory with the exact mode as applied", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "created");
    await mkdir(target, { mode: DIRECTORY_CREATE_MODE });
    await chmod(target, DIRECTORY_CREATE_MODE);
    const observations: unknown[] = [];

    await reconcileExclusiveDirectoryCreateEffect(mkdirDescriptor(target), async (observation) => {
      observations.push(observation);
    });

    expect(observations).toEqual([
      {
        outcome: "applied",
        reason: "target_matches_after",
        observedSha256: EMPTY_DIRECTORY_SHA256,
        observedMode: DIRECTORY_CREATE_MODE,
      },
    ]);
  });

  it("classifies a nonempty directory without reading its complete listing", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "changed");
    await mkdir(target, { mode: DIRECTORY_CREATE_MODE });
    await chmod(target, DIRECTORY_CREATE_MODE);
    await writeFile(join(target, "unexpected.txt"), "external\n", "utf8");
    const observations: unknown[] = [];

    await reconcileExclusiveDirectoryCreateEffect(mkdirDescriptor(target), async (observation) => {
      observations.push(observation);
    });

    expect(observations).toEqual([{ outcome: "unknown", reason: "target_not_empty" }]);
  });

  it("classifies a non-directory target as unknown", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "ordinary-file");
    await writeFile(target, "not a directory\n", "utf8");
    const observations: unknown[] = [];

    await reconcileExclusiveDirectoryCreateEffect(mkdirDescriptor(target), async (observation) => {
      observations.push(observation);
    });

    expect(observations).toEqual([{ outcome: "unknown", reason: "target_not_directory" }]);
  });

  it("classifies a mode-diverged empty directory as unknown", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "wrong-mode");
    await mkdir(target, { mode: 0o700 });
    await chmod(target, 0o700);
    const observations: unknown[] = [];

    await reconcileExclusiveDirectoryCreateEffect(mkdirDescriptor(target), async (observation) => {
      observations.push(observation);
    });

    expect(observations).toEqual([
      {
        outcome: "unknown",
        reason: "target_mode_diverged",
        observedSha256: EMPTY_DIRECTORY_SHA256,
        observedMode: 0o700,
      },
    ]);
  });

  it("classifies an unreadable directory as unknown", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "unreadable");
    await mkdir(target, { mode: DIRECTORY_CREATE_MODE });
    const observations: unknown[] = [];

    await reconcileExclusiveDirectoryCreateEffect(
      mkdirDescriptor(target),
      async (observation) => {
        observations.push(observation);
      },
      {
        readDirectoryEntry: async () =>
          Promise.reject(Object.assign(new Error("injected access refusal"), { code: "EACCES" })),
      },
    );

    expect(observations).toEqual([{ outcome: "unknown", reason: "target_unreadable" }]);
  });

  it("classifies a directory replaced during observation as unknown", async () => {
    const parent = await createTemporaryDirectory();
    const target = join(parent, "replaced");
    await mkdir(target, { mode: DIRECTORY_CREATE_MODE });
    await chmod(target, DIRECTORY_CREATE_MODE);
    const observations: unknown[] = [];

    await reconcileExclusiveDirectoryCreateEffect(
      mkdirDescriptor(target),
      async (observation) => {
        observations.push(observation);
      },
      {
        beforeIdentityRecheck: async () => {
          await rm(target, { recursive: true });
          await mkdir(target, { mode: DIRECTORY_CREATE_MODE });
          await chmod(target, DIRECTORY_CREATE_MODE);
        },
      },
    );

    expect(observations).toEqual([
      { outcome: "unknown", reason: "target_changed_during_observation" },
    ]);
  });

  it("classifies a missing directory as unknown", async () => {
    const parent = await createTemporaryDirectory();
    const observations: unknown[] = [];

    await reconcileExclusiveDirectoryCreateEffect(
      mkdirDescriptor(join(parent, "missing")),
      async (observation) => {
        observations.push(observation);
      },
    );

    expect(observations).toEqual([{ outcome: "unknown", reason: "target_missing" }]);
  });

  it("refuses missing-parent evidence when the target appears before recheck", async () => {
    const parent = await createTemporaryDirectory();
    const missingParent = join(parent, "restored-parent");
    const target = join(missingParent, "created");
    const observations: unknown[] = [];

    await expect(
      reconcileExclusiveDirectoryCreateEffect(
        mkdirDescriptor(target),
        async (observation) => {
          observations.push(observation);
        },
        {
          beforeMissingTargetRecheck: async () => {
            await mkdir(missingParent);
            await mkdir(target, { mode: DIRECTORY_CREATE_MODE });
            await chmod(target, DIRECTORY_CREATE_MODE);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_target" });

    expect(observations).toEqual([]);
    expect((await stat(target)).isDirectory()).toBe(true);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-directory-create-"));
  temporaryDirectories.push(directory);
  return directory;
}

function mkdirDescriptor(target: string) {
  return {
    kind: "filesystem.mkdir" as const,
    target,
    operationDigest: "a".repeat(64),
    beforeSha256: null,
    afterSha256: EMPTY_DIRECTORY_SHA256,
    mode: DIRECTORY_CREATE_MODE,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

expect(EMPTY_DIRECTORY_SHA256).toBe(sha256(""));
