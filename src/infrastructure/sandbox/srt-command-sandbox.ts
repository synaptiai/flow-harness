import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

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
    gitState: "deny-write",
    sensitiveFiles: "deny-write",
  }),
  environment: Object.freeze({
    mode: "allowlist",
    names: SAFE_ENVIRONMENT_NAMES,
    privateTempVariables: Object.freeze(["TMPDIR", "TMP", "TEMP"]),
  }),
});

interface ManagerRuntimeState {
  activeCommands: number;
  operationTail: Promise<void>;
  sessionKey: string | undefined;
  poisonedReason?: string;
}

const MANAGER_RUNTIME_STATES = new WeakMap<SrtSandboxManager, ManagerRuntimeState>();

export interface SrtRuntimeConfig {
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
  readonly cleanupTimeoutMs?: number;
  readonly seccompApplyPath?: string;
}

export class SrtCommandSandbox implements CommandSandbox {
  readonly #backendVersion: string;
  readonly #canonicalize: (path: string) => Promise<string>;
  readonly #cleanupTimeoutMs: number;
  readonly #createTemporaryDirectory: () => Promise<string>;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #homeDirectory: string;
  readonly #manager: SrtSandboxManager;
  readonly #platform: NodeJS.Platform;
  readonly #removeTemporaryDirectory: (path: string) => Promise<void>;
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
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
    this.#seccompApplyPath = options.seccompApplyPath;
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
      const canonicalProtectedPaths = await Promise.all(
        request.protectedPaths.map((path) => this.#canonicalize(path)),
      );
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
        canonicalProtectedPaths,
        this.#homeDirectory,
        canonicalSeccompApplyPath,
      );
      const sessionKey = sandboxSessionKey(
        this.#platform,
        canonicalWorkspace,
        canonicalProtectedPaths,
        this.#homeDirectory,
        canonicalSeccompApplyPath,
      );
      await this.#acquireSession(config, sessionKey);
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

      const launch = Object.freeze({
        executable: descriptor.argv[0] as string,
        args: Object.freeze(descriptor.argv.slice(1)),
        env: buildSafeEnvironment(this.#environment, privateTemporaryDirectory),
      });
      const evidence = sandboxEvidence(this.#backendVersion);
      let released = false;
      return Object.freeze({
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

  async #acquireSession(config: SrtRuntimeConfig, sessionKey: string): Promise<void> {
    const runtimeState = managerRuntimeState(this.#manager);
    await withManagerLock(runtimeState, async () => {
      if (runtimeState.poisonedReason !== undefined) {
        throw new Error(
          `command sandbox is unavailable after cleanup failure: ${runtimeState.poisonedReason}`,
        );
      }
      if (runtimeState.sessionKey !== undefined && runtimeState.sessionKey !== sessionKey) {
        throw new Error(
          "command sandbox cannot activate a different workspace or policy while another command is active",
        );
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
      }
      runtimeState.activeCommands += 1;
    });
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
          try {
            await withTimeout(this.#manager.reset(), this.#cleanupTimeoutMs);
          } catch (error) {
            errors.push(error);
          } finally {
            runtimeState.sessionKey = undefined;
          }
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
    state = { activeCommands: 0, operationTail: Promise.resolve(), sessionKey: undefined };
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

function sandboxSessionKey(
  platform: NodeJS.Platform,
  workspace: string,
  protectedPaths: readonly string[],
  homeDirectory: string,
  seccompApplyPath: string | undefined,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        platform,
        workspace,
        protectedPaths,
        homeDirectory,
        seccompApplyPath: seccompApplyPath ?? null,
      }),
    )
    .digest("hex");
}

function createRuntimeConfig(
  workspace: string,
  privateTemporaryDirectory: string,
  protectedPaths: readonly string[],
  homeDirectory: string,
  seccompApplyPath: string | undefined,
): SrtRuntimeConfig {
  const allowRead = [workspace, privateTemporaryDirectory];
  if (
    seccompApplyPath !== undefined &&
    !isAtOrWithin(seccompApplyPath, workspace) &&
    !isAtOrWithin(seccompApplyPath, privateTemporaryDirectory)
  ) {
    allowRead.push(seccompApplyPath);
  }
  return Object.freeze({
    network: Object.freeze({
      allowedDomains: Object.freeze([]),
      deniedDomains: Object.freeze(["*"]),
      strictAllowlist: true,
      allowUnixSockets: Object.freeze([]),
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    }),
    filesystem: Object.freeze({
      denyRead: Object.freeze([homeDirectory]),
      allowRead: Object.freeze(allowRead),
      allowWrite: Object.freeze([workspace, privateTemporaryDirectory]),
      denyWrite: Object.freeze([
        ...new Set([
          ...protectedPaths,
          join(workspace, ".flow"),
          join(workspace, ".git"),
          join(workspace, ".env"),
          join(workspace, ".env.*"),
          join(workspace, "**/*.pem"),
          join(workspace, "**/*.key"),
        ]),
      ]),
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
  return Object.freeze(environment);
}

function sandboxEvidence(backendVersion: string): SandboxEvidence {
  return Object.freeze({
    backend: "anthropic-sandbox-runtime",
    backendVersion,
    profile: FLOW_SANDBOX_PROFILE,
    policyDigest: createHash("sha256").update(JSON.stringify(SEMANTIC_POLICY)).digest("hex"),
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
