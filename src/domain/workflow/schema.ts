import { z } from "zod";

import { goalContractSchema } from "../goal/schema.js";
import {
  FLOW_WORKFLOW_API_VERSION,
  MAX_CONCURRENT_NODES,
  MAX_LOOP_BODY_NODES,
  MAX_LOOP_ITERATIONS,
  MAX_RESULT_ARRAY_ITEMS,
  MAX_RESULT_SCHEMA_DEPTH,
  MAX_RESULT_SCHEMA_NODES,
  MAX_RESULT_SCHEMA_SERIALIZED_BYTES,
  type CompiledResultSchema,
} from "./types.js";

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

const branchGuardSchema = z
  .object({
    conditionId: identifierSchema,
    case: identifierSchema,
  })
  .strict();

const guardedNodeShape = {
  ...commonNodeShape,
  when: branchGuardSchema.optional(),
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

const concurrencySchema = z
  .object({
    maxNodes: z.number().int().min(1).max(MAX_CONCURRENT_NODES),
  })
  .strict();

const modelSchema = z
  .object({
    provider: identifierSchema,
    id: z.string().trim().min(1).max(256),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).default("medium"),
  })
  .strict();

const commandExecutionSchema = z
  .object({
    executable: z.string().trim().min(1).max(4096),
    args: z
      .array(z.string().max(4096))
      .max(64)
      .refine(
        (args) => args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= 65_536,
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
  );

const evidenceSourceFieldSchema = z.enum([
  "command.stdout",
  "command.stderr",
  "agent.text",
  "verifier.verdict",
  "verifier.reason",
  "result.value",
]);

const evidenceSourceSchema = z
  .object({
    nodeId: identifierSchema,
    field: evidenceSourceFieldSchema,
  })
  .strict();

const commandNodeSchema = z
  .object({
    ...guardedNodeShape,
    type: z.literal("command"),
    approval: commandApprovalSchema.optional(),
    command: commandExecutionSchema,
  })
  .strict();

const agentNodeSchema = z
  .object({
    ...guardedNodeShape,
    type: z.literal("agent"),
    agent: z
      .object({
        prompt: z.string().trim().min(1).max(262_144),
        model: modelSchema,
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

const conditionCaseSchema = z
  .object({
    id: identifierSchema,
    equals: z.string().max(65_536),
  })
  .strict();

const approvalNodeSchema = z
  .object({
    ...guardedNodeShape,
    type: z.literal("approval"),
    approval: z
      .object({
        prompt: z.string().trim().min(1).max(4096),
        evidence: z
          .array(
            z
              .object({
                nodeId: identifierSchema,
                field: evidenceSourceFieldSchema,
              })
              .strict(),
          )
          .min(1)
          .max(16)
          .refine(
            (evidence) =>
              new Set(evidence.map((source) => `${source.nodeId}\0${source.field}`)).size ===
              evidence.length,
            "approval evidence declarations must be unique",
          ),
      })
      .strict(),
  })
  .strict();

const verifierNodeSchema = z
  .object({
    ...guardedNodeShape,
    type: z.literal("verifier"),
    verifier: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("command"),
          command: commandExecutionSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("model"),
          prompt: z.string().trim().min(1).max(16_384),
          evidence: z
            .array(evidenceSourceSchema)
            .min(1)
            .max(16)
            .refine(
              (evidence) =>
                new Set(evidence.map((source) => `${source.nodeId}\0${source.field}`)).size ===
                evidence.length,
              "verifier evidence declarations must be unique",
            ),
          model: modelSchema,
          timeoutMs: z.number().int().positive().max(86_400_000).default(300_000),
        })
        .strict(),
    ]),
  })
  .strict();

export const compiledResultSchemaSchema: z.ZodType<CompiledResultSchema> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("null") }).strict(),
    z.object({ type: z.literal("boolean") }).strict(),
    z
      .object({
        type: z.literal("number"),
        minimum: z.number().finite().optional(),
        maximum: z.number().finite().optional(),
      })
      .strict()
      .refine(
        (schema) =>
          schema.minimum === undefined ||
          schema.maximum === undefined ||
          schema.minimum <= schema.maximum,
        "result number minimum must not exceed maximum",
      ),
    z
      .object({
        type: z.literal("integer"),
        minimum: z.number().int().safe().optional(),
        maximum: z.number().int().safe().optional(),
      })
      .strict()
      .refine(
        (schema) =>
          schema.minimum === undefined ||
          schema.maximum === undefined ||
          schema.minimum <= schema.maximum,
        "result integer minimum must not exceed maximum",
      ),
    z
      .object({
        type: z.literal("string"),
        maxLength: z.number().int().min(0).max(262_144),
      })
      .strict(),
    z
      .object({
        type: z.literal("array"),
        items: compiledResultSchemaSchema,
        maxItems: z.number().int().min(0).max(MAX_RESULT_ARRAY_ITEMS),
      })
      .strict(),
    z
      .object({
        type: z.literal("object"),
        properties: z.record(identifierSchema, compiledResultSchemaSchema),
        required: z
          .array(identifierSchema)
          .max(128)
          .refine((items) => new Set(items).size === items.length, {
            message: "result object required properties must be unique",
          })
          .default([]),
      })
      .strict()
      .superRefine((schema, context) => {
        if (Object.keys(schema.properties).length > 128) {
          context.addIssue({
            code: "custom",
            path: ["properties"],
            message: "result object must not exceed 128 properties",
          });
        }
        for (const [index, key] of schema.required.entries()) {
          if (!Object.hasOwn(schema.properties, key)) {
            context.addIssue({
              code: "custom",
              path: ["required", index],
              message: `required result property "${key}" is not declared`,
            });
          }
        }
      }),
  ]),
);

export const boundedCompiledResultSchemaSchema = compiledResultSchemaSchema.superRefine(
  (schema, context) => {
    const complexity = resultSchemaComplexity(schema);
    if (complexity.depth > MAX_RESULT_SCHEMA_DEPTH) {
      context.addIssue({
        code: "custom",
        message: `result schema depth must not exceed ${MAX_RESULT_SCHEMA_DEPTH}`,
      });
    }
    if (complexity.nodes > MAX_RESULT_SCHEMA_NODES) {
      context.addIssue({
        code: "custom",
        message: `result schema nodes must not exceed ${MAX_RESULT_SCHEMA_NODES}`,
      });
    }
    if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_RESULT_SCHEMA_SERIALIZED_BYTES) {
      context.addIssue({
        code: "custom",
        message: `serialized result schema must not exceed ${MAX_RESULT_SCHEMA_SERIALIZED_BYTES} UTF-8 bytes`,
      });
    }
  },
);

const resultNodeSchema = z
  .object({
    ...guardedNodeShape,
    type: z.literal("result"),
    result: z
      .object({
        source: evidenceSourceSchema,
        schema: boundedCompiledResultSchemaSchema,
      })
      .strict(),
  })
  .strict();

const conditionNodeSchema = z
  .object({
    ...guardedNodeShape,
    type: z.literal("condition"),
    condition: z
      .object({
        source: z
          .object({
            nodeId: identifierSchema,
            field: evidenceSourceFieldSchema,
          })
          .strict(),
        cases: z.array(conditionCaseSchema).min(1).max(32),
        default: identifierSchema,
      })
      .strict()
      .superRefine((condition, context) => {
        const ids = new Set<string>();
        const values = new Set<string>();
        for (const item of condition.cases) {
          if (ids.has(item.id)) {
            context.addIssue({
              code: "custom",
              path: ["cases"],
              message: "condition case identifiers must be unique",
            });
          }
          if (values.has(item.equals)) {
            context.addIssue({
              code: "custom",
              path: ["cases"],
              message: "condition case values must be unique",
            });
          }
          ids.add(item.id);
          values.add(item.equals);
        }
        if (ids.has(condition.default)) {
          context.addIssue({
            code: "custom",
            path: ["default"],
            message: "condition default must be distinct from exact case identifiers",
          });
        }
        const totalBytes = condition.cases.reduce(
          (total, item) => total + Buffer.byteLength(item.equals, "utf8"),
          0,
        );
        if (totalBytes > 65_536) {
          context.addIssue({
            code: "custom",
            path: ["cases"],
            message: "condition case values must not exceed 65536 UTF-8 bytes in total",
          });
        }
      }),
  })
  .strict();

const joinNodeSchema = z
  .object({
    id: identifierSchema,
    type: z.literal("join"),
    join: z
      .object({
        conditionId: identifierSchema,
        branches: z
          .array(
            z
              .object({
                case: identifierSchema,
                nodeId: identifierSchema,
              })
              .strict(),
          )
          .min(1)
          .max(33),
      })
      .strict(),
  })
  .strict();

const loopBodyNodeSchema = z.discriminatedUnion("type", [
  commandNodeSchema,
  agentNodeSchema,
  verifierNodeSchema,
  approvalNodeSchema,
  resultNodeSchema,
  conditionNodeSchema,
  joinNodeSchema,
]);

const loopNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("loop"),
    loop: z
      .object({
        maxIterations: z.number().int().min(1).max(MAX_LOOP_ITERATIONS),
        until: z
          .object({
            source: z
              .object({
                nodeId: identifierSchema,
                field: evidenceSourceFieldSchema,
              })
              .strict(),
            equals: z.string().max(65_536),
          })
          .strict(),
        body: z
          .object({
            nodes: z.array(loopBodyNodeSchema).min(1).max(MAX_LOOP_BODY_NODES),
          })
          .strict(),
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
    concurrency: concurrencySchema.optional(),
    nodes: z
      .array(
        z.discriminatedUnion("type", [
          commandNodeSchema,
          agentNodeSchema,
          verifierNodeSchema,
          approvalNodeSchema,
          resultNodeSchema,
          conditionNodeSchema,
          joinNodeSchema,
          loopNodeSchema,
        ]),
      )
      .min(1)
      .max(64),
  })
  .strict();

function resultSchemaComplexity(schema: CompiledResultSchema): {
  readonly depth: number;
  readonly nodes: number;
} {
  if (schema.type === "array") {
    const child = resultSchemaComplexity(schema.items);
    return { depth: child.depth + 1, nodes: child.nodes + 1 };
  }
  if (schema.type === "object") {
    let depth = 1;
    let nodes = 1;
    for (const property of Object.values(schema.properties)) {
      const child = resultSchemaComplexity(property);
      depth = Math.max(depth, child.depth + 1);
      nodes += child.nodes;
    }
    return { depth, nodes };
  }
  return { depth: 1, nodes: 1 };
}

export type WorkflowSource = z.infer<typeof workflowSourceSchema>;
