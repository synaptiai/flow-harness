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

function memoryStream(options: { readonly writeError?: Error } = {}): {
  readonly stream: Stream;
  readonly written: AnyMessage[];
  readonly push: (message: AnyMessage) => void;
} {
  let input: ReadableStreamDefaultController<AnyMessage> | undefined;
  const written: AnyMessage[] = [];
  return {
    stream: {
      readable: new ReadableStream<AnyMessage>({
        start(controller) {
          input = controller;
        },
      }),
      writable: new WritableStream<AnyMessage>({
        write(message) {
          if (options.writeError !== undefined) {
            throw options.writeError;
          }
          written.push(message);
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
