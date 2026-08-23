import { calculateEvaluationVerifierDigest } from "./plan.js";
import type { AcpQualificationObservation, EvaluationVerificationOutcome } from "./records.js";
import { parseEvaluationVerificationOutcome } from "./records.js";

export interface EvaluationAgentResultVerifier {
  readonly kind: "agent-result-v1";
  readonly digest: string;
  readonly sha256: string;
  readonly bytes: number;
}

export function verifyEvaluationAgentResult(
  observation: AcpQualificationObservation | undefined,
  verifier: EvaluationAgentResultVerifier,
): EvaluationVerificationOutcome {
  if (
    calculateEvaluationVerifierDigest(verifier.kind, {
      sha256: verifier.sha256,
      bytes: verifier.bytes,
    }) !== verifier.digest
  ) {
    return verificationError(verifier.digest, "verifier digest does not match its admitted result");
  }
  if (observation === undefined) {
    return verificationError(verifier.digest, "ACP qualification result evidence is missing");
  }
  const outcome =
    observation.result.sha256 === verifier.sha256 && observation.result.bytes === verifier.bytes;
  return parseEvaluationVerificationOutcome({
    outcome: outcome ? "accepted" : "rejected",
    verifierDigest: verifier.digest,
    assertions: [
      {
        kind: "agent-result" as const,
        outcome,
        observedSha256: observation.result.sha256,
        observedBytes: observation.result.bytes,
      },
    ],
  });
}

function verificationError(verifierDigest: string, reason: string): EvaluationVerificationOutcome {
  return Object.freeze({
    outcome: "error",
    verifierDigest,
    assertions: [],
    reason: reason.slice(0, 4_096),
  });
}
