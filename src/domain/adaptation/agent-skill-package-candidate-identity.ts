import { createHash } from "node:crypto";

import { z } from "zod";
import {
  AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_SYSTEM_PROMPT_SHA256,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_EVIDENCE,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_FILES,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_BYTES,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_TOKENS,
} from "./agent-skill-package-generation-contract.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const portablePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isPortableRelativePath, "must be a canonical portable relative path");

const generationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("model"),
    provider: identifierSchema,
    model: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value === value.trim(), "model must not contain outer whitespace"),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
    systemPromptSha256: z.literal(AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_SYSTEM_PROMPT_SHA256),
    requestDigest: sha256Schema,
    responseDigest: sha256Schema,
    blueprintDigest: sha256Schema,
    limits: z
      .object({
        candidates: z.literal(1),
        turns: z.literal(1),
        maxInputBytes: z.literal(MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_INPUT_BYTES),
        maxOutputBytes: z.literal(MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_BYTES),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_TOKENS),
        timeoutMs: z.number().int().positive().max(86_400_000),
      })
      .strict(),
    targets: z
      .array(z.object({ path: portablePathSchema }).strict())
      .min(1)
      .max(MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_FILES)
      .refine(
        (targets) => new Set(targets.map((target) => target.path)).size === targets.length,
        "generation targets must be unique",
      ),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        cacheReadTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        cacheWriteTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        costUsdMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict()
  .superRefine((generation, context) => {
    if (generation.usage.outputTokens > generation.limits.maxOutputTokens) {
      context.addIssue({
        code: "custom",
        path: ["usage", "outputTokens"],
        message: "reported output tokens exceed the generation limit",
      });
    }
  });

export interface AgentSkillPackageCandidateIdentityValue {
  readonly version: 1;
  readonly kind: "agent-skill-package-candidate";
  readonly id: string;
  readonly candidateVersion: string;
  readonly scope: {
    readonly kind: "workflow-agent-skill-package";
    readonly workflowId: string;
    readonly nodeId: string;
    readonly skillName: string;
  };
  readonly manifest: { readonly provenance: string; readonly sourceSha256: string };
  readonly baseline: {
    readonly workflow: {
      readonly provenance: string;
      readonly sourceSha256: string;
      readonly workflowDigest: string;
    };
  };
  readonly blueprint: {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly blueprintDigest: string;
  };
  readonly evidence: readonly {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly evidenceDigest: string;
    readonly planDigest: string;
  }[];
  readonly package: {
    readonly name: string;
    readonly provenance: string;
    readonly packageDigest: string;
    readonly capabilityDigest: string;
  };
  readonly selection: {
    readonly nodeId: string;
    readonly before: readonly [];
    readonly after: readonly [string];
  };
  readonly projectedWorkflow: {
    readonly sourceSha256: string;
    readonly workflowDigest: string;
  };
  readonly generation: {
    readonly version: 1;
    readonly kind: "model";
    readonly provider: string;
    readonly model: string;
    readonly thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    readonly systemPromptSha256: string;
    readonly requestDigest: string;
    readonly responseDigest: string;
    readonly blueprintDigest: string;
    readonly limits: {
      readonly candidates: number;
      readonly turns: number;
      readonly maxInputBytes: number;
      readonly maxOutputBytes: number;
      readonly maxOutputTokens: number;
      readonly timeoutMs: number;
    };
    readonly targets: readonly { readonly path: string }[];
    readonly usage: {
      readonly inputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
      readonly outputTokens: number;
      readonly costUsdMicros: number;
    };
  };
  readonly candidateDigest: string;
}

const identitySchema: z.ZodType<AgentSkillPackageCandidateIdentityValue> = z
  .object({
    version: z.literal(1),
    kind: z.literal("agent-skill-package-candidate"),
    id: identifierSchema,
    candidateVersion: semverSchema,
    scope: z
      .object({
        kind: z.literal("workflow-agent-skill-package"),
        workflowId: identifierSchema,
        nodeId: identifierSchema,
        skillName: identifierSchema,
      })
      .strict(),
    manifest: z.object({ provenance: portablePathSchema, sourceSha256: sha256Schema }).strict(),
    baseline: z
      .object({
        workflow: z
          .object({
            provenance: portablePathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    blueprint: z
      .object({
        provenance: portablePathSchema,
        sourceSha256: sha256Schema,
        blueprintDigest: sha256Schema,
      })
      .strict(),
    evidence: z
      .array(
        z
          .object({
            provenance: portablePathSchema,
            sourceSha256: sha256Schema,
            evidenceDigest: sha256Schema,
            planDigest: sha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_EVIDENCE),
    package: z
      .object({
        name: identifierSchema,
        provenance: portablePathSchema,
        packageDigest: sha256Schema,
        capabilityDigest: sha256Schema,
      })
      .strict(),
    selection: z
      .object({
        nodeId: identifierSchema,
        before: z.tuple([]),
        after: z.tuple([identifierSchema]),
      })
      .strict(),
    projectedWorkflow: z
      .object({ sourceSha256: sha256Schema, workflowDigest: sha256Schema })
      .strict(),
    generation: generationSchema,
    candidateDigest: sha256Schema,
  })
  .strict()
  .superRefine((identity, context) => {
    if (
      identity.scope.nodeId !== identity.selection.nodeId ||
      identity.scope.skillName !== identity.package.name ||
      identity.scope.skillName !== identity.selection.after[0] ||
      identity.package.provenance !== `skill/${identity.package.name}` ||
      identity.generation.blueprintDigest !== identity.blueprint.blueprintDigest
    ) {
      context.addIssue({
        code: "custom",
        message: "candidate identity relationships are inconsistent",
      });
    }
    if (
      new Set(identity.evidence.map((item) => item.provenance)).size !== identity.evidence.length ||
      new Set(identity.evidence.map((item) => item.evidenceDigest)).size !==
        identity.evidence.length
    ) {
      context.addIssue({ code: "custom", message: "candidate evidence must be unique" });
    }
    const { candidateDigest, ...content } = identity;
    if (candidateDigest !== calculateAgentSkillPackageCandidateIdentityValueDigest(content)) {
      context.addIssue({ code: "custom", message: "candidate identity digest is inconsistent" });
    }
  });

export function parseAgentSkillPackageCandidateIdentityValue(
  input: unknown,
): AgentSkillPackageCandidateIdentityValue {
  const parsed = identitySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Agent Skill package candidate identity is invalid");
  }
  return deepFreeze(parsed.data);
}

export function calculateAgentSkillPackageCandidateIdentityValueDigest(
  identity: Omit<AgentSkillPackageCandidateIdentityValue, "candidateDigest">,
): string {
  return createHash("sha256").update(canonicalize(identity)).digest("hex");
}

function isPortableRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= 128 &&
        segment !== "." &&
        segment !== ".." &&
        !Array.from(segment).some((character) => {
          const point = character.codePointAt(0);
          return point !== undefined && (point <= 31 || point === 127);
        }),
    )
  );
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("Agent Skill package candidate identity is invalid");
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
