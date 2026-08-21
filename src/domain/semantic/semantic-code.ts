import { createHash } from "node:crypto";

import { z } from "zod";

export const MAX_SEMANTIC_PROJECT_PATHS = 4_096;
export const MAX_SEMANTIC_RESULT_ITEMS = 512;
export const MAX_SEMANTIC_MESSAGE_BYTES = 4_096;
export const MAX_SEMANTIC_HOVER_BYTES = 16_384;
export const MAX_SEMANTIC_CODE_BYTES = 256;
export const MAX_SEMANTIC_PATH_BYTES = 1_024;
export const MAX_SEMANTIC_POSITION = 10_000_000;
export const MAX_SEMANTIC_QUERY_RECEIPTS = 16;
export const MAX_SEMANTIC_RECEIPT_RESULT_BYTES = 1024 * 1024;

export type SemanticOperation = "diagnostics" | "definition" | "references" | "hover";
export type SemanticSeverity = "error" | "warning" | "information" | "hint";

export interface SemanticPosition {
  readonly line: number;
  readonly character: number;
}

export interface SemanticRange {
  readonly start: SemanticPosition;
  readonly end: SemanticPosition;
}

export interface SemanticLocation {
  readonly path: string;
  readonly range: SemanticRange;
}

export interface SemanticDiagnostic extends SemanticLocation {
  readonly severity: SemanticSeverity;
  readonly code?: string | undefined;
  readonly message: string;
}

export interface SemanticHover extends SemanticLocation {
  readonly format: "plaintext" | "markdown";
  readonly value: string;
}

export type SemanticRequest =
  | {
      readonly operation: "diagnostics";
      readonly path: string;
    }
  | {
      readonly operation: "definition" | "references" | "hover";
      readonly path: string;
      readonly position: SemanticPosition;
    };

export type SemanticResult =
  | {
      readonly operation: "diagnostics";
      readonly diagnostics: readonly SemanticDiagnostic[];
    }
  | {
      readonly operation: "definition" | "references";
      readonly locations: readonly SemanticLocation[];
    }
  | {
      readonly operation: "hover";
      readonly hover: SemanticHover | null;
    };

export interface SemanticSandboxEvidence {
  readonly backend: string;
  readonly backendVersion: string;
  readonly profile: string;
  readonly policyDigest: string;
}

export interface SemanticQueryReceipt {
  readonly version: 1;
  readonly sequence: number;
  readonly request: SemanticRequest;
  readonly requestDigest: string;
  readonly projectDigest: string;
  readonly sourceDigest: string;
  readonly languageServerDigest: string;
  readonly sandbox: SemanticSandboxEvidence;
  readonly result: SemanticResult;
  readonly resultDigest: string;
  readonly digest: string;
}

export interface SemanticQueryReceiptInput {
  readonly sequence: number;
  readonly request: SemanticRequest;
  readonly projectDigest: string;
  readonly sourceDigest: string;
  readonly languageServerDigest: string;
  readonly sandbox: SemanticSandboxEvidence;
  readonly result: SemanticResult;
}

const positionSchema = z
  .object({
    line: z.number().int().nonnegative().max(MAX_SEMANTIC_POSITION),
    character: z.number().int().nonnegative().max(MAX_SEMANTIC_POSITION),
  })
  .strict();

const rangeSchema = z
  .object({ start: positionSchema, end: positionSchema })
  .strict()
  .refine((range) => comparePosition(range.start, range.end) <= 0, "range must not be inverted");

const pathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_SEMANTIC_PATH_BYTES,
    "path is too large",
  )
  .refine(isPortableRelativePath, "path must be a canonical portable relative path");

const safeTextSchema = (maximumBytes: number) =>
  z
    .string()
    .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes, "text is too large")
    .refine((value) => !containsControlCharacter(value), "text contains a control character");

const locationSchema = z.object({ path: pathSchema, range: rangeSchema }).strict();

const diagnosticSchema = z
  .object({
    path: pathSchema,
    range: rangeSchema,
    severity: z.enum(["error", "warning", "information", "hint"]),
    code: safeTextSchema(MAX_SEMANTIC_CODE_BYTES).min(1).optional(),
    message: safeTextSchema(MAX_SEMANTIC_MESSAGE_BYTES).min(1),
  })
  .strict();

const hoverSchema = z
  .object({
    path: pathSchema,
    range: rangeSchema,
    format: z.enum(["plaintext", "markdown"]),
    value: safeTextSchema(MAX_SEMANTIC_HOVER_BYTES),
  })
  .strict();

const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("diagnostics"), path: pathSchema }).strict(),
  z
    .object({
      operation: z.enum(["definition", "references", "hover"]),
      path: pathSchema,
      position: positionSchema,
    })
    .strict(),
]);

const resultSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("diagnostics"),
      diagnostics: z.array(diagnosticSchema).max(MAX_SEMANTIC_RESULT_ITEMS),
    })
    .strict(),
  z
    .object({
      operation: z.enum(["definition", "references"]),
      locations: z.array(locationSchema).max(MAX_SEMANTIC_RESULT_ITEMS),
    })
    .strict(),
  z.object({ operation: z.literal("hover"), hover: hoverSchema.nullable() }).strict(),
]);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceTextSchema = (maximumBytes: number) => safeTextSchema(maximumBytes).min(1);
const semanticSandboxEvidenceSchema = z
  .object({
    backend: evidenceTextSchema(128),
    backendVersion: evidenceTextSchema(128),
    profile: evidenceTextSchema(256),
    policyDigest: sha256Schema,
  })
  .strict();

export const semanticQueryReceiptSchema: z.ZodType<SemanticQueryReceipt> = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive().max(MAX_SEMANTIC_QUERY_RECEIPTS),
    request: requestSchema,
    requestDigest: sha256Schema,
    projectDigest: sha256Schema,
    sourceDigest: sha256Schema,
    languageServerDigest: sha256Schema,
    sandbox: semanticSandboxEvidenceSchema,
    result: resultSchema,
    resultDigest: sha256Schema,
    digest: sha256Schema,
  })
  .strict();

export class SemanticContractError extends Error {
  readonly code:
    | "semantic_receipt_invalid"
    | "semantic_request_invalid"
    | "semantic_result_invalid";

  constructor(
    code: "semantic_receipt_invalid" | "semantic_request_invalid" | "semantic_result_invalid",
  ) {
    super(
      code === "semantic_request_invalid"
        ? "semantic request is invalid"
        : code === "semantic_result_invalid"
          ? "semantic result is invalid"
          : "semantic receipt is invalid",
    );
    this.name = "SemanticContractError";
    this.code = code;
  }
}

export function normalizeSemanticRequest(input: unknown): SemanticRequest {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    throw new SemanticContractError("semantic_request_invalid");
  }
  return deepFreeze(parsed.data as SemanticRequest);
}

export function normalizeSemanticResult(
  input: unknown,
  projectPaths: readonly string[],
): SemanticResult {
  if (
    projectPaths.length > MAX_SEMANTIC_PROJECT_PATHS ||
    new Set(projectPaths).size !== projectPaths.length ||
    projectPaths.some((path) => !pathSchema.safeParse(path).success)
  ) {
    throw new SemanticContractError("semantic_result_invalid");
  }
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) {
    throw new SemanticContractError("semantic_result_invalid");
  }
  const allowed = new Set(projectPaths);
  if (parsed.data.operation === "diagnostics") {
    assertAllowed(parsed.data.diagnostics, allowed);
    return deepFreeze({
      operation: parsed.data.operation,
      diagnostics: [...parsed.data.diagnostics].sort(compareDiagnostic),
    });
  }
  if (parsed.data.operation === "definition" || parsed.data.operation === "references") {
    assertAllowed(parsed.data.locations, allowed);
    const locations = [
      ...new Map(
        parsed.data.locations.map((location) => [locationKey(location), location]),
      ).values(),
    ].sort(compareLocation);
    return deepFreeze({ operation: parsed.data.operation, locations });
  }
  if (parsed.data.operation === "hover") {
    if (parsed.data.hover !== null) {
      assertAllowed([parsed.data.hover], allowed);
    }
    return deepFreeze(parsed.data as SemanticResult);
  }
  throw new SemanticContractError("semantic_result_invalid");
}

export function createSemanticQueryReceipt(input: SemanticQueryReceiptInput): SemanticQueryReceipt {
  const request = normalizeSemanticRequest(input.request);
  const result = normalizeSemanticResult(input.result, semanticReceiptPaths(request, input.result));
  const requestDigest = sha256(JSON.stringify(request));
  const resultDigest = sha256(JSON.stringify(result));
  const receiptWithoutDigest = {
    version: 1 as const,
    sequence: input.sequence,
    request,
    requestDigest,
    projectDigest: input.projectDigest,
    sourceDigest: input.sourceDigest,
    languageServerDigest: input.languageServerDigest,
    sandbox: input.sandbox,
    result,
    resultDigest,
  };
  return validateSemanticQueryReceipt({
    ...receiptWithoutDigest,
    digest: sha256(JSON.stringify(receiptWithoutDigest)),
  });
}

export function validateSemanticQueryReceipt(input: unknown): SemanticQueryReceipt {
  const parsed = semanticQueryReceiptSchema.safeParse(input);
  if (!parsed.success) {
    throw new SemanticContractError("semantic_receipt_invalid");
  }
  let request: SemanticRequest;
  let result: SemanticResult;
  try {
    request = normalizeSemanticRequest(parsed.data.request);
    result = normalizeSemanticResult(
      parsed.data.result,
      semanticReceiptPaths(request, parsed.data.result),
    );
  } catch {
    throw new SemanticContractError("semantic_receipt_invalid");
  }
  const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  const receiptWithoutDigest = {
    version: parsed.data.version,
    sequence: parsed.data.sequence,
    request,
    requestDigest: parsed.data.requestDigest,
    projectDigest: parsed.data.projectDigest,
    sourceDigest: parsed.data.sourceDigest,
    languageServerDigest: parsed.data.languageServerDigest,
    sandbox: parsed.data.sandbox,
    result,
    resultDigest: parsed.data.resultDigest,
  };
  if (
    result.operation !== request.operation ||
    resultBytes > MAX_SEMANTIC_RECEIPT_RESULT_BYTES ||
    parsed.data.requestDigest !== sha256(JSON.stringify(request)) ||
    parsed.data.resultDigest !== sha256(JSON.stringify(result)) ||
    JSON.stringify(result) !== JSON.stringify(parsed.data.result) ||
    parsed.data.digest !== sha256(JSON.stringify(receiptWithoutDigest))
  ) {
    throw new SemanticContractError("semantic_receipt_invalid");
  }
  return deepFreeze({
    ...receiptWithoutDigest,
    digest: parsed.data.digest,
  });
}

function semanticReceiptPaths(request: SemanticRequest, result: SemanticResult): readonly string[] {
  const paths = new Set<string>([request.path]);
  if (result.operation === "diagnostics") {
    for (const diagnostic of result.diagnostics) paths.add(diagnostic.path);
  } else if (result.operation === "definition" || result.operation === "references") {
    for (const location of result.locations) paths.add(location.path);
  } else if (result.operation === "hover" && result.hover !== null) {
    paths.add(result.hover.path);
  }
  return [...paths].sort(compareStrings);
}

function assertAllowed(
  values: readonly { readonly path: string }[],
  allowed: ReadonlySet<string>,
): void {
  if (values.some((value) => !allowed.has(value.path))) {
    throw new SemanticContractError("semantic_result_invalid");
  }
}

function compareDiagnostic(left: SemanticDiagnostic, right: SemanticDiagnostic): number {
  return (
    compareLocation(left, right) ||
    compareStrings(left.severity, right.severity) ||
    compareStrings(left.code ?? "", right.code ?? "") ||
    compareStrings(left.message, right.message)
  );
}

function compareLocation(left: SemanticLocation, right: SemanticLocation): number {
  return compareStrings(locationKey(left), locationKey(right));
}

function locationKey(value: SemanticLocation): string {
  const range = value.range;
  return `${value.path}\0${padded(range.start.line)}\0${padded(range.start.character)}\0${padded(
    range.end.line,
  )}\0${padded(range.end.character)}`;
}

function padded(value: number): string {
  return String(value).padStart(8, "0");
}

function comparePosition(left: SemanticPosition, right: SemanticPosition): number {
  return left.line - right.line || left.character - right.character;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPortableRelativePath(value: string): boolean {
  if (
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !containsControlCharacter(segment),
    );
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
