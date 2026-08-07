import { z } from "zod";

import { goalContractSchema } from "../goal/schema.js";
import { FLOW_WORKFLOW_API_VERSION } from "./types.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    "must start with a lowercase letter and contain lowercase letters, digits, or hyphens",
  );

const commonNodeShape = {
  id: identifierSchema,
  dependsOn: z.array(identifierSchema).max(128).default([]),
};

const commandApprovalSchema = z
  .object({
    mode: z.literal("required"),
    grantTtlMs: z.number().int().positive().max(86_400_000).default(300_000),
  })
  .strict();

const agentRecoverySchema = z
  .object({
    mode: z.literal("fresh"),
    maxAttempts: z.number().int().min(2).max(16),
  })
  .strict();

const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const runBudgetSchema = z
  .object({
    maxNodeStarts: positiveSafeIntegerSchema.optional(),
    maxModelTokens: positiveSafeIntegerSchema.optional(),
    maxCostUsd: z
      .number()
      .finite()
      .positive()
      .max(Number.MAX_SAFE_INTEGER / 1_000_000)
      .refine(
        (value) => Number.isSafeInteger(value * 1_000_000),
        "must have at most six decimal places",
      )
      .optional(),
    maxExecutionMs: positiveSafeIntegerSchema.optional(),
  })
  .strict()
  .refine((budget) => Object.values(budget).some((value) => value !== undefined), {
    message: "must declare at least one limit",
  });

const commandNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("command"),
    approval: commandApprovalSchema.optional(),
    command: z
      .object({
        executable: z.string().trim().min(1).max(4096),
        args: z
          .array(z.string().max(4096))
          .max(64)
          .refine(
            (args) =>
              args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= 65_536,
            "command arguments must not exceed 65536 UTF-8 bytes in total",
          )
          .default([]),
        timeoutMs: z.number().int().positive().max(86_400_000).default(60_000),
      })
      .strict()
      .refine(
        (command) =>
          !command.executable.includes("\0") && command.args.every((arg) => !arg.includes("\0")),
        "command values must not contain NUL bytes",
      ),
  })
  .strict();

const agentNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("agent"),
    agent: z
      .object({
        prompt: z.string().trim().min(1).max(262_144),
        model: z
          .object({
            provider: identifierSchema,
            id: z.string().trim().min(1).max(256),
            thinking: z
              .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
              .default("medium"),
          })
          .strict(),
        tools: z
          .array(z.enum(["read", "ls", "edit"]))
          .max(3)
          .refine((tools) => new Set(tools).size === tools.length, "agent tools must be unique")
          .default([]),
        recovery: agentRecoverySchema.optional(),
        timeoutMs: z.number().int().positive().max(86_400_000).default(300_000),
      })
      .strict(),
  })
  .strict();

export const workflowSourceSchema = z
  .object({
    apiVersion: z.literal(FLOW_WORKFLOW_API_VERSION),
    kind: z.literal("Workflow"),
    metadata: z
      .object({
        id: identifierSchema,
        description: z.string().trim().min(1).max(4096).optional(),
      })
      .strict(),
    goal: goalContractSchema.optional(),
    budget: runBudgetSchema.optional(),
    nodes: z
      .array(z.discriminatedUnion("type", [commandNodeSchema, agentNodeSchema]))
      .min(1)
      .max(64),
  })
  .strict();

export type WorkflowSource = z.infer<typeof workflowSourceSchema>;
