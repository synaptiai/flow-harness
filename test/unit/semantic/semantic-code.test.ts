import { describe, expect, it } from "vitest";

import {
  createSemanticQueryReceipt,
  normalizeSemanticRequest,
  normalizeSemanticResult,
  validateSemanticQueryReceipt,
} from "../../../src/domain/semantic/semantic-code.js";

describe("semantic code contract", () => {
  it.each(["definition", "references", "hover"] as const)(
    "normalizes a position-based %s request",
    (operation) => {
      expect(
        normalizeSemanticRequest({
          operation,
          path: "src/example.ts",
          position: { line: 12, character: 7 },
        }),
      ).toEqual({
        operation,
        path: "src/example.ts",
        position: { line: 12, character: 7 },
      });
    },
  );

  it("normalizes a file-wide diagnostics request", () => {
    expect(normalizeSemanticRequest({ operation: "diagnostics", path: "src/example.ts" })).toEqual({
      operation: "diagnostics",
      path: "src/example.ts",
    });
  });

  it.each([
    {
      label: "foreign operation",
      input: { operation: "rename", path: "src/example.ts" },
    },
    {
      label: "absolute path",
      input: { operation: "diagnostics", path: "/private/example.ts" },
    },
    {
      label: "parent traversal",
      input: { operation: "diagnostics", path: "../private.ts" },
    },
    {
      label: "missing position",
      input: { operation: "definition", path: "src/example.ts" },
    },
    {
      label: "unexpected position",
      input: {
        operation: "diagnostics",
        path: "src/example.ts",
        position: { line: 0, character: 0 },
      },
    },
    {
      label: "negative position",
      input: {
        operation: "hover",
        path: "src/example.ts",
        position: { line: -1, character: 0 },
      },
    },
  ])("rejects a noncanonical request: $label", ({ input }) => {
    expect(() => normalizeSemanticRequest(input)).toThrow(/semantic request is invalid/i);
  });

  it("normalizes and deterministically sorts diagnostics", () => {
    expect(
      normalizeSemanticResult(
        {
          operation: "diagnostics",
          diagnostics: [
            {
              path: "src/z.ts",
              range: range(7, 1, 7, 4),
              severity: "warning",
              message: "Second diagnostic",
            },
            {
              path: "src/a.ts",
              range: range(2, 0, 2, 3),
              severity: "error",
              code: "TS1001",
              message: "First diagnostic",
            },
          ],
        },
        ["src/a.ts", "src/z.ts"],
      ),
    ).toEqual({
      operation: "diagnostics",
      diagnostics: [
        {
          path: "src/a.ts",
          range: range(2, 0, 2, 3),
          severity: "error",
          code: "TS1001",
          message: "First diagnostic",
        },
        {
          path: "src/z.ts",
          range: range(7, 1, 7, 4),
          severity: "warning",
          message: "Second diagnostic",
        },
      ],
    });
  });

  it.each(["definition", "references"] as const)(
    "deduplicates and sorts %s locations",
    (operation) => {
      const first = { path: "src/a.ts", range: range(1, 0, 1, 5) };
      const second = { path: "src/z.ts", range: range(4, 2, 4, 6) };

      expect(
        normalizeSemanticResult({ operation, locations: [second, first, structuredClone(first)] }, [
          "src/a.ts",
          "src/z.ts",
        ]),
      ).toEqual({ operation, locations: [first, second] });
    },
  );

  it("normalizes bounded hover text without changing its meaning", () => {
    expect(
      normalizeSemanticResult(
        {
          operation: "hover",
          hover: {
            path: "src/example.ts",
            range: range(3, 2, 3, 9),
            format: "markdown",
            value: "`const value: string`",
          },
        },
        ["src/example.ts"],
      ),
    ).toEqual({
      operation: "hover",
      hover: {
        path: "src/example.ts",
        range: range(3, 2, 3, 9),
        format: "markdown",
        value: "`const value: string`",
      },
    });
  });

  it.each([
    {
      label: "foreign location",
      result: {
        operation: "definition",
        locations: [{ path: "private/secret.ts", range: range(0, 0, 0, 1) }],
      },
      allowed: ["src/example.ts"],
    },
    {
      label: "inverted range",
      result: {
        operation: "references",
        locations: [{ path: "src/example.ts", range: range(4, 0, 3, 0) }],
      },
      allowed: ["src/example.ts"],
    },
    {
      label: "control character",
      result: {
        operation: "diagnostics",
        diagnostics: [
          {
            path: "src/example.ts",
            range: range(0, 0, 0, 1),
            severity: "error",
            message: "PRIVATE\u0000MESSAGE",
          },
        ],
      },
      allowed: ["src/example.ts"],
    },
  ])("rejects an unsafe normalized result: $label", ({ result, allowed }) => {
    expect(() => normalizeSemanticResult(result, allowed)).toThrow(/semantic result is invalid/i);
  });

  it("creates and validates a digest-bound semantic query receipt", () => {
    const receipt = createSemanticQueryReceipt({
      sequence: 1,
      request: {
        operation: "hover",
        path: "src/example.ts",
        position: { line: 3, character: 2 },
      },
      projectDigest: "a".repeat(64),
      sourceDigest: "b".repeat(64),
      languageServerDigest: "c".repeat(64),
      sandbox: {
        backend: "sandbox-runtime",
        backendVersion: "1.2.3",
        profile: "workspace-readonly-network-deny-v1",
        policyDigest: "d".repeat(64),
      },
      result: {
        operation: "hover",
        hover: {
          path: "src/example.ts",
          range: range(3, 2, 3, 9),
          format: "markdown",
          value: "`const value: string`",
        },
      },
    });

    expect(receipt).toMatchObject({
      version: 1,
      sequence: 1,
      request: { operation: "hover", path: "src/example.ts" },
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      projectDigest: "a".repeat(64),
      sourceDigest: "b".repeat(64),
      languageServerDigest: "c".repeat(64),
      resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(validateSemanticQueryReceipt(structuredClone(receipt))).toEqual(receipt);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it.each([
    {
      label: "request substitution",
      mutate: (receipt: ReturnType<typeof validReceipt>) => ({
        ...receipt,
        request: { operation: "diagnostics" as const, path: "src/example.ts" },
      }),
    },
    {
      label: "result substitution",
      mutate: (receipt: ReturnType<typeof validReceipt>) => ({
        ...receipt,
        result: {
          operation: "hover" as const,
          hover: {
            path: "src/example.ts",
            range: range(0, 0, 0, 1),
            format: "plaintext" as const,
            value: "PRIVATE_SUBSTITUTED_RESULT",
          },
        },
      }),
    },
    {
      label: "server substitution",
      mutate: (receipt: ReturnType<typeof validReceipt>) => ({
        ...receipt,
        languageServerDigest: "e".repeat(64),
      }),
    },
  ])("rejects a $label in durable semantic evidence", ({ mutate }) => {
    expect(() => validateSemanticQueryReceipt(mutate(validReceipt()))).toThrow(
      /semantic receipt is invalid/i,
    );
  });
});

function validReceipt() {
  return createSemanticQueryReceipt({
    sequence: 1,
    request: {
      operation: "hover",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    },
    projectDigest: "a".repeat(64),
    sourceDigest: "b".repeat(64),
    languageServerDigest: "c".repeat(64),
    sandbox: {
      backend: "sandbox-runtime",
      backendVersion: "1.2.3",
      profile: "workspace-readonly-network-deny-v1",
      policyDigest: "d".repeat(64),
    },
    result: { operation: "hover", hover: null },
  });
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}
