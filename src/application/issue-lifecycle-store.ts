import type { IssueLifecycleEvent } from "../domain/issue-lifecycle/events.js";

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

export interface IssueLifecycleStore {
  append(event: IssueLifecycleEvent): Promise<void>;
  claim(runId: string): Promise<readonly IssueLifecycleEvent[]>;
  release(runId: string): Promise<void>;
  exists(runId: string): Promise<boolean>;
  read(runId: string): Promise<readonly IssueLifecycleEvent[]>;
  readPage(request: IssueLifecycleEventPageRequest): Promise<IssueLifecycleEventPage>;
}
