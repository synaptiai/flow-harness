import { calculateIssueLifecycleDomainDigest } from "../domain/issue-lifecycle/private-manifest.js";

export interface FrozenIssueVerificationCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** Binds one exact, shell-free holdout or verification command vector. */
export function calculateFrozenIssueVerificationCommandDigest(
  command: FrozenIssueVerificationCommand,
): string {
  return calculateIssueLifecycleDomainDigest("flow.issue.verification-command.v1", {
    executable: command.executable,
    args: [...command.args],
    timeoutMs: command.timeoutMs,
  });
}
