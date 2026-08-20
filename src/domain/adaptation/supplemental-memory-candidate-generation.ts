import { createHash } from "node:crypto";

import { z } from "zod";
import { calculateCapabilitySnapshotDigest } from "../capability/agent-skills.js";
import {
  parseTuningEvidencePacket,
  type TuningEvidencePacket,
} from "../evaluation/tuning-evidence.js";
import { parseStrictJson } from "../strict-json.js";
import type { ThinkingLevel } from "../workflow/types.js";
import {
  compileEffectiveHarnessState,
  type EffectiveHarnessState,
} from "./effective-harness-state.js";
import {
  MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES,
  type SupplementalMemoryEntry,
  type SupplementalMemoryTarget,
  supplementalMemoryContent,
} from "./supplemental-memory.js";
import {
  parseSupplementalMemoryCandidateText,
  projectSupplementalMemoryCandidate,
  type SupplementalMemoryCandidateSource,
} from "./supplemental-memory-candidate.js";
import {
  calculateSupplementalMemoryCandidateGenerationResponseDigest,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  renderSupplementalMemoryCandidateGenerationRequest,
  SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_SYSTEM_PROMPT,
} from "./supplemental-memory-candidate-generation-contract.js";

export {
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_REQUEST_KIND,
  SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_SYSTEM_PROMPT,
} from "./supplemental-memory-candidate-generation-contract.js";

const responseSchema = z.object({ value: z.string() }).strict();

export type SupplementalMemoryCandidateGenerationErrorCode =
  | "identity_mismatch"
  | "invalid_input"
  | "invalid_output"
  | "invalid_target"
  | "limit_exceeded";

export class SupplementalMemoryCandidateGenerationError extends Error {
  override readonly name = "SupplementalMemoryCandidateGenerationError";

  constructor(
    readonly code: SupplementalMemoryCandidateGenerationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface SupplementalMemoryCandidateGenerationInput {
  readonly candidate: { readonly id: string; readonly version: string };
  readonly baseline: EffectiveHarnessState;
  readonly target: {
    readonly workflowId: string;
    readonly childPath: readonly string[];
    readonly agentNodeId: string;
    readonly entryId: string;
    readonly operation: "add" | "replace";
  };
  readonly evidence: readonly {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly packet: TuningEvidencePacket;
  }[];
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

export interface PreparedSupplementalMemoryCandidateGeneration {
  readonly input: SupplementalMemoryCandidateGenerationInput;
  readonly renderedInput: string;
  readonly requestDigest: string;
  readonly prior: SupplementalMemoryEntry | null;
}

export interface SupplementalMemoryCandidateGenerationUsage {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly costUsdMicros: number;
}

export function prepareSupplementalMemoryCandidateGeneration(
  input: SupplementalMemoryCandidateGenerationInput,
): PreparedSupplementalMemoryCandidateGeneration {
  validateInput(input);
  const compiled = compileEffectiveHarnessState(input.baseline);
  let selectedWorkflow = compiled;
  for (const childNodeId of input.target.childPath) {
    const child = selectedWorkflow.nodes.find((node) => node.id === childNodeId);
    if (child?.type !== "child" || child.child.workflow.sourcePackage !== undefined) {
      throw new SupplementalMemoryCandidateGenerationError(
        "invalid_target",
        "generation target does not identify an embedded child workflow",
      );
    }
    selectedWorkflow = child.child.workflow;
  }
  const agent = selectedWorkflow.nodes.find(
    (node) => node.id === input.target.agentNodeId && node.type === "agent",
  );
  if (agent?.type !== "agent") {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_target",
      "generation target does not identify an agent node",
    );
  }
  const target: SupplementalMemoryTarget = {
    workflowId: input.target.workflowId,
    childPath: input.target.childPath,
    agentNodeId: input.target.agentNodeId,
  };
  const targetMemory = (input.baseline.supplementalMemory ?? []).filter((entry) =>
    sameTarget(entry.target, target),
  );
  const selected = targetMemory.find((entry) => entry.id === input.target.entryId);
  if (
    (input.target.operation === "add" && selected !== undefined) ||
    (input.target.operation === "replace" && selected === undefined)
  ) {
    throw new SupplementalMemoryCandidateGenerationError(
      "identity_mismatch",
      "generation operation does not match the target entry state",
    );
  }
  const admittedEvidence = input.evidence.map((item) => {
    const packet = parseTuningEvidencePacket(item.packet);
    if (
      !packet.profiles.some(
        (profile) => profile.workflowDigest === input.baseline.workflow.workflowDigest,
      )
    ) {
      throw new SupplementalMemoryCandidateGenerationError(
        "identity_mismatch",
        "generation evidence does not cover the effective workflow",
      );
    }
    return { sourceSha256: item.sourceSha256, packet };
  });
  const renderedInput = renderSupplementalMemoryCandidateGenerationRequest({
    baseline: {
      stateDigest: input.baseline.stateDigest,
      workflowDigest: input.baseline.workflow.workflowDigest,
      packageClosureDigest: calculateCapabilitySnapshotDigest(input.baseline.packages),
    },
    target: {
      scope: {
        kind: "workflow-agent-memory",
        workflowId: input.target.workflowId,
        childPath: input.target.childPath,
        agentNodeId: input.target.agentNodeId,
        entryId: input.target.entryId,
      },
      operation: input.target.operation,
      prior: selected === undefined ? null : memoryValue(selected),
      agent: { prompt: agent.agent.prompt, promptSha256: sha256(agent.agent.prompt) },
      memory: targetMemory.map((entry) => ({ id: entry.id, ...memoryValue(entry) })),
    },
    evidence: admittedEvidence,
    model: input.model,
    limits: input.limits,
  });
  if (
    Buffer.byteLength(renderedInput, "utf8") >
    MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_INPUT_BYTES
  ) {
    throw new SupplementalMemoryCandidateGenerationError(
      "limit_exceeded",
      "supplemental-memory generation input exceeds its UTF-8 byte limit",
    );
  }
  return deepFreeze({
    input,
    renderedInput,
    requestDigest: sha256(renderedInput),
    prior: selected ?? null,
  });
}

export function completeSupplementalMemoryCandidateGeneration(
  prepared: PreparedSupplementalMemoryCandidateGeneration,
  rawResponse: string,
  usage: SupplementalMemoryCandidateGenerationUsage,
): SupplementalMemoryCandidateSource {
  if (
    Buffer.byteLength(rawResponse, "utf8") >
    MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES
  ) {
    throw new SupplementalMemoryCandidateGenerationError(
      "limit_exceeded",
      "supplemental-memory generation response exceeds its UTF-8 byte limit",
    );
  }
  validateUsage(usage, prepared.input.limits.maxOutputTokens);
  let raw: unknown;
  try {
    raw = parseStrictJson(rawResponse, {
      maxDepth: 4,
      maxNodes: 8,
      valueLabel: "supplemental-memory candidate generation response",
    });
  } catch {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_output",
      "supplemental-memory generation response is invalid",
    );
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_output",
      "supplemental-memory generation response is invalid",
    );
  }
  const valueBytes = Buffer.from(parsed.data.value, "utf8");
  if (valueBytes.toString("utf8") !== parsed.data.value || parsed.data.value.trim().length === 0) {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_output",
      "supplemental-memory generation value is invalid",
    );
  }
  if (valueBytes.byteLength > MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES) {
    throw new SupplementalMemoryCandidateGenerationError(
      "limit_exceeded",
      "supplemental-memory generation value exceeds its UTF-8 byte limit",
    );
  }
  if (
    prepared.input.target.operation === "replace" &&
    prepared.prior !== null &&
    supplementalMemoryContent(prepared.prior) === parsed.data.value
  ) {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_output",
      "supplemental-memory generation value must change the selected entry",
    );
  }
  const source = parseSupplementalMemoryCandidateText(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "SupplementalMemoryCandidate",
      metadata: prepared.input.candidate,
      scope: {
        kind: "workflow-agent-memory",
        workflowId: prepared.input.target.workflowId,
        childPath: prepared.input.target.childPath,
        agentNodeId: prepared.input.target.agentNodeId,
        entryId: prepared.input.target.entryId,
      },
      baseline: {
        stateDigest: prepared.input.baseline.stateDigest,
        workflowDigest: prepared.input.baseline.workflow.workflowDigest,
        packageClosureDigest: calculateCapabilitySnapshotDigest(prepared.input.baseline.packages),
      },
      change:
        prepared.input.target.operation === "add"
          ? { kind: "add", value: parsed.data.value }
          : {
              kind: "replace",
              beforeSha256: requiredPrior(prepared).sha256,
              value: parsed.data.value,
            },
      generation: {
        version: 1,
        kind: "model",
        provider: prepared.input.model.provider,
        model: prepared.input.model.id,
        thinking: prepared.input.model.thinking,
        systemPromptSha256: sha256(SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_SYSTEM_PROMPT),
        requestDigest: prepared.requestDigest,
        responseDigest: calculateSupplementalMemoryCandidateGenerationResponseDigest(
          parsed.data.value,
        ),
        limits: {
          candidates: 1,
          turns: 1,
          maxInputBytes: MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_INPUT_BYTES,
          maxOutputBytes: MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES,
          maxOutputTokens: prepared.input.limits.maxOutputTokens,
          timeoutMs: prepared.input.limits.timeoutMs,
        },
        operation: prepared.input.target.operation,
        priorSha256: prepared.prior?.sha256 ?? null,
        evidence: prepared.input.evidence.map((item) => ({
          path: item.provenance,
          sourceSha256: item.sourceSha256,
          evidenceDigest: item.packet.evidenceDigest,
          planDigest: item.packet.evaluation.planDigest,
        })),
        usage,
      },
    }),
    "generated supplemental-memory candidate",
  );
  const sourceText = JSON.stringify(source);
  projectSupplementalMemoryCandidate({
    manifestProvenance: "generated-supplemental-memory.candidate.json",
    sourceSha256: sha256(sourceText),
    source,
    baseline: prepared.input.baseline,
    evidence: prepared.input.evidence,
  });
  return source;
}

function validateInput(input: SupplementalMemoryCandidateGenerationInput): void {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.candidate.id)) {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_input",
      "candidate id is invalid",
    );
  }
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      input.candidate.version,
    )
  ) {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_input",
      "candidate version is invalid",
    );
  }
  if (input.target.workflowId !== input.baseline.workflowId) {
    throw new SupplementalMemoryCandidateGenerationError(
      "identity_mismatch",
      "generation target belongs to a different workflow",
    );
  }
  for (const value of [input.target.agentNodeId, input.target.entryId, ...input.target.childPath]) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) {
      throw new SupplementalMemoryCandidateGenerationError(
        "invalid_input",
        "generation target identity is invalid",
      );
    }
  }
  if (input.target.childPath.length > 8) {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_input",
      "generation child path exceeds its limit",
    );
  }
  if (
    input.evidence.length === 0 ||
    input.evidence.length > MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE ||
    new Set(input.evidence.map((item) => item.provenance)).size !== input.evidence.length ||
    new Set(input.evidence.map((item) => item.packet.evidenceDigest)).size !== input.evidence.length
  ) {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_input",
      "generation evidence set is invalid",
    );
  }
  for (const evidence of input.evidence) {
    if (!isPortableRelativePath(evidence.provenance) || !isSha256(evidence.sourceSha256)) {
      throw new SupplementalMemoryCandidateGenerationError(
        "invalid_input",
        "generation evidence identity is invalid",
      );
    }
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.model.provider)) {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_input",
      "generation provider is invalid",
    );
  }
  if (
    input.model.id.length === 0 ||
    input.model.id.length > 256 ||
    input.model.id.trim() !== input.model.id
  ) {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_input",
      "generation model id is invalid",
    );
  }
  if (
    !Number.isInteger(input.limits.timeoutMs) ||
    input.limits.timeoutMs <= 0 ||
    input.limits.timeoutMs > 86_400_000 ||
    !Number.isInteger(input.limits.maxOutputTokens) ||
    input.limits.maxOutputTokens <= 0 ||
    input.limits.maxOutputTokens > MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_TOKENS
  ) {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_input",
      "generation limits are invalid",
    );
  }
}

function validateUsage(
  usage: SupplementalMemoryCandidateGenerationUsage,
  maxOutputTokens: number,
): void {
  const values = [
    usage.inputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
    usage.costUsdMicros,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    usage.outputTokens > maxOutputTokens
  ) {
    throw new SupplementalMemoryCandidateGenerationError(
      "invalid_output",
      "supplemental-memory generation usage is invalid",
    );
  }
}

function memoryValue(entry: SupplementalMemoryEntry) {
  return {
    bytes: entry.bytes,
    sha256: entry.sha256,
    value: supplementalMemoryContent(entry),
  };
}

function requiredPrior(
  prepared: PreparedSupplementalMemoryCandidateGeneration,
): SupplementalMemoryEntry {
  if (prepared.prior === null) {
    throw new SupplementalMemoryCandidateGenerationError(
      "identity_mismatch",
      "generation replacement prior identity is missing",
    );
  }
  return prepared.prior;
}

function sameTarget(left: SupplementalMemoryTarget, right: SupplementalMemoryTarget): boolean {
  return (
    left.workflowId === right.workflowId &&
    left.agentNodeId === right.agentNodeId &&
    left.childPath.length === right.childPath.length &&
    left.childPath.every((item, index) => item === right.childPath[index])
  );
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

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
