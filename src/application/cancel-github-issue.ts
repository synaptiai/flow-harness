import {
  calculateIssueLifecycleCommandDigest,
  parseIssueLifecycleCommand,
} from "../domain/issue-lifecycle/commands.js";
import {
  type PublicIssueLifecycleState,
  projectPublicIssueLifecycleState,
} from "../domain/issue-lifecycle/events.js";
import {
  createClaimedIssueController,
  evidenceDigest,
  publicStateDigest,
  releaseClaimedIssue,
} from "./continue-github-issue.js";
import type {
  IssueControllerCommandRecord,
  IssueControllerDependencies,
} from "./github-issue-controller-ports.js";

export type CancelGitHubIssueResult =
  | { readonly status: "requested"; readonly command: IssueControllerCommandRecord }
  | { readonly status: "rejected"; readonly command: IssueControllerCommandRecord }
  | { readonly status: "cancelled"; readonly state: PublicIssueLifecycleState };

export async function cancelGitHubIssue(
  input: unknown,
  dependencies: IssueControllerDependencies,
): Promise<CancelGitHubIssueResult> {
  const command = parseIssueLifecycleCommand(input);
  if (command.kind !== "cancel") throw new Error("cancelGitHubIssue requires a cancel command");
  const record = await dependencies.repository.recordCommand({
    runId: command.runId,
    recordedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    command,
  });
  let controller: Awaited<ReturnType<typeof createClaimedIssueController>>;
  try {
    controller = await createClaimedIssueController(command.runId, command.commandId, dependencies);
  } catch (error) {
    if (isActiveOwner(error)) return { status: "requested", command: record };
    throw error;
  }
  try {
    if (record.settlement !== undefined) {
      const state = projectPublicIssueLifecycleState(controller.state);
      return record.settlement.outcome === "completed" && state.phase === "cancelled"
        ? { status: "cancelled", state }
        : { status: "rejected", command: record };
    }
    if (["merged", "failed", "cancelled"].includes(controller.state.phase)) {
      await dependencies.repository.settleCommand(command.runId, command.commandId, {
        version: 1,
        commandDigest: calculateIssueLifecycleCommandDigest(command),
        settledAt: controller.state.lastEventAt,
        outcome: "rejected",
        code: "already_terminal",
        resultDigest: publicStateDigest(projectPublicIssueLifecycleState(controller.state)),
      });
      return {
        status: "rejected",
        command: await dependencies.repository.readCommand(command.runId, command.commandId),
      };
    }
    if (controller.state.pendingEffect !== undefined) {
      return { status: "requested", command: record };
    }
    const actorDigest = evidenceDigest("cancellation-actor", { actor: command.actor });
    const reasonDigest =
      command.reason === undefined
        ? undefined
        : evidenceDigest("cancellation-reason", { reason: command.reason });
    await controller.append({
      type: "run_cancelled",
      actorDigest,
      ...(reasonDigest === undefined ? {} : { reasonDigest }),
    });
    const state = projectPublicIssueLifecycleState(controller.state);
    await dependencies.repository.settleCommand(command.runId, command.commandId, {
      version: 1,
      commandDigest: calculateIssueLifecycleCommandDigest(command),
      settledAt: state.lastEventAt,
      outcome: "completed",
      resultDigest: publicStateDigest(state),
    });
    return { status: "cancelled", state };
  } finally {
    await releaseClaimedIssue(controller);
  }
}

function isActiveOwner(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["active_owner", "not_owner"].includes(String(error.code))
  );
}
