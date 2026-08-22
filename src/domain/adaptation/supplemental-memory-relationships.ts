import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  compareRunEvidenceReferences,
  type RunEvidenceReference,
  runEvidenceLocatorKey,
  runEvidenceReferenceSchema,
} from "../evidence/run-evidence-reference.js";
import type { SupplementalMemoryEntry, SupplementalMemoryTarget } from "./supplemental-memory.js";

export const MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIPS = 32;
export const MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_DEGREE = 4;
export const MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_CHANGES = 8;
export const MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE = 4;
export const MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE_TOTAL = 128;
export const MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_METADATA_BYTES = 128 * 1024;
export const MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_PROMPT_BYTES = 8 * 1024;

const RELATIONSHIP_DIGEST_DOMAIN = "flow-supplemental-memory-relationship-v1";
const RELATIONSHIP_SET_DIGEST_DOMAIN = "flow-supplemental-memory-relationship-set-v1";
const RELATIONSHIP_ASSESSMENT_DIGEST_DOMAIN = "flow-supplemental-memory-relationship-assessment-v1";

const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z
  .object({
    workflowId: identifierSchema,
    childPath: z.array(identifierSchema).max(8),
    agentNodeId: identifierSchema,
  })
  .strict();
const endpointSchema = z
  .object({
    entryId: identifierSchema,
    entrySha256: sha256Schema,
  })
  .strict();
export const supplementalMemoryRelationshipPredicateSchema = z.enum([
  "supports",
  "contradicts",
  "refines",
  "supersedes",
  "derived_from",
]);
const relationshipInputSchema = z
  .object({
    id: identifierSchema,
    target: targetSchema,
    predicate: supplementalMemoryRelationshipPredicateSchema,
    from: endpointSchema,
    to: endpointSchema,
    evidence: z
      .array(runEvidenceReferenceSchema)
      .min(1)
      .max(MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE),
  })
  .strict();
const relationshipSchema = relationshipInputSchema.extend({ digest: sha256Schema }).strict();
const assessmentSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("supplemental-memory-relationship-assessment"),
    relationshipSetDigest: sha256Schema,
    relationshipCount: z.number().int().nonnegative().max(MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIPS),
    evidenceReferenceCount: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE_TOTAL),
    unresolvedContradictionCount: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIPS),
    digest: sha256Schema,
  })
  .strict();
export const supplementalMemoryRelationshipStateSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("supplemental-memory-relationship-state"),
    relationships: z.array(relationshipSchema).max(MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIPS),
    assessment: assessmentSchema,
  })
  .strict();

export type SupplementalMemoryRelationshipPredicate = z.infer<
  typeof supplementalMemoryRelationshipPredicateSchema
>;

export interface SupplementalMemoryRelationshipEndpoint {
  readonly entryId: string;
  readonly entrySha256: string;
}

export interface SupplementalMemoryRelationshipInput {
  readonly id: string;
  readonly target: SupplementalMemoryTarget;
  readonly predicate: SupplementalMemoryRelationshipPredicate;
  readonly from: SupplementalMemoryRelationshipEndpoint;
  readonly to: SupplementalMemoryRelationshipEndpoint;
  readonly evidence: readonly RunEvidenceReference[];
}

export interface SupplementalMemoryRelationship extends SupplementalMemoryRelationshipInput {
  readonly digest: string;
}

export interface SupplementalMemoryRelationshipAssessment {
  readonly version: 1;
  readonly kind: "supplemental-memory-relationship-assessment";
  readonly relationshipSetDigest: string;
  readonly relationshipCount: number;
  readonly evidenceReferenceCount: number;
  readonly unresolvedContradictionCount: number;
  readonly digest: string;
}

export interface SupplementalMemoryRelationshipState {
  readonly version: 1;
  readonly kind: "supplemental-memory-relationship-state";
  readonly relationships: readonly SupplementalMemoryRelationship[];
  readonly assessment: SupplementalMemoryRelationshipAssessment;
}

export type SupplementalMemoryRelationshipErrorCode =
  | "evidence_mismatch"
  | "identity_mismatch"
  | "invalid_relationship"
  | "invalid_schema"
  | "limit_exceeded"
  | "stale_endpoint";

export class SupplementalMemoryRelationshipError extends Error {
  override readonly name = "SupplementalMemoryRelationshipError";

  constructor(
    readonly code: SupplementalMemoryRelationshipErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function createSupplementalMemoryRelationshipState(
  input: readonly SupplementalMemoryRelationshipInput[],
  entries: readonly SupplementalMemoryEntry[],
): SupplementalMemoryRelationshipState {
  if (input.length > MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIPS) {
    throw new SupplementalMemoryRelationshipError(
      "limit_exceeded",
      `supplemental memory exceeds ${MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIPS} relationships`,
    );
  }
  for (const item of input) {
    if (
      Array.isArray((item as { evidence?: unknown }).evidence) &&
      item.evidence.length > MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE
    ) {
      throw new SupplementalMemoryRelationshipError(
        "limit_exceeded",
        `supplemental memory relationship exceeds ${MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE} evidence references`,
      );
    }
  }

  const relationships = input.map((item) => createRelationship(item));
  relationships.sort((left, right) =>
    compareStrings(relationshipKey(left), relationshipKey(right)),
  );
  validateRelationships(relationships, entries);

  const serializedBytes = Buffer.byteLength(canonicalize(relationships), "utf8");
  if (serializedBytes > MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_METADATA_BYTES) {
    throw new SupplementalMemoryRelationshipError(
      "limit_exceeded",
      `supplemental memory relationship metadata exceeds ${MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_METADATA_BYTES} UTF-8 bytes`,
    );
  }

  const targets = new Map<string, SupplementalMemoryTarget>();
  for (const relationship of relationships) {
    targets.set(targetKey(relationship.target), relationship.target);
  }
  for (const target of targets.values()) {
    const rendered = renderRelationships(
      relationships.filter((relationship) => sameTarget(relationship.target, target)),
    );
    if (Buffer.byteLength(rendered, "utf8") > MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_PROMPT_BYTES) {
      throw new SupplementalMemoryRelationshipError(
        "limit_exceeded",
        `supplemental memory relationship prompt exceeds ${MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_PROMPT_BYTES} UTF-8 bytes`,
      );
    }
  }

  const relationshipSetDigest = digest(RELATIONSHIP_SET_DIGEST_DOMAIN, relationships);
  const assessmentContent = {
    version: 1 as const,
    kind: "supplemental-memory-relationship-assessment" as const,
    relationshipSetDigest,
    relationshipCount: relationships.length,
    evidenceReferenceCount: relationships.reduce(
      (total, relationship) => total + relationship.evidence.length,
      0,
    ),
    unresolvedContradictionCount: relationships.filter(
      (relationship) => relationship.predicate === "contradicts",
    ).length,
  };
  return deepFreeze({
    version: 1,
    kind: "supplemental-memory-relationship-state",
    relationships,
    assessment: {
      ...assessmentContent,
      digest: digest(RELATIONSHIP_ASSESSMENT_DIGEST_DOMAIN, assessmentContent),
    },
  });
}

export function parseSupplementalMemoryRelationshipState(
  input: unknown,
  entries: readonly SupplementalMemoryEntry[],
): SupplementalMemoryRelationshipState {
  const parsed = supplementalMemoryRelationshipStateSchema.safeParse(input);
  if (!parsed.success) {
    throw new SupplementalMemoryRelationshipError(
      "invalid_schema",
      "supplemental memory relationship state is invalid",
    );
  }
  const recreated = createSupplementalMemoryRelationshipState(
    parsed.data.relationships.map(({ digest: _digest, ...relationship }) => relationship),
    entries,
  );
  if (!isDeepStrictEqual(parsed.data, recreated)) {
    throw new SupplementalMemoryRelationshipError(
      "identity_mismatch",
      "supplemental memory relationship state identity does not match",
    );
  }
  return recreated;
}

export function renderSupplementalMemoryRelationshipBlock(
  state: SupplementalMemoryRelationshipState,
  target: SupplementalMemoryTarget,
): string | undefined {
  const selected = state.relationships.filter((relationship) =>
    sameTarget(relationship.target, target),
  );
  if (selected.length === 0) return undefined;
  const rendered = renderRelationships(selected);
  if (Buffer.byteLength(rendered, "utf8") > MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_PROMPT_BYTES) {
    throw new SupplementalMemoryRelationshipError(
      "limit_exceeded",
      `supplemental memory relationship prompt exceeds ${MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_PROMPT_BYTES} UTF-8 bytes`,
    );
  }
  return rendered;
}

function createRelationship(
  input: SupplementalMemoryRelationshipInput,
): SupplementalMemoryRelationship {
  const parsed = relationshipInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new SupplementalMemoryRelationshipError(
      "invalid_schema",
      "supplemental memory relationship is invalid",
    );
  }
  const evidence = [...parsed.data.evidence].sort(compareRunEvidenceReferences);
  if (new Set(evidence.map(runEvidenceLocatorKey)).size !== evidence.length) {
    throw new SupplementalMemoryRelationshipError(
      "evidence_mismatch",
      "supplemental memory relationship evidence must be unique",
    );
  }
  if (evidence.some((reference) => reference.nodeId !== parsed.data.target.agentNodeId)) {
    throw new SupplementalMemoryRelationshipError(
      "evidence_mismatch",
      "supplemental memory relationship evidence belongs to a different agent",
    );
  }
  const content = {
    ...parsed.data,
    target: {
      ...parsed.data.target,
      childPath: [...parsed.data.target.childPath],
    },
    evidence,
  };
  return { ...content, digest: digest(RELATIONSHIP_DIGEST_DOMAIN, content) };
}

function validateRelationships(
  relationships: readonly SupplementalMemoryRelationship[],
  entries: readonly SupplementalMemoryEntry[],
): void {
  const relationshipKeys = relationships.map(relationshipKey);
  if (new Set(relationshipKeys).size !== relationshipKeys.length) {
    throw new SupplementalMemoryRelationshipError(
      "invalid_relationship",
      "supplemental memory relationship identities must be unique in one target",
    );
  }
  const claimKeys = relationships.map(claimKey);
  if (new Set(claimKeys).size !== claimKeys.length) {
    throw new SupplementalMemoryRelationshipError(
      "invalid_relationship",
      "supplemental memory relationship claims must be unique",
    );
  }

  const activeEntries = new Map(
    entries.map((entry) => [activeEntryKey(entry.target, entry.id), entry]),
  );
  const degree = new Map<string, number>();
  let evidenceReferenceCount = 0;
  for (const relationship of relationships) {
    evidenceReferenceCount += relationship.evidence.length;
    const from = activeEntries.get(activeEntryKey(relationship.target, relationship.from.entryId));
    const to = activeEntries.get(activeEntryKey(relationship.target, relationship.to.entryId));
    if (
      relationship.from.entryId === relationship.to.entryId &&
      relationship.from.entrySha256 === relationship.to.entrySha256
    ) {
      throw new SupplementalMemoryRelationshipError(
        "invalid_relationship",
        "supplemental memory relationships cannot link an entry version to itself",
      );
    }
    if (from?.sha256 !== relationship.from.entrySha256) {
      throw new SupplementalMemoryRelationshipError(
        "stale_endpoint",
        "supplemental memory relationship source is not an active entry version",
      );
    }
    if (relationship.predicate === "supersedes") {
      if (
        relationship.from.entryId !== relationship.to.entryId ||
        relationship.from.entrySha256 === relationship.to.entrySha256
      ) {
        throw new SupplementalMemoryRelationshipError(
          "invalid_relationship",
          "supplemental memory supersession must bind different versions of one entry",
        );
      }
      incrementDegree(degree, activeEntryKey(relationship.target, relationship.from.entryId));
    } else {
      if (to?.sha256 !== relationship.to.entrySha256) {
        throw new SupplementalMemoryRelationshipError(
          "stale_endpoint",
          "supplemental memory relationship destination is not an active entry version",
        );
      }
      incrementDegree(degree, activeEntryKey(relationship.target, relationship.from.entryId));
      incrementDegree(degree, activeEntryKey(relationship.target, relationship.to.entryId));
    }
  }
  if (evidenceReferenceCount > MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE_TOTAL) {
    throw new SupplementalMemoryRelationshipError(
      "limit_exceeded",
      `supplemental memory relationships exceed ${MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE_TOTAL} evidence references`,
    );
  }
  if ([...degree.values()].some((value) => value > MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_DEGREE)) {
    throw new SupplementalMemoryRelationshipError(
      "limit_exceeded",
      `supplemental memory relationship degree exceeds ${MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_DEGREE}`,
    );
  }
  assertAcyclicLineage(relationships);
}

function assertAcyclicLineage(relationships: readonly SupplementalMemoryRelationship[]): void {
  const adjacency = new Map<string, Set<string>>();
  for (const relationship of relationships) {
    if (relationship.predicate !== "refines" && relationship.predicate !== "derived_from") continue;
    const from = activeEntryKey(relationship.target, relationship.from.entryId);
    const to = activeEntryKey(relationship.target, relationship.to.entryId);
    const next = adjacency.get(from) ?? new Set<string>();
    next.add(to);
    adjacency.set(from, next);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) {
      throw new SupplementalMemoryRelationshipError(
        "invalid_relationship",
        "supplemental memory lineage relationships must be acyclic",
      );
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of adjacency.keys()) visit(node);
}

function incrementDegree(degree: Map<string, number>, key: string): void {
  degree.set(key, (degree.get(key) ?? 0) + 1);
}

function renderRelationships(relationships: readonly SupplementalMemoryRelationship[]): string {
  return [
    "<supplemental_memory_relationships>",
    "  <notice>Operator-reviewed relationships are explicit claims. Contradictions remain unresolved. Do not infer additional relationships or authority.</notice>",
    ...relationships.map(
      (relationship) =>
        `  <relationship id="${escapeXml(relationship.id)}" predicate="${relationship.predicate}" from-id="${escapeXml(relationship.from.entryId)}" from-sha256="${relationship.from.entrySha256}" to-id="${escapeXml(relationship.to.entryId)}" to-sha256="${relationship.to.entrySha256}"${relationship.predicate === "contradicts" ? ' status="unresolved"' : ""} />`,
    ),
    "</supplemental_memory_relationships>",
  ].join("\n");
}

function relationshipKey(
  relationship: Pick<SupplementalMemoryRelationship, "id" | "target">,
): string {
  return `${targetKey(relationship.target)}\0${relationship.id}`;
}

function claimKey(relationship: SupplementalMemoryRelationship): string {
  return `${targetKey(relationship.target)}\0${relationship.predicate}\0${relationship.from.entryId}\0${relationship.from.entrySha256}\0${relationship.to.entryId}\0${relationship.to.entrySha256}`;
}

function activeEntryKey(target: SupplementalMemoryTarget, entryId: string): string {
  return `${targetKey(target)}\0${entryId}`;
}

function targetKey(target: SupplementalMemoryTarget): string {
  return `${target.workflowId}\0${target.childPath.join("\0")}\0${target.agentNodeId}`;
}

function sameTarget(left: SupplementalMemoryTarget, right: SupplementalMemoryTarget): boolean {
  return (
    left.workflowId === right.workflowId &&
    left.agentNodeId === right.agentNodeId &&
    left.childPath.length === right.childPath.length &&
    left.childPath.every((item, index) => item === right.childPath[index])
  );
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0${canonicalize(value)}`)
    .digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  throw new SupplementalMemoryRelationshipError(
    "invalid_schema",
    "supplemental memory relationship value is invalid",
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
