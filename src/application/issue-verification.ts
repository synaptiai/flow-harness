import {
  calculateGitHubLifecycleObservationDigest,
  type GitHubLifecycleObservation,
  parseGitHubLifecycleObservation,
} from "../domain/issue-lifecycle/github-observation.js";
import {
  calculateMergeApprovalDigest,
  calculateMergeGateDigest,
  type MergeGateInput,
} from "../domain/issue-lifecycle/merge-gate.js";
import type { FrozenIssueRunManifest } from "../domain/issue-lifecycle/private-manifest.js";
import { calculateIssueLifecycleDomainDigest } from "../domain/issue-lifecycle/private-manifest.js";
import type { IssueReviewReport } from "../domain/issue-lifecycle/review.js";

export const MAX_ISSUE_CANDIDATE_PATHS = 4_096;
export const MAX_ISSUE_CANDIDATE_LOGICAL_BYTES = 67_108_864;

const sha256Pattern = /^[a-f0-9]{64}$/;
const gitCommitPattern = /^[a-f0-9]{40}$/;

export interface IssueNegativeControlResult {
  readonly baseCommit: string;
  readonly baseOutcome: "failed" | "passed";
  readonly candidateHead: string;
  readonly candidateOutcome: "failed" | "passed";
  readonly evidenceDigest: string;
}

export interface IssueDeterministicVerificationResult {
  readonly id: string;
  readonly commandDigest: string;
  readonly evidenceDigest: string;
  readonly headCommit: string;
}

export interface IssueCandidateDeltaResult {
  readonly baseCommit: string;
  readonly candidateHead: string;
  readonly pathCount: number;
  /** Added and removed content bytes; delete-only changes count bytes from the frozen base. */
  readonly logicalBytes: number;
  readonly relevant: boolean;
  readonly evidenceDigest: string;
}

export interface IssueVerificationResult {
  readonly negativeControl: IssueNegativeControlResult;
  readonly deterministic: readonly IssueDeterministicVerificationResult[];
  readonly candidateDelta: IssueCandidateDeltaResult;
  readonly evidenceDigest: string;
}

export type GitHubObservationAssessment =
  | { readonly status: "ready"; readonly observation: GitHubLifecycleObservation }
  | {
      readonly status: "waiting";
      readonly reason: "required_checks_incomplete" | "mergeability_unknown";
    };

export interface IssueImplementationGateEvidence {
  readonly flowRunId: string;
  readonly executionWorkflowDigest: string;
  readonly terminalSequence: number;
  readonly evidenceDigest: string;
}

export interface IssueReviewGateEvidence {
  readonly flowRunId: string;
  readonly executionWorkflowDigest: string;
  readonly terminalSequence: number;
  readonly evidenceDigest: string;
  readonly reportDigest: string;
  readonly report: IssueReviewReport;
}

export interface BuildIssueMergeGateInput {
  readonly manifest: FrozenIssueRunManifest;
  readonly frozenContractDigest: string;
  /** The current lifecycle sequence before the merge-gate transition is appended. */
  readonly sequence: number;
  readonly candidateHead: string;
  readonly implementation: IssueImplementationGateEvidence;
  readonly verification: IssueVerificationResult;
  readonly review: IssueReviewGateEvidence;
  readonly observation: GitHubLifecycleObservation;
}

export interface BuiltIssueMergeGate {
  readonly input: MergeGateInput;
  /** Stable authority digest presented to an operator and reproduced by fresh verification. */
  readonly digest: string;
  /** Exact digest of the first verification and hosted evidence instance. */
  readonly evidenceDigest: string;
  readonly observationDigest: string;
  readonly checksDigest: string;
}

export class IssueVerificationError extends Error {
  override readonly name = "IssueVerificationError";

  constructor(
    readonly code:
      | "candidate_delta_invalid"
      | "github_identity_mismatch"
      | "github_review_blocked"
      | "hosted_check_failed"
      | "invalid_evidence"
      | "negative_control_failed"
      | "verification_mismatch",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function validateIssueVerificationResult(
  manifest: FrozenIssueRunManifest,
  candidateHead: string,
  input: IssueVerificationResult,
): IssueVerificationResult {
  requireCommit(candidateHead, "candidate head");
  requireDigest(input.evidenceDigest, "verification evidence");
  const negative = input.negativeControl;
  if (negative.baseCommit !== manifest.base.commit || negative.baseOutcome !== "failed") {
    throw new IssueVerificationError(
      "negative_control_failed",
      "the frozen-base holdout must fail at the exact frozen base commit",
    );
  }
  if (negative.candidateHead !== candidateHead || negative.candidateOutcome !== "passed") {
    throw new IssueVerificationError(
      "negative_control_failed",
      "the same holdout must pass at the exact candidate head",
    );
  }
  requireDigest(negative.evidenceDigest, "negative-control evidence");

  const requirements = new Map(
    manifest.verification.map((requirement) => [requirement.id, requirement.commandDigest]),
  );
  if (
    input.deterministic.length !== requirements.size ||
    new Set(input.deterministic.map((item) => item.id)).size !== input.deterministic.length
  ) {
    throw new IssueVerificationError(
      "verification_mismatch",
      "deterministic verification must contain every frozen command exactly once",
    );
  }
  for (const result of input.deterministic) {
    if (requirements.get(result.id) !== result.commandDigest) {
      throw new IssueVerificationError(
        "verification_mismatch",
        `verification ${JSON.stringify(result.id)} does not match a frozen command`,
      );
    }
    if (result.headCommit !== candidateHead) {
      throw new IssueVerificationError(
        "verification_mismatch",
        "every deterministic verification result must bind the exact candidate head",
      );
    }
    requireDigest(result.evidenceDigest, `verification ${result.id} evidence`);
  }

  const delta = input.candidateDelta;
  if (
    delta.baseCommit !== manifest.base.commit ||
    delta.candidateHead !== candidateHead ||
    candidateHead === manifest.base.commit ||
    !delta.relevant ||
    !Number.isSafeInteger(delta.pathCount) ||
    delta.pathCount < 1 ||
    delta.pathCount > MAX_ISSUE_CANDIDATE_PATHS ||
    !Number.isSafeInteger(delta.logicalBytes) ||
    delta.logicalBytes < 1 ||
    delta.logicalBytes > MAX_ISSUE_CANDIDATE_LOGICAL_BYTES
  ) {
    throw new IssueVerificationError(
      "candidate_delta_invalid",
      "candidate delta must be relevant, nonempty, bounded, and bind the frozen base and exact head",
    );
  }
  requireDigest(delta.evidenceDigest, "candidate delta evidence");
  return deepFreeze(structuredClone(input));
}

export function assessGitHubObservation(
  manifest: FrozenIssueRunManifest,
  pullRequestNumber: number,
  candidateHead: string,
  input: unknown,
): GitHubObservationAssessment {
  const observation = parseGitHubLifecycleObservation(input);
  const repositoryMatches =
    observation.repositoryIdentity === manifest.repository.identity &&
    observation.repositoryNodeId === manifest.repository.nodeId;
  const issueMatches =
    observation.issue.number === manifest.issue.number &&
    observation.issue.nodeId === manifest.issue.nodeId &&
    observation.issue.state === "open" &&
    observation.issue.updatedAt === manifest.issue.updatedAt &&
    observation.issue.contentDigest === manifest.issue.contentDigest;
  const baseMatches =
    observation.base.branch === manifest.base.branch &&
    observation.base.commit === manifest.base.commit;
  const pullRequestMatches =
    observation.pullRequest.number === pullRequestNumber &&
    observation.pullRequest.state === "open" &&
    !observation.pullRequest.isDraft &&
    observation.pullRequest.headBranch === manifest.branch.name &&
    observation.pullRequest.headCommit === candidateHead &&
    observation.pullRequest.baseBranch === manifest.base.branch &&
    observation.pullRequest.baseCommit === manifest.base.commit;
  if (!repositoryMatches || !issueMatches || !baseMatches || !pullRequestMatches) {
    throw new IssueVerificationError(
      "github_identity_mismatch",
      "fresh GitHub state does not match the frozen repository, issue, base, branch, pull request, and exact candidate head",
    );
  }

  if (
    observation.conversations.threads.nodes.some((thread) => !thread.isResolved) ||
    latestReviewsByAuthor(observation).some((review) => review.state === "changes_requested")
  ) {
    throw new IssueVerificationError(
      "github_review_blocked",
      "fresh GitHub state contains an unresolved review thread or changes-requested review",
    );
  }

  let incomplete = false;
  for (const requirement of manifest.hostedChecks) {
    const named = observation.checks.nodes.filter((check) => check.name === requirement.name);
    if (
      named.some(
        (check) =>
          check.sourceApp.id !== requirement.sourceApp.id ||
          check.sourceApp.slug !== requirement.sourceApp.slug,
      )
    ) {
      throw new IssueVerificationError(
        "github_identity_mismatch",
        `required check ${JSON.stringify(requirement.name)} was emitted by an unexpected source app`,
      );
    }
    const matching = named.filter(
      (check) =>
        check.sourceApp.id === requirement.sourceApp.id &&
        check.sourceApp.slug === requirement.sourceApp.slug,
    );
    const selected = matching.reduce<(typeof matching)[number] | undefined>(
      (latest, check) => (latest === undefined || check.runId > latest.runId ? check : latest),
      undefined,
    );
    if (selected === undefined || selected.status !== "completed" || selected.conclusion === null) {
      incomplete = true;
      continue;
    }
    if (selected.conclusion !== "success") {
      throw new IssueVerificationError(
        "hosted_check_failed",
        `required check ${JSON.stringify(requirement.name)} did not succeed`,
      );
    }
  }
  if (incomplete) return Object.freeze({ status: "waiting", reason: "required_checks_incomplete" });
  if (observation.pullRequest.mergeability === "unknown") {
    return Object.freeze({ status: "waiting", reason: "mergeability_unknown" });
  }
  if (observation.pullRequest.mergeability !== "mergeable") {
    throw new IssueVerificationError(
      "github_identity_mismatch",
      "the exact pull request head is not mergeable with the frozen base",
    );
  }
  return Object.freeze({ status: "ready", observation });
}

function latestReviewsByAuthor(
  observation: GitHubLifecycleObservation,
): GitHubLifecycleObservation["conversations"]["reviews"]["nodes"] {
  const latest = new Map<
    string,
    GitHubLifecycleObservation["conversations"]["reviews"]["nodes"][number]
  >();
  for (const review of observation.conversations.reviews.nodes) {
    if (review.submittedAt === null) continue;
    const previous = latest.get(review.authorDigest);
    if (
      previous === undefined ||
      previous.submittedAt === null ||
      review.submittedAt > previous.submittedAt ||
      (review.submittedAt === previous.submittedAt &&
        previous.state !== "changes_requested" &&
        (review.state === "changes_requested" || review.nodeId > previous.nodeId))
    ) {
      latest.set(review.authorDigest, review);
    }
  }
  return Object.freeze([...latest.values()]);
}

export function buildIssueMergeGate(input: BuildIssueMergeGateInput): BuiltIssueMergeGate {
  const verification = validateIssueVerificationResult(
    input.manifest,
    input.candidateHead,
    input.verification,
  );
  const assessment = assessGitHubObservation(
    input.manifest,
    input.observation.pullRequest.number,
    input.candidateHead,
    input.observation,
  );
  if (assessment.status !== "ready") {
    throw new IssueVerificationError(
      "invalid_evidence",
      `cannot build a merge gate while GitHub is ${assessment.reason}`,
    );
  }
  if (input.review.report.verdict !== "clear") {
    throw new IssueVerificationError("invalid_evidence", "merge gate requires a clear review");
  }
  requireDigest(input.frozenContractDigest, "frozen contract");
  requireDigest(input.implementation.executionWorkflowDigest, "implementation workflow");
  requireDigest(input.implementation.evidenceDigest, "implementation evidence");
  requireDigest(input.review.executionWorkflowDigest, "review workflow");
  requireDigest(input.review.evidenceDigest, "review evidence");
  requireDigest(input.review.reportDigest, "review report");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new IssueVerificationError("invalid_evidence", "lifecycle sequence is invalid");
  }

  const observation = assessment.observation;
  const selectedChecks = input.manifest.hostedChecks.map((requirement) => {
    const matching = observation.checks.nodes.filter(
      (check) =>
        check.name === requirement.name &&
        check.sourceApp.id === requirement.sourceApp.id &&
        check.sourceApp.slug === requirement.sourceApp.slug,
    );
    const selected = matching.reduce<(typeof matching)[number] | undefined>(
      (latest, check) => (latest === undefined || check.runId > latest.runId ? check : latest),
      undefined,
    );
    if (selected?.status !== "completed" || selected.conclusion !== "success") {
      throw new IssueVerificationError("invalid_evidence", "required hosted check is not ready");
    }
    return {
      name: selected.name,
      runId: selected.runId,
      sourceApp: selected.sourceApp,
      conclusion: "success" as const,
      headCommit: selected.headCommit,
      evidenceDigest: digest("flow.issue.github-check.v1", selected),
    };
  });
  const checksDigest = digest("flow.issue.github-checks.v1", observation.checks);
  const gate: MergeGateInput = {
    version: 1,
    runId: input.manifest.runId,
    githubHost: "github.com",
    repositoryIdentity: input.manifest.repository.identity,
    issue: {
      nodeId: observation.issue.nodeId,
      number: observation.issue.number,
      state: "open",
      digest: observation.issue.contentDigest,
      updatedAt: observation.issue.updatedAt,
    },
    base: {
      branch: input.manifest.base.branch,
      commit: input.manifest.base.commit,
      observedCommit: observation.base.commit,
    },
    branch: input.manifest.branch.name,
    frozenContractDigest: input.frozenContractDigest,
    planDigest: input.manifest.planDigest,
    implementationWorkflowDigest: input.implementation.executionWorkflowDigest,
    reviewWorkflowDigest: input.review.executionWorkflowDigest,
    budgetDigest: input.manifest.budgetDigest,
    requirements: {
      deterministicVerification: input.manifest.verification.map(({ id, commandDigest }) => ({
        id,
        commandDigest,
      })),
      hostedChecks: input.manifest.hostedChecks.map((requirement) => ({
        name: requirement.name,
        sourceApp: { ...requirement.sourceApp },
      })),
    },
    pullRequest: {
      number: observation.pullRequest.number,
      nodeId: observation.pullRequest.nodeId,
      state: "open",
      isDraft: false,
      headBranch: observation.pullRequest.headBranch,
      headCommit: observation.pullRequest.headCommit,
      baseBranch: observation.pullRequest.baseBranch,
      baseCommit: observation.pullRequest.baseCommit,
    },
    merge: input.manifest.merge,
    implementation: {
      ...input.implementation,
      candidateHead: input.candidateHead,
    },
    negativeControl: {
      baseCommit: verification.negativeControl.baseCommit,
      baseOutcome: "failed",
      candidateHead: verification.negativeControl.candidateHead,
      candidateOutcome: "passed",
      evidenceDigest: verification.negativeControl.evidenceDigest,
    },
    deterministicVerification: verification.deterministic.map((result) => ({ ...result })),
    review: {
      flowRunId: input.review.flowRunId,
      executionWorkflowDigest: input.review.executionWorkflowDigest,
      terminalSequence: input.review.terminalSequence,
      evidenceDigest: input.review.evidenceDigest,
      reportDigest: input.review.reportDigest,
      headCommit: input.candidateHead,
      verdict: "clear",
    },
    hostedChecks: selectedChecks,
    conversation: {
      commentsDigest: digest("flow.issue.github-comments.v1", observation.conversations.comments),
      reviewsDigest: digest("flow.issue.github-reviews.v1", observation.conversations.reviews),
      threadsDigest: digest("flow.issue.github-threads.v1", observation.conversations.threads),
      unresolvedThreadCount: 0,
    },
    mergeability: {
      state: "mergeable",
      evidenceDigest: digest("flow.issue.github-mergeability.v1", {
        pullRequestNodeId: observation.pullRequest.nodeId,
        headCommit: observation.pullRequest.headCommit,
        baseCommit: observation.pullRequest.baseCommit,
        mergeability: observation.pullRequest.mergeability,
      }),
    },
    gateCreationSequence: input.sequence + 1,
  };
  return deepFreeze({
    input: gate,
    digest: calculateMergeApprovalDigest(gate),
    evidenceDigest: calculateMergeGateDigest(gate),
    observationDigest: calculateGitHubLifecycleObservationDigest(observation),
    checksDigest,
  });
}

function requireDigest(value: string, label: string): void {
  if (!sha256Pattern.test(value)) {
    throw new IssueVerificationError("invalid_evidence", `${label} digest is invalid`);
  }
}

function requireCommit(value: string, label: string): void {
  if (!gitCommitPattern.test(value)) {
    throw new IssueVerificationError("invalid_evidence", `${label} is invalid`);
  }
}

function digest(domain: string, value: unknown): string {
  return calculateIssueLifecycleDomainDigest(domain, value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
