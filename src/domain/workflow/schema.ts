import { z } from "zod";
import {
  agentSkillNameSchema,
  MAX_AGENT_SKILL_PACKAGES,
} from "../capability/agent-skill-contract.js";
import { toolPackageNameSchema, toolPackageVersionSchema } from "../capability/tool-packages.js";
import {
  verifierPackageNameSchema,
  verifierPackageVersionSchema,
} from "../capability/verifier-packages.js";
import {
  workflowPackageNameSchema,
  workflowPackageVersionSchema,
} from "../capability/workflow-packages.js";
import { goalContractSchema } from "../goal/schema.js";
import { MAX_POLICY_DECISION_LIMIT } from "../policy/limits.js";
import {
  DEFAULT_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT,
  MAX_PROTECTED_CONTEXT_CONSTRAINTS,
  MAX_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT,
  MIN_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT,
} from "../run/context-compaction.js";
import {
  AGENT_TOOL_NAMES,
  type CompiledResultSchema,
  FLOW_WORKFLOW_API_VERSION,
  MAX_CHILD_WORKFLOW_SOURCE_BYTES,
  MAX_CONCURRENT_NODES,
  MAX_LOOP_BODY_NODES,
  MAX_LOOP_ITERATIONS,
  MAX_OPTIMIZATION_CANDIDATES,
  MAX_RESULT_ARRAY_ITEMS,
  MAX_RESULT_SCHEMA_DEPTH,
  MAX_RESULT_SCHEMA_NODES,
  MAX_RESULT_SCHEMA_SERIALIZED_BYTES,
  WORK_PROFILES,
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

const retryBackoffSchema = z
  .object({
    initialDelayMs: z.number().int().positive().max(300_000),
    maxDelayMs: z.number().int().positive().max(900_000),
  })
  .strict()
  .refine((backoff) => backoff.maxDelayMs >= backoff.initialDelayMs, {
    message: "recovery backoff maxDelayMs must be at least initialDelayMs",
    path: ["maxDelayMs"],
  });

const agentRecoverySchema = z
  .object({
    mode: z.literal("fresh"),
    maxAttempts: z.number().int().min(2).max(16),
    backoff: retryBackoffSchema.optional(),
  })
  .strict();

const rollingContextCompactionSchema = z
  .object({
    mode: z.literal("rolling"),
    pressureThresholdPercent: z
      .number()
      .int()
      .min(MIN_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT)
      .max(MAX_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT)
      .default(DEFAULT_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT),
    protectedConstraints: z
      .array(z.string().min(1).max(4_096))
      .max(MAX_PROTECTED_CONTEXT_CONSTRAINTS)
      .refine(
        (constraints) => new Set(constraints).size === constraints.length,
        "protected context constraints must be unique",
      )
      .refine(
        (constraints) =>
          constraints.reduce(
            (total, constraint) => total + Buffer.byteLength(constraint, "utf8"),
            0,
          ) <=
          64 * 1024,
        "protected context constraints must not exceed 65536 UTF-8 bytes",
      )
      .default([]),
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
    maxArtifactBytes: positiveSafeIntegerSchema.optional(),
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

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "must be a SHA-256 digest");
const gitCommitSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/, "must be a full lowercase hexadecimal Git commit ID");
const proofRuntimeSchema = z
  .object({
    version: z.literal(1),
    platform: z.literal("linux"),
    architecture: z.literal("x64"),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/, "must be an exact OCI SHA-256 digest"),
    buildAttestationDigest: sha256Schema,
    dependencyManifestDigest: sha256Schema,
    leanVersion: z
      .string()
      .regex(
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
        "must be an exact stable Lean version",
      ),
    mathlibRevision: gitCommitSchema,
    safeVerifyRevision: gitCommitSchema,
    nanodaRevision: gitCommitSchema,
    profileDigest: sha256Schema,
  })
  .strict();

const evidenceSourceSchema = z
  .object({
    nodeId: identifierSchema,
    field: evidenceSourceFieldSchema,
  })
  .strict();

const verifierPackageReferenceSchema = z
  .object({
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
  })
  .strict();

const toolPackageReferenceSchema = z
  .object({
    name: toolPackageNameSchema,
    version: toolPackageVersionSchema,
  })
  .strict();

const workflowPackageReferenceSchema = z
  .object({
    name: workflowPackageNameSchema,
    version: workflowPackageVersionSchema,
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

const agentToolApprovalSchema = z
  .object({
    exec: commandApprovalSchema,
  })
  .strict();

const agentConfigSchema = z
  .object({
    prompt: z.string().trim().min(1).max(262_144),
    model: modelSchema,
    tools: z
      .array(z.enum(AGENT_TOOL_NAMES))
      .max(AGENT_TOOL_NAMES.length)
      .refine((tools) => new Set(tools).size === tools.length, "agent tools must be unique")
      .default([]),
    skills: z
      .array(agentSkillNameSchema)
      .max(MAX_AGENT_SKILL_PACKAGES)
      .refine((skills) => new Set(skills).size === skills.length, "agent skills must be unique")
      .default([]),
    toolPackages: z
      .array(toolPackageReferenceSchema)
      .max(MAX_AGENT_SKILL_PACKAGES)
      .refine(
        (packages) => new Set(packages.map((item) => item.name)).size === packages.length,
        "agent tool package names must be unique",
      )
      .default([]),
    toolApproval: agentToolApprovalSchema.optional(),
    recovery: agentRecoverySchema.optional(),
    contextCompaction: rollingContextCompactionSchema.optional(),
    policyDecisionLimit: z.number().int().min(1).max(MAX_POLICY_DECISION_LIMIT).optional(),
    maxOutputTokens: z.number().int().positive().safe().optional(),
    timeoutMs: z.number().int().positive().max(86_400_000).default(300_000),
  })
  .strict()
  .superRefine((agent, context) => {
    if (agent.skills.length > 0 && !agent.tools.includes("read")) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "agent skills require the declared read tool for progressive disclosure",
      });
    }
    if (
      agent.recovery !== undefined &&
      (agent.tools.includes("exec") || agent.toolPackages.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["recovery"],
        message: "fresh agent recovery is not supported with agent command execution",
      });
    }
    if (
      agent.toolApproval !== undefined &&
      !agent.tools.includes("exec") &&
      agent.toolPackages.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["toolApproval"],
        message: "agent exec approval requires raw exec or a selected command tool package",
      });
    }
  });

const agentNodeSchema = z
  .object({
    ...guardedNodeShape,
    type: z.literal("agent"),
    agent: agentConfigSchema,
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
          maxOutputTokens: z.number().int().positive().safe().optional(),
          timeoutMs: z.number().int().positive().max(86_400_000).default(300_000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("lean-proof"),
          targetDeclaration: z
            .string()
            .min(3)
            .max(512)
            .regex(
              /^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)+$/,
              "must be an exact namespaced Lean declaration",
            ),
          specification: evidenceSourceSchema,
          statement: evidenceSourceSchema,
          proof: evidenceSourceSchema,
          faithfulnessApprovalNodeId: identifierSchema,
          runtime: proofRuntimeSchema,
          timeoutMs: z.number().int().positive().max(86_400_000).default(300_000),
        })
        .strict()
        .refine(
          (verifier) =>
            new Set(
              [verifier.specification, verifier.statement, verifier.proof].map(
                (source) => `${source.nodeId}\0${source.field}`,
              ),
            ).size === 3,
          "proof verifier source declarations must be unique",
        ),
      z
        .object({
          kind: z.literal("packaged-command"),
          package: verifierPackageReferenceSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("packaged-model"),
          package: verifierPackageReferenceSchema,
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
          maxOutputTokens: z.number().int().positive().safe().optional(),
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

const childDefinitionSchema = z.union([
  z
    .object({
      resultNodeId: identifierSchema,
      workflow: z
        .string()
        .refine(
          (value) =>
            value.trim().length > 0 &&
            Buffer.byteLength(value, "utf8") <= MAX_CHILD_WORKFLOW_SOURCE_BYTES,
          `embedded child workflow must be non-empty and not exceed ${MAX_CHILD_WORKFLOW_SOURCE_BYTES} UTF-8 bytes`,
        ),
    })
    .strict(),
  z
    .object({
      resultNodeId: identifierSchema,
      package: workflowPackageReferenceSchema,
    })
    .strict(),
]);

const childNodeSchema = z
  .object({
    ...guardedNodeShape,
    type: z.literal("child"),
    child: childDefinitionSchema,
  })
  .strict();

const optimizationScalarSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(65_536),
]);

const optimizationNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("optimization"),
    optimization: z
      .object({
        baseline: z
          .object({
            nodeId: identifierSchema,
            field: z.literal("result.value"),
          })
          .strict(),
        metric: z
          .object({
            pointer: z.string().max(4_096),
            direction: z.enum(["minimize", "maximize"]),
          })
          .strict(),
        invariants: z
          .array(
            z
              .object({
                pointer: z.string().max(4_096),
                equals: optimizationScalarSchema,
              })
              .strict(),
          )
          .max(16)
          .refine(
            (invariants) =>
              new Set(invariants.map((invariant) => invariant.pointer)).size === invariants.length,
            "optimization invariant pointers must be unique",
          ),
        maxCandidates: z.number().int().min(1).max(MAX_OPTIMIZATION_CANDIDATES),
        stagnation: z
          .object({
            maxConsecutiveNonImproving: z.number().int().min(1).max(MAX_OPTIMIZATION_CANDIDATES),
          })
          .strict(),
        rollback: z.literal("previous-best"),
        candidate: childDefinitionSchema,
      })
      .strict()
      .refine(
        (optimization) =>
          optimization.stagnation.maxConsecutiveNonImproving <= optimization.maxCandidates,
        {
          path: ["stagnation", "maxConsecutiveNonImproving"],
          message: "optimization stagnation bound must not exceed maxCandidates",
        },
      ),
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
  childNodeSchema,
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
    workProfile: z.enum(WORK_PROFILES).optional(),
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
          childNodeSchema,
          conditionNodeSchema,
          joinNodeSchema,
          loopNodeSchema,
          optimizationNodeSchema,
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
