import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type {
  CommandSandbox,
  CommandSandboxRequest,
  PreparedCommand,
  SandboxLaunch,
} from "../../application/command-sandbox.js";
import {
  isFlowWorkspaceCollectionName,
  isSensitiveWorkspacePath,
} from "../policy/workspace-policy-broker.js";
import {
  type ContainerCommandWorkspaceSnapshotRequest,
  observeContainerCommandWorkspaceSnapshot,
} from "./container-command-workspace-snapshot.js";

const MAX_ARGUMENTS = 4_096;
const MAX_ARGUMENT_BYTES = 1_048_576;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_BYTES = 65_536;
const MAX_WORKSPACE_SCAN_DEPTH = 64;
const MAX_WORKSPACE_SCAN_ENTRIES = 100_000;
const MAX_WORKSPACE_PROTECTION_PATHS = 4_096;
const MAX_WORKSPACE_PROTECTION_BYTES = 1_048_576;

export interface ContainerWorkspaceProtection {
  readonly maskedPaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
}

export interface ContainerWorkspaceProtectionScanLimits {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly maxProtectionBytes?: number;
  readonly maxProtectionPaths?: number;
  readonly signal?: AbortSignal;
}

export interface LocalContainerCommandPreparationInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly protectedPaths: readonly string[];
  readonly readOnlyPaths?: readonly string[];
  readonly workspaceSnapshotDigest: string;
  readonly runtimeSupportPaths?: readonly string[];
  readonly runtimeEnvironment?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface LocalContainerCommandEngineLease {
  readonly launch: SandboxLaunch;
  readonly identity: {
    readonly backendVersion: string;
    readonly policyDigest: string;
  };
  beforeLaunch?(): Promise<void>;
  release(): Promise<void>;
}

export interface LocalContainerCommandSandboxEngine {
  prepare(input: LocalContainerCommandPreparationInput): Promise<LocalContainerCommandEngineLease>;
}

export interface LocalContainerCommandSandboxOptions {
  readonly platform?: NodeJS.Platform;
  readonly canonicalize?: (path: string) => Promise<string>;
  readonly discoverWorkspaceProtection?: (
    workspace: string,
    limits?: ContainerWorkspaceProtectionScanLimits,
  ) => Promise<ContainerWorkspaceProtection>;
  readonly observeWorkspaceSnapshot?: (
    request: ContainerCommandWorkspaceSnapshotRequest,
  ) => Promise<string>;
}

export class LocalContainerCommandSandbox implements CommandSandbox {
  readonly #canonicalize: (path: string) => Promise<string>;
  readonly #discoverWorkspaceProtection: (
    workspace: string,
    limits?: ContainerWorkspaceProtectionScanLimits,
  ) => Promise<ContainerWorkspaceProtection>;
  readonly #platform: NodeJS.Platform;
  readonly #observeWorkspaceSnapshot: (
    request: ContainerCommandWorkspaceSnapshotRequest,
  ) => Promise<string>;

  constructor(
    private readonly engine: LocalContainerCommandSandboxEngine,
    options: LocalContainerCommandSandboxOptions = {},
  ) {
    this.#platform = options.platform ?? process.platform;
    this.#canonicalize = options.canonicalize ?? defaultCanonicalize;
    this.#discoverWorkspaceProtection =
      options.discoverWorkspaceProtection ?? discoverContainerWorkspaceProtection;
    this.#observeWorkspaceSnapshot =
      options.observeWorkspaceSnapshot ?? observeContainerCommandWorkspaceSnapshot;
  }

  async prepare(request: CommandSandboxRequest): Promise<PreparedCommand> {
    if (this.#platform !== "linux") {
      throw new Error("container command sandbox is supported only on Linux");
    }
    validateCommand(request.executable, request.args);
    throwIfAborted(request.signal);

    const cwd = await this.#canonicalize(request.cwd);
    throwIfAborted(request.signal);
    const projectRoot =
      request.projectRoot === undefined ? undefined : await this.#canonicalize(request.projectRoot);
    throwIfAborted(request.signal);
    if (projectRoot !== undefined && projectRoot !== cwd && isAtOrWithin(projectRoot, cwd)) {
      throw new Error(
        "container command workspace must not contain the configured Flow project root",
      );
    }
    const workspaceProtection = await this.#discoverWorkspaceProtection(
      cwd,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    throwIfAborted(request.signal);
    const protectedPaths = Object.freeze([
      ...new Set(
        await Promise.all(
          [
            ...request.protectedPaths,
            ...(request.projectRoot === undefined ? [] : [join(request.projectRoot, ".flow")]),
            ...workspaceProtection.maskedPaths,
          ].map((path) => this.#canonicalize(path)),
        ),
      ),
    ]);
    throwIfAborted(request.signal);
    const readOnlyPaths = Object.freeze(
      await Promise.all(workspaceProtection.readOnlyPaths.map((path) => this.#canonicalize(path))),
    );
    throwIfAborted(request.signal);
    const runtimeSupportPaths = Object.freeze(
      await Promise.all(
        (request.runtimeSupportPaths ?? []).map((path) => this.#canonicalize(path)),
      ),
    );
    throwIfAborted(request.signal);
    const runtimeEnvironment = await canonicalizeRuntimeEnvironment(
      request.runtimeEnvironment,
      this.#canonicalize,
    );
    throwIfAborted(request.signal);
    const snapshotRequest = Object.freeze({
      workspace: cwd,
      excludedPaths: Object.freeze(
        protectedPaths.filter((path) => path !== cwd && isAtOrWithin(path, cwd)),
      ),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const workspaceSnapshotDigest = await observeWorkspaceSnapshotClosed(
      this.#observeWorkspaceSnapshot,
      snapshotRequest,
      request.signal,
    );
    throwIfAborted(request.signal);

    const input = Object.freeze({
      executable: request.executable,
      args: Object.freeze([...request.args]),
      cwd,
      ...(projectRoot === undefined ? {} : { projectRoot }),
      protectedPaths,
      ...(readOnlyPaths.length === 0 ? {} : { readOnlyPaths }),
      workspaceSnapshotDigest,
      ...(runtimeSupportPaths.length === 0 ? {} : { runtimeSupportPaths }),
      ...(runtimeEnvironment === undefined ? {} : { runtimeEnvironment }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const lease = await this.engine.prepare(input);

    try {
      throwIfAborted(request.signal);
      const launch = validateLaunch(lease.launch);
      const evidence = validateIdentity(lease.identity);
      const release = retryableRelease(lease.release.bind(lease));
      const beforeLaunch = async () => {
        const currentSnapshotDigest = await observeWorkspaceSnapshotClosed(
          this.#observeWorkspaceSnapshot,
          snapshotRequest,
          request.signal,
        );
        if (currentSnapshotDigest !== workspaceSnapshotDigest) {
          throw new Error("container command workspace changed before launch");
        }
        await lease.beforeLaunch?.();
      };
      return Object.freeze({
        processContainment: "linux-pid-namespace" as const,
        launch,
        evidence,
        beforeLaunch,
        release,
      });
    } catch (error) {
      const cleanupError = await lease.release().then(
        () => undefined,
        (failure: unknown) => failure,
      );
      if (cleanupError === undefined) {
        throw error;
      }
      throw new AggregateError(
        [error, cleanupError],
        "Container command sandbox preparation and cleanup failed",
      );
    }
  }
}

async function observeWorkspaceSnapshotClosed(
  observe: (request: ContainerCommandWorkspaceSnapshotRequest) => Promise<string>,
  request: ContainerCommandWorkspaceSnapshotRequest,
  signal: AbortSignal | undefined,
): Promise<string> {
  let digest: string;
  try {
    digest = await observe(request);
  } catch (error) {
    if (signal?.aborted === true) {
      throwIfAborted(signal);
    }
    throw new Error("container command workspace snapshot cannot be observed", { cause: error });
  }
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("container command workspace snapshot is invalid");
  }
  return digest;
}

async function canonicalizeRuntimeEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
  canonicalize: (path: string) => Promise<string>,
): Promise<Readonly<Record<string, string>> | undefined> {
  if (environment === undefined) {
    return undefined;
  }
  const entries = Object.entries(environment);
  if (entries.length !== 1 || entries[0]?.[0] !== "NODE_PATH") {
    throw new Error("container command runtime environment supports only NODE_PATH");
  }
  const value = entries[0][1];
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_ENVIRONMENT_BYTES) {
    throw new Error("container command NODE_PATH is empty or exceeds its byte limit");
  }
  const paths = value.split(":");
  if (paths.some((path) => path.length === 0 || !isAbsolute(path))) {
    throw new Error("container command NODE_PATH entries must be absolute paths");
  }
  const canonical = await Promise.all(paths.map((path) => canonicalize(path)));
  return Object.freeze({ NODE_PATH: canonical.join(":") });
}

function validateCommand(executable: string, args: readonly string[]): void {
  if (executable.length === 0 || executable.includes("\0")) {
    throw new Error("container command executable is invalid");
  }
  if (args.length > MAX_ARGUMENTS) {
    throw new Error("container command argument count exceeds its limit");
  }
  let bytes = Buffer.byteLength(executable, "utf8");
  for (const argument of args) {
    if (argument.includes("\0")) {
      throw new Error("container command argument is invalid");
    }
    bytes += Buffer.byteLength(argument, "utf8");
    if (bytes > MAX_ARGUMENT_BYTES) {
      throw new Error("container command arguments exceed their byte limit");
    }
  }
}

function validateLaunch(value: SandboxLaunch): SandboxLaunch {
  validateCommand(value.executable, value.args);
  const entries = Object.entries(value.env);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new Error("container launcher environment entry count exceeds its limit");
  }
  let bytes = 0;
  const environment: Record<string, string> = {};
  for (const [name, content] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || content.includes("\0")) {
      throw new Error("container launcher environment is invalid");
    }
    bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(content, "utf8");
    if (bytes > MAX_ENVIRONMENT_BYTES) {
      throw new Error("container launcher environment exceeds its byte limit");
    }
    environment[name] = content;
  }
  return Object.freeze({
    executable: value.executable,
    args: Object.freeze([...value.args]),
    env: Object.freeze(environment),
  });
}

function validateIdentity(identity: LocalContainerCommandEngineLease["identity"]) {
  if (
    identity.backendVersion.length === 0 ||
    identity.backendVersion.length > 128 ||
    !/^[a-f0-9]{64}$/.test(identity.policyDigest)
  ) {
    throw new Error("container command sandbox identity is invalid");
  }
  return Object.freeze({
    backend: "docker-engine",
    backendVersion: identity.backendVersion,
    profile: "flow-container-v1",
    policyDigest: identity.policyDigest,
  });
}

function retryableRelease(releaseLease: () => Promise<void>): () => Promise<void> {
  let released = false;
  let active: Promise<void> | undefined;
  return async () => {
    if (released) {
      return;
    }
    active ??= releaseLease().then(() => {
      released = true;
    });
    try {
      await active;
    } finally {
      active = undefined;
    }
  };
}

export async function discoverContainerWorkspaceProtection(
  workspace: string,
  limits: ContainerWorkspaceProtectionScanLimits = {},
): Promise<ContainerWorkspaceProtection> {
  const maxDepth = limits.maxDepth ?? MAX_WORKSPACE_SCAN_DEPTH;
  const maxEntries = limits.maxEntries ?? MAX_WORKSPACE_SCAN_ENTRIES;
  const maxProtectionBytes = limits.maxProtectionBytes ?? MAX_WORKSPACE_PROTECTION_BYTES;
  const maxProtectionPaths = limits.maxProtectionPaths ?? MAX_WORKSPACE_PROTECTION_PATHS;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_WORKSPACE_SCAN_DEPTH) {
    throw new RangeError("workspace protection scan depth limit is invalid");
  }
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries <= 0 ||
    maxEntries > MAX_WORKSPACE_SCAN_ENTRIES
  ) {
    throw new RangeError("workspace protection scan entry limit is invalid");
  }
  if (
    !Number.isSafeInteger(maxProtectionBytes) ||
    maxProtectionBytes <= 0 ||
    maxProtectionBytes > MAX_WORKSPACE_PROTECTION_BYTES
  ) {
    throw new RangeError("workspace protection scan path byte limit is invalid");
  }
  if (
    !Number.isSafeInteger(maxProtectionPaths) ||
    maxProtectionPaths <= 0 ||
    maxProtectionPaths > MAX_WORKSPACE_PROTECTION_PATHS
  ) {
    throw new RangeError("workspace protection scan path limit is invalid");
  }

  const maskedPaths: string[] = [];
  const readOnlyPaths: string[] = [];
  const pending: { readonly directory: string; readonly depth: number }[] = [
    { directory: workspace, depth: 0 },
  ];
  let pendingIndex = 0;
  let entriesSeen = 0;
  let retainedPaths = 0;
  let retainedBytes = 0;
  while (pendingIndex < pending.length) {
    throwIfAborted(limits.signal);
    const current = pending[pendingIndex++];
    if (current === undefined) {
      throw new Error("workspace protection scan queue is invalid");
    }
    const entries = (await readdir(current.directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    throwIfAborted(limits.signal);
    for (const entry of entries) {
      throwIfAborted(limits.signal);
      entriesSeen += 1;
      if (entriesSeen > maxEntries) {
        throw new Error("workspace protection scan exceeds its entry limit");
      }
      const path = join(current.directory, entry.name);
      if (
        entry.name === ".flow" ||
        isFlowWorkspaceCollectionName(entry.name) ||
        isSensitiveWorkspacePath(path)
      ) {
        retainedBytes = retainWorkspaceProtectionPath(
          maskedPaths,
          path,
          retainedBytes,
          retainedPaths,
          maxProtectionBytes,
          maxProtectionPaths,
        );
        retainedPaths += 1;
        continue;
      }
      if (entry.name === ".git") {
        retainedBytes = retainWorkspaceProtectionPath(
          entry.isDirectory() || entry.isFile() ? readOnlyPaths : maskedPaths,
          path,
          retainedBytes,
          retainedPaths,
          maxProtectionBytes,
          maxProtectionPaths,
        );
        retainedPaths += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (current.depth >= maxDepth) {
          throw new Error("workspace protection scan exceeds its depth limit");
        }
        pending.push({ directory: path, depth: current.depth + 1 });
      }
    }
  }
  return Object.freeze({
    maskedPaths: Object.freeze(maskedPaths),
    readOnlyPaths: Object.freeze(readOnlyPaths),
  });
}

function retainWorkspaceProtectionPath(
  target: string[],
  path: string,
  retainedBytes: number,
  retainedPaths: number,
  maxProtectionBytes: number,
  maxProtectionPaths: number,
): number {
  if (retainedPaths >= maxProtectionPaths) {
    throw new Error("workspace protection scan exceeds its path limit");
  }
  const nextBytes = retainedBytes + Buffer.byteLength(path, "utf8");
  if (nextBytes > maxProtectionBytes) {
    throw new Error("workspace protection scan exceeds its path byte limit");
  }
  target.push(path);
  return nextBytes;
}

async function defaultCanonicalize(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  const canonical = await realpath(path);
  if (!isAbsolute(canonical)) {
    throw new Error("container command path is not absolute");
  }
  return canonical;
}

function isAtOrWithin(path: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, path);
  return (
    pathFromDirectory === "" ||
    (pathFromDirectory !== ".." &&
      !pathFromDirectory.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromDirectory))
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new Error("container command sandbox preparation was cancelled");
}
