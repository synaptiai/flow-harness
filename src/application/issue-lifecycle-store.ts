import type { IssueLifecycleCommand } from "../domain/issue-lifecycle/commands.js";
import type { IssueLifecycleEvent } from "../domain/issue-lifecycle/events.js";
import type {
  FrozenIssueRunManifest,
  IssuePrivateBlobInput,
  IssuePrivateBlobReference,
} from "../domain/issue-lifecycle/private-manifest.js";

export interface IssueLifecycleEventPageRequest {
  readonly runId: string;
  readonly afterSequence: number;
  readonly limit: number;
}

export interface IssueLifecycleEventPage {
  readonly events: readonly IssueLifecycleEvent[];
  readonly cursor: number;
  readonly hasMore: boolean;
  readonly terminal: boolean;
}

export interface IssueLifecycleCommandRecordInput {
  readonly runId: string;
  readonly recordedAt: string;
  readonly command: unknown;
}

export interface IssueLifecycleCommandSettlement {
  readonly version: 1;
  readonly commandDigest: string;
  readonly settledAt: string;
  readonly outcome: "completed" | "failed" | "rejected";
  readonly code?: string;
  readonly resultDigest?: string;
}

export interface IssueLifecycleCommandRecord {
  readonly version: 1;
  readonly runId: string;
  readonly recordedAt: string;
  readonly commandDigest: string;
  readonly command: IssueLifecycleCommand;
  readonly settlement?: IssueLifecycleCommandSettlement;
}

export interface IssueLifecycleRunInitialization {
  readonly manifest: FrozenIssueRunManifest;
  readonly initialBlobs: readonly IssuePrivateBlobInput[];
  readonly snapshot: IssueLifecycleEvent;
  readonly command: IssueLifecycleCommandRecordInput;
}

export interface IssueLifecycleStore {
  initialize(input: IssueLifecycleRunInitialization): Promise<void>;
  append(event: IssueLifecycleEvent): Promise<void>;
  claim(runId: string): Promise<readonly IssueLifecycleEvent[]>;
  release(runId: string): Promise<void>;
  exists(runId: string): Promise<boolean>;
  read(runId: string): Promise<readonly IssueLifecycleEvent[]>;
  readPage(request: IssueLifecycleEventPageRequest): Promise<IssueLifecycleEventPage>;
  readManifest(runId: string): Promise<FrozenIssueRunManifest>;
  putBlob(runId: string, input: IssuePrivateBlobInput): Promise<IssuePrivateBlobReference>;
  readBlob(runId: string, reference: IssuePrivateBlobReference): Promise<IssuePrivateBlobInput>;
  recordCommand(input: IssueLifecycleCommandRecordInput): Promise<IssueLifecycleCommandRecord>;
  readCommand(runId: string, commandId: string): Promise<IssueLifecycleCommandRecord>;
  settleCommand(
    runId: string,
    commandId: string,
    settlement: IssueLifecycleCommandSettlement,
  ): Promise<IssueLifecycleCommandRecord>;
  readPendingCancellation(runId: string): Promise<IssueLifecycleCommandRecord | undefined>;
}
