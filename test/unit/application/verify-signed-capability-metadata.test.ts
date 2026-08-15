import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createSignedCapabilityMetadataVerifier } from "../../../src/application/verify-signed-capability-metadata.js";
import { CapabilityMetadataError } from "../../../src/domain/capability/capability-metadata.js";
import {
  SigstoreCapabilityVerificationError,
  type SigstoreCapabilityVerifier,
} from "../../../src/domain/capability/sigstore-capability-verifier.js";

const policy = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/metadata-v1",
});
const now = new Date("2026-08-14T00:00:00.000Z");

describe("signed capability metadata verifier", () => {
  it("returns defensively owned exact bytes, parsed metadata, and derived authority", async () => {
    const metadata = metadataBytes();
    const sigstoreBundle = Buffer.from("PRIVATE_SIGSTORE_PROOF");
    const verify = vi.fn(() => policy);
    const service = createSignedCapabilityMetadataVerifier({
      verify,
    } satisfies SigstoreCapabilityVerifier);

    const result = await service.verify({ metadata, sigstoreBundle, ...policy, now });

    expect(verify).toHaveBeenCalledWith(metadata, sigstoreBundle, policy);
    expect(result.metadata).toMatchObject({
      name: "project-capabilities",
      version: 1,
      digest: `sha256:${createHash("sha256").update(metadata).digest("hex")}`,
    });
    expect(result.authority).toEqual({
      kind: "sigstore-keyless-v0.3",
      ...policy,
      signatureBundleDigest: `sha256:${createHash("sha256").update(sigstoreBundle).digest("hex")}`,
    });
    expect(result.metadataBytes()).toEqual(metadata);
    expect(result.sigstoreBundleBytes()).toEqual(sigstoreBundle);

    result.metadataBytes().fill(0);
    result.sigstoreBundleBytes().fill(0);
    expect(result.metadataBytes()).toEqual(metadata);
    expect(result.sigstoreBundleBytes()).toEqual(sigstoreBundle);
  });

  it("preserves exact pre-existing cancellation before parsing", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled metadata verification");
    controller.abort(reason);
    const verify = vi.fn();
    const service = createSignedCapabilityMetadataVerifier({ verify });

    await expect(
      service.verify({
        metadata: Buffer.from("PRIVATE_INVALID_METADATA"),
        sigstoreBundle: Buffer.from("PRIVATE_SIGSTORE_PROOF"),
        ...policy,
        now,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(verify).not.toHaveBeenCalled();
  });

  it("preserves exact cancellation after synchronous signature verification", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled after signature verification");
    const verify = vi.fn(() => {
      controller.abort(reason);
      return policy;
    });
    const service = createSignedCapabilityMetadataVerifier({ verify });

    await expect(
      service.verify({
        metadata: metadataBytes(),
        sigstoreBundle: Buffer.from("PRIVATE_SIGSTORE_PROOF"),
        ...policy,
        now,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("rejects invalid metadata before signature verification", async () => {
    const verify = vi.fn();
    const service = createSignedCapabilityMetadataVerifier({ verify });

    await expect(
      service.verify({
        metadata: Buffer.from(`${metadataBytes().toString("utf8")}\n`),
        sigstoreBundle: Buffer.from("PRIVATE_SIGSTORE_PROOF"),
        ...policy,
        now,
      }),
    ).rejects.toEqual(new CapabilityMetadataError("validate metadata"));
    expect(verify).not.toHaveBeenCalled();
  });

  it("preserves the verifier's fixed signature failure", async () => {
    const failure = new SigstoreCapabilityVerificationError("verify publisher signature");
    const service = createSignedCapabilityMetadataVerifier({
      verify: vi.fn(() => {
        throw failure;
      }),
    });

    await expect(
      service.verify({
        metadata: metadataBytes(),
        sigstoreBundle: Buffer.from("PRIVATE_SIGSTORE_PROOF"),
        ...policy,
        now,
      }),
    ).rejects.toBe(failure);
  });
});

function metadataBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityMetadata",
      metadata: {
        name: "project-capabilities",
        version: 1,
        expiresAt: "2026-08-15T00:00:00.000Z",
      },
      spec: {
        targets: [
          {
            name: "review-suite",
            version: "1.0.0",
            digest: `sha256:${"a".repeat(64)}`,
            bytes: 4096,
            source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
            status: "active",
          },
        ],
      },
    }),
  );
}
