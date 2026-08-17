import { describe, expect, it } from "vitest";

import {
  createStrictAcpStream,
  MAX_ACP_FRAME_BYTES,
  StrictAcpStreamError,
} from "../../../../src/infrastructure/acp/strict-acp-stream.js";

const encoder = new TextEncoder();

describe("strict ACP stream", () => {
  it("reassembles fragmented UTF-8 and yields one individual message at a time", async () => {
    const first =
      '{"jsonrpc":"2.0","id":"one","method":"initialize","params":{"name":"fl\u00f8w"}}\n';
    const second = '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"two"}}\n';
    const bytes = encoder.encode(first + second);
    const split = first.indexOf("\u00f8") + 1;
    const input = byteStream([
      bytes.subarray(0, split),
      bytes.subarray(split, split + 1),
      bytes.subarray(split + 1),
    ]);
    const output = collectingOutput();
    const stream = createStrictAcpStream({ input, output: output.stream });
    const reader = stream.readable.getReader();

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: {
        jsonrpc: "2.0",
        id: "one",
        method: "initialize",
        params: { name: "fl\u00f8w" },
      },
    });
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: {
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: "two" },
      },
    });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it.each([
    [
      "duplicate keys",
      '{"jsonrpc":"2.0","id":1,"id":2,"method":"PRIVATE_DUPLICATE"}\n',
      "invalid_frame",
    ],
    [
      "fatal Unicode",
      new Uint8Array([
        ...encoder.encode('{"jsonrpc":"2.0","id":1,"method":"'),
        0xc3,
        0x28,
        ...encoder.encode('"}\n'),
      ]),
      "invalid_encoding",
    ],
    [
      "excessive depth",
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: nested(33) })}\n`,
      "invalid_frame",
    ],
    [
      "excessive nodes",
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: Array(8_193).fill(null) })}\n`,
      "invalid_frame",
    ],
    ["batch", '[{"jsonrpc":"2.0","id":1,"method":"PRIVATE_BATCH"}]\n', "invalid_message"],
    ["empty line", "\n", "invalid_frame"],
    ["null identifier", '{"jsonrpc":"2.0","id":null,"method":"PRIVATE_NULL"}\n', "invalid_message"],
    [
      "fractional identifier",
      '{"jsonrpc":"2.0","id":1.5,"method":"PRIVATE_FRACTION"}\n',
      "invalid_message",
    ],
    [
      "unknown shape",
      '{"jsonrpc":"2.0","id":1,"method":"PRIVATE_EXTRA","extra":true}\n',
      "invalid_message",
    ],
  ] as const)("rejects %s with a fixed private-value-free error", async (_name, frame, code) => {
    const input = byteStream([typeof frame === "string" ? encoder.encode(frame) : frame]);
    const output = collectingOutput();
    const reader = createStrictAcpStream({ input, output: output.stream }).readable.getReader();

    const error = await reader.read().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StrictAcpStreamError);
    expect(error).toMatchObject({ code });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("PRIVATE_");
  });

  it("enforces the cumulative input frame bound across chunks", async () => {
    const base = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';
    const exact = encoder.encode(`${base}${" ".repeat(MAX_ACP_FRAME_BYTES - base.length)}\n`);
    const exactReader = createStrictAcpStream({
      input: byteStream([exact.subarray(0, 400_000), exact.subarray(400_000)]),
      output: collectingOutput().stream,
    }).readable.getReader();

    await expect(exactReader.read()).resolves.toMatchObject({
      done: false,
      value: { method: "initialize" },
    });

    const oversized = encoder.encode(
      `${base}${" ".repeat(MAX_ACP_FRAME_BYTES + 1 - base.length)}\n`,
    );
    const oversizedReader = createStrictAcpStream({
      input: byteStream([oversized.subarray(0, 600_000), oversized.subarray(600_000)]),
      output: collectingOutput().stream,
    }).readable.getReader();
    await expect(oversizedReader.read()).rejects.toMatchObject({ code: "frame_too_large" });
  });

  it("rejects a partial final frame instead of accepting EOF as a delimiter", async () => {
    const reader = createStrictAcpStream({
      input: byteStream([encoder.encode('{"jsonrpc":"2.0","id":1,"method":"PRIVATE_EOF"}')]),
      output: collectingOutput().stream,
    }).readable.getReader();

    const error = await reader.read().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "incomplete_frame" });
    expect(String(error)).not.toContain("PRIVATE_EOF");
  });

  it("serializes valid writes exactly and closes the output", async () => {
    const output = collectingOutput();
    const stream = createStrictAcpStream({ input: byteStream([]), output: output.stream });
    const writer = stream.writable.getWriter();

    await writer.write({ jsonrpc: "2.0", id: 7, result: { accepted: true } });
    await writer.close();

    expect(new TextDecoder().decode(concatenate(output.chunks))).toBe(
      '{"jsonrpc":"2.0","id":7,"result":{"accepted":true}}\n',
    );
    expect(output.closed).toBe(true);
  });

  it.each([
    ["invalid output", { jsonrpc: "2.0", id: null, result: "PRIVATE_OUTPUT" }, "invalid_message"],
    [
      "oversized output",
      { jsonrpc: "2.0", id: 1, result: "PRIVATE_OUTPUT".repeat(MAX_ACP_FRAME_BYTES) },
      "frame_too_large",
    ],
  ] as const)("rejects %s without writing or disclosing values", async (_name, message, code) => {
    const output = collectingOutput();
    const writer = createStrictAcpStream({
      input: byteStream([]),
      output: output.stream,
    }).writable.getWriter();

    const error = await writer.write(message as never).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("PRIVATE_OUTPUT");
    expect(output.chunks).toEqual([]);
  });
});

function nested(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) {
    value = { value };
  }
  return value;
}

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
  });
}

function collectingOutput(): {
  readonly chunks: Uint8Array[];
  readonly stream: WritableStream<Uint8Array>;
  closed: boolean;
} {
  const state = {
    chunks: [] as Uint8Array[],
    closed: false,
    stream: undefined as unknown as WritableStream<Uint8Array>,
  };
  state.stream = new WritableStream({
    write(chunk) {
      state.chunks.push(chunk.slice());
    },
    close() {
      state.closed = true;
    },
  });
  return state;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
