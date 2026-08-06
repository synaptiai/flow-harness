import { z } from "zod";

import { FLOW_GOAL_API_VERSION } from "./types.js";

export const MAX_SERIALIZED_GOAL_BYTES = 262_144;

const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    "must start with a lowercase letter and contain lowercase letters, digits, or hyphens",
  );

export const goalContractSchema = z
  .object({
    apiVersion: z.literal(FLOW_GOAL_API_VERSION),
    kind: z.literal("Goal"),
    metadata: z
      .object({
        id: identifierSchema,
      })
      .strict(),
    outcome: z.string().trim().min(1).max(16_384),
    criteria: z
      .array(
        z
          .object({
            id: identifierSchema,
            description: z.string().trim().min(1).max(4096),
            verifier: z
              .object({
                nodeId: identifierSchema,
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .refine(hasBoundedSerializedSize, {
    message: `serialized goal must not exceed ${MAX_SERIALIZED_GOAL_BYTES} UTF-8 bytes`,
  });

export type GoalContractSource = z.infer<typeof goalContractSchema>;

const compiledCriterionSchema = z
  .object({
    id: identifierSchema,
    description: z.string().trim().min(1).max(4096),
    verifierNodeId: identifierSchema,
  })
  .strict()
  .refine(hasBoundedSerializedSize, {
    message: `serialized goal must not exceed ${MAX_SERIALIZED_GOAL_BYTES} UTF-8 bytes`,
  });

function hasBoundedSerializedSize(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_SERIALIZED_GOAL_BYTES;
}

export const compiledGoalSchema = z
  .object({
    apiVersion: z.literal(FLOW_GOAL_API_VERSION),
    id: identifierSchema,
    outcome: z.string().trim().min(1).max(16_384),
    criteria: z
      .array(compiledCriterionSchema)
      .min(1)
      .max(64)
      .refine(
        (criteria) => new Set(criteria.map((criterion) => criterion.id)).size === criteria.length,
        "criterion ids must be unique",
      ),
  })
  .strict();
