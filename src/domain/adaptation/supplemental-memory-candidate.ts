import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { z } from "zod";
import { calculateCapabilitySnapshotDigest } from "../capability/agent-skills.js";
import {
  type RunEvidenceReference,
  runEvidenceLocatorKey,
  runEvidenceLocatorSchema,
} from "../evidence/run-evidence-reference.js";
import {
  parseTuningEvidencePacket,
  type TuningEvidencePacket,
} from "../evaluation/tuning-evidence.js";
import {
  compileEffectiveHarnessState,
  createEffectiveHarnessState,
  type EffectiveHarnessState,
  effectiveHarnessWorkflowSource,
} from "./effective-harness-state.js";
import {
  MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_CHANGES,
  MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE,
  type SupplementalMemoryRelationship,
  type SupplementalMemoryRelationshipInput,
} from "./supplemental-memory-relationships.js";
import {
  type SupplementalMemoryEntry,
  type SupplementalMemoryTarget,
  supplementalMemoryContent,
} from "./supplemental-memory.js";
import {
  calculateSupplementalMemoryCandidateGenerationRequestDigest,
  calculateSupplementalMemoryCandidateGenerationResponseDigest,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  renderSupplementalMemoryCandidateGenerationRequest,
  renderSupplementalMemoryCandidateGenerationResponse,
  SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_SYSTEM_PROMPT,
} from "./supplemental-memory-candidate-generation-contract.js";

export const SUPPLEMENTAL_MEMORY_CANDIDATE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES = 1_048_576;

const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const semanticVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const portableRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isPortableRelativePath, "must be a canonical portable relative path");
const scopeSchema = z
  .object({
    kind: z.literal("workflow-agent-memory"),
    workflowId: identifierSchema,
    childPath: z.array(identifierSchema).max(8),
    agentNodeId: identifierSchema,
    entryId: identifierSchema,
  })
  .strict();
const addChangeSchema = z.object({ kind: z.literal("add"), value: z.string() }).strict();
const replaceChangeSchema = z
  .object({ kind: z.literal("replace"), beforeSha256: sha256Schema, value: z.string() })
  .strict();
const removeChangeSchema = z
  .object({ kind: z.literal("remove"), beforeSha256: sha256Schema })
  .strict();
const relationshipEndpointSchema = z
  .object({ entryId: identifierSchema, entrySha256: sha256Schema })
  .strict();
const relationshipRemovalSchema = z
  .object({ id: identifierSchema, beforeDigest: sha256Schema })
  .strict();
const relationshipAdditionSchema = z
  .object({
    id: identifierSchema,
    predicate: z.enum(["supports", "contradicts", "refines", "supersedes", "derived_from"]),
    from: relationshipEndpointSchema,
    to: relationshipEndpointSchema,
    evidence: z
      .array(runEvidenceLocatorSchema)
      .min(1)
      .max(MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE)
      .refine(
        (evidence) => new Set(evidence.map(runEvidenceLocatorKey)).size === evidence.length,
        "relationship evidence locators must be unique",
      ),
  })
  .strict();
const relationshipChangesSchema = z
  .object({
    remove: z.array(relationshipRemovalSchema).max(MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_CHANGES),
    add: z.array(relationshipAdditionSchema).max(MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_CHANGES),
  })
  .strict()
  .superRefine((value, context) => {
    const changes = value.remove.length + value.add.length;
    if (changes < 1 || changes > MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_CHANGES) {
      context.addIssue({
        code: "custom",
        message: `relationship changes must contain 1-${MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_CHANGES} operations`,
      });
    }
    if (new Set(value.remove.map((item) => item.id)).size !== value.remove.length) {
      context.addIssue({ code: "custom", path: ["remove"], message: "removals must be unique" });
    }
    if (new Set(value.add.map((item) => item.id)).size !== value.add.length) {
      context.addIssue({ code: "custom", path: ["add"], message: "additions must be unique" });
    }
  });
const generationUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheReadTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheWriteTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    costUsdMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const generationEvidenceIdentitySchema = z
  .object({
    sourceSha256: sha256Schema,
    evidenceDigest: sha256Schema,
    planDigest: sha256Schema,
  })
  .strict();
const generationShape = {
  version: z.literal(1),
  kind: z.literal("model"),
  provider: identifierSchema,
  model: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => value === value.trim(), "model must not contain outer whitespace"),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  systemPromptSha256: z.literal(sha256(SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_SYSTEM_PROMPT)),
  requestDigest: sha256Schema,
  responseDigest: sha256Schema,
  limits: z
    .object({
      candidates: z.literal(1),
      turns: z.literal(1),
      maxInputBytes: z.literal(MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_INPUT_BYTES),
      maxOutputBytes: z.literal(MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES),
      maxOutputTokens: z
        .number()
        .int()
        .positive()
        .max(MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_TOKENS),
      timeoutMs: z.number().int().positive().max(86_400_000),
    })
    .strict(),
  operation: z.enum(["add", "replace"]),
  priorSha256: sha256Schema.nullable(),
  usage: generationUsageSchema,
};
const generationSchema = z
  .object({
    ...generationShape,
    evidence: z
      .array(generationEvidenceIdentitySchema.extend({ path: portableRelativePathSchema }))
      .min(1)
      .max(MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE)
      .refine(
        (evidence) =>
          new Set(evidence.map((item) => item.path)).size === evidence.length &&
          new Set(evidence.map((item) => item.evidenceDigest)).size === evidence.length,
        "generation evidence must be unique",
      ),
  })
  .strict()
  .superRefine(validateGenerationUsage);
const generationIdentitySchema = z
  .object({
    ...generationShape,
    evidence: z
      .array(generationEvidenceIdentitySchema)
      .min(1)
      .max(MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE)
      .refine(
        (evidence) =>
          new Set(evidence.map((item) => item.sourceSha256)).size === evidence.length &&
          new Set(evidence.map((item) => item.evidenceDigest)).size === evidence.length,
        "generation evidence identities must be unique",
      ),
  })
  .strict()
  .superRefine(validateGenerationUsage);
const sourceSchema = z
  .object({
    apiVersion: z.literal(SUPPLEMENTAL_MEMORY_CANDIDATE_API_VERSION),
    kind: z.literal("SupplementalMemoryCandidate"),
    metadata: z.object({ id: identifierSchema, version: semanticVersionSchema }).strict(),
    scope: scopeSchema,
    baseline: z
      .object({
        stateDigest: sha256Schema,
        workflowDigest: sha256Schema,
        packageClosureDigest: sha256Schema,
      })
      .strict(),
    change: z.discriminatedUnion("kind", [
      addChangeSchema,
      replaceChangeSchema,
      removeChangeSchema,
    ]),
    relationships: relationshipChangesSchema.optional(),
    generation: generationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.generation !== undefined && value.relationships !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["relationships"],
        message: "model-generated memory cannot declare relationships",
      });
    }
  });

const byteIdentitySchema = z
  .object({
    bytes: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();
const relationshipChangeIdentitySchema = z
  .object({
    baselineAssessmentDigest: sha256Schema.nullable(),
    projectedAssessmentDigest: sha256Schema.nullable(),
    removed: z.array(z.object({ id: identifierSchema, digest: sha256Schema }).strict()),
    added: z.array(z.object({ id: identifierSchema, digest: sha256Schema }).strict()),
  })
  .strict();
const identitySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("supplemental-memory-candidate"),
    id: identifierSchema,
    candidateVersion: semanticVersionSchema,
    scope: scopeSchema,
    manifest: z
      .object({ provenance: portableRelativePathSchema, sourceSha256: sha256Schema })
      .strict(),
    baseline: z
      .object({
        stateDigest: sha256Schema,
        workflowDigest: sha256Schema,
        packageClosureDigest: sha256Schema,
        entry: byteIdentitySchema.nullable(),
      })
      .strict(),
    change: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("add"), before: z.null(), after: byteIdentitySchema }).strict(),
      z
        .object({
          kind: z.literal("replace"),
          before: byteIdentitySchema,
          after: byteIdentitySchema,
        })
        .strict(),
      z.object({ kind: z.literal("remove"), before: byteIdentitySchema, after: z.null() }).strict(),
    ]),
    relationships: relationshipChangeIdentitySchema.optional(),
    generation: generationIdentitySchema.optional(),
    projectedStateDigest: sha256Schema,
    candidateDigest: sha256Schema,
  })
  .strict();

export type SupplementalMemoryCandidateSource = Readonly<z.infer<typeof sourceSchema>>;
export type SupplementalMemoryCandidateIdentity = Readonly<z.infer<typeof identitySchema>>;

export interface SupplementalMemoryCandidateProjectionInput {
  readonly manifestProvenance: string;
  readonly sourceSha256: string;
  readonly source: SupplementalMemoryCandidateSource;
  readonly baseline: EffectiveHarnessState;
  readonly evidence?: readonly {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly packet: TuningEvidencePacket;
  }[];
  readonly relationshipEvidence?: readonly RunEvidenceReference[];
}

export interface ProjectedSupplementalMemoryCandidate {
  readonly identity: SupplementalMemoryCandidateIdentity;
  readonly state: EffectiveHarnessState;
}

export type SupplementalMemoryCandidateErrorCode =
  | "identity_mismatch"
  | "invalid_projection"
  | "invalid_schema"
  | "limit_exceeded";

export class SupplementalMemoryCandidateError extends Error {
  override readonly name = "SupplementalMemoryCandidateError";

  constructor(
    readonly code: SupplementalMemoryCandidateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function parseSupplementalMemoryCandidateText(
  text: string,
  _sourceName = "supplemental-memory candidate",
): SupplementalMemoryCandidateSource {
  if (Buffer.byteLength(text, "utf8") > MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES) {
    throw new SupplementalMemoryCandidateError(
      "limit_exceeded",
      `supplemental-memory candidate exceeds ${MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES} UTF-8 bytes`,
    );
  }
  let input: unknown;
  try {
    const document = parseDocument(text, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) throw new Error("invalid document");
    input = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new SupplementalMemoryCandidateError(
      "invalid_schema",
      "supplemental-memory candidate cannot be parsed",
    );
  }
  const parsed = sourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new SupplementalMemoryCandidateError(
      "invalid_schema",
      "supplemental-memory candidate schema is invalid",
    );
  }
  return deepFreeze(parsed.data);
}

export function projectSupplementalMemoryCandidate(
  input: SupplementalMemoryCandidateProjectionInput,
): ProjectedSupplementalMemoryCandidate {
  const packageClosureDigest = calculateCapabilitySnapshotDigest(input.baseline.packages);
  if (
    input.source.baseline.stateDigest !== input.baseline.stateDigest ||
    input.source.baseline.workflowDigest !== input.baseline.workflow.workflowDigest ||
    input.source.baseline.packageClosureDigest !== packageClosureDigest ||
    input.source.scope.workflowId !== input.baseline.workflowId
  ) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory candidate baseline does not match",
    );
  }
  const target: SupplementalMemoryTarget = {
    workflowId: input.source.scope.workflowId,
    childPath: input.source.scope.childPath,
    agentNodeId: input.source.scope.agentNodeId,
  };
  const current = input.baseline.supplementalMemory ?? [];
  const selected = findEntry(current, target, input.source.scope.entryId);
  if (input.source.change.kind === "add" && selected !== undefined) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory add target already exists",
    );
  }
  if (
    input.source.change.kind !== "add" &&
    (selected === undefined || selected.sha256 !== input.source.change.beforeSha256)
  ) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory prior entry identity does not match",
    );
  }
  validateGenerationProvenance(input, selected);
  if (
    input.source.change.kind === "replace" &&
    selected !== undefined &&
    selected.sha256 === sha256(input.source.change.value)
  ) {
    throw new SupplementalMemoryCandidateError(
      "invalid_projection",
      "supplemental-memory replacement must change its declared entry",
    );
  }
  const retained = current
    .filter((entry) => entry !== selected)
    .map((entry) => ({
      id: entry.id,
      target: entry.target,
      content: supplementalMemoryContent(entry),
    }));
  const replacement =
    input.source.change.kind === "remove"
      ? []
      : [
          {
            id: input.source.scope.entryId,
            target,
            content: input.source.change.value,
          },
        ];
  const relationshipProjection = projectRelationshipChanges(input, target, selected);
  let state: EffectiveHarnessState;
  try {
    state = createEffectiveHarnessState({
      scopeDigest: input.baseline.scopeDigest,
      workflowSource: effectiveHarnessWorkflowSource(input.baseline),
      ...(input.baseline.rootPackage === undefined
        ? {}
        : { rootPackage: input.baseline.rootPackage }),
      packages: input.baseline.packages,
      supplementalMemory: [...retained, ...replacement],
      supplementalMemoryRelationships: relationshipProjection.relationships,
    });
  } catch {
    throw new SupplementalMemoryCandidateError(
      "invalid_projection",
      "supplemental-memory relationship projection is invalid",
    );
  }
  const projectedEntry = findEntry(
    state.supplementalMemory ?? [],
    target,
    input.source.scope.entryId,
  );
  if (
    state.stateDigest === input.baseline.stateDigest ||
    (input.source.change.kind === "remove"
      ? projectedEntry !== undefined
      : projectedEntry === undefined)
  ) {
    throw new SupplementalMemoryCandidateError(
      "invalid_projection",
      "supplemental-memory candidate did not change its declared entry",
    );
  }
  const before = selected === undefined ? null : byteIdentity(selected);
  const after = projectedEntry === undefined ? null : byteIdentity(projectedEntry);
  const identityChange =
    input.source.change.kind === "add"
      ? { kind: "add" as const, before: null, after: requireIdentity(after) }
      : input.source.change.kind === "replace"
        ? {
            kind: "replace" as const,
            before: requireIdentity(before),
            after: requireIdentity(after),
          }
        : { kind: "remove" as const, before: requireIdentity(before), after: null };
  const withoutDigest = {
    version: 1 as const,
    kind: "supplemental-memory-candidate" as const,
    id: input.source.metadata.id,
    candidateVersion: input.source.metadata.version,
    scope: input.source.scope,
    manifest: {
      provenance: input.manifestProvenance,
      sourceSha256: input.sourceSha256,
    },
    baseline: {
      stateDigest: input.baseline.stateDigest,
      workflowDigest: input.baseline.workflow.workflowDigest,
      packageClosureDigest,
      entry: before,
    },
    change: identityChange,
    ...(input.source.relationships === undefined
      ? {}
      : {
          relationships: {
            baselineAssessmentDigest:
              input.baseline.supplementalMemoryRelationships?.assessment.digest ?? null,
            projectedAssessmentDigest:
              state.supplementalMemoryRelationships?.assessment.digest ?? null,
            removed: relationshipProjection.removed,
            added: relationshipProjection.addedIds.map((id) => {
              const relationship = state.supplementalMemoryRelationships?.relationships.find(
                (item) => item.id === id && sameTarget(item.target, target),
              );
              if (relationship === undefined) {
                throw new SupplementalMemoryCandidateError(
                  "invalid_projection",
                  "supplemental-memory relationship addition is missing",
                );
              }
              return { id: relationship.id, digest: relationship.digest };
            }),
          },
        }),
    ...(input.source.generation === undefined
      ? {}
      : {
          generation: {
            ...input.source.generation,
            evidence: input.source.generation.evidence.map(({ path: _path, ...item }) => item),
          },
        }),
    projectedStateDigest: state.stateDigest,
  };
  const identity = parseSupplementalMemoryCandidateIdentity({
    ...withoutDigest,
    candidateDigest: sha256(canonicalize(withoutDigest)),
  });
  assertSupplementalMemoryCandidateSurface(identity, input.baseline, state);
  return deepFreeze({ identity, state });
}

function projectRelationshipChanges(
  input: SupplementalMemoryCandidateProjectionInput,
  target: SupplementalMemoryTarget,
  selected: SupplementalMemoryEntry | undefined,
): {
  readonly relationships: readonly SupplementalMemoryRelationshipInput[];
  readonly removed: readonly { readonly id: string; readonly digest: string }[];
  readonly addedIds: readonly string[];
} {
  const baselineRelationships = input.baseline.supplementalMemoryRelationships?.relationships ?? [];
  const source = input.source.relationships;
  const beforeEndpoint =
    selected === undefined ? undefined : { entryId: selected.id, entrySha256: selected.sha256 };
  const incident =
    beforeEndpoint === undefined
      ? []
      : baselineRelationships.filter(
          (relationship) =>
            sameTarget(relationship.target, target) &&
            (sameEndpoint(relationship.from, beforeEndpoint) ||
              sameEndpoint(relationship.to, beforeEndpoint)),
        );
  if (source === undefined) {
    if (incident.length > 0) {
      throw new SupplementalMemoryCandidateError(
        "invalid_projection",
        "supplemental-memory candidate omits incident relationship changes",
      );
    }
    if ((input.relationshipEvidence?.length ?? 0) > 0) {
      throw new SupplementalMemoryCandidateError(
        "identity_mismatch",
        "supplemental-memory candidate contains unselected relationship evidence",
      );
    }
    return {
      relationships: baselineRelationships.map(withoutRelationshipDigest),
      removed: [],
      addedIds: [],
    };
  }

  const removedRelationships: SupplementalMemoryRelationship[] = [];
  for (const removal of source.remove) {
    const relationship = baselineRelationships.find(
      (item) => item.id === removal.id && sameTarget(item.target, target),
    );
    if (
      relationship === undefined ||
      relationship.digest !== removal.beforeDigest ||
      beforeEndpoint === undefined ||
      (!sameEndpoint(relationship.from, beforeEndpoint) &&
        !sameEndpoint(relationship.to, beforeEndpoint))
    ) {
      throw new SupplementalMemoryCandidateError(
        "identity_mismatch",
        "supplemental-memory relationship removal identity does not match",
      );
    }
    removedRelationships.push(relationship);
  }
  if (
    incident.length !== removedRelationships.length ||
    incident.some(
      (relationship) =>
        !removedRelationships.some((removed) => removed.digest === relationship.digest),
    )
  ) {
    throw new SupplementalMemoryCandidateError(
      "invalid_projection",
      "supplemental-memory candidate does not declare every incident relationship",
    );
  }
  if (input.source.change.kind === "remove" && source.add.length > 0) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory removal cannot add relationships",
    );
  }

  const afterEndpoint =
    input.source.change.kind === "remove"
      ? undefined
      : { entryId: input.source.scope.entryId, entrySha256: sha256(input.source.change.value) };
  const references = new Map(
    (input.relationshipEvidence ?? []).map((reference) => [
      runEvidenceLocatorKey(reference),
      reference,
    ]),
  );
  const usedReferences = new Set<string>();
  const additions = source.add.map((addition): SupplementalMemoryRelationshipInput => {
    if (
      afterEndpoint === undefined ||
      (!sameEndpoint(addition.from, afterEndpoint) && !sameEndpoint(addition.to, afterEndpoint))
    ) {
      throw new SupplementalMemoryCandidateError(
        "identity_mismatch",
        "supplemental-memory relationship addition is not incident to the candidate entry",
      );
    }
    if (
      addition.predicate === "supersedes" &&
      (input.source.change.kind !== "replace" ||
        beforeEndpoint === undefined ||
        !sameEndpoint(addition.from, afterEndpoint) ||
        !sameEndpoint(addition.to, beforeEndpoint))
    ) {
      throw new SupplementalMemoryCandidateError(
        "identity_mismatch",
        "supplemental-memory supersession does not bind the exact replacement",
      );
    }
    const evidence = addition.evidence.map((locator) => {
      const key = runEvidenceLocatorKey(locator);
      const reference = references.get(key);
      if (reference === undefined) {
        throw new SupplementalMemoryCandidateError(
          "identity_mismatch",
          "supplemental-memory relationship evidence could not be resolved",
        );
      }
      usedReferences.add(key);
      return reference;
    });
    return {
      id: addition.id,
      target,
      predicate: addition.predicate,
      from: addition.from,
      to: addition.to,
      evidence,
    };
  });
  if (usedReferences.size !== references.size) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory candidate contains unselected relationship evidence",
    );
  }
  const removedDigests = new Set(removedRelationships.map((relationship) => relationship.digest));
  return {
    relationships: [
      ...baselineRelationships
        .filter((relationship) => !removedDigests.has(relationship.digest))
        .map(withoutRelationshipDigest),
      ...additions,
    ],
    removed: removedRelationships
      .map((relationship) => ({ id: relationship.id, digest: relationship.digest }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    addedIds: additions.map((relationship) => relationship.id).sort(),
  };
}

function withoutRelationshipDigest(
  relationship: SupplementalMemoryRelationship,
): SupplementalMemoryRelationshipInput {
  const { digest: _digest, ...input } = relationship;
  return input;
}

function sameEndpoint(
  left: { readonly entryId: string; readonly entrySha256: string },
  right: { readonly entryId: string; readonly entrySha256: string },
): boolean {
  return left.entryId === right.entryId && left.entrySha256 === right.entrySha256;
}

function validateGenerationProvenance(
  input: SupplementalMemoryCandidateProjectionInput,
  selected: SupplementalMemoryEntry | undefined,
): void {
  const generation = input.source.generation;
  if (generation === undefined) return;
  if (input.source.change.kind === "remove" || input.source.change.kind !== generation.operation) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory generation operation does not match",
    );
  }
  const expectedPriorSha256 = selected?.sha256 ?? null;
  if (generation.priorSha256 !== expectedPriorSha256) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory generation prior identity does not match",
    );
  }
  const evidence = input.evidence ?? [];
  if (evidence.length !== generation.evidence.length) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory generation evidence count does not match",
    );
  }
  const admittedEvidence = evidence.map((actual, index) => {
    const declared = generation.evidence[index];
    if (declared === undefined) {
      throw new SupplementalMemoryCandidateError(
        "identity_mismatch",
        "supplemental-memory generation evidence is incomplete",
      );
    }
    const packet = parseTuningEvidencePacket(actual.packet);
    if (
      actual.provenance !== declared.path ||
      actual.sourceSha256 !== declared.sourceSha256 ||
      packet.evidenceDigest !== declared.evidenceDigest ||
      packet.evaluation.planDigest !== declared.planDigest ||
      !packet.profiles.some(
        (profile) => profile.workflowDigest === input.baseline.workflow.workflowDigest,
      )
    ) {
      throw new SupplementalMemoryCandidateError(
        "identity_mismatch",
        "supplemental-memory generation evidence does not match",
      );
    }
    return { sourceSha256: actual.sourceSha256, packet };
  });
  const compiled = compileEffectiveHarnessState(input.baseline);
  let selectedWorkflow = compiled;
  for (const childNodeId of input.source.scope.childPath) {
    const child = selectedWorkflow.nodes.find((node) => node.id === childNodeId);
    if (child?.type !== "child" || child.child.workflow.sourcePackage !== undefined) {
      throw new SupplementalMemoryCandidateError(
        "identity_mismatch",
        "supplemental-memory generation target does not match",
      );
    }
    selectedWorkflow = child.child.workflow;
  }
  const agent = selectedWorkflow.nodes.find(
    (node) => node.id === input.source.scope.agentNodeId && node.type === "agent",
  );
  if (agent?.type !== "agent") {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory generation target does not match",
    );
  }
  const target: SupplementalMemoryTarget = {
    workflowId: input.source.scope.workflowId,
    childPath: input.source.scope.childPath,
    agentNodeId: input.source.scope.agentNodeId,
  };
  const targetMemory = (input.baseline.supplementalMemory ?? [])
    .filter((entry) => sameTarget(entry.target, target))
    .map((entry) => ({
      id: entry.id,
      bytes: entry.bytes,
      sha256: entry.sha256,
      value: supplementalMemoryContent(entry),
    }));
  const request = {
    baseline: {
      stateDigest: input.baseline.stateDigest,
      workflowDigest: input.baseline.workflow.workflowDigest,
      packageClosureDigest: calculateCapabilitySnapshotDigest(input.baseline.packages),
    },
    target: {
      scope: input.source.scope,
      operation: generation.operation,
      prior:
        selected === undefined
          ? null
          : {
              bytes: selected.bytes,
              sha256: selected.sha256,
              value: supplementalMemoryContent(selected),
            },
      agent: { prompt: agent.agent.prompt, promptSha256: sha256(agent.agent.prompt) },
      memory: targetMemory,
    },
    evidence: admittedEvidence,
    model: {
      provider: generation.provider,
      id: generation.model,
      thinking: generation.thinking,
    },
    limits: {
      timeoutMs: generation.limits.timeoutMs,
      maxOutputTokens: generation.limits.maxOutputTokens,
    },
  };
  if (
    Buffer.byteLength(renderSupplementalMemoryCandidateGenerationRequest(request), "utf8") >
      generation.limits.maxInputBytes ||
    calculateSupplementalMemoryCandidateGenerationRequestDigest(request) !==
      generation.requestDigest
  ) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory generation request identity does not match",
    );
  }
  const value = input.source.change.value;
  if (
    Buffer.byteLength(renderSupplementalMemoryCandidateGenerationResponse(value), "utf8") >
      generation.limits.maxOutputBytes ||
    calculateSupplementalMemoryCandidateGenerationResponseDigest(value) !==
      generation.responseDigest
  ) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory generation response identity does not match",
    );
  }
}

function validateGenerationUsage(
  generation: {
    readonly limits: { readonly maxOutputTokens: number };
    readonly usage: { readonly outputTokens: number };
  },
  context: z.RefinementCtx,
): void {
  if (generation.usage.outputTokens > generation.limits.maxOutputTokens) {
    context.addIssue({
      code: "custom",
      path: ["usage", "outputTokens"],
      message: "reported output tokens cannot exceed the generation output-token limit",
    });
  }
}

export function assertSupplementalMemoryCandidateSurface(
  identity: SupplementalMemoryCandidateIdentity,
  baseline: EffectiveHarnessState,
  projected: EffectiveHarnessState,
): void {
  const packageClosureDigest = calculateCapabilitySnapshotDigest(baseline.packages);
  if (
    identity.scope.workflowId !== baseline.workflowId ||
    projected.workflowId !== baseline.workflowId ||
    identity.baseline.stateDigest !== baseline.stateDigest ||
    identity.baseline.workflowDigest !== baseline.workflow.workflowDigest ||
    identity.baseline.packageClosureDigest !== packageClosureDigest ||
    identity.projectedStateDigest !== projected.stateDigest ||
    !isDeepStrictEqual(baseline.workflow, projected.workflow) ||
    !isDeepStrictEqual(baseline.rootPackage, projected.rootPackage) ||
    !isDeepStrictEqual(baseline.packages, projected.packages)
  ) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory candidate state identity does not match",
    );
  }
  const target: SupplementalMemoryTarget = {
    workflowId: identity.scope.workflowId,
    childPath: identity.scope.childPath,
    agentNodeId: identity.scope.agentNodeId,
  };
  const before = findEntry(baseline.supplementalMemory ?? [], target, identity.scope.entryId);
  const after = findEntry(projected.supplementalMemory ?? [], target, identity.scope.entryId);
  if (
    !isDeepStrictEqual(
      identity.baseline.entry,
      before === undefined ? null : byteIdentity(before),
    ) ||
    !isDeepStrictEqual(
      identity.change.before,
      before === undefined ? null : byteIdentity(before),
    ) ||
    !isDeepStrictEqual(identity.change.after, after === undefined ? null : byteIdentity(after)) ||
    (identity.change.kind === "add" && (before !== undefined || after === undefined)) ||
    (identity.change.kind === "replace" && (before === undefined || after === undefined)) ||
    (identity.change.kind === "remove" && (before === undefined || after !== undefined))
  ) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory candidate entry identity does not match",
    );
  }
  const beforeOther = withoutEntry(
    baseline.supplementalMemory ?? [],
    target,
    identity.scope.entryId,
  );
  const afterOther = withoutEntry(
    projected.supplementalMemory ?? [],
    target,
    identity.scope.entryId,
  );
  if (
    !isDeepStrictEqual(beforeOther, afterOther) ||
    baseline.stateDigest === projected.stateDigest
  ) {
    throw new SupplementalMemoryCandidateError(
      "invalid_projection",
      "supplemental-memory candidate changes authority outside its declared entry",
    );
  }
  assertSupplementalMemoryRelationshipSurface(identity, baseline, projected, target);
}

function assertSupplementalMemoryRelationshipSurface(
  identity: SupplementalMemoryCandidateIdentity,
  baseline: EffectiveHarnessState,
  projected: EffectiveHarnessState,
  target: SupplementalMemoryTarget,
): void {
  const beforeState = baseline.supplementalMemoryRelationships;
  const afterState = projected.supplementalMemoryRelationships;
  if (identity.relationships === undefined) {
    if (!isDeepStrictEqual(beforeState, afterState)) {
      throw new SupplementalMemoryCandidateError(
        "invalid_projection",
        "supplemental-memory candidate changes undeclared relationships",
      );
    }
    return;
  }
  if (
    identity.relationships.baselineAssessmentDigest !== (beforeState?.assessment.digest ?? null) ||
    identity.relationships.projectedAssessmentDigest !== (afterState?.assessment.digest ?? null)
  ) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory relationship assessment identity does not match",
    );
  }
  const before = beforeState?.relationships ?? [];
  const after = afterState?.relationships ?? [];
  const removed = before.filter(
    (relationship) => !after.some((item) => item.digest === relationship.digest),
  );
  const added = after.filter(
    (relationship) => !before.some((item) => item.digest === relationship.digest),
  );
  const expectedRemoved = removed
    .map((relationship) => ({ id: relationship.id, digest: relationship.digest }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedAdded = added
    .map((relationship) => ({ id: relationship.id, digest: relationship.digest }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    !isDeepStrictEqual(identity.relationships.removed, expectedRemoved) ||
    !isDeepStrictEqual(identity.relationships.added, expectedAdded) ||
    [...removed, ...added].some((relationship) => !sameTarget(relationship.target, target))
  ) {
    throw new SupplementalMemoryCandidateError(
      "invalid_projection",
      "supplemental-memory candidate relationship surface does not match",
    );
  }
}

export function parseSupplementalMemoryCandidateIdentity(
  input: unknown,
): SupplementalMemoryCandidateIdentity {
  const parsed = identitySchema.safeParse(input);
  if (!parsed.success) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory candidate identity is invalid",
    );
  }
  const { candidateDigest: _candidateDigest, ...withoutDigest } = parsed.data;
  if (sha256(canonicalize(withoutDigest)) !== parsed.data.candidateDigest) {
    throw new SupplementalMemoryCandidateError(
      "identity_mismatch",
      "supplemental-memory candidate identity digest does not match",
    );
  }
  return deepFreeze(parsed.data);
}

function findEntry(
  entries: readonly SupplementalMemoryEntry[],
  target: SupplementalMemoryTarget,
  entryId: string,
): SupplementalMemoryEntry | undefined {
  return entries.find(
    (entry) =>
      entry.id === entryId &&
      entry.target.workflowId === target.workflowId &&
      entry.target.agentNodeId === target.agentNodeId &&
      entry.target.childPath.length === target.childPath.length &&
      entry.target.childPath.every((item, index) => item === target.childPath[index]),
  );
}

function sameTarget(left: SupplementalMemoryTarget, right: SupplementalMemoryTarget): boolean {
  return (
    left.workflowId === right.workflowId &&
    left.agentNodeId === right.agentNodeId &&
    left.childPath.length === right.childPath.length &&
    left.childPath.every((item, index) => item === right.childPath[index])
  );
}

function withoutEntry(
  entries: readonly SupplementalMemoryEntry[],
  target: SupplementalMemoryTarget,
  entryId: string,
): readonly SupplementalMemoryEntry[] {
  const selected = findEntry(entries, target, entryId);
  return selected === undefined ? entries : entries.filter((entry) => entry !== selected);
}

function byteIdentity(entry: SupplementalMemoryEntry): {
  readonly bytes: number;
  readonly sha256: string;
} {
  return { bytes: entry.bytes, sha256: entry.sha256 };
}

function requireIdentity<Value>(value: Value | null): Value {
  if (value === null) {
    throw new SupplementalMemoryCandidateError(
      "invalid_projection",
      "supplemental-memory candidate entry identity is missing",
    );
  }
  return value;
}

function isPortableRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new SupplementalMemoryCandidateError(
    "invalid_schema",
    "supplemental-memory candidate is not canonical JSON",
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
