import { describe, expect, it } from "vitest";
import { MAX_CAPABILITY_METADATA_BYTES } from "../../../src/domain/capability/capability-metadata.js";
import {
  encodeSignedCapabilityMetadataEnvelope,
  MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES,
  parseSignedCapabilityMetadataEnvelope,
  SignedCapabilityMetadataEnvelopeError,
} from "../../../src/domain/capability/signed-capability-metadata-envelope.js";

const MAX_SIGSTORE_BUNDLE_BYTES = 1024 * 1024;

describe("signed capability metadata envelope", () => {
  it("round-trips exact component bytes through one canonical envelope", () => {
    const metadata = Buffer.from("PRIVATE_METADATA");
    const sigstoreBundle = Buffer.from("PRIVATE_BUNDLE");
    const encoded = encodeSignedCapabilityMetadataEnvelope({ metadata, sigstoreBundle });

    const parsed = parseSignedCapabilityMetadataEnvelope(encoded);

    expect(parsed.bytes).toBe(encoded.byteLength);
    expect(parsed.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(parsed.metadataBytes()).toEqual(metadata);
    expect(parsed.sigstoreBundleBytes()).toEqual(sigstoreBundle);

    const firstRead = parsed.metadataBytes();
    firstRead.fill(0);
    expect(parsed.metadataBytes()).toEqual(metadata);
  });

  it("accepts the exact derived envelope byte boundary", () => {
    const encoded = encodeSignedCapabilityMetadataEnvelope({
      metadata: Buffer.alloc(MAX_CAPABILITY_METADATA_BYTES, 0x61),
      sigstoreBundle: Buffer.alloc(MAX_SIGSTORE_BUNDLE_BYTES, 0x62),
    });

    expect(encoded).toHaveLength(MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES);
    expect(parseSignedCapabilityMetadataEnvelope(encoded)).toMatchObject({
      bytes: MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES,
    });
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    [
      "one byte over the envelope limit",
      Buffer.alloc(MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES + 1, 0x61),
    ],
  ])("rejects %s at the fixed bound stage", (_label, source) => {
    expectClosedFailure(source, "bound envelope");
  });

  it.each([
    ["fatal UTF-8", Buffer.from([0xc3, 0x28])],
    [
      "duplicate key",
      Buffer.from(
        '{"apiVersion":"flow.synapti.ai/v1alpha1","apiVersion":"PRIVATE_DUPLICATE","kind":"SignedCapabilityMetadataEnvelope","metadataBase64":"YQ==","sigstoreBundleBase64":"Yg=="}',
      ),
    ],
  ])("rejects %s at the fixed parse stage", (_label, source) => {
    expectClosedFailure(source, "parse envelope");
  });

  it.each([
    [
      "an unknown field",
      Buffer.from(
        JSON.stringify({
          ...envelopeFixture(),
          privateCanary: "PRIVATE_UNKNOWN_FIELD",
        }),
      ),
    ],
    ["a non-canonical JSON encoding", Buffer.from(`${JSON.stringify(envelopeFixture())}\n`)],
  ])("rejects %s at the fixed validation stage", (_label, source) => {
    expectClosedFailure(source, "validate envelope");
  });

  it.each([
    [
      "non-canonical metadata base64",
      Buffer.from(JSON.stringify({ ...envelopeFixture(), metadataBase64: "YQ" })),
    ],
    ["empty metadata", Buffer.from(JSON.stringify({ ...envelopeFixture(), metadataBase64: "" }))],
    [
      "metadata beyond its decoded limit",
      encodeFixture({ metadata: Buffer.alloc(MAX_CAPABILITY_METADATA_BYTES + 1, 0x61) }),
    ],
    [
      "Sigstore bundle beyond its decoded limit",
      encodeFixture({ sigstoreBundle: Buffer.alloc(MAX_SIGSTORE_BUNDLE_BYTES + 1, 0x62) }),
    ],
  ])("rejects %s at the fixed decode stage", (_label, source) => {
    expectClosedFailure(source, "decode envelope");
  });
});

type EnvelopeStage = ConstructorParameters<typeof SignedCapabilityMetadataEnvelopeError>[0];

function envelopeFixture(): {
  apiVersion: string;
  kind: string;
  metadataBase64: string;
  sigstoreBundleBase64: string;
} {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "SignedCapabilityMetadataEnvelope",
    metadataBase64: Buffer.from("metadata").toString("base64"),
    sigstoreBundleBase64: Buffer.from("bundle").toString("base64"),
  };
}

function encodeFixture(input: { metadata?: Buffer; sigstoreBundle?: Buffer }): Buffer {
  return Buffer.from(
    JSON.stringify({
      ...envelopeFixture(),
      ...(input.metadata === undefined
        ? {}
        : { metadataBase64: input.metadata.toString("base64") }),
      ...(input.sigstoreBundle === undefined
        ? {}
        : { sigstoreBundleBase64: input.sigstoreBundle.toString("base64") }),
    }),
  );
}

function expectClosedFailure(source: Buffer, stage: EnvelopeStage): void {
  let caught: unknown;
  try {
    parseSignedCapabilityMetadataEnvelope(source);
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual(new SignedCapabilityMetadataEnvelopeError(stage));
  expect(caught).not.toHaveProperty("cause");
  expect((caught as Error).message).not.toContain("PRIVATE");
}
