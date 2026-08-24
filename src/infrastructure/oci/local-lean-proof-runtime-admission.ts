import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import type { LeanProofRuntimeIdentity } from "../../domain/proof/lean-proof-verification.js";
import { parseStrictJson } from "../../domain/strict-json.js";

const MAX_ATTESTATION_BYTES = 65_536;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type LeanProofRuntimeWithoutAttestation = Omit<
  LeanProofRuntimeIdentity,
  "buildAttestationDigest"
>;

export interface LeanProofOciAttestationInput {
  readonly runtime: LeanProofRuntimeWithoutAttestation;
  readonly reproducibility: {
    readonly firstImageDigest: string;
    readonly secondImageDigest: string;
    readonly identical: true;
  };
  readonly builder: {
    readonly buildkitImage: string;
    readonly buildkitImageDigest: string;
  };
  readonly artifacts: {
    readonly supervisorSha256: string;
    readonly safeVerifySha256: string;
    readonly lean4exportSha256: string;
    readonly nanodaSha256: string;
    readonly mathlibManifestSha256: string;
  };
}

export interface LeanProofOciAttestation {
  readonly version: 1;
  readonly runtime: LeanProofRuntimeIdentity;
  readonly reproducibility: LeanProofOciAttestationInput["reproducibility"];
  readonly builder: LeanProofOciAttestationInput["builder"];
  readonly artifacts: LeanProofOciAttestationInput["artifacts"];
  readonly attestationDigest: string;
}

export interface LocalLeanProofRuntimeAdmissionOptions {
  readonly descriptorPath: string;
  readonly inspectImage: (reference: string) => Promise<Record<string, unknown> | null>;
  readonly expectedUid?: number;
}

export function createLeanProofOciAttestation(
  input: LeanProofOciAttestationInput,
): LeanProofOciAttestation {
  validateRuntimeWithoutAttestation(input.runtime);
  validateReproducibility(input.reproducibility, input.runtime.imageDigest);
  validateBuilder(input.builder);
  validateArtifacts(input.artifacts);
  const payload = {
    version: 1 as const,
    runtime: { ...input.runtime },
    reproducibility: { ...input.reproducibility },
    builder: { ...input.builder },
    artifacts: { ...input.artifacts },
  };
  const attestationDigest = sha256(JSON.stringify(payload));
  return deepFreeze({
    version: 1,
    runtime: { ...input.runtime, buildAttestationDigest: attestationDigest },
    reproducibility: payload.reproducibility,
    builder: payload.builder,
    artifacts: payload.artifacts,
    attestationDigest,
  });
}

export function parseLeanProofOciAttestation(value: unknown): LeanProofOciAttestation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "runtime",
      "reproducibility",
      "builder",
      "artifacts",
      "attestationDigest",
    ])
  ) {
    throw new Error("Lean proof OCI attestation violates the closed schema");
  }
  const runtime = value.runtime;
  if (!isRecord(runtime) || typeof runtime.buildAttestationDigest !== "string") {
    throw new Error("Lean proof OCI attestation has an invalid runtime identity");
  }
  const { buildAttestationDigest: _digest, ...withoutAttestation } = runtime;
  const reconstructed = createLeanProofOciAttestation({
    runtime: withoutAttestation as unknown as LeanProofRuntimeWithoutAttestation,
    reproducibility: value.reproducibility as LeanProofOciAttestationInput["reproducibility"],
    builder: value.builder as LeanProofOciAttestationInput["builder"],
    artifacts: value.artifacts as LeanProofOciAttestationInput["artifacts"],
  });
  if (
    !isDeepStrictEqual(JSON.parse(JSON.stringify(reconstructed)), JSON.parse(JSON.stringify(value)))
  ) {
    throw new Error("Lean proof OCI attestation digest or identity is inconsistent");
  }
  return reconstructed;
}

export class LocalLeanProofRuntimeAdmission {
  readonly #descriptorPath: string;
  readonly #expectedUid: number;

  constructor(private readonly options: LocalLeanProofRuntimeAdmissionOptions) {
    this.#descriptorPath = options.descriptorPath;
    this.#expectedUid = options.expectedUid ?? currentUid();
  }

  async admit(runtime: LeanProofRuntimeIdentity): Promise<void> {
    const descriptor = await this.#readDescriptor();
    if (!isDeepStrictEqual(runtime, descriptor.runtime)) {
      throw new Error("selected Lean proof runtime identity contradicts its local attestation");
    }
    const inspection = await this.options.inspectImage(runtime.imageDigest);
    if (inspection === null) {
      throw new Error("attested Lean proof image is not installed");
    }
    validateImageInspection(inspection, descriptor);
  }

  async #readDescriptor(): Promise<LeanProofOciAttestation> {
    let handle: FileHandle;
    try {
      handle = await open(this.#descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw new Error(
        "Lean proof runtime attestation cannot be opened without following symbolic links",
        {
          cause: error,
        },
      );
    }
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.uid !== this.#expectedUid ||
        (metadata.mode & 0o077) !== 0
      ) {
        throw new Error("Lean proof runtime attestation is not an owner-private regular file");
      }
      if (metadata.size > MAX_ATTESTATION_BYTES) {
        throw new Error(`Lean proof runtime attestation exceeds ${MAX_ATTESTATION_BYTES} bytes`);
      }
      const bytes = Buffer.alloc(metadata.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset !== bytes.byteLength) {
        throw new Error("Lean proof runtime attestation ended before its recorded size");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new Error("Lean proof runtime attestation is not valid UTF-8", { cause: error });
      }
      return parseLeanProofOciAttestation(
        parseStrictJson(text, {
          maxDepth: 16,
          maxNodes: 256,
          valueLabel: "Lean proof OCI attestation",
        }),
      );
    } finally {
      await handle.close();
    }
  }
}

function validateImageInspection(
  inspection: Record<string, unknown>,
  descriptor: LeanProofOciAttestation,
): void {
  if (
    inspection.Id !== descriptor.runtime.imageDigest ||
    inspection.Os !== "linux" ||
    inspection.Architecture !== "amd64"
  ) {
    throw new Error("installed Lean proof image does not match the attested Linux x64 identity");
  }
  const configuration = requireRecord(inspection.Config, "Lean proof image configuration");
  const labels = requireRecord(configuration.Labels, "Lean proof image labels");
  if (
    configuration.User !== "0:10001" ||
    configuration.WorkingDir !== "/workspace" ||
    !sameStrings(configuration.Entrypoint, ["/opt/flow/bin/flow-proof-supervisor"])
  ) {
    throw new Error("installed Lean proof image startup identity contradicts the attestation");
  }
  const expected = {
    "ai.synapti.flow.proof.profile": descriptor.runtime.profileDigest,
    "ai.synapti.flow.proof.dependencies": descriptor.runtime.dependencyManifestDigest,
    "ai.synapti.flow.proof.supervisor": descriptor.artifacts.supervisorSha256,
    "ai.synapti.flow.proof.safe-verify": descriptor.artifacts.safeVerifySha256,
    "ai.synapti.flow.proof.lean4export": descriptor.artifacts.lean4exportSha256,
    "ai.synapti.flow.proof.nanoda": descriptor.artifacts.nanodaSha256,
    "ai.synapti.flow.proof.mathlib-manifest": descriptor.artifacts.mathlibManifestSha256,
  };
  if (Object.entries(expected).some(([key, expectedValue]) => labels[key] !== expectedValue)) {
    throw new Error("installed Lean proof image component labels contradict the attestation");
  }
}

function validateRuntimeWithoutAttestation(value: LeanProofRuntimeWithoutAttestation): void {
  if (
    !hasExactKeys(value as unknown as Record<string, unknown>, [
      "version",
      "platform",
      "architecture",
      "imageDigest",
      "dependencyManifestDigest",
      "leanVersion",
      "mathlibRevision",
      "safeVerifyRevision",
      "nanodaRevision",
      "profileDigest",
    ]) ||
    value.version !== 1 ||
    value.platform !== "linux" ||
    value.architecture !== "x64" ||
    !IMAGE_DIGEST_PATTERN.test(value.imageDigest) ||
    !/^\d+\.\d+\.\d+$/.test(value.leanVersion) ||
    ![value.dependencyManifestDigest, value.profileDigest].every((digest) =>
      SHA256_PATTERN.test(digest),
    ) ||
    ![value.mathlibRevision, value.safeVerifyRevision, value.nanodaRevision].every((revision) =>
      GIT_COMMIT_PATTERN.test(revision),
    )
  ) {
    throw new Error("Lean proof OCI attestation has an invalid runtime identity");
  }
}

function validateReproducibility(
  value: LeanProofOciAttestationInput["reproducibility"],
  imageDigest: string,
): void {
  if (
    !hasExactKeys(value as unknown as Record<string, unknown>, [
      "firstImageDigest",
      "secondImageDigest",
      "identical",
    ]) ||
    value.identical !== true ||
    value.firstImageDigest !== imageDigest ||
    value.secondImageDigest !== imageDigest
  ) {
    throw new Error("Lean proof OCI attestation does not prove two identical clean builds");
  }
}

function validateBuilder(value: LeanProofOciAttestationInput["builder"]): void {
  if (
    !hasExactKeys(value as unknown as Record<string, unknown>, [
      "buildkitImage",
      "buildkitImageDigest",
    ]) ||
    !/^moby\/buildkit:[a-z0-9.-]+@sha256:[a-f0-9]{64}$/.test(value.buildkitImage) ||
    !IMAGE_DIGEST_PATTERN.test(value.buildkitImageDigest) ||
    !value.buildkitImage.endsWith(`@${value.buildkitImageDigest}`)
  ) {
    throw new Error("Lean proof OCI attestation has an invalid exact builder identity");
  }
}

function validateArtifacts(value: LeanProofOciAttestationInput["artifacts"]): void {
  if (
    !hasExactKeys(value as unknown as Record<string, unknown>, [
      "supervisorSha256",
      "safeVerifySha256",
      "lean4exportSha256",
      "nanodaSha256",
      "mathlibManifestSha256",
    ]) ||
    !Object.values(value).every((digest) => SHA256_PATTERN.test(digest))
  ) {
    throw new Error("Lean proof OCI attestation has invalid component identities");
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const observed = Object.keys(value);
  return observed.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Lean proof admission requires a POSIX user identity");
  return uid;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
