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
  createCurrentIssueGate,
  evidenceDigest,
  publicStateDigest,
  recoverPendingEffect,
  releaseClaimedIssue,
  runExternalEffect,
} from "./continue-github-issue.js";
import type { IssueControllerRuntimeDependencies } from "./github-issue-controller-ports.js";

export async function mergeGitHubIssue(
  input: unknown,
  dependencies: IssueControllerRuntimeDependencies,
): Promise<PublicIssueLifecycleState> {
  const command = parseIssueLifecycleCommand(input);
  if (command.kind !== "merge") throw new Error("mergeGitHubIssue requires a merge command");
  const record = await dependencies.repository.recordCommand({
    runId: command.runId,
    recordedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
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
    if (
      controller.state.phase === "external_state_uncertain" &&
      controller.state.recoveryPhase === "merging" &&
      controller.state.pendingEffect?.effectKind === "merge"
    ) {
      if (!(await recoverPendingEffect(controller))) {
        const uncertain = projectPublicIssueLifecycleState(controller.state);
        await settle(
          dependencies,
          command,
          uncertain.lastEventAt,
          "failed",
          "external_state_uncertain",
          publicStateDigest(uncertain),
        );
        return uncertain;
      }
    }
    const gate = controller.state.mergeGate;
    const awaitingApproval = controller.state.phase === "merge_approval_required";
    const recoveringApprovedMerge =
      controller.state.phase === "merging" &&
      controller.state.approvedMerge?.candidateHead === command.expectedHead &&
      controller.state.approvedMerge.gateDigest === command.expectedGateDigest;
    if (
      (!awaitingApproval && !recoveringApprovedMerge) ||
      gate === undefined ||
      gate.pullRequestNumber !== command.expectedPullRequest ||
      gate.candidateHead !== command.expectedHead ||
      gate.gateDigest !== command.expectedGateDigest
    ) {
      await settle(
        dependencies,
        command,
        controller.state.lastEventAt,
        "rejected",
        "approval_mismatch",
      );
      throw new Error("merge command does not match the current exact merge approval gate");
    }

    if (awaitingApproval) {
      const fresh = await createCurrentIssueGate(controller);
      if (fresh === undefined || fresh.gate.digest !== gate.gateDigest) {
        await controller.append({
          type: "phase_transitioned",
          from: "merge_approval_required",
          to: "verifying",
          receipt: {
            kind: "gate_invalidated",
            candidateHead: gate.candidateHead,
            gateDigest: gate.gateDigest,
            evidenceDigest:
              fresh?.gate.observationDigest ??
              evidenceDigest("gate-invalidated", { reason: "github_not_ready" }),
          },
        });
        const replacement = await continueClaimedIssue(controller);
        await settle(
          dependencies,
          command,
          replacement.lastEventAt,
          "rejected",
          "gate_invalidated",
          publicStateDigest(replacement),
        );
        return replacement;
      }

      const actorDigest = evidenceDigest("merge-actor", { actor: command.actor });
      await controller.append({
        type: "phase_transitioned",
        from: "merge_approval_required",
        to: "merging",
        receipt: {
          kind: "merge_approval",
          candidateHead: gate.candidateHead,
          gateDigest: gate.gateDigest,
          actorDigest,
          evidenceDigest: evidenceDigest("merge-approval", {
            commandDigest: calculateIssueLifecycleCommandDigest(command),
            actorDigest,
          }),
        },
      });
    }

    const settledMerge = controller.state.appliedEffects.find(
      (effect) => effect.effectKind === "merge",
    );
    const applied =
      settledMerge === undefined
        ? await runExternalEffect(controller, {
            kind: "merge",
            commandId: command.commandId,
            candidateHead: gate.candidateHead,
            pullRequestNumber: gate.pullRequestNumber,
            pullRequestNodeId: gate.pullRequestNodeId,
            gateDigest: gate.gateDigest,
          })
        : { result: settledMerge.result, observationDigest: settledMerge.observationDigest };
    if (applied === undefined) {
      const uncertain = projectPublicIssueLifecycleState(controller.state);
      await settle(
        dependencies,
        command,
        uncertain.lastEventAt,
        "failed",
        "external_state_uncertain",
        publicStateDigest(uncertain),
      );
      return uncertain;
    }
    if (applied.result.kind !== "merge") {
      throw new Error("merge effect returned another effect kind");
    }
    if (
      applied.result.candidateHead !== gate.candidateHead ||
      applied.result.gateDigest !== gate.gateDigest ||
      applied.result.deleteBranchRequested !== controller.manifest.merge.deleteBranch
    ) {
      throw new Error("merge proof does not bind the approved gate and applied merge result");
    }
    await controller.append({
      type: "phase_transitioned",
      from: "merging",
      to: "merged",
      receipt: {
        kind: "merge",
        candidateHead: gate.candidateHead,
        gateDigest: gate.gateDigest,
        mergeCommit: applied.result.mergeCommit,
        deleteBranchRequested: applied.result.deleteBranchRequested,
        branchDeleted: applied.result.branchDeleted,
        evidenceDigest: applied.result.proofDigest,
      },
    });
    const merged = projectPublicIssueLifecycleState(controller.state);
    await settle(
      dependencies,
      command,
      merged.lastEventAt,
      "completed",
      undefined,
      publicStateDigest(merged),
    );
    return merged;
  } catch (error) {
    const currentRecord = await dependencies.repository.readCommand(
      command.runId,
      command.commandId,
    );
    if (currentRecord.settlement === undefined) {
      const failed = projectPublicIssueLifecycleState(controller.state);
      await settle(
        dependencies,
        command,
        failed.lastEventAt,
        "failed",
        error instanceof Error && "code" in error ? String(error.code) : "merge_failed",
        publicStateDigest(failed),
      );
    }
    throw error;
  } finally {
    await releaseClaimedIssue(controller);
  }
}

async function settle(
  dependencies: IssueControllerRuntimeDependencies,
  command: Extract<ReturnType<typeof parseIssueLifecycleCommand>, { readonly kind: "merge" }>,
  previous: string,
  outcome: "completed" | "failed" | "rejected",
  code?: string,
  resultDigest?: string,
): Promise<void> {
  await dependencies.repository.settleCommand(command.runId, command.commandId, {
    version: 1,
    commandDigest: calculateIssueLifecycleCommandDigest(command),
    settledAt: eventTime(previous, dependencies.now),
    outcome,
    ...(code === undefined ? {} : { code }),
    ...(resultDigest === undefined ? {} : { resultDigest }),
  });
}

function eventTime(previous: string, now: (() => Date) | undefined): string {
  const candidate = (now ?? (() => new Date()))().toISOString();
  return candidate < previous ? previous : candidate;
}
