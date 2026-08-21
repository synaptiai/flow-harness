import { z } from "zod";

export const MAX_SEMANTIC_PROJECT_PATHS = 4_096;
export const MAX_SEMANTIC_RESULT_ITEMS = 512;
export const MAX_SEMANTIC_MESSAGE_BYTES = 4_096;
export const MAX_SEMANTIC_HOVER_BYTES = 16_384;
export const MAX_SEMANTIC_CODE_BYTES = 256;
export const MAX_SEMANTIC_PATH_BYTES = 1_024;
export const MAX_SEMANTIC_POSITION = 10_000_000;

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

export class SemanticContractError extends Error {
  readonly code: "semantic_request_invalid" | "semantic_result_invalid";

  constructor(code: "semantic_request_invalid" | "semantic_result_invalid") {
    super(
      code === "semantic_request_invalid"
        ? "semantic request is invalid"
        : "semantic result is invalid",
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
