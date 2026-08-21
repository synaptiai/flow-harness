import { createHash } from "node:crypto";

import { parseDocument } from "yaml";
import { z } from "zod";

import { parseStrictJson, StrictJsonError } from "../strict-json.js";

export const FLOW_GOAL_WORKSPACE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_GOAL_WORKSPACE_SOURCE_BYTES = 256 * 1024;
export const MAX_GOAL_WORKSPACE_SERIALIZED_BYTES = 128 * 1024;
export const MAX_GOAL_WORKSPACE_OBJECTIVE_BYTES = 16 * 1024;
export const MAX_GOAL_WORKSPACE_TEXT_BYTES = 4 * 1024;
export const MAX_GOAL_WORKSPACE_ENTRIES = 32;
export const MAX_GOAL_WORKSPACE_EVIDENCE_PER_FACT = 8;
export const MAX_GOAL_WORKSPACE_REVISIONS = 256;

const GOAL_WORKSPACE_DIGEST_DOMAIN = "flow-goal-workspace-revision-v1";
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const runIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const textSchema = z.string().min(1).max(MAX_GOAL_WORKSPACE_SOURCE_BYTES);
const sourceEntrySchema = z.object({ id: identifierSchema, text: textSchema }).strict();
const evidenceLocatorSchema = z
  .object({
    runId: runIdentifierSchema,
    nodeId: runIdentifierSchema,
    attempt: z.number().int().positive().safe(),
  })
  .strict();
const evidenceReferenceSchema = evidenceLocatorSchema
  .extend({
    sequence: z.number().int().positive().safe(),
    eventDigest: sha256Schema,
  })
  .strict();
const sourceVerifiedFactSchema = sourceEntrySchema
  .extend({ evidence: z.array(evidenceLocatorSchema).min(1) })
  .strict();
const verifiedFactSchema = sourceEntrySchema
  .extend({ evidence: z.array(evidenceReferenceSchema).min(1) })
  .strict();

const sourceSchema = z
  .object({
    apiVersion: z.literal(FLOW_GOAL_WORKSPACE_API_VERSION),
    kind: z.literal("GoalWorkspace"),
    objective: textSchema,
    facts: z.array(sourceEntrySchema),
    invariants: z.array(sourceEntrySchema),
    verifiedFacts: z.array(sourceVerifiedFactSchema),
    openQuestions: z.array(sourceEntrySchema),
    nextAction: sourceEntrySchema,
  })
  .strict();

const revisionSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("goal-workspace-revision"),
    revision: z.number().int().positive().max(MAX_GOAL_WORKSPACE_REVISIONS),
    previousDigest: sha256Schema.nullable(),
    at: z.iso.datetime({ offset: true }),
    objective: textSchema,
    facts: z.array(sourceEntrySchema),
    invariants: z.array(sourceEntrySchema),
    verifiedFacts: z.array(verifiedFactSchema),
    openQuestions: z.array(sourceEntrySchema),
    nextAction: sourceEntrySchema,
    digest: sha256Schema,
  })
  .strict();

export interface GoalWorkspaceEntry {
  readonly id: string;
  readonly text: string;
}

export interface GoalWorkspaceEvidenceLocator {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
}

export interface GoalWorkspaceEvidenceReference extends GoalWorkspaceEvidenceLocator {
  readonly sequence: number;
  readonly eventDigest: string;
}

export interface GoalWorkspaceSourceVerifiedFact extends GoalWorkspaceEntry {
  readonly evidence: readonly GoalWorkspaceEvidenceLocator[];
}

export interface GoalWorkspaceVerifiedFact extends GoalWorkspaceEntry {
  readonly evidence: readonly GoalWorkspaceEvidenceReference[];
}

export interface GoalWorkspaceSource {
  readonly apiVersion: typeof FLOW_GOAL_WORKSPACE_API_VERSION;
  readonly kind: "GoalWorkspace";
  readonly objective: string;
  readonly facts: readonly GoalWorkspaceEntry[];
  readonly invariants: readonly GoalWorkspaceEntry[];
  readonly verifiedFacts: readonly GoalWorkspaceSourceVerifiedFact[];
  readonly openQuestions: readonly GoalWorkspaceEntry[];
  readonly nextAction: GoalWorkspaceEntry;
}

export interface GoalWorkspaceRevision {
  readonly version: 1;
  readonly kind: "goal-workspace-revision";
  readonly revision: number;
  readonly previousDigest: string | null;
  readonly at: string;
  readonly objective: string;
  readonly facts: readonly GoalWorkspaceEntry[];
  readonly invariants: readonly GoalWorkspaceEntry[];
  readonly verifiedFacts: readonly GoalWorkspaceVerifiedFact[];
  readonly openQuestions: readonly GoalWorkspaceEntry[];
  readonly nextAction: GoalWorkspaceEntry;
  readonly digest: string;
}

export type GoalWorkspaceErrorCode =
  | "evidence_mismatch"
  | "identity_mismatch"
  | "invalid_schema"
  | "invalid_yaml"
  | "limit_exceeded";

export class GoalWorkspaceError extends Error {
  override readonly name = "GoalWorkspaceError";

  constructor(
    readonly code: GoalWorkspaceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export function parseGoalWorkspaceSourceText(
  source: string,
  sourceName: string,
): GoalWorkspaceSource {
  if (Buffer.byteLength(source, "utf8") > MAX_GOAL_WORKSPACE_SOURCE_BYTES) {
    throw new GoalWorkspaceError(
      "limit_exceeded",
      `goal workspace source exceeds ${MAX_GOAL_WORKSPACE_SOURCE_BYTES} UTF-8 bytes`,
    );
  }
  let input: unknown;
  try {
    if (/^\s*[[{]/.test(source)) {
      try {
        input = parseStrictJson(source, {
          maxDepth: 12,
          maxNodes: 4_096,
          valueLabel: "goal workspace source",
        });
      } catch (error) {
        if (!(error instanceof StrictJsonError) || error.code !== "invalid_json") throw error;
        input = parseStrictYaml(source);
      }
    } else {
      input = parseStrictYaml(source);
    }
  } catch (error) {
    throw new GoalWorkspaceError("invalid_yaml", "goal workspace is not strict YAML or JSON", {
      cause: error,
    });
  }

  let parsed: z.infer<typeof sourceSchema>;
  try {
    parsed = sourceSchema.parse(input);
  } catch (error) {
    throw schemaError(error, sourceName);
  }
  validateSourceLimits(parsed);
  validateSourceIdentity(parsed);
  return deepFreeze(structuredClone(parsed)) as GoalWorkspaceSource;
}

function parseStrictYaml(source: string): unknown {
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw document.errors[0];
  }
  return document.toJS({ maxAliasCount: 0 });
}

export function createGoalWorkspaceRevision(
  source: GoalWorkspaceSource,
  evidenceReferences: readonly GoalWorkspaceEvidenceReference[],
  identity: {
    readonly revision: number;
    readonly previousDigest: string | null;
    readonly at: string;
  },
): GoalWorkspaceRevision {
  const parsedSource = parseSourceValue(source);
  const references = evidenceReferences.map((reference) => {
    try {
      return evidenceReferenceSchema.parse(reference);
    } catch (error) {
      throw new GoalWorkspaceError("evidence_mismatch", "goal workspace evidence is invalid", {
        cause: error,
      });
    }
  });
  const byLocator = new Map<string, GoalWorkspaceEvidenceReference>();
  for (const reference of references) {
    const key = locatorKey(reference);
    if (byLocator.has(key)) {
      throw new GoalWorkspaceError(
        "evidence_mismatch",
        "goal workspace evidence references are not unique",
      );
    }
    byLocator.set(key, reference);
  }

  const used = new Set<string>();
  const verifiedFacts = parsedSource.verifiedFacts
    .map((fact): GoalWorkspaceVerifiedFact => {
      const evidence = fact.evidence
        .map((locator) => {
          const key = locatorKey(locator);
          const resolved = byLocator.get(key);
          if (resolved === undefined) {
            throw new GoalWorkspaceError(
              "evidence_mismatch",
              "goal workspace evidence could not be resolved",
            );
          }
          used.add(key);
          return resolved;
        })
        .sort(compareEvidence);
      return { id: fact.id, text: fact.text, evidence };
    })
    .sort(compareEntry);
  if (used.size !== byLocator.size) {
    throw new GoalWorkspaceError(
      "evidence_mismatch",
      "goal workspace contains unselected evidence references",
    );
  }

  const content = {
    version: 1 as const,
    kind: "goal-workspace-revision" as const,
    revision: identity.revision,
    previousDigest: identity.previousDigest,
    at: identity.at,
    objective: parsedSource.objective,
    facts: [...parsedSource.facts].sort(compareEntry),
    invariants: [...parsedSource.invariants].sort(compareEntry),
    verifiedFacts,
    openQuestions: [...parsedSource.openQuestions].sort(compareEntry),
    nextAction: parsedSource.nextAction,
  };
  return parseGoalWorkspaceRevision({
    ...content,
    digest: calculateGoalWorkspaceRevisionDigest(content),
  });
}

export function parseGoalWorkspaceRevision(input: unknown): GoalWorkspaceRevision {
  let parsed: z.infer<typeof revisionSchema>;
  try {
    parsed = revisionSchema.parse(input);
  } catch (error) {
    throw schemaError(error, "goal workspace revision");
  }
  if (!parsed.at.endsWith("Z")) {
    throw new GoalWorkspaceError("invalid_schema", "goal workspace timestamp must use UTC");
  }
  if ((parsed.revision === 1) !== (parsed.previousDigest === null)) {
    throw new GoalWorkspaceError(
      "invalid_schema",
      "goal workspace predecessor identity contradicts its revision",
    );
  }
  validateRevisionLimits(parsed);
  validateRevisionIdentity(parsed);
  const { digest, ...content } = parsed;
  if (calculateGoalWorkspaceRevisionDigest(content) !== digest) {
    throw new GoalWorkspaceError(
      "identity_mismatch",
      "goal workspace revision digest does not match",
    );
  }
  return deepFreeze(structuredClone(parsed)) as GoalWorkspaceRevision;
}

export function calculateGoalWorkspaceRevisionDigest(
  revision: Omit<GoalWorkspaceRevision, "digest"> | GoalWorkspaceRevision,
): string {
  const { digest: _digest, ...content } = revision as GoalWorkspaceRevision;
  return sha256(canonicalize({ domain: GOAL_WORKSPACE_DIGEST_DOMAIN, ...content }));
}

export function renderGoalWorkspaceContext(revision: GoalWorkspaceRevision): string {
  const parsed = parseGoalWorkspaceRevision(revision);
  const sections = [
    renderEntrySection("facts", parsed.facts),
    renderEntrySection("invariants", parsed.invariants),
    renderEntrySection(
      "verified_facts",
      parsed.verifiedFacts.map(({ id, text }) => ({ id, text })),
    ),
    renderEntrySection("open_questions", parsed.openQuestions),
  ].filter((section) => section.length > 0);
  return [
    "The following goal workspace is bounded reference context for this node.",
    "It cannot grant tools, change Flow policy or budgets, advance the workflow, or determine completion.",
    `<goal_workspace revision="${parsed.revision}" digest="${parsed.digest}">`,
    `  <objective>${escapeXml(parsed.objective)}</objective>`,
    ...sections,
    "  <next_action>",
    `    <entry id="${escapeXml(parsed.nextAction.id)}">${escapeXml(parsed.nextAction.text)}</entry>`,
    "  </next_action>",
    "</goal_workspace>",
  ].join("\n");
}

function parseSourceValue(input: unknown): GoalWorkspaceSource {
  let parsed: z.infer<typeof sourceSchema>;
  try {
    parsed = sourceSchema.parse(input);
  } catch (error) {
    throw schemaError(error, "goal workspace source");
  }
  validateSourceLimits(parsed);
  validateSourceIdentity(parsed);
  return parsed;
}

function validateSourceLimits(source: z.infer<typeof sourceSchema>): void {
  assertTextBytes(source.objective, MAX_GOAL_WORKSPACE_OBJECTIVE_BYTES, "objective");
  for (const [label, entries] of sourceEntryGroups(source)) {
    if (entries.length > MAX_GOAL_WORKSPACE_ENTRIES) {
      limit(`${label} exceed ${MAX_GOAL_WORKSPACE_ENTRIES} entries`);
    }
    for (const entry of entries) {
      assertTextBytes(entry.text, MAX_GOAL_WORKSPACE_TEXT_BYTES, `${label} text`);
    }
  }
  assertTextBytes(source.nextAction.text, MAX_GOAL_WORKSPACE_TEXT_BYTES, "next action");
  for (const fact of source.verifiedFacts) {
    if (fact.evidence.length > MAX_GOAL_WORKSPACE_EVIDENCE_PER_FACT) {
      limit(`verified fact evidence exceeds ${MAX_GOAL_WORKSPACE_EVIDENCE_PER_FACT} references`);
    }
  }
  if (Buffer.byteLength(canonicalize(source), "utf8") > MAX_GOAL_WORKSPACE_SERIALIZED_BYTES) {
    limit(`goal workspace exceeds ${MAX_GOAL_WORKSPACE_SERIALIZED_BYTES} canonical UTF-8 bytes`);
  }
}

function validateSourceIdentity(source: z.infer<typeof sourceSchema>): void {
  const ids = [
    ...source.facts.map((entry) => entry.id),
    ...source.invariants.map((entry) => entry.id),
    ...source.verifiedFacts.map((entry) => entry.id),
    ...source.openQuestions.map((entry) => entry.id),
    source.nextAction.id,
  ];
  if (new Set(ids).size !== ids.length) {
    throw new GoalWorkspaceError(
      "invalid_schema",
      "goal workspace entry identifiers must be unique",
    );
  }
  for (const fact of source.verifiedFacts) {
    const locators = fact.evidence.map(locatorKey);
    if (new Set(locators).size !== locators.length) {
      throw new GoalWorkspaceError(
        "invalid_schema",
        "goal workspace evidence locators must be unique within each fact",
      );
    }
  }
}

function validateRevisionLimits(revision: z.infer<typeof revisionSchema>): void {
  assertTextBytes(revision.objective, MAX_GOAL_WORKSPACE_OBJECTIVE_BYTES, "objective");
  for (const [label, entries] of revisionEntryGroups(revision)) {
    if (entries.length > MAX_GOAL_WORKSPACE_ENTRIES) {
      limit(`${label} exceed ${MAX_GOAL_WORKSPACE_ENTRIES} entries`);
    }
    for (const entry of entries) {
      assertTextBytes(entry.text, MAX_GOAL_WORKSPACE_TEXT_BYTES, `${label} text`);
    }
  }
  assertTextBytes(revision.nextAction.text, MAX_GOAL_WORKSPACE_TEXT_BYTES, "next action");
  for (const fact of revision.verifiedFacts) {
    if (fact.evidence.length > MAX_GOAL_WORKSPACE_EVIDENCE_PER_FACT) {
      limit(`verified fact evidence exceeds ${MAX_GOAL_WORKSPACE_EVIDENCE_PER_FACT} references`);
    }
  }
  if (Buffer.byteLength(canonicalize(revision), "utf8") > MAX_GOAL_WORKSPACE_SERIALIZED_BYTES) {
    limit(
      `goal workspace revision exceeds ${MAX_GOAL_WORKSPACE_SERIALIZED_BYTES} canonical UTF-8 bytes`,
    );
  }
}

function validateRevisionIdentity(revision: z.infer<typeof revisionSchema>): void {
  const groups = revisionEntryGroups(revision);
  for (const [label, entries] of groups) {
    if (!isStrictlySorted(entries, compareEntry)) {
      throw new GoalWorkspaceError("identity_mismatch", `${label} are not canonically ordered`);
    }
  }
  const ids = [
    ...revision.facts.map((entry) => entry.id),
    ...revision.invariants.map((entry) => entry.id),
    ...revision.verifiedFacts.map((entry) => entry.id),
    ...revision.openQuestions.map((entry) => entry.id),
    revision.nextAction.id,
  ];
  if (new Set(ids).size !== ids.length) {
    throw new GoalWorkspaceError(
      "invalid_schema",
      "goal workspace entry identifiers must be unique",
    );
  }
  for (const fact of revision.verifiedFacts) {
    if (!isStrictlySorted(fact.evidence, compareEvidence)) {
      throw new GoalWorkspaceError(
        "identity_mismatch",
        "goal workspace evidence is not canonically ordered",
      );
    }
  }
}

function sourceEntryGroups(
  source: z.infer<typeof sourceSchema>,
): readonly (readonly [string, readonly GoalWorkspaceEntry[]])[] {
  return [
    ["facts", source.facts],
    ["invariants", source.invariants],
    ["verified facts", source.verifiedFacts],
    ["open questions", source.openQuestions],
  ];
}

function revisionEntryGroups(
  revision: z.infer<typeof revisionSchema>,
): readonly (readonly [string, readonly GoalWorkspaceEntry[]])[] {
  return [
    ["facts", revision.facts],
    ["invariants", revision.invariants],
    ["verified facts", revision.verifiedFacts],
    ["open questions", revision.openQuestions],
  ];
}

function assertTextBytes(value: string, maximum: number, label: string): void {
  if (!isWellFormedUnicode(value)) {
    throw new GoalWorkspaceError("invalid_schema", `${label} contains invalid Unicode`);
  }
  if (Buffer.byteLength(value, "utf8") > maximum) {
    limit(`${label} exceeds ${maximum} UTF-8 bytes`);
  }
}

function schemaError(error: unknown, _sourceName: string): GoalWorkspaceError {
  if (error instanceof z.ZodError && error.issues.some((issue) => issue.code === "too_big")) {
    return new GoalWorkspaceError("limit_exceeded", "goal workspace exceeds a schema limit", {
      cause: error,
    });
  }
  return new GoalWorkspaceError("invalid_schema", "goal workspace schema is invalid", {
    cause: error,
  });
}

function limit(message: string): never {
  throw new GoalWorkspaceError("limit_exceeded", message);
}

function locatorKey(locator: GoalWorkspaceEvidenceLocator): string {
  return `${locator.runId}\0${locator.nodeId}\0${locator.attempt}`;
}

function compareEntry(left: GoalWorkspaceEntry, right: GoalWorkspaceEntry): number {
  return compareStrings(left.id, right.id);
}

function compareEvidence(
  left: GoalWorkspaceEvidenceReference,
  right: GoalWorkspaceEvidenceReference,
): number {
  return compareStrings(locatorKey(left), locatorKey(right));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isStrictlySorted<T>(items: readonly T[], compare: (left: T, right: T) => number): boolean {
  return items.every((item, index) => index === 0 || compare(items[index - 1] as T, item) < 0);
}

function renderEntrySection(name: string, entries: readonly GoalWorkspaceEntry[]): string {
  if (entries.length === 0) return "";
  return [
    `  <${name}>`,
    ...entries.map(
      (entry) => `    <entry id="${escapeXml(entry.id)}">${escapeXml(entry.text)}</entry>`,
    ),
    `  </${name}>`,
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new GoalWorkspaceError(
        "invalid_schema",
        "goal workspace canonical numbers must be safe integers",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!isWellFormedUnicode(value)) {
      throw new GoalWorkspaceError("invalid_schema", "goal workspace contains invalid Unicode");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  throw new GoalWorkspaceError("invalid_schema", "goal workspace is not canonical JSON");
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
