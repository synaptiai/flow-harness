import { describe, expect, it } from "vitest";

import {
  evaluateOptimizationBaseline,
  evaluateOptimizationCandidate,
  OptimizationResultError,
  resolveOptimizationPointerSchema,
} from "../../../src/domain/result/optimization-result.js";
import type { CompiledResultSchema } from "../../../src/domain/workflow/types.js";

const resultSchema = {
  type: "object",
  properties: {
    measurements: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
    },
    "a/b": {
      type: "object",
      properties: { "~stable": { type: "string", maxLength: 16 } },
      required: ["~stable"],
    },
  },
  required: ["measurements", "a/b"],
} as const satisfies CompiledResultSchema;

describe("optimization result evidence", () => {
  it("resolves RFC 6901 object escapes and array indices against values and schemas", () => {
    const observation = evaluateOptimizationBaseline({
      source: '{"a/b":{"~stable":"yes"},"measurements":[{"value":4.5}]}',
      schema: resultSchema,
      metric: { pointer: "/measurements/0/value", direction: "minimize" },
      invariants: [{ pointer: "/a~1b/~0stable", equals: "yes" }],
    });

    expect(observation).toMatchObject({
      metric: 4.5,
      invariants: [{ pointer: "/a~1b/~0stable", expected: "yes", actual: "yes", passed: true }],
    });
    expect(resolveOptimizationPointerSchema(resultSchema, "/measurements/0/value")).toEqual({
      type: "number",
    });
  });

  it.each(["relative", "/bad~2escape", "/measurements/01/value", "/measurements/-/value"])(
    "rejects malformed or non-resolving JSON Pointer syntax: %s",
    (pointer) => {
      expectOptimizationError(
        () => resolveOptimizationPointerSchema(resultSchema, pointer),
        "optimization_pointer_invalid",
      );
    },
  );

  it("rejects a pointer that is valid for the schema but absent from the runtime value", () => {
    expectOptimizationError(
      () =>
        evaluateOptimizationBaseline({
          source: '{"a/b":{"~stable":"yes"},"measurements":[]}',
          schema: resultSchema,
          metric: { pointer: "/measurements/0/value", direction: "minimize" },
          invariants: [{ pointer: "/a~1b/~0stable", equals: "yes" }],
        }),
      "optimization_pointer_unresolved",
    );
  });

  it.each([
    ["minimize", 9, 10, "accepted"],
    ["minimize", 10, 10, "rejected"],
    ["minimize", 11, 10, "rejected"],
    ["maximize", 11, 10, "accepted"],
    ["maximize", 10, 10, "rejected"],
    ["maximize", 9, 10, "rejected"],
  ] as const)(
    "uses strict %s improvement when candidate=%d and best=%d",
    (direction, candidateMetric, bestMetric, decision) => {
      const observation = evaluateOptimizationCandidate({
        source: candidateSource(candidateMetric, "yes"),
        schema: resultSchema,
        metric: { pointer: "/measurements/0/value", direction },
        invariants: [{ pointer: "/a~1b/~0stable", equals: "yes" }],
        bestMetric,
        priorStagnation: 0,
        maxConsecutiveNonImproving: 2,
      });

      expect(observation.decision).toBe(decision);
      expect(observation.reason).toBe(decision === "accepted" ? "improved" : "not_improved");
    },
  );

  it("rejects an improving metric when an invariant fails", () => {
    const observation = evaluateOptimizationCandidate({
      source: candidateSource(1, "no"),
      schema: resultSchema,
      metric: { pointer: "/measurements/0/value", direction: "minimize" },
      invariants: [{ pointer: "/a~1b/~0stable", equals: "yes" }],
      bestMetric: 10,
      priorStagnation: 0,
      maxConsecutiveNonImproving: 2,
    });

    expect(observation).toMatchObject({
      decision: "rejected",
      reason: "invariant_failed",
      stagnation: 1,
      stop: false,
    });
  });

  it("increments stagnation to its bound for rejections and resets it after improvement", () => {
    const rejected = evaluateOptimizationCandidate({
      source: candidateSource(10, "yes"),
      schema: resultSchema,
      metric: { pointer: "/measurements/0/value", direction: "minimize" },
      invariants: [{ pointer: "/a~1b/~0stable", equals: "yes" }],
      bestMetric: 10,
      priorStagnation: 1,
      maxConsecutiveNonImproving: 2,
    });
    const accepted = evaluateOptimizationCandidate({
      source: candidateSource(9, "yes"),
      schema: resultSchema,
      metric: { pointer: "/measurements/0/value", direction: "minimize" },
      invariants: [{ pointer: "/a~1b/~0stable", equals: "yes" }],
      bestMetric: 10,
      priorStagnation: 1,
      maxConsecutiveNonImproving: 2,
    });

    expect(rejected).toMatchObject({ stagnation: 2, stop: true });
    expect(accepted).toMatchObject({ stagnation: 0, stop: false });
  });
});

function candidateSource(metric: number, invariant: string): string {
  return JSON.stringify({
    measurements: [{ value: metric }],
    "a/b": { "~stable": invariant },
  });
}

function expectOptimizationError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(OptimizationResultError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected optimization result error ${code}`);
}
