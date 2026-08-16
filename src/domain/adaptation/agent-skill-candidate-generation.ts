import { createHash } from "node:crypto";

import { z } from "zod";
import {
  type AgentSkillPackageSnapshot,
  calculateCapabilitySnapshotDigest,
  MAX_AGENT_SKILL_FILE_BYTES,
  validateCapabilitySnapshot,
} from "../capability/agent-skills.js";
import {
  parseTuningEvidencePacket,
  type TuningEvidencePacket,
} from "../evaluation/tuning-evidence.js";
import { parseStrictJson } from "../strict-json.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import type { CompiledWorkflow, ThinkingLevel } from "../workflow/types.js";
import {
  type AgentSkillCandidateSource,
  assertAgentSkillCandidateClosedWorkflow,
  parseAgentSkillCandidateText,
} from "./agent-skill-candidate.js";
import {
  AGENT_SKILL_CANDIDATE_GENERATION_SYSTEM_PROMPT,
  calculateAgentSkillCandidateGenerationResponseDigest,
  isAgentSkillCandidateGenerationResourcePath,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_EVIDENCE,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_BYTES,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS,
  renderAgentSkillCandidateGenerationRequest,
} from "./agent-skill-candidate-generation-contract.js";

export {
  AGENT_SKILL_CANDIDATE_GENERATION_REQUEST_KIND,
  AGENT_SKILL_CANDIDATE_GENERATION_SYSTEM_PROMPT,
  isAgentSkillCandidateGenerationResourcePath,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_EVIDENCE,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_BYTES,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS,
} from "./agent-skill-candidate-generation-contract.js";

const responseSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .max(1_024)
              .refine(isPortableRelativePath, "must be a canonical portable relative path"),
            value: z
              .string()
              .min(1)
              .max(MAX_AGENT_SKILL_FILE_BYTES)
              .refine(
                (value) => Buffer.byteLength(value, "utf8") <= MAX_AGENT_SKILL_FILE_BYTES,
                "replacement resource exceeds its byte limit",
              ),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS)
      .refine(
        (changes) => new Set(changes.map((change) => change.path)).size === changes.length,
        "generation response targets must be unique",
      ),
  })
  .strict();

export type AgentSkillCandidateGenerationErrorCode =
  | "identity_mismatch"
  | "invalid_input"
  | "invalid_output"
  | "invalid_target"
  | "limit_exceeded";

export class AgentSkillCandidateGenerationError extends Error {
  override readonly name = "AgentSkillCandidateGenerationError";

  constructor(
    readonly code: AgentSkillCandidateGenerationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message.slice(0, 2_048)}`, options);
  }
}

export interface AgentSkillCandidateGenerationInput {
  readonly candidate: { readonly id: string; readonly version: string };
  readonly baseline: {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly workflowDigest: string;
    readonly compiled: CompiledWorkflow;
  };
  readonly skill: AgentSkillPackageSnapshot;
  readonly evidence: readonly {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly packet: TuningEvidencePacket;
  }[];
  readonly allowedResourcePaths: readonly string[];
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly thinking: ThinkingLevel;
  };
  readonly limits: { readonly timeoutMs: number; readonly maxOutputTokens: number };
}

export interface PreparedAgentSkillCandidateGeneration {
  readonly input: AgentSkillCandidateGenerationInput;
  readonly renderedInput: string;
  readonly requestDigest: string;
  readonly targets: readonly {
    readonly path: string;
    readonly value: string;
    readonly expectedSha256: string;
  }[];
}

export interface AgentSkillCandidateGenerationUsage {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly costUsdMicros: number;
}

export function prepareAgentSkillCandidateGeneration(
  input: AgentSkillCandidateGenerationInput,
): PreparedAgentSkillCandidateGeneration {
  validateInput(input);
  const files = new Map(input.skill.files.map((file) => [file.path, file]));
  const targets = input.allowedResourcePaths.map((path) => {
    const file = files.get(path);
    if (file === undefined || !isAgentSkillCandidateGenerationResourcePath(path)) {
      throw new AgentSkillCandidateGenerationError(
        "invalid_target",
        "selected resource is not an admitted UTF-8 generation target",
      );
    }
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(file.contentBase64, "base64"),
      );
    } catch {
      throw new AgentSkillCandidateGenerationError(
        "invalid_target",
        "selected resource is not an admitted UTF-8 generation target",
      );
    }
    return Object.freeze({ path, value, expectedSha256: file.sha256 });
  });
  const renderedInput = renderAgentSkillCandidateGenerationRequest(
    generationRequest(input, targets),
  );
  if (Buffer.byteLength(renderedInput, "utf8") > MAX_AGENT_SKILL_CANDIDATE_GENERATION_INPUT_BYTES) {
    throw new AgentSkillCandidateGenerationError(
      "limit_exceeded",
      `generation input exceeds ${MAX_AGENT_SKILL_CANDIDATE_GENERATION_INPUT_BYTES} UTF-8 bytes`,
    );
  }
  return deepFreeze({ input, renderedInput, requestDigest: sha256(renderedInput), targets });
}

export function completeAgentSkillCandidateGeneration(
  prepared: PreparedAgentSkillCandidateGeneration,
  rawResponse: string,
  usage: AgentSkillCandidateGenerationUsage,
): AgentSkillCandidateSource {
  if (Buffer.byteLength(rawResponse, "utf8") > MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_BYTES) {
    throw new AgentSkillCandidateGenerationError(
      "limit_exceeded",
      `generation response exceeds ${MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_BYTES} UTF-8 bytes`,
    );
  }
  validateUsage(usage, prepared.input.limits.maxOutputTokens);
  let raw: unknown;
  try {
    raw = parseStrictJson(rawResponse, {
      maxDepth: 8,
      maxNodes: 128,
      valueLabel: "Agent Skill candidate generation response",
    });
  } catch {
    throw new AgentSkillCandidateGenerationError("invalid_output", "invalid model response");
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentSkillCandidateGenerationError("invalid_output", "invalid model response");
  }
  const targets = new Map(prepared.targets.map((target) => [target.path, target]));
  const resources = parsed.data.changes.map((change) => {
    const target = targets.get(change.path);
    if (target === undefined) {
      throw new AgentSkillCandidateGenerationError(
        "invalid_target",
        "model response contains an unselected resource target",
      );
    }
    if (change.value === target.value) {
      throw new AgentSkillCandidateGenerationError(
        "invalid_output",
        "model response contains an unchanged resource target",
      );
    }
    return { path: change.path, expectedSha256: target.expectedSha256, value: change.value };
  });
  const source = {
    apiVersion: "flow.synapti.ai/v1alpha1" as const,
    kind: "AgentSkillCandidate" as const,
    metadata: prepared.input.candidate,
    scope: {
      kind: "workflow-agent-skill" as const,
      workflowId: prepared.input.baseline.compiled.id,
      skillName: prepared.input.skill.name,
    },
    baseline: {
      workflow: {
        path: prepared.input.baseline.provenance,
        sourceSha256: prepared.input.baseline.sourceSha256,
        workflowDigest: prepared.input.baseline.workflowDigest,
      },
      skill: {
        path: prepared.input.skill.provenance,
        packageDigest: prepared.input.skill.digest,
      },
    },
    evidence: prepared.input.evidence.map((item) => ({
      path: item.provenance,
      sourceSha256: item.sourceSha256,
      evidenceDigest: item.packet.evidenceDigest,
      planDigest: item.packet.evaluation.planDigest,
    })),
    changes: { resources },
    generation: {
      version: 1 as const,
      kind: "model" as const,
      provider: prepared.input.model.provider,
      model: prepared.input.model.id,
      thinking: prepared.input.model.thinking,
      systemPromptSha256: sha256(AGENT_SKILL_CANDIDATE_GENERATION_SYSTEM_PROMPT),
      requestDigest: prepared.requestDigest,
      responseDigest: calculateAgentSkillCandidateGenerationResponseDigest(parsed.data.changes),
      limits: {
        candidates: 1 as const,
        turns: 1 as const,
        maxInputBytes: MAX_AGENT_SKILL_CANDIDATE_GENERATION_INPUT_BYTES,
        maxOutputBytes: MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_BYTES,
        maxOutputTokens: prepared.input.limits.maxOutputTokens,
        timeoutMs: prepared.input.limits.timeoutMs,
      },
      targets: prepared.targets.map(({ path, expectedSha256 }) => ({ path, expectedSha256 })),
      usage,
    },
  };
  return parseAgentSkillCandidateText(JSON.stringify(source), "generated Agent Skill candidate");
}

function validateInput(input: AgentSkillCandidateGenerationInput): void {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.candidate.id)) {
    throw new AgentSkillCandidateGenerationError("invalid_input", "candidate id is invalid");
  }
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      input.candidate.version,
    )
  ) {
    throw new AgentSkillCandidateGenerationError("invalid_input", "candidate version is invalid");
  }
  if (!isPortableRelativePath(input.baseline.provenance)) {
    throw new AgentSkillCandidateGenerationError("invalid_input", "baseline path is invalid");
  }
  validateDigest(input.baseline.sourceSha256, "baseline source");
  validateDigest(input.baseline.workflowDigest, "baseline workflow");
  if (calculateWorkflowDigest(input.baseline.compiled) !== input.baseline.workflowDigest) {
    throw new AgentSkillCandidateGenerationError(
      "identity_mismatch",
      "baseline compiled workflow digest does not match",
    );
  }
  try {
    assertAgentSkillCandidateClosedWorkflow(input.baseline.compiled, input.skill.name);
  } catch {
    throw new AgentSkillCandidateGenerationError(
      "identity_mismatch",
      "baseline workflow must select exactly its scoped Agent Skill",
    );
  }
  try {
    validateCapabilitySnapshot({
      version: 1,
      packages: [input.skill],
      digest: calculateCapabilitySnapshotDigest([input.skill]),
    });
  } catch {
    throw new AgentSkillCandidateGenerationError(
      "identity_mismatch",
      "baseline skill package identity does not match",
    );
  }
  if (
    input.allowedResourcePaths.length === 0 ||
    input.allowedResourcePaths.length > MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS ||
    new Set(input.allowedResourcePaths).size !== input.allowedResourcePaths.length
  ) {
    throw new AgentSkillCandidateGenerationError(
      "invalid_input",
      `generation requires between 1 and ${MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS} unique targets`,
    );
  }
  if (
    input.evidence.length === 0 ||
    input.evidence.length > MAX_AGENT_SKILL_CANDIDATE_GENERATION_EVIDENCE ||
    new Set(input.evidence.map((item) => item.provenance)).size !== input.evidence.length ||
    new Set(input.evidence.map((item) => item.sourceSha256)).size !== input.evidence.length ||
    new Set(input.evidence.map((item) => item.packet.evidenceDigest)).size !== input.evidence.length
  ) {
    throw new AgentSkillCandidateGenerationError(
      "invalid_input",
      `generation requires between 1 and ${MAX_AGENT_SKILL_CANDIDATE_GENERATION_EVIDENCE} unique evidence files`,
    );
  }
  for (const item of input.evidence) {
    if (!isPortableRelativePath(item.provenance)) {
      throw new AgentSkillCandidateGenerationError("invalid_input", "evidence path is invalid");
    }
    validateDigest(item.sourceSha256, "evidence source");
    let packet: TuningEvidencePacket;
    try {
      packet = parseTuningEvidencePacket(item.packet);
    } catch {
      throw new AgentSkillCandidateGenerationError("invalid_input", "tuning evidence is invalid");
    }
    if (
      !packet.profiles.some((profile) => profile.workflowDigest === input.baseline.workflowDigest)
    ) {
      throw new AgentSkillCandidateGenerationError(
        "identity_mismatch",
        "tuning evidence does not cover the baseline workflow",
      );
    }
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.model.provider)) {
    throw new AgentSkillCandidateGenerationError("invalid_input", "generation provider is invalid");
  }
  if (
    input.model.id.length === 0 ||
    input.model.id.length > 256 ||
    input.model.id.trim() !== input.model.id
  ) {
    throw new AgentSkillCandidateGenerationError("invalid_input", "generation model id is invalid");
  }
  if (
    !Number.isSafeInteger(input.limits.timeoutMs) ||
    input.limits.timeoutMs <= 0 ||
    input.limits.timeoutMs > 86_400_000
  ) {
    throw new AgentSkillCandidateGenerationError("invalid_input", "generation timeout is invalid");
  }
  if (
    !Number.isSafeInteger(input.limits.maxOutputTokens) ||
    input.limits.maxOutputTokens <= 0 ||
    input.limits.maxOutputTokens > MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_TOKENS
  ) {
    throw new AgentSkillCandidateGenerationError(
      "invalid_input",
      "generation output-token limit is invalid",
    );
  }
}

function generationRequest(
  input: AgentSkillCandidateGenerationInput,
  targets: PreparedAgentSkillCandidateGeneration["targets"],
) {
  return {
    baseline: {
      workflowId: input.baseline.compiled.id,
      sourceSha256: input.baseline.sourceSha256,
      workflowDigest: input.baseline.workflowDigest,
    },
    skill: {
      name: input.skill.name,
      packageDigest: input.skill.digest,
      description: input.skill.description,
      ...(input.skill.license === undefined ? {} : { license: input.skill.license }),
      ...(input.skill.compatibility === undefined
        ? {}
        : { compatibility: input.skill.compatibility }),
      metadata: input.skill.metadata,
      requestedTools: input.skill.requestedTools,
      trust: input.skill.trust,
    },
    targets,
    evidence: input.evidence.map((item) => ({
      sourceSha256: item.sourceSha256,
      packet: item.packet,
    })),
    model: input.model,
    limits: input.limits,
  };
}

function validateUsage(usage: AgentSkillCandidateGenerationUsage, maxOutputTokens: number): void {
  for (const value of Object.values(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AgentSkillCandidateGenerationError("invalid_output", "generation usage is invalid");
    }
  }
  if (usage.outputTokens > maxOutputTokens) {
    throw new AgentSkillCandidateGenerationError(
      "limit_exceeded",
      "generation output exceeds its token limit",
    );
  }
}

function isPortableRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function validateDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new AgentSkillCandidateGenerationError("identity_mismatch", `${label} digest is invalid`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
