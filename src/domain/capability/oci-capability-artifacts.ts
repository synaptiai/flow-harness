import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { z } from "zod";

import { parseStrictJson, StrictJsonError } from "../strict-json.js";
import { MAX_CAPABILITY_BUNDLE_BYTES } from "./capability-bundles.js";

export const OCI_IMAGE_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json" as const;
export const OCI_EMPTY_CONFIG_MEDIA_TYPE = "application/vnd.oci.empty.v1+json" as const;
export const OCI_EMPTY_CONFIG_DIGEST =
  "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" as const;
export const FLOW_CAPABILITY_ARTIFACT_TYPE =
  "application/vnd.synapti.flow.capability-bundle.v1" as const;
export const FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE =
  "application/vnd.synapti.flow.capability-bundle.v1+json" as const;
export const SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE =
  "application/vnd.dev.sigstore.bundle.v0.3+json" as const;
export const MAX_OCI_CAPABILITY_MANIFEST_BYTES = 64 * 1024;
export const MAX_SIGSTORE_BUNDLE_BYTES = 1024 * 1024;
export const MAX_OCI_CAPABILITY_REFERENCE_BYTES = 4_096;

const sha256DigestSchema = z.custom<`sha256:${string}`>(
  (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value),
  "must be an exact lowercase sha256 digest",
);
const bundleDescriptorSchema = z
  .object({
    mediaType: z.literal(FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE),
    digest: sha256DigestSchema,
    size: z.number().int().positive().max(MAX_CAPABILITY_BUNDLE_BYTES),
  })
  .strict();
const sigstoreDescriptorSchema = z
  .object({
    mediaType: z.literal(SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE),
    digest: sha256DigestSchema,
    size: z.number().int().positive().max(MAX_SIGSTORE_BUNDLE_BYTES),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    mediaType: z.literal(OCI_IMAGE_MANIFEST_MEDIA_TYPE),
    artifactType: z.literal(FLOW_CAPABILITY_ARTIFACT_TYPE),
    config: z
      .object({
        mediaType: z.literal(OCI_EMPTY_CONFIG_MEDIA_TYPE),
        digest: z.literal(OCI_EMPTY_CONFIG_DIGEST),
        size: z.literal(2),
      })
      .strict(),
    layers: z.tuple([bundleDescriptorSchema, sigstoreDescriptorSchema]),
  })
  .strict();

export interface OciCapabilityArtifactReference {
  readonly canonical: string;
  readonly registryOrigin: string;
  readonly repository: string;
  readonly manifestDigest: `sha256:${string}`;
}

export interface OciContentDescriptor {
  readonly mediaType: string;
  readonly digest: `sha256:${string}`;
  readonly size: number;
}

export interface OciCapabilityArtifactManifest {
  readonly digest: `sha256:${string}`;
  readonly bytes: number;
  readonly bundle: OciContentDescriptor & {
    readonly mediaType: typeof FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE;
  };
  readonly sigstoreBundle: OciContentDescriptor & {
    readonly mediaType: typeof SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE;
  };
}

export function parseOciCapabilityArtifactReference(value: string): OciCapabilityArtifactReference {
  if (
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_OCI_CAPABILITY_REFERENCE_BYTES ||
    value !== value.trim()
  ) {
    throw invalidReference();
  }
  const match = /^([^/@]+)\/([^@]+)@(sha256:[a-f0-9]{64})$/.exec(value);
  if (match === null) {
    throw invalidReference();
  }
  const [, registry, repository, manifestDigest] = match;
  if (
    registry === undefined ||
    repository === undefined ||
    manifestDigest === undefined ||
    !isCanonicalRegistryHostname(registry) ||
    !isCanonicalRepository(repository)
  ) {
    throw invalidReference();
  }
  return Object.freeze({
    canonical: value,
    registryOrigin: `https://${registry}`,
    repository,
    manifestDigest: manifestDigest as `sha256:${string}`,
  });
}

export function parseOciCapabilityArtifactManifest(
  source: Uint8Array,
  expectedDigest: string,
): OciCapabilityArtifactManifest {
  if (!sha256DigestSchema.safeParse(expectedDigest).success) {
    throw new Error("OCI capability manifest digest must be exact lowercase sha256");
  }
  const content = Buffer.from(source);
  const actualDigest = digest(content);
  if (actualDigest !== expectedDigest) {
    throw new Error("OCI capability manifest digest mismatch");
  }
  if (content.byteLength === 0 || content.byteLength > MAX_OCI_CAPABILITY_MANIFEST_BYTES) {
    throw new Error(
      `OCI capability manifest must contain 1-${MAX_OCI_CAPABILITY_MANIFEST_BYTES} bytes`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new Error("OCI capability manifest must be valid UTF-8", { cause: error });
  }

  let input: unknown;
  try {
    input = parseStrictJson(text, {
      maxDepth: 8,
      maxNodes: 64,
      valueLabel: "OCI capability manifest",
    });
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new Error(`OCI capability manifest JSON: ${error.message}`, { cause: error });
    }
    throw error;
  }

  const parsed = manifestSchema.parse(input);
  return Object.freeze({
    digest: actualDigest,
    bytes: content.byteLength,
    bundle: freezeDescriptor(parsed.layers[0]),
    sigstoreBundle: freezeDescriptor(parsed.layers[1]),
  });
}

export function assertOciDescriptorBytes(
  descriptor: OciContentDescriptor,
  source: Uint8Array,
  label: string,
): void {
  const content = Buffer.from(source);
  if (content.byteLength !== descriptor.size) {
    throw new Error(`${label} byte count mismatch`);
  }
  if (digest(content) !== descriptor.digest) {
    throw new Error(`${label} digest mismatch`);
  }
}

function freezeDescriptor<T extends OciContentDescriptor>(descriptor: T): Readonly<T> {
  return Object.freeze({ ...descriptor });
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function invalidReference(): Error {
  return new Error(
    "capability artifact reference must be a canonical public OCI repository with an exact sha256 digest",
  );
}

function isCanonicalRegistryHostname(value: string): boolean {
  if (value.length > 253 || value !== value.toLowerCase() || isIP(value) !== 0) {
    return false;
  }
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  );
}

function isCanonicalRepository(value: string): boolean {
  return (
    value.length <= 255 &&
    value.split("/").every((segment) => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(segment))
  );
}
