import { createHash, type Hash } from "node:crypto";

import { z } from "zod";

import { parseStrictJson } from "../../domain/strict-json.js";

export const MAX_PRIME_CONTAINER_PAYLOAD_BYTES = 1_048_576;
export const MAX_PRIME_CONTAINER_ENCODED_FRAME_BYTES = MAX_PRIME_CONTAINER_PAYLOAD_BYTES + 5;
export const MAX_PRIME_CONTAINER_FILE_CHUNK_BYTES = 65_536;
export const MAX_PRIME_CONTAINER_STREAM_BYTES = 457_179_136;
export const MAX_PRIME_CONTAINER_ENTRIES = 4_096;
export const MAX_PRIME_CONTAINER_PATH_BYTES = 4_095;
export const MAX_PRIME_CONTAINER_PATH_COMPONENT_BYTES = 255;
export const MAX_PRIME_CONTAINER_FILE_BYTES = 268_435_456;
export const MAX_PRIME_CONTAINER_TRANSFER_BYTES = 268_435_456;
export const MAX_PRIME_CONTAINER_CHUNK_FRAMES = 8_191;
export const MAX_PRIME_CONTAINER_TRANSFER_FRAMES = 16_385;
export const MAX_PRIME_CONTAINER_DRIVER_FRAMES = 512;

const PRIME_CONTAINER_FRAME_HEADER_BYTES = 5;

export enum PrimeContainerFrameType {
  Readiness = 1,
  FixtureStart = 2,
  FixtureEntry = 3,
  FixtureChunk = 4,
  FixtureFileEnd = 5,
  FixtureComplete = 6,
  Bootstrap = 7,
  Driver = 8,
  Terminal = 9,
  ResultStart = 10,
  ResultEntry = 11,
  ResultChunk = 12,
  ResultFileEnd = 13,
  ResultComplete = 14,
  Settlement = 15,
}

const frameTypes = new Set<number>([
  PrimeContainerFrameType.Readiness,
  PrimeContainerFrameType.FixtureStart,
  PrimeContainerFrameType.FixtureEntry,
  PrimeContainerFrameType.FixtureChunk,
  PrimeContainerFrameType.FixtureFileEnd,
  PrimeContainerFrameType.FixtureComplete,
  PrimeContainerFrameType.Bootstrap,
  PrimeContainerFrameType.Driver,
  PrimeContainerFrameType.Terminal,
  PrimeContainerFrameType.ResultStart,
  PrimeContainerFrameType.ResultEntry,
  PrimeContainerFrameType.ResultChunk,
  PrimeContainerFrameType.ResultFileEnd,
  PrimeContainerFrameType.ResultComplete,
  PrimeContainerFrameType.Settlement,
]);

const chunkFrameTypes = new Set<PrimeContainerFrameType>([
  PrimeContainerFrameType.FixtureChunk,
  PrimeContainerFrameType.ResultChunk,
]);

export interface PrimeContainerFrame {
  readonly type: PrimeContainerFrameType;
  readonly payload: Buffer;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");
const pathSchema = z.string().min(1);
const modeSchema = z.number().int().min(0).max(0o777);
const directoryEntrySchema = z
  .object({
    path: pathSchema,
    type: z.literal("directory"),
    mode: modeSchema,
  })
  .strict();
const fileEntrySchema = z
  .object({
    path: pathSchema,
    type: z.literal("file"),
    mode: modeSchema,
    size: z.number().int().min(0).max(MAX_PRIME_CONTAINER_FILE_BYTES),
    sha256: sha256Schema,
  })
  .strict();
const manifestEntrySchema = z.discriminatedUnion("type", [directoryEntrySchema, fileEntrySchema]);
const transferStartSchema = z
  .object({
    entryCount: z.number().int().min(0).max(MAX_PRIME_CONTAINER_ENTRIES),
    totalBytes: z.number().int().min(0).max(MAX_PRIME_CONTAINER_TRANSFER_BYTES),
    manifestSha256: sha256Schema,
  })
  .strict();

export type PrimeContainerManifestEntry = z.infer<typeof manifestEntrySchema>;
export type PrimeContainerTransferStart = z.infer<typeof transferStartSchema>;
export type PrimeContainerFrameDirection = "host-to-container" | "container-to-host";

export function encodePrimeContainerFrame(
  type: PrimeContainerFrameType,
  payload: Uint8Array,
): Buffer {
  assertKnownFrameType(type);
  const payloadBuffer = Buffer.from(payload);
  assertPayloadLength(type, payloadBuffer.byteLength);

  const frame = Buffer.allocUnsafe(PRIME_CONTAINER_FRAME_HEADER_BYTES + payloadBuffer.byteLength);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(payloadBuffer.byteLength, 1);
  payloadBuffer.copy(frame, PRIME_CONTAINER_FRAME_HEADER_BYTES);
  return frame;
}

export class PrimeContainerFrameDecoder {
  #pending = Buffer.alloc(0);
  #receivedBytes = 0;
  #finished = false;

  push(bytes: Uint8Array): PrimeContainerFrame[] {
    if (this.#finished) {
      throw new Error("Prime container frame decoder is already finished");
    }

    this.#receivedBytes += bytes.byteLength;
    if (this.#receivedBytes > MAX_PRIME_CONTAINER_STREAM_BYTES) {
      throw new Error("Prime container stream exceeds the byte limit");
    }

    if (bytes.byteLength > 0) {
      this.#pending = Buffer.concat([this.#pending, Buffer.from(bytes)]);
    }

    const frames: PrimeContainerFrame[] = [];
    while (this.#pending.byteLength >= PRIME_CONTAINER_FRAME_HEADER_BYTES) {
      const type = this.#pending.readUInt8(0);
      assertKnownFrameType(type);
      const payloadLength = this.#pending.readUInt32BE(1);
      assertPayloadLength(type, payloadLength);

      const frameLength = PRIME_CONTAINER_FRAME_HEADER_BYTES + payloadLength;
      if (this.#pending.byteLength < frameLength) {
        break;
      }

      frames.push({
        type,
        payload: Buffer.from(
          this.#pending.subarray(PRIME_CONTAINER_FRAME_HEADER_BYTES, frameLength),
        ),
      });
      this.#pending = this.#pending.subarray(frameLength);
    }

    return frames;
  }

  finish(): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    if (this.#pending.byteLength > 0) {
      throw new Error("Prime container stream ends with a partial frame");
    }
  }
}

export function parsePrimeContainerManifestEntryPayload(
  payload: Uint8Array,
): PrimeContainerManifestEntry {
  const input = parsePayload(payload, "manifest entry");
  const parsed = manifestEntrySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid Prime container manifest entry: ${parsed.error.message}`);
  }
  assertPortableRelativePath(parsed.data.path);
  return Object.freeze(parsed.data);
}

export function parsePrimeContainerTransferStartPayload(
  payload: Uint8Array,
): PrimeContainerTransferStart {
  const input = parsePayload(payload, "transfer start");
  const parsed = transferStartSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid Prime container transfer start: ${parsed.error.message}`);
  }
  return Object.freeze(parsed.data);
}

export class PrimeContainerTransferValidator {
  readonly #expected: PrimeContainerTransferStart;
  readonly #entries: PrimeContainerManifestEntry[] = [];
  readonly #entryTypes = new Map<string, PrimeContainerManifestEntry["type"]>();
  #currentFile:
    | {
        readonly entry: Extract<PrimeContainerManifestEntry, { readonly type: "file" }>;
        readonly hash: Hash;
        bytes: number;
      }
    | undefined;
  #declaredBytes = 0;
  #receivedBytes = 0;
  #chunkFrames = 0;
  #complete = false;

  constructor(expected: PrimeContainerTransferStart) {
    const parsed = transferStartSchema.safeParse(expected);
    if (!parsed.success) {
      throw new Error(`Invalid Prime container transfer start: ${parsed.error.message}`);
    }
    this.#expected = Object.freeze(parsed.data);
  }

  addEntry(input: PrimeContainerManifestEntry): void {
    this.#assertActive();
    if (this.#currentFile !== undefined) {
      throw new Error("Prime container file must end before the next entry");
    }
    if (this.#entries.length >= this.#expected.entryCount) {
      throw new Error("Prime container transfer has too many entries");
    }

    const parsed = manifestEntrySchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`Invalid Prime container manifest entry: ${parsed.error.message}`);
    }
    assertPortableRelativePath(parsed.data.path);
    const entry = Object.freeze(parsed.data);
    const previous = this.#entries.at(-1);
    if (
      previous !== undefined &&
      Buffer.compare(Buffer.from(previous.path), Buffer.from(entry.path)) >= 0
    ) {
      throw new Error("Prime container manifest contains a duplicate or out-of-order path");
    }
    this.#assertParents(entry.path);

    if (entry.type === "file") {
      this.#declaredBytes += entry.size;
      if (
        this.#declaredBytes > this.#expected.totalBytes ||
        this.#declaredBytes > MAX_PRIME_CONTAINER_TRANSFER_BYTES
      ) {
        throw new Error("Prime container manifest exceeds the total file size");
      }
      this.#currentFile = {
        entry,
        hash: createHash("sha256"),
        bytes: 0,
      };
    }

    this.#entries.push(entry);
    this.#entryTypes.set(entry.path, entry.type);
  }

  addChunk(chunk: Uint8Array): void {
    this.#assertActive();
    const current = this.#currentFile;
    if (current === undefined) {
      throw new Error("Prime container file chunk has no active file entry");
    }
    if (chunk.byteLength < 1 || chunk.byteLength > MAX_PRIME_CONTAINER_FILE_CHUNK_BYTES) {
      throw new Error("Prime container file chunk exceeds the byte limit");
    }
    this.#chunkFrames += 1;
    if (this.#chunkFrames > MAX_PRIME_CONTAINER_CHUNK_FRAMES) {
      throw new Error("Prime container transfer exceeds the chunk-frame limit");
    }
    current.bytes += chunk.byteLength;
    this.#receivedBytes += chunk.byteLength;
    if (current.bytes > current.entry.size) {
      throw new Error("Prime container file data exceeds its declared size");
    }
    if (
      this.#receivedBytes > this.#expected.totalBytes ||
      this.#receivedBytes > MAX_PRIME_CONTAINER_TRANSFER_BYTES
    ) {
      throw new Error("Prime container transfer exceeds its declared byte count");
    }
    current.hash.update(chunk);
  }

  endFile(): void {
    this.#assertActive();
    const current = this.#currentFile;
    if (current === undefined) {
      throw new Error("Prime container file end has no active file entry");
    }
    if (current.bytes !== current.entry.size) {
      throw new Error("Prime container file size does not match its manifest entry");
    }
    if (current.hash.digest("hex") !== current.entry.sha256) {
      throw new Error("Prime container file SHA-256 does not match its manifest entry");
    }
    this.#currentFile = undefined;
  }

  complete(): readonly PrimeContainerManifestEntry[] {
    this.#assertActive();
    if (this.#currentFile !== undefined) {
      throw new Error("Prime container transfer ends before the active file end marker");
    }
    if (this.#entries.length !== this.#expected.entryCount) {
      throw new Error("Prime container transfer entry count does not match its manifest");
    }
    if (
      this.#declaredBytes !== this.#expected.totalBytes ||
      this.#receivedBytes !== this.#expected.totalBytes
    ) {
      throw new Error("Prime container transfer byte count does not match its manifest");
    }
    if (createPrimeContainerManifestSha256(this.#entries) !== this.#expected.manifestSha256) {
      throw new Error("Prime container manifest SHA-256 does not match its entries");
    }
    this.#complete = true;
    return Object.freeze([...this.#entries]);
  }

  #assertParents(path: string): void {
    const components = path.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const parent = components.slice(0, index).join("/");
      const type = this.#entryTypes.get(parent);
      if (type === undefined) {
        throw new Error(`Prime container manifest is missing parent directory: ${parent}`);
      }
      if (type !== "directory") {
        throw new Error(`Prime container manifest has a file path prefix: ${parent}`);
      }
    }
  }

  #assertActive(): void {
    if (this.#complete) {
      throw new Error("Prime container transfer is already complete");
    }
  }
}

type ProtocolState =
  | "readiness"
  | "fixture-start"
  | "fixture"
  | "bootstrap"
  | "driver"
  | "result-start"
  | "result"
  | "settlement"
  | "complete";

export class PrimeContainerProtocolSequence {
  #driverFrames = 0;
  #fixtureFrames = 0;
  #resultFrames = 0;
  #state: ProtocolState = "readiness";

  accept(direction: PrimeContainerFrameDirection, type: PrimeContainerFrameType): void {
    assertKnownFrameType(type);
    assertFrameDirection(direction, type);
    this.#recordFrame(type);

    switch (this.#state) {
      case "readiness":
        this.#acceptExact(type, PrimeContainerFrameType.Readiness, "fixture-start");
        return;
      case "fixture-start":
        this.#acceptExact(type, PrimeContainerFrameType.FixtureStart, "fixture");
        return;
      case "fixture":
        if (
          type === PrimeContainerFrameType.FixtureEntry ||
          type === PrimeContainerFrameType.FixtureChunk ||
          type === PrimeContainerFrameType.FixtureFileEnd
        ) {
          return;
        }
        this.#acceptExact(type, PrimeContainerFrameType.FixtureComplete, "bootstrap");
        return;
      case "bootstrap":
        this.#acceptExact(type, PrimeContainerFrameType.Bootstrap, "driver");
        return;
      case "driver":
        if (type === PrimeContainerFrameType.Driver) {
          return;
        }
        this.#acceptExact(type, PrimeContainerFrameType.Terminal, "result-start");
        return;
      case "result-start":
        this.#acceptExact(type, PrimeContainerFrameType.ResultStart, "result");
        return;
      case "result":
        if (
          type === PrimeContainerFrameType.ResultEntry ||
          type === PrimeContainerFrameType.ResultChunk ||
          type === PrimeContainerFrameType.ResultFileEnd
        ) {
          return;
        }
        this.#acceptExact(type, PrimeContainerFrameType.ResultComplete, "settlement");
        return;
      case "settlement":
        this.#acceptExact(type, PrimeContainerFrameType.Settlement, "complete");
        return;
      case "complete":
        throw new Error("Prime container protocol is already complete");
    }
  }

  finish(): void {
    if (this.#state !== "complete") {
      throw new Error(`Prime container protocol is incomplete in state ${this.#state}`);
    }
  }

  #acceptExact(
    actual: PrimeContainerFrameType,
    expected: PrimeContainerFrameType,
    next: ProtocolState,
  ): void {
    if (actual !== expected) {
      throw new Error(
        `Prime container frame type ${String(actual)} is invalid in state ${this.#state}`,
      );
    }
    this.#state = next;
  }

  #recordFrame(type: PrimeContainerFrameType): void {
    if (
      type === PrimeContainerFrameType.FixtureStart ||
      type === PrimeContainerFrameType.FixtureEntry ||
      type === PrimeContainerFrameType.FixtureChunk ||
      type === PrimeContainerFrameType.FixtureFileEnd ||
      type === PrimeContainerFrameType.FixtureComplete
    ) {
      this.#fixtureFrames += 1;
      if (this.#fixtureFrames > MAX_PRIME_CONTAINER_TRANSFER_FRAMES) {
        throw new Error("Prime container fixture transfer exceeds the frame limit");
      }
      return;
    }
    if (
      type === PrimeContainerFrameType.ResultStart ||
      type === PrimeContainerFrameType.ResultEntry ||
      type === PrimeContainerFrameType.ResultChunk ||
      type === PrimeContainerFrameType.ResultFileEnd ||
      type === PrimeContainerFrameType.ResultComplete
    ) {
      this.#resultFrames += 1;
      if (this.#resultFrames > MAX_PRIME_CONTAINER_TRANSFER_FRAMES) {
        throw new Error("Prime container result transfer exceeds the frame limit");
      }
      return;
    }
    if (type === PrimeContainerFrameType.Driver) {
      this.#driverFrames += 1;
      if (this.#driverFrames > MAX_PRIME_CONTAINER_DRIVER_FRAMES) {
        throw new Error("Prime container driver traffic exceeds the frame limit");
      }
    }
  }
}

function assertKnownFrameType(type: number): asserts type is PrimeContainerFrameType {
  if (!frameTypes.has(type)) {
    throw new Error(`Unknown Prime container frame type: ${String(type)}`);
  }
}

function assertPayloadLength(type: PrimeContainerFrameType, payloadLength: number): void {
  if (chunkFrameTypes.has(type) && payloadLength > MAX_PRIME_CONTAINER_FILE_CHUNK_BYTES) {
    throw new Error("Prime container file chunk exceeds the byte limit");
  }
  if (payloadLength > MAX_PRIME_CONTAINER_PAYLOAD_BYTES) {
    throw new Error("Prime container frame payload exceeds the byte limit");
  }
}

function parsePayload(payload: Uint8Array, label: string): unknown {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch (error) {
    throw new Error(`Prime container ${label} is not valid UTF-8`, { cause: error });
  }
  try {
    return parseStrictJson(source, {
      maxDepth: 4,
      maxNodes: 16,
      valueLabel: `Prime container ${label}`,
    });
  } catch (error) {
    throw new Error(`Prime container ${label} is not strict JSON`, { cause: error });
  }
}

function assertPortableRelativePath(path: string): void {
  const pathBytes = Buffer.byteLength(path);
  if (pathBytes < 1 || pathBytes > MAX_PRIME_CONTAINER_PATH_BYTES) {
    throw new Error("Prime container path exceeds the UTF-8 byte limit");
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error("Prime container path must be a portable relative path");
  }
  const components = path.split("/");
  for (const component of components) {
    if (component === "" || component === "." || component === "..") {
      throw new Error("Prime container path contains an invalid component");
    }
    if (Buffer.byteLength(component) > MAX_PRIME_CONTAINER_PATH_COMPONENT_BYTES) {
      throw new Error("Prime container path component exceeds the UTF-8 byte limit");
    }
  }
  if (components[0] === ".flow-prime") {
    throw new Error("Prime container path uses the reserved .flow-prime path");
  }
}

export function createPrimeContainerManifestSha256(
  entries: readonly PrimeContainerManifestEntry[],
): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    if (entry.type === "directory") {
      hash.update(`directory\0${entry.path}\0${entry.mode}\0`);
    } else {
      hash.update(`file\0${entry.path}\0${entry.mode}\0${entry.size}\0${entry.sha256}\0`);
    }
  }
  return hash.digest("hex");
}

function assertFrameDirection(
  direction: PrimeContainerFrameDirection,
  type: PrimeContainerFrameType,
): void {
  const expected =
    type === PrimeContainerFrameType.Readiness ||
    type === PrimeContainerFrameType.Terminal ||
    type === PrimeContainerFrameType.ResultStart ||
    type === PrimeContainerFrameType.ResultEntry ||
    type === PrimeContainerFrameType.ResultChunk ||
    type === PrimeContainerFrameType.ResultFileEnd ||
    type === PrimeContainerFrameType.ResultComplete ||
    type === PrimeContainerFrameType.Settlement
      ? "container-to-host"
      : type === PrimeContainerFrameType.Driver
        ? direction
        : "host-to-container";
  if (direction !== expected) {
    throw new Error(`Prime container frame type ${String(type)} has the wrong direction`);
  }
}
