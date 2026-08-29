import type { FrozenIssueRunManifest } from "../domain/issue-lifecycle/private-manifest.js";
import type { IssueReviewEvidence } from "./issue-review-evidence-port.js";
import {
  IssueWorkflowAdmissionError,
  MAX_ISSUE_WORKFLOW_CONTEXT_BYTES,
} from "./issue-workflow-admission.js";

export interface IssueIndependentReviewProjectionInput {
  readonly manifest: FrozenIssueRunManifest;
  readonly frozenContractDigest: string;
  readonly candidateHead: string;
  readonly issueSource: string;
  readonly evidence: IssueReviewEvidence;
  readonly diff: string;
}

/** Builds the complete, replay-stable data transmitted to an independent reviewer. */
export function buildIssueIndependentReviewProjection(
  input: IssueIndependentReviewProjectionInput,
): string {
  const deterministicById = new Map(
    input.evidence.verification.deterministic.map((result) => [result.id, result]),
  );
  const deterministic = input.manifest.verification.map((requirement) => {
    const result = deterministicById.get(requirement.id);
    if (result === undefined) {
      throw new Error("review projection is missing a validated deterministic check");
    }
    return {
      id: requirement.id,
      commandDigest: requirement.commandDigest,
      headCommit: result.headCommit,
      outcome: "passed" as const,
    };
  });
  const negativeControl = input.evidence.verification.negativeControl;
  const candidateDelta = input.evidence.verification.candidateDelta;

  return serializeBoundedIssueReviewContext({
    version: 1,
    issue: JSON.parse(input.issueSource),
    acceptanceCriteria: input.manifest.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    expectedResult: {
      candidateHead: input.candidateHead,
      issueDigest: input.manifest.issue.contentDigest,
      reviewWorkflowDigest: input.manifest.reviewWorkflow.templateWorkflowDigest,
    },
    frozenContractDigest: input.frozenContractDigest,
    candidate: {
      baseCommit: input.evidence.baseCommit,
      candidateHead: input.evidence.candidateHead,
      candidateTree: input.evidence.candidateTree,
      changedPaths: [...input.evidence.changedPaths].sort(compareStrings),
      logicalBytes: input.evidence.logicalBytes,
    },
    diff: {
      mediaType: input.evidence.diffBlob.mediaType,
      byteLength: input.evidence.diffBlob.byteLength,
      digest: input.evidence.diffBlob.digest,
      content: input.diff,
    },
    verification: {
      negativeControl: {
        commandDigest: input.manifest.holdout.commandDigest,
        baseCommit: negativeControl.baseCommit,
        baseOutcome: negativeControl.baseOutcome,
        candidateHead: negativeControl.candidateHead,
        candidateOutcome: negativeControl.candidateOutcome,
      },
      deterministic,
      candidateDelta: {
        baseCommit: candidateDelta.baseCommit,
        candidateHead: candidateDelta.candidateHead,
        pathCount: candidateDelta.pathCount,
        logicalBytes: candidateDelta.logicalBytes,
        relevant: candidateDelta.relevant,
      },
    },
  });
}

/** Serializes a review context exactly once and rejects, rather than truncates, excess data. */
export function serializeBoundedIssueReviewContext(input: unknown): string {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, "utf8") > MAX_ISSUE_WORKFLOW_CONTEXT_BYTES) {
    throw new IssueWorkflowAdmissionError(
      "context_too_large",
      `review projection must not exceed ${MAX_ISSUE_WORKFLOW_CONTEXT_BYTES} UTF-8 bytes`,
    );
  }
  return serialized;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
