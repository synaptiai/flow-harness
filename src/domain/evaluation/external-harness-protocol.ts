import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { parseStrictJson } from "../strict-json.js";
import {
  type EvaluationHarnessOutcome,
  type EvaluationMetrics,
  parseEvaluationHarnessOutcome,
  parseEvaluationMetrics,
} from "./records.js";

export const MAX_EXTERNAL_HARNESS_FRAME_BYTES = 1_048_576;
export const MAX_EXTERNAL_HARNESS_DIAGNOSTIC_BYTES = 16_384;
export const MAX_EXTERNAL_HARNESS_EVENT_MESSAGE_BYTES = 4_096;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sessionIdSchema = z.uuid();
const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const readyFrameSchema = frameSchema(
  "ready",
  z
    .object({ trialId: z.string().regex(/^trial-[a-f0-9]{48}$/), identityDigest: sha256Schema })
    .strict(),
);
const eventFrameSchema = frameSchema(
  "event",
  z
    .object({
      category: z.enum(["progress", "diagnostic"]),
      message: z
        .string()
        .max(MAX_EXTERNAL_HARNESS_EVENT_MESSAGE_BYTES)
        .refine(
          (value) => Buffer.byteLength(value, "utf8") <= MAX_EXTERNAL_HARNESS_EVENT_MESSAGE_BYTES,
          `event message exceeds ${MAX_EXTERNAL_HARNESS_EVENT_MESSAGE_BYTES} UTF-8 bytes`,
        ),
    })
    .strict(),
);
const inferenceRequestFrameSchema = frameSchema(
  "inference_request",
  z
    .object({
      requestId: z.uuid(),
      body: z.string().max(MAX_EXTERNAL_HARNESS_FRAME_BYTES),
      bodySha256: sha256Schema,
    })
    .strict(),
);
const terminalFrameSchema = frameSchema(
  "terminal",
  z
    .object({
      harness: z.unknown(),
      metrics: z.unknown(),
    })
    .strict(),
);

const driverFrameSchema = z.discriminatedUnion("type", [
  readyFrameSchema,
  eventFrameSchema,
  inferenceRequestFrameSchema,
  terminalFrameSchema,
]);

const evaluationInputSchema = z
  .object({
    planDigest: sha256Schema,
    trial: z
      .object({
        trialId: z.string().regex(/^trial-[a-f0-9]{48}$/),
        position: z.number().int().positive().max(4_096),
        taskId: z.string().min(1).max(64),
        profileId: z.string().min(1).max(64),
        seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        repetition: z.number().int().positive().max(32),
      })
      .strict(),
    workspace: z
      .object({
        workspaceId: z.string().min(1).max(128),
        cwd: z.string().min(1).max(4_096),
        backend: z.literal("reflink-copy-v1"),
        snapshotDigest: sha256Schema,
      })
      .strict(),
    instruction: z.object({ path: z.string().min(1).max(1_024), sha256: sha256Schema }).strict(),
    controls: z
      .object({
        model: z
          .object({
            provider: z.string().min(1).max(128),
            id: z.string().min(1).max(256),
            thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
          })
          .strict(),
        budget: z
          .object({
            maxNodeStarts: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            maxModelTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            maxCostUsdMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            maxExecutionMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            maxArtifactBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
        network: z.literal("deny"),
        retry: z.object({ providerRetries: z.literal(0), harnessRetries: z.literal(0) }).strict(),
      })
      .strict(),
  })
  .strict();

const parentHelloFrameSchema = parentFrameSchema(
  "hello",
  z
    .object({
      secretHex: z.string().regex(/^[a-f0-9]{64}$/),
      trialId: z.string().regex(/^trial-[a-f0-9]{48}$/),
      identityDigest: sha256Schema,
      evaluation: evaluationInputSchema,
      instructionText: z.string().max(MAX_EXTERNAL_HARNESS_FRAME_BYTES),
    })
    .strict(),
);
const parentInferenceResponseFrameSchema = parentFrameSchema(
  "inference_response",
  z
    .object({
      requestId: z.uuid(),
      body: z.string().max(MAX_EXTERNAL_HARNESS_FRAME_BYTES),
      bodySha256: sha256Schema,
    })
    .strict(),
);
const parentCancelFrameSchema = parentFrameSchema(
  "cancel",
  z.object({ reason: z.string().min(1).max(4_096) }).strict(),
);
const parentFrameUnionSchema = z.discriminatedUnion("type", [
  parentHelloFrameSchema,
  parentInferenceResponseFrameSchema,
  parentCancelFrameSchema,
]);

export type ExternalHarnessEvaluationInput = z.infer<typeof evaluationInputSchema>;
export type ExternalHarnessParentFrame = z.infer<typeof parentFrameUnionSchema>;

export type ExternalHarnessProtocolState = "awaiting_ready" | "running" | "terminal";

export type ExternalHarnessDriverEvent =
  | { readonly type: "ready"; readonly trialId: string; readonly identityDigest: string }
  | {
      readonly type: "event";
      readonly category: "progress" | "diagnostic";
      readonly message: string;
    }
  | {
      readonly type: "inference_request";
      readonly requestId: string;
      readonly body: string;
      readonly bodySha256: string;
    }
  | {
      readonly type: "terminal";
      readonly harness: EvaluationHarnessOutcome;
      readonly metrics: EvaluationMetrics;
    };

export type ExternalHarnessProtocolErrorCode =
  | "frame_invalid"
  | "frame_limit"
  | "frame_forged"
  | "sequence_invalid"
  | "state_invalid"
  | "identity_mismatch"
  | "evidence_invalid";

export class ExternalHarnessProtocolError extends Error {
  override readonly name = "ExternalHarnessProtocolError";

  constructor(
    readonly code: ExternalHarnessProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${boundedMessage(message)}`, options);
  }
}

export interface ExternalHarnessProtocolSessionInput {
  readonly sessionId: string;
  readonly secretHex: string;
  readonly trialId: string;
  readonly identityDigest: string;
}

export class ExternalHarnessProtocolSession {
  readonly #sessionId: string;
  readonly #secretHex: string;
  readonly #trialId: string;
  readonly #identityDigest: string;
  readonly #seenRequestIds = new Set<string>();
  #expectedSequence = 1;
  #pendingRequestId: string | null = null;
  #state: ExternalHarnessProtocolState = "awaiting_ready";

  constructor(input: ExternalHarnessProtocolSessionInput) {
    this.#sessionId = sessionIdSchema.parse(input.sessionId);
    this.#secretHex = parseSecret(input.secretHex);
    this.#trialId = z
      .string()
      .regex(/^trial-[a-f0-9]{48}$/)
      .parse(input.trialId);
    this.#identityDigest = sha256Schema.parse(input.identityDigest);
  }

  get state(): ExternalHarnessProtocolState {
    return this.#state;
  }

  acceptDriverLine(line: string): ExternalHarnessDriverEvent {
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes === 0 || bytes > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
      throw new ExternalHarnessProtocolError(
        "frame_limit",
        `driver frame must contain 1 to ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} UTF-8 bytes`,
      );
    }
    let input: unknown;
    try {
      input = parseStrictJson(line, {
        maxDepth: 32,
        maxNodes: 200_000,
        valueLabel: "external harness driver frame",
      });
    } catch (error) {
      throw new ExternalHarnessProtocolError("frame_invalid", "driver frame is not strict JSON", {
        cause: error,
      });
    }
    const parsed = driverFrameSchema.safeParse(input);
    if (!parsed.success) {
      throw new ExternalHarnessProtocolError(
        "frame_invalid",
        "driver frame does not match the closed protocol schema",
        { cause: parsed.error },
      );
    }
    const frame = parsed.data;
    if (frame.sessionId !== this.#sessionId) {
      throw new ExternalHarnessProtocolError(
        "identity_mismatch",
        "driver frame session id does not match the active session",
      );
    }
    if (!verifyFrameMac(frame, this.#secretHex)) {
      throw new ExternalHarnessProtocolError(
        "frame_forged",
        "driver frame authentication code is invalid",
      );
    }
    if (frame.sequence !== this.#expectedSequence) {
      throw new ExternalHarnessProtocolError(
        "sequence_invalid",
        `driver frame sequence must be ${this.#expectedSequence}`,
      );
    }

    const event = this.#acceptState(frame);
    this.#expectedSequence += 1;
    return event;
  }

  completeInference(requestId: string): void {
    if (this.#state !== "running" || this.#pendingRequestId !== requestId) {
      throw new ExternalHarnessProtocolError(
        "state_invalid",
        "inference response does not match the pending request",
      );
    }
    this.#pendingRequestId = null;
  }

  #acceptState(frame: z.infer<typeof driverFrameSchema>): ExternalHarnessDriverEvent {
    switch (frame.type) {
      case "ready": {
        if (this.#state !== "awaiting_ready") {
          throw new ExternalHarnessProtocolError("state_invalid", "ready frame is out of state");
        }
        if (
          frame.payload.trialId !== this.#trialId ||
          frame.payload.identityDigest !== this.#identityDigest
        ) {
          throw new ExternalHarnessProtocolError(
            "identity_mismatch",
            "ready frame does not match the admitted trial and harness identity",
          );
        }
        this.#state = "running";
        return Object.freeze({ type: "ready", ...frame.payload });
      }
      case "event": {
        this.#requireRunning("event");
        return Object.freeze({ type: "event", ...frame.payload });
      }
      case "inference_request": {
        this.#requireRunning("inference request");
        if (this.#pendingRequestId !== null) {
          throw new ExternalHarnessProtocolError(
            "state_invalid",
            "another inference request is pending",
          );
        }
        if (this.#seenRequestIds.has(frame.payload.requestId)) {
          throw new ExternalHarnessProtocolError(
            "sequence_invalid",
            "inference request id was already used",
          );
        }
        if (sha256(frame.payload.body) !== frame.payload.bodySha256) {
          throw new ExternalHarnessProtocolError(
            "evidence_invalid",
            "inference request body digest does not match its exact bytes",
          );
        }
        this.#seenRequestIds.add(frame.payload.requestId);
        this.#pendingRequestId = frame.payload.requestId;
        return Object.freeze({ type: "inference_request", ...frame.payload });
      }
      case "terminal": {
        this.#requireRunning("terminal result");
        if (this.#pendingRequestId !== null) {
          throw new ExternalHarnessProtocolError(
            "state_invalid",
            "terminal result cannot arrive while inference is pending",
          );
        }
        let harness: EvaluationHarnessOutcome;
        let metrics: EvaluationMetrics;
        try {
          harness = parseEvaluationHarnessOutcome(frame.payload.harness);
          metrics = parseEvaluationMetrics(frame.payload.metrics);
        } catch (error) {
          throw new ExternalHarnessProtocolError(
            "evidence_invalid",
            "terminal harness or metric evidence is invalid",
            { cause: error },
          );
        }
        this.#state = "terminal";
        return Object.freeze({
          type: "terminal",
          harness,
          metrics,
        });
      }
    }
  }

  #requireRunning(label: string): void {
    if (this.#state !== "running") {
      throw new ExternalHarnessProtocolError(
        "state_invalid",
        `${label} requires an authenticated ready frame`,
      );
    }
  }
}

export interface UnsignedExternalHarnessDriverFrame {
  readonly version: 1;
  readonly sequence: number;
  readonly sessionId: string;
  readonly type: "ready" | "event" | "inference_request" | "terminal";
  readonly payload: unknown;
}

export interface UnsignedExternalHarnessParentFrame {
  readonly version: 1;
  readonly sequence: number;
  readonly sessionId: string;
  readonly type: "hello" | "inference_response" | "cancel";
  readonly payload: unknown;
}

export function signExternalHarnessDriverFrame(
  frame: UnsignedExternalHarnessDriverFrame,
  secretHex: string,
): UnsignedExternalHarnessDriverFrame & { readonly mac: string } {
  const secret = parseSecret(secretHex);
  const unsigned = deepFreeze({ ...frame });
  return deepFreeze({ ...unsigned, mac: calculateFrameMac(unsigned, secret) });
}

export function signExternalHarnessParentFrame(
  frame: UnsignedExternalHarnessParentFrame,
  secretHex: string,
): UnsignedExternalHarnessParentFrame & { readonly mac: string } {
  const secret = parseSecret(secretHex);
  const unsigned = deepFreeze({ ...frame });
  return deepFreeze({ ...unsigned, mac: calculateFrameMac(unsigned, secret) });
}

export function parseExternalHarnessParentLine(
  line: string,
  expectedSecretHex?: string,
): ExternalHarnessParentFrame {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes === 0 || bytes > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
    throw new ExternalHarnessProtocolError(
      "frame_limit",
      `parent frame must contain 1 to ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} UTF-8 bytes`,
    );
  }
  let input: unknown;
  try {
    input = parseStrictJson(line, {
      maxDepth: 32,
      maxNodes: 200_000,
      valueLabel: "external harness parent frame",
    });
  } catch (error) {
    throw new ExternalHarnessProtocolError("frame_invalid", "parent frame is not strict JSON", {
      cause: error,
    });
  }
  const parsed = parentFrameUnionSchema.safeParse(input);
  if (!parsed.success) {
    throw new ExternalHarnessProtocolError(
      "frame_invalid",
      "parent frame does not match the closed protocol schema",
      { cause: parsed.error },
    );
  }
  const frame = parsed.data;
  const secretHex =
    frame.type === "hello"
      ? frame.payload.secretHex
      : expectedSecretHex === undefined
        ? undefined
        : parseSecret(expectedSecretHex);
  if (secretHex === undefined) {
    throw new ExternalHarnessProtocolError(
      "frame_invalid",
      "parent frame requires the active protocol secret",
    );
  }
  if (
    frame.type === "hello" &&
    expectedSecretHex !== undefined &&
    frame.payload.secretHex !== parseSecret(expectedSecretHex)
  ) {
    throw new ExternalHarnessProtocolError(
      "identity_mismatch",
      "parent hello secret does not match the active session",
    );
  }
  if (!verifyFrameMac(frame, secretHex)) {
    throw new ExternalHarnessProtocolError(
      "frame_forged",
      "parent frame authentication code is invalid",
    );
  }
  if (
    frame.type === "inference_response" &&
    sha256(frame.payload.body) !== frame.payload.bodySha256
  ) {
    throw new ExternalHarnessProtocolError(
      "evidence_invalid",
      "inference response body digest does not match its exact bytes",
    );
  }
  return deepFreeze(frame);
}

function frameSchema<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z
    .object({
      version: z.literal(1),
      sequence: sequenceSchema,
      sessionId: sessionIdSchema,
      type: z.literal(type),
      payload,
      mac: sha256Schema,
    })
    .strict();
}

function parentFrameSchema<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z
    .object({
      version: z.literal(1),
      sequence: sequenceSchema,
      sessionId: sessionIdSchema,
      type: z.literal(type),
      payload,
      mac: sha256Schema,
    })
    .strict();
}

function verifyFrameMac(
  frame: z.infer<typeof driverFrameSchema> | z.infer<typeof parentFrameUnionSchema>,
  secretHex: string,
): boolean {
  const { mac, ...unsigned } = frame;
  const expected = Buffer.from(calculateFrameMac(unsigned, secretHex), "hex");
  const observed = Buffer.from(mac, "hex");
  return expected.length === observed.length && timingSafeEqual(expected, observed);
}

function calculateFrameMac(frame: object, secretHex: string): string {
  return createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(canonicalize(frame))
    .digest("hex");
}

function parseSecret(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ExternalHarnessProtocolError(
      "frame_invalid",
      "protocol secret must contain 32 hexadecimal bytes",
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new ExternalHarnessProtocolError("frame_invalid", "protocol frame is not canonical JSON");
}

function boundedMessage(message: string): string {
  const bytes = Buffer.from(message, "utf8");
  if (bytes.length <= MAX_EXTERNAL_HARNESS_DIAGNOSTIC_BYTES) {
    return message;
  }
  return `${bytes.subarray(0, MAX_EXTERNAL_HARNESS_DIAGNOSTIC_BYTES - 3).toString("utf8")}...`;
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
