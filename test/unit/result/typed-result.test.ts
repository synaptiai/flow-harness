import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { TypedResultError, evaluateTypedResult } from "../../../src/domain/result/typed-result.js";
import type { CompiledResultSchema } from "../../../src/domain/workflow/types.js";

describe("typed result values", () => {
  it("strictly validates and canonicalizes equivalent object values", () => {
    const schema: CompiledResultSchema = {
      type: "object",
      properties: {
        zeta: { type: "array", maxItems: 2, items: { type: "integer" } },
        alpha: { type: "string", maxLength: 8 },
      },
      required: ["alpha", "zeta"],
    };

    const first = evaluateTypedResult('{ "zeta": [1, 2], "alpha": "ok" }', schema);
    const second = evaluateTypedResult('{"alpha":"ok","zeta":[1.0,2e0]}', schema);

    expect(first).toEqual(second);
    expect(first).toEqual({
      canonicalValue: '{"alpha":"ok","zeta":[1,2]}',
      valueHash: sha256('{"alpha":"ok","zeta":[1,2]}'),
    });
  });

  it.each([
    ["minus zero", "-0", "0"],
    ["small exponent", "1e-7", "1e-7"],
    ["expanded threshold", "1e-6", "0.000001"],
    ["large exponent", "1e21", "1e+21"],
    ["escaped controls", '"line\\nfeed"', '"line\\nfeed"'],
  ])("uses RFC 8785-compatible ECMAScript serialization for %s", (_name, input, canonical) => {
    const schema: CompiledResultSchema = input.startsWith('"')
      ? { type: "string", maxLength: 32 }
      : { type: "number" };

    expect(evaluateTypedResult(input, schema).canonicalValue).toBe(canonical);
  });

  it.each([
    ["duplicate keys", '{"a":1,"a":2}', "result_invalid_json"],
    ["escape-equivalent duplicate keys", '{"a":1,"\\u0061":2}', "result_invalid_json"],
    ["trailing prose", "true accepted", "result_invalid_json"],
    ["multiple values", "true false", "result_invalid_json"],
    ["overflowing number", "1e400", "result_invalid_i_json"],
    ["lone high surrogate", '"\\ud800"', "result_invalid_i_json"],
    ["lone low surrogate in a key", '{"\\udc00":true}', "result_invalid_i_json"],
  ])("rejects %s", (_name, input, code) => {
    expectTypedResultError(() => evaluateTypedResult(input, permissiveSchema(input)), code);
  });

  it.each([
    ["wrong primitive", "true", { type: "number" } as const],
    ["unsafe integer", "9007199254740992", { type: "integer" } as const],
    ["number below minimum", "-1", { type: "number", minimum: 0 } as const],
    ["number above maximum", "2", { type: "number", maximum: 1 } as const],
    ["string too long", '"abcd"', { type: "string", maxLength: 3 } as const],
    [
      "array too long",
      "[true,false]",
      { type: "array", maxItems: 1, items: { type: "boolean" } } as const,
    ],
    [
      "missing required property",
      "{}",
      {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      } as const,
    ],
    [
      "unknown object property",
      '{"extra":true}',
      { type: "object", properties: {}, required: [] } as const,
    ],
    [
      "prototype-named object property",
      '{"constructor":true}',
      { type: "object", properties: {}, required: [] } as const,
    ],
  ])("rejects schema mismatch: %s", (_name, input, schema) => {
    expectTypedResultError(
      () => evaluateTypedResult(input, schema as CompiledResultSchema),
      "result_schema_mismatch",
    );
  });

  it("rejects canonical values beyond the durable result byte limit", () => {
    const input = JSON.stringify("x".repeat(262_144));
    expectTypedResultError(
      () => evaluateTypedResult(input, { type: "string", maxLength: 262_144 }),
      "result_value_too_large",
    );
  });

  it("bounds duplicate and unknown-property diagnostics for hostile long keys", () => {
    const key = "x".repeat(20_000);
    for (const [source, schema] of [
      [`{${JSON.stringify(key)}:true,${JSON.stringify(key)}:false}`, permissiveObjectSchema()],
      [`{${JSON.stringify(key)}:true}`, permissiveObjectSchema()],
    ] as const) {
      try {
        evaluateTypedResult(source, schema);
      } catch (error) {
        expect(error).toBeInstanceOf(TypedResultError);
        expect((error as Error).message.length).toBeLessThan(1_024);
        continue;
      }
      throw new Error("expected hostile property name to fail");
    }
  });
});

function permissiveObjectSchema(): CompiledResultSchema {
  return { type: "object", properties: {}, required: [] };
}

function permissiveSchema(input: string): CompiledResultSchema {
  if (input.trimStart().startsWith("{")) {
    return {
      type: "object",
      properties: { a: { type: "number" } },
      required: [],
    };
  }
  if (input.trimStart().startsWith('"')) {
    return { type: "string", maxLength: 64 };
  }
  if (input.trimStart().startsWith("t")) {
    return { type: "boolean" };
  }
  return { type: "number" };
}

function expectTypedResultError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(TypedResultError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected typed result error ${code}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
