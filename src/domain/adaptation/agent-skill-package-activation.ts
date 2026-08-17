import { createHash } from "node:crypto";

import { z } from "zod";

import {
  type AgentSkillPackageSnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../capability/agent-skills.js";
import { compileWorkflowText } from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import {
  type AgentSkillPackageCandidateIdentityValue,
  parseAgentSkillPackageCandidateIdentityValue,
} from "./agent-skill-package-candidate-identity.js";
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

const snapshotSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("agent-skill-package-activation"),
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
    skill: z.unknown().optional(),
    activationDigest: sha256Schema,
  })
  .strict();

export interface AgentSkillPackageActivationSnapshot {
  readonly version: 1;
  readonly kind: "agent-skill-package-activation";
  readonly selection: "baseline" | "candidate";
  readonly workflowId: string;
  readonly candidateId: string;
  readonly candidateVersion: string;
  readonly candidate: AgentSkillPackageCandidateIdentityValue;
  readonly evaluation: PromptActivationEvaluationProof;
  readonly workflow: {
    readonly bytes: number;
    readonly sha256: string;
    readonly contentBase64: string;
  };
  readonly skill?: AgentSkillPackageSnapshot | undefined;
  readonly activationDigest: string;
}

export interface CreateAgentSkillPackageActivationSnapshotInput {
  readonly selection: "baseline" | "candidate";
  readonly candidate: AgentSkillPackageCandidateIdentityValue;
  readonly evaluation: PromptActivationEvaluationProof;
  readonly workflowSource: string;
  readonly skill?: AgentSkillPackageSnapshot | undefined;
}

export class AgentSkillPackageActivationError extends Error {
  override readonly name = "AgentSkillPackageActivationError";

  constructor(
    readonly code: "identity_mismatch" | "invalid_schema" | "invalid_source" | "limit_exceeded",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function createAgentSkillPackageActivationSnapshot(
  input: CreateAgentSkillPackageActivationSnapshotInput,
): AgentSkillPackageActivationSnapshot {
  const candidate = parseCandidate(input.candidate);
  const evaluation = parseEvaluation(input.evaluation);
  const workflow = Buffer.from(input.workflowSource, "utf8");
  if (workflow.byteLength > MAX_PROMPT_ACTIVATION_SOURCE_BYTES) {
    throw new AgentSkillPackageActivationError(
      "limit_exceeded",
      "activation workflow exceeds its byte limit",
    );
  }
  const skill = input.skill === undefined ? undefined : parseSkill(input.skill);
  assertSelection(input.selection, candidate, workflow, skill);
  const content = {
    version: 1 as const,
    kind: "agent-skill-package-activation" as const,
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
    ...(skill === undefined ? {} : { skill }),
  };
  return parseAgentSkillPackageActivationSnapshot({
    ...content,
    activationDigest: calculateAgentSkillPackageActivationDigest(content),
  });
}

export function parseAgentSkillPackageActivationSnapshot(
  input: unknown,
): AgentSkillPackageActivationSnapshot {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentSkillPackageActivationError("invalid_schema", "activation snapshot is invalid");
  }
  const candidate = parseCandidate(parsed.data.candidate);
  const evaluation = parseEvaluation(parsed.data.evaluation);
  const workflow = decodeCanonicalBase64(parsed.data.workflow.contentBase64);
  if (
    workflow.byteLength !== parsed.data.workflow.bytes ||
    sha256(workflow) !== parsed.data.workflow.sha256
  ) {
    throw new AgentSkillPackageActivationError(
      "identity_mismatch",
      "activation workflow identity does not match",
    );
  }
  const skill = parsed.data.skill === undefined ? undefined : parseSkill(parsed.data.skill);
  assertSelection(parsed.data.selection, candidate, workflow, skill);
  if (
    parsed.data.workflowId !== candidate.scope.workflowId ||
    parsed.data.candidateId !== candidate.id ||
    parsed.data.candidateVersion !== candidate.candidateVersion
  ) {
    throw new AgentSkillPackageActivationError(
      "identity_mismatch",
      "activation candidate identity does not match",
    );
  }
  const snapshot: AgentSkillPackageActivationSnapshot = {
    version: parsed.data.version,
    kind: parsed.data.kind,
    selection: parsed.data.selection,
    workflowId: parsed.data.workflowId,
    candidateId: parsed.data.candidateId,
    candidateVersion: parsed.data.candidateVersion,
    candidate,
    evaluation,
    workflow: parsed.data.workflow,
    ...(skill === undefined ? {} : { skill }),
    activationDigest: parsed.data.activationDigest,
  };
  if (calculateAgentSkillPackageActivationDigest(snapshot) !== snapshot.activationDigest) {
    throw new AgentSkillPackageActivationError(
      "identity_mismatch",
      "activation snapshot digest does not match",
    );
  }
  return deepFreeze(snapshot);
}

export function calculateAgentSkillPackageActivationDigest(
  snapshot:
    | Omit<AgentSkillPackageActivationSnapshot, "activationDigest">
    | AgentSkillPackageActivationSnapshot,
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
      skill:
        snapshot.skill === undefined
          ? null
          : { name: snapshot.skill.name, digest: snapshot.skill.digest },
    }),
  );
}

export function agentSkillPackageActivationWorkflow(
  snapshot: AgentSkillPackageActivationSnapshot,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      decodeCanonicalBase64(snapshot.workflow.contentBase64),
    );
  } catch {
    throw new AgentSkillPackageActivationError(
      "invalid_source",
      "activation workflow is not UTF-8",
    );
  }
}

function assertSelection(
  selection: "baseline" | "candidate",
  candidate: AgentSkillPackageCandidateIdentityValue,
  workflow: Uint8Array,
  skill: AgentSkillPackageSnapshot | undefined,
): void {
  let compiledDigest: string;
  try {
    compiledDigest = calculateWorkflowDigest(
      compileWorkflowText(
        new TextDecoder("utf-8", { fatal: true }).decode(workflow),
        "saved Agent Skill package activation workflow",
      ),
    );
  } catch {
    throw new AgentSkillPackageActivationError("invalid_source", "activation workflow is invalid");
  }
  const expectedWorkflow =
    selection === "baseline" ? candidate.baseline.workflow : candidate.projectedWorkflow;
  if (
    sha256(workflow) !== expectedWorkflow.sourceSha256 ||
    compiledDigest !== expectedWorkflow.workflowDigest
  ) {
    throw new AgentSkillPackageActivationError(
      "identity_mismatch",
      "activation workflow does not match the evaluated selection",
    );
  }
  if (selection === "baseline") {
    if (skill !== undefined) {
      throw new AgentSkillPackageActivationError(
        "identity_mismatch",
        "baseline activation must not contain a generated package",
      );
    }
    return;
  }
  if (
    skill === undefined ||
    skill.name !== candidate.package.name ||
    skill.provenance !== candidate.package.provenance ||
    skill.digest !== candidate.package.packageDigest ||
    calculateCapabilitySnapshotDigest([skill]) !== candidate.package.capabilityDigest
  ) {
    throw new AgentSkillPackageActivationError(
      "identity_mismatch",
      "candidate activation package does not match the evaluated selection",
    );
  }
}

function parseCandidate(input: unknown): AgentSkillPackageCandidateIdentityValue {
  try {
    return parseAgentSkillPackageCandidateIdentityValue(input);
  } catch {
    throw new AgentSkillPackageActivationError(
      "identity_mismatch",
      "candidate identity is invalid",
    );
  }
}

function parseEvaluation(input: unknown): PromptActivationEvaluationProof {
  try {
    return parsePromptActivationEvaluationProof(input);
  } catch {
    throw new AgentSkillPackageActivationError(
      "invalid_schema",
      "activation evaluation proof is invalid",
    );
  }
}

function parseSkill(input: unknown): AgentSkillPackageSnapshot {
  try {
    const packages = [input as AgentSkillPackageSnapshot];
    const snapshot = validateCapabilitySnapshot({
      version: 1,
      packages,
      digest: calculateCapabilitySnapshotDigest(packages),
    });
    const skill = snapshot.packages[0];
    if (snapshot.packages.length !== 1 || skill?.kind !== "agent-skill") {
      throw new Error("selected package is invalid");
    }
    return skill;
  } catch {
    throw new AgentSkillPackageActivationError(
      "invalid_schema",
      "activation package snapshot is invalid",
    );
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new AgentSkillPackageActivationError(
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
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  throw new AgentSkillPackageActivationError("invalid_schema", "activation value is invalid");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
