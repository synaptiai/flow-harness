import { isDeepStrictEqual } from "node:util";

import type { EvaluationOciLease } from "../../domain/evaluation/attempt.js";
import type { ExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import type { DockerUnixApiClient } from "./docker-unix-api-client.js";
import type {
  PrimeOciCreatedIdentity,
  PrimeOciEngine,
  PrimeOciIntentLease,
} from "./prime-container-lifecycle.js";

const PRIME_OCI_MASKED_PATHS = Object.freeze([
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
  "/sys/class/dmi/id",
  "/sys/dev",
  "/sys/devices",
  "/sys/devices/virtual/dmi/id",
  "/sys/firmware",
  "/sys/hypervisor",
  "/sys/kernel",
  "/sys/module",
  "/sys/power",
  "/sys/devices/virtual/powercap",
]);

const PRIME_OCI_ENVIRONMENT = Object.freeze([
  "PRIME_AGENT_KERNEL_FORKSERVER=0",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "NODE_VERSION=22.19.0",
  "YARN_VERSION=1.22.22",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "NODE_ENV=production",
]);

type PrimeIdentity = Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "prime-agent-native-v1" }
>;

export interface LocalDockerPrimeOciEngineOptions {
  readonly api: Pick<
    DockerUnixApiClient,
    | "attachContainer"
    | "createContainer"
    | "inspectContainer"
    | "startContainer"
    | "stopContainer"
    | "removeContainer"
  >;
  readonly identity: PrimeIdentity;
  readonly seccompProfile: Readonly<Record<string, unknown>>;
  readonly imageDevice: {
    readonly path: string;
    readonly major: number;
    readonly minor: number;
  };
}

export class LocalDockerPrimeOciEngine implements PrimeOciEngine {
  readonly #attachments = new Map<
    string,
    Awaited<ReturnType<DockerUnixApiClient["attachContainer"]>>
  >();
  readonly #intents = new Map<string, PrimeOciIntentLease>();
  readonly #seccompJson: string;

  constructor(private readonly options: LocalDockerPrimeOciEngineOptions) {
    if (!/^\/dev\/[a-zA-Z0-9._/-]+$/.test(options.imageDevice.path)) {
      throw new Error("Prime image block device path is invalid");
    }
    if (
      !Number.isSafeInteger(options.imageDevice.major) ||
      options.imageDevice.major < 0 ||
      !Number.isSafeInteger(options.imageDevice.minor) ||
      options.imageDevice.minor < 0
    ) {
      throw new Error("Prime image block device identity is invalid");
    }
    this.#seccompJson = JSON.stringify(options.seccompProfile);
    if (Buffer.byteLength(this.#seccompJson, "utf8") > 1_048_576) {
      throw new Error("Prime seccomp profile exceeds 1048576 bytes");
    }
  }

  async create(
    intent: PrimeOciIntentLease,
    signal?: AbortSignal,
  ): Promise<PrimeOciCreatedIdentity> {
    this.#assertIntent(intent);
    const containerId = await this.options.api.createContainer(
      intent.containerName,
      this.#configuration(intent),
      signal,
    );
    const inspection = await this.options.api.inspectContainer(containerId, signal);
    if (inspection === null) {
      throw new Error("Docker create returned a container that cannot be inspected");
    }
    this.#assertInspection(inspection, intent, containerId);
    this.#intents.set(containerId, intent);
    return this.#created(containerId);
  }

  async recoverIntent(
    intent: PrimeOciIntentLease,
    signal?: AbortSignal,
  ): Promise<PrimeOciCreatedIdentity | null> {
    this.#assertIntent(intent);
    const inspection = await this.options.api.inspectContainer(intent.containerName, signal);
    if (inspection === null) {
      return null;
    }
    const containerId = inspection.Id;
    if (typeof containerId !== "string" || !/^[a-f0-9]{64}$/.test(containerId)) {
      throw new Error("recovered Prime container has an invalid full ID");
    }
    this.#assertInspection(inspection, intent, containerId);
    this.#intents.set(containerId, intent);
    return this.#created(containerId);
  }

  async recoverCreated(
    lease: Exclude<EvaluationOciLease, PrimeOciIntentLease>,
    signal?: AbortSignal,
  ): Promise<PrimeOciCreatedIdentity | null> {
    if (lease.containerId === undefined || lease.inspectedPolicyDigest === undefined) {
      throw new Error("Prime OCI durable container lease is incomplete");
    }
    const intent = toIntentLease(lease);
    this.#assertIntent(intent);
    const inspection = await this.options.api.inspectContainer(lease.containerId, signal);
    if (inspection === null) {
      const byName = await this.options.api.inspectContainer(lease.containerName, signal);
      if (byName !== null) {
        throw new Error("Prime OCI durable container ID is absent but its fixed name is occupied");
      }
      return null;
    }
    this.#assertInspection(inspection, intent, lease.containerId);
    this.#intents.set(lease.containerId, intent);
    return this.#created(lease.containerId);
  }

  async start(containerId: string, signal?: AbortSignal): Promise<void> {
    const intent = this.#intents.get(containerId);
    if (intent === undefined) {
      throw new Error("Prime container start has no reconciled intent");
    }
    const inspection = await this.options.api.inspectContainer(containerId, signal);
    if (inspection === null) {
      throw new Error("Prime container disappeared before start");
    }
    this.#assertInspection(inspection, intent, containerId);
    await this.options.api.startContainer(containerId, signal);
  }

  async attach(containerId: string, signal?: AbortSignal) {
    if (!this.#intents.has(containerId)) {
      throw new Error("Prime container attach has no reconciled intent");
    }
    const attachment = await this.options.api.attachContainer(containerId, signal);
    this.#attachments.set(containerId, attachment);
    return attachment;
  }

  async stop(containerId: string, signal?: AbortSignal): Promise<void> {
    const attachment = this.#attachments.get(containerId);
    this.#attachments.delete(containerId);
    await attachment?.release();
    await this.options.api.stopContainer(
      containerId,
      Math.ceil(this.options.identity.runtime.policy.stopGraceMs / 1_000),
      signal,
    );
  }

  async remove(containerId: string, signal?: AbortSignal): Promise<void> {
    await this.options.api.removeContainer(containerId, signal);
  }

  async confirmRemoved(containerId: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.options.api.inspectContainer(containerId, signal)) === null;
  }

  #created(containerId: string): PrimeOciCreatedIdentity {
    return Object.freeze({
      containerId,
      inspectedPolicyDigest: this.options.identity.runtime.policy.digest,
    });
  }

  #assertIntent(intent: PrimeOciIntentLease): void {
    if (
      intent.imageId !== this.options.identity.image.id ||
      intent.labels.imageId !== this.options.identity.image.id ||
      intent.policyDigest !== this.options.identity.runtime.policy.digest ||
      intent.labels.policyDigest !== this.options.identity.runtime.policy.digest
    ) {
      throw new Error("Prime OCI intent contradicts the admitted image or policy");
    }
  }

  #configuration(intent: PrimeOciIntentLease): Record<string, unknown> {
    const policy = this.options.identity.runtime.policy;
    return {
      Image: intent.imageId,
      Hostname: "flow-prime",
      Domainname: "",
      User: `${policy.supervisorUid}:${policy.sharedGid}`,
      WorkingDir: "/workspace",
      Entrypoint: ["/opt/flow/bin/flow-prime-supervisor"],
      Cmd: null,
      Env: [...PRIME_OCI_ENVIRONMENT],
      Labels: dockerLabels(intent),
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Healthcheck: { Test: ["NONE"] },
      StopTimeout: Math.ceil(policy.stopGraceMs / 1_000),
      HostConfig: this.#hostConfiguration(),
    };
  }

  #hostConfiguration(): Record<string, unknown> {
    const policy = this.options.identity.runtime.policy;
    return {
      NetworkMode: "none",
      PidMode: "",
      Dns: ["127.0.0.1"],
      DnsSearch: ["."],
      DnsOptions: ["ndots:0"],
      IpcMode: "none",
      CgroupnsMode: "private",
      Runtime: policy.runtimeName,
      ReadonlyRootfs: true,
      LogConfig: { Type: "none", Config: {} },
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false,
      PidsLimit: policy.pidsMax,
      Memory: policy.memoryMaxBytes,
      MemorySwap: policy.memoryMaxBytes + policy.memorySwapMaxBytes,
      CpuQuota: policy.cpuQuotaMicros,
      CpuPeriod: policy.cpuPeriodMicros,
      CapDrop: ["ALL"],
      CapAdd: [...policy.supervisorCapabilities],
      SecurityOpt: ["no-new-privileges", `seccomp=${this.#seccompJson}`],
      Binds: [],
      MaskedPaths: [...PRIME_OCI_MASKED_PATHS],
      Tmpfs: {
        "/workspace": tmpfsOptions(policy.workspaceBytes, policy.workspaceInodes, "0710"),
        "/run/flow-node": tmpfsOptions(policy.nodeRuntimeBytes, policy.nodeRuntimeInodes, "0700"),
        "/run/flow-supervisor": tmpfsOptions(
          policy.supervisorRuntimeBytes,
          policy.supervisorRuntimeInodes,
          "0700",
        ),
      },
      Ulimits: [
        { Name: "nofile", Soft: policy.openFilesMax, Hard: policy.openFilesMax },
        { Name: "nproc", Soft: policy.userProcessesMax, Hard: policy.userProcessesMax },
        { Name: "fsize", Soft: policy.fileSizeMaxBytes, Hard: policy.fileSizeMaxBytes },
        { Name: "core", Soft: policy.coreSizeMaxBytes, Hard: policy.coreSizeMaxBytes },
      ],
      BlkioDeviceReadBps: [
        { Path: this.options.imageDevice.path, Rate: policy.imageReadBytesPerSecond },
      ],
      BlkioDeviceReadIOps: [
        { Path: this.options.imageDevice.path, Rate: policy.imageReadOperationsPerSecond },
      ],
    };
  }

  #assertInspection(
    inspection: Record<string, unknown>,
    intent: PrimeOciIntentLease,
    containerId: string,
  ): void {
    const expectedIdentity = {
      Id: containerId,
      Name: `/${intent.containerName}`,
      Image: intent.imageId,
    };
    const actualIdentity = {
      Id: inspection.Id,
      Name: inspection.Name,
      Image: inspection.Image,
    };
    if (!isDockerJsonEqual(actualIdentity, expectedIdentity)) {
      throw new Error("created Prime container identity does not match admission");
    }

    const expectedConfig = selectConfig(this.#configuration(intent));
    const actualConfig = selectConfig(asObject(inspection.Config, "Docker Config"));
    if (!isDockerJsonEqual(actualConfig.Env, expectedConfig.Env)) {
      throw new Error("created Prime container environment does not match admission");
    }
    const configGroups = [
      {
        keys: ["Image"] as const,
        message: "created Prime container image reference does not match admission",
      },
      {
        keys: ["Hostname", "Domainname"] as const,
        message: "created Prime container host identity does not match admission",
      },
      {
        keys: ["User", "WorkingDir"] as const,
        message: "created Prime container execution identity does not match admission",
      },
      {
        keys: ["Labels"] as const,
        message: "created Prime container labels do not match admission",
      },
      {
        keys: ["OpenStdin", "StdinOnce", "AttachStdin", "AttachStdout", "AttachStderr"] as const,
        message: "created Prime container streams do not match admission",
      },
      {
        keys: ["Tty"] as const,
        message: "created Prime container terminal does not match admission",
      },
      {
        keys: ["Entrypoint", "Cmd"] as const,
        message: "created Prime container process command does not match admission",
      },
      {
        keys: ["Healthcheck"] as const,
        message: "created Prime container health does not match admission",
      },
      {
        keys: ["StopTimeout"] as const,
        message: "created Prime container stop timeout does not match admission",
      },
    ];
    for (const group of configGroups) {
      if (
        !isDockerJsonEqual(
          selectKeys(actualConfig, group.keys),
          selectKeys(expectedConfig, group.keys),
        )
      ) {
        throw new Error(group.message);
      }
    }
    const comparedConfigKeys = ["Env", ...configGroups.flatMap((group) => group.keys)];
    if (
      !isDockerJsonEqual(
        omitKeys(actualConfig, comparedConfigKeys),
        omitKeys(expectedConfig, comparedConfigKeys),
      )
    ) {
      throw new Error("created Prime container configuration does not match admission");
    }

    const expectedHostConfig = this.#hostConfiguration();
    const actualHostConfig = selectHostConfig(asObject(inspection.HostConfig, "Docker HostConfig"));
    const capabilityKeys = ["CapDrop", "CapAdd"] as const;
    if (
      !isDockerJsonEqual(
        selectKeys(actualHostConfig, capabilityKeys),
        selectKeys(expectedHostConfig, capabilityKeys),
      )
    ) {
      throw new Error("created Prime container capabilities do not match admission");
    }
    if (!isDockerJsonEqual(actualHostConfig.SecurityOpt, expectedHostConfig.SecurityOpt)) {
      throw new Error("created Prime container security options do not match admission");
    }
    if (
      !isDockerJsonEqual(
        omitKeys(actualHostConfig, [...capabilityKeys, "SecurityOpt"]),
        omitKeys(expectedHostConfig, [...capabilityKeys, "SecurityOpt"]),
      )
    ) {
      throw new Error("created Prime container control policy does not match admission");
    }
  }
}

function toIntentLease(
  lease: Exclude<EvaluationOciLease, PrimeOciIntentLease>,
): PrimeOciIntentLease {
  const { containerId: _containerId, inspectedPolicyDigest: _digest, ...rest } = lease;
  return { ...rest, state: "intent" } as PrimeOciIntentLease;
}

function dockerLabels(intent: PrimeOciIntentLease): Record<string, string> {
  return {
    "flow.evaluation-id": intent.labels.evaluationId,
    "flow.trial-id": intent.labels.trialId,
    "flow.owner-nonce": intent.labels.ownerNonce,
    "flow.image-id": intent.labels.imageId,
    "flow.policy-digest": intent.labels.policyDigest,
  };
}

function selectConfig(configuration: Record<string, unknown>): Record<string, unknown> {
  return {
    Image: configuration.Image,
    Hostname: configuration.Hostname,
    Domainname: configuration.Domainname,
    User: configuration.User,
    WorkingDir: configuration.WorkingDir,
    Entrypoint: configuration.Entrypoint,
    Cmd: configuration.Cmd,
    Env: configuration.Env,
    Labels: configuration.Labels,
    OpenStdin: configuration.OpenStdin,
    StdinOnce: configuration.StdinOnce,
    AttachStdin: configuration.AttachStdin,
    AttachStdout: configuration.AttachStdout,
    AttachStderr: configuration.AttachStderr,
    Tty: configuration.Tty,
    Healthcheck: configuration.Healthcheck,
    StopTimeout: configuration.StopTimeout,
  };
}

function selectHostConfig(configuration: Record<string, unknown>): Record<string, unknown> {
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
    "Tmpfs",
    "Ulimits",
    "BlkioDeviceReadBps",
    "BlkioDeviceReadIOps",
  ] as const;
  return Object.fromEntries(keys.map((key) => [key, configuration[key]]));
}

function selectKeys<const Key extends string>(
  value: Record<string, unknown>,
  keys: readonly Key[],
): Record<Key, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Record<Key, unknown>;
}

function omitKeys(
  value: Record<string, unknown>,
  omittedKeys: readonly string[],
): Record<string, unknown> {
  const omitted = new Set(omittedKeys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}

function isDockerJsonEqual(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(normalizeDockerJson(actual), normalizeDockerJson(expected));
}

function normalizeDockerJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDockerJson(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      normalizeDockerJson(item),
    ]),
  );
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
