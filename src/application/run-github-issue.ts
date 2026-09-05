import {
  calculateIssueLifecycleCommandDigest,
  parseIssueLifecycleCommand,
} from "../domain/issue-lifecycle/commands.js";
import {
  type PublicIssueLifecycleState,
  parseIssueLifecycleEvent,
  projectPublicIssueLifecycleState,
} from "../domain/issue-lifecycle/events.js";
import {
  calculateIssuePrivateManifestDigest,
  parseIssuePrivateManifest,
} from "../domain/issue-lifecycle/private-manifest.js";
import {
  continueClaimedIssue,
  createClaimedIssueController,
  evidenceDigest,
  issueControllerFailureCode,
  publicStateDigest,
  releaseClaimedIssue,
} from "./continue-github-issue.js";
import type { IssueControllerDependencies } from "./github-issue-controller-ports.js";

export async function runGitHubIssue(
  input: unknown,
  dependencies: IssueControllerDependencies,
): Promise<PublicIssueLifecycleState> {
  const command = parseIssueLifecycleCommand(input);
  if (command.kind !== "run") throw new Error("runGitHubIssue requires a run command");
  const runId = deriveGitHubIssueRunId(command.commandId);
  if (await dependencies.repository.exists(runId)) {
    return await executeDurableRun(command, dependencies);
  }
  const freezeOperation = {
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    pollCancellation: async () => {
      if (dependencies.signal?.aborted) throw new Error("issue run was aborted before freeze");
    },
  };
  const frozen = await dependencies.freezer.freeze(command, freezeOperation);
  const manifest = parseIssuePrivateManifest(frozen.manifest);
  assertRunCommandMatchesManifest(command, manifest, runId);
  if (!/^[a-f0-9]{64}$/.test(frozen.evidenceDigest)) {
    throw new Error("frozen issue evidence digest is invalid");
  }
  const frozenContractDigest = calculateIssuePrivateManifestDigest(manifest);
  const snapshot = parseIssueLifecycleEvent({
    version: 1,
    runId: manifest.runId,
    sequence: 1,
    at: manifest.createdAt,
    type: "phase_transitioned",
    from: "preflight",
    to: "issue_frozen",
    receipt: {
      kind: "issue_snapshot",
      repositoryIdentity: manifest.repository.identity,
      issueNumber: manifest.issue.number,
      issueNodeId: manifest.issue.nodeId,
      issueUpdatedAt: manifest.issue.updatedAt,
      baseBranch: manifest.base.branch,
      baseCommit: manifest.base.commit,
      branch: manifest.branch.name,
      issueDigest: manifest.issue.contentDigest,
      frozenContractDigest,
      planDigest: manifest.planDigest,
      implementationTemplateWorkflowDigest: manifest.implementationWorkflow.templateWorkflowDigest,
      reviewTemplateWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
      budgetDigest: manifest.budgetDigest,
      evidenceDigest: frozen.evidenceDigest,
    },
  });
  try {
    await dependencies.repository.initialize({
      manifest,
      initialBlobs: frozen.initialBlobs,
      snapshot,
      command: { runId: manifest.runId, recordedAt: manifest.createdAt, command },
    });
  } catch (error) {
    if (!(await dependencies.repository.exists(runId))) throw error;
    const existingCommand = await dependencies.repository.readCommand(runId, command.commandId);
    if (existingCommand.commandDigest !== calculateIssueLifecycleCommandDigest(command)) {
      throw error;
    }
    return await executeDurableRun(command, dependencies);
  }
  return await executeDurableRun(command, dependencies);
}

function assertRunCommandMatchesManifest(
  command: Extract<ReturnType<typeof parseIssueLifecycleCommand>, { readonly kind: "run" }>,
  manifest: ReturnType<typeof parseIssuePrivateManifest>,
  runId: string,
): void {
  if (
    manifest.runId !== runId ||
    manifest.initialCommandId !== command.commandId ||
    manifest.repository.identity !== command.repositoryIdentity ||
    manifest.issue.canonicalUrl !== command.issueUrl ||
    manifest.planDigest !== command.planDigest ||
    manifest.implementationWorkflow.model.provider !== command.provider ||
    manifest.implementationWorkflow.model.id !== command.model ||
    manifest.reviewWorkflow.model.provider !== command.provider ||
    manifest.reviewWorkflow.model.id !== command.model
  ) {
    throw new Error("run command does not match the complete frozen issue manifest");
  }
}

export function deriveGitHubIssueRunId(commandId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(commandId)
  ) {
    throw new Error("issue run command identifier is invalid");
  }
  return `issue-${commandId}`;
}

async function executeDurableRun(
  command: Extract<ReturnType<typeof parseIssueLifecycleCommand>, { readonly kind: "run" }>,
  dependencies: IssueControllerDependencies,
): Promise<PublicIssueLifecycleState> {
  const runId = deriveGitHubIssueRunId(command.commandId);
  const record = await dependencies.repository.readCommand(runId, command.commandId);
  if (record.commandDigest !== calculateIssueLifecycleCommandDigest(command)) {
    throw new Error("existing issue run command does not match the replayed run command");
  }
  const controller = await createClaimedIssueController(runId, command.commandId, dependencies);
  try {
    if (record.settlement !== undefined) {
      return projectPublicIssueLifecycleState(controller.state);
    }
    const state = await continueClaimedIssue(controller);
    const failed = state.phase === "failed";
    await dependencies.repository.settleCommand(runId, command.commandId, {
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
        evidenceDigest: evidenceDigest("controller-failure", boundedError(error)),
      });
    }
    const failed = projectPublicIssueLifecycleState(controller.state);
    await dependencies.repository.settleCommand(runId, command.commandId, {
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

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048);
}
