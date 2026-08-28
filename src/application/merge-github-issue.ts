import {
  calculateIssueLifecycleCommandDigest,
  parseIssueLifecycleCommand,
} from "../domain/issue-lifecycle/commands.js";
import {
  type PublicIssueLifecycleState,
  projectPublicIssueLifecycleState,
} from "../domain/issue-lifecycle/events.js";
import {
  calculateIssueMergeProofDigest,
  verifyIssueMergeProof,
} from "../domain/issue-lifecycle/github-observation.js";
import {
  continueClaimedIssue,
  createClaimedIssueController,
  createCurrentIssueGate,
  evidenceDigest,
  publicStateDigest,
  releaseClaimedIssue,
  runExternalEffect,
} from "./continue-github-issue.js";
import type { IssueControllerDependencies } from "./github-issue-controller-ports.js";

export async function mergeGitHubIssue(
  input: unknown,
  dependencies: IssueControllerDependencies,
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
    const gate = controller.state.mergeGate;
    if (
      controller.state.phase !== "merge_approval_required" ||
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

    const applied = await runExternalEffect(controller, {
      kind: "merge",
      commandId: command.commandId,
      candidateHead: gate.candidateHead,
      pullRequestNumber: gate.pullRequestNumber,
      pullRequestNodeId: gate.pullRequestNodeId,
      gateDigest: gate.gateDigest,
    });
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
    const proof = verifyIssueMergeProof(
      await dependencies.github.proveMerge({
        runId: controller.manifest.runId,
        manifest: controller.manifest,
        pullRequestNumber: gate.pullRequestNumber,
        pullRequestNodeId: gate.pullRequestNodeId,
        candidateHead: gate.candidateHead,
        gateDigest: gate.gateDigest,
        ...controller.operation(),
      }),
    );
    if (
      proof.repositoryIdentity !== controller.manifest.repository.identity ||
      proof.pullRequestNumber !== gate.pullRequestNumber ||
      proof.pullRequestNodeId !== gate.pullRequestNodeId ||
      proof.gateDigest !== gate.gateDigest ||
      proof.frozenBaseCommit !== controller.manifest.base.commit ||
      proof.candidateHead !== gate.candidateHead ||
      proof.mergeCommit !== applied.result.mergeCommit ||
      proof.method !== controller.manifest.merge.method ||
      proof.deleteBranchRequested !== controller.manifest.merge.deleteBranch ||
      proof.branchDeleted !== applied.result.branchDeleted
    ) {
      throw new Error("merge proof does not bind the approved gate and applied merge result");
    }
    const proofDigest = calculateIssueMergeProofDigest(proof);
    await controller.append({
      type: "phase_transitioned",
      from: "merging",
      to: "merged",
      receipt: {
        kind: "merge",
        candidateHead: gate.candidateHead,
        gateDigest: gate.gateDigest,
        mergeCommit: proof.mergeCommit,
        deleteBranchRequested: proof.deleteBranchRequested,
        branchDeleted: proof.branchDeleted,
        evidenceDigest: proofDigest,
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
      if (
        controller.state.pendingEffect === undefined &&
        !["merged", "failed", "cancelled"].includes(controller.state.phase)
      ) {
        await controller.append({
          type: "run_failed",
          code: "merge_failed",
          evidenceDigest: evidenceDigest("merge-failure", {
            code: error instanceof Error && "code" in error ? String(error.code) : "merge_failed",
          }),
        });
      }
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
  dependencies: IssueControllerDependencies,
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
