import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, opendir, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

import type {
  CommandSandbox,
  CommandSandboxRequest,
  PreparedCommand,
} from "../../application/command-sandbox.js";
import type { SandboxEvidence } from "../../domain/run/events.js";
import { encodePosixCommand } from "./posix-argv.js";

export const FLOW_SANDBOX_PROFILE = "workspace-write-network-deny-v1" as const;

const SAFE_ENVIRONMENT_NAMES = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "GITHUB_ACTIONS",
]);
const TRUSTED_RUNTIME_ENVIRONMENT_NAMES = Object.freeze(["NODE_PATH"] as const);
const MAX_TRUSTED_RUNTIME_ENVIRONMENT_BYTES = 128 * 1_024;

const FLOW_WORKSPACE_COLLECTION_SUFFIX = ".flow-workspaces";
const MAX_COLLECTION_DISCOVERY_ENTRIES = 200_000;

const SEMANTIC_POLICY = Object.freeze({
  version: 1,
  profile: FLOW_SANDBOX_PROFILE,
  network: Object.freeze({ mode: "deny-all", localBinding: false, unixSockets: "deny" }),
  filesystem: Object.freeze({
    home: "deny-read",
    workspace: "read-write",
    privateTemp: "read-write",
    runtimeSupport: "read-only",
    runStore: "deny-write",
    flowState: "deny-write",
    workspaceCollections: "deny-existing",
    gitState: "deny-write",
    sensitiveFiles: "deny-write",
  }),
  environment: Object.freeze({
    mode: "allowlist",
    names: SAFE_ENVIRONMENT_NAMES,
    privateTempVariables: Object.freeze(["TMPDIR", "TMP", "TEMP"]),
  }),
});

export const FLOW_SANDBOX_POLICY_DIGEST = createHash("sha256")
  .update(JSON.stringify(SEMANTIC_POLICY))
  .digest("hex");
export const FLOW_NODE_PATH_SANDBOX_POLICY_DIGEST = createHash("sha256")
  .update(
    JSON.stringify({
      ...SEMANTIC_POLICY,
      environment: {
        ...SEMANTIC_POLICY.environment,
        trustedRuntimeNames: TRUSTED_RUNTIME_ENVIRONMENT_NAMES,
      },
    }),
  )
  .digest("hex");

interface ManagerRuntimeState {
  activeCommands: number;
  completeSession: (() => void) | undefined;
  operationTail: Promise<void>;
  sessionCompletion: Promise<void> | undefined;
  sessionKey: string | undefined;
  poisonedReason?: string;
}

const MANAGER_RUNTIME_STATES = new WeakMap<SrtSandboxManager, ManagerRuntimeState>();

export interface SrtRuntimeConfig {
  readonly bwrapPath?: string;
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    readonly strictAllowlist: boolean;
    readonly allowUnixSockets: readonly string[];
    readonly allowAllUnixSockets: boolean;
    readonly allowLocalBinding: boolean;
  };
  readonly filesystem: {
    readonly denyRead: readonly string[];
    readonly allowRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
    readonly allowGitConfig: boolean;
  };
  readonly allowAppleEvents: boolean;
  readonly allowPty: boolean;
  readonly enableWeakerNestedSandbox: boolean;
  readonly enableWeakerNetworkIsolation: boolean;
  readonly seccomp?: { readonly applyPath: string };
}

export interface SrtSandboxManager {
  checkDependencies(): {
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  };
  initialize(config: SrtRuntimeConfig): Promise<void>;
  wrapWithSandboxArgv(
    command: string,
    binShell: string,
    customConfig: SrtRuntimeConfig | undefined,
    signal: AbortSignal | undefined,
    cwd: string,
  ): Promise<{ readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv }>;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

export interface SrtCommandSandboxOptions {
  readonly backendVersion: string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly canonicalize?: (path: string) => Promise<string>;
  readonly createTemporaryDirectory?: () => Promise<string>;
  readonly removeTemporaryDirectory?: (path: string) => Promise<void>;
  readonly discoverPrivateWorkspaceCollections?: (workspace: string) => Promise<readonly string[]>;
  readonly discoverPrivateWorkspaceCollectionAncestors?: (
    workspace: string,
  ) => Promise<readonly string[]>;
  readonly cleanupTimeoutMs?: number;
  readonly seccompApplyPath?: string;
  readonly resolveTrustedBwrapPath?: (workspace: string) => Promise<string>;
}

export class SrtCommandSandbox implements CommandSandbox {
  readonly #backendVersion: string;
  readonly #canonicalize: (path: string) => Promise<string>;
  readonly #cleanupTimeoutMs: number;
  readonly #createTemporaryDirectory: () => Promise<string>;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #discoverPrivateWorkspaceCollections: (workspace: string) => Promise<readonly string[]>;
  readonly #discoverPrivateWorkspaceCollectionAncestors: (
    workspace: string,
  ) => Promise<readonly string[]>;
  readonly #homeDirectory: string;
  readonly #manager: SrtSandboxManager;
  readonly #platform: NodeJS.Platform;
  readonly #removeTemporaryDirectory: (path: string) => Promise<void>;
  readonly #resolveTrustedBwrapPath: (workspace: string) => Promise<string>;
  readonly #seccompApplyPath: string | undefined;

  constructor(manager: SrtSandboxManager, options: SrtCommandSandboxOptions) {
    if (options.backendVersion.length === 0) {
      throw new TypeError("backendVersion must not be empty");
    }
    this.#manager = manager;
    this.#backendVersion = options.backendVersion;
    this.#platform = options.platform ?? process.platform;
    this.#environment = options.environment ?? process.env;
    this.#homeDirectory = options.homeDirectory ?? homedir();
    this.#canonicalize = options.canonicalize ?? realpath;
    this.#createTemporaryDirectory =
      options.createTemporaryDirectory ?? (() => mkdtemp(join(tmpdir(), "flow-command-")));
    this.#removeTemporaryDirectory =
      options.removeTemporaryDirectory ??
      ((path) => rm(path, { recursive: true, force: true, maxRetries: 2 }));
    this.#discoverPrivateWorkspaceCollections =
      options.discoverPrivateWorkspaceCollections ?? discoverPrivateWorkspaceCollections;
    this.#discoverPrivateWorkspaceCollectionAncestors =
      options.discoverPrivateWorkspaceCollectionAncestors ??
      discoverPrivateWorkspaceCollectionAncestors;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
    this.#seccompApplyPath = options.seccompApplyPath;
    this.#resolveTrustedBwrapPath =
      options.resolveTrustedBwrapPath ??
      ((workspace) => resolveTrustedBwrapPath(this.#environment, workspace));
    if (!Number.isSafeInteger(this.#cleanupTimeoutMs) || this.#cleanupTimeoutMs <= 0) {
      throw new RangeError("cleanupTimeoutMs must be a positive safe integer");
    }
  }

  async prepare(request: CommandSandboxRequest): Promise<PreparedCommand> {
    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      throw new Error(`command sandbox is not supported on ${this.#platform}`);
    }
    const runtimeState = managerRuntimeState(this.#manager);
    if (runtimeState.poisonedReason !== undefined) {
      throw new Error(
        `command sandbox is unavailable after cleanup failure: ${runtimeState.poisonedReason}`,
      );
    }
    if (request.signal?.aborted === true) {
      throw new Error("command sandbox preparation was cancelled");
    }

    let privateTemporaryDirectory: string | undefined;
    let sessionAcquired = false;
    let wrapped = false;
    try {
      const canonicalWorkspace = await this.#canonicalize(request.cwd);
      const canonicalProjectRoot =
        request.projectRoot === undefined
          ? undefined
          : await this.#canonicalize(request.projectRoot);
      const trustedBwrapPath =
        this.#platform === "linux"
          ? await this.#resolveTrustedBwrapPath(canonicalWorkspace)
          : undefined;
      const privateWorkspaceCollections =
        await this.#discoverPrivateWorkspaceCollections(canonicalWorkspace);
      const privateWorkspaceCollectionAncestors =
        await this.#discoverPrivateWorkspaceCollectionAncestors(canonicalWorkspace);
      const canonicalWriteProtectedPaths = await Promise.all(
        [...new Set([...request.protectedPaths, ...privateWorkspaceCollections])].map((path) =>
          this.#canonicalize(path),
        ),
      );
      const canonicalReadProtectedPaths = Object.freeze([
        ...canonicalWriteProtectedPaths,
        ...(await Promise.all(
          privateWorkspaceCollectionAncestors.map((path) => this.#canonicalize(path)),
        )),
      ]);
      const canonicalRuntimeSupportPaths = Object.freeze(
        await Promise.all(
          [...new Set(request.runtimeSupportPaths ?? [])].map((path) => this.#canonicalize(path)),
        ),
      );
      const canonicalRuntimeEnvironment = await canonicalizeRuntimeEnvironment(
        request.runtimeEnvironment,
        this.#canonicalize,
      );
      const policyDigest =
        Object.keys(canonicalRuntimeEnvironment).length === 0
          ? FLOW_SANDBOX_POLICY_DIGEST
          : FLOW_NODE_PATH_SANDBOX_POLICY_DIGEST;
      if (this.#platform === "linux" && canonicalProjectRoot !== undefined) {
        assertLinuxProjectBoundary(canonicalWorkspace, canonicalProjectRoot);
      }
      const canonicalSeccompApplyPath =
        this.#seccompApplyPath === undefined
          ? undefined
          : await this.#canonicalize(this.#seccompApplyPath);
      privateTemporaryDirectory = await this.#createTemporaryDirectory();

      const dependencies = this.#manager.checkDependencies();
      const dependencyProblems = [...dependencies.errors, ...dependencies.warnings];
      if (dependencyProblems.length > 0) {
        throw new Error(`sandbox dependencies unavailable: ${dependencyProblems.join("; ")}`);
      }

      const config = createRuntimeConfig(
        canonicalWorkspace,
        privateTemporaryDirectory,
        canonicalReadProtectedPaths,
        canonicalWriteProtectedPaths,
        canonicalRuntimeSupportPaths,
        this.#homeDirectory,
        canonicalSeccompApplyPath,
        trustedBwrapPath,
      );
      const sessionKey = sandboxSessionKey(
        this.#platform,
        canonicalWorkspace,
        canonicalReadProtectedPaths,
        canonicalWriteProtectedPaths,
        canonicalRuntimeSupportPaths,
        canonicalRuntimeEnvironment,
        this.#homeDirectory,
        canonicalSeccompApplyPath,
        trustedBwrapPath,
      );
      await this.#acquireSession(config, sessionKey, request.signal);
      sessionAcquired = true;
      const command = encodePosixCommand(request.executable, request.args);
      const descriptor = await this.#manager.wrapWithSandboxArgv(
        command,
        "/bin/bash",
        config,
        request.signal,
        canonicalWorkspace,
      );
      wrapped = true;
      validateDescriptor(descriptor.argv);
      const processContainment = validateProcessContainment(
        this.#platform,
        descriptor.argv,
        trustedBwrapPath,
      );

      const launch = Object.freeze({
        executable: descriptor.argv[0] as string,
        args: Object.freeze(descriptor.argv.slice(1)),
        env: buildSafeEnvironment(
          this.#environment,
          privateTemporaryDirectory,
          canonicalRuntimeEnvironment,
        ),
      });
      const evidence = sandboxEvidence(this.#backendVersion, policyDigest);
      let released = false;
      return Object.freeze({
        processContainment,
        launch,
        evidence,
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          await this.#release(privateTemporaryDirectory as string, wrapped, sessionAcquired);
        },
      });
    } catch (error) {
      const cleanupErrors = await this.#release(
        privateTemporaryDirectory,
        wrapped,
        sessionAcquired,
        false,
      );
      if (cleanupErrors.length === 0) {
        throw error;
      }
      throw combinedError(error, cleanupErrors);
    }
  }

  async #acquireSession(
    config: SrtRuntimeConfig,
    sessionKey: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const runtimeState = managerRuntimeState(this.#manager);
    while (true) {
      let acquired = false;
      let sessionCompletion: Promise<void> | undefined;
      await withManagerLock(runtimeState, async () => {
        if (signal?.aborted === true) {
          throw new Error("command sandbox preparation was cancelled");
        }
        if (runtimeState.poisonedReason !== undefined) {
          throw new Error(
            `command sandbox is unavailable after cleanup failure: ${runtimeState.poisonedReason}`,
          );
        }
        if (runtimeState.sessionKey !== undefined && runtimeState.sessionKey !== sessionKey) {
          sessionCompletion = runtimeState.sessionCompletion;
          if (sessionCompletion === undefined) {
            throw new Error("command sandbox active session has no completion signal");
          }
          return;
        }
        if (runtimeState.sessionKey === undefined) {
          try {
            await this.#manager.initialize(config);
          } catch (error) {
            const cleanupErrors: unknown[] = [];
            try {
              await withTimeout(this.#manager.reset(), this.#cleanupTimeoutMs);
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
              runtimeState.poisonedReason = cleanupErrors.map(errorMessage).join("; ");
            }
            if (cleanupErrors.length > 0) {
              throw combinedError(error, cleanupErrors);
            }
            throw error;
          }
          runtimeState.sessionKey = sessionKey;
          runtimeState.sessionCompletion = new Promise<void>((resolvePromise) => {
            runtimeState.completeSession = resolvePromise;
          });
        }
        runtimeState.activeCommands += 1;
        acquired = true;
      });
      if (acquired) {
        return;
      }
      if (sessionCompletion === undefined) {
        throw new Error("command sandbox session wait invariant was violated");
      }
      await waitForSessionCompletion(sessionCompletion, signal);
    }
  }

  async #release(
    privateTemporaryDirectory: string | undefined,
    wrapped: boolean,
    sessionAcquired: boolean,
    throwOnFailure = true,
  ): Promise<readonly unknown[]> {
    const errors: unknown[] = [];
    const runtimeState = managerRuntimeState(this.#manager);
    await withManagerLock(runtimeState, async () => {
      if (wrapped) {
        try {
          this.#manager.cleanupAfterCommand();
        } catch (error) {
          errors.push(error);
        }
      }
      if (sessionAcquired) {
        if (runtimeState.activeCommands <= 0) {
          errors.push(new Error("command sandbox session reference count underflowed"));
        } else {
          runtimeState.activeCommands -= 1;
        }
        if (runtimeState.activeCommands === 0 && runtimeState.sessionKey !== undefined) {
          const completeSession = runtimeState.completeSession;
          try {
            await withTimeout(this.#manager.reset(), this.#cleanupTimeoutMs);
          } catch (error) {
            errors.push(error);
          } finally {
            runtimeState.sessionKey = undefined;
            runtimeState.sessionCompletion = undefined;
            runtimeState.completeSession = undefined;
          }
          if (errors.length > 0) {
            runtimeState.poisonedReason = errors.map(errorMessage).join("; ");
          }
          completeSession?.();
        }
      }
      if (privateTemporaryDirectory !== undefined) {
        try {
          await this.#removeTemporaryDirectory(privateTemporaryDirectory);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        runtimeState.poisonedReason = errors.map(errorMessage).join("; ");
      }
    });
    if (throwOnFailure && errors.length > 0) {
      throw combinedError("command sandbox cleanup failed", errors);
    }
    return errors;
  }
}

function managerRuntimeState(manager: SrtSandboxManager): ManagerRuntimeState {
  let state = MANAGER_RUNTIME_STATES.get(manager);
  if (state === undefined) {
    state = {
      activeCommands: 0,
      completeSession: undefined,
      operationTail: Promise.resolve(),
      sessionCompletion: undefined,
      sessionKey: undefined,
    };
    MANAGER_RUNTIME_STATES.set(manager, state);
  }
  return state;
}

async function withManagerLock<T>(
  state: ManagerRuntimeState,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = state.operationTail;
  let unlock!: () => void;
  state.operationTail = new Promise<void>((resolvePromise) => {
    unlock = resolvePromise;
  });
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
  }
}

async function waitForSessionCompletion(
  completion: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await completion;
    return;
  }
  if (signal.aborted) {
    throw new Error("command sandbox preparation was cancelled");
  }
  await new Promise<void>((resolvePromise, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("command sandbox preparation was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void completion.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sandboxSessionKey(
  platform: NodeJS.Platform,
  workspace: string,
  readProtectedPaths: readonly string[],
  writeProtectedPaths: readonly string[],
  runtimeSupportPaths: readonly string[],
  runtimeEnvironment: Readonly<Record<string, string>>,
  homeDirectory: string,
  seccompApplyPath: string | undefined,
  trustedBwrapPath: string | undefined,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        platform,
        workspace,
        readProtectedPaths,
        writeProtectedPaths,
        runtimeSupportPaths,
        runtimeEnvironment,
        homeDirectory,
        seccompApplyPath: seccompApplyPath ?? null,
        trustedBwrapPath: trustedBwrapPath ?? null,
      }),
    )
    .digest("hex");
}

function createRuntimeConfig(
  workspace: string,
  privateTemporaryDirectory: string,
  readProtectedPaths: readonly string[],
  writeProtectedPaths: readonly string[],
  runtimeSupportPaths: readonly string[],
  homeDirectory: string,
  seccompApplyPath: string | undefined,
  trustedBwrapPath: string | undefined,
): SrtRuntimeConfig {
  const allowRead = [
    workspace,
    privateTemporaryDirectory,
    ...runtimeSupportPaths.filter(
      (path) => !isAtOrWithin(path, workspace) && !isAtOrWithin(path, privateTemporaryDirectory),
    ),
  ];
  if (
    seccompApplyPath !== undefined &&
    !isAtOrWithin(seccompApplyPath, workspace) &&
    !isAtOrWithin(seccompApplyPath, privateTemporaryDirectory)
  ) {
    allowRead.push(seccompApplyPath);
  }
  const denyWrite = [
    ...new Set([
      ...writeProtectedPaths,
      ...runtimeSupportPaths,
      join(workspace, ".flow"),
      join(workspace, ".flow-workspaces"),
      join(workspace, ".flow-workspaces/**"),
      join(workspace, ".*.flow-workspaces"),
      join(workspace, ".*.flow-workspaces/**"),
      join(workspace, "**/.flow-workspaces"),
      join(workspace, "**/.flow-workspaces/**"),
      join(workspace, "**/.*.flow-workspaces"),
      join(workspace, "**/.*.flow-workspaces/**"),
      join(workspace, ".git"),
      join(workspace, ".env"),
      join(workspace, ".env.*"),
      join(workspace, "**/*.pem"),
      join(workspace, "**/*.key"),
    ]),
  ].filter(
    (candidate) =>
      !writeProtectedPaths.some(
        (protectedPath) => candidate !== protectedPath && isAtOrWithin(candidate, protectedPath),
      ),
  );
  return Object.freeze({
    ...(trustedBwrapPath === undefined ? {} : { bwrapPath: trustedBwrapPath }),
    network: Object.freeze({
      allowedDomains: Object.freeze([]),
      deniedDomains: Object.freeze(["*"]),
      strictAllowlist: true,
      allowUnixSockets: Object.freeze([]),
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    }),
    filesystem: Object.freeze({
      denyRead: Object.freeze([
        ...new Set([
          homeDirectory,
          ...readProtectedPaths,
          join(workspace, ".flow"),
          join(workspace, ".flow-workspaces"),
          join(workspace, ".flow-workspaces/**"),
          join(workspace, ".*.flow-workspaces"),
          join(workspace, ".*.flow-workspaces/**"),
          join(workspace, "**/.flow-workspaces"),
          join(workspace, "**/.flow-workspaces/**"),
          join(workspace, "**/.*.flow-workspaces"),
          join(workspace, "**/.*.flow-workspaces/**"),
          join(workspace, ".env"),
          join(workspace, ".env.*"),
          join(workspace, "**/*.pem"),
          join(workspace, "**/*.key"),
        ]),
      ]),
      allowRead: Object.freeze(allowRead),
      allowWrite: Object.freeze([workspace, privateTemporaryDirectory]),
      denyWrite: Object.freeze(denyWrite),
      allowGitConfig: false,
    }),
    allowAppleEvents: false,
    allowPty: false,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    ...(seccompApplyPath === undefined
      ? {}
      : { seccomp: Object.freeze({ applyPath: seccompApplyPath }) }),
  });
}

async function discoverPrivateWorkspaceCollections(workspace: string): Promise<readonly string[]> {
  const pending = [workspace];
  const collections: string[] = [];
  let observedEntries = 0;
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      observedEntries += 1;
      if (observedEntries > MAX_COLLECTION_DISCOVERY_ENTRIES) {
        throw new Error(
          `command workspace collection scan exceeds ${MAX_COLLECTION_DISCOVERY_ENTRIES} entries`,
        );
      }
      const candidate = join(directory, entry.name);
      if (isFlowWorkspaceCollectionName(entry.name)) {
        const [metadata, canonical] = await Promise.all([lstat(candidate), realpath(candidate)]);
        if (metadata.isSymbolicLink() || !metadata.isDirectory() || canonical !== candidate) {
          throw new Error(`Flow workspace collection is not a direct directory: ${candidate}`);
        }
        collections.push(canonical);
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(candidate);
      }
    }
  }
  return Object.freeze(collections.sort());
}

async function discoverPrivateWorkspaceCollectionAncestors(
  workspace: string,
): Promise<readonly string[]> {
  const collections: string[] = [];
  let current = dirname(workspace);
  for (;;) {
    if (isFlowWorkspaceCollectionName(current.split(sep).at(-1) ?? "")) {
      const [metadata, canonical] = await Promise.all([lstat(current), realpath(current)]);
      if (metadata.isSymbolicLink() || !metadata.isDirectory() || canonical !== current) {
        throw new Error(`Flow workspace collection is not a direct directory: ${current}`);
      }
      collections.push(canonical);
    }
    const parent = dirname(current);
    if (parent === current) {
      return Object.freeze(collections);
    }
    current = parent;
  }
}

function isFlowWorkspaceCollectionName(name: string): boolean {
  return (
    name === FLOW_WORKSPACE_COLLECTION_SUFFIX ||
    (name.startsWith(".") &&
      name.endsWith(FLOW_WORKSPACE_COLLECTION_SUFFIX) &&
      name.length > FLOW_WORKSPACE_COLLECTION_SUFFIX.length + 1)
  );
}

function assertLinuxProjectBoundary(workspace: string, projectRoot: string): void {
  if (projectRoot !== workspace && isAtOrWithin(projectRoot, workspace)) {
    throw new Error("Linux command workspace must not contain the configured Flow project root");
  }
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

function buildSafeEnvironment(
  source: NodeJS.ProcessEnv,
  privateTemporaryDirectory: string,
  runtimeEnvironment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  environment.TMPDIR = privateTemporaryDirectory;
  environment.TMP = privateTemporaryDirectory;
  environment.TEMP = privateTemporaryDirectory;
  Object.assign(environment, runtimeEnvironment);
  return Object.freeze(environment);
}

async function canonicalizeRuntimeEnvironment(
  value: Readonly<Record<string, string>> | undefined,
  canonicalize: (path: string) => Promise<string>,
): Promise<Readonly<Record<string, string>>> {
  if (value === undefined) {
    return Object.freeze({});
  }
  const names = Object.keys(value);
  if (names.length !== 1 || names[0] !== "NODE_PATH") {
    throw new Error("command sandbox runtime environment supports only NODE_PATH");
  }
  const nodePath = value.NODE_PATH;
  if (
    typeof nodePath !== "string" ||
    nodePath === "" ||
    Buffer.byteLength(nodePath, "utf8") > MAX_TRUSTED_RUNTIME_ENVIRONMENT_BYTES
  ) {
    throw new Error("command sandbox NODE_PATH is empty or exceeds its byte limit");
  }
  const entries = nodePath.split(delimiter);
  if (entries.some((entry) => entry === "" || !isAbsolute(entry))) {
    throw new Error("command sandbox NODE_PATH entries must be absolute paths");
  }
  const canonicalEntries = await Promise.all(
    [...new Set(entries)].map((entry) => canonicalize(entry)),
  );
  return Object.freeze({ NODE_PATH: canonicalEntries.join(delimiter) });
}

function sandboxEvidence(backendVersion: string, policyDigest: string): SandboxEvidence {
  return Object.freeze({
    backend: "anthropic-sandbox-runtime",
    backendVersion,
    profile: FLOW_SANDBOX_PROFILE,
    policyDigest,
  });
}

function validateDescriptor(argv: readonly string[]): void {
  if (argv.length === 0 || typeof argv[0] !== "string" || argv[0].length === 0) {
    throw new Error("sandbox backend returned an invalid launch descriptor");
  }
  if (!argv.every((value) => typeof value === "string" && !value.includes("\0"))) {
    throw new Error("sandbox backend returned an invalid launch descriptor");
  }
}

function validateProcessContainment(
  platform: NodeJS.Platform,
  argv: readonly string[],
  trustedBwrapPath: string | undefined,
): PreparedCommand["processContainment"] {
  if (platform === "darwin") {
    return "process-group";
  }
  const wrapperArgv =
    argv.length === 3 && argv[0] === "/bin/bash" && argv[1] === "-c"
      ? parseCanonicalSrtShellArgv(argv[2] as string)
      : null;
  const bwrapDescriptor = wrapperArgv === null ? null : parseBwrapDescriptor(wrapperArgv);
  const lifecycleTail = bwrapDescriptor?.options.slice(-4) ?? [];
  if (
    trustedBwrapPath === undefined ||
    wrapperArgv === null ||
    wrapperArgv[0] !== trustedBwrapPath ||
    bwrapDescriptor === null ||
    bwrapDescriptor.options[0]?.name !== "--new-session" ||
    bwrapDescriptor.options[1]?.name !== "--die-with-parent" ||
    !sameBwrapOptions(lifecycleTail, [
      { name: "--unshare-pid", operands: [] },
      { name: "--unshare-user", operands: [] },
      { name: "--cap-drop", operands: ["ALL"] },
      { name: "--proc", operands: ["/proc"] },
    ]) ||
    bwrapDescriptor.command.length !== 3 ||
    bwrapDescriptor.command[0] !== "/bin/bash" ||
    bwrapDescriptor.command[1] !== "-c"
  ) {
    throw new Error(
      "sandbox backend did not provide required Linux PID namespace descendant containment",
    );
  }
  return "linux-pid-namespace";
}

interface BwrapOption {
  readonly name: string;
  readonly operands: readonly string[];
}

interface BwrapDescriptor {
  readonly options: readonly BwrapOption[];
  readonly command: readonly string[];
}

const BWRAP_OPTION_ARITY = new Map<string, number>([
  ["--new-session", 0],
  ["--die-with-parent", 0],
  ["--unshare-net", 0],
  ["--unshare-pid", 0],
  ["--unshare-user", 0],
  ["--unsetenv", 1],
  ["--dev", 1],
  ["--proc", 1],
  ["--cap-drop", 1],
  ["--tmpfs", 1],
  ["--bind", 2],
  ["--ro-bind", 2],
  ["--setenv", 2],
]);

function parseBwrapDescriptor(argv: readonly string[]): BwrapDescriptor | null {
  const options: BwrapOption[] = [];
  let cursor = 1;
  while (cursor < argv.length) {
    const name = argv[cursor] as string;
    if (name === "--") {
      return {
        options: Object.freeze(options),
        command: Object.freeze(argv.slice(cursor + 1)),
      };
    }
    const arity = BWRAP_OPTION_ARITY.get(name);
    if (arity === undefined || cursor + arity >= argv.length) {
      return null;
    }
    options.push(
      Object.freeze({
        name,
        operands: Object.freeze(argv.slice(cursor + 1, cursor + 1 + arity)),
      }),
    );
    cursor += arity + 1;
  }
  return null;
}

const SRT_BARE_SHELL_WORD = /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/;
const SRT_SINGLE_QUOTE_SPLICE = "\"'\"'";

function parseCanonicalSrtShellArgv(command: string): readonly string[] | null {
  if (command.length === 0) {
    return null;
  }
  const values: string[] = [];
  let cursor = 0;
  while (cursor < command.length) {
    if (command[cursor] === " ") {
      return null;
    }
    if (command[cursor] !== "'") {
      const separator = command.indexOf(" ", cursor);
      const end = separator === -1 ? command.length : separator;
      const value = command.slice(cursor, end);
      if (!SRT_BARE_SHELL_WORD.test(value)) {
        return null;
      }
      values.push(value);
      cursor = end;
    } else {
      cursor += 1;
      let value = "";
      while (true) {
        const quoteEnd = command.indexOf("'", cursor);
        if (quoteEnd === -1) {
          return null;
        }
        value += command.slice(cursor, quoteEnd);
        cursor = quoteEnd + 1;
        if (cursor === command.length || command[cursor] === " ") {
          break;
        }
        if (
          command.slice(cursor, cursor + SRT_SINGLE_QUOTE_SPLICE.length) !== SRT_SINGLE_QUOTE_SPLICE
        ) {
          return null;
        }
        value += "'";
        cursor += SRT_SINGLE_QUOTE_SPLICE.length;
      }
      values.push(value);
    }
    if (cursor === command.length) {
      break;
    }
    if (command[cursor] !== " " || cursor + 1 === command.length || command[cursor + 1] === " ") {
      return null;
    }
    cursor += 1;
  }
  return Object.freeze(values);
}

function sameBwrapOptions(left: readonly BwrapOption[], right: readonly BwrapOption[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (option, index) =>
        option.name === right[index]?.name &&
        option.operands.length === right[index]?.operands.length &&
        option.operands.every(
          (operand, operandIndex) => operand === right[index]?.operands[operandIndex],
        ),
    )
  );
}

async function resolveTrustedBwrapPath(
  environment: NodeJS.ProcessEnv,
  workspace: string,
): Promise<string> {
  const pathEntries = environment.PATH?.split(delimiter) ?? [];
  const inspected = new Set<string>();
  for (const entry of pathEntries) {
    if (!isAbsolute(entry)) {
      continue;
    }
    let candidate: string;
    try {
      candidate = await realpath(join(entry, "bwrap"));
    } catch {
      continue;
    }
    if (inspected.has(candidate) || isAtOrWithin(candidate, workspace)) {
      continue;
    }
    inspected.add(candidate);
    if (!/^\/[A-Za-z0-9_./:@+,-]+$/.test(candidate)) {
      continue;
    }
    try {
      const candidateStat = await stat(candidate);
      if (
        !candidateStat.isFile() ||
        candidateStat.uid !== 0 ||
        (candidateStat.mode & 0o022) !== 0 ||
        !(await hasTrustedAncestors(candidate))
      ) {
        continue;
      }
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(
    "sandbox dependencies unavailable: trusted root-owned bubblewrap executable not found outside the workspace",
  );
}

async function hasTrustedAncestors(path: string): Promise<boolean> {
  let current = dirname(path);
  while (true) {
    const metadata = await stat(current);
    if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      return false;
    }
    const parent = dirname(current);
    if (parent === current) {
      return true;
    }
    current = parent;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`sandbox cleanup exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function combinedError(primary: unknown, cleanupErrors: readonly unknown[]): Error {
  const messages = [primary, ...cleanupErrors].map(errorMessage);
  return new Error(messages.join("; "));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
