import { createHash } from "node:crypto";
import { constants, realpathSync, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type {
  CandidateDelta,
  CandidatePromotionLifecycle,
  CandidatePromotionRequest,
  CandidatePromotionSettlement,
  CandidateWorkspaceManager,
  IsolatedWorkspace,
  WorkspaceIsolator,
} from "../../application/ports.js";
import {
  DEFAULT_MAX_CANDIDATE_DELTA_BYTES,
  DEFAULT_MAX_CANDIDATE_DELTA_ENTRIES,
  DEFAULT_MAX_WORKSPACE_BYTES,
  DEFAULT_MAX_WORKSPACE_ENTRIES,
  ReflinkCopyWorkspaceIsolator,
  WorkspaceIsolationError,
} from "../fs/reflink-copy-workspace-isolator.js";

const MAX_MIGRATION_ENTRIES =
  DEFAULT_MAX_WORKSPACE_ENTRIES + DEFAULT_MAX_CANDIDATE_DELTA_ENTRIES + 1_024;
const MAX_MIGRATION_BYTES =
  DEFAULT_MAX_WORKSPACE_BYTES + DEFAULT_MAX_CANDIDATE_DELTA_BYTES + 64 * 1024 * 1024;

interface WorkspaceRequest {
  readonly workspaceId: string;
  readonly sourceCwd: string;
  readonly excludedPaths?: readonly string[];
  readonly legacySourceCwd?: string;
}

interface RoutedWorkspaceRequest<Request extends WorkspaceRequest> {
  readonly manager: ReflinkCopyWorkspaceIsolator;
  readonly request: Request;
  readonly relocatedFromCwd?: string;
}

export function createProductionWorkspaceIsolator(
  runsDirectory: string,
  _protectedPaths: readonly string[] = [],
  executionRoot?: string,
  projectRoot?: string,
): WorkspaceIsolator & CandidateWorkspaceManager {
  return new ProductionWorkspaceIsolator(runsDirectory, executionRoot, projectRoot);
}

class ProductionWorkspaceIsolator implements WorkspaceIsolator, CandidateWorkspaceManager {
  readonly #runsDirectory: string;
  readonly #baseDirectory: string;
  readonly #collectionDirectory: string;
  readonly #collectionParent: string;
  readonly #current: ReflinkCopyWorkspaceIsolator;
  readonly #legacy: ReflinkCopyWorkspaceIsolator;
  readonly #legacyBaseDirectory: string;
  readonly #privateCollection: boolean;

  constructor(
    runsDirectory: string,
    executionRoot: string | undefined,
    projectRoot: string | undefined,
  ) {
    this.#runsDirectory = canonicalPotentialPath(runsDirectory);
    const executionBoundary =
      projectRoot === undefined
        ? executionRoot === undefined
          ? undefined
          : realpathSync(executionRoot)
        : realpathSync(projectRoot);
    const stateDirectory = dirname(this.#runsDirectory);
    const fallbackParent =
      basename(stateDirectory) === ".flow" ? dirname(stateDirectory) : stateDirectory;
    this.#privateCollection = executionBoundary !== undefined;
    this.#collectionParent =
      executionBoundary === undefined ? fallbackParent : dirname(executionBoundary);
    this.#collectionDirectory =
      executionBoundary === undefined
        ? join(this.#collectionParent, ".flow-workspaces")
        : join(this.#collectionParent, `.${basename(executionBoundary)}.flow-workspaces`);
    const identity = createHash("sha256").update(this.#runsDirectory).digest("hex").slice(0, 24);
    this.#baseDirectory = join(this.#collectionDirectory, identity);
    this.#legacyBaseDirectory = join(this.#runsDirectory, ".workspaces");
    this.#current = new ReflinkCopyWorkspaceIsolator(this.#baseDirectory);
    this.#legacy = new ReflinkCopyWorkspaceIsolator(this.#legacyBaseDirectory);
  }

  async create(request: WorkspaceRequest): Promise<IsolatedWorkspace> {
    await this.#prepareCurrentStorage();
    const workspace = await this.#current.create(this.#currentRequest(request));
    await this.#verifyCurrentStorage();
    return workspace;
  }

  async reopen(request: WorkspaceRequest): Promise<IsolatedWorkspace> {
    const routed = await this.#route(request);
    const workspace = await routed.manager.reopen(routed.request);
    return Object.freeze({
      ...workspace,
      ...(routed.relocatedFromCwd === undefined
        ? {}
        : { relocatedFromCwd: routed.relocatedFromCwd }),
    });
  }

  async captureCandidateDelta(
    request: WorkspaceRequest & { readonly expectedSnapshotDigest: string },
  ): Promise<CandidateDelta> {
    const routed = await this.#route(request);
    return await routed.manager.captureCandidateDelta(routed.request);
  }

  async promoteCandidateDelta(
    request: CandidatePromotionRequest,
    lifecycle: CandidatePromotionLifecycle,
  ): Promise<CandidatePromotionSettlement> {
    const routed = await this.#route(request);
    return await routed.manager.promoteCandidateDelta(routed.request, lifecycle);
  }

  async reconcileCandidatePromotion(
    request: CandidatePromotionRequest,
  ): Promise<CandidatePromotionSettlement> {
    const routed = await this.#route(request);
    return await routed.manager.reconcileCandidatePromotion(routed.request);
  }

  async cleanup(workspaceId: string): Promise<"discarded"> {
    await this.#prepareCurrentStorage();
    await this.#current.cleanup(workspaceId);
    await this.#verifyCurrentStorage();
    await this.#legacy.cleanup(workspaceId);
    return "discarded";
  }

  async #route<Request extends WorkspaceRequest>(
    request: Request,
  ): Promise<RoutedWorkspaceRequest<Request>> {
    await this.#prepareCurrentStorage();
    const currentRequest = this.#currentRequest(request);
    try {
      await this.#current.reopen(currentRequest);
      await this.#verifyCurrentStorage();
      return { manager: this.#current, request: currentRequest };
    } catch (error) {
      if (!workspaceIsMissingOrMismatch(error)) {
        throw error;
      }
    }

    const legacyRequest = this.#legacyRequest(request);
    const relocatedFromCwd = workspaceCwd(this.#legacyBaseDirectory, request.workspaceId);
    try {
      await this.#current.reopen(legacyRequest);
      await this.#verifyCurrentStorage();
      return { manager: this.#current, request: legacyRequest, relocatedFromCwd };
    } catch (error) {
      if (!workspaceIsMissing(error)) {
        throw error;
      }
    }

    await this.#migrateLegacyWorkspace(legacyRequest);
    await this.#current.reopen(legacyRequest);
    await this.#verifyCurrentStorage();
    return { manager: this.#current, request: legacyRequest, relocatedFromCwd };
  }

  async #migrateLegacyWorkspace<Request extends WorkspaceRequest>(request: Request): Promise<void> {
    await this.#legacy.reopen(request);
    await requireRealDirectory(this.#legacyBaseDirectory, "legacy workspace storage");
    const source = workspaceIdentityDirectory(this.#legacyBaseDirectory, request.workspaceId);
    const target = workspaceIdentityDirectory(this.#baseDirectory, request.workspaceId);
    await requireRealDirectory(source, "legacy workspace identity");
    try {
      await lstat(target);
      throw new WorkspaceIsolationError(
        "workspace_mismatch",
        `isolated workspace "${request.workspaceId}" has conflicting current and legacy storage`,
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    try {
      await rename(source, target);
      await Promise.all([
        syncDirectory(this.#legacyBaseDirectory),
        syncDirectory(this.#baseDirectory),
      ]);
    } catch (error) {
      if (isNodeError(error) && error.code === "EXDEV") {
        await copyLegacyWorkspaceIdentity(
          source,
          target,
          this.#baseDirectory,
          this.#legacyBaseDirectory,
          request.workspaceId,
        );
        return;
      }
      if (error instanceof WorkspaceIsolationError) {
        throw error;
      }
      throw new WorkspaceIsolationError(
        "source_invalid",
        `could not move legacy workspace "${request.workspaceId}" to private storage`,
        { cause: error },
      );
    }
  }

  async #prepareCurrentStorage(): Promise<void> {
    if (!this.#privateCollection) {
      await mkdir(this.#collectionDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.#collectionDirectory, 0o700);
      await mkdir(this.#baseDirectory, { mode: 0o700 }).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      });
      return;
    }
    await requireRealDirectory(this.#collectionParent, "workspace collection parent");
    await ensurePrivateDirectory(
      this.#collectionDirectory,
      this.#collectionParent,
      "workspace collection",
    );
    await ensurePrivateDirectory(this.#baseDirectory, this.#collectionDirectory, "workspace owner");
  }

  async #verifyCurrentStorage(): Promise<void> {
    if (!this.#privateCollection) {
      return;
    }
    await requireRealDirectory(this.#collectionParent, "workspace collection parent");
    await requireRealDirectory(this.#collectionDirectory, "workspace collection");
    await requireRealDirectory(this.#baseDirectory, "workspace owner");
  }

  #currentRequest<Request extends WorkspaceRequest>(request: Request): Request {
    return {
      ...request,
      excludedPaths: [...(request.excludedPaths ?? []), this.#collectionDirectory],
    };
  }

  #legacyRequest<Request extends WorkspaceRequest>(request: Request): Request {
    const currentSource = resolve(request.sourceCwd);
    const fromCurrentBase = relative(this.#baseDirectory, currentSource);
    const isNestedSource =
      fromCurrentBase !== "" && fromCurrentBase !== ".." && !fromCurrentBase.startsWith(`..${sep}`);
    return {
      ...request,
      excludedPaths: isNestedSource ? [] : [this.#runsDirectory],
      legacySourceCwd: isNestedSource
        ? resolve(this.#legacyBaseDirectory, fromCurrentBase)
        : currentSource,
    };
  }
}

interface MigrationTreeState {
  entries: number;
  bytes: number;
  readonly digest: ReturnType<typeof createHash>;
}

function canonicalPotentialPath(path: string): string {
  let current = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...missingSegments);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`workspace storage path cannot be resolved: ${path}`);
    }
    missingSegments.unshift(basename(current));
    current = parent;
  }
}

export async function copyLegacyWorkspaceIdentity(
  source: string,
  target: string,
  targetBase: string,
  sourceBase: string,
  workspaceId: string,
): Promise<void> {
  const staging = join(targetBase, `.${workspaceId}.migration`);
  await retireMigrationStaging(staging);
  const sourceBefore = await observeMigrationTree(source);
  try {
    await mkdir(staging, { mode: 0o700 });
    const copyState: MigrationTreeState = {
      entries: 0,
      bytes: 0,
      digest: createHash("sha256"),
    };
    await copyMigrationDirectory(source, staging, "", copyState);
    await syncDirectory(staging);
    const [sourceAfter, targetObservation] = await Promise.all([
      observeMigrationTree(source),
      observeMigrationTree(staging),
    ]);
    if (sourceBefore !== sourceAfter || sourceBefore !== targetObservation) {
      throw new WorkspaceIsolationError(
        "source_changed",
        `legacy workspace "${workspaceId}" changed during cross-filesystem migration`,
      );
    }
    await rename(staging, target);
    await syncDirectory(targetBase);
    await rm(source, { recursive: true });
    await syncDirectory(sourceBase);
  } catch (error) {
    await retireMigrationStaging(staging).catch(() => undefined);
    if (error instanceof WorkspaceIsolationError) {
      throw error;
    }
    throw new WorkspaceIsolationError(
      "source_invalid",
      `could not copy legacy workspace "${workspaceId}" to private storage`,
      { cause: error },
    );
  }
}

async function retireMigrationStaging(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  await requireRealDirectory(path, "workspace migration staging directory");
  await rm(path, { recursive: true });
  await syncDirectory(dirname(path));
}

async function copyMigrationDirectory(
  source: string,
  target: string,
  relativeDirectory: string,
  state: MigrationTreeState,
): Promise<void> {
  const directory = await opendir(source);
  const names: string[] = [];
  for await (const entry of directory) {
    names.push(entry.name);
  }
  names.sort((left, right) => left.localeCompare(right, "en"));
  for (const name of names) {
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    const metadata = await lstat(sourcePath);
    state.entries += 1;
    assertMigrationLimits(state);
    if (metadata.isDirectory()) {
      state.digest.update(`directory\0${relativePath}\0${metadata.mode & 0o777}\0`);
      await mkdir(targetPath, { mode: metadata.mode & 0o777 });
      await chmod(targetPath, metadata.mode & 0o777);
      await copyMigrationDirectory(sourcePath, targetPath, relativePath, state);
      await syncDirectory(targetPath);
      continue;
    }
    if (metadata.isSymbolicLink()) {
      const linkTarget = await readlink(sourcePath);
      state.digest.update(`symlink\0${relativePath}\0${linkTarget}\0`);
      await symlink(linkTarget, targetPath);
      continue;
    }
    if (!metadata.isFile()) {
      throw new WorkspaceIsolationError(
        "unsupported_entry",
        `legacy workspace entry "${relativePath}" is not supported`,
      );
    }
    state.bytes += metadata.size;
    assertMigrationLimits(state);
    const fileDigest = await copyMigrationFile(
      sourcePath,
      targetPath,
      metadata.size,
      metadata.mode & 0o777,
    );
    state.digest.update(
      `file\0${relativePath}\0${metadata.mode & 0o777}\0${metadata.size}\0${fileDigest}\0`,
    );
  }
}

async function copyMigrationFile(
  source: string,
  target: string,
  size: number,
  mode: number,
): Promise<string> {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.size !== size) {
      throw new WorkspaceIsolationError("source_changed", "legacy workspace file changed");
    }
    targetHandle = await open(target, "wx", 0o600);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < size) {
      const requested = Math.min(buffer.length, size - position);
      const result = await sourceHandle.read(buffer, 0, requested, position);
      if (result.bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, result.bytesRead);
      digest.update(chunk);
      await targetHandle.write(chunk, 0, chunk.length, position);
      position += chunk.length;
    }
    const after = await sourceHandle.stat();
    if (position !== size || !sameFileIdentity(before, after)) {
      throw new WorkspaceIsolationError("source_changed", "legacy workspace file changed");
    }
    await targetHandle.chmod(mode);
    await targetHandle.sync();
    return digest.digest("hex");
  } finally {
    await targetHandle?.close().catch(() => undefined);
    await sourceHandle.close();
  }
}

async function observeMigrationTree(root: string): Promise<string> {
  const state: MigrationTreeState = {
    entries: 0,
    bytes: 0,
    digest: createHash("sha256"),
  };
  await observeMigrationDirectory(root, "", state);
  return state.digest.digest("hex");
}

async function observeMigrationDirectory(
  directoryPath: string,
  relativeDirectory: string,
  state: MigrationTreeState,
): Promise<void> {
  const directory = await opendir(directoryPath);
  const names: string[] = [];
  for await (const entry of directory) {
    names.push(entry.name);
  }
  names.sort((left, right) => left.localeCompare(right, "en"));
  for (const name of names) {
    const path = join(directoryPath, name);
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    const metadata = await lstat(path);
    state.entries += 1;
    assertMigrationLimits(state);
    if (metadata.isDirectory()) {
      state.digest.update(`directory\0${relativePath}\0${metadata.mode & 0o777}\0`);
      await observeMigrationDirectory(path, relativePath, state);
      continue;
    }
    if (metadata.isSymbolicLink()) {
      state.digest.update(`symlink\0${relativePath}\0${await readlink(path)}\0`);
      continue;
    }
    if (!metadata.isFile()) {
      throw new WorkspaceIsolationError(
        "unsupported_entry",
        `legacy workspace entry "${relativePath}" is not supported`,
      );
    }
    state.bytes += metadata.size;
    assertMigrationLimits(state);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== metadata.size) {
        throw new WorkspaceIsolationError("source_changed", "legacy workspace file changed");
      }
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < before.size) {
        const result = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - position),
          position,
        );
        if (result.bytesRead === 0) {
          break;
        }
        digest.update(buffer.subarray(0, result.bytesRead));
        position += result.bytesRead;
      }
      const after = await handle.stat();
      if (position !== before.size || !sameFileIdentity(before, after)) {
        throw new WorkspaceIsolationError("source_changed", "legacy workspace file changed");
      }
      state.digest.update(
        `file\0${relativePath}\0${metadata.mode & 0o777}\0${metadata.size}\0${digest.digest("hex")}\0`,
      );
    } finally {
      await handle.close();
    }
  }
}

function assertMigrationLimits(state: MigrationTreeState): void {
  if (state.entries > MAX_MIGRATION_ENTRIES || state.bytes > MAX_MIGRATION_BYTES) {
    throw new WorkspaceIsolationError(
      "snapshot_limit_exceeded",
      "legacy workspace migration exceeds its entry or byte limit",
    );
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function ensurePrivateDirectory(path: string, parent: string, label: string): Promise<void> {
  if (dirname(path) !== parent) {
    throw new WorkspaceIsolationError("source_invalid", `${label} has an invalid parent`);
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new WorkspaceIsolationError("source_invalid", `could not create ${label}`, {
        cause: error,
      });
    }
  }
  await requireRealDirectory(path, label);
  await chmod(path, 0o700);
}

async function requireRealDirectory(path: string, label: string): Promise<void> {
  try {
    const [metadata, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== resolve(path)) {
      throw new Error("path is not a direct directory");
    }
  } catch (error) {
    if (error instanceof WorkspaceIsolationError) {
      throw error;
    }
    throw new WorkspaceIsolationError("source_invalid", `${label} is not a direct directory`, {
      cause: error,
    });
  }
}

function workspaceIdentityDirectory(base: string, workspaceId: string): string {
  const candidate = resolve(base, workspaceId);
  const path = relative(base, candidate);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    basename(candidate) !== workspaceId
  ) {
    throw new WorkspaceIsolationError("invalid_workspace_id", "invalid isolated workspace id");
  }
  return candidate;
}

function workspaceCwd(base: string, workspaceId: string): string {
  return join(workspaceIdentityDirectory(base, workspaceId), "workspace");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function workspaceIsMissing(error: unknown): boolean {
  return error instanceof WorkspaceIsolationError && error.code === "workspace_missing";
}

function workspaceIsMissingOrMismatch(error: unknown): boolean {
  return (
    error instanceof WorkspaceIsolationError &&
    (error.code === "workspace_missing" || error.code === "workspace_mismatch")
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
