import { createHash } from "node:crypto";

import {
  AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_SYSTEM_PROMPT,
  type AgentSkillPackageCandidateGenerationUsage,
  type CompletedAgentSkillPackageCandidateGeneration,
  completeAgentSkillPackageCandidateGeneration,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_BYTES,
  type PreparedAgentSkillPackageCandidateGeneration,
} from "../domain/adaptation/agent-skill-package-candidate-generation.js";
import type { AgentEvidence } from "../domain/run/events.js";
import type { CompiledAgentNode } from "../domain/workflow/types.js";
import type { AgentExecutor } from "./ports.js";

export type AgentSkillPackageCandidateGenerationExecutionErrorCode =
  | "execution_failed"
  | "invalid_evidence";

export class AgentSkillPackageCandidateGenerationExecutionError extends Error {
  override readonly name = "AgentSkillPackageCandidateGenerationExecutionError";

  constructor(
    readonly code: AgentSkillPackageCandidateGenerationExecutionErrorCode,
    message: string,
  ) {
    super(`${code}: ${message.slice(0, 2_048)}`);
  }
}

export interface GenerateAgentSkillPackageCandidateInput {
  readonly prepared: PreparedAgentSkillPackageCandidateGeneration;
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly protectedPaths: readonly string[];
  readonly signal?: AbortSignal;
}

export async function generateAgentSkillPackageCandidate(
  input: GenerateAgentSkillPackageCandidateInput,
  executor: AgentExecutor,
): Promise<CompletedAgentSkillPackageCandidateGeneration> {
  throwIfAborted(input.signal);
  const node: CompiledAgentNode = {
    id: "agent-skill-package-candidate-generation",
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
      workflowId: input.prepared.input.baseline.compiled.id,
      attempt: 1,
      cwd: input.cwd,
      ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
      protectedPaths: input.protectedPaths,
      agentSystemPrompt: AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_SYSTEM_PROMPT,
      agentExactModelSettings: true,
      agentMaxOutputBytes: MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_BYTES,
      agentMaxOutputTokens: input.prepared.input.limits.maxOutputTokens,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    throwIfAborted(input.signal);
    throw new AgentSkillPackageCandidateGenerationExecutionError(
      "execution_failed",
      "Agent Skill package candidate generation failed",
    );
  }
  throwIfAborted(input.signal);
  if (outcome.status === "failed") {
    throw new AgentSkillPackageCandidateGenerationExecutionError(
      "execution_failed",
      "Agent Skill package candidate generation failed",
    );
  }
  if (outcome.evidence.kind !== "agent") {
    throw invalidEvidence("generation executor returned non-agent evidence");
  }
  validateEvidence(input.prepared, outcome.evidence);
  return completeAgentSkillPackageCandidateGeneration(
    input.prepared,
    outcome.evidence.text,
    generationUsage(outcome.evidence),
  );
}

function validateEvidence(
  prepared: PreparedAgentSkillPackageCandidateGeneration,
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

function generationUsage(evidence: AgentEvidence): AgentSkillPackageCandidateGenerationUsage {
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

function invalidEvidence(message: string): AgentSkillPackageCandidateGenerationExecutionError {
  return new AgentSkillPackageCandidateGenerationExecutionError("invalid_evidence", message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("Agent Skill package candidate generation was cancelled");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
