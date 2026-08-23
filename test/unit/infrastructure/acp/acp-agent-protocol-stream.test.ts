import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import {
  type AcpAgentAuthorityViolationCategory,
  AcpAgentProtocolStreamError,
  createAcpAgentProtocolStream,
} from "../../../../src/infrastructure/acp/acp-agent-protocol-stream.js";

describe("ACP agent client protocol stream", () => {
  it("admits only client-owned initialization and exact outstanding responses", async () => {
    const base = memoryStream();
    const stream = createAcpAgentProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();

    await writer.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    base.push({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { id: 1, result: { protocolVersion: 1 } },
    });

    await writer.write({
      jsonrpc: "2.0",
      id: "new-1",
      method: "session/new",
      params: { cwd: "/private/attempt", mcpServers: [] },
    });
    base.push({ jsonrpc: "2.0", id: "new-1", result: { sessionId: "session-1" } });
    await expect(reader.read()).resolves.toMatchObject({
      value: { id: "new-1", result: { sessionId: "session-1" } },
    });
    expect(
      base.written.map((message) => ("method" in message ? message.method : "response")),
    ).toEqual(["initialize", "session/new"]);
  });

  it("passes a permission request only so the client can cancel it and records the violation", async () => {
    const violations: AcpAgentAuthorityViolationCategory[] = [];
    const permissionResponses: string[] = [];
    const base = memoryStream();
    const stream = createAcpAgentProtocolStream(base.stream, {
      onAuthorityViolation: (category) => violations.push(category),
      onPermissionResponse: () => permissionResponses.push("written"),
    });
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    await initialize(base, reader, writer);
    base.push({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: { sessionId: "session-1", toolCall: { toolCallId: "tool-1" }, options: [] },
    });

    await expect(reader.read()).resolves.toMatchObject({
      value: { id: "permission-1", method: "session/request_permission" },
    });
    await writer.write({
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "cancelled" } },
    });

    expect(violations).toEqual(["permission"]);
    expect(permissionResponses).toEqual(["written"]);
    expect(base.written.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  it.each([
    ["filesystem", "fs/read_text_file"],
    ["terminal", "terminal/create"],
    ["elicitation", "elicitation/create"],
    ["mcp", "mcp/connect"],
    ["extension", "_private/authority"],
    ["undeclared_client_method", "private/authority"],
  ] as const)("rejects %s authority without disclosing the method", async (category, method) => {
    const violations: AcpAgentAuthorityViolationCategory[] = [];
    const base = memoryStream();
    const stream = createAcpAgentProtocolStream(base.stream, {
      onAuthorityViolation: (value) => violations.push(value),
    });
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    await initialize(base, reader, writer);
    base.push({ jsonrpc: "2.0", id: 7, method, params: { private: "PRIVATE_VALUE" } });

    const error = await reader.read().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AcpAgentProtocolStreamError);
    expect(error).toMatchObject({ code: "authority_violation", authorityCategory: category });
    expect(violations).toEqual([category]);
    expect(JSON.stringify(error)).not.toContain(method);
    expect(JSON.stringify(error)).not.toContain("PRIVATE_VALUE");
  });

  it("rejects unknown responses and client methods with fixed errors", async () => {
    const unsupportedBase = memoryStream();
    const unsupportedStream = createAcpAgentProtocolStream(unsupportedBase.stream);
    const unsupportedReader = unsupportedStream.readable.getReader();
    const unsupportedWriter = unsupportedStream.writable.getWriter();
    await initialize(unsupportedBase, unsupportedReader, unsupportedWriter);

    await expect(
      unsupportedWriter.write({
        jsonrpc: "2.0",
        id: 4,
        method: "fs/read_text_file",
        params: {},
      }),
    ).rejects.toMatchObject({ code: "unsupported_message" });

    const unknownBase = memoryStream();
    const unknownStream = createAcpAgentProtocolStream(unknownBase.stream);
    const unknownReader = unknownStream.readable.getReader();
    const unknownWriter = unknownStream.writable.getWriter();
    await initialize(unknownBase, unknownReader, unknownWriter);
    unknownBase.push({ jsonrpc: "2.0", id: "PRIVATE_UNKNOWN", result: {} });
    const error = await unknownReader.read().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "unknown_response" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_UNKNOWN");
  });

  it("settles both directions while preserving the first fixed protocol failure", async () => {
    const base = memoryStream();
    const stream = createAcpAgentProtocolStream(base.stream);
    const reader = stream.readable.getReader();
    base.push({ jsonrpc: "2.0", id: 1, result: { private: "PRIVATE_RESULT" } });

    const primary = await reader.read().catch((caught: unknown) => caught);
    const settled = await stream.settle();

    expect(primary).toMatchObject({ code: "invalid_order" });
    expect(settled).toBe(primary);
    expect(base.outputAbortCalls()).toBe(1);
    expect(JSON.stringify(settled)).not.toContain("PRIVATE_RESULT");
  });
});

async function initialize(
  base: ReturnType<typeof memoryStream>,
  reader: ReadableStreamDefaultReader<AnyMessage>,
  writer: WritableStreamDefaultWriter<AnyMessage>,
): Promise<void> {
  await writer.write({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  });
  base.push({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
  await reader.read();
}

function memoryStream(): {
  readonly outputAbortCalls: () => number;
  readonly stream: Stream;
  readonly written: AnyMessage[];
  readonly push: (message: AnyMessage) => void;
} {
  let input: ReadableStreamDefaultController<AnyMessage> | undefined;
  let outputAbortCalls = 0;
  const written: AnyMessage[] = [];
  return {
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
        },
        write(message) {
          written.push(message);
        },
      }),
    },
    written,
    push: (message) => input?.enqueue(message),
  };
}
