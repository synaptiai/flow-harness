import { createHash } from "node:crypto";

import type { AgentExecutor } from "./ports.js";
import {
  type PreparedPromptCandidateGeneration,
  type PromptCandidateGenerationUsage,
  completePromptCandidateGeneration,
  MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES,
  PROMPT_CANDIDATE_GENERATION_SYSTEM_PROMPT,
} from "../domain/adaptation/prompt-candidate-generation.js";
import type { PromptCandidateSource } from "../domain/adaptation/prompt-candidate.js";
import type { AgentEvidence } from "../domain/run/events.js";
import type { CompiledAgentNode } from "../domain/workflow/types.js";

export type PromptCandidateGenerationExecutionErrorCode = "execution_failed" | "invalid_evidence";

export class PromptCandidateGenerationExecutionError extends Error {
  override readonly name = "PromptCandidateGenerationExecutionError";

  constructor(
    readonly code: PromptCandidateGenerationExecutionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${boundedMessage(message)}`, options);
  }
}

export interface GeneratePromptCandidateInput {
  readonly prepared: PreparedPromptCandidateGeneration;
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly protectedPaths: readonly string[];
  readonly signal?: AbortSignal;
}

export async function generatePromptCandidate(
  input: GeneratePromptCandidateInput,
  executor: AgentExecutor,
): Promise<PromptCandidateSource> {
  const node: CompiledAgentNode = {
    id: "prompt-candidate-generation",
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
  const outcome = await executor.execute(node, {
    runId: `candidate-generation-${input.prepared.requestDigest}`,
    workflowId: input.prepared.input.baseline.compiled.id,
    attempt: 1,
    cwd: input.cwd,
    ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
    protectedPaths: input.protectedPaths,
    agentSystemPrompt: PROMPT_CANDIDATE_GENERATION_SYSTEM_PROMPT,
    agentExactModelSettings: true,
    agentMaxOutputBytes: MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES,
    agentMaxOutputTokens: input.prepared.input.limits.maxOutputTokens,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  throwIfAborted(input.signal);
  if (outcome.status === "failed") {
    throw new PromptCandidateGenerationExecutionError("execution_failed", outcome.error.message);
  }
  if (outcome.evidence.kind !== "agent") {
    throw invalidEvidence("generation executor returned non-agent evidence");
  }
  const evidence = outcome.evidence;
  validateEvidence(input.prepared, evidence);
  return completePromptCandidateGeneration(
    input.prepared,
    evidence.text,
    generationUsage(evidence),
  );
}

function validateEvidence(
  prepared: PreparedPromptCandidateGeneration,
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
  if (evidence.activity === undefined) {
    throw invalidEvidence("generation evidence is missing model activity");
  }
  if (evidence.activity.turns !== 1) {
    throw invalidEvidence("generation must use exactly one model turn");
  }
  if (evidence.activity.toolCalls !== 0 || evidence.activity.toolErrors !== 0) {
    throw invalidEvidence("zero-tool generation reported tool activity");
  }
  if (evidence.usage === undefined) {
    throw invalidEvidence("generation evidence is missing model usage");
  }
}

function generationUsage(evidence: AgentEvidence): PromptCandidateGenerationUsage {
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

function invalidEvidence(message: string): PromptCandidateGenerationExecutionError {
  return new PromptCandidateGenerationExecutionError("invalid_evidence", message);
}

function boundedMessage(value: string): string {
  return value.length <= 2_048 ? value : `${value.slice(0, 2_048)}…`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("candidate generation was cancelled");
  }
}
