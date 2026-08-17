import {
  createAgentSkillPackageCandidateSource,
  projectAgentSkillPackageCandidate,
} from "../../src/domain/adaptation/agent-skill-package-candidate.js";
import { completeAgentSkillPackageCandidateGeneration } from "../../src/domain/adaptation/agent-skill-package-candidate-generation.js";
import type { PromptActivationEvaluationProof } from "../../src/domain/adaptation/prompt-activation.js";
import {
  agentSkillPackageCandidateGenerationFixture,
  agentSkillPackageGenerationResponse,
} from "./agent-skill-package-candidate-generation.js";
import { promptCandidateGenerationFixture } from "./prompt-candidate-generation.js";

export function agentSkillPackageActivationFixture() {
  const generation = agentSkillPackageCandidateGenerationFixture();
  const prompt = promptCandidateGenerationFixture();
  const completed = completeAgentSkillPackageCandidateGeneration(
    generation.prepared,
    agentSkillPackageGenerationResponse,
    {
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      costUsdMicros: 0,
    },
  );
  const source = createAgentSkillPackageCandidateSource(generation.prepared, completed);
  const projected = projectAgentSkillPackageCandidate({
    manifestProvenance: "generated-review-helper/CANDIDATE.json",
    source,
    sourceSha256: "1".repeat(64),
    baseline: {
      provenance: prompt.input.baseline.provenance,
      source: prompt.input.baseline.source,
      sourceSha256: prompt.input.baseline.sourceSha256,
      compiled: prompt.input.baseline.compiled,
    },
    evidence: prompt.input.evidence,
    package: completed.package,
  });
  return { prompt, completed, projected };
}

export function agentSkillPackageEvaluationProof(): PromptActivationEvaluationProof {
  return {
    evaluationId: "evaluation-1",
    planDigest: "2".repeat(64),
    terminalRecordDigest: "3".repeat(64),
    reportDigest: "4".repeat(64),
    baselineProfileId: "baseline",
    candidateProfileId: "candidate",
    scheduledTrials: 8,
    committedTrials: 8,
    criteria: {
      minimumPairedTrials: 2,
      confidenceLevel: 0.95,
      minimumEffect: 0,
      maxFalseCompletionRate: 0,
      maxPolicyViolations: 0,
      maxVerifiedSuccessRegression: 0,
    },
    comparison: {
      verdict: "superior",
      scheduledPairs: 2,
      completePairs: 2,
      comparablePairs: 2,
      pairedSuccessDelta: 1,
      confidenceInterval: { lower: 0.5, upper: 1, level: 0.95 },
      constraints: {
        falseCompletionRate: true,
        policyViolations: true,
        verifiedSuccessRegression: true,
      },
    },
  };
}
