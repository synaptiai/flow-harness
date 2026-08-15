import { createHash } from "node:crypto";

import { z } from "zod";

import { parseStrictJson } from "../strict-json.js";
import { parseOciCapabilityArtifactReference } from "./oci-capability-artifacts.js";
import { verifierPackageNameSchema, verifierPackageVersionSchema } from "./verifier-packages.js";

export const CAPABILITY_METADATA_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_CAPABILITY_METADATA_BYTES = 512 * 1024;
export const MAX_CAPABILITY_METADATA_TARGETS = 1_024;

const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const canonicalInstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const instant = new Date(value);
    return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
  });
const publisherPolicySchema = z
  .object({
    certificateIssuer: z.string().min(1).max(2_048).refine(isCanonicalHttpsIssuer),
    certificateIdentity: z.string().min(1).max(4_096).refine(isCanonicalPublisherIdentity),
  })
  .strict();
const targetSchema = z
  .object({
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    digest: sha256DigestSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    source: z.string().min(1).max(4_096),
    status: z.enum(["active", "revoked"]),
    publisher: publisherPolicySchema.optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (!isValidTargetSource(target.source, target.publisher !== undefined)) {
      context.addIssue({ code: "custom", path: ["source"], message: "invalid source authority" });
    }
  });
const metadataSchema = z
  .object({
    apiVersion: z.literal(CAPABILITY_METADATA_API_VERSION),
    kind: z.literal("CapabilityMetadata"),
    metadata: z
      .object({
        name: verifierPackageNameSchema,
        version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        expiresAt: canonicalInstantSchema,
      })
      .strict(),
    spec: z
      .object({
        targets: z.array(targetSchema).max(MAX_CAPABILITY_METADATA_TARGETS),
      })
      .strict(),
  })
  .strict();

export type CapabilityMetadataStage = "parse metadata" | "validate metadata" | "validate freshness";

export class CapabilityMetadataError extends Error {
  override readonly name = "CapabilityMetadataError";
  readonly code = "capability_metadata_failed" as const;

  constructor(readonly stage: CapabilityMetadataStage) {
    super(`Capability metadata failed during ${stage}`);
  }
}

export interface CapabilityMetadataPublisherPolicy {
  readonly certificateIssuer: string;
  readonly certificateIdentity: string;
}

export interface CapabilityMetadataTarget {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly bytes: number;
  readonly source: string;
  readonly status: "active" | "revoked";
  readonly publisher?: CapabilityMetadataPublisherPolicy;
}

export interface CapabilityMetadata {
  readonly apiVersion: typeof CAPABILITY_METADATA_API_VERSION;
  readonly kind: "CapabilityMetadata";
  readonly name: string;
  readonly version: number;
  readonly expiresAt: string;
  readonly bytes: number;
  readonly digest: string;
  readonly targets: readonly CapabilityMetadataTarget[];
}

export function parseCapabilityMetadata(source: Uint8Array, now: Date): CapabilityMetadata {
  const content = Buffer.from(source);
  if (content.byteLength < 1 || content.byteLength > MAX_CAPABILITY_METADATA_BYTES) {
    throw new CapabilityMetadataError("parse metadata");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new CapabilityMetadataError("parse metadata");
  }

  let parsed: z.infer<typeof metadataSchema>;
  try {
    const input = parseStrictJson(text, {
      maxDepth: 10,
      maxNodes: 16_384,
      valueLabel: "capability metadata",
    });
    parsed = metadataSchema.parse(input);
    assertCanonicalTargets(parsed.spec.targets);
    if (!content.equals(canonicalMetadataBytes(parsed))) {
      throw new Error("capability metadata must use its canonical encoding");
    }
  } catch {
    throw new CapabilityMetadataError("validate metadata");
  }

  if (Number.isNaN(now.getTime()) || now.getTime() >= Date.parse(parsed.metadata.expiresAt)) {
    throw new CapabilityMetadataError("validate freshness");
  }

  return deepFreeze({
    apiVersion: parsed.apiVersion,
    kind: parsed.kind,
    name: parsed.metadata.name,
    version: parsed.metadata.version,
    expiresAt: parsed.metadata.expiresAt,
    bytes: content.byteLength,
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    targets: parsed.spec.targets.map((target) => ({
      name: target.name,
      version: target.version,
      digest: target.digest,
      bytes: target.bytes,
      source: target.source,
      status: target.status,
      ...(target.publisher === undefined
        ? {}
        : {
            publisher: {
              certificateIssuer: target.publisher.certificateIssuer,
              certificateIdentity: target.publisher.certificateIdentity,
            },
          }),
    })),
  });
}

function canonicalMetadataBytes(metadata: z.infer<typeof metadataSchema>): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: metadata.apiVersion,
      kind: metadata.kind,
      metadata: {
        name: metadata.metadata.name,
        version: metadata.metadata.version,
        expiresAt: metadata.metadata.expiresAt,
      },
      spec: {
        targets: metadata.spec.targets.map((target) => ({
          name: target.name,
          version: target.version,
          digest: target.digest,
          bytes: target.bytes,
          source: target.source,
          status: target.status,
          ...(target.publisher === undefined
            ? {}
            : {
                publisher: {
                  certificateIssuer: target.publisher.certificateIssuer,
                  certificateIdentity: target.publisher.certificateIdentity,
                },
              }),
        })),
      },
    }),
  );
}

function assertCanonicalTargets(targets: readonly z.infer<typeof targetSchema>[]): void {
  for (let index = 1; index < targets.length; index += 1) {
    const previous = targets[index - 1];
    const current = targets[index];
    if (previous === undefined || current === undefined || compareTargets(previous, current) >= 0) {
      throw new Error("metadata targets must be strictly sorted and unique");
    }
  }
}

function compareTargets(
  left: Pick<CapabilityMetadataTarget, "name" | "version">,
  right: Pick<CapabilityMetadataTarget, "name" | "version">,
): number {
  const leftKey = `${left.name}\0${left.version}`;
  const rightKey = `${right.name}\0${right.version}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function isValidTargetSource(source: string, hasPublisher: boolean): boolean {
  try {
    const url = new URL(source);
    if (
      source === url.toString() &&
      !source.includes("?") &&
      !source.includes("#") &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    ) {
      return !hasPublisher;
    }
  } catch {
    // The exact OCI parser below owns non-URL source validation.
  }
  if (!hasPublisher) {
    return false;
  }
  try {
    return parseOciCapabilityArtifactReference(source).canonical === source;
  } catch {
    return false;
  }
}

function isCanonicalHttpsIssuer(source: string): boolean {
  try {
    const url = new URL(source);
    return (
      source === url.toString() &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.hostname === url.hostname.toLowerCase()
    );
  } catch {
    return false;
  }
}

function isCanonicalPublisherIdentity(identity: string): boolean {
  if (
    identity === identity.trim() &&
    Buffer.byteLength(identity, "utf8") <= 4_096 &&
    !Array.from(identity).some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  ) {
    try {
      return (
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(identity, "utf8")) === identity
      );
    } catch {
      return false;
    }
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
