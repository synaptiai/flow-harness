import { readFileSync } from "node:fs";

import { TrustedRoot } from "@sigstore/protobuf-specs";
import { describe, expect, it } from "vitest";

import {
  MAX_SIGSTORE_BUNDLE_BYTES,
  SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
} from "../../../src/domain/capability/oci-capability-artifacts.js";
import {
  OfflineSigstoreCapabilityVerifier,
  SigstoreCapabilityVerificationError,
} from "../../../src/domain/capability/sigstore-capability-verifier.js";
import { createSigstorePublicGoodTrustedRoot } from "../../../src/infrastructure/sigstore-public-good-trusted-root.js";

interface OfflineFixture {
  readonly artifactBase64: string;
  readonly bundle: MutableBundleFixture;
  readonly trustedRoot: Record<string, unknown>;
}

interface MutableBundleFixture extends Record<string, unknown> {
  mediaType: string;
  verificationMaterial: {
    certificate?: unknown;
    publicKey?: unknown;
    tlogEntries: { inclusionProof?: unknown }[];
    timestampVerificationData: { rfc3161Timestamps: unknown[] };
  };
  messageSignature?: unknown;
  dsseEnvelope?: unknown;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../fixtures/sigstore/offline-message-signature-v03.json", import.meta.url),
    "utf8",
  ),
) as OfflineFixture;
const policy = Object.freeze({
  certificateIssuer: "https://github.com/login/oauth",
  certificateIdentity: "brian@dehamer.com",
});

describe("offline Sigstore capability verifier", () => {
  it("verifies the exact payload, proof thresholds, issuer, and escaped SAN without network access", () => {
    const verifier = createVerifier();

    expect(verifier.verify(artifact(), bundleBytes(), policy)).toEqual({
      certificateIssuer: policy.certificateIssuer,
      certificateIdentity: policy.certificateIdentity,
    });
  });

  it("treats regex metacharacters in the publisher SAN as literal identity data", () => {
    const verifier = createVerifier();

    expect(() =>
      verifier.verify(artifact(), bundleBytes(), {
        ...policy,
        certificateIdentity: "brian@dehamerXcom",
      }),
    ).toThrowError(expectedError("verify publisher signature"));
  });

  it.each([
    ["missing issuer", { certificateIssuer: "", certificateIdentity: policy.certificateIdentity }],
    [
      "non-HTTPS issuer",
      {
        certificateIssuer: "http://github.com/login/oauth",
        certificateIdentity: policy.certificateIdentity,
      },
    ],
    [
      "issuer credentials",
      {
        certificateIssuer: "https://user:secret@github.com/login/oauth",
        certificateIdentity: policy.certificateIdentity,
      },
    ],
    [
      "issuer query",
      {
        certificateIssuer: "https://github.com/login/oauth?private=value",
        certificateIdentity: policy.certificateIdentity,
      },
    ],
    ["empty identity", { certificateIssuer: policy.certificateIssuer, certificateIdentity: "" }],
    [
      "identity control character",
      { certificateIssuer: policy.certificateIssuer, certificateIdentity: "private\nidentity" },
    ],
  ])("rejects an invalid publisher policy before bundle parsing: %s", (_label, candidate) => {
    const privateBundle = Buffer.from("PRIVATE_BUNDLE");

    expect(() => createVerifier().verify(artifact(), privateBundle, candidate)).toThrowError(
      expectedError("validate publisher policy"),
    );
  });

  it.each([
    ["invalid JSON", Buffer.from("PRIVATE_INVALID_JSON"), "parse Sigstore bundle"],
    [
      "unknown top-level key",
      bundleBytes({ privateUnknown: "PRIVATE_UNKNOWN" }),
      "validate Sigstore bundle",
    ],
    [
      "alternate media type",
      bundleBytes({ mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3" }),
      "validate Sigstore bundle",
    ],
  ])("rejects %s with one value-free stage", (_label, source, stage) => {
    expectClosedFailure(() => createVerifier().verify(artifact(), source, policy), stage);
  });

  it("requires a v0.3 message-signature bundle", () => {
    const candidate = cloneBundle();
    delete candidate.messageSignature;
    candidate.dsseEnvelope = {
      payload: "UFJJVkFURQ==",
      payloadType: "text/plain",
      signatures: [{ sig: "UFJJVkFURQ==" }],
    };

    expectClosedFailure(
      () => createVerifier().verify(artifact(), Buffer.from(JSON.stringify(candidate)), policy),
      "validate Sigstore bundle",
    );
  });

  it.each([
    [
      "transparency inclusion proof",
      (candidate: MutableBundleFixture) => {
        const entry = candidate.verificationMaterial.tlogEntries[0];
        if (entry === undefined) {
          throw new Error("Sigstore fixture requires one transparency entry");
        }
        delete entry.inclusionProof;
      },
    ],
    [
      "signed timestamp",
      (candidate: MutableBundleFixture) => {
        candidate.verificationMaterial.timestampVerificationData.rfc3161Timestamps = [];
      },
    ],
    [
      "certificate identity",
      (candidate: MutableBundleFixture) => {
        candidate.verificationMaterial.publicKey = { hint: "PRIVATE_KEY" };
        delete candidate.verificationMaterial.certificate;
      },
    ],
  ])("rejects a bundle missing its required %s", (_label, mutate) => {
    const candidate = cloneBundle();
    mutate(candidate);

    expectClosedFailure(
      () => createVerifier().verify(artifact(), Buffer.from(JSON.stringify(candidate)), policy),
      "validate Sigstore bundle",
    );
  });

  it("rejects a changed payload and wrong issuer at the cryptographic policy stage", () => {
    expectClosedFailure(
      () => createVerifier().verify(Buffer.from("changed payload"), bundleBytes(), policy),
      "verify publisher signature",
    );
    expectClosedFailure(
      () =>
        createVerifier().verify(artifact(), bundleBytes(), {
          ...policy,
          certificateIssuer: "https://token.actions.githubusercontent.com/",
        }),
      "verify publisher signature",
    );
  });

  it("rejects a structurally valid bundle with changed signature bytes", () => {
    const candidate = cloneBundle();
    if (
      typeof candidate.messageSignature !== "object" ||
      candidate.messageSignature === null ||
      Array.isArray(candidate.messageSignature)
    ) {
      throw new Error("Sigstore fixture requires a message signature");
    }
    candidate.messageSignature = {
      ...candidate.messageSignature,
      signature: "AAAA",
    };

    expectClosedFailure(
      () => createVerifier().verify(artifact(), Buffer.from(JSON.stringify(candidate)), policy),
      "verify publisher signature",
    );
  });

  it("rejects evidence whose trusted certificate authority expired before the signed time", () => {
    const trustedRoot = structuredClone(fixture.trustedRoot) as {
      certificateAuthorities: { validFor?: { end?: string } }[];
    };
    for (const authority of trustedRoot.certificateAuthorities) {
      authority.validFor = { end: "2025-01-01T00:00:00Z" };
    }

    expectClosedFailure(
      () =>
        new OfflineSigstoreCapabilityVerifier(TrustedRoot.fromJSON(trustedRoot)).verify(
          artifact(),
          bundleBytes(),
          policy,
        ),
      "verify publisher signature",
    );
  });

  it("accepts the exact Sigstore byte bound and rejects one additional byte", () => {
    const source = bundleBytes();
    const exact = Buffer.concat([
      source,
      Buffer.alloc(MAX_SIGSTORE_BUNDLE_BYTES - source.length, 0x20),
    ]);
    const overflow = Buffer.concat([exact, Buffer.from(" ")]);

    expect(createVerifier().verify(artifact(), exact, policy)).toEqual(policy);
    expectClosedFailure(
      () => createVerifier().verify(artifact(), overflow, policy),
      "parse Sigstore bundle",
    );
  });

  it("keeps the OCI and Sigstore v0.3 media-type contracts identical", () => {
    expect(fixture.bundle.mediaType).toBe(SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE);
  });
});

function createVerifier(): OfflineSigstoreCapabilityVerifier {
  return new OfflineSigstoreCapabilityVerifier(createSigstorePublicGoodTrustedRoot());
}

function artifact(): Buffer {
  return Buffer.from(fixture.artifactBase64, "base64");
}

function bundleBytes(change: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ ...cloneBundle(), ...change }));
}

function cloneBundle(): MutableBundleFixture {
  return structuredClone(fixture.bundle);
}

function expectedError(stage: string): SigstoreCapabilityVerificationError {
  return new SigstoreCapabilityVerificationError(stage as never);
}

function expectClosedFailure(operation: () => unknown, stage: string): void {
  try {
    operation();
    throw new Error("expected Sigstore verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SigstoreCapabilityVerificationError);
    expect(error).toEqual(expectedError(stage));
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
  }
}
