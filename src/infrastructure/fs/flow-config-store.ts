import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parseDocument } from "yaml";

import type { PolicyPackageCapabilitySnapshot } from "../../domain/capability/agent-skills.js";
import {
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
  FlowConfigError,
  parseOperatorConfig,
  parseProjectConfig,
  resolveFlowConfig,
} from "../../domain/config/resolver.js";
import { snapshotSelectedPolicyPackages } from "./local-policy-package-catalog.js";
import { discoverProjectCapabilityCatalogs } from "./project-capability-catalog.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const PROJECT_CONFIG_SOURCE = `apiVersion: ${FLOW_CONFIG_API_VERSION}\nkind: FlowProjectConfig\n`;

export type FlowConfigStoreErrorCode =
  | "already_exists"
  | "commit_uncertain"
  | "io"
  | "settlement_uncertain"
  | "unsafe_target";

export class FlowConfigStoreError extends Error {
  override readonly name = "FlowConfigStoreError";

  constructor(
    readonly code: FlowConfigStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface FlowConfigLocationOptions {
  readonly cwd?: string;
  readonly xdgConfigHome?: string;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Pick<NodeJS.ProcessEnv, "XDG_CONFIG_HOME" | "HOME">>;
}

export interface LoadEffectiveFlowConfigOptions extends FlowConfigLocationOptions {
  readonly policyPackages?: PolicyPackageCapabilitySnapshot;
  readonly signal?: AbortSignal;
}

export interface InitializeFlowProjectOptions {
  readonly replace?: boolean;
  readonly signal?: AbortSignal;
  readonly hooks?: FlowProjectInitializationHooks;
}

export interface FlowProjectInitializationHooks {
  readonly beforeConfigLinked?: () => void | Promise<void>;
  readonly afterConfigLinked?: () => void | Promise<void>;
}

export interface InitializedFlowProject {
  readonly created: boolean;
  readonly projectRoot: string;
  readonly path: string;
}

export function resolveOperatorConfigPath(options: {
  readonly xdgConfigHome?: string;
  readonly homeDirectory?: string;
}): string {
  const fallbackHome =
    options.homeDirectory !== undefined && isAbsolute(options.homeDirectory)
      ? options.homeDirectory
      : homedir();
  const configHome =
    options.xdgConfigHome !== undefined && isAbsolute(options.xdgConfigHome)
      ? options.xdgConfigHome
      : join(fallbackHome, ".config");
  return join(configHome, "flow", "config.yaml");
}

export async function loadEffectiveFlowConfig(
  options: LoadEffectiveFlowConfigOptions = {},
): Promise<EffectiveFlowConfig> {
  options.signal?.throwIfAborted();
  const cwd = await canonicalDirectory(
    options.cwd ?? process.cwd(),
    "configuration working directory",
  );
  options.signal?.throwIfAborted();
  const environment = options.environment ?? process.env;
  const xdgConfigHome = options.xdgConfigHome ?? environment.XDG_CONFIG_HOME;
  const homeDirectory = options.homeDirectory ?? environment.HOME;
  const operatorPath = resolveOperatorConfigPath({
    ...(xdgConfigHome === undefined ? {} : { xdgConfigHome }),
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
  });
  const [operatorInput, projectLocation] = await Promise.all([
    readOptionalConfig(operatorPath),
    discoverProjectConfig(cwd),
  ]);
  options.signal?.throwIfAborted();
  const projectInput =
    projectLocation === null ? null : await readRequiredConfig(projectLocation.path);
  options.signal?.throwIfAborted();
  const operator =
    operatorInput === null ? undefined : parseOperatorConfig(operatorInput, operatorPath);
  const project =
    projectLocation === null || projectInput === null
      ? undefined
      : parseProjectConfig(projectInput, projectLocation.path);
  const policyReferences = [
    ...(operator?.policies?.required ?? []),
    ...(project?.policies?.additional ?? []),
  ];
  const policyPackages =
    options.policyPackages !== undefined
      ? options.policyPackages
      : policyReferences.length === 0 || projectLocation === null
        ? undefined
        : await discoverProjectCapabilityCatalogs(projectLocation.projectRoot, {
            includeNonPolicies: false,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }).then(
            async (catalogs) =>
              await snapshotSelectedPolicyPackages(
                catalogs.policies,
                policyReferences.map(({ name, version }) => ({ name, version })),
                { ...(options.signal === undefined ? {} : { signal: options.signal }) },
              ),
          );

  options.signal?.throwIfAborted();

  return resolveFlowConfig({
    ...(operator === undefined
      ? {}
      : {
          operator: {
            path: operatorPath,
            config: operator,
          },
        }),
    ...(projectLocation === null || project === undefined
      ? {}
      : {
          project: {
            path: projectLocation.path,
            config: project,
          },
          projectRoot: projectLocation.projectRoot,
        }),
    ...(policyPackages === undefined ? {} : { policyPackages }),
  });
}

export async function locateFlowProjectRoot(
  options: FlowConfigLocationOptions = {},
): Promise<string | null> {
  const cwd = await canonicalDirectory(
    options.cwd ?? process.cwd(),
    "configuration working directory",
  );
  return (await discoverProjectConfig(cwd))?.projectRoot ?? null;
}

export async function initializeFlowProject(
  directory: string,
  options: InitializeFlowProjectOptions = {},
): Promise<InitializedFlowProject> {
  options.signal?.throwIfAborted();
  const projectRoot = await canonicalDirectory(directory, "project directory");
  options.signal?.throwIfAborted();
  const flowDirectory = join(projectRoot, ".flow");
  await ensureWritableFlowDirectory(flowDirectory);
  options.signal?.throwIfAborted();
  const path = join(flowDirectory, "config.yaml");
  const existing = await optionalLstat(path);
  options.signal?.throwIfAborted();

  if (existing !== null && options.replace !== true) {
    throw new FlowConfigStoreError(
      "already_exists",
      `Flow project configuration already exists at "${path}"; use explicit replacement to overwrite it`,
    );
  }
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new FlowConfigStoreError(
      "unsafe_target",
      `Flow project configuration target "${path}" must be a regular file`,
    );
  }

  if (existing === null) {
    const pending = join(flowDirectory, `.config.${randomUUID()}.pending`);
    let linked = false;
    let pendingRemoved = false;
    let publicationFailed = false;
    let publicationError: unknown;
    try {
      const handle = await open(pending, "wx", 0o644);
      await writeAndSync(handle, PROJECT_CONFIG_SOURCE);
      options.signal?.throwIfAborted();
      await options.hooks?.beforeConfigLinked?.();
      options.signal?.throwIfAborted();
      await link(pending, path);
      linked = true;
      await options.hooks?.afterConfigLinked?.();
      await syncDirectory(flowDirectory);
      await rm(pending);
      pendingRemoved = true;
      await syncDirectory(flowDirectory);
    } catch (error) {
      publicationFailed = true;
      publicationError = error;
    }

    let cleanupFailed = false;
    let cleanupError: unknown;
    if (!pendingRemoved) {
      try {
        await rm(pending, { force: true });
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }

    if (publicationFailed) {
      if (linked) {
        throw new FlowConfigStoreError(
          "commit_uncertain",
          "Flow project configuration publication is uncertain",
          { cause: publicationError },
        );
      }
      if (cleanupFailed) {
        throw new FlowConfigStoreError(
          "settlement_uncertain",
          "Flow project configuration staging settlement is uncertain",
          { cause: new AggregateError([publicationError, cleanupError]) },
        );
      }
      options.signal?.throwIfAborted();
      if (isNodeError(publicationError) && publicationError.code === "EEXIST") {
        throw new FlowConfigStoreError(
          "already_exists",
          `Flow project configuration already exists at "${path}"`,
          { cause: publicationError },
        );
      }
      if (publicationError instanceof FlowConfigStoreError) {
        throw publicationError;
      }
      throw ioError(`failed to initialize Flow project at "${path}"`, publicationError);
    }
    return Object.freeze({ created: true, projectRoot, path });
  }

  const pending = join(flowDirectory, `.config.${randomUUID()}.pending`);
  let published = false;
  try {
    const handle = await open(pending, "wx", 0o644);
    await writeAndSync(handle, PROJECT_CONFIG_SOURCE);
    await rename(pending, path);
    published = true;
    await syncDirectory(flowDirectory);
  } catch (error) {
    throw ioError(`failed to replace Flow project configuration at "${path}"`, error);
  } finally {
    if (!published) {
      await rm(pending, { force: true }).catch(() => undefined);
    }
  }
  return Object.freeze({ created: false, projectRoot, path });
}

async function discoverProjectConfig(
  cwd: string,
): Promise<{ readonly projectRoot: string; readonly path: string } | null> {
  let current = cwd;
  for (;;) {
    const flowDirectory = join(current, ".flow");
    const flowMetadata = await optionalLstat(flowDirectory);
    if (flowMetadata !== null && (flowMetadata.isSymbolicLink() || !flowMetadata.isDirectory())) {
      throw new FlowConfigStoreError(
        "unsafe_target",
        `Flow project directory "${flowDirectory}" must be a real directory`,
      );
    }
    const path = join(flowDirectory, "config.yaml");
    const metadata = flowMetadata === null ? null : await optionalLstat(path);
    if (metadata !== null) {
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new FlowConfigStoreError(
          "unsafe_target",
          `Flow project configuration "${path}" is not a regular file`,
        );
      }
      return Object.freeze({ projectRoot: current, path });
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function readOptionalConfig(path: string): Promise<unknown | null> {
  const metadata = await optionalLstat(path);
  if (metadata === null) {
    return null;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new FlowConfigStoreError(
      "unsafe_target",
      `Flow configuration "${path}" is not a regular file`,
    );
  }
  return await readRequiredConfig(path);
}

async function readRequiredConfig(path: string): Promise<unknown> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new FlowConfigStoreError(
        "unsafe_target",
        `Flow configuration "${path}" is not a regular file`,
      );
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new FlowConfigError(
        "invalid_config",
        `${path}: <root>: configuration exceeds ${MAX_CONFIG_BYTES} bytes`,
        { sourcePath: path, fieldPath: "<root>" },
      );
    }
    return parseYaml(await handle.readFile({ encoding: "utf8" }), path);
  } catch (error) {
    if (error instanceof FlowConfigError || error instanceof FlowConfigStoreError) {
      throw error;
    }
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new FlowConfigStoreError(
        "unsafe_target",
        `Flow configuration "${path}" must not be a symbolic link`,
        { cause: error },
      );
    }
    throw ioError(`failed to read Flow configuration "${path}"`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseYaml(source: string, sourcePath: string): unknown {
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new FlowConfigError(
        "invalid_config",
        `${sourcePath}: <yaml>: ${document.errors.map((error) => error.message).join("; ")}`,
        { sourcePath, fieldPath: "<yaml>" },
      );
    }
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof FlowConfigError) {
      throw error;
    }
    throw new FlowConfigError(
      "invalid_config",
      `${sourcePath}: <yaml>: ${error instanceof Error ? error.message : String(error)}`,
      { sourcePath, fieldPath: "<yaml>", cause: error },
    );
  }
}

async function ensureWritableFlowDirectory(path: string): Promise<void> {
  const before = await optionalLstat(path);
  if (before?.isSymbolicLink() === true || (before !== null && !before.isDirectory())) {
    throw new FlowConfigStoreError(
      "unsafe_target",
      `Flow project directory "${path}" must be a real directory`,
    );
  }
  try {
    await mkdir(path, { recursive: true, mode: 0o755 });
    const after = await lstat(path);
    if (!after.isDirectory() || after.isSymbolicLink()) {
      throw new FlowConfigStoreError(
        "unsafe_target",
        `Flow project directory "${path}" must be a real directory`,
      );
    }
  } catch (error) {
    if (error instanceof FlowConfigStoreError) {
      throw error;
    }
    throw ioError(`failed to prepare Flow project directory "${path}"`, error);
  }
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  try {
    const canonical = await realpath(resolve(path));
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new FlowConfigStoreError("unsafe_target", `${label} "${canonical}" is not a directory`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof FlowConfigStoreError) {
      throw error;
    }
    throw ioError(`failed to resolve ${label} "${path}"`, error);
  }
}

async function optionalLstat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw ioError(`failed to inspect "${path}"`, error);
  }
}

async function writeAndSync(handle: FileHandle, source: string): Promise<void> {
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function ioError(message: string, cause: unknown): FlowConfigStoreError {
  return cause instanceof FlowConfigStoreError
    ? cause
    : new FlowConfigStoreError("io", message, { cause });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
