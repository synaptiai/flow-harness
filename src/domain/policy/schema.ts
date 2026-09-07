import { z } from "zod";

import { MAX_POLICY_DECISION_LIMIT, MAX_POLICY_TARGET_BYTES } from "./limits.js";

export const policyAuthoritySchema = z.enum([
  "read",
  "write",
  "execute",
  "network",
  "credentials",
  "destructive",
]);

export const policyActionSchema = z.enum([
  "filesystem.read",
  "filesystem.list",
  "filesystem.write",
  "filesystem.delete",
  "process.execute",
  "network.request",
  "credential.read",
]);

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const policyDecisionSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive().max(MAX_POLICY_DECISION_LIMIT),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    runId: identifierSchema,
    workflowId: identifierSchema,
    nodeId: identifierSchema,
    attempt: z.number().int().positive(),
    authority: policyAuthoritySchema,
    action: policyActionSchema,
    target: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_POLICY_TARGET_BYTES, {
        message: `policy target must not exceed ${MAX_POLICY_TARGET_BYTES} UTF-8 bytes`,
      }),
    operationDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    outcome: z.enum(["allowed", "denied"]),
    reason: z.enum([
      "operation_declared",
      "operation_not_declared",
      "target_outside_workspace",
      "target_protected",
      "target_resolution_failed",
    ]),
  })
  .strict();
