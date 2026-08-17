import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

import { StrictAcpStreamError } from "./strict-acp-stream.js";

export const MAX_ACP_IN_FLIGHT_REQUESTS = 64;
export const DEFAULT_ACP_OPERATION_TIMEOUT_MS = 30_000;

export type FlowAcpProtocolStreamErrorCode =
  | "duplicate_request"
  | "invalid_order"
  | "io"
  | "too_many_requests"
  | "unknown_response"
  | "unsupported_message";

export class FlowAcpProtocolStreamError extends Error {
  override readonly name = "FlowAcpProtocolStreamError";

  constructor(readonly code: FlowAcpProtocolStreamErrorCode) {
    super(messageForCode(code));
  }
}

export interface FlowAcpProtocolStream extends Stream {
  readonly settle: () => Promise<Error | undefined>;
}

export interface FlowAcpProtocolStreamOptions {
  readonly operationTimeoutMs?: number;
}

type ProtocolPhase = "await_initialize" | "initializing" | "ready" | "failed";

const CLIENT_REQUEST_METHODS = new Set([
  "session/close",
  "session/list",
  "session/load",
  "session/new",
  "session/prompt",
  "session/resume",
]);
const CLIENT_NOTIFICATION_METHODS = new Set(["$/cancel_request", "session/cancel"]);
const AGENT_REQUEST_METHODS = new Set(["session/request_permission"]);
const AGENT_NOTIFICATION_METHODS = new Set(["$/cancel_request", "session/update"]);

export function createFlowAcpProtocolStream(
  base: Stream,
  options: FlowAcpProtocolStreamOptions = {},
): FlowAcpProtocolStream {
  const operationTimeoutMs = parseOperationTimeout(options.operationTimeoutMs);
  const reader = base.readable.getReader();
  const writer = base.writable.getWriter();
  const incomingRequests = new Set<string>();
  const outgoingRequests = new Set<string>();
  const initialization = deferred();
  let phase: ProtocolPhase = "await_initialize";
  let initializeId: string | undefined;
  let primaryFailure: Error | undefined;
  let readerSettled = false;
  let settlement: Promise<Error | undefined> | undefined;
  let writeTail: Promise<void> = Promise.resolve();
  let writerSettled = false;

  const failInitialization = (): void => {
    if (phase === "initializing") {
      phase = "failed";
      initialization.resolve();
    }
  };

  const settleReader = (): void => {
    if (!readerSettled) {
      readerSettled = true;
      try {
        reader.releaseLock();
      } catch {
        // A timed-out transport operation can retain its Web Streams lock.
      }
    }
  };

  const settleWriter = (): void => {
    if (!writerSettled) {
      writerSettled = true;
      try {
        writer.releaseLock();
      } catch {
        // A timed-out transport operation can retain its Web Streams lock.
      }
    }
  };

  const awaitTransport = async <T>(operation: Promise<T>): Promise<T> =>
    await withOperationTimeout(operation, operationTimeoutMs);

  const settleReaderAfterFailure = async (): Promise<void> => {
    failInitialization();
    if (readerSettled) {
      return;
    }
    try {
      await awaitTransport(reader.cancel());
    } catch {
      // The protocol failure retains precedence over transport settlement.
    } finally {
      settleReader();
    }
  };

  const recordFailure = (error: unknown): Error => {
    const normalized = normalizeProtocolError(error);
    primaryFailure ??= normalized;
    return normalized;
  };

  const settleOutput = async (mode: "abort" | "close"): Promise<Error | undefined> => {
    try {
      await awaitTransport(writeTail);
    } catch (error) {
      recordFailure(error);
    }
    if (writerSettled) {
      return primaryFailure;
    }
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
      failInitialization();
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
          if (phase === "initializing") {
            await initialization.promise;
          }
          if (phase === "failed") {
            throw new FlowAcpProtocolStreamError("invalid_order");
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
        failInitialization();
        if (readerSettled) {
          return;
        }
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
            if (outgoing !== undefined) {
              rollbackOutgoing(outgoing);
            }
            failInitialization();
            throw recordFailure(error);
          }
        })();
        writeTail = operation.catch(() => undefined);
        await operation;
      },
      async close() {
        failInitialization();
        const failure = await settleOutput("close");
        if (failure !== undefined) {
          throw failure;
        }
      },
      async abort() {
        failInitialization();
        const failure = await settleOutput("abort");
        if (failure !== undefined) {
          throw failure;
        }
      },
    }),
  };

  function admitIncoming(message: AnyMessage): void {
    if (isCall(message)) {
      if (phase === "await_initialize") {
        if (!isRequest(message) || message.method !== "initialize") {
          throw new FlowAcpProtocolStreamError("invalid_order");
        }
        const key = requestKey(message.id);
        addRequest(incomingRequests, key);
        initializeId = key;
        phase = "initializing";
        return;
      }
      if (phase !== "ready") {
        throw new FlowAcpProtocolStreamError("invalid_order");
      }
      if (message.method === "initialize") {
        throw new FlowAcpProtocolStreamError("invalid_order");
      }
      if (isRequest(message)) {
        if (!CLIENT_REQUEST_METHODS.has(message.method)) {
          throw new FlowAcpProtocolStreamError("unsupported_message");
        }
        addRequest(incomingRequests, requestKey(message.id));
        return;
      }
      if (!CLIENT_NOTIFICATION_METHODS.has(message.method)) {
        throw new FlowAcpProtocolStreamError("unsupported_message");
      }
      return;
    }

    if (phase !== "ready") {
      throw new FlowAcpProtocolStreamError("invalid_order");
    }
    const key = requestKey(message.id);
    if (!outgoingRequests.delete(key)) {
      throw new FlowAcpProtocolStreamError("unknown_response");
    }
  }

  function inspectOutgoing(message: AnyMessage): OutgoingSettlement {
    if (isCall(message)) {
      if (phase !== "ready") {
        throw new FlowAcpProtocolStreamError("invalid_order");
      }
      if (isRequest(message)) {
        if (!AGENT_REQUEST_METHODS.has(message.method)) {
          throw new FlowAcpProtocolStreamError("unsupported_message");
        }
        const key = requestKey(message.id);
        if (outgoingRequests.has(key)) {
          throw new FlowAcpProtocolStreamError("duplicate_request");
        }
        if (outgoingRequests.size >= MAX_ACP_IN_FLIGHT_REQUESTS) {
          throw new FlowAcpProtocolStreamError("too_many_requests");
        }
        return { kind: "agent_request", key };
      }
      if (!AGENT_NOTIFICATION_METHODS.has(message.method)) {
        throw new FlowAcpProtocolStreamError("unsupported_message");
      }
      return {
        kind: "notification",
        cancelledRequestKey: cancelledAgentRequestKey(message),
      };
    }

    const key = requestKey(message.id);
    if (!incomingRequests.has(key)) {
      throw new FlowAcpProtocolStreamError("unknown_response");
    }
    if (phase === "initializing" && key !== initializeId) {
      throw new FlowAcpProtocolStreamError("invalid_order");
    }
    return {
      kind: "client_response",
      initialize: key === initializeId,
      key,
      successful: Object.hasOwn(message, "result"),
    };
  }

  function commitOutgoing(settlement: OutgoingSettlement): void {
    switch (settlement.kind) {
      case "agent_request":
        return;
      case "client_response":
        incomingRequests.delete(settlement.key);
        if (settlement.initialize) {
          phase = settlement.successful ? "ready" : "failed";
          initialization.resolve();
        }
        return;
      case "notification":
        if (settlement.cancelledRequestKey !== undefined) {
          outgoingRequests.delete(settlement.cancelledRequestKey);
        }
        return;
    }
  }

  function reserveOutgoing(settlement: OutgoingSettlement): void {
    if (settlement.kind === "agent_request") {
      outgoingRequests.add(settlement.key);
    }
  }

  function rollbackOutgoing(settlement: OutgoingSettlement): void {
    if (settlement.kind === "agent_request") {
      outgoingRequests.delete(settlement.key);
    }
  }
}

type OutgoingSettlement =
  | { readonly kind: "agent_request"; readonly key: string }
  | {
      readonly kind: "client_response";
      readonly initialize: boolean;
      readonly key: string;
      readonly successful: boolean;
    }
  | { readonly kind: "notification"; readonly cancelledRequestKey: string | undefined };

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
    throw new FlowAcpProtocolStreamError("unsupported_message");
  }
  return `${typeof id}:${String(id)}`;
}

function cancelledAgentRequestKey(
  message: Extract<AnyMessage, { method: string }>,
): string | undefined {
  if (message.method !== "$/cancel_request") {
    return undefined;
  }
  const params = message.params;
  if (
    typeof params !== "object" ||
    params === null ||
    Array.isArray(params) ||
    Object.keys(params).length !== 1 ||
    !("requestId" in params)
  ) {
    throw new FlowAcpProtocolStreamError("unsupported_message");
  }
  const requestId = params.requestId;
  if (typeof requestId !== "string" && typeof requestId !== "number" && requestId !== null) {
    throw new FlowAcpProtocolStreamError("unsupported_message");
  }
  return requestKey(requestId);
}

function addRequest(requests: Set<string>, key: string): void {
  if (requests.has(key)) {
    throw new FlowAcpProtocolStreamError("duplicate_request");
  }
  if (requests.size >= MAX_ACP_IN_FLIGHT_REQUESTS) {
    throw new FlowAcpProtocolStreamError("too_many_requests");
  }
  requests.add(key);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function parseOperationTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_ACP_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000) {
    throw new Error("Flow ACP protocol stream options are invalid");
  }
  return timeout;
}

async function withOperationTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FlowAcpProtocolStreamError("io")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function normalizeProtocolError(error: unknown): Error {
  if (error instanceof FlowAcpProtocolStreamError || error instanceof StrictAcpStreamError) {
    return error;
  }
  return new FlowAcpProtocolStreamError("io");
}

function messageForCode(code: FlowAcpProtocolStreamErrorCode): string {
  switch (code) {
    case "duplicate_request":
      return "ACP request identifier is already active";
    case "invalid_order":
      return "ACP message order is invalid";
    case "io":
      return "ACP protocol transport failed";
    case "too_many_requests":
      return "ACP request concurrency limit exceeded";
    case "unknown_response":
      return "ACP response does not match an active request";
    case "unsupported_message":
      return "ACP message is not supported";
  }
}
