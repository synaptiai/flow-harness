import type { FrozenIssueRunManifest } from "../domain/issue-lifecycle/private-manifest.js";
import type { IssueReviewRepairProjection } from "./issue-review-repair-projection.js";
import type { ValidatedReviewWorkflowResult } from "./issue-workflow-runner.js";

export interface IssueReviewRepairHostRequest {
  readonly manifest: FrozenIssueRunManifest;
  readonly review: ValidatedReviewWorkflowResult;
  readonly cycle: number;
  readonly candidateTree: string;
  readonly workspaceIdentityDigest: string;
  readonly signal?: AbortSignal;
}

export interface IssueReviewRepairAssessment {
  readonly projection: IssueReviewRepairProjection;
  readonly eligibilityDigest: string;
}

/** Host observations establish bounded eligibility, not the semantic truth of review findings. */
export interface IssueReviewRepairHostPort {
  /** Rebuilds frozen context without reading the current candidate, including after a repair. */
  project(request: IssueReviewRepairHostRequest): Promise<IssueReviewRepairProjection>;
  /** Validates the currently owned committed candidate and every explicit finding location. */
  assess(request: IssueReviewRepairHostRequest): Promise<IssueReviewRepairAssessment>;
}
