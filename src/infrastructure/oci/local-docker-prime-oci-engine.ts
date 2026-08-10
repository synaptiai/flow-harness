import { isDeepStrictEqual } from "node:util";

import type { ExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import type { DockerUnixApiClient } from "./docker-unix-api-client.js";
import type {
  PrimeOciCreatedIdentity,
  PrimeOciEngine,
  PrimeOciIntentLease,
} from "./prime-container-lifecycle.js";

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
      User: `${policy.supervisorUid}:${policy.sharedGid}`,
      WorkingDir: "/workspace",
      Env: ["PRIME_AGENT_KERNEL_FORKSERVER=0"],
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
      IpcMode: "none",
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
    const expected = {
      Id: containerId,
      Name: `/${intent.containerName}`,
      Image: intent.imageId,
      Config: selectConfig(this.#configuration(intent)),
      HostConfig: this.#hostConfiguration(),
    };
    const actual = {
      Id: inspection.Id,
      Name: inspection.Name,
      Image: inspection.Image,
      Config: selectConfig(asObject(inspection.Config, "Docker Config")),
      HostConfig: selectHostConfig(asObject(inspection.HostConfig, "Docker HostConfig")),
    };
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error("created Prime container control policy does not match admission");
    }
  }
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
    User: configuration.User,
    WorkingDir: configuration.WorkingDir,
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
    "IpcMode",
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
    "Tmpfs",
    "Ulimits",
    "BlkioDeviceReadBps",
    "BlkioDeviceReadIOps",
  ] as const;
  return Object.fromEntries(keys.map((key) => [key, configuration[key]]));
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
