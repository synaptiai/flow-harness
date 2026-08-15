import { createHash } from "node:crypto";

import { z } from "zod";

import { parseStrictJson } from "../strict-json.js";
import {
  CAPABILITY_METADATA_API_VERSION,
  MAX_CAPABILITY_METADATA_BYTES,
} from "./capability-metadata.js";

export const SIGNED_CAPABILITY_METADATA_ENVELOPE_KIND = "SignedCapabilityMetadataEnvelope" as const;
export const MAX_SIGSTORE_BUNDLE_BYTES = 1024 * 1024;

const MAX_METADATA_BASE64_CHARACTERS = 4 * Math.ceil(MAX_CAPABILITY_METADATA_BYTES / 3);
const MAX_SIGSTORE_BUNDLE_BASE64_CHARACTERS = 4 * Math.ceil(MAX_SIGSTORE_BUNDLE_BYTES / 3);
const CANONICAL_ENVELOPE_FIXED_BYTES = 129;

export const MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES =
  MAX_METADATA_BASE64_CHARACTERS +
  MAX_SIGSTORE_BUNDLE_BASE64_CHARACTERS +
  CANONICAL_ENVELOPE_FIXED_BYTES;

const envelopeSchema = z
  .object({
    apiVersion: z.literal(CAPABILITY_METADATA_API_VERSION),
    kind: z.literal(SIGNED_CAPABILITY_METADATA_ENVELOPE_KIND),
    metadataBase64: z.string().max(MAX_METADATA_BASE64_CHARACTERS),
    sigstoreBundleBase64: z.string().max(MAX_SIGSTORE_BUNDLE_BASE64_CHARACTERS),
  })
  .strict();

export type SignedCapabilityMetadataEnvelopeStage =
  | "bound envelope"
  | "parse envelope"
  | "validate envelope"
  | "decode envelope";

export class SignedCapabilityMetadataEnvelopeError extends Error {
  override readonly name = "SignedCapabilityMetadataEnvelopeError";
  readonly code = "signed_capability_metadata_envelope_failed" as const;

  constructor(readonly stage: SignedCapabilityMetadataEnvelopeStage) {
    super(`Signed capability metadata envelope failed during ${stage}`);
  }
}

export interface SignedCapabilityMetadataEnvelopeInput {
  readonly metadata: Uint8Array;
  readonly sigstoreBundle: Uint8Array;
}

export class SignedCapabilityMetadataEnvelope {
  readonly bytes: number;
  readonly digest: string;
  readonly apiVersion = CAPABILITY_METADATA_API_VERSION;
  readonly kind = SIGNED_CAPABILITY_METADATA_ENVELOPE_KIND;

  readonly #metadata: Buffer;
  readonly #sigstoreBundle: Buffer;

  constructor(input: {
    readonly source: Buffer;
    readonly metadata: Buffer;
    readonly sigstoreBundle: Buffer;
  }) {
    this.bytes = input.source.byteLength;
    this.digest = `sha256:${createHash("sha256").update(input.source).digest("hex")}`;
    this.#metadata = Buffer.from(input.metadata);
    this.#sigstoreBundle = Buffer.from(input.sigstoreBundle);
    Object.freeze(this);
  }

  metadataBytes(): Buffer {
    return Buffer.from(this.#metadata);
  }

  sigstoreBundleBytes(): Buffer {
    return Buffer.from(this.#sigstoreBundle);
  }
}

export function encodeSignedCapabilityMetadataEnvelope(
  input: SignedCapabilityMetadataEnvelopeInput,
): Buffer {
  const metadata = requireComponentBytes(input.metadata, MAX_CAPABILITY_METADATA_BYTES);
  const sigstoreBundle = requireComponentBytes(input.sigstoreBundle, MAX_SIGSTORE_BUNDLE_BYTES);
  return canonicalEnvelopeBytes({
    apiVersion: CAPABILITY_METADATA_API_VERSION,
    kind: SIGNED_CAPABILITY_METADATA_ENVELOPE_KIND,
    metadataBase64: metadata.toString("base64"),
    sigstoreBundleBase64: sigstoreBundle.toString("base64"),
  });
}

export function parseSignedCapabilityMetadataEnvelope(
  source: Uint8Array,
): SignedCapabilityMetadataEnvelope {
  const content = Buffer.from(source);
  if (
    content.byteLength < 1 ||
    content.byteLength > MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES
  ) {
    throw new SignedCapabilityMetadataEnvelopeError("bound envelope");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new SignedCapabilityMetadataEnvelopeError("parse envelope");
  }

  let input: unknown;
  try {
    input = parseStrictJson(text, {
      maxDepth: 3,
      maxNodes: 16,
      valueLabel: "signed capability metadata envelope",
    });
  } catch {
    throw new SignedCapabilityMetadataEnvelopeError("parse envelope");
  }

  let parsed: z.infer<typeof envelopeSchema>;
  try {
    parsed = envelopeSchema.parse(input);
    if (!content.equals(canonicalEnvelopeBytes(parsed))) {
      throw new Error("signed capability metadata envelope must use its canonical encoding");
    }
  } catch {
    throw new SignedCapabilityMetadataEnvelopeError("validate envelope");
  }

  let metadata: Buffer;
  let sigstoreBundle: Buffer;
  try {
    metadata = decodeCanonicalBase64(parsed.metadataBase64, MAX_CAPABILITY_METADATA_BYTES);
    sigstoreBundle = decodeCanonicalBase64(parsed.sigstoreBundleBase64, MAX_SIGSTORE_BUNDLE_BYTES);
  } catch {
    throw new SignedCapabilityMetadataEnvelopeError("decode envelope");
  }

  return new SignedCapabilityMetadataEnvelope({
    source: content,
    metadata,
    sigstoreBundle,
  });
}

function canonicalEnvelopeBytes(metadata: z.infer<typeof envelopeSchema>): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: metadata.apiVersion,
      kind: metadata.kind,
      metadataBase64: metadata.metadataBase64,
      sigstoreBundleBase64: metadata.sigstoreBundleBase64,
    }),
  );
}

function decodeCanonicalBase64(source: string, maxBytes: number): Buffer {
  if (
    source.length < 1 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source)
  ) {
    throw new Error("invalid canonical base64");
  }
  const decoded = Buffer.from(source, "base64");
  if (
    decoded.byteLength < 1 ||
    decoded.byteLength > maxBytes ||
    decoded.toString("base64") !== source
  ) {
    throw new Error("decoded component exceeds its contract");
  }
  return decoded;
}

function requireComponentBytes(source: Uint8Array, maxBytes: number): Buffer {
  const content = Buffer.from(source);
  if (content.byteLength < 1 || content.byteLength > maxBytes) {
    throw new SignedCapabilityMetadataEnvelopeError("decode envelope");
  }
  return content;
}
