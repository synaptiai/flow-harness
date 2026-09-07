import { calculateIssueLifecycleDomainDigest } from "../domain/issue-lifecycle/private-manifest.js";
import {
  type AgentCommandAuthority,
  calculateAgentCommandDigest,
  normalizeAgentCommandAuthority,
  normalizeAgentCommandRequest,
} from "../domain/agent-command.js";

export const FROZEN_ISSUE_HOLDOUT_STDIN_MEDIA_TYPE = "application/vnd.flow.issue-holdout-stdin";
export const MAX_FROZEN_ISSUE_HOLDOUT_STDIN_BYTES = 1_048_576;
export const DEFAULT_ISSUE_COMMAND_REJECTION_LIMIT = 3;

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

/** Converts public frozen verification vectors into exact agent execution authority. */
export function createFrozenVerificationAgentCommandAuthority(
  commands: readonly FrozenIssueVerificationCommand[],
  options: { readonly rejectionLimit?: number } = {},
): AgentCommandAuthority {
  const requests = [
    ...new Map(
      commands.map((command) => {
        const request = normalizeAgentCommandRequest({ version: 1, ...command });
        return [calculateAgentCommandDigest(request), request] as const;
      }),
    ).values(),
  ];
  return normalizeAgentCommandAuthority(
    requests.map(calculateAgentCommandDigest),
    requests,
    options.rejectionLimit,
  );
}
