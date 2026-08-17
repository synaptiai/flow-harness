import { createHash } from "node:crypto";

import { z } from "zod";

import { parseStrictJson } from "../strict-json.js";
import {
  CAPABILITY_BUNDLE_API_VERSION,
  MAX_CAPABILITY_BUNDLE_BYTES,
} from "./capability-bundles.js";
import { MAX_SIGSTORE_BUNDLE_BYTES } from "./oci-capability-artifacts.js";

export const SIGNED_CAPABILITY_BUNDLE_ENVELOPE_KIND = "SignedCapabilityBundleEnvelope" as const;
export const MAX_SIGNED_CAPABILITY_BUNDLE_SIGSTORE_BYTES = MAX_SIGSTORE_BUNDLE_BYTES;

const MAX_CAPABILITY_BUNDLE_BASE64_CHARACTERS = 4 * Math.ceil(MAX_CAPABILITY_BUNDLE_BYTES / 3);
const MAX_SIGSTORE_BUNDLE_BASE64_CHARACTERS =
  4 * Math.ceil(MAX_SIGNED_CAPABILITY_BUNDLE_SIGSTORE_BYTES / 3);
const CANONICAL_ENVELOPE_FIXED_BYTES = Buffer.byteLength(
  JSON.stringify({
    apiVersion: CAPABILITY_BUNDLE_API_VERSION,
    kind: SIGNED_CAPABILITY_BUNDLE_ENVELOPE_KIND,
    capabilityBundleBase64: "",
    sigstoreBundleBase64: "",
  }),
);

export const MAX_SIGNED_CAPABILITY_BUNDLE_ENVELOPE_BYTES =
  MAX_CAPABILITY_BUNDLE_BASE64_CHARACTERS +
  MAX_SIGSTORE_BUNDLE_BASE64_CHARACTERS +
  CANONICAL_ENVELOPE_FIXED_BYTES;

const envelopeSchema = z
  .object({
    apiVersion: z.literal(CAPABILITY_BUNDLE_API_VERSION),
    kind: z.literal(SIGNED_CAPABILITY_BUNDLE_ENVELOPE_KIND),
    capabilityBundleBase64: z.string().max(MAX_CAPABILITY_BUNDLE_BASE64_CHARACTERS),
    sigstoreBundleBase64: z.string().max(MAX_SIGSTORE_BUNDLE_BASE64_CHARACTERS),
  })
  .strict();

export type SignedCapabilityBundleEnvelopeStage =
  | "bound envelope"
  | "parse envelope"
  | "validate envelope"
  | "decode envelope";

export class SignedCapabilityBundleEnvelopeError extends Error {
  override readonly name = "SignedCapabilityBundleEnvelopeError";
  readonly code = "signed_capability_bundle_envelope_failed" as const;

  constructor(readonly stage: SignedCapabilityBundleEnvelopeStage) {
    super(`Signed capability bundle envelope failed during ${stage}`);
  }
}

export interface SignedCapabilityBundleEnvelopeInput {
  readonly capabilityBundle: Uint8Array;
  readonly sigstoreBundle: Uint8Array;
}

export class SignedCapabilityBundleEnvelope {
  readonly apiVersion = CAPABILITY_BUNDLE_API_VERSION;
  readonly kind = SIGNED_CAPABILITY_BUNDLE_ENVELOPE_KIND;
  readonly bytes: number;
  readonly digest: `sha256:${string}`;
  readonly capabilityBundleBytes: number;
  readonly sigstoreBundleBytes: number;

  readonly #capabilityBundle: Buffer;
  readonly #sigstoreBundle: Buffer;

  constructor(input: {
    readonly source: Buffer;
    readonly capabilityBundle: Buffer;
    readonly sigstoreBundle: Buffer;
  }) {
    this.bytes = input.source.byteLength;
    this.digest = sha256(input.source);
    this.capabilityBundleBytes = input.capabilityBundle.byteLength;
    this.sigstoreBundleBytes = input.sigstoreBundle.byteLength;
    this.#capabilityBundle = Buffer.from(input.capabilityBundle);
    this.#sigstoreBundle = Buffer.from(input.sigstoreBundle);
    Object.freeze(this);
  }

  capabilityBundle(): Buffer {
    return Buffer.from(this.#capabilityBundle);
  }

  sigstoreBundle(): Buffer {
    return Buffer.from(this.#sigstoreBundle);
  }
}

export function encodeSignedCapabilityBundleEnvelope(
  input: SignedCapabilityBundleEnvelopeInput,
): Buffer {
  const capabilityBundle = requireComponentBytes(
    input.capabilityBundle,
    MAX_CAPABILITY_BUNDLE_BYTES,
  );
  const sigstoreBundle = requireComponentBytes(
    input.sigstoreBundle,
    MAX_SIGNED_CAPABILITY_BUNDLE_SIGSTORE_BYTES,
  );
  return canonicalEnvelopeBytes({
    apiVersion: CAPABILITY_BUNDLE_API_VERSION,
    kind: SIGNED_CAPABILITY_BUNDLE_ENVELOPE_KIND,
    capabilityBundleBase64: capabilityBundle.toString("base64"),
    sigstoreBundleBase64: sigstoreBundle.toString("base64"),
  });
}

export function parseSignedCapabilityBundleEnvelope(
  source: Uint8Array,
): SignedCapabilityBundleEnvelope {
  const content = Buffer.from(source);
  if (content.byteLength < 1 || content.byteLength > MAX_SIGNED_CAPABILITY_BUNDLE_ENVELOPE_BYTES) {
    throw new SignedCapabilityBundleEnvelopeError("bound envelope");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new SignedCapabilityBundleEnvelopeError("parse envelope");
  }

  let input: unknown;
  try {
    input = parseStrictJson(text, {
      maxDepth: 3,
      maxNodes: 16,
      valueLabel: "signed capability bundle envelope",
    });
  } catch {
    throw new SignedCapabilityBundleEnvelopeError("parse envelope");
  }

  let parsed: z.infer<typeof envelopeSchema>;
  try {
    parsed = envelopeSchema.parse(input);
    if (!content.equals(canonicalEnvelopeBytes(parsed))) {
      throw new Error("envelope is not canonical");
    }
  } catch {
    throw new SignedCapabilityBundleEnvelopeError("validate envelope");
  }

  let capabilityBundle: Buffer;
  let sigstoreBundle: Buffer;
  try {
    capabilityBundle = decodeCanonicalBase64(
      parsed.capabilityBundleBase64,
      MAX_CAPABILITY_BUNDLE_BYTES,
    );
    sigstoreBundle = decodeCanonicalBase64(
      parsed.sigstoreBundleBase64,
      MAX_SIGNED_CAPABILITY_BUNDLE_SIGSTORE_BYTES,
    );
  } catch {
    throw new SignedCapabilityBundleEnvelopeError("decode envelope");
  }

  return new SignedCapabilityBundleEnvelope({ source: content, capabilityBundle, sigstoreBundle });
}

function canonicalEnvelopeBytes(envelope: z.infer<typeof envelopeSchema>): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: envelope.apiVersion,
      kind: envelope.kind,
      capabilityBundleBase64: envelope.capabilityBundleBase64,
      sigstoreBundleBase64: envelope.sigstoreBundleBase64,
    }),
  );
}

function decodeCanonicalBase64(source: string, maximumBytes: number): Buffer {
  if (!isCanonicalBase64Alphabet(source)) {
    throw new Error("invalid canonical base64");
  }
  const decoded = Buffer.from(source, "base64");
  if (
    decoded.byteLength < 1 ||
    decoded.byteLength > maximumBytes ||
    decoded.toString("base64") !== source
  ) {
    throw new Error("decoded component violates its byte contract");
  }
  return decoded;
}

function isCanonicalBase64Alphabet(source: string): boolean {
  if (source.length < 4 || source.length % 4 !== 0) {
    return false;
  }
  const padding = source.endsWith("==") ? 2 : source.endsWith("=") ? 1 : 0;
  const contentLength = source.length - padding;
  if (source.indexOf("=") !== (padding === 0 ? -1 : contentLength)) {
    return false;
  }
  for (let index = 0; index < contentLength; index += 1) {
    const code = source.charCodeAt(index);
    const allowed =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!allowed) {
      return false;
    }
  }
  return true;
}

function requireComponentBytes(source: Uint8Array, maximumBytes: number): Buffer {
  const content = Buffer.from(source);
  if (content.byteLength < 1 || content.byteLength > maximumBytes) {
    throw new SignedCapabilityBundleEnvelopeError("decode envelope");
  }
  return content;
}

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
