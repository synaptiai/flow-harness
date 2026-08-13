import { relative, sep } from "node:path";

import {
  type ContainerCommandIntent,
  type ContainerCommandProcessOwner,
  calculateContainerCommandConfigurationDigest,
  parseContainerCommandIntent,
} from "./container-command-intent.js";
import { isDockerJsonEqual } from "./docker-json-equality.js";
import type { DockerUnixApiClient } from "./docker-unix-api-client.js";
import type {
  LocalContainerCommandEngineLease,
  LocalContainerCommandPreparationInput,
  LocalContainerCommandSandboxEngine,
} from "./local-container-command-sandbox.js";

const COMMAND_ENVIRONMENT = Object.freeze([
  "PRIME_AGENT_KERNEL_FORKSERVER=0",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "NODE_VERSION=22.19.0",
  "YARN_VERSION=1.22.22",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "NODE_ENV=production",
  "HOME=/tmp",
]);

const MASKED_PATHS = Object.freeze([
  "/proc/acpi",
  "/proc/asound",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/timer_list",
  "/proc/timer_stats",
  "/proc/sched_debug",
  "/proc/scsi",
  "/proc/cmdline",
  "/proc/sys",
  "/sys/block",
  "/sys/bus",
  "/sys/class",
  "/sys/dev",
  "/sys/devices",
  "/sys/firmware",
  "/sys/hypervisor",
  "/sys/kernel",
  "/sys/module",
  "/sys/power",
]);

const READONLY_PATHS = Object.freeze([
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/sys",
  "/proc/sysrq-trigger",
]);

export interface LocalDockerContainerCommandRuntimeDescriptor {
  readonly engineVersion: string;
  readonly apiVersion: string;
  readonly socketPath: "/var/run/docker.sock";
  readonly dockerExecutable: string;
  readonly imageId: string;
  readonly runtimeName: string;
  readonly policyDigest: string;
  readonly seccompProfile: Readonly<Record<string, unknown>>;
  readonly user: { readonly uid: number; readonly gid: number };
  readonly limits: {
    readonly stopGraceMs: number;
    readonly pidsMax: number;
    readonly memoryMaxBytes: number;
    readonly memorySwapMaxBytes: number;
    readonly cpuQuotaMicros: number;
    readonly cpuPeriodMicros: number;
    readonly openFilesMax: number;
    readonly userProcessesMax: number;
    readonly fileSizeMaxBytes: number;
    readonly coreSizeMaxBytes: number;
    readonly temporaryBytes: number;
    readonly temporaryInodes: number;
  };
  assertCurrent(signal?: AbortSignal): Promise<void>;
}

type ContainerCommandApi = Pick<
  DockerUnixApiClient,
  "createContainer" | "inspectContainer" | "stopContainer" | "removeContainer"
>;

export interface LocalDockerContainerCommandEngineOptions {
  readonly resolveDescriptor: (
    signal?: AbortSignal,
  ) => Promise<LocalDockerContainerCommandRuntimeDescriptor>;
  readonly createApi: (
    descriptor: LocalDockerContainerCommandRuntimeDescriptor,
  ) => ContainerCommandApi;
  readonly createNonce: () => string;
  readonly createPrivateDirectory: () => Promise<string>;
  readonly removePrivateDirectory: (path: string) => Promise<void>;
  readonly createCleanupSignal?: () => AbortSignal | undefined;
  readonly durability?: {
    readonly createOwnerNonce: () => string;
    readonly readProcessOwner: () => Promise<ContainerCommandIntent["owner"]>;
    readonly isOwnerAlive?: (owner: ContainerCommandProcessOwner) => Promise<boolean>;
    readonly store: {
      claimOrphans?(
        claimant: ContainerCommandProcessOwner,
        isOwnerAlive: (owner: ContainerCommandProcessOwner) => Promise<boolean>,
      ): Promise<
        readonly {
          readonly intent: ContainerCommandIntent;
          release(): Promise<void>;
          complete(): Promise<void>;
        }[]
      >;
      writeIntent(intent: ContainerCommandIntent): Promise<void>;
      writeOwned(intent: ContainerCommandIntent): Promise<void>;
      remove(ownerNonce: string): Promise<void>;
    };
  };
}

export class LocalDockerContainerCommandEngine implements LocalContainerCommandSandboxEngine {
  #recovery: Promise<void> | undefined;

  constructor(private readonly options: LocalDockerContainerCommandEngineOptions) {}

  async prepare(
    input: LocalContainerCommandPreparationInput,
  ): Promise<LocalContainerCommandEngineLease> {
    const workspacePolicy = resolveWorkspacePolicy(input);
    throwIfAborted(input.signal);
    const descriptor = await this.options.resolveDescriptor(input.signal);
    validateDescriptor(descriptor);
    await descriptor.assertCurrent(input.signal);
    throwIfAborted(input.signal);
    await this.#recoverBeforePrepare(descriptor);
    throwIfAborted(input.signal);

    const user = descriptor.user;
    if (
      !Number.isSafeInteger(user.uid) ||
      user.uid <= 0 ||
      !Number.isSafeInteger(user.gid) ||
      user.gid <= 0
    ) {
      throw new Error("container command sandbox requires a non-root host user identity");
    }
    const nonce = this.options.createNonce();
    if (!/^[a-f0-9]{32}$/.test(nonce)) {
      throw new Error("container command ownership nonce is invalid");
    }
    const ownerNonce = this.options.durability?.createOwnerNonce() ?? nonce.repeat(2);
    if (!/^[a-f0-9]{64}$/.test(ownerNonce)) {
      throw new Error("container command durable owner nonce is invalid");
    }
    const containerName = `flow-command-${nonce}`;
    const configuration = createConfiguration(input, workspacePolicy, descriptor, user, ownerNonce);
    const configurationDigest = calculateContainerCommandConfigurationDigest(configuration);
    const api = this.options.createApi(descriptor);
    const privateDirectory = await this.options.createPrivateDirectory();
    let containerId: string | undefined;
    let durableIntent: ContainerCommandIntent | undefined;
    let intentPublished = false;

    try {
      if (this.options.durability !== undefined) {
        durableIntent = parseContainerCommandIntent({
          version: 1,
          state: "intent",
          ownerNonce,
          containerName,
          owner: await this.options.durability.readProcessOwner(),
          runtime: {
            engineVersion: descriptor.engineVersion,
            apiVersion: descriptor.apiVersion,
            socketPath: descriptor.socketPath,
            imageId: descriptor.imageId,
            runtimeName: descriptor.runtimeName,
            policyDigest: descriptor.policyDigest,
          },
          privateDirectory,
          configuration,
          configurationDigest,
        });
        await this.options.durability.store.writeIntent(durableIntent);
        intentPublished = true;
      }
      try {
        containerId = await api.createContainer(containerName, configuration, input.signal);
      } catch (createError) {
        try {
          containerId = await recoverCreatedContainer(
            api,
            containerName,
            configuration,
            descriptor,
            input.signal,
          );
        } catch (recoveryError) {
          throw new AggregateError(
            [createError, recoveryError],
            "Command container create outcome cannot be recovered",
          );
        }
        throw createError;
      }
      const inspection = await api.inspectContainer(containerId, input.signal);
      if (inspection === null) {
        throw new Error("created command container cannot be inspected");
      }
      assertInspection(inspection, configuration, descriptor, containerName, containerId);
      await descriptor.assertCurrent(input.signal);
      throwIfAborted(input.signal);
      if (durableIntent !== undefined && this.options.durability !== undefined) {
        durableIntent = parseContainerCommandIntent({
          ...durableIntent,
          state: "owned",
          containerId,
        });
        await this.options.durability.store.writeOwned(durableIntent);
      }
    } catch (error) {
      const cleanupErrors = await settleFailedPreparation(
        api,
        containerId,
        descriptor,
        privateDirectory,
        this.options.removePrivateDirectory,
        this.options.createCleanupSignal,
        intentPublished ? this.options.durability?.store : undefined,
        durableIntent,
      );
      if (cleanupErrors.length === 0) {
        throw error;
      }
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Container command preparation cleanup is not proved",
      );
    }

    const ownedContainerId = containerId;
    return Object.freeze({
      launch: Object.freeze({
        executable: descriptor.dockerExecutable,
        args: Object.freeze([
          "--host",
          "unix:///var/run/docker.sock",
          "start",
          "--attach",
          ownedContainerId,
        ]),
        env: Object.freeze({
          DOCKER_API_VERSION: descriptor.apiVersion,
          DOCKER_CONFIG: privateDirectory,
          HOME: privateDirectory,
        }),
      }),
      identity: Object.freeze({
        backendVersion: descriptor.engineVersion,
        policyDigest: configurationDigest,
      }),
      beforeLaunch: async () => {
        await descriptor.assertCurrent(input.signal);
        throwIfAborted(input.signal);
        const inspection = await api.inspectContainer(ownedContainerId, input.signal);
        if (inspection === null) {
          throw new Error("created command container cannot be inspected before launch");
        }
        assertInspection(inspection, configuration, descriptor, containerName, ownedContainerId);
        throwIfAborted(input.signal);
      },
      release: async () => {
        const errors = await settleContainerWithRetry(
          api,
          ownedContainerId,
          descriptor,
          this.options.createCleanupSignal,
        );
        if (errors.length === 0) {
          try {
            await this.options.removePrivateDirectory(privateDirectory);
          } catch (error) {
            errors.push(error);
          }
        }
        if (
          errors.length === 0 &&
          durableIntent !== undefined &&
          this.options.durability !== undefined
        ) {
          try {
            await this.options.durability.store.remove(durableIntent.ownerNonce);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Container command cleanup is not proved");
        }
      },
    });
  }

  async #recoverBeforePrepare(
    descriptor: LocalDockerContainerCommandRuntimeDescriptor,
  ): Promise<void> {
    const durability = this.options.durability;
    if (durability?.store.claimOrphans === undefined || durability.isOwnerAlive === undefined) {
      return;
    }
    const attempt =
      this.#recovery ??
      this.#recoverDurableOrphans(
        descriptor,
        durability.store.claimOrphans.bind(durability.store),
        durability.readProcessOwner,
        durability.isOwnerAlive,
      );
    this.#recovery = attempt;
    try {
      await attempt;
    } finally {
      if (this.#recovery === attempt) {
        this.#recovery = undefined;
      }
    }
  }

  async #recoverDurableOrphans(
    descriptor: LocalDockerContainerCommandRuntimeDescriptor,
    claimOrphans: NonNullable<
      NonNullable<LocalDockerContainerCommandEngineOptions["durability"]>["store"]["claimOrphans"]
    >,
    readProcessOwner: () => Promise<ContainerCommandProcessOwner>,
    isOwnerAlive: (owner: ContainerCommandProcessOwner) => Promise<boolean>,
  ): Promise<void> {
    const claims = await claimOrphans(await readProcessOwner(), isOwnerAlive);
    const api = this.options.createApi(descriptor);
    for (const claim of claims) {
      try {
        assertDurableRuntime(claim.intent, descriptor);
        await descriptor.assertCurrent(this.options.createCleanupSignal?.());
        await recoverDurableContainer(
          api,
          claim.intent,
          descriptor,
          this.options.removePrivateDirectory,
          this.options.createCleanupSignal,
        );
        await claim.complete();
      } catch (error) {
        const releaseError = await claim.release().then(
          () => undefined,
          (failure: unknown) => failure,
        );
        if (releaseError !== undefined) {
          throw new AggregateError(
            [error, releaseError],
            "Container command recovery claim release failed",
          );
        }
        throw error;
      }
    }
  }
}

async function recoverDurableContainer(
  api: ContainerCommandApi,
  intent: ContainerCommandIntent,
  descriptor: LocalDockerContainerCommandRuntimeDescriptor,
  removePrivateDirectory: (path: string) => Promise<void>,
  createCleanupSignal: (() => AbortSignal | undefined) | undefined,
): Promise<void> {
  const signal = createCleanupSignal?.();
  let containerId: string | undefined;
  if (intent.state === "owned") {
    const durableContainerId = intent.containerId;
    if (durableContainerId === undefined) {
      throw new Error("durable owned command container has no full ID");
    }
    const inspection = await api.inspectContainer(durableContainerId, signal);
    if (inspection === null) {
      if ((await api.inspectContainer(intent.containerName, signal)) !== null) {
        throw new Error("durable command container ID is absent but its name is occupied");
      }
      await removePrivateDirectory(intent.privateDirectory);
      return;
    }
    assertInspection(
      inspection,
      intent.configuration,
      descriptor,
      intent.containerName,
      durableContainerId,
    );
    containerId = durableContainerId;
  } else {
    containerId = await recoverCreatedContainer(
      api,
      intent.containerName,
      intent.configuration,
      descriptor,
      signal,
    );
  }
  if (containerId === undefined) {
    throw new Error("durable command container create outcome is unresolved");
  }
  const errors = await settleContainerWithRetry(api, containerId, descriptor, createCleanupSignal);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Durable command container cleanup is not proved");
  }
  await removePrivateDirectory(intent.privateDirectory);
}

function assertDurableRuntime(
  intent: ContainerCommandIntent,
  descriptor: LocalDockerContainerCommandRuntimeDescriptor,
): void {
  if (
    !isDockerJsonEqual(intent.runtime, {
      engineVersion: descriptor.engineVersion,
      apiVersion: descriptor.apiVersion,
      socketPath: descriptor.socketPath,
      imageId: descriptor.imageId,
      runtimeName: descriptor.runtimeName,
      policyDigest: descriptor.policyDigest,
    })
  ) {
    throw new Error("durable command container runtime identity changed");
  }
}

async function recoverCreatedContainer(
  api: ContainerCommandApi,
  containerName: string,
  configuration: Record<string, unknown>,
  descriptor: LocalDockerContainerCommandRuntimeDescriptor,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const recovered = await inspectRecoveredContainer(
    api,
    containerName,
    configuration,
    descriptor,
    signal,
  );
  if (recovered !== undefined) {
    return recovered;
  }

  await descriptor.assertCurrent(signal);
  throwIfAborted(signal);

  let fencedContainerId: string | undefined;
  let fenceError: unknown;
  try {
    fencedContainerId = await api.createContainer(containerName, configuration, signal);
  } catch (error) {
    fenceError = error;
  }
  if (fencedContainerId !== undefined) {
    const inspection = await api.inspectContainer(fencedContainerId, signal);
    if (inspection === null) {
      throw new Error("fenced command container cannot be inspected");
    }
    assertInspection(inspection, configuration, descriptor, containerName, fencedContainerId);
    return fencedContainerId;
  }

  const reconciled = await inspectRecoveredContainer(
    api,
    containerName,
    configuration,
    descriptor,
    signal,
  );
  if (reconciled !== undefined) {
    return reconciled;
  }
  throw new Error("command container named create did not settle", { cause: fenceError });
}

async function inspectRecoveredContainer(
  api: ContainerCommandApi,
  containerName: string,
  configuration: Record<string, unknown>,
  descriptor: LocalDockerContainerCommandRuntimeDescriptor,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const inspection = await api.inspectContainer(containerName, signal);
  if (inspection === null) {
    return undefined;
  }
  const containerId = inspection.Id;
  if (typeof containerId !== "string" || !/^[a-f0-9]{64}$/.test(containerId)) {
    throw new Error("recovered command container has an invalid full ID");
  }
  assertInspection(inspection, configuration, descriptor, containerName, containerId);
  return containerId;
}

function createConfiguration(
  input: LocalContainerCommandPreparationInput,
  workspacePolicy: ContainerCommandWorkspacePolicy,
  descriptor: LocalDockerContainerCommandRuntimeDescriptor,
  user: { readonly uid: number; readonly gid: number },
  ownerNonce: string,
): Record<string, unknown> {
  const seccomp = JSON.stringify(descriptor.seccompProfile);
  if (Buffer.byteLength(seccomp, "utf8") > 1_048_576) {
    throw new Error("container command seccomp profile exceeds its byte limit");
  }
  const environment = [
    ...COMMAND_ENVIRONMENT,
    ...(input.runtimeEnvironment?.NODE_PATH === undefined
      ? []
      : [`NODE_PATH=${input.runtimeEnvironment.NODE_PATH}`]),
  ];
  return {
    Image: descriptor.imageId,
    Hostname: "flow-command",
    Domainname: "",
    User: `${user.uid}:${user.gid}`,
    WorkingDir: "/workspace",
    Entrypoint: [input.executable],
    Cmd: [...input.args],
    Env: environment,
    Labels: {
      "flow.command-owner-nonce": ownerNonce,
      "flow.image-id": descriptor.imageId,
      "flow.policy-digest": descriptor.policyDigest,
      "flow.workspace-snapshot-digest": input.workspaceSnapshotDigest,
    },
    OpenStdin: false,
    StdinOnce: false,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Healthcheck: { Test: ["NONE"] },
    StopTimeout: Math.ceil(descriptor.limits.stopGraceMs / 1_000),
    HostConfig: {
      NetworkMode: "none",
      PidMode: "",
      Dns: ["127.0.0.1"],
      DnsSearch: ["."],
      DnsOptions: ["ndots:0"],
      IpcMode: "none",
      CgroupnsMode: "private",
      Runtime: descriptor.runtimeName,
      ReadonlyRootfs: true,
      LogConfig: { Type: "none", Config: {} },
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false,
      PidsLimit: descriptor.limits.pidsMax,
      Memory: descriptor.limits.memoryMaxBytes,
      MemorySwap: descriptor.limits.memoryMaxBytes + descriptor.limits.memorySwapMaxBytes,
      CpuQuota: descriptor.limits.cpuQuotaMicros,
      CpuPeriod: descriptor.limits.cpuPeriodMicros,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges", `seccomp=${seccomp}`],
      Binds: [
        `${input.cwd}:/workspace:rw`,
        ...(input.runtimeSupportPaths ?? []).map((path) => `${path}:${path}:ro`),
      ],
      MaskedPaths: [...MASKED_PATHS, ...workspacePolicy.maskedPaths],
      ReadonlyPaths: [...READONLY_PATHS, ...workspacePolicy.readOnlyPaths],
      Tmpfs: {
        "/tmp": tmpfsOptions(
          descriptor.limits.temporaryBytes,
          descriptor.limits.temporaryInodes,
          "0700",
        ),
      },
      Ulimits: [
        {
          Name: "nofile",
          Soft: descriptor.limits.openFilesMax,
          Hard: descriptor.limits.openFilesMax,
        },
        {
          Name: "nproc",
          Soft: descriptor.limits.userProcessesMax,
          Hard: descriptor.limits.userProcessesMax,
        },
        {
          Name: "fsize",
          Soft: descriptor.limits.fileSizeMaxBytes,
          Hard: descriptor.limits.fileSizeMaxBytes,
        },
        {
          Name: "core",
          Soft: descriptor.limits.coreSizeMaxBytes,
          Hard: descriptor.limits.coreSizeMaxBytes,
        },
      ],
    },
  };
}

function assertInspection(
  inspection: Record<string, unknown>,
  configuration: Record<string, unknown>,
  descriptor: LocalDockerContainerCommandRuntimeDescriptor,
  containerName: string,
  containerId: string,
): void {
  if (
    !isDockerJsonEqual(
      { Id: inspection.Id, Name: inspection.Name, Image: inspection.Image },
      { Id: containerId, Name: `/${containerName}`, Image: descriptor.imageId },
    )
  ) {
    throw new Error("created command container identity does not match admission");
  }
  const actualConfig = selectConfig(asObject(inspection.Config, "Docker Config"));
  const expectedConfig = selectConfig(configuration);
  if (!isDockerJsonEqual(actualConfig, expectedConfig)) {
    throw new Error("created command container configuration does not match admission");
  }
  const actualHostConfig = asObject(inspection.HostConfig, "Docker HostConfig");
  const expectedHostConfig = asObject(configuration.HostConfig, "submitted HostConfig");
  if (
    !isDockerJsonEqual(selectHostConfig(actualHostConfig), selectHostConfig(expectedHostConfig))
  ) {
    throw new Error("created command container control policy does not match admission");
  }
}

function selectConfig(value: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "Image",
    "Hostname",
    "Domainname",
    "User",
    "WorkingDir",
    "Entrypoint",
    "Cmd",
    "Env",
    "Labels",
    "OpenStdin",
    "StdinOnce",
    "AttachStdin",
    "AttachStdout",
    "AttachStderr",
    "Tty",
    "Healthcheck",
    "StopTimeout",
  ] as const;
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function selectHostConfig(value: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "NetworkMode",
    "PidMode",
    "Dns",
    "DnsSearch",
    "DnsOptions",
    "IpcMode",
    "CgroupnsMode",
    "Runtime",
    "ReadonlyRootfs",
    "LogConfig",
    "RestartPolicy",
    "AutoRemove",
    "PidsLimit",
    "Memory",
    "MemorySwap",
    "CpuQuota",
    "CpuPeriod",
    "CapDrop",
    "CapAdd",
    "SecurityOpt",
    "Binds",
    "MaskedPaths",
    "ReadonlyPaths",
    "Tmpfs",
    "Ulimits",
  ] as const;
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

async function settleFailedPreparation(
  api: ContainerCommandApi,
  containerId: string | undefined,
  descriptor: LocalDockerContainerCommandRuntimeDescriptor,
  privateDirectory: string,
  removePrivateDirectory: (path: string) => Promise<void>,
  createCleanupSignal: (() => AbortSignal | undefined) | undefined,
  intentStore:
    | {
        remove(ownerNonce: string): Promise<void>;
      }
    | undefined,
  durableIntent: ContainerCommandIntent | undefined,
): Promise<unknown[]> {
  const errors =
    containerId === undefined
      ? []
      : await settleContainerWithRetry(api, containerId, descriptor, createCleanupSignal);
  const canFinalize =
    errors.length === 0 && (containerId !== undefined || intentStore === undefined);
  if (canFinalize) {
    try {
      await removePrivateDirectory(privateDirectory);
    } catch (error) {
      errors.push(error);
    }
  }
  if (
    errors.length === 0 &&
    containerId !== undefined &&
    intentStore !== undefined &&
    durableIntent !== undefined
  ) {
    try {
      await intentStore.remove(durableIntent.ownerNonce);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function settleContainerWithRetry(
  api: ContainerCommandApi,
  containerId: string,
  descriptor: LocalDockerContainerCommandRuntimeDescriptor,
  createCleanupSignal: (() => AbortSignal | undefined) | undefined,
): Promise<unknown[]> {
  const firstErrors = await settleContainer(api, containerId, descriptor, createCleanupSignal?.());
  if (firstErrors.length === 0) {
    return [];
  }
  const secondErrors = await settleContainer(api, containerId, descriptor, createCleanupSignal?.());
  return secondErrors.length === 0 ? [] : [...firstErrors, ...secondErrors];
}

async function settleContainer(
  api: ContainerCommandApi,
  containerId: string,
  descriptor: LocalDockerContainerCommandRuntimeDescriptor,
  signal: AbortSignal | undefined,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    await api.stopContainer(containerId, Math.ceil(descriptor.limits.stopGraceMs / 1_000), signal);
  } catch (error) {
    errors.push(error);
  }
  try {
    await api.removeContainer(containerId, signal);
  } catch (error) {
    errors.push(error);
  }
  try {
    if ((await api.inspectContainer(containerId, signal)) !== null) {
      errors.push(new Error("command container absence is not proved"));
    }
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

interface ContainerCommandWorkspacePolicy {
  readonly maskedPaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
}

function resolveWorkspacePolicy(
  input: LocalContainerCommandPreparationInput,
): ContainerCommandWorkspacePolicy {
  if (!/^[a-f0-9]{64}$/.test(input.workspaceSnapshotDigest)) {
    throw new Error("container command workspace snapshot digest is invalid");
  }
  const paths = [input.cwd, ...(input.runtimeSupportPaths ?? []), ...(input.readOnlyPaths ?? [])];
  if (paths.some((path) => path.includes(":"))) {
    throw new Error("container command bind path is invalid");
  }

  const maskedPaths: string[] = [];
  for (const protectedPath of input.protectedPaths) {
    if (isWithin(protectedPath, input.cwd)) {
      throw new Error("container command workspace overlaps protected state");
    }
    if (isWithin(input.cwd, protectedPath)) {
      const relativePath = relative(input.cwd, protectedPath).split(sep).join("/");
      maskedPaths.push(`/workspace/${relativePath}`);
    }
    for (const runtimeSupportPath of input.runtimeSupportPaths ?? []) {
      if (overlaps(runtimeSupportPath, protectedPath)) {
        throw new Error("container command runtime support overlaps protected state");
      }
    }
  }
  const minimalMaskedPaths: string[] = [];
  for (const path of [...new Set(maskedPaths)].sort()) {
    if (!minimalMaskedPaths.some((parent) => isWithin(parent, path))) {
      minimalMaskedPaths.push(path);
    }
  }
  const readOnlyPaths: string[] = [];
  for (const source of [...new Set(input.readOnlyPaths ?? [])].sort()) {
    if (source === input.cwd || !isWithin(input.cwd, source)) {
      throw new Error("container command read-only path must be nested inside the workspace");
    }
    if ((input.runtimeSupportPaths ?? []).some((path) => overlaps(path, source))) {
      throw new Error("container command read-only path overlaps runtime support");
    }
    const relativePath = relative(input.cwd, source).split(sep).join("/");
    const target = `/workspace/${relativePath}`;
    if (minimalMaskedPaths.some((path) => isWithin(path, target))) {
      continue;
    }
    if (!readOnlyPaths.some((parent) => isWithin(parent, target))) {
      readOnlyPaths.push(target);
    }
  }
  return Object.freeze({
    maskedPaths: Object.freeze(minimalMaskedPaths),
    readOnlyPaths: Object.freeze(readOnlyPaths),
  });
}

function overlaps(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function validateDescriptor(descriptor: LocalDockerContainerCommandRuntimeDescriptor): void {
  if (
    descriptor.socketPath !== "/var/run/docker.sock" ||
    descriptor.dockerExecutable.length === 0 ||
    !descriptor.dockerExecutable.startsWith("/") ||
    !/^sha256:[a-f0-9]{64}$/.test(descriptor.imageId) ||
    descriptor.runtimeName !== "flow-prime-runc" ||
    !/^[a-f0-9]{64}$/.test(descriptor.policyDigest) ||
    !/^\d+\.\d+$/.test(descriptor.apiVersion) ||
    descriptor.engineVersion.length === 0 ||
    descriptor.engineVersion.length > 128
  ) {
    throw new Error("container command runtime descriptor is invalid");
  }
}

function tmpfsOptions(bytes: number, inodes: number, mode: string): string {
  return `rw,nosuid,nodev,noexec,size=${bytes},nr_inodes=${inodes},mode=${mode}`;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new Error("container command preparation was cancelled");
}
