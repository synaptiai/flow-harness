import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { MAX_ACTIVE_WORKERS, MAX_QUEUED_JOBS } from "../domain/config/resolver.js";
import { SUPERVISOR_PROTOCOL_VERSION } from "./protocol.js";

const uuidSchema = z.uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/, "invalid worker token");
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "invalid runId");
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value), "must be an absolute path");
const timestampSchema = z.iso.datetime({ offset: true });
const actorSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (actor) =>
      !Array.from(actor).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
      }),
    "must not contain control characters",
  );

export interface JobDigestInput {
  readonly version: 1;
  readonly jobId: string;
  readonly workerId: string;
  readonly runId: string;
  readonly mode: "run" | "resume";
  readonly sourceName: string;
  readonly workflowSource: string;
  readonly cwd: string;
  readonly token: string;
  readonly createdAt: string;
}

export interface JobRecord extends JobDigestInput {
  readonly digest: string;
}

export interface SubmissionCommandIdentity {
  readonly version: 1;
  readonly commandId: string;
  readonly type: "submit";
  readonly policyDigest: string;
  readonly runId: string;
  readonly mode: "run" | "resume";
  readonly sourceName: string;
  readonly workflowSourceDigest: string;
  readonly cwd: string;
}

interface SubmissionCommandBase extends SubmissionCommandIdentity {
  readonly requestDigest: string;
  readonly recordedAt: string;
}

export interface RecordedSubmissionCommand extends SubmissionCommandBase {
  readonly status: "recorded";
}

export interface CompletedSubmissionCommand extends SubmissionCommandBase {
  readonly status: "completed";
  readonly completedAt: string;
  readonly result: {
    readonly workerId: string;
    readonly acceptedAt: string;
  };
}

export interface QueuedSubmissionCommand extends SubmissionCommandBase {
  readonly status: "queued";
  readonly queuedAt: string;
  readonly result: {
    readonly queuePosition: number;
  };
}

export interface RejectedSubmissionCommand extends SubmissionCommandBase {
  readonly status: "rejected";
  readonly reason: "cancelled" | "conflict" | "queue_full";
  readonly rejectedAt: string;
  readonly failure: string;
}

export interface UncertainSubmissionCommand extends SubmissionCommandBase {
  readonly status: "uncertain";
  readonly uncertainAt: string;
  readonly failure: string;
}

export type SubmissionCommandRecord =
  | RecordedSubmissionCommand
  | QueuedSubmissionCommand
  | CompletedSubmissionCommand
  | RejectedSubmissionCommand
  | UncertainSubmissionCommand;

export interface CancellationCommandIdentity {
  readonly version: 1;
  readonly commandId: string;
  readonly type: "cancel";
  readonly runId: string;
  readonly actor: string;
  readonly reason?: string | undefined;
}

interface CancellationCommandBase extends CancellationCommandIdentity {
  readonly requestDigest: string;
  readonly recordedAt: string;
}

export interface RecordedCancellationCommand extends CancellationCommandBase {
  readonly status: "recorded";
}

export interface CompletedCancellationCommand extends CancellationCommandBase {
  readonly status: "completed";
  readonly completedAt: string;
  readonly result: {
    readonly runStatus: "cancelled";
    readonly phase: "active" | "queued";
    readonly lastSequence: number | null;
  };
}

export interface UncertainCancellationCommand extends CancellationCommandBase {
  readonly status: "uncertain";
  readonly uncertainAt: string;
  readonly failure: string;
}

export type CancellationCommandRecord =
  | RecordedCancellationCommand
  | CompletedCancellationCommand
  | UncertainCancellationCommand;

export type SupervisorCommandRecord = SubmissionCommandRecord | CancellationCommandRecord;

const jobRecordShape = {
  version: z.literal(1),
  jobId: uuidSchema,
  workerId: uuidSchema,
  runId: runIdSchema,
  mode: z.enum(["run", "resume"]),
  sourceName: absolutePathSchema,
  workflowSource: z.string().min(1).max(20_000_000),
  cwd: absolutePathSchema,
  token: tokenSchema,
  createdAt: timestampSchema,
};

const jobRecordSchema: z.ZodType<JobRecord> = z
  .object({
    ...jobRecordShape,
    digest: sha256Schema,
  })
  .strict()
  .refine((record) => calculateJobDigest(record) === record.digest, {
    message: "job digest does not match its immutable snapshot",
    path: ["digest"],
  });

const activeRunClaimSchema = z
  .object({
    version: z.literal(1),
    runId: runIdSchema,
    jobId: uuidSchema,
    workerId: uuidSchema,
    claimedAt: timestampSchema,
  })
  .strict();

const workerDescriptorSchema = z
  .object({
    version: z.literal(1),
    workerId: uuidSchema,
    jobId: uuidSchema,
    runId: runIdSchema,
    pid: z.number().int().positive().safe(),
    token: tokenSchema,
    jobDigest: sha256Schema,
    socketPath: absolutePathSchema,
    status: z.enum(["starting", "running", "waiting", "terminal", "failed"]),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    runStatus: z
      .enum([
        "running",
        "waiting_for_approval",
        "succeeded",
        "failed",
        "cancelled",
        "resource_exhausted",
      ])
      .optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    failure: z.string().min(1).max(16_384).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const final = record.status === "terminal" || record.status === "failed";
    if (final !== (record.exitCode !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "final worker status and exit code must be present together",
        path: ["exitCode"],
      });
    }
    if (record.status === "terminal" && record.runStatus === undefined) {
      context.addIssue({
        code: "custom",
        message: "terminal worker status requires a run status",
        path: ["runStatus"],
      });
    }
    if (record.status === "failed" && record.failure === undefined) {
      context.addIssue({
        code: "custom",
        message: "failed worker status requires a failure description",
        path: ["failure"],
      });
    }
  });

const supervisorDescriptorSchema = z
  .object({
    version: z.literal(1),
    protocolVersion: z.literal(SUPERVISOR_PROTOCOL_VERSION),
    generation: uuidSchema,
    pid: z.number().int().positive().safe(),
    startedAt: timestampSchema,
    runsDirectory: absolutePathSchema,
    socketPath: absolutePathSchema,
    policyDigest: sha256Schema,
    limits: z
      .object({
        maxActiveWorkers: z.number().int().positive().safe().max(MAX_ACTIVE_WORKERS),
        maxQueuedJobs: z.number().int().nonnegative().safe().max(MAX_QUEUED_JOBS),
      })
      .strict(),
  })
  .strict();

const supervisorStartLockSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive().safe(),
    token: uuidSchema,
    acquiredAt: timestampSchema,
  })
  .strict();

const cancellationCommandBaseShape = {
  version: z.literal(1),
  commandId: uuidSchema,
  type: z.literal("cancel"),
  runId: runIdSchema,
  actor: actorSchema,
  reason: z.string().trim().min(1).max(4096).optional(),
  requestDigest: sha256Schema,
  recordedAt: timestampSchema,
};

const cancellationCommandRecordSchema: z.ZodType<CancellationCommandRecord> = z
  .discriminatedUnion("status", [
    z.object({ ...cancellationCommandBaseShape, status: z.literal("recorded") }).strict(),
    z
      .object({
        ...cancellationCommandBaseShape,
        status: z.literal("completed"),
        completedAt: timestampSchema,
        result: z
          .object({
            runStatus: z.literal("cancelled"),
            phase: z.enum(["active", "queued"]),
            lastSequence: z.number().int().positive().safe().nullable(),
          })
          .strict()
          .superRefine((result, context) => {
            if ((result.phase === "queued") !== (result.lastSequence === null)) {
              context.addIssue({
                code: "custom",
                message: "queued cancellation requires a null run sequence",
                path: ["lastSequence"],
              });
            }
          }),
      })
      .strict(),
    z
      .object({
        ...cancellationCommandBaseShape,
        status: z.literal("uncertain"),
        uncertainAt: timestampSchema,
        failure: z.string().min(1).max(16_384),
      })
      .strict(),
  ])
  .refine((record) => calculateCancellationCommandDigest(record) === record.requestDigest, {
    message: "cancellation command digest does not match its request",
    path: ["requestDigest"],
  });

const submissionCommandBaseShape = {
  version: z.literal(1),
  commandId: uuidSchema,
  type: z.literal("submit"),
  policyDigest: sha256Schema,
  runId: runIdSchema,
  mode: z.enum(["run", "resume"]),
  sourceName: absolutePathSchema,
  workflowSourceDigest: sha256Schema,
  cwd: absolutePathSchema,
  requestDigest: sha256Schema,
  recordedAt: timestampSchema,
};

const submissionCommandRecordSchema: z.ZodType<SubmissionCommandRecord> = z
  .discriminatedUnion("status", [
    z.object({ ...submissionCommandBaseShape, status: z.literal("recorded") }).strict(),
    z
      .object({
        ...submissionCommandBaseShape,
        status: z.literal("queued"),
        queuedAt: timestampSchema,
        result: z
          .object({
            queuePosition: z.number().int().positive().safe(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...submissionCommandBaseShape,
        status: z.literal("completed"),
        completedAt: timestampSchema,
        result: z
          .object({
            workerId: uuidSchema,
            acceptedAt: timestampSchema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...submissionCommandBaseShape,
        status: z.literal("rejected"),
        reason: z.enum(["cancelled", "conflict", "queue_full"]),
        rejectedAt: timestampSchema,
        failure: z.string().min(1).max(16_384),
      })
      .strict(),
    z
      .object({
        ...submissionCommandBaseShape,
        status: z.literal("uncertain"),
        uncertainAt: timestampSchema,
        failure: z.string().min(1).max(16_384),
      })
      .strict(),
  ])
  .refine((record) => calculateSubmissionCommandDigest(record) === record.requestDigest, {
    message: "submission command digest does not match its request",
    path: ["requestDigest"],
  });

const supervisorCommandRecordSchema: z.ZodType<SupervisorCommandRecord> = z.union([
  submissionCommandRecordSchema,
  cancellationCommandRecordSchema,
]);

export type ActiveRunClaim = z.infer<typeof activeRunClaimSchema>;
export type WorkerDescriptor = z.infer<typeof workerDescriptorSchema>;
export type SupervisorDescriptor = z.infer<typeof supervisorDescriptorSchema>;
export type SupervisorStartLock = z.infer<typeof supervisorStartLockSchema>;

export type CreateJobRecordInput = Omit<JobRecord, "version" | "digest">;
export type CreateActiveRunClaimInput = Omit<ActiveRunClaim, "version">;
export type CreateSupervisorStartLockInput = Omit<SupervisorStartLock, "version">;
export type CreateCancellationCommandInput = Omit<
  RecordedCancellationCommand,
  "version" | "type" | "requestDigest" | "status"
>;
export interface CreateSubmissionCommandInput {
  readonly commandId: string;
  readonly policyDigest: string;
  readonly runId: string;
  readonly mode: "run" | "resume";
  readonly sourceName: string;
  readonly workflowSource: string;
  readonly cwd: string;
  readonly recordedAt: string;
}

export function createJobRecord(input: CreateJobRecordInput): JobRecord {
  const candidate = { version: 1 as const, ...input };
  return deepFreeze(
    jobRecordSchema.parse({
      ...candidate,
      digest: calculateJobDigest(candidate),
    }),
  );
}

export function calculateJobDigest(record: JobDigestInput | JobRecord): string {
  const canonical = {
    version: record.version,
    jobId: record.jobId,
    workerId: record.workerId,
    runId: record.runId,
    mode: record.mode,
    sourceName: record.sourceName,
    workflowSource: record.workflowSource,
    cwd: record.cwd,
    token: record.token,
    createdAt: record.createdAt,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function parseJobRecord(input: unknown): JobRecord {
  return deepFreeze(jobRecordSchema.parse(input));
}

export function createActiveRunClaim(input: CreateActiveRunClaimInput): ActiveRunClaim {
  return Object.freeze(activeRunClaimSchema.parse({ version: 1, ...input }));
}

export function parseActiveRunClaim(input: unknown): ActiveRunClaim {
  return Object.freeze(activeRunClaimSchema.parse(input));
}

export function parseWorkerDescriptor(input: unknown): WorkerDescriptor {
  return Object.freeze(workerDescriptorSchema.parse(input));
}

export function parseSupervisorDescriptor(input: unknown): SupervisorDescriptor {
  return Object.freeze(supervisorDescriptorSchema.parse(input));
}

export function createSupervisorStartLock(
  input: CreateSupervisorStartLockInput,
): SupervisorStartLock {
  return Object.freeze(supervisorStartLockSchema.parse({ version: 1, ...input }));
}

export function parseSupervisorStartLock(input: unknown): SupervisorStartLock {
  return Object.freeze(supervisorStartLockSchema.parse(input));
}

export function createCancellationCommandRecord(
  input: CreateCancellationCommandInput,
): RecordedCancellationCommand {
  const identity = {
    version: 1 as const,
    commandId: input.commandId,
    type: "cancel" as const,
    runId: input.runId,
    actor: input.actor,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
  return Object.freeze(
    cancellationCommandRecordSchema.parse({
      ...identity,
      requestDigest: calculateCancellationCommandDigest(identity),
      recordedAt: input.recordedAt,
      status: "recorded",
    }),
  ) as RecordedCancellationCommand;
}

export function completeCancellationCommand(
  input: CancellationCommandRecord,
  result: CompletedCancellationCommand["result"],
  completedAt: string,
): CompletedCancellationCommand {
  const current = parseSupervisorCommandRecord(input);
  if (current.type !== "cancel") {
    throw new TypeError("expected a cancellation command record");
  }
  return Object.freeze(
    cancellationCommandRecordSchema.parse({
      ...cancellationCommandBase(current),
      status: "completed",
      completedAt,
      result,
    }),
  ) as CompletedCancellationCommand;
}

export function markCancellationCommandUncertain(
  input: CancellationCommandRecord,
  failure: string,
  uncertainAt: string,
): UncertainCancellationCommand {
  const current = parseSupervisorCommandRecord(input);
  if (current.type !== "cancel") {
    throw new TypeError("expected a cancellation command record");
  }
  return Object.freeze(
    cancellationCommandRecordSchema.parse({
      ...cancellationCommandBase(current),
      status: "uncertain",
      uncertainAt,
      failure,
    }),
  ) as UncertainCancellationCommand;
}

export function createSubmissionCommandRecord(
  input: CreateSubmissionCommandInput,
): RecordedSubmissionCommand {
  const identity = {
    version: 1 as const,
    commandId: input.commandId,
    type: "submit" as const,
    policyDigest: input.policyDigest,
    runId: input.runId,
    mode: input.mode,
    sourceName: input.sourceName,
    workflowSourceDigest: createHash("sha256").update(input.workflowSource).digest("hex"),
    cwd: input.cwd,
  };
  return deepFreeze(
    submissionCommandRecordSchema.parse({
      ...identity,
      requestDigest: calculateSubmissionCommandDigest(identity),
      recordedAt: input.recordedAt,
      status: "recorded",
    }),
  ) as RecordedSubmissionCommand;
}

export function completeSubmissionCommand(
  input: SubmissionCommandRecord,
  result: CompletedSubmissionCommand["result"],
  completedAt: string,
): CompletedSubmissionCommand {
  const current = parseSubmissionCommandRecord(input);
  return deepFreeze(
    submissionCommandRecordSchema.parse({
      ...submissionCommandBase(current),
      status: "completed",
      completedAt,
      result,
    }),
  ) as CompletedSubmissionCommand;
}

export function queueSubmissionCommand(
  input: SubmissionCommandRecord,
  queuePosition: number,
  queuedAt: string,
): QueuedSubmissionCommand {
  const current = parseSubmissionCommandRecord(input);
  return deepFreeze(
    submissionCommandRecordSchema.parse({
      ...submissionCommandBase(current),
      status: "queued",
      queuedAt,
      result: { queuePosition },
    }),
  ) as QueuedSubmissionCommand;
}

export function rejectSubmissionCommand(
  input: SubmissionCommandRecord,
  failure: string,
  rejectedAt: string,
  reason: RejectedSubmissionCommand["reason"] = "conflict",
): RejectedSubmissionCommand {
  const current = parseSubmissionCommandRecord(input);
  return Object.freeze(
    submissionCommandRecordSchema.parse({
      ...submissionCommandBase(current),
      status: "rejected",
      reason,
      rejectedAt,
      failure,
    }),
  ) as RejectedSubmissionCommand;
}

export function markSubmissionCommandUncertain(
  input: SubmissionCommandRecord,
  failure: string,
  uncertainAt: string,
): UncertainSubmissionCommand {
  const current = parseSubmissionCommandRecord(input);
  return Object.freeze(
    submissionCommandRecordSchema.parse({
      ...submissionCommandBase(current),
      status: "uncertain",
      uncertainAt,
      failure,
    }),
  ) as UncertainSubmissionCommand;
}

export function parseSupervisorCommandRecord(input: unknown): SupervisorCommandRecord {
  return deepFreeze(supervisorCommandRecordSchema.parse(input));
}

export function parseSubmissionCommandRecord(input: unknown): SubmissionCommandRecord {
  return deepFreeze(submissionCommandRecordSchema.parse(input));
}

export function calculateCancellationCommandDigest(input: CancellationCommandIdentity): string {
  const canonical = {
    version: input.version,
    commandId: input.commandId,
    type: input.type,
    runId: input.runId,
    actor: input.actor,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function calculateSubmissionCommandDigest(input: SubmissionCommandIdentity): string {
  const canonical = {
    version: input.version,
    commandId: input.commandId,
    type: input.type,
    policyDigest: input.policyDigest,
    runId: input.runId,
    mode: input.mode,
    sourceName: input.sourceName,
    workflowSourceDigest: input.workflowSourceDigest,
    cwd: input.cwd,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function supervisorSocketPath(runsDirectory: string, uid = currentUid()): string {
  const digest = createHash("sha256").update(resolve(runsDirectory)).digest("hex").slice(0, 24);
  return join(socketRoot(uid), `s-${digest}.sock`);
}

export function workerSocketPath(workerId: string, uid = currentUid()): string {
  const parsedWorkerId = uuidSchema.parse(workerId);
  const digest = createHash("sha256").update(parsedWorkerId).digest("hex").slice(0, 24);
  return join(socketRoot(uid), `w-${digest}.sock`);
}

export function socketRoot(uid = currentUid()): string {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new RangeError("uid must be a non-negative safe integer");
  }
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
  return `${temporaryRoot}/flow-harness-${uid}`;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("detached supervision requires a POSIX user id");
  }
  return uid;
}

function cancellationCommandBase(record: CancellationCommandRecord): CancellationCommandBase {
  return {
    version: record.version,
    commandId: record.commandId,
    type: record.type,
    runId: record.runId,
    actor: record.actor,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    requestDigest: record.requestDigest,
    recordedAt: record.recordedAt,
  };
}

function submissionCommandBase(record: SubmissionCommandRecord): SubmissionCommandBase {
  return {
    version: record.version,
    commandId: record.commandId,
    type: record.type,
    policyDigest: record.policyDigest,
    runId: record.runId,
    mode: record.mode,
    sourceName: record.sourceName,
    workflowSourceDigest: record.workflowSourceDigest,
    cwd: record.cwd,
    requestDigest: record.requestDigest,
    recordedAt: record.recordedAt,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
