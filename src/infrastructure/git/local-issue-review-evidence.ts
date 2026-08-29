import type { IssueVerificationPort } from "../../application/github-issue-controller-ports.js";
import type { IssueLifecycleStore } from "../../application/issue-lifecycle-store.js";
import type {
  IssueGitCandidateObservation,
  IssueGitCommitObservation,
  IssueGitVerificationWorktreeObservation,
  IssueGitWorkspace,
  IssueLocalGitPort,
} from "../../application/issue-local-git-port.js";
import {
  calculateIssueReviewEvidenceDigest,
  ISSUE_REVIEW_DIFF_MEDIA_TYPE,
  type IssueReviewEvidence,
  type IssueReviewEvidencePort,
} from "../../application/issue-review-evidence-port.js";
import { validateIssueVerificationResult } from "../../application/issue-verification.js";
import {
  calculateIssuePrivateManifestDigest,
  createIssuePrivateBlobReference,
  type FrozenIssueRunManifest,
  type IssuePrivateBlobReference,
} from "../../domain/issue-lifecycle/private-manifest.js";
import type { PinnedGitHubIssueHostExecutable } from "./fixed-host-executables.js";
import { MAX_STRICT_HOST_PROCESS_OUTPUT_BYTES, StrictHostProcess } from "./strict-host-process.js";

export const MAX_ISSUE_REVIEW_DIFF_BYTES = 32_768;

const DEFAULT_DIFF_TIMEOUT_MS = 60_000;
const MAX_DIFF_STDERR_BYTES = 65_536;

export type LocalIssueReviewEvidenceErrorCode =
  | "invalid_request"
  | "workspace_mismatch"
  | "verification_mismatch"
  | "candidate_drift"
  | "diff_failed"
  | "diff_timeout"
  | "diff_output_limit"
  | "operation_cancelled"
  | "evidence_store_failed";

/** A bounded, content-free failure at the trusted review-evidence boundary. */
export class LocalIssueReviewEvidenceError extends Error {
  override readonly name = "LocalIssueReviewEvidenceError";

  constructor(readonly code: LocalIssueReviewEvidenceErrorCode) {
    super(`Local issue review evidence failed: ${code}`);
  }
}

export interface LocalIssueReviewEvidenceOptions {
  readonly git: IssueLocalGitPort;
  readonly gitExecutable: PinnedGitHubIssueHostExecutable;
  readonly privateStore: Pick<IssueLifecycleStore, "putBlob">;
  readonly verification: IssueVerificationPort;
  readonly timeoutMs?: number;
  readonly maxDiffBytes?: number;
  /** @internal Introduces a deterministic post-capture race in tests. */
  readonly testOnlyAfterDiffCapture?: () => Promise<void>;
}

interface CandidateProof {
  readonly commit: IssueGitCommitObservation;
  readonly candidate: IssueGitCandidateObservation;
  readonly worktree: IssueGitVerificationWorktreeObservation;
}

/** Captures exact private review input without exposing Git or storage authority to the model. */
export class LocalIssueReviewEvidence implements IssueReviewEvidencePort {
  readonly #diffProcess: StrictHostProcess;
  readonly #git: IssueLocalGitPort;
  readonly #privateStore: Pick<IssueLifecycleStore, "putBlob">;
  readonly #testOnlyAfterDiffCapture: (() => Promise<void>) | undefined;
  readonly #verification: IssueVerificationPort;

  constructor(options: LocalIssueReviewEvidenceOptions) {
    const maxDiffBytes = options.maxDiffBytes ?? MAX_ISSUE_REVIEW_DIFF_BYTES;
    if (
      !Number.isSafeInteger(maxDiffBytes) ||
      maxDiffBytes <= 0 ||
      maxDiffBytes > MAX_ISSUE_REVIEW_DIFF_BYTES ||
      maxDiffBytes > MAX_STRICT_HOST_PROCESS_OUTPUT_BYTES
    ) {
      throw new RangeError(`maxDiffBytes must be between 1 and ${MAX_ISSUE_REVIEW_DIFF_BYTES}`);
    }
    this.#git = options.git;
    this.#privateStore = options.privateStore;
    this.#verification = options.verification;
    this.#testOnlyAfterDiffCapture = options.testOnlyAfterDiffCapture;
    this.#diffProcess = new StrictHostProcess({
      executable: options.gitExecutable,
      environment: {
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_EXTERNAL_DIFF: "",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
        LC_ALL: "C",
        PAGER: "cat",
      },
      timeoutMs: options.timeoutMs ?? DEFAULT_DIFF_TIMEOUT_MS,
      maxStdoutBytes: maxDiffBytes,
      maxStderrBytes: MAX_DIFF_STDERR_BYTES,
    });
  }

  async read(request: {
    readonly runId: string;
    readonly manifest: FrozenIssueRunManifest;
    readonly candidateHead: string;
    readonly workspace: IssueGitWorkspace;
    readonly signal?: AbortSignal;
  }): Promise<IssueReviewEvidence> {
    validateRequest(request);
    const verification = await this.#readVerification(request);
    const before = await this.#proveCandidate(request, "command-postcondition", request.signal);
    const diff = await this.#diffProcess.run({
      cwd: request.workspace.verificationRoot,
      arguments: [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        "-c",
        "diff.external=",
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "-c",
        "diff.algorithm=myers",
        "-c",
        "diff.indentHeuristic=false",
        "-c",
        "core.attributesFile=/dev/null",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--full-index",
        "--binary",
        request.manifest.base.commit,
        request.candidateHead,
        "--",
      ],
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    try {
      await this.#testOnlyAfterDiffCapture?.();
    } catch {
      return fail("candidate_drift");
    }
    const after = await this.#proveCandidate(request, "command-postcondition");
    if (!sameProof(before, after)) fail("candidate_drift");
    validateDiffResult(diff);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(diff.stdout);
    } catch {
      return fail("diff_failed");
    }

    const diffInput = {
      mediaType: ISSUE_REVIEW_DIFF_MEDIA_TYPE,
      bytes: Uint8Array.from(diff.stdout),
    };
    let diffBlob: IssuePrivateBlobReference;
    try {
      diffBlob = await this.#privateStore.putBlob(request.runId, diffInput);
      const expected = createIssuePrivateBlobReference(diffInput);
      if (
        diffBlob.digest !== expected.digest ||
        diffBlob.mediaType !== expected.mediaType ||
        diffBlob.byteLength !== expected.byteLength
      ) {
        fail("evidence_store_failed");
      }
    } catch (error) {
      if (error instanceof LocalIssueReviewEvidenceError) throw error;
      return fail("evidence_store_failed");
    }

    let pristine: CandidateProof;
    try {
      await this.#git.resetVerificationWorktree({
        workspace: request.workspace,
        commit: request.candidateHead,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      pristine = await this.#proveCandidate(request, "pristine", request.signal);
    } catch (error) {
      if (request.signal?.aborted === true) return fail("operation_cancelled");
      if (error instanceof LocalIssueReviewEvidenceError) throw error;
      return fail("candidate_drift");
    }
    if (!sameProof(after, pristine)) fail("candidate_drift");

    const evidenceWithoutDigest = {
      version: 1 as const,
      baseCommit: request.manifest.base.commit,
      candidateHead: request.candidateHead,
      candidateTree: pristine.commit.tree,
      workspaceIdentityDigest: pristine.worktree.workspaceIdentityDigest,
      changedPaths: Object.freeze([...pristine.candidate.changedPaths]),
      logicalBytes: pristine.candidate.logicalBytes,
      diffBlob,
      verification,
    };
    return Object.freeze({
      ...evidenceWithoutDigest,
      evidenceDigest: calculateIssueReviewEvidenceDigest(evidenceWithoutDigest),
    });
  }

  async #readVerification(request: {
    readonly runId: string;
    readonly manifest: FrozenIssueRunManifest;
    readonly candidateHead: string;
    readonly signal?: AbortSignal;
  }) {
    try {
      const result = await this.#verification.verify({
        runId: request.runId,
        manifest: request.manifest,
        frozenContractDigest: calculateIssuePrivateManifestDigest(request.manifest),
        candidateHead: request.candidateHead,
        pollCancellation: async () => {
          if (request.signal?.aborted === true) throw request.signal.reason;
        },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return validateIssueVerificationResult(request.manifest, request.candidateHead, result);
    } catch {
      if (request.signal?.aborted === true) return fail("operation_cancelled");
      return fail("verification_mismatch");
    }
  }

  async #proveCandidate(
    request: {
      readonly manifest: FrozenIssueRunManifest;
      readonly candidateHead: string;
      readonly workspace: IssueGitWorkspace;
    },
    cleanliness: "pristine" | "command-postcondition",
    signal?: AbortSignal,
  ): Promise<CandidateProof> {
    try {
      const [commit, candidate, worktree] = await Promise.all([
        this.#git.inspectCommit({
          workspace: request.workspace,
          commit: request.candidateHead,
          ...(signal === undefined ? {} : { signal }),
        }),
        this.#git.inspectVerificationCandidate({
          workspace: request.workspace,
          baseCommit: request.manifest.base.commit,
          candidateHead: request.candidateHead,
          allowedWritePrefixes: request.manifest.allowedWritePrefixes,
          ...(signal === undefined ? {} : { signal }),
        }),
        this.#git.inspectVerificationWorktree({
          workspace: request.workspace,
          commit: request.candidateHead,
          cleanliness,
          ...(signal === undefined ? {} : { signal }),
        }),
      ]);
      if (
        commit.commit !== request.candidateHead ||
        candidate.head !== request.candidateHead ||
        candidate.baseCommit !== request.manifest.base.commit ||
        candidate.tree !== commit.tree ||
        worktree.head !== request.candidateHead ||
        worktree.tree !== commit.tree ||
        worktree.status !== "clean" ||
        candidate.workspaceIdentityDigest !== request.workspace.workspaceIdentityDigest ||
        worktree.workspaceIdentityDigest !== request.workspace.workspaceIdentityDigest ||
        candidate.changedPaths.length === 0
      ) {
        fail("candidate_drift");
      }
      return Object.freeze({ commit, candidate, worktree });
    } catch (error) {
      if (error instanceof LocalIssueReviewEvidenceError) throw error;
      return fail("candidate_drift");
    }
  }
}

function validateRequest(request: {
  readonly runId: string;
  readonly manifest: FrozenIssueRunManifest;
  readonly candidateHead: string;
  readonly workspace: IssueGitWorkspace;
}): void {
  if (
    request.runId !== request.manifest.runId ||
    request.candidateHead === request.manifest.base.commit ||
    request.workspace.repositoryIdentity !== request.manifest.repository.identity ||
    request.workspace.originCanonicalUrl !== request.manifest.repository.canonicalUrl ||
    request.workspace.baseBranch !== request.manifest.base.branch ||
    request.workspace.baseCommit !== request.manifest.base.commit ||
    request.workspace.branch !== request.manifest.branch.name
  ) {
    fail("invalid_request");
  }
}

function validateDiffResult(result: Awaited<ReturnType<StrictHostProcess["run"]>>): void {
  if (result.termination === "abort") fail("operation_cancelled");
  if (result.termination === "timeout") fail("diff_timeout");
  if (result.termination === "output_limit") fail("diff_output_limit");
  if (result.termination !== "exit") fail("diff_failed");
  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.stdoutTruncated ||
    result.stderrTruncated ||
    result.stdout.byteLength === 0 ||
    result.stderr.byteLength !== 0
  ) {
    fail("diff_failed");
  }
}

function sameProof(left: CandidateProof, right: CandidateProof): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fail(code: LocalIssueReviewEvidenceErrorCode): never {
  throw new LocalIssueReviewEvidenceError(code);
}
