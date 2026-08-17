import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

import {
  parseStrictJson,
  type StrictJsonObject,
  type StrictJsonValue,
} from "../../domain/strict-json.js";

export const MAX_ACP_FRAME_BYTES = 1_048_576;
export const MAX_ACP_JSON_DEPTH = 32;
export const MAX_ACP_JSON_NODES = 8_192;

export type StrictAcpStreamErrorCode =
  | "frame_too_large"
  | "incomplete_frame"
  | "invalid_encoding"
  | "invalid_frame"
  | "invalid_message"
  | "io";

export class StrictAcpStreamError extends Error {
  override readonly name = "StrictAcpStreamError";

  constructor(readonly code: StrictAcpStreamErrorCode) {
    super(messageForCode(code));
  }
}

export interface StrictAcpStreamOptions {
  readonly input: ReadableStream<Uint8Array>;
  readonly output: WritableStream<Uint8Array>;
  readonly maxFrameBytes?: number;
}

type ByteReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

export function createStrictAcpStream(options: StrictAcpStreamOptions): Stream {
  const maxFrameBytes = parseMaximum(options.maxFrameBytes ?? MAX_ACP_FRAME_BYTES);
  const input = new StrictFrameReader(options.input.getReader(), maxFrameBytes);
  const output = options.output.getWriter();
  const encoder = new TextEncoder();

  return {
    readable: new ReadableStream<AnyMessage>({
      async pull(controller) {
        try {
          const message = await input.read();
          if (message === undefined) {
            controller.close();
          } else {
            controller.enqueue(message);
          }
        } catch (error) {
          await input.settleAfterFailure();
          throw normalizeStreamError(error);
        }
      },
      async cancel() {
        await input.cancel();
      },
    }),
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        try {
          if (!isStrictJsonRpcMessage(message)) {
            throw new StrictAcpStreamError("invalid_message");
          }
          let source: string;
          try {
            source = JSON.stringify(message);
          } catch {
            throw new StrictAcpStreamError("invalid_message");
          }
          const frame = encoder.encode(`${source}\n`);
          if (frame.byteLength - 1 > maxFrameBytes) {
            throw new StrictAcpStreamError("frame_too_large");
          }
          await output.write(frame);
        } catch (error) {
          throw normalizeStreamError(error);
        }
      },
      async close() {
        try {
          await output.close();
        } catch {
          throw new StrictAcpStreamError("io");
        } finally {
          output.releaseLock();
        }
      },
      async abort() {
        try {
          await output.abort();
        } catch {
          throw new StrictAcpStreamError("io");
        } finally {
          output.releaseLock();
        }
      },
    }),
  };
}

class StrictFrameReader {
  readonly #buffer: Uint8Array;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxFrameBytes: number;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunk: Uint8Array | undefined;
  #chunkOffset = 0;
  #length = 0;
  #settled = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, maxFrameBytes: number) {
    this.#reader = reader;
    this.#maxFrameBytes = maxFrameBytes;
    this.#buffer = new Uint8Array(maxFrameBytes);
  }

  async read(): Promise<AnyMessage | undefined> {
    for (;;) {
      if (this.#chunk === undefined) {
        let result: ByteReadResult;
        try {
          result = await this.#reader.read();
        } catch {
          throw new StrictAcpStreamError("io");
        }
        if (result.done) {
          this.#settle();
          if (this.#length !== 0) {
            throw new StrictAcpStreamError("incomplete_frame");
          }
          return undefined;
        }
        if (result.value.byteLength === 0) {
          continue;
        }
        this.#chunk = result.value;
        this.#chunkOffset = 0;
      }

      const chunk = this.#chunk;
      if (chunk === undefined) {
        continue;
      }
      const newline = chunk.indexOf(0x0a, this.#chunkOffset);
      const end = newline === -1 ? chunk.byteLength : newline;
      const segmentLength = end - this.#chunkOffset;
      if (this.#length + segmentLength > this.#maxFrameBytes) {
        throw new StrictAcpStreamError("frame_too_large");
      }
      this.#buffer.set(chunk.subarray(this.#chunkOffset, end), this.#length);
      this.#length += segmentLength;
      this.#chunkOffset = end;

      if (newline === -1) {
        this.#chunk = undefined;
        continue;
      }

      this.#chunkOffset += 1;
      if (this.#chunkOffset === chunk.byteLength) {
        this.#chunk = undefined;
      }
      return this.#parseFrame();
    }
  }

  async cancel(): Promise<void> {
    if (this.#settled) {
      return;
    }
    try {
      await this.#reader.cancel();
    } catch {
      throw new StrictAcpStreamError("io");
    } finally {
      this.#settle();
    }
  }

  async settleAfterFailure(): Promise<void> {
    if (this.#settled) {
      return;
    }
    try {
      await this.#reader.cancel();
    } catch {
      // The primary parse or transport error must retain precedence.
    } finally {
      this.#settle();
    }
  }

  #parseFrame(): AnyMessage {
    let length = this.#length;
    this.#length = 0;
    if (length > 0 && this.#buffer[length - 1] === 0x0d) {
      length -= 1;
    }
    if (length === 0) {
      throw new StrictAcpStreamError("invalid_frame");
    }

    let source: string;
    try {
      source = this.#decoder.decode(this.#buffer.subarray(0, length));
    } catch {
      throw new StrictAcpStreamError("invalid_encoding");
    }

    let value: StrictJsonValue;
    try {
      value = parseStrictJson(source, {
        maxDepth: MAX_ACP_JSON_DEPTH,
        maxNodes: MAX_ACP_JSON_NODES,
        valueLabel: "ACP frame",
      });
    } catch {
      throw new StrictAcpStreamError("invalid_frame");
    }
    if (!isStrictJsonRpcMessage(value)) {
      throw new StrictAcpStreamError("invalid_message");
    }
    return value;
  }

  #settle(): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#reader.releaseLock();
  }
}

function isStrictJsonRpcMessage(value: unknown): value is AnyMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    return false;
  }
  if (Object.hasOwn(value, "method")) {
    return isCall(value);
  }
  return isResponse(value);
}

function isCall(value: StrictJsonObject): boolean {
  if (!isMethod(value.method) || !isStructuredParams(value)) {
    return false;
  }
  if (Object.hasOwn(value, "id")) {
    return hasOnlyKeys(value, ["jsonrpc", "id", "method", "params"]) && isId(value.id);
  }
  return hasOnlyKeys(value, ["jsonrpc", "method", "params"]);
}

function isResponse(value: StrictJsonObject): boolean {
  if (!hasOnlyKeys(value, ["jsonrpc", "id", "result", "error"]) || !isId(value.id)) {
    return false;
  }
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  return hasResult !== hasError && (!hasError || isErrorResponse(value.error));
}

function isErrorResponse(value: StrictJsonValue | undefined): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["code", "message", "data"]) &&
    typeof value.code === "number" &&
    Number.isSafeInteger(value.code) &&
    typeof value.message === "string"
  );
}

function isStructuredParams(value: StrictJsonObject): boolean {
  if (!Object.hasOwn(value, "params")) {
    return true;
  }
  return value.params === null || typeof value.params === "object";
}

function isMethod(value: StrictJsonValue | undefined): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isId(value: StrictJsonValue | undefined): boolean {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && value.length > 0 && value.length <= 128)
  );
}

function isRecord(value: unknown): value is StrictJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: StrictJsonObject, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function parseMaximum(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ACP_FRAME_BYTES) {
    throw new RangeError("ACP frame maximum must be a positive safe integer within its limit");
  }
  return value;
}

function normalizeStreamError(error: unknown): StrictAcpStreamError {
  return error instanceof StrictAcpStreamError ? error : new StrictAcpStreamError("io");
}

function messageForCode(code: StrictAcpStreamErrorCode): string {
  switch (code) {
    case "frame_too_large":
      return "ACP frame exceeds its limit";
    case "incomplete_frame":
      return "ACP input ended with an incomplete frame";
    case "invalid_encoding":
      return "ACP frame encoding is invalid";
    case "invalid_frame":
      return "ACP frame is invalid";
    case "invalid_message":
      return "ACP message is invalid";
    case "io":
      return "ACP transport failed";
  }
}
