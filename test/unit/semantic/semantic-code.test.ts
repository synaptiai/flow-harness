import { describe, expect, it } from "vitest";

import {
  createSemanticQueryReceipt,
  MAX_SEMANTIC_CODE_BYTES,
  MAX_SEMANTIC_HOVER_BYTES,
  MAX_SEMANTIC_MESSAGE_BYTES,
  MAX_SEMANTIC_PATH_BYTES,
  MAX_SEMANTIC_POSITION,
  MAX_SEMANTIC_PROJECT_PATHS,
  MAX_SEMANTIC_RECEIPT_RESULT_BYTES,
  MAX_SEMANTIC_RESULT_ITEMS,
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

  it("binds exact UTF-8 path and position request limits", () => {
    const exactPath = `${"é".repeat((MAX_SEMANTIC_PATH_BYTES - 4) / 2)}a.ts`;
    expect(Buffer.byteLength(exactPath, "utf8")).toBe(MAX_SEMANTIC_PATH_BYTES);
    expect(
      normalizeSemanticRequest({
        operation: "hover",
        path: exactPath,
        position: { line: MAX_SEMANTIC_POSITION, character: MAX_SEMANTIC_POSITION },
      }),
    ).toMatchObject({ path: exactPath });
    expect(() =>
      normalizeSemanticRequest({ operation: "diagnostics", path: `${exactPath}b` }),
    ).toThrow(/semantic request is invalid/i);
    expect(() =>
      normalizeSemanticRequest({
        operation: "hover",
        path: "src/example.ts",
        position: { line: MAX_SEMANTIC_POSITION + 1, character: 0 },
      }),
    ).toThrow(/semantic request is invalid/i);
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

  it("binds exact and plus-one semantic text limits in UTF-8 bytes", () => {
    const exactDiagnostic = {
      operation: "diagnostics" as const,
      diagnostics: [
        {
          path: "src/example.ts",
          range: range(0, 0, 0, 1),
          severity: "error" as const,
          code: "c".repeat(MAX_SEMANTIC_CODE_BYTES),
          message: "é".repeat(MAX_SEMANTIC_MESSAGE_BYTES / 2),
        },
      ],
    };
    const exactHover = {
      operation: "hover" as const,
      hover: {
        path: "src/example.ts",
        range: range(0, 0, 0, 1),
        format: "plaintext" as const,
        value: "é".repeat(MAX_SEMANTIC_HOVER_BYTES / 2),
      },
    };

    expect(normalizeSemanticResult(exactDiagnostic, ["src/example.ts"])).toEqual(exactDiagnostic);
    expect(normalizeSemanticResult(exactHover, ["src/example.ts"])).toEqual(exactHover);
    expect(() =>
      normalizeSemanticResult(
        {
          ...exactDiagnostic,
          diagnostics: [
            { ...exactDiagnostic.diagnostics[0], code: "c".repeat(MAX_SEMANTIC_CODE_BYTES + 1) },
          ],
        },
        ["src/example.ts"],
      ),
    ).toThrow(/semantic result is invalid/i);
    expect(() =>
      normalizeSemanticResult(
        {
          ...exactDiagnostic,
          diagnostics: [
            {
              ...exactDiagnostic.diagnostics[0],
              message: `${exactDiagnostic.diagnostics[0]?.message}x`,
            },
          ],
        },
        ["src/example.ts"],
      ),
    ).toThrow(/semantic result is invalid/i);
    expect(() =>
      normalizeSemanticResult(
        { ...exactHover, hover: { ...exactHover.hover, value: `${exactHover.hover.value}x` } },
        ["src/example.ts"],
      ),
    ).toThrow(/semantic result is invalid/i);
  });

  it("binds exact and plus-one result and project-path counts", () => {
    const locations = Array.from({ length: MAX_SEMANTIC_RESULT_ITEMS }, (_, index) => ({
      path: "src/example.ts",
      range: range(index, 0, index, 1),
    }));
    const projectPaths = Array.from(
      { length: MAX_SEMANTIC_PROJECT_PATHS },
      (_, index) => `src/file-${index}.ts`,
    );

    expect(
      normalizeSemanticResult({ operation: "references", locations }, ["src/example.ts"]),
    ).toMatchObject({ operation: "references", locations });
    expect(() =>
      normalizeSemanticResult(
        { operation: "references", locations: [...locations, locations[0]] },
        ["src/example.ts"],
      ),
    ).toThrow(/semantic result is invalid/i);
    expect(
      normalizeSemanticResult({ operation: "diagnostics", diagnostics: [] }, projectPaths),
    ).toEqual({ operation: "diagnostics", diagnostics: [] });
    expect(() =>
      normalizeSemanticResult({ operation: "diagnostics", diagnostics: [] }, [
        ...projectPaths,
        "src/plus-one.ts",
      ]),
    ).toThrow(/semantic result is invalid/i);
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

  it("binds the exact and plus-one persisted result byte limit", () => {
    const exactResult = diagnosticResultWithBytes(MAX_SEMANTIC_RECEIPT_RESULT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(exactResult), "utf8")).toBe(
      MAX_SEMANTIC_RECEIPT_RESULT_BYTES,
    );
    expect(() => createReceiptForResult(exactResult)).not.toThrow();

    const diagnostics = [...exactResult.diagnostics];
    const index = diagnostics.findIndex(
      (diagnostic) => Buffer.byteLength(diagnostic.message, "utf8") < MAX_SEMANTIC_MESSAGE_BYTES,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const diagnostic = diagnostics[index];
    if (diagnostic === undefined) throw new Error("exact result has no expandable diagnostic");
    diagnostics[index] = { ...diagnostic, message: `${diagnostic.message}x` };
    expect(() => createReceiptForResult({ ...exactResult, diagnostics })).toThrow(
      /semantic receipt is invalid/i,
    );
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

function createReceiptForResult(result: ReturnType<typeof diagnosticResultWithBytes>) {
  return createSemanticQueryReceipt({
    sequence: 1,
    request: { operation: "diagnostics", path: "src/example.ts" },
    projectDigest: "a".repeat(64),
    sourceDigest: "b".repeat(64),
    languageServerDigest: "c".repeat(64),
    sandbox: {
      backend: "sandbox-runtime",
      backendVersion: "1.2.3",
      profile: "workspace-readonly-network-deny-v1",
      policyDigest: "d".repeat(64),
    },
    result,
  });
}

function diagnosticResultWithBytes(targetBytes: number) {
  const diagnostics = Array.from({ length: 256 }, (_, index) => ({
    path: "src/example.ts",
    range: range(index, 0, index, 1),
    severity: "error" as const,
    message: "x",
  }));
  const result = { operation: "diagnostics" as const, diagnostics };
  let remaining = targetBytes - Buffer.byteLength(JSON.stringify(result), "utf8");
  for (let index = 0; index < diagnostics.length && remaining > 0; index += 1) {
    const diagnostic = diagnostics[index];
    if (diagnostic === undefined) break;
    const added = Math.min(remaining, MAX_SEMANTIC_MESSAGE_BYTES - 1);
    diagnostics[index] = { ...diagnostic, message: `${diagnostic.message}${"x".repeat(added)}` };
    remaining -= added;
  }
  if (remaining !== 0) throw new Error("cannot construct the exact semantic result boundary");
  return result;
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}
