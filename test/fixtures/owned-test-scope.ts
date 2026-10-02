import { constants } from "node:fs";
import { type FileHandle, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "vitest";

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface OwnedDirectory {
  readonly path: string;
  readonly parent: string;
  readonly parentIdentity: Identity;
  handle?: FileHandle;
  identity?: Identity;
}

export interface OwnedTestScopeOptions {
  /**
   * Settlement grace only, not a new test watchdog. Defaults to 1000 ms, capped at
   * 2000 ms to leave headroom in these tests' existing hook budget. Filesystem
   * cleanup is not launched at all after an uncertain join.
   */
  readonly settlementTimeoutMs?: number;
  /**
   * Synchronous test-only observation after a real root removal, before the next
   * cancellation check. Cannot replace I/O. Throwing stops further cleanup.
   */
  readonly onRootRemoved?: (path: string) => undefined;
}

export class OwnedTestScopeCleanupError extends Error {
  constructor(readonly directories: readonly string[]) {
    super(
      `Owned test cleanup incomplete; some paths may already have been removed. Owned directory inventory: ${directories.join(", ")}`,
    );
    this.name = "OwnedTestScopeCleanupError";
  }
}

/**
 * Owns the original callback, not Vitest's timeout wrapper. Callbacks must await their
 * work, including child close/production settlement; this cannot prove arbitrary
 * descendants quiescent. Once an abort is observed, no further root removal starts.
 * An already-admitted filesystem removal cannot be cancelled and may finish; an
 * incomplete cleanup reports an ownership inventory, not a promise all paths remain.
 */
export class OwnedTestScope {
  readonly #controller = new AbortController();
  readonly #contextSignal: AbortSignal;
  readonly #timeoutMs: number;
  readonly #onRootRemoved: OwnedTestScopeOptions["onRootRemoved"];
  readonly #directories: OwnedDirectory[] = [];
  readonly #allocations: Promise<void>[] = [];
  #body: Promise<void> | undefined;
  #bodySettled = false;
  #closing = false;
  #retained = false;
  #cleanup: Promise<void> | undefined;
  #cleanupFinished = false;

  constructor(signal: AbortSignal, options: OwnedTestScopeOptions = {}) {
    const timeoutMs = options.settlementTimeoutMs ?? 1_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_000) {
      throw new Error("Owned test settlement grace must be between 1 and 2000 milliseconds");
    }
    this.#timeoutMs = timeoutMs;
    this.#onRootRemoved = options.onRootRemoved;
    this.#contextSignal = signal;
    signal.addEventListener("abort", this.#abort, { once: true });
    if (signal.aborted) this.#abort();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Includes allocations that finish after a bounded cleanup has returned. */
  get directories(): readonly string[] {
    return Object.freeze(this.#directories.map(({ path }) => path));
  }

  run<T>(body: (scope: OwnedTestScope) => Promise<T>): Promise<T> {
    if (this.#body !== undefined || this.#closing)
      throw new Error("Owned test scope is single-use");
    const result = Promise.resolve().then(() => {
      this.signal.throwIfAborted();
      return body(this);
    });
    // Observe rejection immediately, without converting the result returned to the test.
    this.#body = result.then(
      () => {
        this.#bodySettled = true;
      },
      () => {
        this.#bodySettled = true;
      },
    );
    return result;
  }

  temporaryDirectory(prefix: string): Promise<string> {
    if (this.#body === undefined || this.#bodySettled || this.#closing) {
      throw new Error("Temporary directories require an active owned callback");
    }
    this.signal.throwIfAborted();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}-$/.test(prefix)) {
      throw new Error("Expected a bounded temporary-directory basename prefix");
    }
    const allocation = this.#allocate(prefix);
    this.#allocations.push(
      allocation.then(
        () => undefined,
        () => {
          this.#retained = true;
        },
      ),
    );
    return allocation;
  }

  cleanup(): Promise<void> {
    this.#closing = true;
    this.#cleanup ??= this.#finish();
    return this.#cleanup;
  }

  readonly #abort = (): void => {
    this.#retained = true;
    this.#controller.abort(this.#contextSignal.reason ?? new Error("Owned test cancelled"));
  };

  async #allocate(prefix: string): Promise<string> {
    const parent = await realpath(tmpdir());
    const parentIdentity = await lstat(parent, { bigint: true });
    if (!parentIdentity.isDirectory()) throw new Error("Temporary parent is not a directory");
    const path = await mkdtemp(join(parent, prefix));
    const directory: OwnedDirectory = { path, parent, parentIdentity };
    this.#directories.push(directory);
    try {
      directory.handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const identity = await directory.handle.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      if (!identity.isDirectory() || !named.isDirectory() || !sameIdentity(identity, named)) {
        throw new Error("Temporary directory identity changed during creation");
      }
      directory.identity = identity;
      return path;
    } finally {
      // A late allocation belongs only to this retained scope, never the next test.
      if (this.#cleanupFinished) await this.#close(directory);
    }
  }

  async #finish(): Promise<void> {
    if (!this.#bodySettled && this.#body !== undefined) this.#abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failures: unknown[] = [];
    try {
      const settled = await Promise.race([
        Promise.all([this.#body, ...this.#allocations]).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.#timeoutMs);
        }),
      ]);
      if (!settled) this.#retained = true;
      if (this.#retained) throw new OwnedTestScopeCleanupError(this.directories);
      // Check every root before deleting any. Only mkdtemp-created immediate children
      // of the canonical temporary directory can enter this collection.
      for (const directory of this.#directories) await this.#assertIdentity(directory);
      for (const directory of this.#directories) {
        await this.#assertIdentity(directory);
        if (this.#retained) throw new OwnedTestScopeCleanupError(this.directories);
        await rm(directory.path, { recursive: true, force: true, maxRetries: 0 });
        this.#onRootRemoved?.(directory.path);
        if (this.#retained) throw new OwnedTestScopeCleanupError(this.directories);
      }
    } catch (error) {
      this.#retained = true;
      failures.push(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#contextSignal.removeEventListener("abort", this.#abort);
      this.#cleanupFinished = true;
      const closes = await Promise.allSettled(
        this.#directories.map((directory) => this.#close(directory)),
      );
      for (const close of closes) {
        if (close.status === "rejected") failures.push(close.reason);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Owned test cleanup failed");
  }

  async #assertIdentity(directory: OwnedDirectory): Promise<void> {
    const named = await lstat(directory.path, { bigint: true });
    const parent = await lstat(directory.parent, { bigint: true });
    if (
      directory.identity === undefined ||
      directory.handle === undefined ||
      !named.isDirectory() ||
      !parent.isDirectory() ||
      !sameIdentity(named, directory.identity) ||
      !sameIdentity(parent, directory.parentIdentity) ||
      dirname(directory.path) !== directory.parent ||
      (await realpath(directory.path)) !== directory.path ||
      !sameIdentity(await directory.handle.stat({ bigint: true }), directory.identity)
    )
      throw new OwnedTestScopeCleanupError(this.directories);
  }

  async #close(directory: OwnedDirectory): Promise<void> {
    const handle = directory.handle;
    delete directory.handle;
    if (handle !== undefined) await handle.close();
  }
}

/**
 * Use inside an ordinary Vitest callback (or it.for callback with its real context).
 * Do not call context.skip() dynamically: Vitest does not run onTestFinished then.
 * Keep all fixture setup, operations, and assertions inside body.
 */
export function runOwnedTest<T>(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  body: (scope: OwnedTestScope) => Promise<T>,
  options?: OwnedTestScopeOptions,
): Promise<T> {
  const scope = new OwnedTestScope(context.signal, options);
  context.onTestFinished(() => scope.cleanup());
  return scope.run(body);
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Preserves Vitest's own test registration and watchdog. */
export function ownedTest(
  body: (scope: OwnedTestScope) => Promise<void>,
): (context: TestContext) => Promise<void> {
  return (context) => runOwnedTest(context, body);
}

/** Use with it.for, whose public callback supplies the case value and context. */
export function ownedTestCase<T>(
  body: (value: T, scope: OwnedTestScope) => Promise<void>,
): (value: T, context: TestContext) => Promise<void> {
  return (value, context) => runOwnedTest(context, (scope) => body(value, scope));
}
