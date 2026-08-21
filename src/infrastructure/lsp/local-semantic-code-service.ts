import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { CommandSandbox, PreparedCommand } from "../../application/command-sandbox.js";
import type { NodeExecutionContext } from "../../application/ports.js";
import type { LanguageServerSnapshot } from "../../domain/capability/language-server.js";
import {
  createSemanticQueryReceipt,
  MAX_SEMANTIC_QUERY_RECEIPTS,
  MAX_SEMANTIC_RECEIPT_RESULT_BYTES,
  type SemanticQueryReceipt,
  type SemanticRequest,
  type SemanticResult,
} from "../../domain/semantic/semantic-code.js";
import { assertLocalLanguageServerCurrent } from "../fs/local-language-server.js";
import type { SemanticToolSessionFactory } from "../pi/pi-agent-executor.js";
import type { SemanticToolSession } from "../pi/workspace-agent-tools.js";
import { waitForProcessTreeExit } from "../process/command-node-executor.js";
import {
  runStrictLspQuery,
  StrictLspClientError,
  type StrictLspTransport,
} from "./strict-lsp-client.js";

export const MAX_SEMANTIC_PROJECT_ENTRIES = 4_096;
export const MAX_SEMANTIC_PROJECT_FILE_BYTES = 1024 * 1024;
export const MAX_SEMANTIC_PROJECT_BYTES = 16 * 1024 * 1024;
export const MAX_SEMANTIC_PROJECT_DEPTH = 32;
export const MAX_SEMANTIC_STDERR_BYTES = 64 * 1024;

const EXCLUDED_PROJECT_ENTRIES = new Set([".flow", ".git", "node_modules", "dist", "coverage"]);

export type LocalSemanticCodeServiceErrorCode =
  | "semantic_service_unavailable"
  | "semantic_operation_unsupported"
  | "semantic_request_invalid"
  | "semantic_source_changed"
  | "semantic_protocol_failed"
  | "semantic_deadline_exceeded"
  | "semantic_response_limit_exceeded"
  | "semantic_cleanup_uncertain";

export class LocalSemanticCodeServiceError extends Error {
  override readonly name = "LocalSemanticCodeServiceError";

  constructor(readonly code: LocalSemanticCodeServiceErrorCode) {
    super(
      code === "semantic_service_unavailable"
        ? "semantic language service is unavailable"
        : code === "semantic_operation_unsupported"
          ? "semantic operation is not supported"
          : code === "semantic_request_invalid"
            ? "semantic request is invalid"
            : code === "semantic_source_changed"
              ? "semantic project source changed during the query"
              : code === "semantic_protocol_failed"
                ? "semantic language-service protocol failed"
                : code === "semantic_deadline_exceeded"
                  ? "semantic language-service deadline was exceeded"
                  : code === "semantic_response_limit_exceeded"
                    ? "semantic response limit was exceeded"
                    : "semantic language-service cleanup is uncertain",
    );
  }
}

export interface LocalSemanticCodeServiceOptions {
  /** @internal Deterministic source-race seam. */
  readonly afterSnapshot?: () => void | Promise<void>;
  /** @internal Deterministic directory-race seam. */
  readonly afterProjectDirectoryObserved?: (path: string) => void | Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly terminationGraceMs?: number;
  readonly terminationConfirmationMs?: number;
  /** @internal Deterministic process-settlement seam. */
  readonly waitForExit?: typeof waitForProcessTreeExit;
}

interface ProjectSnapshot {
  readonly digest: string;
  readonly paths: readonly string[];
  readonly source: ReadonlyMap<string, Buffer>;
}

export function createLocalSemanticToolSessionFactory(
  sandbox: CommandSandbox,
  options: LocalSemanticCodeServiceOptions = {},
): SemanticToolSessionFactory {
  return ({ context, languageServer }) =>
    new LocalSemanticToolSession(sandbox, context, languageServer, options);
}

class LocalSemanticToolSession implements SemanticToolSession {
  readonly #receipts: SemanticQueryReceipt[] = [];

  constructor(
    private readonly sandbox: CommandSandbox,
    private readonly context: NodeExecutionContext,
    private readonly languageServer: LanguageServerSnapshot,
    private readonly options: LocalSemanticCodeServiceOptions,
  ) {}

  evidence(): readonly SemanticQueryReceipt[] {
    return Object.freeze([...this.#receipts]);
  }

  async query(request: SemanticRequest, signal?: AbortSignal): Promise<SemanticResult> {
    signal?.throwIfAborted();
    if (this.#receipts.length >= MAX_SEMANTIC_QUERY_RECEIPTS) {
      throw new LocalSemanticCodeServiceError("semantic_response_limit_exceeded");
    }
    const deadline = new AbortController();
    const deadlineReason = new LocalSemanticCodeServiceError("semantic_deadline_exceeded");
    const deadlineHandle = setTimeout(
      () => deadline.abort(deadlineReason),
      this.languageServer.requestTimeoutMs,
    );
    deadlineHandle.unref();
    const operationSignal =
      signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    let projectionRoot: string | undefined;
    let prepared: PreparedCommand | undefined;
    let primaryError: unknown;
    let result: SemanticResult | undefined;
    let pendingReceipt: SemanticQueryReceipt | undefined;
    try {
      const authoritativeRoot = resolve(this.context.cwd);
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(authoritativeRoot);
      } catch {
        operationSignal.throwIfAborted();
        throw new LocalSemanticCodeServiceError("semantic_source_changed");
      }
      operationSignal.throwIfAborted();
      if (canonicalRoot !== authoritativeRoot) {
        throw new LocalSemanticCodeServiceError("semantic_source_changed");
      }
      projectionRoot = await mkdtemp(join(tmpdir(), "flow-semantic-"));
      operationSignal.throwIfAborted();
      const before = await captureProject(
        authoritativeRoot,
        projectionRoot,
        operationSignal,
        this.options.afterProjectDirectoryObserved,
      );
      await this.options.afterSnapshot?.();
      operationSignal.throwIfAborted();
      const source = before.source.get(request.path);
      if (source === undefined) {
        throw new LocalSemanticCodeServiceError("semantic_source_changed");
      }
      try {
        await assertLocalLanguageServerCurrent(this.languageServer, operationSignal);
      } catch {
        operationSignal.throwIfAborted();
        throw new LocalSemanticCodeServiceError("semantic_service_unavailable");
      }
      prepared = await this.sandbox.prepare({
        executable: this.languageServer.executable.path,
        args: this.languageServer.args,
        cwd: projectionRoot,
        projectRoot: projectionRoot,
        protectedPaths: [projectionRoot],
        runtimeSupportPaths: [this.languageServer.executable.path],
        signal: operationSignal,
      });
      if (prepared.run !== undefined) {
        throw new LocalSemanticCodeServiceError("semantic_service_unavailable");
      }
      await prepared.beforeLaunch?.();
      operationSignal.throwIfAborted();
      result = await runProcessSession(
        prepared,
        projectionRoot,
        this.languageServer,
        before.paths,
        request,
        source,
        signal,
        deadline.signal,
        deadlineReason,
        operationSignal,
        this.options,
      );
      const after = await captureProject(authoritativeRoot, undefined, operationSignal);
      if (after.digest !== before.digest) {
        throw new LocalSemanticCodeServiceError("semantic_source_changed");
      }
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_SEMANTIC_RECEIPT_RESULT_BYTES) {
        throw new LocalSemanticCodeServiceError("semantic_response_limit_exceeded");
      }
      pendingReceipt = createSemanticQueryReceipt({
        sequence: this.#receipts.length + 1,
        request,
        projectDigest: before.digest,
        sourceDigest: sha256(source),
        languageServerDigest: this.languageServer.digest,
        sandbox: prepared.evidence,
        result,
      });
    } catch (error) {
      primaryError = error;
    }

    let cleanupFailed = false;
    if (prepared !== undefined) {
      try {
        await prepared.release();
      } catch {
        cleanupFailed = true;
      }
    }
    if (projectionRoot !== undefined) {
      try {
        await rm(projectionRoot, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        cleanupFailed = true;
      }
    }
    clearTimeout(deadlineHandle);
    if (cleanupFailed) {
      throw new LocalSemanticCodeServiceError("semantic_cleanup_uncertain");
    }
    const normalizedPrimaryError =
      primaryError === undefined ? undefined : normalizeServiceError(primaryError);
    if (
      normalizedPrimaryError instanceof LocalSemanticCodeServiceError &&
      normalizedPrimaryError.code === "semantic_cleanup_uncertain"
    ) {
      throw normalizedPrimaryError;
    }
    signal?.throwIfAborted();
    if (deadline.signal.aborted) {
      throw deadlineReason;
    }
    if (normalizedPrimaryError !== undefined) {
      throw normalizedPrimaryError;
    }
    if (result === undefined || pendingReceipt === undefined) {
      throw new LocalSemanticCodeServiceError("semantic_protocol_failed");
    }
    this.#receipts.push(pendingReceipt);
    return result;
  }
}

async function runProcessSession(
  prepared: PreparedCommand,
  cwd: string,
  languageServer: LanguageServerSnapshot,
  projectPaths: readonly string[],
  request: SemanticRequest,
  source: Buffer,
  callerSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
  deadlineReason: LocalSemanticCodeServiceError,
  operationSignal: AbortSignal,
  options: LocalSemanticCodeServiceOptions,
): Promise<SemanticResult> {
  let child: ChildProcess;
  try {
    child = spawn(prepared.launch.executable, [...prepared.launch.args], {
      cwd,
      env: prepared.launch.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw new LocalSemanticCodeServiceError("semantic_service_unavailable");
  }
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    child.kill("SIGKILL");
    throw new LocalSemanticCodeServiceError("semantic_service_unavailable");
  }
  const protocolAbort = new AbortController();
  const exitSignal = AbortSignal.any([operationSignal, protocolAbort.signal]);
  const exitPromise = (options.waitForExit ?? waitForProcessTreeExit)(
    child,
    languageServer.requestTimeoutMs,
    options.terminationGraceMs ?? 2_000,
    exitSignal,
    options.platform ?? process.platform,
    options.terminationConfirmationMs ?? 2_000,
    true,
  );
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > MAX_SEMANTIC_STDERR_BYTES && !protocolAbort.signal.aborted) {
      protocolAbort.abort(new LocalSemanticCodeServiceError("semantic_response_limit_exceeded"));
    }
  });
  const transport = new NodeLspTransport(child);
  let result: SemanticResult | undefined;
  let queryError: unknown;
  try {
    result = await runStrictLspQuery({
      transport,
      languageServer,
      projectRoot: cwd,
      projectPaths,
      source: { path: request.path, content: source },
      request,
      signal: operationSignal,
    });
  } catch (error) {
    queryError = error;
    if (!protocolAbort.signal.aborted) {
      protocolAbort.abort(error);
    }
  }
  const exit = await exitPromise;
  if (exit.terminationIncomplete) {
    throw new LocalSemanticCodeServiceError("semantic_cleanup_uncertain");
  }
  if (callerSignal?.aborted === true) {
    throw callerSignal.reason;
  }
  if (deadlineSignal.aborted || exit.timedOut) {
    throw deadlineReason;
  }
  if (protocolAbort.signal.reason instanceof LocalSemanticCodeServiceError) {
    throw protocolAbort.signal.reason;
  }
  if (queryError !== undefined) {
    throw queryError;
  }
  if (
    result === undefined ||
    exit.spawnError !== null ||
    exit.exitCode !== 0 ||
    exit.signal !== null
  ) {
    throw new LocalSemanticCodeServiceError("semantic_protocol_failed");
  }
  return result;
}

export class NodeLspTransport implements StrictLspTransport {
  readonly #iterator;

  constructor(private readonly child: ChildProcess) {
    if (child.stdout === null) {
      throw new LocalSemanticCodeServiceError("semantic_service_unavailable");
    }
    this.#iterator = child.stdout[Symbol.asyncIterator]();
  }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const input = this.child.stdin;
    if (input === null || input.destroyed) {
      throw new LocalSemanticCodeServiceError("semantic_protocol_failed");
    }
    await waitForAbortable(
      new Promise<void>((resolveWrite, rejectWrite) => {
        input.write(bytes, (error: Error | null | undefined) => {
          if (error === null || error === undefined) {
            resolveWrite();
          } else {
            rejectWrite(new LocalSemanticCodeServiceError("semantic_protocol_failed"));
          }
        });
      }),
      signal,
    );
    signal?.throwIfAborted();
  }

  async read(signal?: AbortSignal): Promise<Uint8Array | null> {
    signal?.throwIfAborted();
    const next = await waitForAbortable(this.#iterator.next(), signal);
    signal?.throwIfAborted();
    return next.done === true ? null : Buffer.from(next.value);
  }
}

async function waitForAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => settle(() => rejectPromise(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void promise.then(
      (value) => settle(() => resolvePromise(value)),
      (error: unknown) => settle(() => rejectPromise(error)),
    );
  });
}

async function captureProject(
  root: string,
  projectionRoot: string | undefined,
  signal?: AbortSignal,
  afterDirectoryObserved?: ((path: string) => void | Promise<void>) | undefined,
): Promise<ProjectSnapshot> {
  const entries: Array<{ readonly path: string; readonly sha256: string; readonly bytes: number }> =
    [];
  const source = new Map<string, Buffer>();
  const directories: string[] = [];
  let totalBytes = 0;
  let entryCount = 0;

  async function visit(directory: string, provenance: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    if (depth > MAX_SEMANTIC_PROJECT_DEPTH) {
      throw new LocalSemanticCodeServiceError("semantic_response_limit_exceeded");
    }
    const directoryIdentity = await observeProjectDirectory(directory, signal);
    await afterDirectoryObserved?.(directory);
    signal?.throwIfAborted();
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(directory);
      signal?.throwIfAborted();
    } catch {
      signal?.throwIfAborted();
      throw new LocalSemanticCodeServiceError("semantic_source_changed");
    }
    signal?.throwIfAborted();
    try {
      for await (const entry of handle) {
        signal?.throwIfAborted();
        if (isExcludedProjectEntry(entry.name)) {
          continue;
        }
        entryCount += 1;
        if (entryCount > MAX_SEMANTIC_PROJECT_ENTRIES) {
          throw new LocalSemanticCodeServiceError("semantic_response_limit_exceeded");
        }
        const path = join(directory, entry.name);
        const portablePath = provenance === "" ? entry.name : `${provenance}/${entry.name}`;
        if (!isPortablePath(portablePath)) {
          throw new LocalSemanticCodeServiceError("semantic_source_changed");
        }
        if (entry.isDirectory()) {
          directories.push(portablePath);
          await visit(path, portablePath, depth + 1);
        } else if (entry.isFile()) {
          const file = await readStableProjectFile(path, signal);
          totalBytes += file.byteLength;
          if (totalBytes > MAX_SEMANTIC_PROJECT_BYTES) {
            throw new LocalSemanticCodeServiceError("semantic_response_limit_exceeded");
          }
          entries.push({ path: portablePath, sha256: sha256(file), bytes: file.byteLength });
          source.set(portablePath, file);
        } else {
          throw new LocalSemanticCodeServiceError("semantic_source_changed");
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
      signal?.throwIfAborted();
    }
    const revalidatedDirectory = await observeProjectDirectory(directory, signal);
    if (!sameIdentity(directoryIdentity, revalidatedDirectory)) {
      throw new LocalSemanticCodeServiceError("semantic_source_changed");
    }
  }

  await visit(root, "", 1);
  entries.sort((left, right) => compareStrings(left.path, right.path));
  if (projectionRoot !== undefined) {
    for (const directory of directories.sort(compareStrings)) {
      signal?.throwIfAborted();
      await mkdir(join(projectionRoot, directory), { recursive: true, mode: 0o700 });
      signal?.throwIfAborted();
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      const content = source.get(entry.path);
      if (content === undefined) {
        throw new LocalSemanticCodeServiceError("semantic_source_changed");
      }
      await mkdir(dirname(join(projectionRoot, entry.path)), { recursive: true, mode: 0o700 });
      signal?.throwIfAborted();
      await writeFile(join(projectionRoot, entry.path), content, { mode: 0o400, flag: "wx" });
      signal?.throwIfAborted();
    }
  }
  return {
    digest: sha256(JSON.stringify(entries)),
    paths: Object.freeze(entries.map((entry) => entry.path)),
    source,
  };
}

async function observeProjectDirectory(path: string, signal?: AbortSignal): Promise<BigIntStats> {
  signal?.throwIfAborted();
  try {
    const [canonicalPath, identity] = await Promise.all([
      realpath(path),
      lstat(path, { bigint: true }),
    ]);
    signal?.throwIfAborted();
    if (canonicalPath !== path || !identity.isDirectory() || identity.isSymbolicLink()) {
      throw new LocalSemanticCodeServiceError("semantic_source_changed");
    }
    return identity;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LocalSemanticCodeServiceError) throw error;
    throw new LocalSemanticCodeServiceError("semantic_source_changed");
  }
}

async function readStableProjectFile(path: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_SEMANTIC_PROJECT_FILE_BYTES)
    ) {
      throw new LocalSemanticCodeServiceError("semantic_response_limit_exceeded");
    }
    const content = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (offset !== content.byteLength || !sameIdentity(before, after)) {
      throw new LocalSemanticCodeServiceError("semantic_source_changed");
    }
    return content;
  } finally {
    await handle.close().catch(() => undefined);
    signal?.throwIfAborted();
  }
}

function normalizeServiceError(error: unknown): Error {
  if (error instanceof LocalSemanticCodeServiceError) return error;
  if (error instanceof StrictLspClientError) {
    return new LocalSemanticCodeServiceError(error.code);
  }
  return new LocalSemanticCodeServiceError("semantic_protocol_failed");
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isPortablePath(value: string): boolean {
  return (
    value === value.normalize("NFC") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function isExcludedProjectEntry(name: string): boolean {
  return (
    EXCLUDED_PROJECT_ENTRIES.has(name) ||
    name === ".flow-workspaces" ||
    (name.startsWith(".") && name.endsWith(".flow-workspaces") && name.length > 17)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
