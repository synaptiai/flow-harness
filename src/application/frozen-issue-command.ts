import { calculateIssueLifecycleDomainDigest } from "../domain/issue-lifecycle/private-manifest.js";

export interface FrozenIssueVerificationCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** Returns the frozen identity of one exact holdout or deterministic verification vector. */
export function calculateFrozenIssueVerificationCommandDigest(
  command: FrozenIssueVerificationCommand,
): string {
  return calculateIssueLifecycleDomainDigest("flow.issue.verification-command.v1", {
    executable: command.executable,
    args: [...command.args],
    timeoutMs: command.timeoutMs,
  });
}
