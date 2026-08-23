import { Ajv2020 } from "ajv/dist/2020.js";
import { classifyPolicyAction } from "../policy/broker.js";

export const PUBLIC_CAPABILITY_CATALOG_VERSION = "flow.public-capabilities/v1" as const;
export const PUBLIC_CAPABILITY_JSON_SCHEMA_DIALECT =
  "https://json-schema.org/draft/2020-12/schema" as const;

export type PublicJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PublicJsonValue[]
  | { readonly [key: string]: PublicJsonValue };

export type PublicAuthorityClass = "execute" | "read" | "write";
export type PublicPolicyAction =
  | "artifact.read"
  | "filesystem.list"
  | "filesystem.read"
  | "filesystem.write"
  | "process.execute";
export type PublicAvailabilityRequirement =
  | "artifact-store"
  | "command-recorder"
  | "effect-recorder"
  | "language-server"
  | "production-sandbox";
export type PublicLimitUnit =
  | "bytes"
  | "characters"
  | "entries"
  | "items"
  | "lines"
  | "milliseconds"
  | "position";

export class PublicCapabilityCatalogValidationError extends TypeError {
  override readonly name = "PublicCapabilityCatalogValidationError";
  readonly code = "invalid_public_capability_catalog" as const;

  constructor(
    readonly location: string,
    cause: Error,
  ) {
    super(cause.message, { cause });
  }
}

const PUBLIC_AUTHORITY_CLASSES = ["execute", "read", "write"] as const;
const PUBLIC_POLICY_ACTIONS = [
  "artifact.read",
  "filesystem.list",
  "filesystem.read",
  "filesystem.write",
  "process.execute",
] as const;
const PUBLIC_EXECUTION_MODES = ["default", "parallel", "sequential"] as const;
const PUBLIC_AVAILABILITY_REQUIREMENTS = [
  "artifact-store",
  "command-recorder",
  "effect-recorder",
  "language-server",
  "production-sandbox",
] as const;
const PUBLIC_LIMIT_UNITS = [
  "bytes",
  "characters",
  "entries",
  "items",
  "lines",
  "milliseconds",
  "position",
] as const;
const PUBLIC_EVALUATION_ISOLATIONS = ["flow-runtime", "local-process", "oci-container"] as const;
const publicSchemaValidator = new Ajv2020({ allErrors: true, strict: true });

export interface PublicCapabilityToolInput {
  readonly selector: string;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly executionMode: "default" | "parallel" | "sequential";
  readonly authority: readonly PublicAuthorityClass[];
  readonly policyActions: readonly PublicPolicyAction[];
  readonly availability: readonly PublicAvailabilityRequirement[];
  readonly limitIds: readonly string[];
}

export interface PublicCapabilityLimitInput {
  readonly id: string;
  readonly value: number;
  readonly unit: PublicLimitUnit;
  readonly scope: string;
  readonly default?: number;
}

export interface PublicCapabilityFamilyInput {
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly extension: "dynamic";
}

export interface PublicExecutionSeamInput {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly openness: "open";
  readonly implementation: string;
}

export interface PublicEvaluationAdapterInput {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly isolation: "flow-runtime" | "local-process" | "oci-container";
}

export interface PublicCapabilityCatalogInput {
  readonly version: typeof PUBLIC_CAPABILITY_CATALOG_VERSION;
  readonly jsonSchemaDialect: typeof PUBLIC_CAPABILITY_JSON_SCHEMA_DIALECT;
  readonly tools: readonly PublicCapabilityToolInput[];
  readonly limits: readonly PublicCapabilityLimitInput[];
  readonly capabilityFamilies: readonly PublicCapabilityFamilyInput[];
  readonly executionSeams: readonly PublicExecutionSeamInput[];
  readonly evaluationAdapters: readonly PublicEvaluationAdapterInput[];
}

export type PublicCapabilityCatalog = Readonly<{
  version: typeof PUBLIC_CAPABILITY_CATALOG_VERSION;
  jsonSchemaDialect: typeof PUBLIC_CAPABILITY_JSON_SCHEMA_DIALECT;
  tools: readonly Readonly<PublicCapabilityToolInput>[];
  limits: readonly Readonly<PublicCapabilityLimitInput>[];
  capabilityFamilies: readonly Readonly<PublicCapabilityFamilyInput>[];
  executionSeams: readonly Readonly<PublicExecutionSeamInput>[];
  evaluationAdapters: readonly Readonly<PublicEvaluationAdapterInput>[];
}>;

export function definePublicCapabilityCatalog(
  input: PublicCapabilityCatalogInput,
): PublicCapabilityCatalog {
  if (input.version !== PUBLIC_CAPABILITY_CATALOG_VERSION) {
    throw validationError(
      "version",
      new TypeError(`unsupported public capability catalog version "${input.version}"`),
    );
  }
  if (input.jsonSchemaDialect !== PUBLIC_CAPABILITY_JSON_SCHEMA_DIALECT) {
    throw validationError(
      "jsonSchemaDialect",
      new TypeError(
        `unsupported public capability JSON Schema dialect "${input.jsonSchemaDialect}"`,
      ),
    );
  }

  const limits = validateAt("limits", () =>
    normalizeByIdentifier(
      input.limits.map((item, index) => validateAt(`limits[${index}]`, () => normalizeLimit(item))),
      "public limit identifier",
      (item) => item.id,
    ),
  );
  const limitIds = new Set(limits.map((item) => item.id));
  const tools = validateAt("tools", () =>
    normalizeByIdentifier(
      input.tools.map((item, index) =>
        validateAt(`tools[${index}]`, () => normalizeTool(item, limitIds)),
      ),
      "public tool selector",
      (item) => item.selector,
    ),
  );
  validateAt("tools", () => assertUnique(tools, "public tool name", (item) => item.name));
  const capabilityFamilies = validateAt("capabilityFamilies", () =>
    normalizeByIdentifier(
      input.capabilityFamilies.map((item, index) =>
        validateAt(`capabilityFamilies[${index}]`, () => normalizeCapabilityFamily(item)),
      ),
      "public capability family",
      (item) => item.kind,
    ),
  );
  const executionSeams = validateAt("executionSeams", () =>
    normalizeByIdentifier(
      input.executionSeams.map((item, index) =>
        validateAt(`executionSeams[${index}]`, () => normalizeExecutionSeam(item)),
      ),
      "public execution seam",
      (item) => item.id,
    ),
  );
  const evaluationAdapters = validateAt("evaluationAdapters", () =>
    normalizeByIdentifier(
      input.evaluationAdapters.map((item, index) =>
        validateAt(`evaluationAdapters[${index}]`, () => normalizeEvaluationAdapter(item)),
      ),
      "public evaluation adapter",
      (item) => item.id,
    ),
  );

  return deepFreeze({
    version: input.version,
    jsonSchemaDialect: input.jsonSchemaDialect,
    tools,
    limits,
    capabilityFamilies,
    executionSeams,
    evaluationAdapters,
  }) as PublicCapabilityCatalog;
}

function normalizeTool(
  input: PublicCapabilityToolInput,
  limitIds: ReadonlySet<string>,
): PublicCapabilityToolInput {
  const selector = requiredIdentifier(input.selector, "public tool selector");
  const name = requiredIdentifier(input.name, "public tool name", /^[a-z][a-z0-9_]*$/u);
  const label = requiredText(input.label, "public tool label");
  const description = requiredText(input.description, "public tool description");
  const inputSchema = canonicalJson(input.inputSchema, `public tool "${selector}" input schema`);
  if (!isJsonObject(inputSchema)) {
    throw new TypeError(`public tool "${selector}" input schema must be a JSON object`);
  }
  assertValidJsonSchema(inputSchema, selector);
  const executionMode = requiredEnum(
    input.executionMode,
    PUBLIC_EXECUTION_MODES,
    `public tool "${selector}" execution mode`,
  );
  const authority = uniqueSorted(
    input.authority.map((item) =>
      requiredEnum(item, PUBLIC_AUTHORITY_CLASSES, `public tool "${selector}" authority`),
    ),
    `public tool "${selector}" authority`,
  );
  const policyActions = uniqueSorted(
    input.policyActions.map((item) =>
      requiredEnum(item, PUBLIC_POLICY_ACTIONS, `public tool "${selector}" policy action`),
    ),
    `public tool "${selector}" policy action`,
  );
  if (authority.length === 0 || policyActions.length === 0) {
    throw new TypeError(`public tool "${selector}" must declare authority and a policy action`);
  }
  const policyAuthority = uniqueSorted(
    policyActions.map((action) => classifyPolicyAction(action)),
    `public tool "${selector}" policy authority`,
  );
  if (!sameStrings(authority, policyAuthority)) {
    throw new TypeError(
      `public tool "${selector}" authority must match its declared policy actions`,
    );
  }
  const availability = uniqueSorted(
    input.availability.map((item) =>
      requiredEnum(
        item,
        PUBLIC_AVAILABILITY_REQUIREMENTS,
        `public tool "${selector}" availability requirement`,
      ),
    ),
    `public tool "${selector}" availability requirement`,
  );
  const referencedLimits = uniqueSorted(
    input.limitIds.map((item) => requiredIdentifier(item, "public limit identifier")),
    `public tool "${selector}" public limit identifier`,
  );
  for (const id of referencedLimits) {
    if (!limitIds.has(id)) {
      throw new TypeError(`public tool "${selector}" references undeclared public limit "${id}"`);
    }
  }
  return {
    selector,
    name,
    label,
    description,
    inputSchema,
    executionMode,
    authority,
    policyActions,
    availability,
    limitIds: referencedLimits,
  };
}

function normalizeLimit(input: PublicCapabilityLimitInput): PublicCapabilityLimitInput {
  const id = requiredIdentifier(input.id, "public limit identifier");
  const value = finiteNonNegative(input.value, `public limit "${id}" value`);
  const scope = requiredText(input.scope, `public limit "${id}" scope`);
  const defaultValue =
    input.default === undefined
      ? undefined
      : finiteNonNegative(input.default, `public limit "${id}" default`);
  if (defaultValue !== undefined && defaultValue > value) {
    throw new TypeError(`public limit "${id}" default must not exceed its limit`);
  }
  return {
    id,
    value,
    unit: requiredEnum(input.unit, PUBLIC_LIMIT_UNITS, `public limit "${id}" unit`),
    scope,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

function normalizeCapabilityFamily(
  input: PublicCapabilityFamilyInput,
): PublicCapabilityFamilyInput {
  return {
    kind: requiredIdentifier(input.kind, "public capability family"),
    title: requiredText(input.title, "public capability family title"),
    summary: requiredText(input.summary, "public capability family summary"),
    extension: requiredEnum(
      input.extension,
      ["dynamic"] as const,
      `public capability family "${input.kind}" extension`,
    ),
  };
}

function normalizeExecutionSeam(input: PublicExecutionSeamInput): PublicExecutionSeamInput {
  return {
    id: requiredIdentifier(input.id, "public execution seam"),
    title: requiredText(input.title, "public execution seam title"),
    summary: requiredText(input.summary, "public execution seam summary"),
    openness: requiredEnum(
      input.openness,
      ["open"] as const,
      `public execution seam "${input.id}" openness`,
    ),
    implementation: requiredIdentifier(input.implementation, "execution seam implementation"),
  };
}

function normalizeEvaluationAdapter(
  input: PublicEvaluationAdapterInput,
): PublicEvaluationAdapterInput {
  return {
    id: requiredIdentifier(input.id, "public evaluation adapter"),
    title: requiredText(input.title, "public evaluation adapter title"),
    summary: requiredText(input.summary, "public evaluation adapter summary"),
    isolation: requiredEnum(
      input.isolation,
      PUBLIC_EVALUATION_ISOLATIONS,
      `public evaluation adapter "${input.id}" isolation`,
    ),
  };
}

function canonicalJson(input: unknown, label: string): PublicJsonValue {
  if (input === null || typeof input === "boolean" || typeof input === "string") {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new TypeError(`${label} must contain only finite JSON numbers`);
    }
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item, index) => canonicalJson(item, `${label}[${index}]`));
  }
  if (typeof input !== "object" || input === undefined) {
    throw new TypeError(`${label} must contain only JSON values`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only plain JSON objects`);
  }
  const output: Record<string, PublicJsonValue> = {};
  for (const key of Object.keys(input).sort(compareStrings)) {
    const value = (input as Record<string, unknown>)[key];
    Object.defineProperty(output, key, {
      value: canonicalJson(value, `${label}.${key}`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function normalizeByIdentifier<T>(
  items: readonly T[],
  label: string,
  identifier: (item: T) => string,
): readonly T[] {
  assertUnique(items, label, identifier);
  return [...items].sort((left, right) => compareStrings(identifier(left), identifier(right)));
}

function assertUnique<T>(
  items: readonly T[],
  label: string,
  identifier: (item: T) => string,
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = identifier(item);
    if (seen.has(id)) {
      throw new TypeError(`duplicate ${label} "${id}"`);
    }
    seen.add(id);
  }
}

function uniqueSorted<T extends string>(items: readonly T[], label: string): readonly T[] {
  assertUnique(items, label, (item) => item);
  return [...items].sort(compareStrings);
}

function requiredIdentifier(
  value: string,
  label: string,
  pattern: RegExp = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u,
): string {
  if (!pattern.test(value)) {
    throw new TypeError(`${label} "${value}" is not a canonical identifier`);
  }
  return value;
}

function requiredText(value: string, label: string): string {
  if (value.trim() !== value || value.length === 0 || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new TypeError(`${label} must contain between 1 and 4096 trimmed UTF-8 bytes`);
  }
  return value;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requiredEnum<const TValue extends string>(
  value: string,
  allowed: readonly TValue[],
  label: string,
): TValue {
  if (!allowed.includes(value as TValue)) {
    throw new TypeError(`${label} contains unsupported value "${value}"`);
  }
  return value as TValue;
}

function assertValidJsonSchema(schema: object, selector: string): void {
  if (!publicSchemaValidator.validateSchema(schema)) {
    throw new TypeError(`public tool "${selector}" input must be valid Draft 2020-12 JSON Schema`);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isJsonObject(
  value: PublicJsonValue,
): value is { readonly [key: string]: PublicJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateAt<T>(location: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PublicCapabilityCatalogValidationError) {
      throw error;
    }
    throw validationError(
      location,
      error instanceof Error ? error : new TypeError("public capability value is invalid"),
    );
  }
}

function validationError(location: string, cause: Error): PublicCapabilityCatalogValidationError {
  return new PublicCapabilityCatalogValidationError(location, cause);
}
