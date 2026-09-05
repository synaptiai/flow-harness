import {
  calculateIssueLifecycleCommandDigest,
  parseIssueLifecycleCommand,
} from "../domain/issue-lifecycle/commands.js";
import {
  type PublicIssueLifecycleState,
  projectPublicIssueLifecycleState,
} from "../domain/issue-lifecycle/events.js";
import {
  continueClaimedIssue,
  createClaimedIssueController,
  issueControllerFailureCode,
  publicStateDigest,
  releaseClaimedIssue,
} from "./continue-github-issue.js";
import type { IssueControllerRuntimeDependencies } from "./github-issue-controller-ports.js";

export async function resumeGitHubIssue(
  input: unknown,
  dependencies: IssueControllerRuntimeDependencies,
): Promise<PublicIssueLifecycleState> {
  const command = parseIssueLifecycleCommand(input);
  if (command.kind !== "resume") throw new Error("resumeGitHubIssue requires a resume command");
  const recordedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const record = await dependencies.repository.recordCommand({
    runId: command.runId,
    recordedAt,
    command,
  });
  const controller = await createClaimedIssueController(
    command.runId,
    command.commandId,
    dependencies,
  );
  try {
    if (record.settlement !== undefined) {
      return projectPublicIssueLifecycleState(controller.state);
    }
    const state = await continueClaimedIssue(controller);
    const failed = state.phase === "failed";
    await dependencies.repository.settleCommand(command.runId, command.commandId, {
      version: 1,
      commandDigest: calculateIssueLifecycleCommandDigest(command),
      settledAt: eventTime(state.lastEventAt, dependencies.now),
      outcome: failed ? "failed" : "completed",
      ...(failed ? { code: state.terminal?.code ?? "controller_failed" } : {}),
      resultDigest: publicStateDigest(state),
    });
    return state;
  } catch (error) {
    const code = issueControllerFailureCode(error);
    if (
      controller.state.pendingEffect === undefined &&
      !["merged", "failed", "cancelled"].includes(controller.state.phase)
    ) {
      await controller.append({
        type: "run_failed",
        code,
        evidenceDigest: publicStateDigest(projectPublicIssueLifecycleState(controller.state)),
      });
    }
    const failed = projectPublicIssueLifecycleState(controller.state);
    await dependencies.repository.settleCommand(command.runId, command.commandId, {
      version: 1,
      commandDigest: calculateIssueLifecycleCommandDigest(command),
      settledAt: eventTime(failed.lastEventAt, dependencies.now),
      outcome: "failed",
      code,
      resultDigest: publicStateDigest(failed),
    });
    throw error;
  } finally {
    await releaseClaimedIssue(controller);
  }
}

function eventTime(previous: string, now: (() => Date) | undefined): string {
  const candidate = (now ?? (() => new Date()))().toISOString();
  return candidate < previous ? previous : candidate;
}
