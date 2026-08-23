import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

import {
  DEFAULT_ACP_OPERATION_TIMEOUT_MS,
  MAX_ACP_IN_FLIGHT_REQUESTS,
} from "./flow-acp-protocol-stream.js";
import { StrictAcpStreamError } from "./strict-acp-stream.js";

export type AcpAgentAuthorityViolationCategory =
  | "permission"
  | "filesystem"
  | "terminal"
  | "elicitation"
  | "mcp"
  | "tool"
  | "extension"
  | "undeclared_client_method";

export type AcpAgentProtocolStreamErrorCode =
  | "authority_violation"
  | "duplicate_request"
  | "invalid_order"
  | "io"
  | "too_many_requests"
  | "unknown_response"
  | "unsupported_message";

export class AcpAgentProtocolStreamError extends Error {
  override readonly name = "AcpAgentProtocolStreamError";

  constructor(
    readonly code: AcpAgentProtocolStreamErrorCode,
    readonly authorityCategory?: AcpAgentAuthorityViolationCategory,
  ) {
    super(messageForCode(code));
  }
}

export interface AcpAgentProtocolStream extends Stream {
  readonly settle: () => Promise<Error | undefined>;
}

export interface AcpAgentProtocolStreamOptions {
  readonly operationTimeoutMs?: number;
  readonly onAuthorityViolation?: (category: AcpAgentAuthorityViolationCategory) => void;
  readonly onPermissionResponse?: () => void;
}

type ProtocolPhase = "await_initialize" | "initializing" | "ready" | "failed";

const CLIENT_REQUEST_METHODS = new Set([
  "session/new",
  "session/prompt",
  "session/set_config_option",
]);
const CLIENT_NOTIFICATION_METHODS = new Set(["$/cancel_request", "session/cancel"]);
const AGENT_NOTIFICATION_METHODS = new Set(["$/cancel_request", "session/update"]);

export function createAcpAgentProtocolStream(
  base: Stream,
  options: AcpAgentProtocolStreamOptions = {},
): AcpAgentProtocolStream {
  const operationTimeoutMs = parseOperationTimeout(options.operationTimeoutMs);
  const reader = base.readable.getReader();
  const writer = base.writable.getWriter();
  const incomingRequests = new Set<string>();
  const permissionRequests = new Set<string>();
  const outgoingRequests = new Set<string>();
  let phase: ProtocolPhase = "await_initialize";
  let initializeId: string | undefined;
  let primaryFailure: Error | undefined;
  let readerSettled = false;
  let settlement: Promise<Error | undefined> | undefined;
  let writeTail: Promise<void> = Promise.resolve();
  let writerSettled = false;

  const awaitTransport = async <T>(operation: Promise<T>): Promise<T> =>
    await withOperationTimeout(operation, operationTimeoutMs);

  const recordFailure = (error: unknown): Error => {
    const normalized = normalizeProtocolError(error);
    primaryFailure ??= normalized;
    phase = "failed";
    return normalized;
  };

  const settleReader = (): void => {
    if (readerSettled) return;
    readerSettled = true;
    try {
      reader.releaseLock();
    } catch {
      // A bounded transport operation can retain its Web Streams lock.
    }
  };

  const settleWriter = (): void => {
    if (writerSettled) return;
    writerSettled = true;
    try {
      writer.releaseLock();
    } catch {
      // A bounded transport operation can retain its Web Streams lock.
    }
  };

  const settleReaderAfterFailure = async (): Promise<void> => {
    if (readerSettled) return;
    try {
      await awaitTransport(reader.cancel());
    } catch {
      // The first protocol failure retains precedence.
    } finally {
      settleReader();
    }
  };

  const settleOutput = async (mode: "abort" | "close"): Promise<Error | undefined> => {
    try {
      await awaitTransport(writeTail);
    } catch (error) {
      recordFailure(error);
    }
    if (writerSettled) return primaryFailure;
    try {
      if (mode === "abort") {
        await awaitTransport(writer.abort());
      } else {
        await awaitTransport(writer.close());
      }
    } catch (error) {
      recordFailure(error);
    } finally {
      settleWriter();
    }
    return primaryFailure;
  };

  const settle = async (): Promise<Error | undefined> => {
    settlement ??= (async () => {
      if (!readerSettled) {
        try {
          await awaitTransport(reader.cancel());
        } catch (error) {
          recordFailure(error);
        } finally {
          settleReader();
        }
      }
      return await settleOutput("abort");
    })();
    return await settlement;
  };

  return {
    settle,
    readable: new ReadableStream<AnyMessage>({
      async pull(controller) {
        try {
          if (phase === "failed") {
            throw primaryFailure ?? new AcpAgentProtocolStreamError("invalid_order");
          }
          const result = await reader.read();
          if (result.done) {
            settleReader();
            controller.close();
            return;
          }
          admitIncoming(result.value);
          controller.enqueue(result.value);
        } catch (error) {
          const failure = recordFailure(error);
          await settleReaderAfterFailure();
          throw failure;
        }
      },
      async cancel() {
        if (readerSettled) return;
        try {
          await awaitTransport(reader.cancel());
        } catch (error) {
          throw recordFailure(error);
        } finally {
          settleReader();
        }
      },
    }),
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        const operation = (async () => {
          let outgoing: OutgoingSettlement | undefined;
          try {
            outgoing = inspectOutgoing(message);
            reserveOutgoing(outgoing);
            await awaitTransport(writer.write(message));
            commitOutgoing(outgoing);
          } catch (error) {
            if (outgoing !== undefined) rollbackOutgoing(outgoing);
            throw recordFailure(error);
          }
        })();
        writeTail = operation.catch(() => undefined);
        await operation;
      },
      async close() {
        const failure = await settleOutput("close");
        if (failure !== undefined) throw failure;
      },
      async abort() {
        const failure = await settleOutput("abort");
        if (failure !== undefined) throw failure;
      },
    }),
  };

  function admitIncoming(message: AnyMessage): void {
    if (isCall(message)) {
      if (phase !== "ready") {
        throw new AcpAgentProtocolStreamError("invalid_order");
      }
      if (isRequest(message)) {
        const category = classifyAuthorityMethod(message.method);
        notifyAuthorityViolation(category);
        if (category !== "permission") {
          throw new AcpAgentProtocolStreamError("authority_violation", category);
        }
        const key = requestKey(message.id);
        addRequest(incomingRequests, key);
        permissionRequests.add(key);
        return;
      }
      if (AGENT_NOTIFICATION_METHODS.has(message.method)) {
        return;
      }
      const category = classifyAuthorityMethod(message.method);
      notifyAuthorityViolation(category);
      throw new AcpAgentProtocolStreamError("authority_violation", category);
    }

    const key = requestKey(message.id);
    if (phase === "initializing") {
      if (key !== initializeId || !outgoingRequests.delete(key)) {
        throw new AcpAgentProtocolStreamError("unknown_response");
      }
      phase = Object.hasOwn(message, "result") ? "ready" : "failed";
      return;
    }
    if (phase !== "ready") {
      throw new AcpAgentProtocolStreamError("invalid_order");
    }
    if (!outgoingRequests.delete(key)) {
      throw new AcpAgentProtocolStreamError("unknown_response");
    }
  }

  function inspectOutgoing(message: AnyMessage): OutgoingSettlement {
    if (phase === "failed") {
      throw primaryFailure ?? new AcpAgentProtocolStreamError("invalid_order");
    }
    if (isCall(message)) {
      if (isRequest(message)) {
        if (phase === "await_initialize") {
          if (message.method !== "initialize") {
            throw new AcpAgentProtocolStreamError("invalid_order");
          }
          return { kind: "client_request", initialize: true, key: requestKey(message.id) };
        }
        if (phase !== "ready") {
          throw new AcpAgentProtocolStreamError("invalid_order");
        }
        if (!CLIENT_REQUEST_METHODS.has(message.method)) {
          throw new AcpAgentProtocolStreamError("unsupported_message");
        }
        return { kind: "client_request", initialize: false, key: requestKey(message.id) };
      }
      if (phase !== "ready") {
        throw new AcpAgentProtocolStreamError("invalid_order");
      }
      if (!CLIENT_NOTIFICATION_METHODS.has(message.method)) {
        throw new AcpAgentProtocolStreamError("unsupported_message");
      }
      return { kind: "notification" };
    }

    if (phase !== "ready") {
      throw new AcpAgentProtocolStreamError("invalid_order");
    }
    const key = requestKey(message.id);
    if (!incomingRequests.has(key)) {
      throw new AcpAgentProtocolStreamError("unknown_response");
    }
    return { kind: "agent_response", key };
  }

  function reserveOutgoing(outgoing: OutgoingSettlement): void {
    if (outgoing.kind !== "client_request") return;
    addRequest(outgoingRequests, outgoing.key);
    if (outgoing.initialize) {
      phase = "initializing";
      initializeId = outgoing.key;
    }
  }

  function commitOutgoing(outgoing: OutgoingSettlement): void {
    if (outgoing.kind === "agent_response") {
      incomingRequests.delete(outgoing.key);
      if (permissionRequests.delete(outgoing.key)) {
        notifyPermissionResponse();
      }
    }
  }

  function rollbackOutgoing(outgoing: OutgoingSettlement): void {
    if (outgoing.kind !== "client_request") return;
    outgoingRequests.delete(outgoing.key);
    if (outgoing.initialize) {
      phase = "failed";
    }
  }

  function notifyAuthorityViolation(category: AcpAgentAuthorityViolationCategory): void {
    try {
      options.onAuthorityViolation?.(category);
    } catch {
      throw new AcpAgentProtocolStreamError("io");
    }
  }

  function notifyPermissionResponse(): void {
    try {
      options.onPermissionResponse?.();
    } catch {
      throw new AcpAgentProtocolStreamError("io");
    }
  }
}

type OutgoingSettlement =
  | { readonly kind: "client_request"; readonly initialize: boolean; readonly key: string }
  | { readonly kind: "agent_response"; readonly key: string }
  | { readonly kind: "notification" };

function classifyAuthorityMethod(method: string): AcpAgentAuthorityViolationCategory {
  if (method === "session/request_permission") return "permission";
  if (method.startsWith("fs/")) return "filesystem";
  if (method.startsWith("terminal/")) return "terminal";
  if (method.startsWith("elicitation/")) return "elicitation";
  if (method.startsWith("mcp/")) return "mcp";
  return method.startsWith("_") ? "extension" : "undeclared_client_method";
}

function addRequest(requests: Set<string>, key: string): void {
  if (requests.has(key)) {
    throw new AcpAgentProtocolStreamError("duplicate_request");
  }
  if (requests.size >= MAX_ACP_IN_FLIGHT_REQUESTS) {
    throw new AcpAgentProtocolStreamError("too_many_requests");
  }
  requests.add(key);
}

function isCall(message: AnyMessage): message is Extract<AnyMessage, { method: string }> {
  return Object.hasOwn(message, "method");
}

function isRequest(
  message: Extract<AnyMessage, { method: string }>,
): message is Extract<AnyMessage, { method: string; id: unknown }> {
  return Object.hasOwn(message, "id");
}

function requestKey(id: string | number | null): string {
  if (id === null) {
    throw new AcpAgentProtocolStreamError("unsupported_message");
  }
  return `${typeof id}:${String(id)}`;
}

function parseOperationTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_ACP_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > DEFAULT_ACP_OPERATION_TIMEOUT_MS) {
    throw new RangeError("ACP operation timeout must be within its fixed limit");
  }
  return timeout;
}

async function withOperationTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AcpAgentProtocolStreamError("io")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeProtocolError(error: unknown): Error {
  if (error instanceof AcpAgentProtocolStreamError) return error;
  if (error instanceof StrictAcpStreamError) return new AcpAgentProtocolStreamError("io");
  return new AcpAgentProtocolStreamError("io");
}

function messageForCode(code: AcpAgentProtocolStreamErrorCode): string {
  switch (code) {
    case "authority_violation":
      return "ACP agent requested unsupported client authority";
    case "duplicate_request":
      return "ACP agent reused an active request identifier";
    case "invalid_order":
      return "ACP agent message order is invalid";
    case "io":
      return "ACP agent transport failed";
    case "too_many_requests":
      return "ACP agent has too many active requests";
    case "unknown_response":
      return "ACP agent response does not match an active request";
    case "unsupported_message":
      return "ACP client message is unsupported";
  }
}
