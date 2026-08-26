import { describe, expect, it } from "vitest";

import { evaluateModelRequestCapacity } from "../../../src/domain/run/model-request-capacity.js";

describe("model request capacity", () => {
  it("admits below pressure and identifies the first exact threshold token", () => {
    expect(
      evaluateModelRequestCapacity({
        contextWindowTokens: 272_000,
        outputAllowanceTokens: 128_000,
        safetyReserveTokens: 16_384,
        pressureThresholdPercent: 85,
        measuredInputTokens: 108_473,
      }),
    ).toMatchObject({
      usableInputTokens: 127_616,
      measuredInputTokens: 108_473,
      decision: "admitted",
    });

    expect(
      evaluateModelRequestCapacity({
        contextWindowTokens: 272_000,
        outputAllowanceTokens: 128_000,
        safetyReserveTokens: 16_384,
        pressureThresholdPercent: 85,
        measuredInputTokens: 108_474,
      }),
    ).toMatchObject({ decision: "reduction_required" });
  });

  it("uses the actual serialized output allowance", () => {
    expect(
      evaluateModelRequestCapacity({
        contextWindowTokens: 1_000_000,
        outputAllowanceTokens: 64_000,
        safetyReserveTokens: 16_384,
        pressureThresholdPercent: 85,
        measuredInputTokens: 781_673,
      }),
    ).toMatchObject({ usableInputTokens: 919_616, decision: "admitted" });

    expect(
      evaluateModelRequestCapacity({
        contextWindowTokens: 1_000_000,
        outputAllowanceTokens: 64_000,
        safetyReserveTokens: 16_384,
        pressureThresholdPercent: 85,
        measuredInputTokens: 781_674,
      }),
    ).toMatchObject({ decision: "reduction_required" });
  });

  it("admits the absolute boundary and rejects one token more", () => {
    const base = {
      contextWindowTokens: 272_000,
      outputAllowanceTokens: 128_000,
      safetyReserveTokens: 16_384,
      pressureThresholdPercent: 95,
    } as const;

    expect(evaluateModelRequestCapacity({ ...base, measuredInputTokens: 127_616 })).toMatchObject({
      decision: "reduction_required",
      absoluteSafe: true,
    });
    expect(evaluateModelRequestCapacity({ ...base, measuredInputTokens: 127_617 })).toMatchObject({
      decision: "over_capacity",
      absoluteSafe: false,
    });
  });

  it("uses overflow-safe integer threshold comparison", () => {
    const contextWindowTokens = Number.MAX_SAFE_INTEGER;

    expect(
      evaluateModelRequestCapacity({
        contextWindowTokens,
        outputAllowanceTokens: 1,
        safetyReserveTokens: 1,
        pressureThresholdPercent: 95,
        measuredInputTokens: contextWindowTokens - 3,
      }),
    ).toMatchObject({ decision: "reduction_required" });
  });

  it.each([
    ["zero context", { contextWindowTokens: 0 }],
    ["negative output", { outputAllowanceTokens: -1 }],
    ["negative reserve", { safetyReserveTokens: -1 }],
    ["negative measurement", { measuredInputTokens: -1 }],
    ["low threshold", { pressureThresholdPercent: 49 }],
    ["high threshold", { pressureThresholdPercent: 96 }],
    ["fractional threshold", { pressureThresholdPercent: 84.5 }],
    [
      "no usable input",
      { contextWindowTokens: 32_768, outputAllowanceTokens: 16_384, safetyReserveTokens: 16_384 },
    ],
  ])("rejects invalid capacity arithmetic for %s", (_case, replacement) => {
    expect(() =>
      evaluateModelRequestCapacity({
        contextWindowTokens: 272_000,
        outputAllowanceTokens: 128_000,
        safetyReserveTokens: 16_384,
        pressureThresholdPercent: 85,
        measuredInputTokens: 1,
        ...replacement,
      }),
    ).toThrow();
  });
});
