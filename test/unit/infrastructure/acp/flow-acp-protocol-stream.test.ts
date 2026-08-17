import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import {
  createFlowAcpProtocolStream,
  FlowAcpProtocolStreamError,
  MAX_ACP_IN_FLIGHT_REQUESTS,
} from "../../../../src/infrastructure/acp/flow-acp-protocol-stream.js";

describe("Flow ACP protocol stream", () => {
  it("holds pipelined traffic until the initialize response is written", async () => {
    const base = memoryStream();
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    base.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    base.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/workspace", mcpServers: [] },
    });

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { id: 1, method: "initialize" },
    });
    const second = reader.read();
    await expect(Promise.race([second.then(() => "read"), delay(20, "blocked")])).resolves.toBe(
      "blocked",
    );

    await writer.write({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    await expect(second).resolves.toMatchObject({
      done: false,
      value: { id: 2, method: "session/new" },
    });
  });

  it.each([
    ["notification before initialization", { jsonrpc: "2.0", method: "session/cancel" }],
    ["session request before initialization", { jsonrpc: "2.0", id: 1, method: "session/list" }],
    [
      "unknown method",
      { jsonrpc: "2.0", id: 1, method: "PRIVATE_EXTENSION", params: { PRIVATE: true } },
    ],
  ] as const)("rejects %s with one fixed private-safe error", async (_name, message) => {
    const base = memoryStream();
    const reader = createFlowAcpProtocolStream(base.stream).readable.getReader();
    base.push(message as AnyMessage);

    const error = await reader.read().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FlowAcpProtocolStreamError);
    expect(error).toMatchObject({ code: "invalid_order" });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
  });

  it("rejects an unsupported method after initialization without exposing its name", async () => {
    const base = memoryStream();
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    await initialize(base, reader, writer);
    base.push({ jsonrpc: "2.0", id: 2, method: "PRIVATE_METHOD", params: {} });

    const error = await reader.read().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "unsupported_message" });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_METHOD");
  });

  it("rejects duplicate incoming request identifiers", async () => {
    const base = memoryStream();
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    await initialize(base, reader, writer);
    base.push({ jsonrpc: "2.0", id: 2, method: "session/list", params: {} });
    base.push({ jsonrpc: "2.0", id: 2, method: "session/list", params: {} });

    await expect(reader.read()).resolves.toMatchObject({ value: { id: 2 } });
    await expect(reader.read()).rejects.toMatchObject({ code: "duplicate_request" });
  });

  it("keeps numeric and string request identifiers distinct", async () => {
    const base = memoryStream();
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    await initialize(base, reader, writer);
    base.push({ jsonrpc: "2.0", id: 2, method: "session/list", params: {} });
    base.push({ jsonrpc: "2.0", id: "2", method: "session/list", params: {} });

    await expect(reader.read()).resolves.toMatchObject({ value: { id: 2 } });
    await expect(reader.read()).resolves.toMatchObject({ value: { id: "2" } });
  });

  it("admits the exact incoming concurrency bound and rejects one more request", async () => {
    const base = memoryStream();
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    await initialize(base, reader, writer);
    for (let index = 0; index < MAX_ACP_IN_FLIGHT_REQUESTS; index += 1) {
      base.push({ jsonrpc: "2.0", id: index, method: "session/list", params: {} });
      await expect(reader.read()).resolves.toMatchObject({ value: { id: index } });
    }
    base.push({
      jsonrpc: "2.0",
      id: MAX_ACP_IN_FLIGHT_REQUESTS,
      method: "session/list",
      params: {},
    });

    await expect(reader.read()).rejects.toMatchObject({ code: "too_many_requests" });
  });

  it("admits the exact outgoing concurrency bound and rejects one more request", async () => {
    const base = memoryStream();
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    await initialize(base, reader, writer);
    for (let index = 0; index < MAX_ACP_IN_FLIGHT_REQUESTS; index += 1) {
      await writer.write({
        jsonrpc: "2.0",
        id: `permission-${index}`,
        method: "session/request_permission",
        params: {},
      });
    }

    await expect(
      writer.write({
        jsonrpc: "2.0",
        id: `permission-${MAX_ACP_IN_FLIGHT_REQUESTS}`,
        method: "session/request_permission",
        params: {},
      }),
    ).rejects.toMatchObject({ code: "too_many_requests" });
    expect(base.written).toHaveLength(MAX_ACP_IN_FLIGHT_REQUESTS + 1);
  });

  it("admits only responses to exact outstanding agent requests", async () => {
    const base = memoryStream();
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    await initialize(base, reader, writer);
    await writer.write({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {},
    });
    base.push({ jsonrpc: "2.0", id: "permission-1", result: { outcome: "cancelled" } });
    await expect(reader.read()).resolves.toMatchObject({
      value: { id: "permission-1", result: { outcome: "cancelled" } },
    });

    base.push({ jsonrpc: "2.0", id: "PRIVATE_UNKNOWN", result: {} });
    const error = await reader.read().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "unknown_response" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_UNKNOWN");
  });

  it("retires an agent request after its cancellation notification is written", async () => {
    const base = memoryStream();
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    await initialize(base, reader, writer);
    await writer.write({
      jsonrpc: "2.0",
      id: "permission-cancelled",
      method: "session/request_permission",
      params: {},
    });

    await writer.write({
      jsonrpc: "2.0",
      method: "$/cancel_request",
      params: { requestId: "permission-cancelled" },
    });
    await expect(
      writer.write({
        jsonrpc: "2.0",
        id: "permission-cancelled",
        method: "session/request_permission",
        params: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("reserves an agent request before a fast peer can return its response", async () => {
    const writeRelease = deferred();
    let base: ReturnType<typeof memoryStream>;
    base = memoryStream({
      onWrite: async (message) => {
        if ("method" in message && message.method === "session/request_permission") {
          base.push({
            jsonrpc: "2.0",
            id: "permission-fast",
            result: { outcome: { outcome: "cancelled" } },
          });
          await writeRelease.promise;
        }
      },
    });
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    await initialize(base, reader, writer);

    const response = reader.read().catch((error: unknown) => error);
    const write = writer
      .write({
        jsonrpc: "2.0",
        id: "permission-fast",
        method: "session/request_permission",
        params: {},
      })
      .catch((error: unknown) => error);
    const observed = await response;
    writeRelease.resolve();
    const writeResult = await write;

    expect(observed).toMatchObject({
      done: false,
      value: { id: "permission-fast", result: { outcome: { outcome: "cancelled" } } },
    });
    expect(writeResult).toBeUndefined();
  });

  it("does not release pipelined traffic after a failed initialize response", async () => {
    const base = memoryStream();
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    base.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    base.push({ jsonrpc: "2.0", id: 2, method: "session/list", params: {} });
    await reader.read();
    const second = reader.read();

    await writer.write({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32_600, message: "PRIVATE_INITIALIZE_FAILURE" },
    });

    await expect(second).rejects.toMatchObject({ code: "invalid_order" });
  });

  it("settles a failed initialize write without exposing its transport error", async () => {
    const base = memoryStream({ writeError: new Error("PRIVATE_WRITE_FAILURE") });
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    base.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    base.push({ jsonrpc: "2.0", id: 2, method: "session/list", params: {} });
    await reader.read();
    const second = reader.read();

    const writeError = await writer
      .write({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })
      .catch((caught: unknown) => caught);

    expect(writeError).toMatchObject({ code: "io" });
    expect(writeError).not.toHaveProperty("cause");
    expect(JSON.stringify(writeError)).not.toContain("PRIVATE_WRITE_FAILURE");
    await expect(second).rejects.toMatchObject({ code: "invalid_order" });
  });

  it("settles the owned output after clean input settlement", async () => {
    const base = memoryStream();
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    base.closeInput();

    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    await expect(stream.settle()).resolves.toBeUndefined();
    expect(base.outputAbortCalls()).toBe(1);
  });

  it("preserves the primary protocol error when output cleanup also fails", async () => {
    const base = memoryStream({ abortError: new Error("PRIVATE_CLOSE_FAILURE") });
    const stream = createFlowAcpProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    base.push({ jsonrpc: "2.0", id: 1, method: "PRIVATE_BEFORE_INITIALIZE", params: {} });

    const primary = await reader.read().catch((caught: unknown) => caught);
    const settled = await stream.settle();

    expect(primary).toMatchObject({ code: "invalid_order" });
    expect(settled).toBe(primary);
    expect(base.outputAbortCalls()).toBe(1);
    expect(JSON.stringify(settled)).not.toContain("PRIVATE_");
  });

  it("bounds a stalled output write and its cleanup", async () => {
    const stalled = deferred();
    const base = memoryStream({
      onWrite: async (message) => {
        if ("method" in message && message.method === "session/request_permission") {
          await stalled.promise;
        }
      },
    });
    const stream = createFlowAcpProtocolStream(base.stream, { operationTimeoutMs: 10 });
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    await initialize(base, reader, writer);

    const writeFailure = await Promise.race([
      writer
        .write({
          jsonrpc: "2.0",
          id: "permission-stalled",
          method: "session/request_permission",
          params: {},
        })
        .catch((error: unknown) => error),
      delay(250, "PRIVATE_WRITE_TIMEOUT"),
    ]);
    const settled = await Promise.race([stream.settle(), delay(250, "PRIVATE_SETTLE_TIMEOUT")]);
    stalled.resolve();

    expect(writeFailure).toMatchObject({ code: "io" });
    expect(settled).toBe(writeFailure);
    expect(JSON.stringify({ writeFailure, settled })).not.toContain("PRIVATE_");
  });
});

async function initialize(
  base: ReturnType<typeof memoryStream>,
  reader: ReadableStreamDefaultReader<AnyMessage>,
  writer: WritableStreamDefaultWriter<AnyMessage>,
): Promise<void> {
  base.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await reader.read();
  await writer.write({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
}

function memoryStream(
  options: {
    readonly abortError?: Error;
    readonly onWrite?: (message: AnyMessage) => void | Promise<void>;
    readonly writeError?: Error;
  } = {},
): {
  readonly outputAbortCalls: () => number;
  readonly closeInput: () => void;
  readonly stream: Stream;
  readonly written: AnyMessage[];
  readonly push: (message: AnyMessage) => void;
} {
  let input: ReadableStreamDefaultController<AnyMessage> | undefined;
  let outputAbortCalls = 0;
  const written: AnyMessage[] = [];
  return {
    closeInput: () => input?.close(),
    outputAbortCalls: () => outputAbortCalls,
    stream: {
      readable: new ReadableStream<AnyMessage>({
        start(controller) {
          input = controller;
        },
      }),
      writable: new WritableStream<AnyMessage>({
        abort() {
          outputAbortCalls += 1;
          if (options.abortError !== undefined) {
            throw options.abortError;
          }
        },
        async write(message) {
          if (options.writeError !== undefined) {
            throw options.writeError;
          }
          written.push(message);
          await options.onWrite?.(message);
        },
      }),
    },
    written,
    push: (message) => input?.enqueue(message),
  };
}

async function delay(milliseconds: number, value: string): Promise<string> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  return value;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}
