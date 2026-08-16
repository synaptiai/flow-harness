import { createHash } from "node:crypto";

import { z } from "zod";

import { agentSkillNameSchema } from "../capability/agent-skill-contract.js";

export const MAX_AGENT_SKILL_CANDIDATE_EVIDENCE = 16;
export const MAX_AGENT_SKILL_CANDIDATE_CHANGES = 16;

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
const portableRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isPortableRelativePath, "must be a canonical portable relative path");

export interface AgentSkillCandidateIdentity {
  readonly version: 1;
  readonly kind: "agent-skill-candidate";
  readonly id: string;
  readonly candidateVersion: string;
  readonly scope: {
    readonly kind: "workflow-agent-skill";
    readonly workflowId: string;
    readonly skillName: string;
  };
  readonly manifest: { readonly provenance: string; readonly sourceSha256: string };
  readonly baseline: {
    readonly workflow: {
      readonly provenance: string;
      readonly sourceSha256: string;
      readonly workflowDigest: string;
    };
    readonly skill: {
      readonly name: string;
      readonly provenance: string;
      readonly packageDigest: string;
      readonly capabilityDigest: string;
    };
  };
  readonly evidence: readonly {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly evidenceDigest: string;
    readonly planDigest: string;
  }[];
  readonly changes: readonly {
    readonly path: string;
    readonly beforeSha256: string;
    readonly afterSha256: string;
  }[];
  readonly projectedSkill: {
    readonly packageDigest: string;
    readonly capabilityDigest: string;
  };
  readonly candidateDigest: string;
}

const agentSkillCandidateIdentitySchema: z.ZodType<AgentSkillCandidateIdentity> = z
  .object({
    version: z.literal(1),
    kind: z.literal("agent-skill-candidate"),
    id: identifierSchema,
    candidateVersion: semverSchema,
    scope: z
      .object({
        kind: z.literal("workflow-agent-skill"),
        workflowId: identifierSchema,
        skillName: agentSkillNameSchema,
      })
      .strict(),
    manifest: z
      .object({ provenance: portableRelativePathSchema, sourceSha256: sha256Schema })
      .strict(),
    baseline: z
      .object({
        workflow: z
          .object({
            provenance: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
          })
          .strict(),
        skill: z
          .object({
            name: agentSkillNameSchema,
            provenance: portableRelativePathSchema,
            packageDigest: sha256Schema,
            capabilityDigest: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    evidence: z
      .array(
        z
          .object({
            provenance: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            evidenceDigest: sha256Schema,
            planDigest: sha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_AGENT_SKILL_CANDIDATE_EVIDENCE),
    changes: z
      .array(
        z
          .object({
            path: portableRelativePathSchema,
            beforeSha256: sha256Schema,
            afterSha256: sha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_AGENT_SKILL_CANDIDATE_CHANGES),
    projectedSkill: z
      .object({ packageDigest: sha256Schema, capabilityDigest: sha256Schema })
      .strict(),
    candidateDigest: sha256Schema,
  })
  .strict()
  .superRefine((identity, context) => {
    if (
      identity.scope.skillName !== identity.baseline.skill.name ||
      identity.baseline.skill.packageDigest === identity.projectedSkill.packageDigest ||
      identity.baseline.skill.capabilityDigest === identity.projectedSkill.capabilityDigest ||
      new Set(identity.evidence.map((item) => item.provenance)).size !== identity.evidence.length ||
      new Set(identity.evidence.map((item) => item.evidenceDigest)).size !==
        identity.evidence.length ||
      new Set(identity.changes.map((item) => item.path)).size !== identity.changes.length ||
      identity.changes.some((item) => item.beforeSha256 === item.afterSha256)
    ) {
      context.addIssue({ code: "custom", message: "candidate identity is inconsistent" });
    }
    const { candidateDigest, ...content } = identity;
    if (candidateDigest !== calculateAgentSkillCandidateIdentityDigest(content)) {
      context.addIssue({ code: "custom", message: "candidate identity digest is inconsistent" });
    }
  });

export function parseAgentSkillCandidateIdentity(input: unknown): AgentSkillCandidateIdentity {
  const parsed = agentSkillCandidateIdentitySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("candidate identity is invalid");
  }
  return deepFreeze(parsed.data);
}

export function calculateAgentSkillCandidateIdentityDigest(
  identity: Omit<AgentSkillCandidateIdentity, "candidateDigest">,
): string {
  return createHash("sha256").update(canonicalize(identity)).digest("hex");
}

function isPortableRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
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
  throw new Error("candidate identity is not JSON");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
