import { createHash } from "node:crypto";

import { z } from "zod";

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_COMMAND_ARTIFACT_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_READ_BYTES = 32 * 1024;

const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const referenceDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const artifactReferenceIdentifierSchema = z.string().regex(/^artifact:[a-f0-9]{64}$/);
const mediaTypeSchema = z
  .string()
  .min(3)
  .max(127)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/,
    "artifact media type must be canonical lowercase type/subtype without parameters",
  );
const identitySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/, "artifact producer identity is invalid")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 256, {
    message: "artifact producer identity exceeds 256 UTF-8 bytes",
  });

export const artifactDescriptorSchema = z
  .object({
    digest: sha256DigestSchema,
    size: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
    mediaType: mediaTypeSchema,
  })
  .strict();

export const artifactProducerSchema = z
  .object({
    kind: z.literal("agent-command"),
    runId: identitySchema,
    workflowId: identitySchema,
    nodeId: identitySchema,
    attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    commandId: identitySchema,
    commandSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    stream: z.enum(["stdout", "stderr"]),
  })
  .strict();

export const artifactReferenceSchema = z
  .object({
    version: z.literal(1),
    reference: artifactReferenceIdentifierSchema,
    referenceDigest: referenceDigestSchema,
    descriptor: artifactDescriptorSchema,
    producer: artifactProducerSchema,
    retentionClass: z.literal("run"),
  })
  .strict();

export type ArtifactDescriptor = z.infer<typeof artifactDescriptorSchema>;
export type ArtifactProducer = z.infer<typeof artifactProducerSchema>;
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

export function createArtifactReference(input: {
  readonly descriptor: ArtifactDescriptor;
  readonly producer: ArtifactProducer;
}): ArtifactReference {
  const descriptor = artifactDescriptorSchema.parse(input.descriptor);
  const producer = artifactProducerSchema.parse(input.producer);
  const referenceDigest = calculateArtifactReferenceDigest({ descriptor, producer });
  return freezeReference({
    version: 1,
    reference: `artifact:${referenceDigest}`,
    referenceDigest,
    descriptor,
    producer,
    retentionClass: "run",
  });
}

export function validateArtifactReference(input: unknown): ArtifactReference {
  const parsed = artifactReferenceSchema.parse(input);
  const expectedDigest = calculateArtifactReferenceDigest(parsed);
  if (parsed.referenceDigest !== expectedDigest) {
    throw new TypeError("artifact reference digest does not match its exact content");
  }
  if (parsed.reference !== `artifact:${parsed.referenceDigest}`) {
    throw new TypeError("artifact reference does not match its digest");
  }
  return freezeReference(parsed);
}

export function calculateArtifactReferenceDigest(input: {
  readonly descriptor: ArtifactDescriptor;
  readonly producer: ArtifactProducer;
}): string {
  const canonical = {
    version: 1,
    descriptor: {
      digest: input.descriptor.digest,
      size: input.descriptor.size,
      mediaType: input.descriptor.mediaType,
    },
    producer: {
      kind: input.producer.kind,
      runId: input.producer.runId,
      workflowId: input.producer.workflowId,
      nodeId: input.producer.nodeId,
      attempt: input.producer.attempt,
      commandId: input.producer.commandId,
      commandSequence: input.producer.commandSequence,
      stream: input.producer.stream,
    },
    retentionClass: "run",
  } as const;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function freezeReference(reference: ArtifactReference): ArtifactReference {
  return Object.freeze({
    version: 1,
    reference: reference.reference,
    referenceDigest: reference.referenceDigest,
    descriptor: Object.freeze({ ...reference.descriptor }),
    producer: Object.freeze({ ...reference.producer }),
    retentionClass: "run",
  });
}
