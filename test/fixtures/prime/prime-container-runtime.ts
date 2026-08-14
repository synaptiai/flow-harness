import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExternalHarnessIdentity } from "../../../src/domain/evaluation/external-harness.js";
import type { PrimeOciAttachedTransport } from "../../../src/infrastructure/oci/attached-prime-oci-operator.js";
import { DockerUnixApiClient } from "../../../src/infrastructure/oci/docker-unix-api-client.js";
import { LocalDockerPrimeOciEngine } from "../../../src/infrastructure/oci/local-docker-prime-oci-engine.js";
import type {
  PrimeOciCreatedIdentity,
  PrimeOciIntentLease,
} from "../../../src/infrastructure/oci/prime-container-lifecycle.js";
import { resolvePrimeImageDevice } from "../../../src/infrastructure/oci/prime-oci-image-device.js";

const executeFile = promisify(execFile);
type PrimeIdentity = Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "prime-agent-native-v1" }
>;
type VerifiedPrimeDockerApi = Pick<
  DockerUnixApiClient,
  | "attachContainer"
  | "createContainer"
  | "inspectContainer"
  | "removeContainer"
  | "startContainer"
  | "stopContainer"
>;

export interface VerifiedPrimeContainerTransport extends PrimeOciAttachedTransport {
  readonly containerId: string;
  readonly containerName: string;
  readonly imageDevice: {
    readonly path: string;
    readonly major: number;
    readonly minor: number;
  };
  forceRemove(): Promise<void>;
}

export interface VerifiedPrimeContainerOptions {
  readonly api?: VerifiedPrimeDockerApi;
  readonly assertCurrent?: () => Promise<void>;
  readonly dockerExecutable?: string;
  readonly imageDevice?: {
    readonly path: string;
    readonly major: number;
    readonly minor: number;
  };
  readonly seccompProfile: Readonly<Record<string, unknown>>;
  readonly temporaryRoot?: string;
}

export async function startVerifiedPrimeContainer(
  identity: PrimeIdentity,
  options: VerifiedPrimeContainerOptions,
): Promise<VerifiedPrimeContainerTransport> {
  const imageId = identity.image.id;
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error("verified Prime container requires one full image ID");
  }
  const docker =
    options.dockerExecutable ?? process.env.FLOW_DOCKER_EXECUTABLE ?? "/usr/bin/docker";
  const operationRoot = await mkdtemp(
    join(options.temporaryRoot ?? tmpdir(), "flow-prime-runtime-container-"),
  );
  const containerName = `flow-prime-${randomUUID().replaceAll("-", "")}`;
  const environment = {
    HOME: operationRoot,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    DOCKER_CONFIG: operationRoot,
  };
  let imageDevice: { readonly path: string; readonly major: number; readonly minor: number };
  try {
    imageDevice = options.imageDevice ?? (await resolveDockerImageDevice(docker, environment));
    if (!/^\/dev\/[a-zA-Z0-9._/-]+$/.test(imageDevice.path)) {
      throw new Error("verified Prime container received an invalid image device path");
    }
  } catch (error) {
    await rm(operationRoot, { recursive: true, force: true });
    throw error;
  }
  await rm(operationRoot, { recursive: true, force: true });

  assertSeccompIdentity(identity, options.seccompProfile);
  const api =
    options.api ??
    new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: identity.runtime.engine.apiVersion,
    });
  const engine = new LocalDockerPrimeOciEngine({
    api,
    identity,
    seccompProfile: options.seccompProfile,
    imageDevice,
  });
  const intent = verifiedIntent(identity, containerName);
  let containerId: string | undefined;
  let attachment: PrimeOciAttachedTransport | undefined;
  try {
    await options.assertCurrent?.();
    try {
      containerId = (await engine.create(intent)).containerId;
    } catch (createError) {
      try {
        const settled = await settleVerifiedCreate(engine, intent, options.assertCurrent);
        containerId = settled.created.containerId;
        if (settled.retryFailed) {
          throw new AggregateError(
            [createError, settled.retryError],
            "verified Prime container create failed during reconciliation",
          );
        }
      } catch (recoveryError) {
        if (recoveryError instanceof AggregateError) {
          throw recoveryError;
        }
        throw new AggregateError(
          [createError, recoveryError],
          "verified Prime container create outcome is not reconciled",
        );
      }
      throw createError;
    }
    attachment = await engine.attach(containerId);
    await options.assertCurrent?.();
    await engine.start(containerId);
  } catch (error) {
    if (containerId === undefined) {
      throw error;
    }
    const cleanupErrors: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cleanupError = await settleVerifiedContainer(engine, containerId).then(
        () => undefined,
        (cleanup: unknown) => cleanup,
      );
      if (cleanupError === undefined) {
        cleanupErrors.length = 0;
        break;
      }
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "verified Prime container setup failed");
    }
    throw error;
  }

  const verifiedContainerId = containerId;
  const verifiedAttachment = attachment;
  let activeSettlement: Promise<void> | undefined;
  let removed = false;
  return {
    containerId: verifiedContainerId,
    containerName,
    imageDevice,
    output: verifiedAttachment.output,
    write: (bytes, signal) => verifiedAttachment.write(bytes, signal),
    closeInput: (signal) => verifiedAttachment.closeInput(signal),
    release: () => settle(),
    forceRemove: () => settle(),
  };

  function settle(): Promise<void> {
    if (removed) {
      return Promise.resolve();
    }
    if (activeSettlement !== undefined) {
      return activeSettlement;
    }
    const attempt = settleVerifiedContainer(engine, verifiedContainerId);
    activeSettlement = attempt;
    attempt.then(
      () => {
        removed = true;
        if (activeSettlement === attempt) {
          activeSettlement = undefined;
        }
      },
      () => {
        if (activeSettlement === attempt) {
          activeSettlement = undefined;
        }
      },
    );
    return attempt;
  }
}

async function settleVerifiedCreate(
  engine: LocalDockerPrimeOciEngine,
  intent: PrimeOciIntentLease,
  assertCurrent: (() => Promise<void>) | undefined,
): Promise<
  | { readonly created: PrimeOciCreatedIdentity; readonly retryFailed: false }
  | {
      readonly created: PrimeOciCreatedIdentity;
      readonly retryError: unknown;
      readonly retryFailed: true;
    }
> {
  const recovered = await engine.recoverIntent(intent);
  if (recovered !== null) {
    return { created: recovered, retryFailed: false };
  }
  let retryFailed = false;
  let createError: unknown;
  try {
    await assertCurrent?.();
    return { created: await engine.create(intent), retryFailed: false };
  } catch (error) {
    retryFailed = true;
    createError = error;
  }
  const reconciled = await engine.recoverIntent(intent);
  if (reconciled !== null) {
    return { created: reconciled, retryError: createError, retryFailed };
  }
  throw new Error("verified Prime named create did not settle", { cause: createError });
}

async function settleVerifiedContainer(
  engine: LocalDockerPrimeOciEngine,
  reference: string,
): Promise<void> {
  const errors: unknown[] = [];
  await engine.stop(reference).catch((error: unknown) => errors.push(error));
  await engine.remove(reference).catch((error: unknown) => errors.push(error));
  await engine
    .confirmRemoved(reference)
    .then((removed) => {
      if (!removed) {
        errors.push(new Error("verified Prime container removal is not confirmed"));
      }
    })
    .catch((error: unknown) => errors.push(error));
  if (errors.length > 0) {
    throw new AggregateError(errors, "verified Prime container cleanup failed");
  }
}

function verifiedIntent(identity: PrimeIdentity, containerName: string): PrimeOciIntentLease {
  const ownerNonce = randomBytes(32).toString("hex");
  return {
    version: 1,
    adapter: "prime-agent-native-v1",
    state: "intent",
    ownerNonce,
    containerName,
    labels: {
      evaluationId: "verified-prime-runtime",
      trialId: `trial-${"b".repeat(48)}`,
      ownerNonce,
      imageId: identity.image.id,
      policyDigest: identity.runtime.policy.digest,
    },
    imageId: identity.image.id,
    policyDigest: identity.runtime.policy.digest,
    fixtureDigest: "f".repeat(64),
    engineEndpoint: {
      socketPath: "/var/run/docker.sock",
      device: 0,
      inode: 0,
      uid: 0,
      gid: 0,
      mode: 0o660,
    },
  };
}

function assertSeccompIdentity(
  identity: PrimeIdentity,
  seccompProfile: Readonly<Record<string, unknown>>,
): void {
  const digest = createHash("sha256").update(canonicalize(seccompProfile)).digest("hex");
  if (digest !== identity.runtime.policy.seccompSha256) {
    throw new Error("verified Prime seccomp profile contradicts its runtime identity");
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("verified Prime seccomp profile contains a non-JSON value");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

async function resolveDockerImageDevice(
  dockerExecutable: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly path: string; readonly major: number; readonly minor: number }> {
  const { stdout } = await executeFile(dockerExecutable, ["info", "--format={{.DockerRootDir}}"], {
    encoding: "utf8",
    env: environment,
    maxBuffer: 4_096,
    timeout: 10_000,
  });
  const dockerRoot = stdout.trim();
  if (!dockerRoot.startsWith("/") || Buffer.byteLength(dockerRoot, "utf8") > 4_095) {
    throw new Error("Docker returned an invalid storage root");
  }
  return resolvePrimeImageDevice(dockerRoot);
}
