import { isDeepStrictEqual } from "node:util";

import type { ExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import type { DockerUnixApiClient } from "./docker-unix-api-client.js";
import {
  type PrimeGlobalSlotEngine,
  type PrimeGlobalSlotInspection,
  type PrimeGlobalSlotLease,
  PrimeGlobalAdmissionUnsafeStateError,
} from "./prime-global-admission.js";

type PrimeIdentity = Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "prime-agent-native-v1" }
>;

export interface LocalDockerPrimeGlobalSlotEngineOptions {
  readonly api: Pick<
    DockerUnixApiClient,
    "createContainer" | "inspectContainer" | "removeContainer"
  >;
  readonly identity: PrimeIdentity;
  readonly daemonId: string;
}

export class LocalDockerPrimeGlobalSlotEngine implements PrimeGlobalSlotEngine {
  constructor(private readonly options: LocalDockerPrimeGlobalSlotEngineOptions) {}

  async create(
    lease: PrimeGlobalSlotLease,
    signal?: AbortSignal,
  ): Promise<PrimeGlobalSlotInspection> {
    this.#assertLease(lease);
    const objectId = await this.options.api.createContainer(
      lease.lockName,
      configuration(this.options.identity, lease),
      signal,
    );
    const inspection = await this.options.api.inspectContainer(objectId, signal);
    if (inspection === null) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot create returned an object that cannot be inspected",
      );
    }
    return this.#parseInspection(inspection, objectId);
  }

  async inspect(
    reference: string,
    signal?: AbortSignal,
  ): Promise<PrimeGlobalSlotInspection | null> {
    const inspection = await this.options.api.inspectContainer(reference, signal);
    return inspection === null ? null : this.#parseInspection(inspection);
  }

  async remove(objectId: string, signal?: AbortSignal): Promise<void> {
    await this.options.api.removeContainer(objectId, signal);
  }

  async confirmRemoved(objectId: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.options.api.inspectContainer(objectId, signal)) === null;
  }

  #assertLease(lease: PrimeGlobalSlotLease): void {
    if (
      lease.state !== "intent" ||
      lease.lockName !== "flow-prime-global-v1" ||
      lease.policyDigest !== this.options.identity.runtime.policy.digest ||
      lease.daemonId !== this.options.daemonId
    ) {
      throw new Error("Prime global slot lease contradicts the admitted daemon or policy");
    }
  }

  #parseInspection(
    inspection: Record<string, unknown>,
    expectedObjectId?: string,
  ): PrimeGlobalSlotInspection {
    const objectId = requiredString(inspection.Id, "Prime global slot object ID");
    const config = requiredObject(inspection.Config, "Prime global slot Config");
    const labels = requiredObject(config.Labels, "Prime global slot labels");
    const ownerNonce = requiredString(labels["flow.prime-slot-owner"], "slot owner nonce");
    const policyDigest = requiredString(labels["flow.prime-slot-policy"], "slot policy digest");
    const daemonId = requiredString(labels["flow.prime-slot-daemon"], "slot daemon ID");
    const lease: PrimeGlobalSlotLease = {
      version: 1,
      state: "intent",
      lockName: "flow-prime-global-v1",
      ownerNonce,
      policyDigest,
      daemonId,
    };
    const expected = {
      Id: expectedObjectId ?? objectId,
      Name: "/flow-prime-global-v1",
      Image: this.options.identity.image.id,
      Config: selectConfig(configuration(this.options.identity, lease)),
      HostConfig: selectHostConfig(configuration(this.options.identity, lease).HostConfig),
      State: { Running: false },
    };
    const actual = {
      Id: inspection.Id,
      Name: inspection.Name,
      Image: inspection.Image,
      Config: selectConfig(config),
      HostConfig: selectHostConfig(inspection.HostConfig),
      State: { Running: requiredObject(inspection.State, "Prime global slot State").Running },
    };
    if (
      !/^[a-f0-9]{64}$/.test(objectId) ||
      !/^[a-f0-9]{64}$/.test(ownerNonce) ||
      policyDigest !== this.options.identity.runtime.policy.digest ||
      daemonId !== this.options.daemonId ||
      !isDeepStrictEqual(actual, expected)
    ) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot lock contradicts its admitted control policy",
      );
    }
    return Object.freeze({ objectId, ownerNonce, policyDigest, daemonId });
  }
}

function configuration(identity: PrimeIdentity, lease: PrimeGlobalSlotLease) {
  return {
    Image: identity.image.id,
    Labels: {
      "flow.prime-slot-version": "1",
      "flow.prime-slot-owner": lease.ownerNonce,
      "flow.prime-slot-policy": lease.policyDigest,
      "flow.prime-slot-daemon": lease.daemonId,
    },
    OpenStdin: false,
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    Healthcheck: { Test: ["NONE"] },
    HostConfig: {
      NetworkMode: "none",
      IpcMode: "none",
      ReadonlyRootfs: true,
      LogConfig: { Type: "none", Config: {} },
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
    },
  };
}

function selectConfig(value: unknown) {
  const config = requiredObject(value, "Prime global slot Config");
  return {
    Image: config.Image,
    Labels: config.Labels,
    OpenStdin: config.OpenStdin,
    AttachStdin: config.AttachStdin,
    AttachStdout: config.AttachStdout,
    AttachStderr: config.AttachStderr,
    Tty: config.Tty,
    Healthcheck: config.Healthcheck,
  };
}

function selectHostConfig(value: unknown) {
  const config = requiredObject(value, "Prime global slot HostConfig");
  return {
    NetworkMode: config.NetworkMode,
    IpcMode: config.IpcMode,
    ReadonlyRootfs: config.ReadonlyRootfs,
    LogConfig: config.LogConfig,
    RestartPolicy: config.RestartPolicy,
    AutoRemove: config.AutoRemove,
    CapDrop: config.CapDrop,
    SecurityOpt: config.SecurityOpt,
  };
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PrimeGlobalAdmissionUnsafeStateError(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new PrimeGlobalAdmissionUnsafeStateError(`${label} is not a string`);
  }
  return value;
}
