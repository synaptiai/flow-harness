import { isAbsolute } from "node:path";
import { z } from "zod";

import { parsePromptActivationLocator } from "../domain/adaptation/prompt-activation.js";
import { persistedCapabilitySnapshotSchema } from "../domain/capability/agent-skills.js";
import { parseWorkflowPackageLocator } from "../domain/capability/workflow-packages.js";
import { MAX_ACTIVE_WORKERS, MAX_QUEUED_JOBS } from "../domain/config/resolver.js";
import { type RunEvent, type RunStatus, runEventSchema } from "../domain/run/events.js";

export const SUPERVISOR_PROTOCOL_VERSION = 2 as const;
export const MAX_SUPERVISOR_FRAME_BYTES = 40 * 1024 * 1024;
export const MAX_SUPERVISOR_EVENT_PAGE = 256;
export const MAX_WORKFLOW_SOURCE_CHARACTERS = 20_000_000;

const uuidSchema = z.uuid();
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "must be a valid run id");
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value), "must be an absolute path");
const protectedPathsSchema = z
  .array(absolutePathSchema)
  .min(1)
  .max(16)
  .refine((paths) => new Set(paths).size === paths.length, "protected paths must be unique");
const workflowSourceNameSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    isWorkflowSourceName,
    "must be an absolute path, exact workflow package locator, or exact activation locator",
  );
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
const reasonSchema = z.string().trim().min(1).max(4096);
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a 256-bit hexadecimal token");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sequenceSchema = z.number().int().nonnegative().safe();

const submitCommandSchema = z
  .object({
    type: z.literal("submit"),
    policyDigest: digestSchema,
    commandId: uuidSchema,
    mode: z.enum(["run", "resume"]),
    runId: runIdSchema,
    sourceName: workflowSourceNameSchema,
    workflowSource: z.string().min(1).max(MAX_WORKFLOW_SOURCE_CHARACTERS),
    cwd: absolutePathSchema,
    projectRoot: absolutePathSchema.optional(),
    protectedPaths: protectedPathsSchema.optional(),
    capabilitySnapshot: persistedCapabilitySnapshotSchema.optional(),
  })
  .strict();

function isWorkflowSourceName(value: string): boolean {
  if (isAbsolute(value)) {
    return true;
  }
  try {
    return (
      parseWorkflowPackageLocator(value) !== null || parsePromptActivationLocator(value) !== null
    );
  } catch {
    return false;
  }
}

const cancelCommandSchema = z
  .object({
    type: z.literal("cancel"),
    policyDigest: digestSchema,
    commandId: uuidSchema,
    runId: runIdSchema,
    actor: actorSchema,
    reason: reasonSchema.optional(),
  })
  .strict();

const eventsCommandSchema = z
  .object({
    type: z.literal("events"),
    policyDigest: digestSchema,
    runId: runIdSchema,
    afterSequence: sequenceSchema,
    limit: z.number().int().positive().max(MAX_SUPERVISOR_EVENT_PAGE),
  })
  .strict();

const supervisorRequestSchema = z
  .object({
    version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
    requestId: uuidSchema,
    command: z.discriminatedUnion("type", [
      z.object({ type: z.literal("status") }).strict(),
      submitCommandSchema,
      cancelCommandSchema,
      eventsCommandSchema,
      z
        .object({
          type: z.literal("shutdown"),
          commandId: uuidSchema,
          policyDigest: digestSchema,
        })
        .strict(),
    ]),
  })
  .strict();

const workerSummarySchema = z
  .object({
    workerId: uuidSchema,
    runId: runIdSchema,
    pid: z.number().int().positive().safe().nullable(),
    status: z.enum(["starting", "running", "waiting", "terminal", "unreachable", "uncertain"]),
    runStatus: z
      .enum([
        "running",
        "waiting_for_approval",
        "succeeded",
        "failed",
        "cancelled",
        "resource_exhausted",
      ])
      .nullable(),
  })
  .strict();

const acceptedResultSchema = z
  .object({
    type: z.literal("accepted"),
    commandId: uuidSchema,
    runId: runIdSchema,
    workerId: uuidSchema,
    acceptedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const queuedResultSchema = z
  .object({
    type: z.literal("queued"),
    commandId: uuidSchema,
    runId: runIdSchema,
    queuePosition: z.number().int().positive().safe(),
    queuedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const rejectedResultSchema = z
  .object({
    type: z.literal("rejected"),
    commandId: uuidSchema,
    runId: runIdSchema,
    reason: z.enum(["queue_full", "cancelled"]),
    rejectedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const cancelledResultSchema = z
  .object({
    type: z.literal("cancelled"),
    commandId: uuidSchema,
    runId: runIdSchema,
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
  });

const eventsResultSchema = z
  .object({
    type: z.literal("events"),
    runId: runIdSchema,
    afterSequence: sequenceSchema,
    cursor: sequenceSchema,
    events: z.array(runEventSchema).max(MAX_SUPERVISOR_EVENT_PAGE),
    terminal: z.boolean(),
  })
  .strict();

const supervisorResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("status"),
      generation: uuidSchema,
      pid: z.number().int().positive().safe(),
      startedAt: z.iso.datetime({ offset: true }),
      policyDigest: digestSchema,
      limits: z
        .object({
          maxActiveWorkers: z.number().int().positive().safe().max(MAX_ACTIVE_WORKERS),
          maxQueuedJobs: z.number().int().nonnegative().safe().max(MAX_QUEUED_JOBS),
        })
        .strict(),
      admission: z
        .object({
          activeWorkers: z.number().int().nonnegative().safe().max(MAX_ACTIVE_WORKERS),
          queuedJobs: z.number().int().nonnegative().safe().max(MAX_QUEUED_JOBS),
        })
        .strict(),
      workers: z.array(workerSummarySchema).max(MAX_ACTIVE_WORKERS),
    })
    .strict(),
  acceptedResultSchema,
  queuedResultSchema,
  rejectedResultSchema,
  cancelledResultSchema,
  eventsResultSchema,
  z.object({ type: z.literal("shutdown"), stopped: z.literal(true) }).strict(),
]);

export const supervisorErrorCodeSchema = z.enum([
  "active_workers",
  "command_uncertain",
  "conflict",
  "identity_mismatch",
  "internal",
  "not_found",
  "policy_mismatch",
  "protocol_invalid",
  "protocol_version",
  "worker_unavailable",
]);

const supervisorResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
      requestId: uuidSchema,
      ok: z.literal(true),
      result: supervisorResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
      requestId: uuidSchema,
      ok: z.literal(false),
      error: z
        .object({
          code: supervisorErrorCodeSchema,
          message: z.string().min(1).max(16_384),
        })
        .strict(),
    })
    .strict(),
]);

const workerRequestSchema = z
  .object({
    version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
    requestId: uuidSchema,
    workerId: uuidSchema,
    token: tokenSchema,
    command: z.discriminatedUnion("type", [
      z.object({ type: z.literal("identify") }).strict(),
      z
        .object({
          type: z.literal("cancel"),
          commandId: uuidSchema,
          actor: actorSchema,
          reason: reasonSchema.optional(),
        })
        .strict(),
    ]),
  })
  .strict();

const workerIdentityResultSchema = z
  .object({
    type: z.literal("identity"),
    workerId: uuidSchema,
    runId: runIdSchema,
    pid: z.number().int().positive().safe(),
    jobDigest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["starting", "running", "waiting", "terminal", "failed"]),
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
  })
  .strict();

const workerResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
      requestId: uuidSchema,
      ok: z.literal(true),
      result: z.discriminatedUnion("type", [workerIdentityResultSchema, cancelledResultSchema]),
    })
    .strict(),
  z
    .object({
      version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
      requestId: uuidSchema,
      ok: z.literal(false),
      error: z
        .object({
          code: supervisorErrorCodeSchema,
          message: z.string().min(1).max(16_384),
        })
        .strict(),
    })
    .strict(),
]);

export type SupervisorRequest = z.infer<typeof supervisorRequestSchema>;
export type SupervisorResponse = z.infer<typeof supervisorResponseSchema>;
export type SupervisorResult = z.infer<typeof supervisorResultSchema>;
export type SupervisorErrorCode = z.infer<typeof supervisorErrorCodeSchema>;
export type WorkerRequest = z.infer<typeof workerRequestSchema>;
export type WorkerResponse = z.infer<typeof workerResponseSchema>;
export type SubmitCommand = z.infer<typeof submitCommandSchema>;
export type CancelCommand = z.infer<typeof cancelCommandSchema>;
export type EventsCommand = z.infer<typeof eventsCommandSchema>;
export type AcceptedResult = z.infer<typeof acceptedResultSchema>;
export type QueuedResult = z.infer<typeof queuedResultSchema>;
export type RejectedResult = z.infer<typeof rejectedResultSchema>;
export type SubmissionResult = AcceptedResult | QueuedResult | RejectedResult;
export type CancelledResult = z.infer<typeof cancelledResultSchema>;
export type EventsResult = Omit<z.infer<typeof eventsResultSchema>, "events"> & {
  readonly events: readonly RunEvent[];
};
export type WorkerSummary = Omit<z.infer<typeof workerSummarySchema>, "runStatus"> & {
  readonly runStatus: RunStatus | null;
};

export type SupervisorProtocolErrorCode =
  | "frame_encoding"
  | "frame_invalid"
  | "frame_limit"
  | "message_invalid";

export class SupervisorProtocolError extends Error {
  override readonly name = "SupervisorProtocolError";

  constructor(
    readonly code: SupervisorProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function encodeSupervisorMessage(message: unknown): string {
  let encoded: string;
  try {
    encoded = `${JSON.stringify(message)}\n`;
  } catch (error) {
    throw new SupervisorProtocolError("message_invalid", "message is not JSON serializable", {
      cause: error,
    });
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_SUPERVISOR_FRAME_BYTES) {
    throw new SupervisorProtocolError(
      "frame_limit",
      `message exceeds the maximum frame size of ${MAX_SUPERVISOR_FRAME_BYTES} bytes`,
    );
  }
  return encoded;
}

export function parseSupervisorRequestFrame(frame: string | Uint8Array): SupervisorRequest {
  return parseFrame(supervisorRequestSchema, frame);
}

export function parseSupervisorResponseFrame(frame: string | Uint8Array): SupervisorResponse {
  return parseFrame(supervisorResponseSchema, frame);
}

export function parseWorkerRequestFrame(frame: string | Uint8Array): WorkerRequest {
  return parseFrame(workerRequestSchema, frame);
}

export function parseWorkerResponseFrame(frame: string | Uint8Array): WorkerResponse {
  return parseFrame(workerResponseSchema, frame);
}

function parseFrame<T>(schema: z.ZodType<T>, frame: string | Uint8Array): T {
  const byteLength =
    typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : frame.byteLength;
  if (byteLength > MAX_SUPERVISOR_FRAME_BYTES) {
    throw new SupervisorProtocolError(
      "frame_limit",
      `frame exceeds the maximum size of ${MAX_SUPERVISOR_FRAME_BYTES} bytes`,
    );
  }

  let text: string;
  try {
    text =
      typeof frame === "string" ? frame : new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch (error) {
    throw new SupervisorProtocolError("frame_encoding", "frame is not valid UTF-8", {
      cause: error,
    });
  }

  if (!text.endsWith("\n") || text.includes("\r")) {
    throw new SupervisorProtocolError(
      "frame_invalid",
      "frame must contain exactly one LF-terminated JSON message",
    );
  }
  const body = text.slice(0, -1);
  if (body.length === 0 || body.includes("\n")) {
    throw new SupervisorProtocolError(
      "frame_invalid",
      "frame must contain exactly one LF-terminated JSON message",
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch (error) {
    throw new SupervisorProtocolError("frame_invalid", "frame contains invalid JSON", {
      cause: error,
    });
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "message"}: ${issue.message}`)
      .join("; ");
    throw new SupervisorProtocolError("message_invalid", `message is invalid: ${details}`, {
      cause: result.error,
    });
  }
  return result.data;
}
