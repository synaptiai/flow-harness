import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  OwnedTestScope,
  OwnedTestScopeCleanupError,
  ownedTest,
  ownedTestCase,
  runOwnedTest,
} from "../../fixtures/owned-test-scope.js";

it("keeps an aborted callback root available for its outstanding real process", async () => {
  const cancellation = new AbortController();
  const scope = new OwnedTestScope(cancellation.signal, { settlementTimeoutMs: 20 });
  let publishRoot!: (root: string) => void;
  let finish!: () => void;
  const rootReady = new Promise<string>((resolve) => {
    publishRoot = resolve;
  });
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const operation = scope.run(async () => {
    const root = await scope.temporaryDirectory("flow-owned-scope-");
    publishRoot(root);
    await released;
    return root;
  });
  const root = await rootReady;
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const fs = require("node:fs");
    process.stdin.once("data", () => {
      fs.writeFileSync(process.argv[1] + "/completed", "settled");
      process.exit(0);
    });
    process.stdout.write("ready");
    setTimeout(() => process.exit(2), 3000);
  `,
      root,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  try {
    await once(child.stdout, "data");
    cancellation.abort();
    await expect(scope.cleanup()).rejects.toBeInstanceOf(OwnedTestScopeCleanupError);
    child.stdin.end("finish");
    expect((await closed)[0]).toBe(0);
    expect(await readFile(join(root, "completed"), "utf8")).toBe("settled");
    finish();
    await operation;
    await expect(scope.cleanup()).rejects.toBeInstanceOf(OwnedTestScopeCleanupError);
    expect(await readFile(join(root, "completed"), "utf8")).toBe("settled");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    finish();
    await operation;
    await rm(root, { recursive: true, force: true });
  }
});

it("removes only its own unchanged directory after the complete callback settles", async () => {
  const scope = new OwnedTestScope(new AbortController().signal);
  const result = await scope.run(async () => {
    const root = await scope.temporaryDirectory("flow-owned-complete-");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "assertion-output"), "complete");
    return root;
  });
  await scope.cleanup();
  await expect(lstat(result)).rejects.toMatchObject({ code: "ENOENT" });
  await scope.cleanup();
});

it("preserves the original callback failure while allowing settled cleanup", async () => {
  const scope = new OwnedTestScope(new AbortController().signal);
  const failure = new Error("original assertion failure");
  await expect(
    scope.run(async () => {
      await scope.temporaryDirectory("flow-owned-failed-");
      throw failure;
    }),
  ).rejects.toBe(failure);
  await scope.cleanup();
  await expect(lstat(scope.directories[0] as string)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports cancellation observed immediately after the last real removal", async () => {
  const cancellation = new AbortController();
  const removed: string[] = [];
  const scope = new OwnedTestScope(cancellation.signal, {
    onRootRemoved: (path) => {
      removed.push(path);
      cancellation.abort();
      return undefined;
    },
  });
  const root = await scope.run(async () => {
    const directory = await scope.temporaryDirectory("flow-owned-late-abort-");
    await writeFile(join(directory, "entry"), "remove");
    return directory;
  });
  try {
    const result = await scope.cleanup().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(cancellation.signal.aborted).toBe(true);
    expect(removed).toEqual([root]);
    expect(result).toBeInstanceOf(OwnedTestScopeCleanupError);
    expect((result as Error).message).toContain("some paths may already have been removed");
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("starts no further root deletion after cancellation observed at a real removal boundary", async () => {
  const cancellation = new AbortController();
  const removed: string[] = [];
  const scope = new OwnedTestScope(cancellation.signal, {
    onRootRemoved: (path) => {
      removed.push(path);
      cancellation.abort();
      return undefined;
    },
  });
  const [first, second] = await scope.run(async () => {
    const first = await scope.temporaryDirectory("flow-owned-partial-first-");
    const second = await scope.temporaryDirectory("flow-owned-partial-second-");
    await writeFile(join(first, "entry"), "remove");
    await writeFile(join(second, "entry"), "preserve");
    return [first, second] as const;
  });
  try {
    await expect(scope.cleanup()).rejects.toThrow("some paths may already have been removed");
    expect(removed).toEqual([first]);
    await expect(lstat(first)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(second, "entry"), "utf8")).toBe("preserve");
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

it("stops after a synchronous observer failure without substituting filesystem cleanup", async () => {
  const failure = new Error("removal observer failed");
  const removed: string[] = [];
  const scope = new OwnedTestScope(new AbortController().signal, {
    onRootRemoved: (path) => {
      removed.push(path);
      throw failure;
    },
  });
  const [first, second] = await scope.run(
    async () =>
      [
        await scope.temporaryDirectory("flow-owned-observer-first-"),
        await scope.temporaryDirectory("flow-owned-observer-second-"),
      ] as const,
  );
  try {
    await expect(scope.cleanup()).rejects.toBe(failure);
    expect(removed).toEqual([first]);
    await expect(lstat(first)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(second)).isDirectory()).toBe(true);
    await expect(scope.cleanup()).rejects.toBe(failure);
    expect(removed).toEqual([first]);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

it("retains a late allocation only in its original aborted scope", async () => {
  const cancellation = new AbortController();
  const scope = new OwnedTestScope(cancellation.signal, { settlementTimeoutMs: 20 });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const operation = scope.run(async () => {
    const allocating = scope.temporaryDirectory("flow-owned-late-");
    started();
    return await allocating;
  });
  await ready;
  cancellation.abort();
  await expect(scope.cleanup()).rejects.toBeInstanceOf(OwnedTestScopeCleanupError);
  const root = await operation;
  const next = new OwnedTestScope(new AbortController().signal);
  try {
    const nextRoot = await next.run(() => next.temporaryDirectory("flow-owned-next-"));
    await next.cleanup();
    await expect(lstat(nextRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(root)).isDirectory()).toBe(true);
    expect(scope.directories).toEqual([root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds the join without interrupting signal-independent postcondition work", async () => {
  const scope = new OwnedTestScope(new AbortController().signal, { settlementTimeoutMs: 20 });
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = scope.run(async () => {
    const root = await scope.temporaryDirectory("flow-owned-proof-");
    started();
    await barrier;
    // Deliberately ignores cancellation, as production's finally proof does.
    await writeFile(join(root, "postcondition"), "proved");
    return root;
  });
  await ready;
  const before = performance.now();
  await expect(scope.cleanup()).rejects.toBeInstanceOf(OwnedTestScopeCleanupError);
  expect(performance.now() - before).toBeLessThan(1_000);
  expect(scope.signal.aborted).toBe(true);
  release();
  const root = await operation;
  try {
    expect(await readFile(join(root, "postcondition"), "utf8")).toBe("proved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not delete a same-path replacement directory", async () => {
  const scope = new OwnedTestScope(new AbortController().signal);
  const root = await scope.run(() => scope.temporaryDirectory("flow-owned-identity-"));
  const moved = `${root}-moved`;
  await rename(root, moved);
  await mkdir(root);
  await writeFile(join(root, "replacement"), "preserve");
  try {
    await expect(scope.cleanup()).rejects.toBeInstanceOf(OwnedTestScopeCleanupError);
    expect(await readFile(join(root, "replacement"), "utf8")).toBe("preserve");
    expect((await lstat(moved)).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

it("does not follow a root symlink or delete its target", async () => {
  const scope = new OwnedTestScope(new AbortController().signal);
  const root = await scope.run(() => scope.temporaryDirectory("flow-owned-link-"));
  const target = await mkdtemp(join(tmpdir(), "flow-owned-target-"));
  const moved = `${root}-moved`;
  await rename(root, moved);
  await writeFile(join(target, "preserved"), "private");
  await symlink(target, root);
  try {
    await expect(scope.cleanup()).rejects.toBeInstanceOf(OwnedTestScopeCleanupError);
    expect((await lstat(root)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(target, "preserved"), "utf8")).toBe("private");
  } finally {
    await rm(root);
    await rm(moved, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

it("rejects traversal prefixes without creating or adopting arbitrary targets", async () => {
  const scope = new OwnedTestScope(new AbortController().signal);
  await scope.run(async () => {
    expect(() => scope.temporaryDirectory("../unsafe-")).toThrow("basename prefix");
    expect(() => scope.temporaryDirectory("/tmp/unsafe-")).toThrow("basename prefix");
  });
  expect(scope.directories).toEqual([]);
  await scope.cleanup();
});

it("does not start a callback whose context was already cancelled", async () => {
  const scope = new OwnedTestScope(AbortSignal.abort(new Error("cancelled")));
  await expect(
    scope.run(async () => {
      throw new Error("callback must not start");
    }),
  ).rejects.toThrow("cancelled");
  await expect(scope.cleanup()).rejects.toBeInstanceOf(OwnedTestScopeCleanupError);
});

it.each([0, -1, 2_001, Number.POSITIVE_INFINITY, 1.5])(
  "rejects invalid settlement grace %s",
  (settlementTimeoutMs) => {
    expect(() => new OwnedTestScope(new AbortController().signal, { settlementTimeoutMs })).toThrow(
      "settlement grace",
    );
  },
);

it("integrates with the real Vitest context without replacing its watchdog", async (context) => {
  expect(
    await runOwnedTest(context, async (scope) => {
      const root = await scope.temporaryDirectory("flow-owned-vitest-");
      await writeFile(join(root, "body"), "asserted");
      return await readFile(join(root, "body"), "utf8");
    }),
  ).toBe("asserted");
});

it("observes a late callback rejection after bounded retention", async () => {
  const scope = new OwnedTestScope(new AbortController().signal, { settlementTimeoutMs: 20 });
  let started!: () => void;
  let rejectBody!: (error: Error) => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const barrier = new Promise<never>((_resolve, reject) => {
    rejectBody = reject;
  });
  const operation = scope.run(async () => {
    started();
    return await barrier;
  });
  await ready;
  await expect(scope.cleanup()).rejects.toBeInstanceOf(OwnedTestScopeCleanupError);
  const failure = new Error("late original failure");
  rejectBody(failure);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect(operation).rejects.toBe(failure);
});

it(
  "adapts an ordinary callback with the real Vitest context",
  ownedTest(async (scope) => {
    expect(scope.signal.aborted).toBe(false);
    const root = await scope.temporaryDirectory("flow-owned-adapter-");
    expect((await lstat(root)).isDirectory()).toBe(true);
  }),
);

it.for(["typed-case"] as const)(
  "adapts case %s with the real Vitest context",
  { timeout: 5_000 },
  ownedTestCase(async (value: "typed-case", scope) => {
    expect(value).toBe("typed-case");
    expect(scope.signal.aborted).toBe(false);
    await scope.temporaryDirectory("flow-owned-case-");
  }),
);
