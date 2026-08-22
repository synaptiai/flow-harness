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
export type PublicLimitUnit = "bytes" | "entries" | "items" | "lines" | "milliseconds" | "position";

export interface PublicCapabilityToolInput {
  readonly selector: string;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly executionMode: "default" | "parallel" | "sequential";
  readonly authority: readonly PublicAuthorityClass[];
  readonly policyActions: readonly PublicPolicyAction[];
  readonly availability: readonly string[];
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
    throw new TypeError(`unsupported public capability catalog version "${input.version}"`);
  }
  if (input.jsonSchemaDialect !== PUBLIC_CAPABILITY_JSON_SCHEMA_DIALECT) {
    throw new TypeError(
      `unsupported public capability JSON Schema dialect "${input.jsonSchemaDialect}"`,
    );
  }

  const limits = normalizeByIdentifier(
    input.limits.map((item) => normalizeLimit(item)),
    "public limit identifier",
    (item) => item.id,
  );
  const limitIds = new Set(limits.map((item) => item.id));
  const tools = normalizeByIdentifier(
    input.tools.map((item) => normalizeTool(item, limitIds)),
    "public tool selector",
    (item) => item.selector,
  );
  assertUnique(tools, "public tool name", (item) => item.name);
  const capabilityFamilies = normalizeByIdentifier(
    input.capabilityFamilies.map(normalizeCapabilityFamily),
    "public capability family",
    (item) => item.kind,
  );
  const executionSeams = normalizeByIdentifier(
    input.executionSeams.map(normalizeExecutionSeam),
    "public execution seam",
    (item) => item.id,
  );
  const evaluationAdapters = normalizeByIdentifier(
    input.evaluationAdapters.map(normalizeEvaluationAdapter),
    "public evaluation adapter",
    (item) => item.id,
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
  const authority = uniqueSorted(input.authority, `public tool "${selector}" authority`);
  const policyActions = uniqueSorted(
    input.policyActions,
    `public tool "${selector}" policy action`,
  );
  const availability = uniqueSorted(
    input.availability.map((item) => requiredIdentifier(item, "availability requirement")),
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
    executionMode: input.executionMode,
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
    unit: input.unit,
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
    extension: input.extension,
  };
}

function normalizeExecutionSeam(input: PublicExecutionSeamInput): PublicExecutionSeamInput {
  return {
    id: requiredIdentifier(input.id, "public execution seam"),
    title: requiredText(input.title, "public execution seam title"),
    summary: requiredText(input.summary, "public execution seam summary"),
    openness: input.openness,
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
    isolation: input.isolation,
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
    output[key] = canonicalJson(value, `${label}.${key}`);
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
