import { z } from "zod";

import { MAX_ACTIVE_WORKERS, MAX_QUEUED_JOBS } from "../domain/config/resolver.js";

const uuidSchema = z.uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const actorSchema = z.string().trim().min(1).max(256);
const reasonSchema = z.string().trim().min(1).max(4096);
const sequenceSchema = z.number().int().positive().safe();

const limitsSchema = z
  .object({
    maxActiveWorkers: z.number().int().positive().safe().max(MAX_ACTIVE_WORKERS),
    maxQueuedJobs: z.number().int().nonnegative().safe().max(MAX_QUEUED_JOBS),
  })
  .strict();

const jobIdentitySchema = z
  .object({
    jobId: uuidSchema,
    workerId: uuidSchema,
    runId: runIdSchema,
    jobDigest: digestSchema,
  })
  .strict();

const admissionJobStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...jobIdentitySchema.shape,
      status: z.literal("queued"),
      queueSequence: sequenceSchema,
      queuedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      ...jobIdentitySchema.shape,
      status: z.literal("dispatching"),
      queueSequence: sequenceSchema.nullable(),
      dispatchingAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      ...jobIdentitySchema.shape,
      status: z.literal("accepted"),
      queueSequence: sequenceSchema.nullable(),
      acceptedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      ...jobIdentitySchema.shape,
      status: z.literal("queue_cancelling"),
      queueSequence: sequenceSchema,
      cancellation: z
        .object({
          commandId: uuidSchema,
          actor: actorSchema,
          reason: reasonSchema.optional(),
          recordedAt: timestampSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...jobIdentitySchema.shape,
      status: z.literal("uncertain"),
      queueSequence: sequenceSchema.nullable(),
      failure: reasonSchema,
      uncertainAt: timestampSchema,
    })
    .strict(),
]);

const admissionRejectionStateSchema = z
  .object({
    jobId: uuidSchema,
    runId: runIdSchema,
    requestDigest: digestSchema,
    reason: z.literal("queue_full"),
    rejectedAt: timestampSchema,
  })
  .strict();

const initializedEventSchema = z
  .object({
    version: z.literal(1),
    sequence: z.literal(1),
    type: z.literal("admission_initialized"),
    policyDigest: digestSchema,
    limits: limitsSchema,
    at: timestampSchema,
  })
  .strict();

const snapshotEventSchema = z
  .object({
    version: z.literal(1),
    sequence: sequenceSchema,
    type: z.literal("admission_snapshot"),
    policyDigest: digestSchema,
    limits: limitsSchema,
    lastQueueSequence: z.number().int().nonnegative().safe(),
    jobs: z.array(admissionJobStateSchema),
    rejections: z.array(admissionRejectionStateSchema),
    at: timestampSchema,
  })
  .strict();

const eventBase = {
  version: z.literal(1),
  sequence: sequenceSchema,
  policyDigest: digestSchema,
  at: timestampSchema,
};

const enqueuedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("job_enqueued"),
    ...jobIdentitySchema.shape,
    queueSequence: sequenceSchema,
  })
  .strict();

const rejectedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("job_rejected"),
    jobId: uuidSchema,
    runId: runIdSchema,
    requestDigest: digestSchema,
    reason: z.literal("queue_full"),
  })
  .strict();

const rejectionCommittedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("job_rejection_committed"),
    jobId: uuidSchema,
    requestDigest: digestSchema,
  })
  .strict();

const dispatchReservedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("job_dispatch_reserved"),
    ...jobIdentitySchema.shape,
    queueSequence: sequenceSchema.nullable(),
  })
  .strict();

const workerAcceptedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("worker_accepted"),
    jobId: uuidSchema,
    workerId: uuidSchema,
  })
  .strict();

const queueCancellationRecordedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("queue_cancellation_recorded"),
    jobId: uuidSchema,
    commandId: uuidSchema,
    actor: actorSchema,
    reason: reasonSchema.optional(),
  })
  .strict();

const queueCancellationCompletedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("queue_cancellation_completed"),
    jobId: uuidSchema,
    commandId: uuidSchema,
  })
  .strict();

const jobUncertainEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("job_uncertain"),
    jobId: uuidSchema,
    failure: z.string().trim().min(1).max(16_384),
  })
  .strict();

const jobReleasedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("job_released"),
    jobId: uuidSchema,
    runStatus: z.enum([
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "resource_exhausted",
      "waiting_for_approval",
    ]),
  })
  .strict();

const admissionEventSchema = z.discriminatedUnion("type", [
  initializedEventSchema,
  snapshotEventSchema,
  enqueuedEventSchema,
  rejectedEventSchema,
  rejectionCommittedEventSchema,
  dispatchReservedEventSchema,
  workerAcceptedEventSchema,
  queueCancellationRecordedEventSchema,
  queueCancellationCompletedEventSchema,
  jobUncertainEventSchema,
  jobReleasedEventSchema,
]);

export type AdmissionLimits = Readonly<z.infer<typeof limitsSchema>>;
export type AdmissionJobIdentity = Readonly<z.infer<typeof jobIdentitySchema>>;
export type AdmissionRejectionState = Readonly<z.infer<typeof admissionRejectionStateSchema>>;
export type AdmissionEvent = Readonly<z.infer<typeof admissionEventSchema>>;
type AdmissionTransitionEvent = Exclude<
  AdmissionEvent,
  { readonly type: "admission_initialized" | "admission_snapshot" }
>;

interface AdmissionJobBase extends AdmissionJobIdentity {
  readonly queueSequence: number | null;
}

export type AdmissionJobState =
  | (AdmissionJobBase & {
      readonly status: "queued";
      readonly queueSequence: number;
      readonly queuedAt: string;
    })
  | (AdmissionJobBase & {
      readonly status: "dispatching";
      readonly dispatchingAt: string;
    })
  | (AdmissionJobBase & {
      readonly status: "accepted";
      readonly acceptedAt: string;
    })
  | (AdmissionJobBase & {
      readonly status: "queue_cancelling";
      readonly queueSequence: number;
      readonly cancellation: {
        readonly commandId: string;
        readonly actor: string;
        readonly reason?: string | undefined;
        readonly recordedAt: string;
      };
    })
  | (AdmissionJobBase & {
      readonly status: "uncertain";
      readonly failure: string;
      readonly uncertainAt: string;
    });

export interface AdmissionState {
  readonly policyDigest: string;
  readonly limits: AdmissionLimits;
  readonly lastSequence: number;
  readonly lastQueueSequence: number;
  readonly activeCount: number;
  readonly queuedCount: number;
  readonly jobs: Readonly<Record<string, AdmissionJobState>>;
  readonly rejections: Readonly<Record<string, AdmissionRejectionState>>;
  readonly events: readonly AdmissionTransitionEvent[];
}

export type AdmissionStateErrorCode =
  | "capacity_exceeded"
  | "invalid_event"
  | "invalid_transition"
  | "policy_mismatch";

export class AdmissionStateError extends Error {
  override readonly name = "AdmissionStateError";

  constructor(
    readonly code: AdmissionStateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function parseAdmissionEvent(input: unknown): AdmissionEvent {
  try {
    return deepFreeze(admissionEventSchema.parse(input));
  } catch (error) {
    const detail =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".") || "event"}: ${issue.message}`)
            .join("; ")
        : "unknown validation failure";
    throw new AdmissionStateError("invalid_event", `admission event schema is invalid: ${detail}`, {
      cause: error,
    });
  }
}

export function createAdmissionInitializedEvent(input: {
  readonly policyDigest: string;
  readonly limits: AdmissionLimits;
  readonly at: string;
}): Extract<AdmissionEvent, { readonly type: "admission_initialized" }> {
  return parseAdmissionEvent({
    version: 1,
    sequence: 1,
    type: "admission_initialized",
    ...input,
  }) as Extract<AdmissionEvent, { readonly type: "admission_initialized" }>;
}

export function createAdmissionSnapshotEvent(
  state: AdmissionState,
  at: string,
): Extract<AdmissionEvent, { readonly type: "admission_snapshot" }> {
  return parseAdmissionEvent({
    version: 1,
    sequence: state.lastSequence,
    type: "admission_snapshot",
    policyDigest: state.policyDigest,
    limits: state.limits,
    lastQueueSequence: state.lastQueueSequence,
    jobs: Object.values(state.jobs).sort((left, right) => left.jobId.localeCompare(right.jobId)),
    rejections: Object.values(state.rejections).sort((left, right) =>
      left.jobId.localeCompare(right.jobId),
    ),
    at,
  }) as Extract<AdmissionEvent, { readonly type: "admission_snapshot" }>;
}

export function createJobEnqueuedEvent(
  state: AdmissionState,
  job: AdmissionJobIdentity,
  at: string,
): Extract<AdmissionEvent, { readonly type: "job_enqueued" }> {
  return validateNextEvent(state, {
    version: 1,
    sequence: state.lastSequence + 1,
    type: "job_enqueued",
    policyDigest: state.policyDigest,
    ...job,
    queueSequence: state.lastQueueSequence + 1,
    at,
  });
}

export function createJobRejectedEvent(
  state: AdmissionState,
  input: {
    readonly jobId: string;
    readonly runId: string;
    readonly requestDigest: string;
  },
  reason: "queue_full",
  at: string,
): Extract<AdmissionEvent, { readonly type: "job_rejected" }> {
  return validateNextEvent(state, {
    version: 1,
    sequence: state.lastSequence + 1,
    type: "job_rejected",
    policyDigest: state.policyDigest,
    ...input,
    reason,
    at,
  });
}

export function createJobRejectionCommittedEvent(
  state: AdmissionState,
  jobId: string,
  requestDigest: string,
  at: string,
): Extract<AdmissionEvent, { readonly type: "job_rejection_committed" }> {
  return validateNextEvent(state, {
    version: 1,
    sequence: state.lastSequence + 1,
    type: "job_rejection_committed",
    policyDigest: state.policyDigest,
    jobId,
    requestDigest,
    at,
  });
}

export function createDispatchReservedEvent(
  state: AdmissionState,
  job: AdmissionJobIdentity,
  at: string,
): Extract<AdmissionEvent, { readonly type: "job_dispatch_reserved" }> {
  const existing = state.jobs[job.jobId];
  return validateNextEvent(state, {
    version: 1,
    sequence: state.lastSequence + 1,
    type: "job_dispatch_reserved",
    policyDigest: state.policyDigest,
    jobId: job.jobId,
    workerId: job.workerId,
    runId: job.runId,
    jobDigest: job.jobDigest,
    queueSequence: existing?.status === "queued" ? existing.queueSequence : null,
    at,
  });
}

export function createWorkerAcceptedEvent(
  state: AdmissionState,
  jobId: string,
  at: string,
): Extract<AdmissionEvent, { readonly type: "worker_accepted" }> {
  const job = requireJob(state, jobId);
  return validateNextEvent(state, {
    version: 1,
    sequence: state.lastSequence + 1,
    type: "worker_accepted",
    policyDigest: state.policyDigest,
    jobId,
    workerId: job.workerId,
    at,
  });
}

export function createQueueCancellationRecordedEvent(
  state: AdmissionState,
  jobId: string,
  input: {
    readonly commandId: string;
    readonly actor: string;
    readonly reason?: string;
    readonly at: string;
  },
): Extract<AdmissionEvent, { readonly type: "queue_cancellation_recorded" }> {
  return validateNextEvent(state, {
    version: 1,
    sequence: state.lastSequence + 1,
    type: "queue_cancellation_recorded",
    policyDigest: state.policyDigest,
    jobId,
    commandId: input.commandId,
    actor: input.actor,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    at: input.at,
  });
}

export function createQueueCancellationCompletedEvent(
  state: AdmissionState,
  jobId: string,
  commandId: string,
  at: string,
): Extract<AdmissionEvent, { readonly type: "queue_cancellation_completed" }> {
  return validateNextEvent(state, {
    version: 1,
    sequence: state.lastSequence + 1,
    type: "queue_cancellation_completed",
    policyDigest: state.policyDigest,
    jobId,
    commandId,
    at,
  });
}

export function createJobUncertainEvent(
  state: AdmissionState,
  jobId: string,
  failure: string,
  at: string,
): Extract<AdmissionEvent, { readonly type: "job_uncertain" }> {
  return validateNextEvent(state, {
    version: 1,
    sequence: state.lastSequence + 1,
    type: "job_uncertain",
    policyDigest: state.policyDigest,
    jobId,
    failure,
    at,
  });
}

export function createJobReleasedEvent(
  state: AdmissionState,
  jobId: string,
  runStatus: Extract<AdmissionEvent, { readonly type: "job_released" }>["runStatus"],
  at: string,
): Extract<AdmissionEvent, { readonly type: "job_released" }> {
  return validateNextEvent(state, {
    version: 1,
    sequence: state.lastSequence + 1,
    type: "job_released",
    policyDigest: state.policyDigest,
    jobId,
    runStatus,
    at,
  });
}

export function classifyNewAdmission(state: AdmissionState): "dispatch" | "queue" | "reject" {
  if (state.activeCount < state.limits.maxActiveWorkers) {
    return "dispatch";
  }
  return state.queuedCount < state.limits.maxQueuedJobs ? "queue" : "reject";
}

export function reduceAdmissionEvents(inputs: readonly unknown[]): AdmissionState {
  if (inputs.length === 0) {
    throw new AdmissionStateError("invalid_event", "admission ledger is missing initialization");
  }
  const events = inputs.map(parseAdmissionEvent);
  const root = events[0];
  if (root?.type !== "admission_initialized" && root?.type !== "admission_snapshot") {
    throw new AdmissionStateError(
      "invalid_event",
      "admission ledger must begin with admission_initialized or admission_snapshot",
    );
  }
  let state = root.type === "admission_initialized" ? emptyState(root) : snapshotState(root);
  for (const event of events.slice(1)) {
    if (event.type === "admission_initialized" || event.type === "admission_snapshot") {
      throw new AdmissionStateError(
        "invalid_transition",
        "admission ledger root cannot appear after the first record",
      );
    }
    state = applyAdmissionEvent(state, event);
  }
  return state;
}

export function appendAdmissionEvent(state: AdmissionState, input: unknown): AdmissionState {
  const event = parseAdmissionEvent(input);
  if (event.type === "admission_initialized" || event.type === "admission_snapshot") {
    throw new AdmissionStateError("invalid_transition", "admission state is already initialized");
  }
  return applyAdmissionEvent(state, event);
}

function validateNextEvent<TEvent extends AdmissionTransitionEvent>(
  state: AdmissionState,
  input: TEvent,
): TEvent {
  const event = parseAdmissionEvent(input);
  if (event.type === "admission_initialized" || event.type === "admission_snapshot") {
    throw new AdmissionStateError("invalid_transition", "admission policy is already initialized");
  }
  applyAdmissionEvent(state, event);
  return event as TEvent;
}

function applyAdmissionEvent(
  state: AdmissionState,
  event: AdmissionTransitionEvent,
): AdmissionState {
  if (event.sequence !== state.lastSequence + 1) {
    throw new AdmissionStateError(
      "invalid_event",
      `admission sequence ${event.sequence} does not follow ${state.lastSequence}`,
    );
  }
  if (event.policyDigest !== state.policyDigest) {
    throw new AdmissionStateError(
      "policy_mismatch",
      `admission event policy ${event.policyDigest} does not match ${state.policyDigest}`,
    );
  }

  const jobs: Record<string, AdmissionJobState> = { ...state.jobs };
  const rejections: Record<string, AdmissionRejectionState> = { ...state.rejections };
  let lastQueueSequence = state.lastQueueSequence;
  switch (event.type) {
    case "job_enqueued": {
      requireNewJob(state, event.jobId, event.runId, event.workerId);
      if (state.activeCount < state.limits.maxActiveWorkers) {
        throw invalidTransition(`job "${event.jobId}" cannot queue while active capacity is free`);
      }
      if (state.queuedCount >= state.limits.maxQueuedJobs) {
        throw new AdmissionStateError("capacity_exceeded", "queued admission capacity is full");
      }
      if (event.queueSequence !== state.lastQueueSequence + 1) {
        throw invalidTransition(
          `queue sequence ${event.queueSequence} does not follow ${state.lastQueueSequence}`,
        );
      }
      jobs[event.jobId] = {
        ...jobIdentityFromEvent(event),
        status: "queued",
        queueSequence: event.queueSequence,
        queuedAt: event.at,
      };
      lastQueueSequence = event.queueSequence;
      break;
    }
    case "job_rejected": {
      if (state.jobs[event.jobId] !== undefined || state.rejections[event.jobId] !== undefined) {
        throw invalidTransition(`admission command "${event.jobId}" already has a decision`);
      }
      if (classifyNewAdmission(state) !== "reject") {
        throw invalidTransition(`admission queue is not full for job "${event.jobId}"`);
      }
      rejections[event.jobId] = {
        jobId: event.jobId,
        runId: event.runId,
        requestDigest: event.requestDigest,
        reason: event.reason,
        rejectedAt: event.at,
      };
      break;
    }
    case "job_rejection_committed": {
      const rejection = state.rejections[event.jobId];
      if (rejection === undefined || rejection.requestDigest !== event.requestDigest) {
        throw invalidTransition(`admission command "${event.jobId}" has no matching rejection`);
      }
      delete rejections[event.jobId];
      break;
    }
    case "job_dispatch_reserved": {
      const existing = state.jobs[event.jobId];
      if (existing === undefined) {
        requireNewJob(state, event.jobId, event.runId, event.workerId);
        if (event.queueSequence !== null) {
          throw invalidTransition(`new job "${event.jobId}" cannot claim a queue sequence`);
        }
      } else {
        if (existing.status !== "queued") {
          throw invalidTransition(`job "${event.jobId}" is not queued`);
        }
        assertSameJob(existing, event);
        if (event.queueSequence !== existing.queueSequence) {
          throw invalidTransition(`job "${event.jobId}" queue sequence changed`);
        }
        const oldest = oldestQueuedJob(state);
        if (oldest?.jobId !== event.jobId) {
          throw invalidTransition(`job "${event.jobId}" is not the oldest FIFO admission`);
        }
      }
      if (state.activeCount >= state.limits.maxActiveWorkers) {
        throw new AdmissionStateError("capacity_exceeded", "active worker capacity is full");
      }
      jobs[event.jobId] = {
        ...jobIdentityFromEvent(event),
        status: "dispatching",
        queueSequence: event.queueSequence,
        dispatchingAt: event.at,
      };
      break;
    }
    case "worker_accepted": {
      const existing = requireJob(state, event.jobId);
      if (existing.status !== "dispatching" || existing.workerId !== event.workerId) {
        throw invalidTransition(`job "${event.jobId}" is not the matching dispatch reservation`);
      }
      jobs[event.jobId] = {
        ...jobIdentity(existing),
        status: "accepted",
        queueSequence: existing.queueSequence,
        acceptedAt: event.at,
      };
      break;
    }
    case "queue_cancellation_recorded": {
      const existing = requireJob(state, event.jobId);
      if (existing.status !== "queued") {
        throw invalidTransition(`job "${event.jobId}" is not queued for cancellation`);
      }
      jobs[event.jobId] = {
        ...jobIdentity(existing),
        status: "queue_cancelling",
        queueSequence: existing.queueSequence,
        cancellation: {
          commandId: event.commandId,
          actor: event.actor,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          recordedAt: event.at,
        },
      };
      break;
    }
    case "queue_cancellation_completed": {
      const existing = requireJob(state, event.jobId);
      if (
        existing.status !== "queue_cancelling" ||
        existing.cancellation.commandId !== event.commandId
      ) {
        throw invalidTransition(`job "${event.jobId}" has no matching queued cancellation`);
      }
      delete jobs[event.jobId];
      break;
    }
    case "job_uncertain": {
      const existing = requireJob(state, event.jobId);
      if (existing.status !== "dispatching" && existing.status !== "accepted") {
        throw invalidTransition(`job "${event.jobId}" has no active execution to mark uncertain`);
      }
      jobs[event.jobId] = {
        ...jobIdentity(existing),
        status: "uncertain",
        queueSequence: existing.queueSequence,
        failure: event.failure,
        uncertainAt: event.at,
      };
      break;
    }
    case "job_released": {
      const existing = requireJob(state, event.jobId);
      if (
        existing.status !== "dispatching" &&
        existing.status !== "accepted" &&
        existing.status !== "uncertain"
      ) {
        throw invalidTransition(`job "${event.jobId}" has no active capacity to release`);
      }
      delete jobs[event.jobId];
      break;
    }
  }

  return finalizedState({
    policyDigest: state.policyDigest,
    limits: state.limits,
    lastSequence: event.sequence,
    lastQueueSequence,
    jobs,
    rejections,
    events: [...state.events, event],
  });
}

function emptyState(
  initialized: Extract<AdmissionEvent, { readonly type: "admission_initialized" }>,
): AdmissionState {
  return finalizedState({
    policyDigest: initialized.policyDigest,
    limits: initialized.limits,
    lastSequence: 1,
    lastQueueSequence: 0,
    jobs: {},
    rejections: {},
    events: [],
  });
}

function snapshotState(
  snapshot: Extract<AdmissionEvent, { readonly type: "admission_snapshot" }>,
): AdmissionState {
  const jobs: Record<string, AdmissionJobState> = {};
  for (const job of snapshot.jobs) {
    if (jobs[job.jobId] !== undefined) {
      throw invalidTransition(`snapshot contains duplicate job "${job.jobId}"`);
    }
    jobs[job.jobId] = job;
  }
  const rejections: Record<string, AdmissionRejectionState> = {};
  for (const rejection of snapshot.rejections) {
    if (rejections[rejection.jobId] !== undefined || jobs[rejection.jobId] !== undefined) {
      throw invalidTransition(`snapshot contains duplicate command "${rejection.jobId}"`);
    }
    rejections[rejection.jobId] = rejection;
  }
  const highestQueueSequence = Math.max(0, ...snapshot.jobs.map((job) => job.queueSequence ?? 0));
  if (highestQueueSequence > snapshot.lastQueueSequence) {
    throw invalidTransition(
      `snapshot queue sequence ${highestQueueSequence} exceeds last queue sequence ${snapshot.lastQueueSequence}`,
    );
  }
  return finalizedState({
    policyDigest: snapshot.policyDigest,
    limits: snapshot.limits,
    lastSequence: snapshot.sequence,
    lastQueueSequence: snapshot.lastQueueSequence,
    jobs,
    rejections,
    events: [],
  });
}

function finalizedState(input: {
  readonly policyDigest: string;
  readonly limits: AdmissionLimits;
  readonly lastSequence: number;
  readonly lastQueueSequence: number;
  readonly jobs: Readonly<Record<string, AdmissionJobState>>;
  readonly rejections: Readonly<Record<string, AdmissionRejectionState>>;
  readonly events: readonly AdmissionTransitionEvent[];
}): AdmissionState {
  const values = Object.values(input.jobs);
  if (new Set(values.map((job) => job.runId)).size !== values.length) {
    throw invalidTransition("admission run identities must be unique");
  }
  if (new Set(values.map((job) => job.workerId)).size !== values.length) {
    throw invalidTransition("admission worker identities must be unique");
  }
  if (Object.keys(input.rejections).some((jobId) => input.jobs[jobId] !== undefined)) {
    throw invalidTransition("admission jobs and rejections must have unique command identities");
  }
  const activeCount = values.filter((job) => isActive(job.status)).length;
  const queuedCount = values.filter((job) => job.status === "queued").length;
  if (activeCount > input.limits.maxActiveWorkers) {
    throw new AdmissionStateError("capacity_exceeded", "active worker capacity was exceeded");
  }
  if (queuedCount > input.limits.maxQueuedJobs) {
    throw new AdmissionStateError("capacity_exceeded", "queued admission capacity was exceeded");
  }
  const queueSequences = values
    .filter((job) => job.status === "queued" || job.status === "queue_cancelling")
    .map((job) => job.queueSequence);
  if (new Set(queueSequences).size !== queueSequences.length) {
    throw invalidTransition("queue sequences must be unique");
  }
  return deepFreeze({ ...input, activeCount, queuedCount });
}

function oldestQueuedJob(state: AdmissionState): AdmissionJobState | undefined {
  return Object.values(state.jobs)
    .filter((job) => job.status === "queued")
    .sort((left, right) => left.queueSequence - right.queueSequence)[0];
}

function requireJob(state: AdmissionState, jobId: string): AdmissionJobState {
  const job = state.jobs[jobId];
  if (job === undefined) {
    throw invalidTransition(`admission job "${jobId}" does not exist`);
  }
  return job;
}

function requireNewJob(
  state: AdmissionState,
  jobId: string,
  runId: string,
  workerId: string,
): void {
  if (state.jobs[jobId] !== undefined) {
    throw invalidTransition(`admission job "${jobId}" already exists`);
  }
  if (state.rejections[jobId] !== undefined) {
    throw invalidTransition(`admission command "${jobId}" has an uncommitted rejection`);
  }
  if (Object.values(state.jobs).some((job) => job.runId === runId)) {
    throw invalidTransition(`run "${runId}" already has a nonterminal admission job`);
  }
  if (Object.values(state.jobs).some((job) => job.workerId === workerId)) {
    throw invalidTransition(`worker "${workerId}" already belongs to an admission job`);
  }
}

function assertSameJob(left: AdmissionJobIdentity, right: AdmissionJobIdentity): void {
  if (
    left.jobId !== right.jobId ||
    left.workerId !== right.workerId ||
    left.runId !== right.runId ||
    left.jobDigest !== right.jobDigest
  ) {
    throw invalidTransition(`admission job "${left.jobId}" identity changed`);
  }
}

function jobIdentityFromEvent(
  event: Extract<
    AdmissionTransitionEvent,
    { readonly type: "job_enqueued" | "job_dispatch_reserved" }
  >,
): AdmissionJobIdentity {
  return jobIdentity(event);
}

function jobIdentity(input: AdmissionJobIdentity): AdmissionJobIdentity {
  return {
    jobId: input.jobId,
    workerId: input.workerId,
    runId: input.runId,
    jobDigest: input.jobDigest,
  };
}

function isActive(status: AdmissionJobState["status"]): boolean {
  return status === "dispatching" || status === "accepted" || status === "uncertain";
}

function invalidTransition(message: string): AdmissionStateError {
  return new AdmissionStateError("invalid_transition", message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
