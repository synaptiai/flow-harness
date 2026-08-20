import { createHash } from "node:crypto";
import type { SupplementalMemoryCandidateSource } from "../domain/adaptation/supplemental-memory-candidate.js";
import {
  completeSupplementalMemoryCandidateGeneration,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES,
  type PreparedSupplementalMemoryCandidateGeneration,
  SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_SYSTEM_PROMPT,
  type SupplementalMemoryCandidateGenerationUsage,
} from "../domain/adaptation/supplemental-memory-candidate-generation.js";
import type { AgentEvidence } from "../domain/run/events.js";
import type { CompiledAgentNode } from "../domain/workflow/types.js";
import type { AgentExecutor } from "./ports.js";

export type SupplementalMemoryCandidateGenerationExecutionErrorCode =
  | "execution_failed"
  | "invalid_evidence";

export class SupplementalMemoryCandidateGenerationExecutionError extends Error {
  override readonly name = "SupplementalMemoryCandidateGenerationExecutionError";

  constructor(
    readonly code: SupplementalMemoryCandidateGenerationExecutionErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface GenerateSupplementalMemoryCandidateInput {
  readonly prepared: PreparedSupplementalMemoryCandidateGeneration;
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly protectedPaths: readonly string[];
  readonly signal?: AbortSignal;
}

export async function generateSupplementalMemoryCandidate(
  input: GenerateSupplementalMemoryCandidateInput,
  executor: AgentExecutor,
): Promise<SupplementalMemoryCandidateSource> {
  throwIfAborted(input.signal);
  const node: CompiledAgentNode = {
    id: "supplemental-memory-candidate-generation",
    type: "agent",
    dependsOn: [],
    agent: {
      prompt: input.prepared.renderedInput,
      model: input.prepared.input.model,
      tools: [],
      skills: [],
      toolPackages: [],
      timeoutMs: input.prepared.input.limits.timeoutMs,
    },
  };
  let outcome: Awaited<ReturnType<AgentExecutor["execute"]>>;
  try {
    outcome = await executor.execute(node, {
      runId: `candidate-generation-${input.prepared.requestDigest}`,
      workflowId: input.prepared.input.baseline.workflowId,
      attempt: 1,
      cwd: input.cwd,
      ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
      protectedPaths: input.protectedPaths,
      agentSystemPrompt: SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_SYSTEM_PROMPT,
      agentExactModelSettings: true,
      agentMaxOutputBytes: MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES,
      agentMaxOutputTokens: input.prepared.input.limits.maxOutputTokens,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    throwIfAborted(input.signal);
    throw new SupplementalMemoryCandidateGenerationExecutionError(
      "execution_failed",
      "supplemental-memory candidate generation failed",
    );
  }
  throwIfAborted(input.signal);
  if (outcome.status === "failed") {
    throw new SupplementalMemoryCandidateGenerationExecutionError(
      "execution_failed",
      "supplemental-memory candidate generation failed",
    );
  }
  if (outcome.evidence.kind !== "agent") {
    throw invalidEvidence("generation executor returned non-agent evidence");
  }
  validateEvidence(input.prepared, outcome.evidence);
  return completeSupplementalMemoryCandidateGeneration(
    input.prepared,
    outcome.evidence.text,
    generationUsage(outcome.evidence),
  );
}

function validateEvidence(
  prepared: PreparedSupplementalMemoryCandidateGeneration,
  evidence: AgentEvidence,
): void {
  if (
    evidence.provider !== prepared.input.model.provider ||
    evidence.model !== prepared.input.model.id
  ) {
    throw invalidEvidence("generation evidence provenance does not match the selected model");
  }
  if (evidence.textHash !== sha256(evidence.text)) {
    throw invalidEvidence("generation evidence text hash is inconsistent");
  }
  if (evidence.textTruncated) {
    throw invalidEvidence("generation evidence text is truncated");
  }
  if (evidence.policyDecisions.length > 0 || evidence.effectReceipts.length > 0) {
    throw invalidEvidence("zero-tool generation reported policy or effect activity");
  }
  if (evidence.capabilities !== undefined) {
    throw invalidEvidence("zero-tool generation reported capability activity");
  }
  if (evidence.activity?.turns !== 1) {
    throw invalidEvidence("generation must use exactly one model turn");
  }
  if (evidence.activity.toolCalls !== 0 || evidence.activity.toolErrors !== 0) {
    throw invalidEvidence("zero-tool generation reported tool activity");
  }
  if (evidence.usage === undefined) {
    throw invalidEvidence("generation evidence is missing model usage");
  }
}

function generationUsage(evidence: AgentEvidence): SupplementalMemoryCandidateGenerationUsage {
  const usage = evidence.usage;
  if (usage === undefined) {
    throw invalidEvidence("generation evidence is missing model usage");
  }
  return {
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    costUsdMicros: usage.costUsdMicros,
  };
}

function invalidEvidence(message: string): SupplementalMemoryCandidateGenerationExecutionError {
  return new SupplementalMemoryCandidateGenerationExecutionError("invalid_evidence", message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("supplemental-memory candidate generation was cancelled");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
