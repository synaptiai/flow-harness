import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type PrimeExternalHarnessIdentity,
  parsePrimeOciImageIdentity,
  parsePrimeOciRuntimeIdentity,
} from "../../domain/evaluation/external-harness.js";
import {
  isPrimeDockerCommandCancellation,
  PrimeImageBuildStageError,
} from "./local-prime-image-builder.js";
import type { PrimeOciLocalRuntimeAttestation } from "./local-prime-oci-attestation.js";

const sha256Pattern = /^[a-f0-9]{64}$/;

export interface PrimeOciImageArtifacts {
  readonly driverSha256: string;
  readonly flowDistSha256: string;
  readonly kernelProxySha256: string;
  readonly noIoResourceLoaderSha256: string;
  readonly pythonLauncherSha256: string;
  readonly supervisorSha256: string;
}

export interface PrimeOciBuilderIdentity {
  readonly clientPath: string;
  readonly clientSha256: string;
  readonly imageId: string;
  readonly imageReference: string;
}

export interface PrimeOciPreparedBuild {
  readonly image: PrimeExternalHarnessIdentity["image"];
  readonly builder: PrimeOciBuilderIdentity;
  readonly artifacts: PrimeOciImageArtifacts;
  readonly harnessPackageContentSha256: string;
  readonly harnessDependencyClosureSha256: string;
}

export interface PrimeOciRuntimeInspection {
  readonly runtime: PrimeExternalHarnessIdentity["runtime"];
  readonly daemonId: string;
  readonly local: Omit<PrimeOciLocalRuntimeAttestation, "daemonId">;
}

export interface PrimeOciAttestationDescriptor {
  readonly version: 1;
  readonly runtime: PrimeExternalHarnessIdentity["runtime"];
  readonly image: PrimeExternalHarnessIdentity["image"];
  readonly builder: PrimeOciBuilderIdentity;
  readonly artifacts: PrimeOciImageArtifacts;
  readonly harnessPackageContentSha256: string;
  readonly harnessDependencyClosureSha256: string;
  readonly daemonId: string;
  readonly local: Omit<PrimeOciLocalRuntimeAttestation, "daemonId">;
}

export interface PrimeOciPreparationDependencies {
  readonly preflightRuntime?: () => Promise<PrimeOciRuntimeInspection>;
  readonly build: (buildNumber: 1 | 2) => Promise<PrimeOciPreparedBuild>;
  readonly inspectRuntime: () => Promise<PrimeOciRuntimeInspection>;
  readonly publish: (
    path: string,
    descriptor: PrimeOciAttestationDescriptor,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export type PrimeOciInspectionStage =
  | "read Docker version"
  | "read Docker information"
  | "inspect Docker socket"
  | "inspect host core policy"
  | "inspect host cgroup"
  | "prepare global lease root"
  | "inspect image backing device"
  | "inspect runtime executables"
  | "inspect seccomp policy"
  | "validate Docker runtime identity";

export class PrimeOciInspectionStageError extends Error {
  override readonly name = "PrimeOciInspectionStageError";

  constructor(
    readonly stage: PrimeOciInspectionStage,
    options?: ErrorOptions,
  ) {
    super(`Prime OCI runtime inspection failed during ${stage}`, options);
  }
}

class PrimeOciPreparationCancellationError extends Error {
  override readonly name = "AbortError";

  constructor(reason: unknown) {
    super("Prime OCI runtime preparation was cancelled", { cause: reason });
  }
}

export async function withPrimeOciInspectionStage<T>(
  stage: PrimeOciInspectionStage,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    if (isExactCancellation(error, signal)) {
      throw cancellationReason(signal);
    }
    if (error instanceof PrimeOciInspectionStageError) {
      throw error;
    }
    throw new PrimeOciInspectionStageError(stage, { cause: error });
  }
  throwIfAborted(signal);
  return result;
}

export async function settlePrimeOciInspectionStages<const Results extends readonly unknown[]>(
  operations: { readonly [Index in keyof Results]: Promise<Results[Index]> },
  signal?: AbortSignal,
): Promise<Results> {
  const settlements = await Promise.allSettled(operations);
  for (const settlement of settlements) {
    if (settlement.status === "rejected" && !isExactCancellation(settlement.reason, signal)) {
      throw settlement.reason;
    }
  }
  if (settlements.some((settlement) => settlement.status === "rejected")) {
    throw cancellationReason(signal);
  }
  return settlements.map((settlement) => {
    if (settlement.status === "rejected") {
      throw cancellationReason(signal);
    }
    return settlement.value;
  }) as unknown as Results;
}

export interface PrimeOciPreparationResult {
  readonly descriptorPath: string;
  readonly imageId: string;
  readonly imageManifestSha256: string;
  readonly sbomSha256: string;
}

export class PrimeOciPreparationError extends Error {
  override readonly name = "PrimeOciPreparationError";

  constructor(
    readonly code: "build_failed" | "non_reproducible" | "inspection_failed" | "publish_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export async function preparePrimeOciRuntime(
  input: { readonly descriptorPath: string; readonly signal?: AbortSignal },
  dependencies: PrimeOciPreparationDependencies,
): Promise<PrimeOciPreparationResult> {
  throwIfAborted(input.signal);
  if (dependencies.preflightRuntime !== undefined) {
    await runRuntimeInspection(dependencies.preflightRuntime, input.signal);
    throwIfAborted(input.signal);
  }
  const first = await runBuild(1, dependencies, input.signal);
  throwIfAborted(input.signal);
  const second = await runBuild(2, dependencies, input.signal);
  throwIfAborted(input.signal);
  if (!isDeepStrictEqual(first, second)) {
    throw new PrimeOciPreparationError(
      "non_reproducible",
      "Prime OCI clean builds produced different identities",
    );
  }

  const inspected = await runRuntimeInspection(dependencies.inspectRuntime, input.signal);
  throwIfAborted(input.signal);

  const descriptor = Object.freeze({
    version: 1 as const,
    runtime: inspected.runtime,
    image: first.image,
    builder: first.builder,
    artifacts: first.artifacts,
    harnessPackageContentSha256: first.harnessPackageContentSha256,
    harnessDependencyClosureSha256: first.harnessDependencyClosureSha256,
    daemonId: inspected.daemonId,
    local: inspected.local,
  });
  throwIfAborted(input.signal);
  try {
    await dependencies.publish(input.descriptorPath, descriptor, input.signal);
  } catch (error) {
    if (isExactCancellation(error, input.signal)) {
      throw cancellationReason(input.signal);
    }
    throw new PrimeOciPreparationError(
      "publish_failed",
      "Prime OCI local attestation publication failed",
      { cause: error },
    );
  }

  return Object.freeze({
    descriptorPath: input.descriptorPath,
    imageId: first.image.id,
    imageManifestSha256: first.image.ociManifestSha256,
    sbomSha256: first.image.sbomSha256,
  });
}

async function runRuntimeInspection(
  inspect: () => Promise<PrimeOciRuntimeInspection>,
  signal: AbortSignal | undefined,
): Promise<PrimeOciRuntimeInspection> {
  try {
    const inspected = await inspect();
    return await withPrimeOciInspectionStage("validate Docker runtime identity", async () =>
      normalizeInspection(inspected),
    );
  } catch (error) {
    if (isExactCancellation(error, signal)) {
      throw cancellationReason(signal);
    }
    throw new PrimeOciPreparationError(
      "inspection_failed",
      error instanceof PrimeOciInspectionStageError
        ? error.message
        : "Prime OCI runtime inspection failed",
      { cause: error },
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  throw cancellationReason(signal);
}

function cancellationReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new PrimeOciPreparationCancellationError(signal?.reason);
}

function isExactCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true &&
    (error === signal.reason ||
      isPrimeDockerCommandCancellation(error, signal) ||
      (error instanceof PrimeOciPreparationCancellationError && error.cause === signal.reason))
  );
}

async function runBuild(
  buildNumber: 1 | 2,
  dependencies: PrimeOciPreparationDependencies,
  signal: AbortSignal | undefined,
): Promise<PrimeOciPreparedBuild> {
  try {
    return normalizeBuild(await dependencies.build(buildNumber));
  } catch (error) {
    if (isExactCancellation(error, signal)) {
      throw cancellationReason(signal);
    }
    if (error instanceof PrimeOciPreparationError) {
      throw error;
    }
    throw new PrimeOciPreparationError(
      "build_failed",
      `Prime OCI clean build ${buildNumber} failed${
        error instanceof PrimeImageBuildStageError ? ` during ${error.stage}` : ""
      }`,
      { cause: error },
    );
  }
}

function normalizeBuild(input: PrimeOciPreparedBuild): PrimeOciPreparedBuild {
  const image = parsePrimeOciImageIdentity(input.image);
  const builder = normalizeBuilderIdentity(input.builder);
  const artifacts = normalizeImageArtifacts(input.artifacts);
  assertSha256(input.harnessPackageContentSha256, "Prime package content digest");
  assertSha256(input.harnessDependencyClosureSha256, "Prime dependency closure digest");
  return Object.freeze({
    image,
    builder,
    artifacts,
    harnessPackageContentSha256: input.harnessPackageContentSha256,
    harnessDependencyClosureSha256: input.harnessDependencyClosureSha256,
  });
}

function normalizeBuilderIdentity(input: PrimeOciBuilderIdentity): PrimeOciBuilderIdentity {
  if (!input.clientPath.startsWith("/") || input.clientPath.length > 4_095) {
    throw new Error("Prime Buildx client path is not one bounded absolute path");
  }
  if (!/^[a-f0-9]{64}$/.test(input.clientSha256)) {
    throw new Error("Prime Buildx client digest is not a SHA-256 digest");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.imageId)) {
    throw new Error("Prime BuildKit image ID is not a SHA-256 digest");
  }
  if (!/^moby\/buildkit:[a-z0-9.-]+@sha256:[a-f0-9]{64}$/.test(input.imageReference)) {
    throw new Error("Prime BuildKit image reference is not digest-pinned");
  }
  return Object.freeze({ ...input });
}

function normalizeImageArtifacts(input: PrimeOciImageArtifacts): PrimeOciImageArtifacts {
  for (const [name, value] of Object.entries(input)) {
    assertSha256(value, `Prime image artifact ${name}`);
  }
  return Object.freeze({ ...input });
}

function normalizeInspection(input: PrimeOciRuntimeInspection): PrimeOciRuntimeInspection {
  const runtime = parsePrimeOciRuntimeIdentity(input.runtime);
  if (input.daemonId.length < 1 || input.daemonId.length > 256) {
    throw new Error("Prime OCI daemon identity is outside its bounds");
  }
  if (input.local.apiVersion !== runtime.engine.apiVersion) {
    throw new Error("Prime OCI local API version contradicts the runtime identity");
  }
  if (input.local.corePattern.trimStart().startsWith("|")) {
    throw new PrimeOciInspectionStageError("inspect host core policy", {
      cause: new Error("Prime OCI host core pattern uses a piped handler"),
    });
  }
  const seccompSha256 = createHash("sha256")
    .update(canonicalize(input.local.seccompProfile))
    .digest("hex");
  if (seccompSha256 !== runtime.policy.seccompSha256) {
    throw new Error("Prime OCI seccomp profile contradicts the runtime policy");
  }
  return Object.freeze({
    runtime,
    daemonId: input.daemonId,
    local: input.local,
  });
}

function assertSha256(value: string, label: string): void {
  if (!sha256Pattern.test(value)) {
    throw new Error(`${label} is not a lowercase SHA-256 digest`);
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
    throw new Error("Prime OCI seccomp profile contains a non-JSON value");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
