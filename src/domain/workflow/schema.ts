import { z } from "zod";

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

const commandNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("command"),
    command: z
      .object({
        executable: z.string().trim().min(1).max(4096),
        args: z.array(z.string().max(131_072)).max(256).default([]),
        timeoutMs: z.number().int().positive().max(86_400_000).default(60_000),
      })
      .strict(),
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
          .array(z.enum(["read", "grep", "find", "ls"]))
          .max(4)
          .default([]),
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
    nodes: z
      .array(z.discriminatedUnion("type", [commandNodeSchema, agentNodeSchema]))
      .min(1)
      .max(512),
  })
  .strict();

export type WorkflowSource = z.infer<typeof workflowSourceSchema>;
