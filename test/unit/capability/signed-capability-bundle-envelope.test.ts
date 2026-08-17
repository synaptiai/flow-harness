import { describe, expect, it } from "vitest";

import { MAX_CAPABILITY_BUNDLE_BYTES } from "../../../src/domain/capability/capability-bundles.js";
import {
  encodeSignedCapabilityBundleEnvelope,
  MAX_SIGNED_CAPABILITY_BUNDLE_ENVELOPE_BYTES,
  MAX_SIGNED_CAPABILITY_BUNDLE_SIGSTORE_BYTES,
  parseSignedCapabilityBundleEnvelope,
  SignedCapabilityBundleEnvelopeError,
} from "../../../src/domain/capability/signed-capability-bundle-envelope.js";

describe("signed capability bundle envelope", () => {
  it("round-trips exact package and Sigstore bytes through canonical JSON", () => {
    const capabilityBundle = Buffer.from("PRIVATE_CAPABILITY_BUNDLE");
    const sigstoreBundle = Buffer.from("PRIVATE_SIGSTORE_BUNDLE");
    const encoded = encodeSignedCapabilityBundleEnvelope({ capabilityBundle, sigstoreBundle });

    const parsed = parseSignedCapabilityBundleEnvelope(encoded);

    expect(parsed).toMatchObject({
      bytes: encoded.byteLength,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      capabilityBundleBytes: capabilityBundle.byteLength,
      sigstoreBundleBytes: sigstoreBundle.byteLength,
    });
    expect(parsed.capabilityBundle()).toEqual(capabilityBundle);
    expect(parsed.sigstoreBundle()).toEqual(sigstoreBundle);
    const mutableRead = parsed.capabilityBundle();
    mutableRead.fill(0);
    expect(parsed.capabilityBundle()).toEqual(capabilityBundle);
  });

  it("accepts the exact derived envelope boundary", () => {
    const encoded = encodeSignedCapabilityBundleEnvelope({
      capabilityBundle: Buffer.alloc(MAX_CAPABILITY_BUNDLE_BYTES, 0x61),
      sigstoreBundle: Buffer.alloc(MAX_SIGNED_CAPABILITY_BUNDLE_SIGSTORE_BYTES, 0x62),
    });

    expect(encoded).toHaveLength(MAX_SIGNED_CAPABILITY_BUNDLE_ENVELOPE_BYTES);
    expect(parseSignedCapabilityBundleEnvelope(encoded)).toMatchObject({
      bytes: MAX_SIGNED_CAPABILITY_BUNDLE_ENVELOPE_BYTES,
    });
  });

  it.each([
    ["empty", Buffer.alloc(0), "bound envelope"],
    [
      "one byte over the encoded limit",
      Buffer.alloc(MAX_SIGNED_CAPABILITY_BUNDLE_ENVELOPE_BYTES + 1, 0x61),
      "bound envelope",
    ],
    ["fatal UTF-8", Buffer.from([0xc3, 0x28]), "parse envelope"],
    [
      "duplicate key",
      Buffer.from(
        '{"apiVersion":"flow.synapti.ai/v1alpha1","kind":"SignedCapabilityBundleEnvelope","kind":"PRIVATE_DUPLICATE","capabilityBundleBase64":"YQ==","sigstoreBundleBase64":"Yg=="}',
      ),
      "parse envelope",
    ],
    [
      "unknown field",
      Buffer.from(JSON.stringify({ ...envelopeFixture(), privateCanary: "PRIVATE_UNKNOWN" })),
      "validate envelope",
    ],
    [
      "non-canonical JSON",
      Buffer.from(`${JSON.stringify(envelopeFixture())}\n`),
      "validate envelope",
    ],
    [
      "non-canonical base64",
      Buffer.from(JSON.stringify({ ...envelopeFixture(), capabilityBundleBase64: "YQ" })),
      "decode envelope",
    ],
    [
      "empty capability bundle",
      Buffer.from(JSON.stringify({ ...envelopeFixture(), capabilityBundleBase64: "" })),
      "decode envelope",
    ],
  ] as const)("rejects %s with the exact fixed stage", (_label, source, stage) => {
    let caught: unknown;
    try {
      parseSignedCapabilityBundleEnvelope(source);
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new SignedCapabilityBundleEnvelopeError(stage));
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
  });

  it.each([
    [
      "capability bundle",
      () =>
        encodeSignedCapabilityBundleEnvelope({
          capabilityBundle: Buffer.alloc(MAX_CAPABILITY_BUNDLE_BYTES + 1, 0x61),
          sigstoreBundle: Buffer.from("bundle"),
        }),
    ],
    [
      "Sigstore bundle",
      () =>
        encodeSignedCapabilityBundleEnvelope({
          capabilityBundle: Buffer.from("package"),
          sigstoreBundle: Buffer.alloc(MAX_SIGNED_CAPABILITY_BUNDLE_SIGSTORE_BYTES + 1, 0x62),
        }),
    ],
  ])("rejects an oversized %s before encoding", (_label, encode) => {
    expect(encode).toThrowError(new SignedCapabilityBundleEnvelopeError("decode envelope"));
  });
});

function envelopeFixture(): {
  apiVersion: string;
  kind: string;
  capabilityBundleBase64: string;
  sigstoreBundleBase64: string;
} {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "SignedCapabilityBundleEnvelope",
    capabilityBundleBase64: Buffer.from("package").toString("base64"),
    sigstoreBundleBase64: Buffer.from("bundle").toString("base64"),
  };
}
