import { mkdtemp, open, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { LeanProofRuntimeIdentity } from "../../../../src/domain/proof/lean-proof-verification.js";
import {
  createLeanProofOciAttestation,
  LocalLeanProofRuntimeAdmission,
} from "../../../../src/infrastructure/oci/local-lean-proof-runtime-admission.js";

describe("local Lean proof runtime admission", () => {
  it("admits only an exact reproducible descriptor and current Linux x64 image", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-proof-admission-"));
    const descriptorPath = join(root, "attestation.json");
    const input = attestationInput();
    const descriptor = createLeanProofOciAttestation(input);
    await writePrivate(descriptorPath, descriptor);
    const inspectImage = vi.fn(async () => imageInspection(descriptor));
    const admission = new LocalLeanProofRuntimeAdmission({ descriptorPath, inspectImage });

    await expect(admission.admit(descriptor.runtime)).resolves.toBeUndefined();
    expect(inspectImage).toHaveBeenCalledWith(descriptor.runtime.imageDigest);

    await expect(
      admission.admit({ ...descriptor.runtime, profileDigest: "f".repeat(64) }),
    ).rejects.toThrow(/attestation|identity|profile/i);
  });

  it("rejects a changed or non-x64 installed image", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-proof-image-drift-"));
    const descriptorPath = join(root, "attestation.json");
    const descriptor = createLeanProofOciAttestation(attestationInput());
    await writePrivate(descriptorPath, descriptor);
    const admission = new LocalLeanProofRuntimeAdmission({
      descriptorPath,
      inspectImage: async () => ({ ...imageInspection(descriptor), Architecture: "arm64" }),
    });

    await expect(admission.admit(descriptor.runtime)).rejects.toThrow(/Linux x64|image/i);
  });

  it("requires full Git commit IDs instead of SHA-256-shaped pseudo-revisions", () => {
    const input = attestationInput();

    expect(() =>
      createLeanProofOciAttestation({
        ...input,
        runtime: { ...input.runtime, mathlibRevision: "3".repeat(64) },
      }),
    ).toThrow(/invalid runtime identity/i);
  });

  it("does not follow an attestation symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-proof-attestation-link-"));
    const descriptorPath = join(root, "attestation.json");
    await symlink("/etc/passwd", descriptorPath);
    const admission = new LocalLeanProofRuntimeAdmission({
      descriptorPath,
      inspectImage: async () => null,
    });

    await expect(
      admission.admit(runtimeWithoutAttestation() as LeanProofRuntimeIdentity),
    ).rejects.toThrow(/symbolic link|attestation/i);
  });
});

function attestationInput() {
  const runtime = runtimeWithoutAttestation();
  return {
    runtime,
    reproducibility: {
      firstImageDigest: runtime.imageDigest,
      secondImageDigest: runtime.imageDigest,
      identical: true as const,
    },
    builder: {
      buildkitImage: `moby/buildkit:buildx-stable-1@sha256:${"8".repeat(64)}`,
      buildkitImageDigest: `sha256:${"8".repeat(64)}`,
    },
    artifacts: {
      supervisorSha256: "9".repeat(64),
      safeVerifySha256: "a".repeat(64),
      lean4exportSha256: "b".repeat(64),
      nanodaSha256: "c".repeat(64),
      mathlibManifestSha256: "d".repeat(64),
    },
  };
}

function runtimeWithoutAttestation() {
  return {
    version: 1 as const,
    platform: "linux" as const,
    architecture: "x64" as const,
    imageDigest: `sha256:${"1".repeat(64)}`,
    dependencyManifestDigest: "2".repeat(64),
    leanVersion: "4.33.1",
    mathlibRevision: "3".repeat(40),
    safeVerifyRevision: "4".repeat(40),
    nanodaRevision: "5".repeat(40),
    profileDigest: "6".repeat(64),
  };
}

function imageInspection(descriptor: ReturnType<typeof createLeanProofOciAttestation>) {
  return {
    Id: descriptor.runtime.imageDigest,
    Os: "linux",
    Architecture: "amd64",
    Config: {
      User: "0:10001",
      WorkingDir: "/workspace",
      Entrypoint: ["/opt/flow/bin/flow-proof-supervisor"],
      Labels: {
        "ai.synapti.flow.proof.profile": descriptor.runtime.profileDigest,
        "ai.synapti.flow.proof.dependencies": descriptor.runtime.dependencyManifestDigest,
        "ai.synapti.flow.proof.supervisor": descriptor.artifacts.supervisorSha256,
        "ai.synapti.flow.proof.safe-verify": descriptor.artifacts.safeVerifySha256,
        "ai.synapti.flow.proof.lean4export": descriptor.artifacts.lean4exportSha256,
        "ai.synapti.flow.proof.nanoda": descriptor.artifacts.nanodaSha256,
        "ai.synapti.flow.proof.mathlib-manifest": descriptor.artifacts.mathlibManifestSha256,
      },
    },
  };
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
  } finally {
    await handle.close();
  }
}
