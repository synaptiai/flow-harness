import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

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
  })
  .strict();

export type EvaluationTrialAttempt = z.infer<typeof evaluationTrialAttemptSchema>;

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
