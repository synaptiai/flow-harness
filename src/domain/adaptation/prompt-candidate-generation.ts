import { createHash } from "node:crypto";

import { z } from "zod";
import {
  MAX_PROMPT_CANDIDATE_GENERATION_EVIDENCE,
  MAX_PROMPT_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES,
  MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  MAX_PROMPT_CANDIDATE_GENERATION_TARGETS,
  PROMPT_CANDIDATE_GENERATION_SYSTEM_PROMPT,
  calculatePromptCandidateGenerationResponseDigest,
  renderPromptCandidateGenerationRequest,
} from "./prompt-candidate-generation-contract.js";
import { type PromptCandidateSource, parsePromptCandidateText } from "./prompt-candidate.js";
import {
  type TuningEvidencePacket,
  parseTuningEvidencePacket,
} from "../evaluation/tuning-evidence.js";
import { parseStrictJson } from "../strict-json.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import type { WorkflowSource } from "../workflow/schema.js";
import type { CompiledWorkflow, ThinkingLevel } from "../workflow/types.js";

export {
  MAX_PROMPT_CANDIDATE_GENERATION_EVIDENCE,
  MAX_PROMPT_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES,
  MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  MAX_PROMPT_CANDIDATE_GENERATION_TARGETS,
  PROMPT_CANDIDATE_GENERATION_REQUEST_KIND,
  PROMPT_CANDIDATE_GENERATION_SYSTEM_PROMPT,
} from "./prompt-candidate-generation-contract.js";

const responseSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            nodeId: z
              .string()
              .min(1)
              .max(96)
              .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
            value: z
              .string()
              .min(1)
              .max(262_144)
              .refine((value) => value.trim().length > 0, "replacement prompt cannot be blank"),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PROMPT_CANDIDATE_GENERATION_TARGETS)
      .refine(
        (changes) => new Set(changes.map((change) => change.nodeId)).size === changes.length,
        "generation response targets must be unique",
      ),
  })
  .strict();

export type PromptCandidateGenerationErrorCode =
  | "identity_mismatch"
  | "invalid_input"
  | "invalid_output"
  | "invalid_target"
  | "limit_exceeded";

export class PromptCandidateGenerationError extends Error {
  override readonly name = "PromptCandidateGenerationError";

  constructor(
    readonly code: PromptCandidateGenerationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export interface PromptCandidateGenerationInput {
  readonly candidate: { readonly id: string; readonly version: string };
  readonly baseline: {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly workflowDigest: string;
    readonly source: WorkflowSource;
    readonly compiled: CompiledWorkflow;
  };
  readonly evidence: readonly {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly packet: TuningEvidencePacket;
  }[];
  readonly allowedNodeIds: readonly string[];
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly thinking: ThinkingLevel;
  };
  readonly limits: {
    readonly timeoutMs: number;
    readonly maxOutputTokens: number;
  };
}

export interface PreparedPromptCandidateGeneration {
  readonly input: PromptCandidateGenerationInput;
  readonly renderedInput: string;
  readonly requestDigest: string;
  readonly targets: readonly {
    readonly nodeId: string;
    readonly prompt: string;
    readonly promptSha256: string;
  }[];
}

export interface PromptCandidateGenerationUsage {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly costUsdMicros: number;
}

export function preparePromptCandidateGeneration(
  input: PromptCandidateGenerationInput,
): PreparedPromptCandidateGeneration {
  validateIdentity(input);
  const targets = input.allowedNodeIds.map((nodeId) => {
    const node = input.baseline.source.nodes.find((item) => item.id === nodeId);
    if (node === undefined || node.type !== "agent") {
      throw new PromptCandidateGenerationError(
        "invalid_target",
        `prompt target "${nodeId}" is not a root agent node`,
      );
    }
    const compiledNode = input.baseline.compiled.nodes.find(
      (item) => item.id === nodeId && item.loopInstance === undefined,
    );
    if (
      compiledNode === undefined ||
      compiledNode.type !== "agent" ||
      compiledNode.agent.prompt !== node.agent.prompt
    ) {
      throw new PromptCandidateGenerationError(
        "identity_mismatch",
        `source prompt for "${nodeId}" does not match the compiled workflow`,
      );
    }
    return Object.freeze({
      nodeId,
      prompt: node.agent.prompt,
      promptSha256: sha256(node.agent.prompt),
    });
  });
  const renderedInput = renderPromptCandidateGenerationRequest({
    baseline: {
      workflowId: input.baseline.compiled.id,
      sourceSha256: input.baseline.sourceSha256,
      workflowDigest: input.baseline.workflowDigest,
    },
    targets,
    evidence: input.evidence.map((item) => ({
      sourceSha256: item.sourceSha256,
      packet: item.packet,
    })),
    model: input.model,
    limits: {
      maxOutputTokens: input.limits.maxOutputTokens,
      timeoutMs: input.limits.timeoutMs,
    },
  });
  if (Buffer.byteLength(renderedInput, "utf8") > MAX_PROMPT_CANDIDATE_GENERATION_INPUT_BYTES) {
    throw new PromptCandidateGenerationError(
      "limit_exceeded",
      `generation input exceeds ${MAX_PROMPT_CANDIDATE_GENERATION_INPUT_BYTES} UTF-8 bytes`,
    );
  }
  return deepFreeze({
    input,
    renderedInput,
    requestDigest: sha256(renderedInput),
    targets,
  });
}

export function completePromptCandidateGeneration(
  prepared: PreparedPromptCandidateGeneration,
  rawResponse: string,
  usage: PromptCandidateGenerationUsage,
): PromptCandidateSource {
  if (Buffer.byteLength(rawResponse, "utf8") > MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES) {
    throw new PromptCandidateGenerationError(
      "limit_exceeded",
      `generation response exceeds ${MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES} UTF-8 bytes`,
    );
  }
  validateUsage(usage, prepared.input.limits.maxOutputTokens);
  let raw: unknown;
  try {
    raw = parseStrictJson(rawResponse, {
      maxDepth: 8,
      maxNodes: 128,
      valueLabel: "prompt candidate generation response",
    });
  } catch (error) {
    throw new PromptCandidateGenerationError(
      "invalid_output",
      `invalid model response: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PromptCandidateGenerationError(
      "invalid_output",
      `invalid model response: ${boundedZodError(parsed.error)}`,
      { cause: parsed.error },
    );
  }

  const targets = new Map(prepared.targets.map((target) => [target.nodeId, target]));
  const prompts = parsed.data.changes.map((change) => {
    const target = targets.get(change.nodeId);
    if (target === undefined) {
      throw new PromptCandidateGenerationError(
        "invalid_target",
        `model response target "${change.nodeId}" is not permitted`,
      );
    }
    if (change.value === target.prompt) {
      throw new PromptCandidateGenerationError(
        "invalid_output",
        `model response target "${change.nodeId}" must change its prompt`,
      );
    }
    return {
      nodeId: change.nodeId,
      expectedSha256: target.promptSha256,
      value: change.value,
    };
  });
  const source = {
    apiVersion: "flow.synapti.ai/v1alpha1" as const,
    kind: "PromptCandidate" as const,
    metadata: {
      id: prepared.input.candidate.id,
      version: prepared.input.candidate.version,
    },
    scope: { kind: "workflow" as const, workflowId: prepared.input.baseline.compiled.id },
    baseline: {
      workflow: prepared.input.baseline.provenance,
      sourceSha256: prepared.input.baseline.sourceSha256,
      workflowDigest: prepared.input.baseline.workflowDigest,
    },
    evidence: prepared.input.evidence.map((item) => ({
      path: item.provenance,
      sourceSha256: item.sourceSha256,
      evidenceDigest: item.packet.evidenceDigest,
      planDigest: item.packet.evaluation.planDigest,
    })),
    changes: { prompts },
    generation: {
      version: 1 as const,
      kind: "model" as const,
      provider: prepared.input.model.provider,
      model: prepared.input.model.id,
      thinking: prepared.input.model.thinking,
      systemPromptSha256: sha256(PROMPT_CANDIDATE_GENERATION_SYSTEM_PROMPT),
      requestDigest: prepared.requestDigest,
      responseDigest: calculatePromptCandidateGenerationResponseDigest(parsed.data.changes),
      limits: {
        candidates: 1 as const,
        turns: 1 as const,
        maxInputBytes: MAX_PROMPT_CANDIDATE_GENERATION_INPUT_BYTES,
        maxOutputBytes: MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES,
        maxOutputTokens: prepared.input.limits.maxOutputTokens,
        timeoutMs: prepared.input.limits.timeoutMs,
      },
      targets: prepared.targets.map((target) => ({
        nodeId: target.nodeId,
        expectedSha256: target.promptSha256,
      })),
      usage,
    },
  };
  return parsePromptCandidateText(JSON.stringify(source), "generated prompt candidate");
}

function validateIdentity(input: PromptCandidateGenerationInput): void {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.candidate.id)) {
    throw new PromptCandidateGenerationError(
      "invalid_input",
      "candidate id must be a lower-case hyphenated identifier",
    );
  }
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      input.candidate.version,
    )
  ) {
    throw new PromptCandidateGenerationError(
      "invalid_input",
      "candidate version must be an exact semantic version",
    );
  }
  if (!isPortableRelativePath(input.baseline.provenance)) {
    throw new PromptCandidateGenerationError(
      "invalid_input",
      "baseline path must be a canonical portable relative path",
    );
  }
  if (input.baseline.source.metadata.id !== input.baseline.compiled.id) {
    throw new PromptCandidateGenerationError(
      "identity_mismatch",
      "baseline source and compiled workflow ids differ",
    );
  }
  validateDigest(input.baseline.sourceSha256, "baseline source");
  validateDigest(input.baseline.workflowDigest, "baseline workflow");
  if (calculateWorkflowDigest(input.baseline.compiled) !== input.baseline.workflowDigest) {
    throw new PromptCandidateGenerationError(
      "identity_mismatch",
      "baseline compiled workflow digest does not match its declaration",
    );
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.model.provider)) {
    throw new PromptCandidateGenerationError(
      "invalid_input",
      "generation provider must be a lower-case hyphenated identifier",
    );
  }
  if (
    input.model.id.length === 0 ||
    input.model.id.length > 256 ||
    input.model.id.trim() !== input.model.id
  ) {
    throw new PromptCandidateGenerationError(
      "invalid_input",
      "generation model id must contain between 1 and 256 non-padding characters",
    );
  }
  if (
    input.allowedNodeIds.length === 0 ||
    input.allowedNodeIds.length > MAX_PROMPT_CANDIDATE_GENERATION_TARGETS ||
    new Set(input.allowedNodeIds).size !== input.allowedNodeIds.length
  ) {
    throw new PromptCandidateGenerationError(
      "invalid_input",
      `generation requires between 1 and ${MAX_PROMPT_CANDIDATE_GENERATION_TARGETS} unique targets`,
    );
  }
  if (
    input.evidence.length === 0 ||
    input.evidence.length > MAX_PROMPT_CANDIDATE_GENERATION_EVIDENCE ||
    new Set(input.evidence.map((item) => item.provenance)).size !== input.evidence.length
  ) {
    throw new PromptCandidateGenerationError(
      "invalid_input",
      `generation requires between 1 and ${MAX_PROMPT_CANDIDATE_GENERATION_EVIDENCE} unique evidence files`,
    );
  }
  if (new Set(input.evidence.map((item) => item.sourceSha256)).size !== input.evidence.length) {
    throw new PromptCandidateGenerationError(
      "invalid_input",
      "generation evidence source identities must be unique",
    );
  }
  if (
    new Set(input.evidence.map((item) => item.packet.evidenceDigest)).size !== input.evidence.length
  ) {
    throw new PromptCandidateGenerationError(
      "invalid_input",
      "generation evidence digests must be unique",
    );
  }
  for (const item of input.evidence) {
    if (!isPortableRelativePath(item.provenance)) {
      throw new PromptCandidateGenerationError(
        "invalid_input",
        `evidence path "${item.provenance}" must be a canonical portable relative path`,
      );
    }
    validateDigest(item.sourceSha256, `evidence "${item.provenance}" source`);
    let packet: TuningEvidencePacket;
    try {
      packet = parseTuningEvidencePacket(item.packet);
    } catch (error) {
      throw new PromptCandidateGenerationError(
        "invalid_input",
        `evidence "${item.provenance}" is invalid: ${boundedMessage(error)}`,
        { cause: error },
      );
    }
    if (
      !packet.profiles.some((profile) => profile.workflowDigest === input.baseline.workflowDigest)
    ) {
      throw new PromptCandidateGenerationError(
        "identity_mismatch",
        `evidence "${item.provenance}" does not cover the baseline workflow`,
      );
    }
  }
  if (
    !Number.isSafeInteger(input.limits.timeoutMs) ||
    input.limits.timeoutMs <= 0 ||
    input.limits.timeoutMs > 86_400_000
  ) {
    throw new PromptCandidateGenerationError(
      "invalid_input",
      "generation timeout must be between 1 and 86400000ms",
    );
  }
  if (
    !Number.isSafeInteger(input.limits.maxOutputTokens) ||
    input.limits.maxOutputTokens <= 0 ||
    input.limits.maxOutputTokens > MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_TOKENS
  ) {
    throw new PromptCandidateGenerationError(
      "invalid_input",
      `generation output-token limit must be between 1 and ${MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_TOKENS}`,
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
    throw new PromptCandidateGenerationError("identity_mismatch", `${label} digest is invalid`);
  }
}

function validateUsage(usage: PromptCandidateGenerationUsage, maxOutputTokens: number): void {
  for (const [name, value] of Object.entries(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PromptCandidateGenerationError(
        "invalid_output",
        `generation usage ${name} must be a non-negative safe integer`,
      );
    }
  }
  if (usage.outputTokens > maxOutputTokens) {
    throw new PromptCandidateGenerationError(
      "limit_exceeded",
      `generation output used ${usage.outputTokens} tokens, above the ${maxOutputTokens} token limit`,
    );
  }
}

function boundedZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
    .join("; ")
    .slice(0, 2_048);
}

function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return value;
}
