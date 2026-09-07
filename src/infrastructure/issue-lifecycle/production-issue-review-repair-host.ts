import type { IssueLifecycleStore } from "../../application/issue-lifecycle-store.js";
import type {
  IssueGitFindingSourceObservation,
  IssueGitWorkspace,
  IssueLocalGitPort,
} from "../../application/issue-local-git-port.js";
import type {
  IssueReviewRepairAssessment,
  IssueReviewRepairHostPort,
  IssueReviewRepairHostRequest,
} from "../../application/issue-review-repair-host-port.js";
import {
  buildIssueReviewRepairProjection,
  type IssueReviewRepairProjection,
} from "../../application/issue-review-repair-projection.js";
import { validateReviewWorkflowResult } from "../../application/issue-workflow-runner.js";
import {
  decodeFrozenGitHubIssueSnapshot,
  FROZEN_GITHUB_ISSUE_SNAPSHOT_MEDIA_TYPE,
} from "../../domain/issue-lifecycle/frozen-github-issue-snapshot.js";
import {
  calculateIssueLifecycleDomainDigest,
  calculateIssuePrivateManifestDigest,
  parseIssuePrivateManifest,
  verifyIssuePrivateBlob,
} from "../../domain/issue-lifecycle/private-manifest.js";
import { calculateIssueReviewReportDigest } from "../../domain/issue-lifecycle/review.js";
import type { IssueWorkflowWorkspacePort } from "./production-issue-runner.js";

type RepairGitPort = Pick<IssueLocalGitPort, "inspectCommit"> & {
  readonly inspectFindingSource: NonNullable<IssueLocalGitPort["inspectFindingSource"]>;
};

export interface ProductionIssueReviewRepairHostOptions {
  readonly lifecycleStore: Pick<IssueLifecycleStore, "readBlob">;
  readonly workspaces: IssueWorkflowWorkspacePort;
  readonly git: RepairGitPort;
}

export class IssueReviewRepairHostError extends Error {
  override readonly name = "IssueReviewRepairHostError";

  constructor(
    readonly code:
      | "repair_not_authorized"
      | "repair_cycle_not_authorized"
      | "repair_class_not_authorized"
      | "review_identity_mismatch"
      | "issue_identity_mismatch"
      | "workspace_identity_mismatch"
      | "candidate_identity_mismatch"
      | "operation_aborted",
  ) {
    super(`Issue review repair host failed: ${code}`);
  }
}

/** Observes frozen authority and exact Git source; it does not adjudicate arbitrary review prose. */
export class ProductionIssueReviewRepairHost implements IssueReviewRepairHostPort {
  readonly #lifecycleStore: Pick<IssueLifecycleStore, "readBlob">;
  readonly #workspaces: IssueWorkflowWorkspacePort;
  readonly #git: RepairGitPort;

  constructor(options: ProductionIssueReviewRepairHostOptions) {
    this.#lifecycleStore = options.lifecycleStore;
    this.#workspaces = options.workspaces;
    this.#git = options.git;
  }

  async project(request: IssueReviewRepairHostRequest): Promise<IssueReviewRepairProjection> {
    return (await this.#prepare(request)).projection;
  }

  async assess(request: IssueReviewRepairHostRequest): Promise<IssueReviewRepairAssessment> {
    const prepared = await this.#prepare(request);
    const { manifest, projection, workspaceIdentityDigest, signal } = prepared;
    const workspace = await this.#workspaces.read({
      runId: manifest.runId,
      workspaceIdentityDigest,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      workspace.workspaceIdentityDigest !== workspaceIdentityDigest ||
      workspace.repositoryIdentity !== manifest.repository.identity ||
      workspace.branch !== manifest.branch.name ||
      workspace.baseBranch !== manifest.base.branch ||
      workspace.baseCommit !== manifest.base.commit
    ) {
      throw new IssueReviewRepairHostError("workspace_identity_mismatch");
    }
    const candidateHead = projection.context.binding.candidateHead;
    const candidateTree = projection.context.binding.candidateTree;
    await this.#inspectCandidate(workspace, candidateHead, candidateTree, signal);
    const observations: {
      readonly findingId: string;
      readonly source: IssueGitFindingSourceObservation;
    }[] = [];
    for (const finding of projection.context.findings) {
      assertNotAborted(signal);
      const source = await this.#git.inspectFindingSource({
        workspace,
        candidateHead,
        file: finding.file,
        startLine: finding.startLine,
        ...(finding.endLine === undefined ? {} : { endLine: finding.endLine }),
        allowedWritePrefixes: projection.context.allowedWritePrefixes,
        ...(signal === undefined ? {} : { signal }),
      });
      observations.push({ findingId: finding.id, source });
    }
    // Also close the observation window for zero-findings / unsatisfied-only reviews.
    await this.#inspectCandidate(workspace, candidateHead, candidateTree, signal);
    assertNotAborted(signal);
    const eligibilityDigest = calculateIssueLifecycleDomainDigest(
      "flow.issue.review-repair-eligibility.v1",
      {
        version: 1,
        frozenContractDigest: calculateIssuePrivateManifestDigest(manifest),
        workspaceIdentityDigest,
        contextDigest: projection.digest,
        candidateHead,
        candidateTree,
        baseCommit: manifest.base.commit,
        observations,
      },
    );
    return Object.freeze({ projection, eligibilityDigest });
  }

  async #inspectCandidate(
    workspace: IssueGitWorkspace,
    candidateHead: string,
    candidateTree: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal);
    const observation = await this.#git.inspectCommit({
      workspace,
      commit: candidateHead,
      expectedCandidateHead: candidateHead,
      ...(signal === undefined ? {} : { signal }),
    });
    if (observation.commit !== candidateHead || observation.tree !== candidateTree) {
      throw new IssueReviewRepairHostError("candidate_identity_mismatch");
    }
  }

  async #prepare(request: IssueReviewRepairHostRequest) {
    const signal = request.signal;
    assertNotAborted(signal);
    const manifest = parseIssuePrivateManifest(request.manifest);
    const policy = manifest.reviewRepair;
    if (policy === undefined) throw new IssueReviewRepairHostError("repair_not_authorized");
    const cycle = request.cycle;
    if (!Number.isSafeInteger(cycle) || cycle < 1 || cycle > policy.maxCycles) {
      throw new IssueReviewRepairHostError("repair_cycle_not_authorized");
    }
    const workspaceIdentityDigest = request.workspaceIdentityDigest;
    if (!/^[a-f0-9]{64}$/.test(workspaceIdentityDigest)) {
      throw new IssueReviewRepairHostError("workspace_identity_mismatch");
    }
    const candidateTree = request.candidateTree;
    if (!/^[a-f0-9]{40}$/.test(candidateTree)) {
      throw new IssueReviewRepairHostError("candidate_identity_mismatch");
    }
    const { report, reportDigest, ...rawReview } = request.review;
    const review = validateReviewWorkflowResult(manifest, rawReview.candidateHead, rawReview);
    const identity = {
      candidateHead: review.candidateHead,
      issueDigest: manifest.issue.contentDigest,
      reviewWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
    };
    if (
      review.report.verdict !== "blocked" ||
      reportDigest !== review.reportDigest ||
      calculateIssueReviewReportDigest(
        report,
        manifest.acceptanceCriteria.map(({ id }) => id),
        identity,
      ) !== review.reportDigest
    ) {
      throw new IssueReviewRepairHostError("review_identity_mismatch");
    }
    if (
      (review.report.findings.length > 0 && !policy.eligibleClasses.includes("review-findings")) ||
      (review.report.acceptanceMapping.some(({ status }) => status === "unsatisfied") &&
        !policy.eligibleClasses.includes("unsatisfied-criteria"))
    ) {
      throw new IssueReviewRepairHostError("repair_class_not_authorized");
    }
    const issueBlob = await this.#lifecycleStore.readBlob(manifest.runId, manifest.artifacts.issue);
    assertNotAborted(signal);
    verifyIssuePrivateBlob(issueBlob, manifest.artifacts.issue);
    if (issueBlob.mediaType !== FROZEN_GITHUB_ISSUE_SNAPSHOT_MEDIA_TYPE) {
      throw new IssueReviewRepairHostError("issue_identity_mismatch");
    }
    const issue = decodeFrozenGitHubIssueSnapshot(issueBlob.bytes);
    if (
      issue.repository.identity !== manifest.repository.identity ||
      issue.repository.nodeId !== manifest.repository.nodeId ||
      issue.issue.number !== manifest.issue.number ||
      issue.issue.nodeId !== manifest.issue.nodeId ||
      issue.issue.updatedAt !== manifest.issue.updatedAt ||
      issue.issue.contentDigest !== manifest.issue.contentDigest
    ) {
      throw new IssueReviewRepairHostError("issue_identity_mismatch");
    }
    const projection = buildIssueReviewRepairProjection({
      issue,
      acceptanceCriteria: manifest.acceptanceCriteria,
      allowedWritePrefixes: manifest.allowedWritePrefixes,
      report: review.report,
      binding: {
        cycle,
        candidateHead: review.candidateHead,
        candidateTree,
        issueDigest: manifest.issue.contentDigest,
        reviewWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
        reviewReportDigest: review.reportDigest,
        repairWorkflowDigest: policy.workflow.templateWorkflowDigest,
      },
    });
    return { manifest, projection, workspaceIdentityDigest, signal };
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new IssueReviewRepairHostError("operation_aborted");
}
