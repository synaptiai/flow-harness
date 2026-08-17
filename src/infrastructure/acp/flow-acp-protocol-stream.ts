import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

import { StrictAcpStreamError } from "./strict-acp-stream.js";

export const MAX_ACP_IN_FLIGHT_REQUESTS = 64;

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

export function createFlowAcpProtocolStream(base: Stream): Stream {
  const reader = base.readable.getReader();
  const writer = base.writable.getWriter();
  const incomingRequests = new Set<string>();
  const outgoingRequests = new Set<string>();
  const initialization = deferred();
  let phase: ProtocolPhase = "await_initialize";
  let initializeId: string | undefined;
  let readerSettled = false;
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
      reader.releaseLock();
    }
  };

  const settleWriter = (): void => {
    if (!writerSettled) {
      writerSettled = true;
      writer.releaseLock();
    }
  };

  const settleReaderAfterFailure = async (): Promise<void> => {
    failInitialization();
    if (readerSettled) {
      return;
    }
    try {
      await reader.cancel();
    } catch {
      // The protocol failure retains precedence over transport settlement.
    } finally {
      settleReader();
    }
  };

  return {
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
          await settleReaderAfterFailure();
          throw normalizeProtocolError(error);
        }
      },
      async cancel() {
        failInitialization();
        if (readerSettled) {
          return;
        }
        try {
          await reader.cancel();
        } catch {
          throw new FlowAcpProtocolStreamError("io");
        } finally {
          settleReader();
        }
      },
    }),
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        let settlement: OutgoingSettlement;
        try {
          settlement = inspectOutgoing(message);
          await writer.write(message);
          commitOutgoing(settlement);
        } catch (error) {
          failInitialization();
          throw normalizeProtocolError(error);
        }
      },
      async close() {
        failInitialization();
        try {
          await writer.close();
        } catch {
          throw new FlowAcpProtocolStreamError("io");
        } finally {
          settleWriter();
        }
      },
      async abort() {
        failInitialization();
        try {
          await writer.abort();
        } catch {
          throw new FlowAcpProtocolStreamError("io");
        } finally {
          settleWriter();
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
      return { kind: "notification" };
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
        outgoingRequests.add(settlement.key);
        return;
      case "client_response":
        incomingRequests.delete(settlement.key);
        if (settlement.initialize) {
          phase = settlement.successful ? "ready" : "failed";
          initialization.resolve();
        }
        return;
      case "notification":
        return;
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
  | { readonly kind: "notification" };

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
