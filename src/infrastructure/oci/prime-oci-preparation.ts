import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type PrimeExternalHarnessIdentity,
  parsePrimeOciImageIdentity,
  parsePrimeOciRuntimeIdentity,
} from "../../domain/evaluation/external-harness.js";
import type { PrimeOciLocalRuntimeAttestation } from "./local-prime-oci-attestation.js";

const sha256Pattern = /^[a-f0-9]{64}$/;

export interface PrimeOciPreparedBuild {
  readonly image: PrimeExternalHarnessIdentity["image"];
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
  readonly harnessPackageContentSha256: string;
  readonly harnessDependencyClosureSha256: string;
  readonly daemonId: string;
  readonly local: Omit<PrimeOciLocalRuntimeAttestation, "daemonId">;
}

export interface PrimeOciPreparationDependencies {
  readonly build: (buildNumber: 1 | 2) => Promise<PrimeOciPreparedBuild>;
  readonly inspectRuntime: () => Promise<PrimeOciRuntimeInspection>;
  readonly publish: (path: string, descriptor: PrimeOciAttestationDescriptor) => Promise<void>;
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
  input: { readonly descriptorPath: string },
  dependencies: PrimeOciPreparationDependencies,
): Promise<PrimeOciPreparationResult> {
  const first = await runBuild(1, dependencies);
  const second = await runBuild(2, dependencies);
  if (!isDeepStrictEqual(first, second)) {
    throw new PrimeOciPreparationError(
      "non_reproducible",
      "Prime OCI clean builds produced different identities",
    );
  }

  let inspected: PrimeOciRuntimeInspection;
  try {
    inspected = normalizeInspection(await dependencies.inspectRuntime());
  } catch (error) {
    throw new PrimeOciPreparationError("inspection_failed", "Prime OCI runtime inspection failed", {
      cause: error,
    });
  }

  const descriptor = Object.freeze({
    version: 1 as const,
    runtime: inspected.runtime,
    image: first.image,
    harnessPackageContentSha256: first.harnessPackageContentSha256,
    harnessDependencyClosureSha256: first.harnessDependencyClosureSha256,
    daemonId: inspected.daemonId,
    local: inspected.local,
  });
  try {
    await dependencies.publish(input.descriptorPath, descriptor);
  } catch (error) {
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

async function runBuild(
  buildNumber: 1 | 2,
  dependencies: PrimeOciPreparationDependencies,
): Promise<PrimeOciPreparedBuild> {
  try {
    return normalizeBuild(await dependencies.build(buildNumber));
  } catch (error) {
    if (error instanceof PrimeOciPreparationError) {
      throw error;
    }
    throw new PrimeOciPreparationError(
      "build_failed",
      `Prime OCI clean build ${buildNumber} failed`,
      { cause: error },
    );
  }
}

function normalizeBuild(input: PrimeOciPreparedBuild): PrimeOciPreparedBuild {
  const image = parsePrimeOciImageIdentity(input.image);
  assertSha256(input.harnessPackageContentSha256, "Prime package content digest");
  assertSha256(input.harnessDependencyClosureSha256, "Prime dependency closure digest");
  return Object.freeze({
    image,
    harnessPackageContentSha256: input.harnessPackageContentSha256,
    harnessDependencyClosureSha256: input.harnessDependencyClosureSha256,
  });
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
    throw new Error("Prime OCI host core pattern uses a piped handler");
  }
  if (
    input.local.imageProbe.readBytesPerSecond < runtime.policy.minImageReadBytesPerSecond ||
    input.local.imageProbe.readOperationsPerSecond < runtime.policy.minImageReadOperationsPerSecond
  ) {
    throw new Error("Prime OCI image capacity is below the runtime policy");
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
