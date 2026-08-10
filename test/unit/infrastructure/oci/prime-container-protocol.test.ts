import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  encodePrimeContainerFrame,
  MAX_PRIME_CONTAINER_DRIVER_FRAMES,
  MAX_PRIME_CONTAINER_FILE_BYTES,
  MAX_PRIME_CONTAINER_FILE_CHUNK_BYTES,
  MAX_PRIME_CONTAINER_PATH_BYTES,
  MAX_PRIME_CONTAINER_PAYLOAD_BYTES,
  MAX_PRIME_CONTAINER_TRANSFER_FRAMES,
  PrimeContainerFrameDecoder,
  PrimeContainerFrameType,
  PrimeContainerProtocolSequence,
  PrimeContainerTransferValidator,
  parsePrimeContainerManifestEntryPayload,
  parsePrimeContainerTransferStartPayload,
} from "../../../../src/infrastructure/prime/prime-container-protocol.js";

const fileSha256 = createHash("sha256").update("abc").digest("hex");
const directoryEntry = { path: "src", type: "directory" as const, mode: 0o555 };
const fileEntry = {
  path: "src/a.txt",
  type: "file" as const,
  mode: 0o644,
  size: 3,
  sha256: fileSha256,
};

describe("Prime container frame codec", () => {
  it("decodes fragmented headers, fragmented payloads, and multiple frames", () => {
    const first = encodePrimeContainerFrame(PrimeContainerFrameType.Readiness, Buffer.from("one"));
    const second = encodePrimeContainerFrame(
      PrimeContainerFrameType.FixtureStart,
      Buffer.from("two"),
    );
    const bytes = Buffer.concat([first, second]);
    const decoder = new PrimeContainerFrameDecoder();

    expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
    expect(decoder.push(bytes.subarray(2, 7))).toEqual([]);
    expect(decoder.push(bytes.subarray(7))).toEqual([
      { type: PrimeContainerFrameType.Readiness, payload: Buffer.from("one") },
      { type: PrimeContainerFrameType.FixtureStart, payload: Buffer.from("two") },
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("accepts exact payload limits and rejects one byte over each limit", () => {
    expect(() =>
      encodePrimeContainerFrame(
        PrimeContainerFrameType.Driver,
        Buffer.alloc(MAX_PRIME_CONTAINER_PAYLOAD_BYTES),
      ),
    ).not.toThrow();
    expect(() =>
      encodePrimeContainerFrame(
        PrimeContainerFrameType.Driver,
        Buffer.alloc(MAX_PRIME_CONTAINER_PAYLOAD_BYTES + 1),
      ),
    ).toThrow(/payload/i);
    expect(() =>
      encodePrimeContainerFrame(
        PrimeContainerFrameType.FixtureChunk,
        Buffer.alloc(MAX_PRIME_CONTAINER_FILE_CHUNK_BYTES),
      ),
    ).not.toThrow();
    expect(() =>
      encodePrimeContainerFrame(
        PrimeContainerFrameType.FixtureChunk,
        Buffer.alloc(MAX_PRIME_CONTAINER_FILE_CHUNK_BYTES + 1),
      ),
    ).toThrow(/chunk/i);
  });

  it("rejects unknown frame types and partial end-of-stream data", () => {
    const decoder = new PrimeContainerFrameDecoder();
    expect(() => decoder.push(Buffer.from([255, 0, 0, 0, 0]))).toThrow(/frame type/i);

    const partialHeader = new PrimeContainerFrameDecoder();
    partialHeader.push(Buffer.from([PrimeContainerFrameType.Readiness, 0]));
    expect(() => partialHeader.finish()).toThrow(/partial/i);

    const partialPayload = new PrimeContainerFrameDecoder();
    partialPayload.push(Buffer.from([PrimeContainerFrameType.Readiness, 0, 0, 0, 2, 1]));
    expect(() => partialPayload.finish()).toThrow(/partial/i);
  });
});

describe("Prime container transfer", () => {
  it("accepts one complete nested manifest and verifies file bytes", () => {
    const entries = [directoryEntry, fileEntry];
    const validator = new PrimeContainerTransferValidator({
      entryCount: entries.length,
      totalBytes: 3,
      manifestSha256: manifestSha256(entries),
    });

    validator.addEntry(directoryEntry);
    validator.addEntry(fileEntry);
    validator.addChunk(Buffer.from("a"));
    validator.addChunk(Buffer.from("bc"));
    validator.endFile();

    expect(validator.complete()).toEqual(entries);
  });

  it("rejects missing parents, file prefixes, duplicates, and content drift", () => {
    const start = {
      entryCount: 2,
      totalBytes: 3,
      manifestSha256: manifestSha256([directoryEntry, fileEntry]),
    };

    const missingParent = new PrimeContainerTransferValidator(start);
    expect(() => missingParent.addEntry(fileEntry)).toThrow(/parent/i);

    const filePrefix = new PrimeContainerTransferValidator(start);
    filePrefix.addEntry({ ...directoryEntry, type: "file", size: 0, sha256: emptySha256() });
    filePrefix.endFile();
    expect(() => filePrefix.addEntry(fileEntry)).toThrow(/parent|prefix/i);

    const duplicate = new PrimeContainerTransferValidator(start);
    duplicate.addEntry(directoryEntry);
    expect(() => duplicate.addEntry(directoryEntry)).toThrow(/duplicate|order/i);

    const changed = new PrimeContainerTransferValidator(start);
    changed.addEntry(directoryEntry);
    changed.addEntry(fileEntry);
    changed.addChunk(Buffer.from("abd"));
    expect(() => changed.endFile()).toThrow(/sha-256/i);
  });

  it("enforces strict paths, modes, sizes, and wire payloads", () => {
    const exactPath = Array.from({ length: 16 }, () => "a".repeat(255)).join("/");
    expect(Buffer.byteLength(exactPath)).toBe(MAX_PRIME_CONTAINER_PATH_BYTES);
    expect(() =>
      parsePrimeContainerManifestEntryPayload(
        json({ path: exactPath, type: "directory", mode: 0o777 }),
      ),
    ).not.toThrow();

    for (const path of [".flow-prime", ".flow-prime/private", "a//b", "a/../b", "a\\b"]) {
      expect(() =>
        parsePrimeContainerManifestEntryPayload(json({ path, type: "directory", mode: 0o755 })),
      ).toThrow(/path/i);
    }
    expect(() =>
      parsePrimeContainerManifestEntryPayload(
        json({ path: `${"a".repeat(256)}`, type: "directory", mode: 0o755 }),
      ),
    ).toThrow(/component/i);
    expect(() =>
      parsePrimeContainerManifestEntryPayload(json({ path: "a", type: "directory", mode: 0o1000 })),
    ).toThrow(/mode/i);
    expect(() =>
      parsePrimeContainerManifestEntryPayload(
        json({
          path: "a",
          type: "file",
          mode: 0o644,
          size: MAX_PRIME_CONTAINER_FILE_BYTES + 1,
          sha256: emptySha256(),
        }),
      ),
    ).toThrow(/size/i);
    expect(() =>
      parsePrimeContainerManifestEntryPayload(json({ ...directoryEntry, unexpected: true })),
    ).toThrow(/entry/i);
    expect(() =>
      parsePrimeContainerTransferStartPayload(
        Buffer.from('{"entryCount":1,"entryCount":2,"totalBytes":0,"manifestSha256":"x"}'),
      ),
    ).toThrow(/strict JSON/i);
  });
});

describe("Prime container protocol sequence", () => {
  it("accepts the complete direction-aware sequence", () => {
    const sequence = new PrimeContainerProtocolSequence();
    sequence.accept("container-to-host", PrimeContainerFrameType.Readiness);
    sequence.accept("host-to-container", PrimeContainerFrameType.FixtureStart);
    sequence.accept("host-to-container", PrimeContainerFrameType.FixtureEntry);
    sequence.accept("host-to-container", PrimeContainerFrameType.FixtureChunk);
    sequence.accept("host-to-container", PrimeContainerFrameType.FixtureFileEnd);
    sequence.accept("host-to-container", PrimeContainerFrameType.FixtureComplete);
    sequence.accept("host-to-container", PrimeContainerFrameType.Bootstrap);
    sequence.accept("container-to-host", PrimeContainerFrameType.Driver);
    sequence.accept("host-to-container", PrimeContainerFrameType.Driver);
    sequence.accept("container-to-host", PrimeContainerFrameType.Terminal);
    sequence.accept("container-to-host", PrimeContainerFrameType.ResultStart);
    sequence.accept("container-to-host", PrimeContainerFrameType.ResultEntry);
    sequence.accept("container-to-host", PrimeContainerFrameType.ResultChunk);
    sequence.accept("container-to-host", PrimeContainerFrameType.ResultFileEnd);
    sequence.accept("container-to-host", PrimeContainerFrameType.ResultComplete);
    sequence.accept("container-to-host", PrimeContainerFrameType.Settlement);

    expect(() => sequence.finish()).not.toThrow();
  });

  it("rejects wrong directions, out-of-state frames, and early end-of-stream", () => {
    const wrongDirection = new PrimeContainerProtocolSequence();
    expect(() =>
      wrongDirection.accept("host-to-container", PrimeContainerFrameType.Readiness),
    ).toThrow(/direction/i);

    const outOfState = new PrimeContainerProtocolSequence();
    outOfState.accept("container-to-host", PrimeContainerFrameType.Readiness);
    expect(() => outOfState.accept("host-to-container", PrimeContainerFrameType.Bootstrap)).toThrow(
      /state/i,
    );

    const partial = new PrimeContainerProtocolSequence();
    partial.accept("container-to-host", PrimeContainerFrameType.Readiness);
    expect(() => partial.finish()).toThrow(/incomplete/i);
  });

  it("enforces exact transfer limits", () => {
    const exact = new PrimeContainerProtocolSequence();
    exact.accept("container-to-host", PrimeContainerFrameType.Readiness);
    exact.accept("host-to-container", PrimeContainerFrameType.FixtureStart);
    for (let entry = 0; entry < 4_096; entry += 1) {
      exact.accept("host-to-container", PrimeContainerFrameType.FixtureEntry);
      const chunks = entry === 4_095 ? 4_096 : 1;
      for (let chunk = 0; chunk < chunks; chunk += 1) {
        exact.accept("host-to-container", PrimeContainerFrameType.FixtureChunk);
      }
      exact.accept("host-to-container", PrimeContainerFrameType.FixtureFileEnd);
    }
    expect(() =>
      exact.accept("host-to-container", PrimeContainerFrameType.FixtureComplete),
    ).not.toThrow();

    const tooManyTransferFrames = new PrimeContainerProtocolSequence();
    tooManyTransferFrames.accept("container-to-host", PrimeContainerFrameType.Readiness);
    tooManyTransferFrames.accept("host-to-container", PrimeContainerFrameType.FixtureStart);
    for (let frame = 1; frame < MAX_PRIME_CONTAINER_TRANSFER_FRAMES; frame += 1) {
      tooManyTransferFrames.accept("host-to-container", PrimeContainerFrameType.FixtureEntry);
    }
    expect(() =>
      tooManyTransferFrames.accept("host-to-container", PrimeContainerFrameType.FixtureComplete),
    ).toThrow(/transfer.*frame/i);

    const tooManyDriverFrames = new PrimeContainerProtocolSequence();
    tooManyDriverFrames.accept("container-to-host", PrimeContainerFrameType.Readiness);
    tooManyDriverFrames.accept("host-to-container", PrimeContainerFrameType.FixtureStart);
    tooManyDriverFrames.accept("host-to-container", PrimeContainerFrameType.FixtureComplete);
    tooManyDriverFrames.accept("host-to-container", PrimeContainerFrameType.Bootstrap);
    for (let frame = 0; frame < MAX_PRIME_CONTAINER_DRIVER_FRAMES; frame += 1) {
      tooManyDriverFrames.accept("container-to-host", PrimeContainerFrameType.Driver);
    }
    expect(() =>
      tooManyDriverFrames.accept("container-to-host", PrimeContainerFrameType.Driver),
    ).toThrow(/driver.*frame/i);
  });
});

function manifestSha256(entries: readonly (typeof directoryEntry | typeof fileEntry)[]): string {
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

function emptySha256(): string {
  return createHash("sha256").update("").digest("hex");
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}
