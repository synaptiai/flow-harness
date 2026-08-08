import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import type {
  AgentCommandApprovalDecision,
  AgentCommandApprovalDecisionChannel,
  AgentCommandApprovalWait,
} from "../../application/ports.js";
import { AgentCommandApprovalDecisionSourceError } from "../../application/ports.js";
import { calculateAgentCommandApprovalRequestDigest } from "../../domain/approval/command-approval.js";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_DECISION_RECEIPT_BYTES = 16_384;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const decisionSchema = z
  .object({
    version: z.literal(1),
    runId: identifierSchema,
    requestId: identifierSchema,
    requestDigest: digestSchema,
    operationDigest: digestSchema,
    decision: z.enum(["approve", "deny"]),
    actor: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine(
        (actor) =>
          !Array.from(actor).some((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
          }),
        "approval actor must not contain control characters",
      ),
    reason: z.string().trim().min(1).max(4096).optional(),
    submittedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.decision === "approve" && decision.reason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "approval decisions cannot carry a denial reason",
      });
    }
  });

export type LocalAgentCommandApprovalChannelErrorCode =
  | "decision_exists"
  | "decision_invalid"
  | "decision_mismatch"
  | "io";

export class LocalAgentCommandApprovalChannelError extends Error {
  override readonly name = "LocalAgentCommandApprovalChannelError";

  constructor(
    readonly code: LocalAgentCommandApprovalChannelErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class LocalAgentCommandApprovalChannel implements AgentCommandApprovalDecisionChannel {
  constructor(
    readonly rootDirectory: string,
    readonly pollIntervalMs = 50,
  ) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 1_000) {
      throw new RangeError("approval channel poll interval must be between 1 and 1000ms");
    }
  }

  async submitDecision(input: AgentCommandApprovalDecision): Promise<void> {
    const decision = parseDecision(input);
    const path = this.#decisionPath(decision.runId, decision.requestId);
    const directory = dirname(path);
    const temporaryPath = join(directory, `.${decision.requestId}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(decision)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new LocalAgentCommandApprovalChannelError(
            "decision_exists",
            `approval decision "${decision.requestId}" already exists for run "${decision.runId}"`,
            { cause: error },
          );
        }
        throw error;
      }
      await syncDirectory(directory);
    } catch (error) {
      if (error instanceof LocalAgentCommandApprovalChannelError) {
        throw error;
      }
      throw new LocalAgentCommandApprovalChannelError(
        "io",
        `failed to publish approval decision "${decision.requestId}" for run "${decision.runId}"`,
        { cause: error },
      );
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async waitForDecision(
    wait: AgentCommandApprovalWait,
    signal?: AbortSignal,
  ): Promise<AgentCommandApprovalDecision> {
    validateWait(wait);
    const path = this.#decisionPath(wait.request.runId, wait.requestId);
    while (true) {
      throwIfAborted(signal);
      let contents: string;
      try {
        contents = await readBoundedUtf8File(path, MAX_DECISION_RECEIPT_BYTES);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          await abortableDelay(this.pollIntervalMs, signal);
          continue;
        }
        if (
          error instanceof LocalAgentCommandApprovalChannelError &&
          (error.code === "decision_invalid" || error.code === "decision_mismatch")
        ) {
          throw new AgentCommandApprovalDecisionSourceError(
            "decision_invalid",
            error.message,
            this.pollIntervalMs,
            { cause: error },
          );
        }
        throw new AgentCommandApprovalDecisionSourceError(
          "temporarily_unavailable",
          `failed to read approval decision "${wait.requestId}" for run "${wait.request.runId}"`,
          this.pollIntervalMs,
          { cause: error },
        );
      }
      throwIfAborted(signal);

      let decision: AgentCommandApprovalDecision;
      try {
        decision = parseDecision(JSON.parse(contents));
      } catch (error) {
        throw new AgentCommandApprovalDecisionSourceError(
          "decision_invalid",
          `approval decision "${wait.requestId}" is not a valid immutable receipt`,
          this.pollIntervalMs,
          { cause: error },
        );
      }
      if (
        decision.runId !== wait.request.runId ||
        decision.requestId !== wait.requestId ||
        decision.requestDigest !== wait.requestDigest ||
        decision.operationDigest !== wait.request.operationDigest
      ) {
        throw new AgentCommandApprovalDecisionSourceError(
          "decision_invalid",
          `approval decision "${wait.requestId}" does not match the exact pending request`,
          this.pollIntervalMs,
        );
      }
      throwIfAborted(signal);
      return decision;
    }
  }

  #decisionPath(runId: string, requestId: string): string {
    const parsedRunId = identifierSchema.parse(runId);
    const parsedRequestId = identifierSchema.parse(requestId);
    return join(
      this.rootDirectory,
      parsedRunId,
      "agent-command-approvals",
      `${parsedRequestId}.decision.json`,
    );
  }
}

async function readBoundedUtf8File(path: string, maximumBytes: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new LocalAgentCommandApprovalChannelError(
        "decision_invalid",
        "agent command approval decision must be a no-follow regular file",
        { cause: error },
      );
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new LocalAgentCommandApprovalChannelError(
        "decision_invalid",
        "agent command approval decision must be a no-follow regular file",
      );
    }
    if (metadata.size > maximumBytes) {
      throw new LocalAgentCommandApprovalChannelError(
        "decision_invalid",
        `agent command approval decision exceeds ${maximumBytes} bytes`,
      );
    }
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      throw new LocalAgentCommandApprovalChannelError(
        "decision_invalid",
        `agent command approval decision exceeds ${maximumBytes} bytes`,
      );
    }
    try {
      return fatalUtf8Decoder.decode(buffer.subarray(0, offset));
    } catch (error) {
      throw new LocalAgentCommandApprovalChannelError(
        "decision_invalid",
        "agent command approval decision must contain valid UTF-8",
        { cause: error },
      );
    }
  } finally {
    await handle.close();
  }
}

function parseDecision(input: unknown): AgentCommandApprovalDecision {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) {
    throw new LocalAgentCommandApprovalChannelError(
      "decision_invalid",
      `agent command approval decision is invalid: ${z.prettifyError(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze({
    version: parsed.data.version,
    runId: parsed.data.runId,
    requestId: parsed.data.requestId,
    requestDigest: parsed.data.requestDigest,
    operationDigest: parsed.data.operationDigest,
    decision: parsed.data.decision,
    actor: parsed.data.actor,
    ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
    submittedAt: parsed.data.submittedAt,
  });
}

function validateWait(wait: AgentCommandApprovalWait): void {
  if (
    !identifierSchema.safeParse(wait.requestId).success ||
    wait.requestDigest !== calculateAgentCommandApprovalRequestDigest(wait.request)
  ) {
    throw new AgentCommandApprovalDecisionSourceError(
      "decision_invalid",
      "agent command approval wait does not contain a valid exact request",
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const onAbort = () => done(signal?.reason ?? new Error("approval wait was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });

    function done(error?: unknown): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    }
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("approval wait was cancelled");
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
