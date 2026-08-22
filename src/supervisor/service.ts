import { createHash, randomBytes, randomUUID } from "node:crypto";

import { compileWorkflowFromSnapshot } from "../application/workflow-package-admission.js";
import type { PolicyPackageSnapshot } from "../domain/capability/policy-packages.js";
import { bindWorkflowCapabilities } from "../domain/capability/workflow-capabilities.js";
import type { FlowSandboxProfile } from "../domain/config/resolver.js";
import { assertWorkflowSatisfiesPolicyPackages } from "../domain/policy/policy-package-admission.js";
import { composePolicyPackages } from "../domain/policy/policy-package-composition.js";
import { type RunEvent, type RunStatus, reduceRunEvents } from "../domain/run/events.js";
import type { JsonlAdmissionStore } from "../infrastructure/fs/jsonl-admission-store.js";
import { JsonlRunStore, RunStoreError } from "../infrastructure/fs/jsonl-run-store.js";
import {
  type LocalSupervisorStore,
  LocalSupervisorStoreError,
} from "../infrastructure/fs/local-supervisor-store.js";
import {
  type AdmissionJobIdentity,
  type AdmissionJobState,
  AdmissionStateError,
  classifyNewAdmission,
  createDispatchReservedEvent,
  createJobEnqueuedEvent,
  createJobRejectedEvent,
  createJobRejectionCommittedEvent,
  createJobReleasedEvent,
  createJobUncertainEvent,
  createQueueCancellationCompletedEvent,
  createQueueCancellationRecordedEvent,
  createWorkerAcceptedEvent,
} from "./admission.js";
import type {
  AcceptedResult,
  CancelCommand,
  CancelledResult,
  EventsCommand,
  EventsResult,
  SubmissionResult,
  SubmitCommand,
  SupervisorResult,
  WorkerRequest,
  WorkerResponse,
  WorkerSummary,
} from "./protocol.js";
import {
  type ActiveRunClaim,
  type CancellationCommandRecord,
  completeCancellationCommand,
  completeSubmissionCommand,
  createActiveRunClaim,
  createCancellationCommandRecord,
  createJobRecord,
  createSubmissionCommandRecord,
  type JobRecord,
  markCancellationCommandUncertain,
  markSubmissionCommandUncertain,
  type QueuedSubmissionCommand,
  queueSubmissionCommand,
  rejectSubmissionCommand,
  type SubmissionCommandRecord,
  type WorkerDescriptor,
} from "./records.js";

export type SupervisorServiceErrorCode =
  | "command_uncertain"
  | "conflict"
  | "identity_mismatch"
  | "not_found"
  | "policy_mismatch"
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
  readonly admissionStore: JsonlAdmissionStore;
  readonly launcher: WorkerLauncher;
  readonly generation: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly sandboxProfile: FlowSandboxProfile;
  readonly policyPackageDigest?: string;
  readonly now?: () => Date;
}

export class LocalSupervisorService {
  readonly #store: LocalSupervisorStore;
  readonly #admissionStore: JsonlAdmissionStore;
  readonly #launcher: WorkerLauncher;
  readonly #generation: string;
  readonly #pid: number;
  readonly #startedAt: string;
  readonly #sandboxProfile: FlowSandboxProfile;
  readonly #policyPackageDigest: string | undefined;
  readonly #now: () => Date;
  readonly #submissions = new Map<
    string,
    { readonly command: SubmitCommand; readonly result: Promise<SubmissionResult> }
  >();
  readonly #launches = new Map<string, Promise<AcceptedResult>>();
  #admissionTail: Promise<void> = Promise.resolve();
  #acceptingSubmissions = true;

  constructor(options: LocalSupervisorServiceOptions) {
    this.#store = options.store;
    this.#admissionStore = options.admissionStore;
    this.#launcher = options.launcher;
    this.#generation = options.generation;
    this.#pid = options.pid;
    this.#startedAt = options.startedAt;
    this.#sandboxProfile = options.sandboxProfile;
    this.#policyPackageDigest = options.policyPackageDigest;
    this.#now = options.now ?? (() => new Date());
  }

  async submit(command: SubmitCommand): Promise<SubmissionResult> {
    this.assertPolicy(command.policyDigest);
    this.#assertAcceptingSubmissions();
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

  async #submitOnce(command: SubmitCommand): Promise<SubmissionResult> {
    // Compilation must precede every durable reservation and worker launch.
    const workflow = compileWorkflowFromSnapshot({
      source: command.workflowSource,
      sourceName: command.sourceName,
      ...(command.capabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: command.capabilitySnapshot }),
    });
    const capabilitySnapshot = bindWorkflowCapabilities(workflow, command.capabilitySnapshot);
    assertWorkflowSatisfiesPolicyPackages(workflow, capabilitySnapshot);
    const effectivePolicyPackages = composePolicyPackages(
      (capabilitySnapshot?.packages ?? []).filter(
        (item): item is PolicyPackageSnapshot => item.kind === "policy-package",
      ),
    );
    if (effectivePolicyPackages?.digest !== this.#policyPackageDigest) {
      throw new SupervisorServiceError(
        "policy_mismatch",
        "submitted capability snapshot does not reconstruct the supervisor policy",
      );
    }

    let journal: SubmissionCommandRecord;
    try {
      const recorded = await this.#store.recordCommand(
        createSubmissionCommandRecord({
          commandId: command.commandId,
          policyDigest: command.policyDigest,
          runId: command.runId,
          mode: command.mode,
          sourceName: command.sourceName,
          workflowSource: command.workflowSource,
          ...(command.workProfile === undefined ? {} : { workProfile: command.workProfile }),
          ...(command.capabilitySnapshot === undefined
            ? {}
            : { capabilitySnapshot: command.capabilitySnapshot }),
          cwd: command.cwd,
          ...(command.projectRoot === undefined ? {} : { projectRoot: command.projectRoot }),
          ...(command.protectedPaths === undefined
            ? {}
            : { protectedPaths: command.protectedPaths }),
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
      if (journal.reason === "conflict") {
        throw new SupervisorServiceError("conflict", journal.failure);
      }
      return rejectedResultFromJournal(journal);
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
      job = existing;
      if ((existing.sandboxProfile ?? "native") !== this.#sandboxProfile) {
        const message = `command "${command.commandId}" was admitted under a different sandbox profile`;
        await this.#rejectSubmissionJournal(journal, message);
        throw new SupervisorServiceError("conflict", message);
      }
      if (!sameSubmission(existing, command)) {
        const message = `command "${command.commandId}" was already used for different execution input`;
        await this.#rejectSubmissionJournal(journal, message);
        throw new SupervisorServiceError("conflict", message);
      }

      const admission = this.#admissionStore.state.jobs[existing.jobId];
      if (admission?.status === "queued") {
        if (journal.status === "recorded") {
          journal = await this.#queueSubmissionJournal(
            journal,
            admission.queueSequence,
            admission.queuedAt,
          );
        }
        return queuedResultFromJournal(journal);
      }
      const reconciled = await this.#tryAcceptedJob(existing);
      if (reconciled !== null) {
        await this.#recordWorkerAccepted(existing);
        await this.#completeSubmissionJournal(journal, reconciled);
        return reconciled;
      }

      if (admission?.status === "dispatching") {
        return await this.#launchJobOnce(existing, journal);
      }
      if (admission?.status === "accepted" || admission?.status === "uncertain") {
        await this.#markSubmissionUncertain(
          journal,
          `job "${existing.jobId}" has admission state "${admission.status}" without an authenticated worker`,
        );
        throw new SupervisorServiceError(
          "command_uncertain",
          `job "${existing.jobId}" has no authenticated worker result`,
        );
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
    } else {
      const createdAt = this.#now().toISOString();
      job = createJobRecord({
        jobId: command.commandId,
        workerId: randomUUID(),
        runId: command.runId,
        mode: command.mode,
        sourceName: command.sourceName,
        workflowSource: command.workflowSource,
        ...(command.workProfile === undefined ? {} : { workProfile: command.workProfile }),
        sandboxProfile: this.#sandboxProfile,
        ...(command.capabilitySnapshot === undefined
          ? {}
          : { capabilitySnapshot: command.capabilitySnapshot }),
        cwd: command.cwd,
        ...(command.projectRoot === undefined ? {} : { projectRoot: command.projectRoot }),
        ...(command.protectedPaths === undefined ? {} : { protectedPaths: command.protectedPaths }),
        token: randomBytes(32).toString("hex"),
        createdAt,
      });
    }

    return await this.#admitJob(job, journal);
  }

  async #admitJob(job: JobRecord, journal: SubmissionCommandRecord): Promise<SubmissionResult> {
    let outcome:
      | {
          readonly decision: "dispatch" | "reject";
          readonly decidedAt: string;
          readonly journal: SubmissionCommandRecord;
        }
      | {
          readonly decision: "queue";
          readonly decidedAt: string;
          readonly queuePosition: number;
          readonly journal: SubmissionCommandRecord;
        }
      | { readonly decision: "replay"; readonly result: SubmissionResult };
    try {
      outcome = await this.#serializeAdmission(async () => {
        this.#assertAcceptingSubmissions();
        const identity = admissionIdentity(job);
        const state = this.#admissionStore.state;
        const current = await this.#store.readCommand(job.jobId);
        if (current.type !== "submit" || !journalMatchesJob(current, job)) {
          throw new SupervisorServiceError(
            "identity_mismatch",
            `job "${job.jobId}" does not match its durable submission command`,
          );
        }
        const rejection = state.rejections[job.jobId];
        if (
          rejection !== undefined &&
          (rejection.runId !== current.runId || rejection.requestDigest !== current.requestDigest)
        ) {
          throw new SupervisorServiceError(
            "identity_mismatch",
            `job "${job.jobId}" does not match its durable admission rejection`,
          );
        }
        if (rejection !== undefined) {
          if (current.status === "recorded") {
            return {
              decision: "reject",
              decidedAt: rejection.rejectedAt,
              journal: current,
            };
          }
          if (current.status === "rejected" && current.reason === rejection.reason) {
            await this.#admissionStore.append(
              createJobRejectionCommittedEvent(
                state,
                rejection.jobId,
                rejection.requestDigest,
                this.#now().toISOString(),
              ),
            );
            return { decision: "replay", result: rejectedResultFromJournal(current) };
          }
          throw new SupervisorServiceError(
            "command_uncertain",
            `submission command "${current.commandId}" conflicts with an uncommitted rejection`,
          );
        }
        if (current.status === "completed") {
          return { decision: "replay", result: acceptedResultFromJournal(current) };
        }
        if (current.status === "rejected") {
          if (current.reason === "conflict") {
            throw new SupervisorServiceError("conflict", current.failure);
          }
          return { decision: "replay", result: rejectedResultFromJournal(current) };
        }
        if (current.status === "uncertain") {
          throw new SupervisorServiceError(
            "command_uncertain",
            `submission command "${current.commandId}" has an uncertain prior admission`,
          );
        }
        if (current.status === "queued") {
          const admission = state.jobs[job.jobId];
          if (admission?.status === "queued") {
            return { decision: "replay", result: queuedResultFromJournal(current) };
          }
          throw new SupervisorServiceError(
            "command_uncertain",
            `queued submission command "${current.commandId}" has no stable queue admission`,
          );
        }
        if (state.jobs[job.jobId]?.status === "queue_cancelling") {
          throw new SupervisorServiceError(
            "command_uncertain",
            `queued submission command "${current.commandId}" is being cancelled`,
          );
        }
        const decision = classifyNewAdmission(state);
        const decidedAt = this.#now().toISOString();
        if (decision === "dispatch") {
          const event = createDispatchReservedEvent(state, identity, decidedAt);
          await this.#store.reserveJob(job);
          await this.#admissionStore.append(event);
          return { decision, decidedAt, journal: current };
        }
        if (decision === "queue") {
          const event = createJobEnqueuedEvent(state, identity, decidedAt);
          await this.#store.reserveJob(job);
          await this.#admissionStore.append(event);
          return { decision, decidedAt, queuePosition: event.queueSequence, journal: current };
        }
        await this.#admissionStore.append(
          createJobRejectedEvent(
            state,
            {
              jobId: job.jobId,
              runId: job.runId,
              requestDigest: current.requestDigest,
            },
            "queue_full",
            decidedAt,
          ),
        );
        return { decision, decidedAt, journal: current };
      });
    } catch (error) {
      if (error instanceof SupervisorServiceError) {
        throw error;
      }
      if (
        (error instanceof AdmissionStateError &&
          (error.code === "invalid_transition" || error.code === "capacity_exceeded")) ||
        (error instanceof LocalSupervisorStoreError &&
          (error.code === "job_exists" || error.code === "identity_mismatch"))
      ) {
        await this.#rejectSubmissionJournal(journal, error.message);
        throw new SupervisorServiceError("conflict", error.message, { cause: error });
      }
      throw new SupervisorServiceError(
        "command_uncertain",
        `admission for run "${job.runId}" has an uncertain outcome`,
        { cause: error },
      );
    }

    if (outcome.decision === "replay") {
      return outcome.result;
    }
    if (outcome.decision === "queue") {
      const queuedJournal = await this.#queueSubmissionJournal(
        outcome.journal,
        outcome.queuePosition,
        outcome.decidedAt,
      );
      return queuedResultFromJournal(queuedJournal);
    }
    if (outcome.decision === "reject") {
      const rejected = rejectSubmissionCommand(
        outcome.journal,
        "admission queue is full",
        outcome.decidedAt,
        "queue_full",
      );
      await this.#store.updateCommand(rejected);
      await this.#serializeAdmission(async () => {
        const rejection = this.#admissionStore.state.rejections[job.jobId];
        if (rejection === undefined) {
          return;
        }
        if (rejection.requestDigest !== rejected.requestDigest) {
          throw new SupervisorServiceError(
            "identity_mismatch",
            `job "${job.jobId}" does not match its durable admission rejection`,
          );
        }
        await this.#admissionStore.append(
          createJobRejectionCommittedEvent(
            this.#admissionStore.state,
            rejection.jobId,
            rejection.requestDigest,
            this.#now().toISOString(),
          ),
        );
      });
      return rejectedResultFromJournal(rejected);
    }
    return await this.#launchJobOnce(job, outcome.journal);
  }

  async reconcile(): Promise<void> {
    const actions = await this.#serializeAdmission(async () => {
      let state = this.#admissionStore.state;
      for (const rejection of Object.values(state.rejections)) {
        const command = await this.#store.readCommand(rejection.jobId);
        if (
          command.type !== "submit" ||
          command.runId !== rejection.runId ||
          command.requestDigest !== rejection.requestDigest
        ) {
          throw new SupervisorServiceError(
            "identity_mismatch",
            `job "${rejection.jobId}" does not match its durable admission rejection`,
          );
        }
        if (command.status === "recorded") {
          continue;
        }
        if (command.status !== "rejected" || command.reason !== rejection.reason) {
          throw new SupervisorServiceError(
            "command_uncertain",
            `submission command "${command.commandId}" conflicts with an uncommitted rejection`,
          );
        }
        state = await this.#admissionStore.append(
          createJobRejectionCommittedEvent(
            state,
            rejection.jobId,
            rejection.requestDigest,
            this.#now().toISOString(),
          ),
        );
      }
      const claims = await this.#store.listActiveRunClaims();
      const workerIds = new Set([
        ...claims.map((claim) => claim.workerId),
        ...Object.values(state.jobs)
          .filter((job) => isActiveAdmission(job))
          .map((job) => job.workerId),
      ]);
      const descriptors = new Map<string, WorkerDescriptor>();
      for (const workerId of workerIds) {
        const descriptor = await this.#readWorkerDescriptorOptional(workerId);
        if (descriptor !== null) {
          descriptors.set(workerId, descriptor);
        }
      }
      const legacyClaims: ActiveRunClaim[] = [];
      for (const claim of claims) {
        if (state.jobs[claim.jobId] !== undefined) {
          continue;
        }
        const descriptor = descriptors.get(claim.workerId);
        if (descriptor?.status === "terminal" || descriptor?.status === "failed") {
          await this.#store.releaseActiveRunClaim(claim.runId, claim.jobId);
          continue;
        }
        legacyClaims.push(claim);
      }
      if (legacyClaims.length > state.limits.maxActiveWorkers - state.activeCount) {
        throw new SupervisorServiceError(
          "conflict",
          `${legacyClaims.length} legacy active claims cannot fit within the configured active-worker limit`,
        );
      }
      for (const claim of legacyClaims) {
        const job = await this.#store.readJob(claim.jobId);
        assertClaimMatchesJob(claim, job);
        state = await this.#admissionStore.append(
          createDispatchReservedEvent(state, admissionIdentity(job), this.#now().toISOString()),
        );
      }

      const actionsByJob = new Map<
        string,
        | { readonly kind: "adopt"; readonly job: JobRecord; readonly descriptor: WorkerDescriptor }
        | { readonly kind: "launch"; readonly job: JobRecord }
      >();
      for (const admission of Object.values(state.jobs)) {
        if (
          admission.status !== "dispatching" &&
          admission.status !== "accepted" &&
          admission.status !== "uncertain"
        ) {
          continue;
        }
        const descriptor = descriptors.get(admission.workerId);
        if (descriptor === undefined) {
          if (admission.status === "dispatching") {
            const job = await this.#store.readJob(admission.jobId);
            assertAdmissionMatchesJob(admission, job);
            actionsByJob.set(job.jobId, { kind: "launch", job });
          }
          continue;
        }
        if (descriptor.status !== "terminal" && descriptor.status !== "failed") {
          if (admission.status === "dispatching") {
            const job = await this.#store.readJob(admission.jobId);
            assertAdmissionMatchesJob(admission, job);
            assertWorkerMatchesJob(descriptor, job);
            actionsByJob.set(job.jobId, { kind: "adopt", job, descriptor });
          }
          continue;
        }
        assertAdmissionMatchesDescriptor(admission, descriptor);
        const runStatus = descriptor.status === "failed" ? "failed" : descriptor.runStatus;
        if (runStatus === undefined) {
          throw new SupervisorServiceError(
            "identity_mismatch",
            `terminal worker "${descriptor.workerId}" has invalid run status`,
          );
        }
        await this.#store.releaseActiveRunClaim(admission.runId, admission.jobId);
        state = await this.#admissionStore.append(
          createJobReleasedEvent(state, admission.jobId, runStatus, this.#now().toISOString()),
        );
      }

      while (state.activeCount < state.limits.maxActiveWorkers) {
        const queued = Object.values(state.jobs)
          .filter((job) => job.status === "queued")
          .sort((left, right) => left.queueSequence - right.queueSequence)[0];
        if (queued === undefined) {
          break;
        }
        const job = await this.#store.readJob(queued.jobId);
        assertAdmissionMatchesJob(queued, job);
        state = await this.#admissionStore.append(
          createDispatchReservedEvent(state, queued, this.#now().toISOString()),
        );
        actionsByJob.set(job.jobId, { kind: "launch", job });
      }
      return [...actionsByJob.values()];
    });

    for (const action of actions) {
      try {
        const command = await this.#store.readCommand(action.job.jobId);
        if (command.type !== "submit") {
          throw new SupervisorServiceError(
            "identity_mismatch",
            `job "${action.job.jobId}" does not have a submission command`,
          );
        }
        if (action.kind === "launch") {
          await this.#launchJobOnce(action.job, command);
          continue;
        }
        try {
          await this.#verifyWorkerIdentity(action.descriptor);
        } catch (error) {
          if (error instanceof SupervisorServiceError) {
            throw error;
          }
          const failure = errorMessage(error);
          await this.#recordJobUncertain(action.job, failure);
          if (command.status !== "uncertain") {
            await this.#markSubmissionUncertain(command, failure);
          }
          continue;
        }
        await this.#recordWorkerAccepted(action.job);
        if (command.status !== "completed") {
          await this.#completeSubmissionJournal(
            command,
            acceptedResult(action.job, this.#now().toISOString()),
          );
        }
      } catch (error) {
        if (error instanceof SupervisorServiceError && error.code === "command_uncertain") {
          continue;
        }
        throw error;
      }
    }
  }

  #launchJobOnce(job: JobRecord, journal: SubmissionCommandRecord): Promise<AcceptedResult> {
    const existing = this.#launches.get(job.jobId);
    if (existing !== undefined) {
      return existing;
    }
    const launched = this.#launchReservedJob(job, journal);
    this.#launches.set(job.jobId, launched);
    void launched.then(
      () => this.#forgetLaunch(job.jobId, launched),
      () => this.#forgetLaunch(job.jobId, launched),
    );
    return launched;
  }

  #forgetLaunch(jobId: string, launched: Promise<AcceptedResult>): void {
    if (this.#launches.get(jobId) === launched) {
      this.#launches.delete(jobId);
    }
  }

  async #launchReservedJob(
    job: JobRecord,
    journal: SubmissionCommandRecord,
  ): Promise<AcceptedResult> {
    try {
      await this.#store.reserveActiveRunClaim(
        createActiveRunClaim({
          runId: job.runId,
          jobId: job.jobId,
          workerId: job.workerId,
          claimedAt: job.createdAt,
        }),
      );
    } catch (error) {
      await this.#recordJobUncertain(job, errorMessage(error));
      await this.#markSubmissionUncertain(journal, errorMessage(error));
      throw new SupervisorServiceError(
        "command_uncertain",
        `active claim for run "${job.runId}" has an uncertain outcome`,
        { cause: error },
      );
    }

    let descriptor: WorkerDescriptor;
    try {
      descriptor = await this.#launcher.launch(job);
      assertWorkerMatchesJob(descriptor, job);
      await this.#verifyWorkerIdentity(descriptor);
      await this.#recordWorkerAccepted(job);
    } catch (error) {
      const reconciled = await this.#tryAcceptedJob(job);
      if (reconciled !== null) {
        await this.#recordWorkerAccepted(job);
        await this.#completeSubmissionJournal(journal, reconciled);
        return reconciled;
      }
      await this.#recordJobUncertain(job, errorMessage(error));
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
    const workers = await Promise.all(
      claims.map(async (claim): Promise<WorkerSummary> => {
        const descriptor = await this.#readWorkerDescriptorOptional(claim.workerId);
        if (
          descriptor === null ||
          descriptor.jobId !== claim.jobId ||
          descriptor.runId !== claim.runId
        ) {
          return {
            workerId: claim.workerId,
            runId: claim.runId,
            pid: null,
            status: "uncertain",
            runStatus: null,
          };
        }
        return await this.#summarizeWorker(descriptor);
      }),
    );
    return {
      type: "status",
      generation: this.#generation as ReturnType<typeof randomUUID>,
      pid: this.#pid,
      startedAt: this.#startedAt,
      policyDigest: this.#admissionStore.state.policyDigest,
      limits: this.#admissionStore.state.limits,
      admission: {
        activeWorkers: this.#admissionStore.state.activeCount,
        queuedJobs: this.#admissionStore.state.queuedCount,
      },
      workers,
    };
  }

  async cancel(command: CancelCommand): Promise<CancelledResult> {
    this.assertPolicy(command.policyDigest);
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
      if (journal.result.phase === "queued") {
        await this.#finalizeQueuedCancellation(command);
      }
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

    const queuedCancellation = await this.#cancelQueued(command, journal);
    if (queuedCancellation !== null) {
      return queuedCancellation;
    }

    // Another exact retry may have completed a queued cancellation while this
    // caller waited for the admission lock. The durable command record, rather
    // than the now-absent queue entry, determines the converged result.
    const latestJournal = await this.#store.readCommand(command.commandId);
    if (latestJournal.type !== "cancel" || latestJournal.requestDigest !== journal.requestDigest) {
      throw new SupervisorServiceError(
        "conflict",
        `command "${command.commandId}" was replaced with a different identity`,
      );
    }
    journal = latestJournal;
    if (journal.status === "completed") {
      if (journal.result.phase === "queued") {
        await this.#finalizeQueuedCancellation(command);
      }
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
      const admission = Object.values(this.#admissionStore.state.jobs).find(
        (job) => job.runId === command.runId,
      );
      if (admission?.status === "dispatching") {
        throw new SupervisorServiceError(
          "worker_unavailable",
          `run "${command.runId}" has reserved capacity but its worker is not controllable yet; retry the same cancellation command`,
        );
      }
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

  async #cancelQueued(
    command: CancelCommand,
    journal: CancellationCommandRecord,
  ): Promise<CancelledResult | null> {
    return await this.#serializeAdmission(async () => {
      let state = this.#admissionStore.state;
      let admission = Object.values(state.jobs).find((job) => job.runId === command.runId);
      if (admission?.status === "queued") {
        state = await this.#admissionStore.append(
          createQueueCancellationRecordedEvent(state, admission.jobId, {
            commandId: command.commandId,
            actor: command.actor,
            ...(command.reason === undefined ? {} : { reason: command.reason }),
            at: this.#now().toISOString(),
          }),
        );
        admission = state.jobs[admission.jobId];
      }
      if (admission?.status !== "queue_cancelling") {
        return null;
      }
      assertQueuedCancellationMatches(admission, command);

      const submission = await this.#store.readCommand(admission.jobId);
      if (submission.type !== "submit") {
        throw new SupervisorServiceError(
          "identity_mismatch",
          `queued job "${admission.jobId}" has no submission command`,
        );
      }
      if (submission.status === "recorded" || submission.status === "queued") {
        await this.#store.updateCommand(
          rejectSubmissionCommand(
            submission,
            `queued run "${command.runId}" was cancelled by ${command.actor}`,
            this.#now().toISOString(),
            "cancelled",
          ),
        );
      } else if (submission.status !== "rejected" || submission.reason !== "cancelled") {
        throw new SupervisorServiceError(
          "identity_mismatch",
          `queued job "${admission.jobId}" has incompatible command state "${submission.status}"`,
        );
      }

      const result: CancelledResult = {
        type: "cancelled",
        commandId: command.commandId,
        runId: command.runId,
        runStatus: "cancelled",
        phase: "queued",
        lastSequence: null,
      };
      await this.#completeCancellationJournal(journal, result);
      await this.#admissionStore.append(
        createQueueCancellationCompletedEvent(
          this.#admissionStore.state,
          admission.jobId,
          command.commandId,
          this.#now().toISOString(),
        ),
      );
      return result;
    });
  }

  async #finalizeQueuedCancellation(command: CancelCommand): Promise<void> {
    await this.#serializeAdmission(async () => {
      const state = this.#admissionStore.state;
      const admission = Object.values(state.jobs).find((job) => job.runId === command.runId);
      if (admission?.status !== "queue_cancelling") {
        return;
      }
      assertQueuedCancellationMatches(admission, command);
      await this.#admissionStore.append(
        createQueueCancellationCompletedEvent(
          state,
          admission.jobId,
          command.commandId,
          this.#now().toISOString(),
        ),
      );
    });
  }

  async events(command: EventsCommand): Promise<EventsResult> {
    this.assertPolicy(command.policyDigest);
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

  async #readWorkerDescriptorOptional(workerId: string): Promise<WorkerDescriptor | null> {
    try {
      return await this.#store.readWorkerDescriptor(workerId);
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

  async #queueSubmissionJournal(
    journal: SubmissionCommandRecord,
    queuePosition: number,
    queuedAt: string,
  ): Promise<QueuedSubmissionCommand> {
    if (journal.status === "queued") {
      if (journal.result.queuePosition !== queuePosition || journal.queuedAt !== queuedAt) {
        throw new SupervisorServiceError(
          "identity_mismatch",
          `queued command "${journal.commandId}" does not match admission position ${queuePosition}`,
        );
      }
      return journal;
    }
    const queued = queueSubmissionCommand(journal, queuePosition, queuedAt);
    await this.#store.updateCommand(queued);
    return queued;
  }

  async #recordWorkerAccepted(job: JobRecord): Promise<void> {
    await this.#serializeAdmission(async () => {
      const state = this.#admissionStore.state;
      const admission = state.jobs[job.jobId];
      if (admission?.status === "accepted") {
        return;
      }
      if (admission?.status !== "dispatching") {
        throw new SupervisorServiceError(
          "identity_mismatch",
          `job "${job.jobId}" cannot authenticate from admission state "${admission?.status ?? "missing"}"`,
        );
      }
      await this.#admissionStore.append(
        createWorkerAcceptedEvent(state, job.jobId, this.#now().toISOString()),
      );
    });
  }

  async #recordJobUncertain(job: JobRecord, failure: string): Promise<void> {
    await this.#serializeAdmission(async () => {
      const state = this.#admissionStore.state;
      const admission = state.jobs[job.jobId];
      if (admission?.status === "uncertain") {
        return;
      }
      if (admission?.status !== "dispatching" && admission?.status !== "accepted") {
        return;
      }
      await this.#admissionStore.append(
        createJobUncertainEvent(
          state,
          job.jobId,
          boundedMessage(failure),
          this.#now().toISOString(),
        ),
      );
    });
  }

  #serializeAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#admissionTail.then(operation);
    this.#admissionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  get isIdle(): boolean {
    const state = this.#admissionStore.state;
    return Object.keys(state.jobs).length === 0 && Object.keys(state.rejections).length === 0;
  }

  get isShuttingDown(): boolean {
    return !this.#acceptingSubmissions;
  }

  async prepareShutdown(): Promise<void> {
    await this.#serializeAdmission(async () => {
      if (!this.isIdle) {
        throw new SupervisorServiceError(
          "conflict",
          "supervisor shutdown is refused while work is active or queued",
        );
      }
      this.#acceptingSubmissions = false;
    });
  }

  async retirePolicy(): Promise<void> {
    await this.#serializeAdmission(async () => {
      if (!this.isIdle) {
        throw new SupervisorServiceError(
          "conflict",
          "admission policy cannot be retired while work remains",
        );
      }
      await this.#admissionStore.retire();
    });
  }

  async close(): Promise<void> {
    await this.#serializeAdmission(async () => this.#admissionStore.close());
  }

  assertPolicy(policyDigest: string): void {
    if (policyDigest !== this.#admissionStore.state.policyDigest) {
      throw new SupervisorServiceError(
        "policy_mismatch",
        `requested policy ${policyDigest} does not match supervisor policy ${this.#admissionStore.state.policyDigest}`,
      );
    }
  }

  #assertAcceptingSubmissions(): void {
    if (!this.#acceptingSubmissions) {
      throw new SupervisorServiceError(
        "worker_unavailable",
        "supervisor shutdown has started; retry against the next generation",
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
      phase: "active",
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
        { runStatus: "cancelled", phase: result.phase, lastSequence: result.lastSequence },
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

function queuedResultFromJournal(journal: QueuedSubmissionCommand): SubmissionResult {
  return {
    type: "queued",
    commandId: journal.commandId as ReturnType<typeof randomUUID>,
    runId: journal.runId,
    queuePosition: journal.result.queuePosition,
    queuedAt: journal.queuedAt,
  };
}

function rejectedResultFromJournal(
  journal: Extract<SubmissionCommandRecord, { readonly status: "rejected" }>,
): SubmissionResult {
  if (journal.reason === "conflict") {
    throw new TypeError("conflicting submission is not a result");
  }
  return {
    type: "rejected",
    commandId: journal.commandId as ReturnType<typeof randomUUID>,
    runId: journal.runId,
    reason: journal.reason,
    rejectedAt: journal.rejectedAt,
  };
}

function admissionIdentity(job: JobRecord): AdmissionJobIdentity {
  return {
    jobId: job.jobId,
    workerId: job.workerId,
    runId: job.runId,
    jobDigest: job.digest,
  };
}

function isActiveAdmission(admission: AdmissionJobState): boolean {
  return (
    admission.status === "dispatching" ||
    admission.status === "accepted" ||
    admission.status === "uncertain"
  );
}

function assertAdmissionMatchesJob(admission: AdmissionJobState, job: JobRecord): void {
  if (
    admission.jobId !== job.jobId ||
    admission.workerId !== job.workerId ||
    admission.runId !== job.runId ||
    admission.jobDigest !== job.digest
  ) {
    throw new SupervisorServiceError(
      "identity_mismatch",
      `admission job "${admission.jobId}" does not match its immutable snapshot`,
    );
  }
}

function assertAdmissionMatchesDescriptor(
  admission: AdmissionJobState,
  descriptor: WorkerDescriptor,
): void {
  if (
    admission.jobId !== descriptor.jobId ||
    admission.workerId !== descriptor.workerId ||
    admission.runId !== descriptor.runId ||
    admission.jobDigest !== descriptor.jobDigest
  ) {
    throw new SupervisorServiceError(
      "identity_mismatch",
      `admission job "${admission.jobId}" does not match worker "${descriptor.workerId}"`,
    );
  }
}

function assertClaimMatchesJob(claim: ActiveRunClaim, job: JobRecord): void {
  if (claim.jobId !== job.jobId || claim.workerId !== job.workerId || claim.runId !== job.runId) {
    throw new SupervisorServiceError(
      "identity_mismatch",
      `active claim for run "${claim.runId}" does not match job "${job.jobId}"`,
    );
  }
}

function assertQueuedCancellationMatches(
  admission: Extract<AdmissionJobState, { readonly status: "queue_cancelling" }>,
  command: CancelCommand,
): void {
  if (
    admission.cancellation.commandId !== command.commandId ||
    admission.cancellation.actor !== command.actor ||
    admission.cancellation.reason !== command.reason
  ) {
    throw new SupervisorServiceError(
      "identity_mismatch",
      `queued cancellation for run "${command.runId}" does not match command "${command.commandId}"`,
    );
  }
}

function journalMatchesJob(journal: SubmissionCommandRecord, job: JobRecord): boolean {
  return (
    journal.commandId === job.jobId &&
    journal.runId === job.runId &&
    journal.mode === job.mode &&
    journal.sourceName === job.sourceName &&
    journal.workflowSourceDigest ===
      createHash("sha256").update(job.workflowSource).digest("hex") &&
    journal.workProfile === job.workProfile &&
    journal.capabilitySnapshotDigest === job.capabilitySnapshot?.digest &&
    journal.cwd === job.cwd &&
    journal.projectRoot === job.projectRoot &&
    samePaths(journal.protectedPaths, job.protectedPaths)
  );
}

function sameSubmission(job: JobRecord, command: SubmitCommand): boolean {
  return (
    job.jobId === command.commandId &&
    job.runId === command.runId &&
    job.mode === command.mode &&
    job.sourceName === command.sourceName &&
    job.workflowSource === command.workflowSource &&
    job.workProfile === command.workProfile &&
    job.capabilitySnapshot?.digest === command.capabilitySnapshot?.digest &&
    job.cwd === command.cwd &&
    job.projectRoot === command.projectRoot &&
    samePaths(job.protectedPaths, command.protectedPaths)
  );
}

function sameSubmitCommand(left: SubmitCommand, right: SubmitCommand): boolean {
  return (
    left.commandId === right.commandId &&
    left.runId === right.runId &&
    left.mode === right.mode &&
    left.sourceName === right.sourceName &&
    left.workflowSource === right.workflowSource &&
    left.workProfile === right.workProfile &&
    left.capabilitySnapshot?.digest === right.capabilitySnapshot?.digest &&
    left.cwd === right.cwd &&
    left.projectRoot === right.projectRoot &&
    samePaths(left.protectedPaths, right.protectedPaths)
  );
}

function samePaths(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.length === right.length && left.every((path, index) => path === right[index]);
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
    phase: journal.result.phase,
    lastSequence: journal.result.lastSequence,
  };
}

function boundedMessage(message: string): string {
  return message.length <= 16_384 ? message : `${message.slice(0, 16_350)}… [truncated]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
