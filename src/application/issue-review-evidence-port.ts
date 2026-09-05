import type {
  FrozenIssueRunManifest,
  IssuePrivateBlobReference,
} from "../domain/issue-lifecycle/private-manifest.js";
import { calculateIssueLifecycleDomainDigest } from "../domain/issue-lifecycle/private-manifest.js";
import type { IssueGitWorkspace } from "./issue-local-git-port.js";
import type { IssueVerificationResult } from "./issue-verification.js";

export const ISSUE_REVIEW_DIFF_MEDIA_TYPE = "text/x-diff; charset=utf-8";

export interface IssueReviewEvidence {
  readonly version: 1;
  readonly baseCommit: string;
  readonly candidateHead: string;
  readonly candidateTree: string;
  readonly workspaceIdentityDigest: string;
  readonly changedPaths: readonly string[];
  readonly logicalBytes: number;
  readonly diffBlob: IssuePrivateBlobReference;
  readonly verification: IssueVerificationResult;
  readonly evidenceDigest: string;
}

export interface IssueReviewEvidencePort {
  read(request: {
    readonly runId: string;
    readonly manifest: FrozenIssueRunManifest;
    readonly candidateHead: string;
    readonly workspace: IssueGitWorkspace;
    readonly signal?: AbortSignal;
  }): Promise<IssueReviewEvidence>;
}

export function calculateIssueReviewEvidenceDigest(
  evidence: Omit<IssueReviewEvidence, "evidenceDigest">,
): string {
  return calculateIssueLifecycleDomainDigest("flow.issue.review-evidence.v1", {
    ...evidence,
    changedPaths: [...evidence.changedPaths],
  });
}
