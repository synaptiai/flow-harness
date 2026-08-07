import { createHash, randomBytes, randomUUID } from "node:crypto";

import { reduceRunEvents, type RunEvent, type RunStatus } from "../domain/run/events.js";
import { compileWorkflowText } from "../domain/workflow/compiler.js";
import { JsonlRunStore, RunStoreError } from "../infrastructure/fs/jsonl-run-store.js";
import {
  LocalSupervisorStoreError,
  type LocalSupervisorStore,
} from "../infrastructure/fs/local-supervisor-store.js";
import type {
  AcceptedResult,
  CancelCommand,
  CancelledResult,
  EventsCommand,
  EventsResult,
  SubmitCommand,
  SupervisorResult,
  WorkerResponse,
  WorkerRequest,
  WorkerSummary,
} from "./protocol.js";
import {
  completeCancellationCommand,
  completeSubmissionCommand,
  createActiveRunClaim,
  createCancellationCommandRecord,
  createJobRecord,
  createSubmissionCommandRecord,
  markCancellationCommandUncertain,
  markSubmissionCommandUncertain,
  rejectSubmissionCommand,
  type CancellationCommandRecord,
  type JobRecord,
  type SubmissionCommandRecord,
  type WorkerDescriptor,
} from "./records.js";

export type SupervisorServiceErrorCode =
  | "command_uncertain"
  | "conflict"
  | "identity_mismatch"
  | "not_found"
  | "worker_unavailable";

export class SupervisorServiceError extends Error {
  override readonly name = "SupervisorServiceError";

  constructor(
    readonly code: SupervisorServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface WorkerLauncher {
  launch(job: JobRecord): Promise<WorkerDescriptor>;
  request(descriptor: WorkerDescriptor, command: WorkerRequest["command"]): Promise<WorkerResponse>;
}

export interface LocalSupervisorServiceOptions {
  readonly store: LocalSupervisorStore;
  readonly launcher: WorkerLauncher;
  readonly generation: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly now?: () => Date;
}

export class LocalSupervisorService {
  readonly #store: LocalSupervisorStore;
  readonly #launcher: WorkerLauncher;
  readonly #generation: string;
  readonly #pid: number;
  readonly #startedAt: string;
  readonly #now: () => Date;
  readonly #submissions = new Map<
    string,
    { readonly command: SubmitCommand; readonly result: Promise<AcceptedResult> }
  >();

  constructor(options: LocalSupervisorServiceOptions) {
    this.#store = options.store;
    this.#launcher = options.launcher;
    this.#generation = options.generation;
    this.#pid = options.pid;
    this.#startedAt = options.startedAt;
    this.#now = options.now ?? (() => new Date());
  }

  async submit(command: SubmitCommand): Promise<AcceptedResult> {
    const pending = this.#submissions.get(command.commandId);
    if (pending !== undefined) {
      if (!sameSubmitCommand(pending.command, command)) {
        throw new SupervisorServiceError(
          "conflict",
          `command "${command.commandId}" is already executing with different input`,
        );
      }
      return await pending.result;
    }
    const submission = this.#submitOnce(command);
    this.#submissions.set(command.commandId, { command, result: submission });
    try {
      return await submission;
    } finally {
      if (this.#submissions.get(command.commandId)?.result === submission) {
        this.#submissions.delete(command.commandId);
      }
    }
  }

  async #submitOnce(command: SubmitCommand): Promise<AcceptedResult> {
    // Compilation must precede every durable reservation and worker launch.
    compileWorkflowText(command.workflowSource, command.sourceName);

    let journal: SubmissionCommandRecord;
    try {
      const recorded = await this.#store.recordCommand(
        createSubmissionCommandRecord({
          commandId: command.commandId,
          runId: command.runId,
          mode: command.mode,
          sourceName: command.sourceName,
          workflowSource: command.workflowSource,
          cwd: command.cwd,
          recordedAt: this.#now().toISOString(),
        }),
      );
      if (recorded.type !== "submit") {
        throw new SupervisorServiceError(
          "conflict",
          `command "${command.commandId}" was already used for another command type`,
        );
      }
      journal = recorded;
    } catch (error) {
      if (
        error instanceof SupervisorServiceError ||
        (error instanceof LocalSupervisorStoreError && error.code === "identity_mismatch")
      ) {
        throw new SupervisorServiceError(
          "conflict",
          error.message,
          error instanceof SupervisorServiceError ? undefined : { cause: error },
        );
      }
      throw error;
    }

    if (journal.status === "completed") {
      return acceptedResultFromJournal(journal);
    }
    if (journal.status === "rejected") {
      throw new SupervisorServiceError("conflict", journal.failure);
    }
    if (journal.status === "uncertain") {
      const reconciled = await this.#tryAcceptedSubmission(command, journal);
      if (reconciled === null) {
        throw new SupervisorServiceError(
          "command_uncertain",
          `submission command "${command.commandId}" has an uncertain prior launch`,
        );
      }
      await this.#completeSubmissionJournal(journal, reconciled);
      return reconciled;
    }

    const existing = await this.#readExistingJob(command.commandId);
    let job: JobRecord;
    if (existing !== null) {
      if (!sameSubmission(existing, command)) {
        const message = `command "${command.commandId}" was already used for different execution input`;
        await this.#rejectSubmissionJournal(journal, message);
        throw new SupervisorServiceError("conflict", message);
      }

      const reconciled = await this.#tryAcceptedJob(existing);
      if (reconciled !== null) {
        await this.#completeSubmissionJournal(journal, reconciled);
        return reconciled;
      }

      const claim = await this.#store.readActiveRunClaim(existing.runId);
      if (claim !== null) {
        if (claim.jobId !== existing.jobId || claim.workerId !== existing.workerId) {
          const message = `run "${existing.runId}" already has an active job`;
          await this.#rejectSubmissionJournal(journal, message);
          throw new SupervisorServiceError("conflict", message);
        }
        await this.#markSubmissionUncertain(
          journal,
          `job "${existing.jobId}" is claimed without an authenticated worker result`,
        );
        throw new SupervisorServiceError(
          "command_uncertain",
          `job "${existing.jobId}" exists without an authenticated worker result`,
        );
      }
      await this.#markSubmissionUncertain(
        journal,
        `job "${existing.jobId}" exists without a claim or authenticated worker result`,
      );
      throw new SupervisorServiceError(
        "command_uncertain",
        `job "${existing.jobId}" has an ambiguous prior reservation outcome`,
      );
    } else {
      const createdAt = this.#now().toISOString();
      job = createJobRecord({
        jobId: command.commandId,
        workerId: randomUUID(),
        runId: command.runId,
        mode: command.mode,
        sourceName: command.sourceName,
        workflowSource: command.workflowSource,
        cwd: command.cwd,
        token: randomBytes(32).toString("hex"),
        createdAt,
      });
    }

    try {
      await this.#store.reserveSubmission(
        job,
        createActiveRunClaim({
          runId: job.runId,
          jobId: job.jobId,
          workerId: job.workerId,
          claimedAt: job.createdAt,
        }),
      );
    } catch (error) {
      if (
        error instanceof LocalSupervisorStoreError &&
        (error.code === "run_claimed" ||
          error.code === "job_exists" ||
          error.code === "identity_mismatch")
      ) {
        await this.#rejectSubmissionJournal(journal, error.message);
        throw new SupervisorServiceError("conflict", error.message, { cause: error });
      }
      await this.#markSubmissionUncertain(
        journal,
        error instanceof Error ? error.message : String(error),
      );
      throw new SupervisorServiceError(
        "command_uncertain",
        `reservation for run "${job.runId}" has an uncertain outcome`,
        { cause: error },
      );
    }

    let descriptor: WorkerDescriptor;
    try {
      descriptor = await this.#launcher.launch(job);
      assertWorkerMatchesJob(descriptor, job);
      await this.#verifyWorkerIdentity(descriptor);
    } catch (error) {
      await this.#markSubmissionUncertain(
        journal,
        error instanceof Error ? error.message : String(error),
      );
      throw new SupervisorServiceError(
        "command_uncertain",
        `worker launch for run "${job.runId}" did not reach authenticated readiness`,
        { cause: error },
      );
    }
    const result = acceptedResult(job, this.#now().toISOString());
    await this.#completeSubmissionJournal(journal, result);
    return result;
  }

  async status(): Promise<Extract<SupervisorResult, { readonly type: "status" }>> {
    const claims = await this.#store.listActiveRunClaims();
    const descriptors = new Map(
      (await this.#store.listWorkerDescriptors()).map((descriptor) => [
        descriptor.workerId,
        descriptor,
      ]),
    );
    const workers: WorkerSummary[] = [];
    for (const claim of claims) {
      const descriptor = descriptors.get(claim.workerId);
      if (
        descriptor === undefined ||
        descriptor.jobId !== claim.jobId ||
        descriptor.runId !== claim.runId
      ) {
        workers.push({
          workerId: claim.workerId,
          runId: claim.runId,
          pid: null,
          status: "uncertain",
          runStatus: null,
        });
        continue;
      }
      workers.push(await this.#summarizeWorker(descriptor));
    }
    return {
      type: "status",
      generation: this.#generation as ReturnType<typeof randomUUID>,
      pid: this.#pid,
      startedAt: this.#startedAt,
      workers,
    };
  }

  async cancel(command: CancelCommand): Promise<CancelledResult> {
    let journal: CancellationCommandRecord;
    try {
      const recorded = await this.#store.recordCommand(
        createCancellationCommandRecord({
          commandId: command.commandId,
          runId: command.runId,
          actor: command.actor,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
          recordedAt: this.#now().toISOString(),
        }),
      );
      if (recorded.type !== "cancel") {
        throw new SupervisorServiceError(
          "conflict",
          `command "${command.commandId}" was already used for another command type`,
        );
      }
      journal = recorded;
    } catch (error) {
      if (
        error instanceof SupervisorServiceError ||
        (error instanceof LocalSupervisorStoreError && error.code === "identity_mismatch")
      ) {
        throw new SupervisorServiceError(
          "conflict",
          error.message,
          error instanceof SupervisorServiceError ? undefined : { cause: error },
        );
      }
      throw error;
    }
    if (journal.status === "completed") {
      return cancellationResultFromJournal(journal);
    }
    if (journal.status === "uncertain") {
      const reconciled = await this.#tryCompletedCancellation(command);
      if (reconciled === null) {
        throw new SupervisorServiceError(
          "command_uncertain",
          `cancellation command "${command.commandId}" has an uncertain prior dispatch`,
        );
      }
      await this.#completeCancellationJournal(journal, reconciled);
      return reconciled;
    }

    const claim = await this.#store.readActiveRunClaim(command.runId);
    if (claim === null) {
      const completed = await this.#completedCancellation(command);
      await this.#completeCancellationJournal(journal, completed);
      return completed;
    }

    let descriptor: WorkerDescriptor;
    try {
      descriptor = await this.#store.readWorkerDescriptor(claim.workerId);
    } catch (error) {
      const reconciled = await this.#tryCompletedCancellation(command);
      if (reconciled !== null) {
        await this.#completeCancellationJournal(journal, reconciled);
        return reconciled;
      }
      await this.#markCancellationUncertain(
        journal,
        error instanceof Error ? error.message : String(error),
      );
      throw new SupervisorServiceError(
        "command_uncertain",
        `active run "${command.runId}" has no controllable worker descriptor`,
        { cause: error },
      );
    }
    if (descriptor.jobId !== claim.jobId || descriptor.runId !== claim.runId) {
      throw new SupervisorServiceError(
        "identity_mismatch",
        `active claim for run "${command.runId}" does not match worker identity`,
      );
    }

    let response: WorkerResponse;
    try {
      response = await this.#launcher.request(descriptor, {
        type: "cancel",
        commandId: command.commandId,
        actor: command.actor,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      });
    } catch (error) {
      await this.#markCancellationUncertain(
        journal,
        error instanceof Error ? error.message : String(error),
      );
      throw new SupervisorServiceError(
        "command_uncertain",
        `worker for run "${command.runId}" may have received cancellation but did not acknowledge it`,
        { cause: error },
      );
    }
    if (
      !response.ok ||
      response.result.type !== "cancelled" ||
      response.result.commandId !== command.commandId ||
      response.result.runId !== command.runId
    ) {
      await this.#markCancellationUncertain(
        journal,
        `worker for run "${command.runId}" returned an invalid cancellation result`,
      );
      throw new SupervisorServiceError(
        "command_uncertain",
        `worker for run "${command.runId}" returned an invalid cancellation result`,
      );
    }
    await this.#completeCancellationJournal(journal, response.result);
    return response.result;
  }

  async events(command: EventsCommand): Promise<EventsResult> {
    let events: readonly RunEvent[];
    try {
      events = await new JsonlRunStore(this.#store.runsDirectory).read(command.runId);
    } catch (error) {
      if (error instanceof RunStoreError && error.code === "not_found") {
        throw new SupervisorServiceError("not_found", error.message, { cause: error });
      }
      throw error;
    }
    const state = reduceRunEvents(events);
    if (command.afterSequence > state.lastSequence) {
      throw new SupervisorServiceError(
        "conflict",
        `event cursor ${command.afterSequence} is beyond last sequence ${state.lastSequence}`,
      );
    }
    const page = events
      .filter((event) => event.sequence > command.afterSequence)
      .slice(0, command.limit);
    const cursor = page.at(-1)?.sequence ?? command.afterSequence;
    return {
      type: "events",
      runId: command.runId,
      afterSequence: command.afterSequence,
      cursor,
      events: Object.freeze([...page]),
      terminal: cursor === state.lastSequence && isTerminal(state.status),
    };
  }

  async #readExistingJob(jobId: string): Promise<JobRecord | null> {
    try {
      return await this.#store.readJob(jobId);
    } catch (error) {
      if (error instanceof LocalSupervisorStoreError && error.code === "not_found") {
        return null;
      }
      throw error;
    }
  }

  async #tryAcceptedSubmission(
    command: SubmitCommand,
    journal: SubmissionCommandRecord,
  ): Promise<AcceptedResult | null> {
    const job = await this.#readExistingJob(command.commandId);
    if (job === null) {
      return null;
    }
    if (!sameSubmission(job, command) || !journalMatchesJob(journal, job)) {
      throw new SupervisorServiceError(
        "identity_mismatch",
        `submission command "${command.commandId}" does not match its durable job`,
      );
    }
    return await this.#tryAcceptedJob(job);
  }

  async #tryAcceptedJob(job: JobRecord): Promise<AcceptedResult | null> {
    let descriptor: WorkerDescriptor;
    try {
      descriptor = await this.#store.readWorkerDescriptor(job.workerId);
    } catch (error) {
      if (error instanceof LocalSupervisorStoreError && error.code === "not_found") {
        return null;
      }
      throw error;
    }
    assertWorkerMatchesJob(descriptor, job);
    if (descriptor.status !== "terminal" && descriptor.status !== "failed") {
      await this.#verifyWorkerIdentity(descriptor);
    }
    return acceptedResult(job, this.#now().toISOString());
  }

  async #completeSubmissionJournal(
    journal: SubmissionCommandRecord,
    result: AcceptedResult,
  ): Promise<void> {
    try {
      await this.#store.updateCommand(
        completeSubmissionCommand(
          journal,
          { workerId: result.workerId, acceptedAt: result.acceptedAt },
          this.#now().toISOString(),
        ),
      );
    } catch (error) {
      if (journal.status === "recorded") {
        await this.#tryMarkSubmissionUncertain(
          journal,
          `accepted worker could not be committed to the command journal: ${errorMessage(error)}`,
        );
      }
      throw new SupervisorServiceError(
        "command_uncertain",
        `submission command "${journal.commandId}" reached a worker but its acceptance journal is uncertain`,
        { cause: error },
      );
    }
  }

  async #rejectSubmissionJournal(journal: SubmissionCommandRecord, failure: string): Promise<void> {
    try {
      await this.#store.updateCommand(
        rejectSubmissionCommand(journal, boundedMessage(failure), this.#now().toISOString()),
      );
    } catch (error) {
      throw new SupervisorServiceError(
        "command_uncertain",
        `submission command "${journal.commandId}" could not durably record its rejection`,
        { cause: error },
      );
    }
  }

  async #markSubmissionUncertain(journal: SubmissionCommandRecord, failure: string): Promise<void> {
    try {
      await this.#store.updateCommand(
        markSubmissionCommandUncertain(journal, boundedMessage(failure), this.#now().toISOString()),
      );
    } catch (error) {
      throw new SupervisorServiceError(
        "command_uncertain",
        `submission command "${journal.commandId}" could not durably record uncertainty`,
        { cause: error },
      );
    }
  }

  async #tryMarkSubmissionUncertain(
    journal: SubmissionCommandRecord,
    failure: string,
  ): Promise<void> {
    try {
      await this.#markSubmissionUncertain(journal, failure);
    } catch {
      // A retry re-reads whichever atomic command state won; no worker is launched here.
    }
  }

  async #completedCancellation(command: CancelCommand): Promise<CancelledResult> {
    let events: readonly RunEvent[];
    try {
      events = await new JsonlRunStore(this.#store.runsDirectory).read(command.runId);
    } catch (error) {
      if (error instanceof RunStoreError && error.code === "not_found") {
        throw new SupervisorServiceError("not_found", error.message, { cause: error });
      }
      throw error;
    }
    const state = reduceRunEvents(events);
    const terminal = events.at(-1);
    if (
      state.status !== "cancelled" ||
      terminal?.type !== "run_cancelled" ||
      terminal.requestId !== command.commandId ||
      terminal.actor !== command.actor ||
      terminal.reason !== (command.reason ?? `run cancelled by ${command.actor}`)
    ) {
      throw new SupervisorServiceError(
        "conflict",
        `run "${command.runId}" is not the result of cancellation command "${command.commandId}"`,
      );
    }
    return {
      type: "cancelled",
      commandId: command.commandId,
      runId: command.runId,
      runStatus: "cancelled",
      lastSequence: state.lastSequence,
    };
  }

  async #tryCompletedCancellation(command: CancelCommand): Promise<CancelledResult | null> {
    try {
      return await this.#completedCancellation(command);
    } catch (error) {
      if (
        error instanceof SupervisorServiceError &&
        (error.code === "not_found" || error.code === "conflict")
      ) {
        return null;
      }
      throw error;
    }
  }

  async #completeCancellationJournal(
    journal: CancellationCommandRecord,
    result: CancelledResult,
  ): Promise<void> {
    await this.#store.updateCommand(
      completeCancellationCommand(
        journal,
        { runStatus: "cancelled", lastSequence: result.lastSequence },
        this.#now().toISOString(),
      ),
    );
  }

  async #markCancellationUncertain(
    journal: CancellationCommandRecord,
    failure: string,
  ): Promise<void> {
    await this.#store.updateCommand(
      markCancellationCommandUncertain(journal, boundedMessage(failure), this.#now().toISOString()),
    );
  }

  async #verifyWorkerIdentity(descriptor: WorkerDescriptor): Promise<void> {
    const response = await this.#launcher.request(descriptor, { type: "identify" });
    if (
      !response.ok ||
      response.result.type !== "identity" ||
      response.result.workerId !== descriptor.workerId ||
      response.result.runId !== descriptor.runId ||
      response.result.pid !== descriptor.pid ||
      response.result.jobDigest !== descriptor.jobDigest
    ) {
      throw new SupervisorServiceError(
        "identity_mismatch",
        `worker "${descriptor.workerId}" failed identity verification`,
      );
    }
  }

  async #summarizeWorker(descriptor: WorkerDescriptor): Promise<WorkerSummary> {
    try {
      await this.#verifyWorkerIdentity(descriptor);
      return {
        workerId: descriptor.workerId,
        runId: descriptor.runId,
        pid: descriptor.pid,
        status: summaryStatus(descriptor),
        runStatus: descriptor.runStatus ?? "running",
      };
    } catch (error) {
      return {
        workerId: descriptor.workerId,
        runId: descriptor.runId,
        pid: descriptor.pid,
        status:
          error instanceof SupervisorServiceError && error.code === "identity_mismatch"
            ? "uncertain"
            : "unreachable",
        runStatus: descriptor.runStatus ?? null,
      };
    }
  }
}

function acceptedResult(job: JobRecord, acceptedAt: string): AcceptedResult {
  return {
    type: "accepted",
    commandId: job.jobId as ReturnType<typeof randomUUID>,
    runId: job.runId,
    workerId: job.workerId as ReturnType<typeof randomUUID>,
    acceptedAt,
  };
}

function acceptedResultFromJournal(
  journal: Extract<SubmissionCommandRecord, { readonly status: "completed" }>,
): AcceptedResult {
  return {
    type: "accepted",
    commandId: journal.commandId as ReturnType<typeof randomUUID>,
    runId: journal.runId,
    workerId: journal.result.workerId as ReturnType<typeof randomUUID>,
    acceptedAt: journal.result.acceptedAt,
  };
}

function journalMatchesJob(journal: SubmissionCommandRecord, job: JobRecord): boolean {
  return (
    journal.commandId === job.jobId &&
    journal.runId === job.runId &&
    journal.mode === job.mode &&
    journal.sourceName === job.sourceName &&
    journal.workflowSourceDigest ===
      createHash("sha256").update(job.workflowSource).digest("hex") &&
    journal.cwd === job.cwd
  );
}

function sameSubmission(job: JobRecord, command: SubmitCommand): boolean {
  return (
    job.jobId === command.commandId &&
    job.runId === command.runId &&
    job.mode === command.mode &&
    job.sourceName === command.sourceName &&
    job.workflowSource === command.workflowSource &&
    job.cwd === command.cwd
  );
}

function sameSubmitCommand(left: SubmitCommand, right: SubmitCommand): boolean {
  return (
    left.commandId === right.commandId &&
    left.runId === right.runId &&
    left.mode === right.mode &&
    left.sourceName === right.sourceName &&
    left.workflowSource === right.workflowSource &&
    left.cwd === right.cwd
  );
}

function assertWorkerMatchesJob(descriptor: WorkerDescriptor, job: JobRecord): void {
  if (
    descriptor.workerId !== job.workerId ||
    descriptor.jobId !== job.jobId ||
    descriptor.runId !== job.runId ||
    descriptor.token !== job.token ||
    descriptor.jobDigest !== job.digest
  ) {
    throw new SupervisorServiceError(
      "identity_mismatch",
      `worker "${descriptor.workerId}" does not match job "${job.jobId}"`,
    );
  }
}

function summaryStatus(descriptor: WorkerDescriptor): WorkerSummary["status"] {
  if (descriptor.status === "starting") {
    return "starting";
  }
  if (descriptor.status === "failed") {
    return "uncertain";
  }
  if (descriptor.status === "terminal") {
    return descriptor.runStatus === "waiting_for_approval" ? "waiting" : "terminal";
  }
  return "running";
}

function isTerminal(status: RunStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "resource_exhausted"
  );
}

function cancellationResultFromJournal(
  journal: Extract<CancellationCommandRecord, { readonly status: "completed" }>,
): CancelledResult {
  return {
    type: "cancelled",
    commandId: journal.commandId as ReturnType<typeof randomUUID>,
    runId: journal.runId,
    runStatus: "cancelled",
    lastSequence: journal.result.lastSequence,
  };
}

function boundedMessage(message: string): string {
  return message.length <= 16_384 ? message : `${message.slice(0, 16_350)}… [truncated]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
