import { describe, expect, it } from "vitest";

import { parseNativeObserverResult } from "../../../src/infrastructure/verification/native-observer-result.js";

const correlation = "0123456789abcdef".repeat(4);

describe("native observer private result recognition", () => {
  it("recognizes a normal application exit without promoting outer shell evidence", () => {
    const frame = Buffer.alloc(64);
    frame.write("FLOWOBS1", 0, "ascii");
    Buffer.from(correlation, "hex").copy(frame, 8);
    frame.writeUInt32LE(1, 40);
    frame.writeUInt32LE(143, 44);
    const result = parseNativeObserverResult(frame, correlation);
    expect(result).toEqual({
      kind: "normal_exit",
      exitCode: 143,
      clone3FallbackUsed: false,
    });
  });

  it.each([0, 1, 127, 128, 143, 255])("preserves deliberate exit %i", (exitCode) => {
    expect(parseNativeObserverResult(wire(1, exitCode), correlation)).toEqual({
      kind: "normal_exit",
      exitCode,
      clone3FallbackUsed: false,
    });
  });

  it.each([1, 9, 15, 31, 32, 64])(
    "preserves worker signal %i separately from launch proof",
    (signal) => {
      expect(parseNativeObserverResult(wire(2, signal), correlation)).toEqual({
        kind: "signalled",
        signal,
        clone3FallbackUsed: false,
      });
    },
  );

  it.each([1, 2, 8, 13, 4095])(
    "preserves failed exec errno %i, not an application exit",
    (errno) => {
      expect(parseNativeObserverResult(wire(4, errno), correlation)).toEqual({
        kind: "exec_failed",
        errno,
        clone3FallbackUsed: false,
      });
    },
  );

  it.each([
    [3, 1, "setup_failed", "bootstrap"],
    [3, 2, "setup_failed", "namespace_setup"],
    [3, 3, "setup_failed", "filter_setup"],
    [3, 4, "setup_failed", "descriptor_handoff"],
    [6, 4, "supervisor_failed", "descriptor_handoff"],
    [6, 5, "supervisor_failed", "settlement"],
  ] as const)("preserves failure kind %i and phase %i", (kindId, stageId, kind, stage) => {
    expect(parseNativeObserverResult(wire(kindId, 5, stageId), correlation)).toEqual({
      kind,
      stage,
      errno: 5,
      clone3FallbackUsed: false,
    });
  });

  it.each([
    [1, 0, 0],
    [2, 9, 0],
    [3, 5, 3],
    [4, 13, 0],
    [5, 0, 0],
    [6, 5, 5],
  ])("retains clone3 intervention for terminal kind %i", (kind, detail, stage) => {
    expect(parseNativeObserverResult(wire(kind, detail, stage, 1), correlation)).toMatchObject({
      clone3FallbackUsed: true,
    });
  });

  it("retains policy interference without interpreting the parent's status", () => {
    expect(parseNativeObserverResult(wire(5, 0), correlation)).toEqual({
      kind: "policy_interference",
      clone3FallbackUsed: false,
    });
  });

  it.each([
    [0, 0, 0, 0],
    [7, 0, 0, 0],
    [0xffff_ffff, 0, 0, 0],
    [1, 256, 0, 0],
    [1, 0xffff_ffff, 0, 0],
    [1, 0, 1, 0],
    [2, 0, 0, 0],
    [2, 65, 0, 0],
    [2, 15, 1, 0],
    [3, 0, 1, 0],
    [3, 4096, 1, 0],
    [3, 5, 0, 0],
    [3, 5, 5, 0],
    [3, 5, 0xffff_ffff, 0],
    [4, 0, 0, 0],
    [4, 4096, 0, 0],
    [4, 13, 1, 0],
    [5, 1, 0, 0],
    [5, 0, 1, 0],
    [6, 0, 5, 0],
    [6, 4096, 5, 0],
    [6, 5, 0, 0],
    [6, 5, 3, 0],
    [6, 5, 6, 0],
    [1, 0, 0, 2],
    [1, 0, 0, 3],
    [5, 0, 0, 0x8000_0000],
  ])("rejects impossible or unknown fields %j/%j/%j/%j", (kind, detail, stage, flags) => {
    expect(parseNativeObserverResult(wire(kind, detail, stage, flags), correlation)).toBeNull();
  });

  it.each(Array.from({ length: 64 }, (_, length) => length))(
    "rejects a truncated frame of %i bytes",
    (length) => {
      expect(parseNativeObserverResult(wire(1, 0).subarray(0, length), correlation)).toBeNull();
    },
  );

  it.each([Buffer.alloc(1), Buffer.from("\n"), wire(1, 0), Buffer.alloc(8192)])(
    "rejects trailing bytes, including a duplicate frame",
    (suffix) => {
      expect(
        parseNativeObserverResult(Buffer.concat([wire(1, 0), suffix]), correlation),
      ).toBeNull();
    },
  );

  it.each(Array.from({ length: 8 }, (_, offset) => offset))(
    "rejects changed magic/version byte %i",
    (offset) => {
      const frame = wire(1, 0);
      frame[offset] = 0;
      expect(parseNativeObserverResult(frame, correlation)).toBeNull();
    },
  );

  it.each(Array.from({ length: 32 }, (_, offset) => offset + 8))(
    "rejects a mismatched correlation byte %i",
    (offset) => {
      const frame = wire(1, 0);
      frame[offset] = (frame[offset] ?? 0) ^ 1;
      expect(parseNativeObserverResult(frame, correlation)).toBeNull();
    },
  );

  it.each(Array.from({ length: 8 }, (_, offset) => offset + 56))(
    "rejects nonzero reserved byte %i",
    (offset) => {
      const frame = wire(1, 0);
      frame[offset] = 1;
      expect(parseNativeObserverResult(frame, correlation)).toBeNull();
    },
  );

  it.each([
    null,
    undefined,
    0,
    {},
    "",
    correlation.toUpperCase(),
    `${correlation}\n`,
    correlation.slice(2),
  ])("rejects a malformed host correlation value %j", (token) => {
    expect(parseNativeObserverResult(wire(1, 0), token)).toBeNull();
  });

  it.each([null, undefined, {}, [], "FLOWOBS1", new Uint8Array(64)])(
    "rejects non-Buffer input %j",
    (input) => {
      expect(parseNativeObserverResult(input, correlation)).toBeNull();
    },
  );

  it("rejects concurrently mutable shared memory", () => {
    const shared = Buffer.from(new SharedArrayBuffer(64));
    wire(1, 0).copy(shared);
    expect(parseNativeObserverResult(shared, correlation)).toBeNull();
  });

  it("returns a detached frozen record from a Buffer view", () => {
    const allocation = Buffer.concat([Buffer.alloc(16), wire(1, 127), Buffer.alloc(16)]);
    const frame = allocation.subarray(16, 80);
    const result = parseNativeObserverResult(frame, correlation);
    expect(result).toEqual({ kind: "normal_exit", exitCode: 127, clone3FallbackUsed: false });
    expect(Object.isFrozen(result)).toBe(true);
    allocation.fill(0);
    expect(result).toEqual({ kind: "normal_exit", exitCode: 127, clone3FallbackUsed: false });
  });
});

function wire(kind: number, detail: number, stage = 0, flags = 0): Buffer {
  const frame = Buffer.alloc(64);
  frame.write("FLOWOBS1", 0, "ascii");
  Buffer.from(correlation, "hex").copy(frame, 8);
  frame.writeUInt32LE(kind, 40);
  frame.writeUInt32LE(detail, 44);
  frame.writeUInt32LE(stage, 48);
  frame.writeUInt32LE(flags, 52);
  return frame;
}
