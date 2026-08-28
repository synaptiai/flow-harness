import type { IssueLifecycleCommand } from "../domain/issue-lifecycle/commands.js";
import type {
  IssueExternalEffectResult,
  IssueLifecycleEvent,
  IssueLifecycleState,
  PendingIssueExternalEffect,
} from "../domain/issue-lifecycle/events.js";
import type { IssueExternalEffectDescriptor } from "../domain/issue-lifecycle/external-effects.js";
import type {
  GitHubLifecycleObservation,
  IssueMergeProof,
} from "../domain/issue-lifecycle/github-observation.js";
import type {
  FrozenIssueRunManifest,
  IssuePrivateBlobInput,
} from "../domain/issue-lifecycle/private-manifest.js";
import type { IssueVerificationResult } from "./issue-verification.js";
import type {
  ImplementationWorkflowResult,
  RawReviewWorkflowResult,
} from "./issue-workflow-runner.js";

export interface IssueControllerCommandSettlement {
  readonly version: 1;
  readonly commandDigest: string;
  readonly settledAt: string;
  readonly outcome: "completed" | "failed" | "rejected";
  readonly code?: string;
  readonly resultDigest?: string;
}

export interface IssueControllerCommandRecord {
  readonly version: 1;
  readonly runId: string;
  readonly recordedAt: string;
  readonly commandDigest: string;
  readonly command: IssueLifecycleCommand;
  readonly settlement?: IssueControllerCommandSettlement;
}

export interface IssueControllerCommandRecordInput {
  readonly runId: string;
  readonly recordedAt: string;
  readonly command: unknown;
}

export interface IssueControllerRunInitialization {
  readonly manifest: FrozenIssueRunManifest;
  readonly initialBlobs: readonly IssuePrivateBlobInput[];
  readonly snapshot: IssueLifecycleEvent;
  readonly command: IssueControllerCommandRecordInput;
}

/** The aggregate repository boundary required by the foreground controller. */
export interface IssueControllerRepository {
  initialize(input: IssueControllerRunInitialization): Promise<void>;
  append(event: IssueLifecycleEvent): Promise<void>;
  claim(runId: string): Promise<readonly IssueLifecycleEvent[]>;
  release(runId: string): Promise<void>;
  exists(runId: string): Promise<boolean>;
  read(runId: string): Promise<readonly IssueLifecycleEvent[]>;
  readManifest(runId: string): Promise<FrozenIssueRunManifest>;
  recordCommand(input: IssueControllerCommandRecordInput): Promise<IssueControllerCommandRecord>;
  readCommand(runId: string, commandId: string): Promise<IssueControllerCommandRecord>;
  settleCommand(
    runId: string,
    commandId: string,
    settlement: IssueControllerCommandSettlement,
  ): Promise<IssueControllerCommandRecord>;
  readPendingCancellation(runId: string): Promise<IssueControllerCommandRecord | undefined>;
}

export interface FrozenIssueRunInput {
  readonly manifest: FrozenIssueRunManifest;
  readonly initialBlobs: readonly IssuePrivateBlobInput[];
  readonly evidenceDigest: string;
}

export interface IssueRunFreezerPort {
  freeze(
    command: Extract<IssueLifecycleCommand, { readonly kind: "run" }>,
    operation: IssueControllerOperation,
  ): Promise<FrozenIssueRunInput>;
}

export interface IssueControllerOperation {
  readonly signal?: AbortSignal;
  pollCancellation(): Promise<void>;
}

export interface IssueImplementationWorkflowRequest extends IssueControllerOperation {
  readonly kind: "implementation";
  readonly runId: string;
  readonly manifest: FrozenIssueRunManifest;
  readonly frozenContractDigest: string;
  readonly iteration: number;
  readonly workspaceIdentityDigest: string;
}

export interface IssueReviewWorkflowRequest extends IssueControllerOperation {
  readonly kind: "review";
  readonly runId: string;
  readonly manifest: FrozenIssueRunManifest;
  readonly frozenContractDigest: string;
  readonly candidateHead: string;
}

export interface IssueWorkflowRunnerPort {
  /**
   * Trusted adapter boundary. Implementations must not render the manifest, Git identities,
   * credentials, or delivery authority into the model prompt.
   */
  runImplementation(request: IssueImplementationWorkflowRequest): Promise<unknown>;
  /** The trusted runner injects evidence identities after model execution. */
  runReview(request: IssueReviewWorkflowRequest): Promise<unknown>;
  readReviewResult(request: {
    readonly runId: string;
    readonly flowRunId: string;
    readonly candidateHead: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface IssueVerificationRequest extends IssueControllerOperation {
  readonly runId: string;
  readonly manifest: FrozenIssueRunManifest;
  readonly frozenContractDigest: string;
  readonly candidateHead: string;
}

export interface IssueVerificationPort {
  verify(request: IssueVerificationRequest): Promise<IssueVerificationResult>;
}

export interface IssueGitHubObservationRequest extends IssueControllerOperation {
  readonly runId: string;
  readonly manifest: FrozenIssueRunManifest;
  readonly pullRequestNumber: number;
  readonly candidateHead: string;
}

export interface IssueMergeProofRequest extends IssueControllerOperation {
  readonly runId: string;
  readonly manifest: FrozenIssueRunManifest;
  readonly pullRequestNumber: number;
  readonly pullRequestNodeId: string;
  readonly candidateHead: string;
  readonly gateDigest: string;
}

export interface IssueGitHubPort {
  observe(request: IssueGitHubObservationRequest): Promise<GitHubLifecycleObservation>;
  proveMerge(request: IssueMergeProofRequest): Promise<IssueMergeProof>;
}

interface CommonIssueExternalEffectPreparation {
  readonly commandId: string;
}

export type IssueExternalEffectPreparation =
  | (CommonIssueExternalEffectPreparation & { readonly kind: "workspace" })
  | (CommonIssueExternalEffectPreparation & {
      readonly kind: "commit";
      readonly workspaceIdentityDigest: string;
      readonly parentCommit: string;
      readonly candidateTreeDigest: string;
      readonly messageDigest: string;
    })
  | (CommonIssueExternalEffectPreparation & {
      readonly kind: "push";
      readonly candidateHead: string;
      readonly expectedRemoteHead: string | null;
    })
  | (CommonIssueExternalEffectPreparation & {
      readonly kind: "pull_request";
      readonly candidateHead: string;
    })
  | (CommonIssueExternalEffectPreparation & {
      readonly kind: "pull_request_ready";
      readonly candidateHead: string;
      readonly pullRequestNumber?: number;
      readonly pullRequestNodeId?: string;
    })
  | (CommonIssueExternalEffectPreparation & {
      readonly kind: "merge";
      readonly candidateHead: string;
      readonly pullRequestNumber: number;
      readonly pullRequestNodeId: string;
      readonly gateDigest: string;
    });

export type IssueExternalEffectObservation =
  | {
      readonly status: "applied";
      readonly observationDigest: string;
      readonly result: IssueExternalEffectResult;
    }
  | { readonly status: "not_applied"; readonly observationDigest: string }
  | {
      readonly status: "uncertain";
      readonly code: string;
      readonly evidenceDigest: string;
    };

export interface IssueExternalEffectsPort {
  describe(
    request: IssueExternalEffectPreparation,
    manifest: FrozenIssueRunManifest,
  ): Promise<IssueExternalEffectDescriptor>;
  recover(
    manifest: FrozenIssueRunManifest,
    state: IssueLifecycleState,
    pending: PendingIssueExternalEffect,
  ): Promise<IssueExternalEffectDescriptor>;
  reconcile(
    descriptor: IssueExternalEffectDescriptor,
    operation: IssueControllerOperation,
  ): Promise<IssueExternalEffectObservation>;
  execute(
    descriptor: IssueExternalEffectDescriptor,
    operation: IssueControllerOperation,
  ): Promise<void>;
}

export interface IssueControllerRuntimeDependencies {
  readonly repository: IssueControllerRepository;
  readonly workflows: IssueWorkflowRunnerPort;
  readonly verification: IssueVerificationPort;
  readonly github: IssueGitHubPort;
  readonly effects: IssueExternalEffectsPort;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface IssueControllerDependencies extends IssueControllerRuntimeDependencies {
  readonly freezer: IssueRunFreezerPort;
}

export type { ImplementationWorkflowResult, RawReviewWorkflowResult };
