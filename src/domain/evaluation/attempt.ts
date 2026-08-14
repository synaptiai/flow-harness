import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const dockerImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const containerIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

const ociLeaseSchema = z
  .object({
    version: z.literal(1),
    adapter: z.literal("prime-agent-native-v1"),
    state: z.enum([
      "intent",
      "absent",
      "created",
      "started",
      "terminal",
      "exported",
      "stopped",
      "removed",
    ]),
    ownerNonce: sha256Schema,
    containerName: z.string().regex(/^flow-prime-[a-f0-9]{32}$/),
    labels: z
      .object({
        evaluationId: identifierSchema,
        trialId: z.string().regex(/^trial-[a-f0-9]{48}$/),
        ownerNonce: sha256Schema,
        imageId: dockerImageDigestSchema,
        policyDigest: sha256Schema,
      })
      .strict(),
    imageId: dockerImageDigestSchema,
    policyDigest: sha256Schema,
    fixtureDigest: sha256Schema,
    engineEndpoint: z
      .object({
        socketPath: z.literal("/var/run/docker.sock"),
        device: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        inode: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        uid: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        gid: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        mode: z.number().int().nonnegative().max(0o777),
      })
      .strict(),
    containerId: containerIdSchema.optional(),
    inspectedPolicyDigest: sha256Schema.optional(),
  })
  .strict()
  .superRefine((lease, context) => {
    const hasCreatedIdentity =
      lease.containerId !== undefined && lease.inspectedPolicyDigest !== undefined;
    if (
      lease.state === "intent" || lease.state === "absent"
        ? hasCreatedIdentity
        : !hasCreatedIdentity
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "OCI lease state contradicts its durable container identity",
      });
    }
    if (
      lease.labels.ownerNonce !== lease.ownerNonce ||
      lease.labels.imageId !== lease.imageId ||
      lease.labels.policyDigest !== lease.policyDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["labels"],
        message: "OCI lease labels contradict its durable identity",
      });
    }
  });

const evaluationTrialAttemptSchema = z
  .object({
    version: z.literal(1),
    planDigest: sha256Schema,
    position: z.number().int().positive().max(4_096),
    trialId: z.string().regex(/^trial-[a-f0-9]{48}$/),
    taskId: identifierSchema,
    profileId: identifierSchema,
    adapter: identifierSchema,
    startedAt: z.iso.datetime({ offset: true }),
    workspace: z
      .object({
        backend: z.literal("reflink-copy-v1"),
        snapshotDigest: sha256Schema,
      })
      .strict(),
    ociLease: ociLeaseSchema.optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (attempt.ociLease !== undefined && attempt.adapter !== "prime-agent-native-v1") {
      context.addIssue({
        code: "custom",
        path: ["adapter"],
        message: "only a Prime adapter attempt can own an OCI lease",
      });
    }
    if (attempt.ociLease !== undefined && attempt.ociLease.labels.trialId !== attempt.trialId) {
      context.addIssue({
        code: "custom",
        path: ["ociLease", "labels", "trialId"],
        message: "OCI lease trial label contradicts the adapter attempt",
      });
    }
  });

export type EvaluationTrialAttempt = z.infer<typeof evaluationTrialAttemptSchema>;
export type EvaluationOciLease = z.infer<typeof ociLeaseSchema>;

export function parseEvaluationOciLease(input: unknown): EvaluationOciLease {
  const parsed = ociLeaseSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("evaluation OCI lease is invalid", { cause: parsed.error });
  }
  return deepFreeze(parsed.data);
}

export function parseEvaluationTrialAttempt(input: unknown): EvaluationTrialAttempt {
  const parsed = evaluationTrialAttemptSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("evaluation trial attempt is invalid", { cause: parsed.error });
  }
  return deepFreeze(parsed.data);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
