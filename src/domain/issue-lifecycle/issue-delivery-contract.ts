import { calculateIssueLifecycleDomainDigest } from "./private-manifest.js";

const gitTreePattern = /^[a-f0-9]{40}$/;

/** Exact host-authored commit message, including its terminating newline. */
export function renderIssueCommitMessage(issueNumber: number): string {
  assertIssueNumber(issueNumber);
  return `Implement issue #${issueNumber}\n`;
}

export function calculateIssueCommitMessageDigest(issueNumber: number): string {
  return calculateIssueLifecycleDomainDigest("flow.issue.commit-message.v1", {
    message: renderIssueCommitMessage(issueNumber),
  });
}

/** Binds only the raw candidate tree OID observed independently by the host. */
export function calculateIssueCandidateTreeDigest(tree: string): string {
  if (!gitTreePattern.test(tree)) throw new Error("candidate tree must be a lowercase Git OID");
  return calculateIssueLifecycleDomainDigest("flow.issue.candidate-tree.v1", { tree });
}

function assertIssueNumber(issueNumber: number): void {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new Error("issue number must be a positive safe integer");
  }
}
