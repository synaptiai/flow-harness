import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateCapabilityMetadataCandidate,
  CapabilityMetadataActivationError,
} from "../../../src/application/activate-capability-metadata-candidate.js";
import { createCapabilityMetadataCandidate } from "../../../src/application/capability-metadata-candidate.js";
import { StoredCapabilityMetadataCandidate } from "../../../src/application/capability-metadata-candidate-store.js";
import type { RefreshCapabilityMetadataResult } from "../../../src/application/capability-package-store.js";
import { createSignedCapabilityMetadataVerifier } from "../../../src/application/verify-signed-capability-metadata.js";
import { parseCapabilityMetadata } from "../../../src/domain/capability/capability-metadata.js";
import { SigstoreCapabilityVerificationError } from "../../../src/domain/capability/sigstore-capability-verifier.js";
import { LocalCapabilityPackageStore } from "../../../src/infrastructure/fs/local-capability-package-store.js";

const policy = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/metadata-v1",
});
const now = new Date("2026-08-14T00:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("capability metadata candidate activation", () => {
  it("reopens, re-verifies, re-identifies, and delegates active publication in order", async () => {
    const events: string[] = [];
    const stored = storedCandidate();
    const read = vi.fn(async () => {
      events.push("read");
      return stored;
    });
    const verify = vi.fn(() => {
      events.push("verify");
      return policy;
    });
    const refreshMetadata = vi.fn(async (input): Promise<RefreshCapabilityMetadataResult> => {
      events.push("refresh");
      return { status: "established", state: activeResult(input) };
    });

    const result = await activateCapabilityMetadataCandidate(
      {
        candidates: { read },
        verifier: createSignedCapabilityMetadataVerifier({ verify }),
        activeMetadata: { refreshMetadata },
        now: () => new Date(now),
      },
      { candidateDigest: stored.candidate.candidateDigest, ...policy },
    );

    expect(events).toEqual(["read", "verify", "refresh"]);
    expect(verify).toHaveBeenCalledWith(
      stored.metadataBytes(),
      stored.sigstoreBundleBytes(),
      policy,
    );
    expect(result).toMatchObject({ status: "established", state: { version: 1 } });
    expect(refreshMetadata).toHaveBeenCalledWith({
      metadata: expect.objectContaining({ version: 1 }),
      authority: expect.objectContaining(policy),
    });
  });

  it("requires the supplied signer policy independently from the candidate", async () => {
    const stored = storedCandidate();
    const failure = new SigstoreCapabilityVerificationError("verify publisher signature");
    const refreshMetadata = vi.fn();
    const substitutedIdentity = "https://publisher.example.test/PRIVATE_SUBSTITUTE";
    const verify = vi.fn((_metadata, _bundle, suppliedPolicy) => {
      if (suppliedPolicy.certificateIdentity === substitutedIdentity) {
        throw failure;
      }
      return policy;
    });

    await expect(
      activateCapabilityMetadataCandidate(
        {
          candidates: { read: vi.fn(async () => stored) },
          verifier: createSignedCapabilityMetadataVerifier({ verify }),
          activeMetadata: { refreshMetadata },
          now: () => new Date(now),
        },
        {
          candidateDigest: stored.candidate.candidateDigest,
          certificateIssuer: policy.certificateIssuer,
          certificateIdentity: substitutedIdentity,
        },
      ),
    ).rejects.toBe(failure);
    expect(verify).toHaveBeenCalledWith(stored.metadataBytes(), stored.sigstoreBundleBytes(), {
      ...policy,
      certificateIdentity: substitutedIdentity,
    });
    expect(refreshMetadata).not.toHaveBeenCalled();
  });

  it("requires the supplied signer issuer independently from the candidate", async () => {
    const stored = storedCandidate();
    const failure = new SigstoreCapabilityVerificationError("verify publisher signature");
    const refreshMetadata = vi.fn();
    const substitutedIssuer = "https://issuer.example.test/PRIVATE_SUBSTITUTE";
    const verify = vi.fn((_metadata, _bundle, suppliedPolicy) => {
      if (suppliedPolicy.certificateIssuer === substitutedIssuer) {
        throw failure;
      }
      return policy;
    });

    await expect(
      activateCapabilityMetadataCandidate(
        {
          candidates: { read: vi.fn(async () => stored) },
          verifier: createSignedCapabilityMetadataVerifier({ verify }),
          activeMetadata: { refreshMetadata },
          now: () => new Date(now),
        },
        {
          candidateDigest: stored.candidate.candidateDigest,
          certificateIssuer: substitutedIssuer,
          certificateIdentity: policy.certificateIdentity,
        },
      ),
    ).rejects.toBe(failure);
    expect(verify).toHaveBeenCalledWith(stored.metadataBytes(), stored.sigstoreBundleBytes(), {
      ...policy,
      certificateIssuer: substitutedIssuer,
    });
    expect(refreshMetadata).not.toHaveBeenCalled();
  });

  it.each([
    ["one millisecond before expiry", new Date("2026-08-14T23:59:59.999Z"), true],
    ["at exact expiry", new Date("2026-08-15T00:00:00.000Z"), false],
  ] as const)(
    "checks freshness %s with the activation clock",
    async (_label, instant, accepted) => {
      const stored = storedCandidate();
      const refreshMetadata = vi.fn(
        async (input): Promise<RefreshCapabilityMetadataResult> => ({
          status: "established",
          state: activeResult(input),
        }),
      );
      const operation = activateCapabilityMetadataCandidate(
        {
          candidates: { read: vi.fn(async () => stored) },
          verifier: createSignedCapabilityMetadataVerifier({ verify: vi.fn(() => policy) }),
          activeMetadata: { refreshMetadata },
          now: () => new Date(instant),
        },
        { candidateDigest: stored.candidate.candidateDigest, ...policy },
      );

      if (accepted) {
        await expect(operation).resolves.toMatchObject({ status: "established" });
        expect(refreshMetadata).toHaveBeenCalledOnce();
      } else {
        await expect(operation).rejects.toMatchObject({ stage: "validate freshness" });
        expect(refreshMetadata).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["read", "verify"] as const)(
    "preserves exact cancellation after candidate %s and starts no later mutation",
    async (boundary) => {
      const stored = storedCandidate();
      const controller = new AbortController();
      const reason = new Error(`operator cancelled after candidate ${boundary}`);
      const verify = vi.fn(() => {
        if (boundary === "verify") {
          controller.abort(reason);
        }
        return policy;
      });
      const refreshMetadata = vi.fn();
      const read = vi.fn(async () => {
        if (boundary === "read") {
          controller.abort(reason);
        }
        return stored;
      });

      await expect(
        activateCapabilityMetadataCandidate(
          {
            candidates: { read },
            verifier: createSignedCapabilityMetadataVerifier({ verify }),
            activeMetadata: { refreshMetadata },
            now: () => new Date(now),
          },
          {
            candidateDigest: stored.candidate.candidateDigest,
            ...policy,
            signal: controller.signal,
          },
        ),
      ).rejects.toBe(reason);
      expect(verify).toHaveBeenCalledTimes(boundary === "read" ? 0 : 1);
      expect(refreshMetadata).not.toHaveBeenCalled();
    },
  );

  it("rejects bytes that no longer derive the requested candidate identity", async () => {
    const stored = storedCandidate();
    const substituted = new StoredCapabilityMetadataCandidate({
      candidate: stored.candidate,
      metadata: metadataBytes(2),
      sigstoreBundle: stored.sigstoreBundleBytes(),
    });
    const refreshMetadata = vi.fn();

    await expect(
      activateCapabilityMetadataCandidate(
        {
          candidates: { read: vi.fn(async () => substituted) },
          verifier: createSignedCapabilityMetadataVerifier({ verify: vi.fn(() => policy) }),
          activeMetadata: { refreshMetadata },
          now: () => new Date(now),
        },
        { candidateDigest: stored.candidate.candidateDigest, ...policy },
      ),
    ).rejects.toEqual(new CapabilityMetadataActivationError("validate candidate identity"));
    expect(refreshMetadata).not.toHaveBeenCalled();
  });

  it("delegates rollback and equal-version substitution to the real monotonic active store", async () => {
    const projectRoot = await projectDirectory();
    await mkdir(join(projectRoot, ".flow"));
    const activeMetadata = new LocalCapabilityPackageStore(projectRoot, {
      now: () => new Date(now),
    });
    const current = storedCandidate({ version: 2 });
    const rollback = storedCandidate({ version: 1 });
    const substitution = storedCandidate({ version: 2, name: "private-substitute" });
    const candidates = new Map(
      [current, rollback, substitution].map((stored) => [stored.candidate.candidateDigest, stored]),
    );
    const verifier = createSignedCapabilityMetadataVerifier({ verify: vi.fn(() => policy) });
    const activate = async (stored: StoredCapabilityMetadataCandidate) =>
      await activateCapabilityMetadataCandidate(
        {
          candidates: {
            read: vi.fn(async (candidateDigest) => {
              const selected = candidates.get(candidateDigest);
              if (selected === undefined) {
                throw new Error("missing test candidate");
              }
              return selected;
            }),
          },
          verifier,
          activeMetadata,
          now: () => new Date(now),
        },
        { candidateDigest: stored.candidate.candidateDigest, ...policy },
      );

    await expect(activate(current)).resolves.toMatchObject({
      status: "established",
      state: { version: 2 },
    });
    const packageCanary = join(projectRoot, ".flow", "PRIVATE_INSTALLED_PACKAGE_CANARY");
    await writeFile(packageCanary, "PRIVATE_PACKAGE_BYTES");
    await expect(activate(rollback)).rejects.toMatchObject({ code: "metadata_rollback" });
    await expect(activate(substitution)).rejects.toMatchObject({ code: "metadata_rollback" });
    await expect(activeMetadata.inspectMetadata()).resolves.toMatchObject({
      name: "project-capabilities",
      version: 2,
      metadataDigest: current.candidate.metadata.digest,
    });
    await expect(readFile(packageCanary, "utf8")).resolves.toBe("PRIVATE_PACKAGE_BYTES");
    expect(candidates.size).toBe(3);
  });
});

function storedCandidate(
  options: { readonly version?: number; readonly name?: string } = {},
): StoredCapabilityMetadataCandidate {
  const metadata = metadataBytes(options.version ?? 1, options.name ?? "project-capabilities");
  const sigstoreBundle = Buffer.from("PRIVATE_SIGSTORE_PROOF");
  const authority = {
    kind: "sigstore-keyless-v0.3" as const,
    ...policy,
    signatureBundleDigest: digest(sigstoreBundle),
  };
  return new StoredCapabilityMetadataCandidate({
    candidate: createCapabilityMetadataCandidate({
      metadata: parseCapabilityMetadata(metadata, now),
      metadataBytes: metadata,
      sigstoreBundle,
      authority,
    }),
    metadata,
    sigstoreBundle,
  });
}

function metadataBytes(version: number, name = "project-capabilities"): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityMetadata",
      metadata: { name, version, expiresAt: "2026-08-15T00:00:00.000Z" },
      spec: { targets: [] },
    }),
  );
}

function digest(source: Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function activeResult(input: {
  metadata: ReturnType<typeof parseCapabilityMetadata>;
  authority: ReturnType<typeof authorityFixture>;
}) {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1" as const,
    kind: "CapabilityMetadataState" as const,
    name: input.metadata.name,
    version: input.metadata.version,
    expiresAt: input.metadata.expiresAt,
    metadataBytes: input.metadata.bytes,
    metadataDigest: input.metadata.digest,
    authority: input.authority,
    targets: input.metadata.targets,
  };
}

function authorityFixture() {
  return {
    kind: "sigstore-keyless-v0.3" as const,
    ...policy,
    signatureBundleDigest: `sha256:${"f".repeat(64)}`,
  };
}

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-metadata-activation-"));
  temporaryDirectories.push(directory);
  return directory;
}
