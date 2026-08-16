import { createHash } from "node:crypto";

import { z } from "zod";
import {
  type AgentSkillPackageSnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../capability/agent-skills.js";
import { compileWorkflowText, WorkflowCompilationError } from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import {
  type AgentSkillCandidateIdentity,
  parseAgentSkillCandidateIdentity,
} from "./agent-skill-candidate-identity.js";
import {
  MAX_PROMPT_ACTIVATION_SOURCE_BYTES,
  type PromptActivationEvaluationProof,
  parsePromptActivationEvaluationProof,
} from "./prompt-activation.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
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

const agentSkillActivationSnapshotSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("agent-skill-activation"),
    selection: z.enum(["baseline", "candidate"]),
    workflowId: identifierSchema,
    candidateId: identifierSchema,
    candidateVersion: semverSchema,
    candidate: z.unknown(),
    evaluation: z.unknown(),
    workflow: z
      .object({
        bytes: z.number().int().positive().max(MAX_PROMPT_ACTIVATION_SOURCE_BYTES),
        sha256: sha256Schema,
        contentBase64: z.string().max(Math.ceil((MAX_PROMPT_ACTIVATION_SOURCE_BYTES * 4) / 3) + 4),
      })
      .strict(),
    skill: z.unknown(),
    activationDigest: sha256Schema,
  })
  .strict();

export interface AgentSkillActivationSnapshot {
  readonly version: 1;
  readonly kind: "agent-skill-activation";
  readonly selection: "baseline" | "candidate";
  readonly workflowId: string;
  readonly candidateId: string;
  readonly candidateVersion: string;
  readonly candidate: AgentSkillCandidateIdentity;
  readonly evaluation: PromptActivationEvaluationProof;
  readonly workflow: {
    readonly bytes: number;
    readonly sha256: string;
    readonly contentBase64: string;
  };
  readonly skill: AgentSkillPackageSnapshot;
  readonly activationDigest: string;
}

export interface CreateAgentSkillActivationSnapshotInput {
  readonly selection: "baseline" | "candidate";
  readonly candidate: AgentSkillCandidateIdentity;
  readonly evaluation: PromptActivationEvaluationProof;
  readonly workflowSource: string;
  readonly skill: AgentSkillPackageSnapshot;
}

export type AgentSkillActivationErrorCode =
  | "identity_mismatch"
  | "invalid_schema"
  | "invalid_source"
  | "limit_exceeded";

export class AgentSkillActivationError extends Error {
  override readonly name = "AgentSkillActivationError";

  constructor(
    readonly code: AgentSkillActivationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function createAgentSkillActivationSnapshot(
  input: CreateAgentSkillActivationSnapshotInput,
): AgentSkillActivationSnapshot {
  const candidate = parseCandidate(input.candidate);
  const evaluation = parseEvaluation(input.evaluation);
  const workflow = Buffer.from(input.workflowSource, "utf8");
  if (workflow.byteLength > MAX_PROMPT_ACTIVATION_SOURCE_BYTES) {
    throw new AgentSkillActivationError(
      "limit_exceeded",
      `activation workflow exceeds ${MAX_PROMPT_ACTIVATION_SOURCE_BYTES} UTF-8 bytes`,
    );
  }
  const skill = parseSelectedSkill(input.skill);
  const snapshotWithoutDigest = {
    version: 1 as const,
    kind: "agent-skill-activation" as const,
    selection: input.selection,
    workflowId: candidate.scope.workflowId,
    candidateId: candidate.id,
    candidateVersion: candidate.candidateVersion,
    candidate,
    evaluation,
    workflow: {
      bytes: workflow.byteLength,
      sha256: sha256(workflow),
      contentBase64: workflow.toString("base64"),
    },
    skill,
  };
  return parseAgentSkillActivationSnapshot({
    ...snapshotWithoutDigest,
    activationDigest: calculateAgentSkillActivationDigest(snapshotWithoutDigest),
  });
}

export function parseAgentSkillActivationSnapshot(input: unknown): AgentSkillActivationSnapshot {
  const parsed = agentSkillActivationSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentSkillActivationError("invalid_schema", "activation snapshot is invalid");
  }
  const candidate = parseCandidate(parsed.data.candidate);
  const evaluation = parseEvaluation(parsed.data.evaluation);
  const skill = parseSelectedSkill(parsed.data.skill);
  const workflow = decodeCanonicalBase64(parsed.data.workflow.contentBase64);
  if (
    workflow.byteLength !== parsed.data.workflow.bytes ||
    sha256(workflow) !== parsed.data.workflow.sha256
  ) {
    throw new AgentSkillActivationError(
      "identity_mismatch",
      "activation workflow byte count or digest does not match",
    );
  }
  const workflowIdentity = compileActivationWorkflow(workflow);
  if (
    parsed.data.workflowId !== candidate.scope.workflowId ||
    parsed.data.workflowId !== workflowIdentity.workflowId ||
    parsed.data.candidateId !== candidate.id ||
    parsed.data.candidateVersion !== candidate.candidateVersion ||
    parsed.data.workflow.sha256 !== candidate.baseline.workflow.sourceSha256 ||
    workflowIdentity.workflowDigest !== candidate.baseline.workflow.workflowDigest
  ) {
    throw new AgentSkillActivationError(
      "identity_mismatch",
      "activation workflow does not match its candidate identity",
    );
  }
  assertSelectedSkill(parsed.data.selection, candidate, skill);
  const snapshot: AgentSkillActivationSnapshot = {
    ...parsed.data,
    candidate,
    evaluation,
    skill,
  };
  if (calculateAgentSkillActivationDigest(snapshot) !== snapshot.activationDigest) {
    throw new AgentSkillActivationError(
      "identity_mismatch",
      "activation snapshot digest does not match",
    );
  }
  return deepFreeze(snapshot);
}

export function calculateAgentSkillActivationDigest(
  snapshot: Omit<AgentSkillActivationSnapshot, "activationDigest"> | AgentSkillActivationSnapshot,
): string {
  return sha256(
    canonicalize({
      version: snapshot.version,
      kind: snapshot.kind,
      selection: snapshot.selection,
      workflowId: snapshot.workflowId,
      candidateId: snapshot.candidateId,
      candidateVersion: snapshot.candidateVersion,
      candidate: snapshot.candidate,
      evaluation: snapshot.evaluation,
      workflow: { bytes: snapshot.workflow.bytes, sha256: snapshot.workflow.sha256 },
      skill: { name: snapshot.skill.name, digest: snapshot.skill.digest },
    }),
  );
}

export function agentSkillActivationWorkflow(snapshot: AgentSkillActivationSnapshot): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      decodeCanonicalBase64(snapshot.workflow.contentBase64),
    );
  } catch {
    throw new AgentSkillActivationError("invalid_source", "activation workflow is not UTF-8");
  }
}

function parseCandidate(input: unknown): AgentSkillCandidateIdentity {
  try {
    return parseAgentSkillCandidateIdentity(input);
  } catch {
    throw new AgentSkillActivationError("identity_mismatch", "candidate identity is invalid");
  }
}

function parseEvaluation(input: unknown): PromptActivationEvaluationProof {
  try {
    return parsePromptActivationEvaluationProof(input);
  } catch {
    throw new AgentSkillActivationError("invalid_schema", "activation evaluation proof is invalid");
  }
}

function parseSelectedSkill(input: unknown): AgentSkillPackageSnapshot {
  try {
    const packages = [input as AgentSkillPackageSnapshot];
    const snapshot = validateCapabilitySnapshot({
      version: 1,
      packages,
      digest: calculateCapabilitySnapshotDigest(packages),
    });
    const skill = snapshot.packages[0];
    if (snapshot.packages.length !== 1 || skill?.kind !== "agent-skill") {
      throw new Error("selected package is not an Agent Skill");
    }
    return skill;
  } catch {
    throw new AgentSkillActivationError("invalid_schema", "activation skill snapshot is invalid");
  }
}

function assertSelectedSkill(
  selection: "baseline" | "candidate",
  candidate: AgentSkillCandidateIdentity,
  skill: AgentSkillPackageSnapshot,
): void {
  const expected =
    selection === "baseline"
      ? {
          packageDigest: candidate.baseline.skill.packageDigest,
          capabilityDigest: candidate.baseline.skill.capabilityDigest,
        }
      : candidate.projectedSkill;
  const capabilityDigest = calculateCapabilitySnapshotDigest([skill]);
  if (
    skill.name !== candidate.scope.skillName ||
    skill.name !== candidate.baseline.skill.name ||
    skill.provenance !== candidate.baseline.skill.provenance ||
    skill.digest !== expected.packageDigest ||
    capabilityDigest !== expected.capabilityDigest
  ) {
    throw new AgentSkillActivationError(
      "identity_mismatch",
      `activation skill does not match the evaluated ${selection} selection`,
    );
  }
}

function compileActivationWorkflow(content: Uint8Array): {
  readonly workflowId: string;
  readonly workflowDigest: string;
} {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const compiled = compileWorkflowText(source, "saved Agent Skill activation workflow");
    return { workflowId: compiled.id, workflowDigest: calculateWorkflowDigest(compiled) };
  } catch (error) {
    throw new AgentSkillActivationError(
      "invalid_source",
      error instanceof WorkflowCompilationError
        ? "activation workflow is not valid"
        : "activation workflow is not UTF-8",
    );
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new AgentSkillActivationError(
      "invalid_source",
      "activation workflow is not canonical base64",
    );
  }
  return content;
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
  throw new AgentSkillActivationError("invalid_schema", "activation value is not canonical JSON");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
