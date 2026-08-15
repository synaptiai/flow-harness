import { isDeepStrictEqual } from "node:util";

import {
  assertBundleLatest,
  BUNDLE_V03_MEDIA_TYPE,
  bundleFromJSON,
  bundleToJSON,
  isBundleWithMessageSignature,
} from "@sigstore/bundle";
import type { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";

import { parseStrictJson, StrictJsonError } from "../strict-json.js";
import { MAX_SIGSTORE_BUNDLE_BYTES } from "./oci-capability-artifacts.js";

export type SigstoreCapabilityVerificationStage =
  | "load trusted root"
  | "validate publisher policy"
  | "parse Sigstore bundle"
  | "validate Sigstore bundle"
  | "verify publisher signature";

export class SigstoreCapabilityVerificationError extends Error {
  override readonly name = "SigstoreCapabilityVerificationError";
  readonly code = "publisher_verification_failed" as const;

  constructor(readonly stage: SigstoreCapabilityVerificationStage) {
    super(`Sigstore capability verification failed during ${stage}`);
  }
}

export interface SigstoreCapabilityPublisherPolicy {
  readonly certificateIssuer: string;
  readonly certificateIdentity: string;
}

export interface VerifiedSigstoreCapabilityPublisher {
  readonly certificateIssuer: string;
  readonly certificateIdentity: string;
}

export interface SigstoreCapabilityVerifier {
  verify(
    artifact: Uint8Array,
    serializedBundle: Uint8Array,
    policy: SigstoreCapabilityPublisherPolicy,
  ): VerifiedSigstoreCapabilityPublisher;
}

export class OfflineSigstoreCapabilityVerifier implements SigstoreCapabilityVerifier {
  readonly #verifier: Verifier;

  constructor(trustedRoot: TrustedRoot) {
    try {
      this.#verifier = new Verifier(toTrustMaterial(trustedRoot), {
        tlogThreshold: 1,
        ctlogThreshold: 1,
        timestampThreshold: 1,
      });
    } catch {
      throw new SigstoreCapabilityVerificationError("load trusted root");
    }
  }

  verify(
    artifact: Uint8Array,
    serializedBundle: Uint8Array,
    inputPolicy: SigstoreCapabilityPublisherPolicy,
  ): VerifiedSigstoreCapabilityPublisher {
    const policy = validateSigstoreCapabilityPublisherPolicy(inputPolicy);
    const bundle = parseBundle(serializedBundle);

    try {
      this.#verifier.verify(toSignedEntity(bundle, Buffer.from(artifact)), {
        subjectAlternativeName: exactPattern(policy.certificateIdentity),
        extensions: { issuer: policy.certificateIssuer },
      });
    } catch {
      throw new SigstoreCapabilityVerificationError("verify publisher signature");
    }

    return Object.freeze({ ...policy });
  }
}

export function validateSigstoreCapabilityPublisherPolicy(
  input: SigstoreCapabilityPublisherPolicy,
): SigstoreCapabilityPublisherPolicy {
  try {
    const issuer = new URL(input.certificateIssuer);
    if (
      issuer.protocol !== "https:" ||
      issuer.username !== "" ||
      issuer.password !== "" ||
      issuer.port !== "" ||
      issuer.search !== "" ||
      issuer.hash !== "" ||
      issuer.hostname !== issuer.hostname.toLowerCase() ||
      issuer.toString() !== input.certificateIssuer ||
      Buffer.byteLength(input.certificateIssuer, "utf8") > 2_048 ||
      !isCanonicalIdentity(input.certificateIdentity)
    ) {
      throw new Error("invalid policy");
    }
  } catch {
    throw new SigstoreCapabilityVerificationError("validate publisher policy");
  }
  return Object.freeze({
    certificateIssuer: input.certificateIssuer,
    certificateIdentity: input.certificateIdentity,
  });
}

function parseBundle(serialized: Uint8Array) {
  const content = Buffer.from(serialized);
  if (content.byteLength === 0 || content.byteLength > MAX_SIGSTORE_BUNDLE_BYTES) {
    throw new SigstoreCapabilityVerificationError("parse Sigstore bundle");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new SigstoreCapabilityVerificationError("parse Sigstore bundle");
  }

  let input: unknown;
  try {
    input = parseStrictJson(text, {
      maxDepth: 16,
      maxNodes: 4_096,
      valueLabel: "Sigstore bundle",
    });
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new SigstoreCapabilityVerificationError("parse Sigstore bundle");
    }
    throw error;
  }

  try {
    const plainInput = JSON.parse(JSON.stringify(input)) as unknown;
    const bundle = bundleFromJSON(plainInput);
    if (!isDeepStrictEqual(plainInput, bundleToJSON(bundle))) {
      throw new Error("non-canonical bundle");
    }
    assertBundleLatest(bundle);
    if (
      bundle.mediaType !== BUNDLE_V03_MEDIA_TYPE ||
      !isBundleWithMessageSignature(bundle) ||
      bundle.verificationMaterial.content.$case !== "certificate" ||
      bundle.verificationMaterial.tlogEntries.length < 1 ||
      (bundle.verificationMaterial.timestampVerificationData?.rfc3161Timestamps.length ?? 0) < 1
    ) {
      throw new Error("unsupported bundle");
    }
    return bundle;
  } catch {
    throw new SigstoreCapabilityVerificationError("validate Sigstore bundle");
  }
}

function exactPattern(value: string): RegExp {
  return new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "u");
}

function isCanonicalIdentity(value: string): boolean {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    Array.from(value).some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  ) {
    return false;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "utf8")) === value;
  } catch {
    return false;
  }
}
