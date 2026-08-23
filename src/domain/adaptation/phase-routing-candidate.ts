import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { parseDocument } from "yaml";
import { z } from "zod";

import {
  compileWorkflowText,
  parseWorkflowSourceText,
  WorkflowCompilationError,
} from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import type { WorkflowSource } from "../workflow/schema.js";
import {
  MAX_CHILD_WORKFLOW_DEPTH,
  MAX_RUN_TREE_NODES,
  type CompiledNode,
  type CompiledWorkflow,
} from "../workflow/types.js";
import type { ModelRoute } from "./model-routing-candidate.js";

export const PHASE_ROUTING_CANDIDATE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_PHASE_ROUTING_CANDIDATE_BYTES = 1_048_576;
export const MAX_PHASE_ROUTING_PROJECTED_WORKFLOW_BYTES = 8 * 1024 * 1024;
export const PHASE_ROUTING_PHASES = Object.freeze([
  "planner",
  "executor",
  "verifier",
  "escalation",
] as const);

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
const modelRouteSchema = z
  .object({
    provider: identifierSchema,
    id: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value === value.trim(), "model id must not contain outer whitespace"),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  })
  .strict();
const targetSchema = z
  .object({
    workflowId: identifierSchema,
    childPath: z.array(identifierSchema).max(MAX_CHILD_WORKFLOW_DEPTH),
    nodeId: identifierSchema,
  })
  .strict();
const assignmentSchema = z
  .object({
    phase: z.enum(PHASE_ROUTING_PHASES),
    target: targetSchema,
    route: modelRouteSchema,
  })
  .strict();
const sourceProfileSchema = z
  .object({
    selectionRule: z.literal("exact-target-v1"),
    fallback: z.literal("deny"),
    assignments: z.array(assignmentSchema).min(1).max(MAX_RUN_TREE_NODES),
  })
  .strict()
  .superRefine((profile, context) => refineUniqueTargets(profile.assignments, context));
const durableProfileSchema = sourceProfileSchema.extend({ profileDigest: sha256Schema }).strict();
const decisionContentSchema = z
  .object({
    version: z.literal(1),
    profileDigest: sha256Schema,
    phase: z.enum(PHASE_ROUTING_PHASES),
    target: targetSchema,
    selectionRule: z.literal("exact-target-v1"),
    selectionResult: z.literal("selected"),
    route: modelRouteSchema,
    fallback: z.literal("deny"),
    fallbackResult: z.literal("not-used"),
    escalationResult: z.enum(["selected", "not-selected"]),
  })
  .strict()
  .superRefine((decision, context) => {
    const expected = decision.phase === "escalation" ? "selected" : "not-selected";
    if (decision.escalationResult !== expected) {
      context.addIssue({
        code: "custom",
        path: ["escalationResult"],
        message: `must be ${expected} for the selected phase`,
      });
    }
  });
export const phaseRoutingDecisionSchema: z.ZodType<PhaseRoutingDecision> = decisionContentSchema
  .extend({ decisionDigest: sha256Schema })
  .strict()
  .superRefine((decision, context) => {
    const { decisionDigest, ...content } = decision;
    if (calculatePhaseRoutingDecisionDigest(content) !== decisionDigest) {
      context.addIssue({
        code: "custom",
        path: ["decisionDigest"],
        message: "phase-routing decision digest does not match",
      });
    }
  });
const scopeSchema = z
  .object({
    kind: z.literal("workflow-phase-routing"),
    workflowId: identifierSchema,
  })
  .strict();

const sourceSchema = z
  .object({
    apiVersion: z.literal(PHASE_ROUTING_CANDIDATE_API_VERSION),
    kind: z.literal("PhaseRoutingCandidate"),
    metadata: z.object({ id: identifierSchema, version: semanticVersionSchema }).strict(),
    scope: scopeSchema,
    baseline: z
      .object({
        workflow: z
          .object({
            path: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    profiles: z.object({ before: sourceProfileSchema, after: sourceProfileSchema }).strict(),
  })
  .strict()
  .superRefine((source, context) => refineProfilePair(source.profiles, context));

export type PhaseRoutingPhase = (typeof PHASE_ROUTING_PHASES)[number];
export interface PhaseRoutingTarget {
  readonly workflowId: string;
  readonly childPath: readonly string[];
  readonly nodeId: string;
}
export interface PhaseRoutingAssignment {
  readonly phase: PhaseRoutingPhase;
  readonly target: PhaseRoutingTarget;
  readonly route: ModelRoute;
}
export type PhaseRoutingCandidateSource = Readonly<z.infer<typeof sourceSchema>>;
export type PhaseRoutingProfileSource = Readonly<z.infer<typeof sourceProfileSchema>>;

export interface PhaseRoutingProfile extends PhaseRoutingProfileSource {
  readonly profileDigest: string;
}

export interface PhaseRoutingDecision {
  readonly version: 1;
  readonly profileDigest: string;
  readonly phase: PhaseRoutingPhase;
  readonly target: PhaseRoutingTarget;
  readonly selectionRule: "exact-target-v1";
  readonly selectionResult: "selected";
  readonly route: ModelRoute;
  readonly fallback: "deny";
  readonly fallbackResult: "not-used";
  readonly escalationResult: "selected" | "not-selected";
  readonly decisionDigest: string;
}

export interface PhaseRoutingCandidateIdentity {
  readonly version: 1;
  readonly kind: "phase-routing-candidate";
  readonly id: string;
  readonly candidateVersion: string;
  readonly scope: PhaseRoutingCandidateSource["scope"];
  readonly manifest: {
    readonly provenance: string;
    readonly sourceSha256: string;
  };
  readonly baseline: {
    readonly workflow: {
      readonly provenance: string;
      readonly sourceSha256: string;
      readonly workflowDigest: string;
    };
  };
  readonly profiles: {
    readonly before: PhaseRoutingProfile;
    readonly after: PhaseRoutingProfile;
  };
  readonly projected: {
    readonly baselineWorkflow: {
      readonly sourceSha256: string;
      readonly workflowDigest: string;
    };
    readonly candidateWorkflow: {
      readonly sourceSha256: string;
      readonly workflowDigest: string;
    };
  };
  readonly candidateDigest: string;
}

const workflowIdentitySchema = z
  .object({ sourceSha256: sha256Schema, workflowDigest: sha256Schema })
  .strict();
const identitySchema: z.ZodType<PhaseRoutingCandidateIdentity> = z
  .object({
    version: z.literal(1),
    kind: z.literal("phase-routing-candidate"),
    id: identifierSchema,
    candidateVersion: semanticVersionSchema,
    scope: scopeSchema,
    manifest: z
      .object({ provenance: portableRelativePathSchema, sourceSha256: sha256Schema })
      .strict(),
    baseline: z
      .object({
        workflow: z
          .object({
            provenance: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    profiles: z.object({ before: durableProfileSchema, after: durableProfileSchema }).strict(),
    projected: z
      .object({
        baselineWorkflow: workflowIdentitySchema,
        candidateWorkflow: workflowIdentitySchema,
      })
      .strict(),
    candidateDigest: sha256Schema,
  })
  .strict()
  .superRefine((identity, context) => refineProfilePair(identity.profiles, context));

export interface PhaseRoutingCandidateProjectionInput {
  readonly manifestProvenance: string;
  readonly sourceSha256: string;
  readonly source: PhaseRoutingCandidateSource;
  readonly baseline: {
    readonly provenance: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly source: WorkflowSource;
    readonly compiled: CompiledWorkflow;
  };
}

export interface PhaseRoutingWorkflowProjection {
  readonly source: string;
  readonly sourceSha256: string;
  readonly compiled: CompiledWorkflow;
  readonly workflowDigest: string;
}

export interface ProjectedPhaseRoutingCandidate {
  readonly identity: PhaseRoutingCandidateIdentity;
  readonly workflows: {
    readonly baseline: PhaseRoutingWorkflowProjection;
    readonly candidate: PhaseRoutingWorkflowProjection;
  };
}

export type PhaseRoutingCandidateErrorCode =
  | "identity_mismatch"
  | "invalid_projection"
  | "invalid_schema"
  | "invalid_target"
  | "invalid_yaml"
  | "limit_exceeded";

export class PhaseRoutingCandidateError extends Error {
  override readonly name = "PhaseRoutingCandidateError";

  constructor(
    readonly code: PhaseRoutingCandidateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${boundedText(message, 8_192)}`, options);
  }
}

export function parsePhaseRoutingCandidateText(
  source: string,
  sourceName = "phase-routing candidate",
): PhaseRoutingCandidateSource {
  if (Buffer.byteLength(source, "utf8") > MAX_PHASE_ROUTING_CANDIDATE_BYTES) {
    throw new PhaseRoutingCandidateError(
      "limit_exceeded",
      `${sourceName} exceeds ${MAX_PHASE_ROUTING_CANDIDATE_BYTES} UTF-8 bytes`,
    );
  }
  let input: unknown;
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new PhaseRoutingCandidateError(
        "invalid_yaml",
        `${sourceName}: ${boundedMessages(document.errors.map((error) => error.message))}`,
      );
    }
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof PhaseRoutingCandidateError) throw error;
    throw new PhaseRoutingCandidateError("invalid_yaml", `${sourceName} cannot be parsed`, {
      cause: error,
    });
  }
  const parsed = sourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new PhaseRoutingCandidateError(
      "invalid_schema",
      `${sourceName}: ${boundedIssues(parsed.error.issues)}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

export function createPhaseRoutingProfile(source: PhaseRoutingProfileSource): PhaseRoutingProfile {
  const parsed = sourceProfileSchema.safeParse(source);
  if (!parsed.success) {
    throw new PhaseRoutingCandidateError(
      "invalid_schema",
      `phase-routing profile is invalid: ${boundedIssues(parsed.error.issues)}`,
    );
  }
  const content = deepFreeze(parsed.data);
  return deepFreeze({ ...content, profileDigest: calculatePhaseRoutingProfileDigest(content) });
}

export function parsePhaseRoutingProfile(input: unknown): PhaseRoutingProfile {
  const parsed = durableProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw new PhaseRoutingCandidateError("identity_mismatch", "phase-routing profile is invalid");
  }
  const { profileDigest, ...content } = parsed.data;
  if (calculatePhaseRoutingProfileDigest(content) !== profileDigest) {
    throw new PhaseRoutingCandidateError(
      "identity_mismatch",
      "phase-routing profile digest does not match",
    );
  }
  return deepFreeze(parsed.data);
}

export function calculatePhaseRoutingProfileDigest(source: PhaseRoutingProfileSource): string {
  return sha256(canonicalize({ domain: "flow-phase-routing-profile-v1", ...source }));
}

export function parsePhaseRoutingCandidateIdentity(input: unknown): PhaseRoutingCandidateIdentity {
  const parsed = identitySchema.safeParse(input);
  if (!parsed.success) {
    throw new PhaseRoutingCandidateError(
      "identity_mismatch",
      `phase-routing candidate identity is invalid: ${boundedIssues(parsed.error.issues)}`,
    );
  }
  const identity = parsed.data;
  parsePhaseRoutingProfile(identity.profiles.before);
  parsePhaseRoutingProfile(identity.profiles.after);
  const { candidateDigest, ...content } = identity;
  if (calculatePhaseRoutingCandidateDigest(content) !== candidateDigest) {
    throw new PhaseRoutingCandidateError(
      "identity_mismatch",
      "phase-routing candidate identity digest does not match",
    );
  }
  return deepFreeze(identity);
}

export function calculatePhaseRoutingCandidateDigest(
  input: Omit<PhaseRoutingCandidateIdentity, "candidateDigest">,
): string {
  return sha256(canonicalize({ domain: "flow-phase-routing-candidate-v1", ...input }));
}

export function projectPhaseRoutingCandidate(
  input: PhaseRoutingCandidateProjectionInput,
): ProjectedPhaseRoutingCandidate {
  const sourceValidation = sourceSchema.safeParse(input.source);
  if (!sourceValidation.success) {
    throw new PhaseRoutingCandidateError(
      "invalid_schema",
      `phase-routing candidate projection source is invalid: ${boundedIssues(sourceValidation.error.issues)}`,
    );
  }
  validateSha256(input.sourceSha256, "candidate source");
  validateSha256(input.baseline.sourceSha256, "baseline workflow source");
  const baselineDigest = calculateWorkflowDigest(input.baseline.compiled);
  if (
    sha256(input.baseline.sourceText) !== input.baseline.sourceSha256 ||
    !isDeepStrictEqual(
      normalizeJson(parseWorkflowSourceText(input.baseline.sourceText, input.baseline.provenance)),
      normalizeJson(input.baseline.source),
    ) ||
    input.source.baseline.workflow.path !== input.baseline.provenance ||
    input.source.baseline.workflow.sourceSha256 !== input.baseline.sourceSha256 ||
    input.source.baseline.workflow.workflowDigest !== baselineDigest ||
    input.source.scope.workflowId !== input.baseline.source.metadata.id ||
    input.source.scope.workflowId !== input.baseline.compiled.id
  ) {
    throw new PhaseRoutingCandidateError(
      "identity_mismatch",
      "phase-routing candidate baseline does not match the admitted workflow",
    );
  }

  const before = createPhaseRoutingProfile(input.source.profiles.before);
  const after = createPhaseRoutingProfile(input.source.profiles.after);
  const beforeAssignments = assignmentMap(before.assignments);
  const afterAssignments = assignmentMap(after.assignments);
  const visited = new Set<string>();
  const projectedSource = projectSourceWorkflow({
    source: structuredClone(input.baseline.source),
    compiled: input.baseline.compiled,
    childPath: [],
    workflowId: input.source.scope.workflowId,
    before: beforeAssignments,
    after: afterAssignments,
    visited,
    sourceName: input.baseline.provenance,
  });
  if (visited.size !== before.assignments.length) {
    throw new PhaseRoutingCandidateError(
      "invalid_target",
      "phase-routing profile contains a target outside the admitted workflow",
    );
  }

  const candidateSource = JSON.stringify(projectedSource);
  if (Buffer.byteLength(candidateSource, "utf8") > MAX_PHASE_ROUTING_PROJECTED_WORKFLOW_BYTES) {
    throw new PhaseRoutingCandidateError(
      "limit_exceeded",
      `projected workflow exceeds ${MAX_PHASE_ROUTING_PROJECTED_WORKFLOW_BYTES} UTF-8 bytes`,
    );
  }
  let candidateCompiled: CompiledWorkflow;
  try {
    candidateCompiled = compileWorkflowText(candidateSource, input.manifestProvenance);
  } catch (error) {
    throw new PhaseRoutingCandidateError(
      "invalid_projection",
      error instanceof WorkflowCompilationError
        ? error.message
        : "phase-routing candidate workflow cannot be compiled",
      { cause: error },
    );
  }
  assertOnlyDeclaredRoutesChanged(input.baseline.compiled, candidateCompiled, before, after);

  const baselineWorkflow = workflowProjection(input.baseline.sourceText, input.baseline.compiled);
  const candidateWorkflow = workflowProjection(candidateSource, candidateCompiled);
  const identityWithoutDigest: Omit<PhaseRoutingCandidateIdentity, "candidateDigest"> = {
    version: 1,
    kind: "phase-routing-candidate",
    id: input.source.metadata.id,
    candidateVersion: input.source.metadata.version,
    scope: input.source.scope,
    manifest: {
      provenance: input.manifestProvenance,
      sourceSha256: input.sourceSha256,
    },
    baseline: {
      workflow: {
        provenance: input.baseline.provenance,
        sourceSha256: input.baseline.sourceSha256,
        workflowDigest: baselineDigest,
      },
    },
    profiles: { before, after },
    projected: {
      baselineWorkflow: {
        sourceSha256: baselineWorkflow.sourceSha256,
        workflowDigest: baselineWorkflow.workflowDigest,
      },
      candidateWorkflow: {
        sourceSha256: candidateWorkflow.sourceSha256,
        workflowDigest: candidateWorkflow.workflowDigest,
      },
    },
  };
  const identity = parsePhaseRoutingCandidateIdentity({
    ...identityWithoutDigest,
    candidateDigest: calculatePhaseRoutingCandidateDigest(identityWithoutDigest),
  });
  return deepFreeze({
    identity,
    workflows: { baseline: baselineWorkflow, candidate: candidateWorkflow },
  });
}

export function phaseRoutingTargetKey(target: PhaseRoutingTarget): string {
  return `${target.workflowId}\0${target.childPath.join("\0")}\0${target.nodeId}`;
}

export function validatePhaseRoutingProfileForWorkflow(
  input: PhaseRoutingProfile,
  workflow: CompiledWorkflow,
): PhaseRoutingProfile {
  const profile = parsePhaseRoutingProfile(input);
  const assignments = assignmentMap(profile.assignments);
  const visited = new Set<string>();
  visitCompiledModelTargets(workflow, workflow.id, [], (target, route) => {
    const key = phaseRoutingTargetKey(target);
    const assignment = assignments.get(key);
    if (assignment === undefined || !isDeepStrictEqual(assignment.route, route)) {
      throw new PhaseRoutingCandidateError(
        "identity_mismatch",
        "phase-routing profile does not match the compiled workflow model routes",
      );
    }
    visited.add(key);
  });
  if (visited.size !== profile.assignments.length) {
    throw new PhaseRoutingCandidateError(
      "invalid_target",
      "phase-routing profile contains an unknown or duplicate workflow target",
    );
  }
  return profile;
}

export function resolvePhaseRoutingAssignment(
  profile: PhaseRoutingProfile,
  target: PhaseRoutingTarget,
): PhaseRoutingAssignment {
  const parsed = parsePhaseRoutingProfile(profile);
  const assignment = parsed.assignments.find(
    (item) => phaseRoutingTargetKey(item.target) === phaseRoutingTargetKey(target),
  );
  if (assignment === undefined) {
    throw new PhaseRoutingCandidateError(
      "invalid_target",
      "phase-routing profile has no assignment for the provider call",
    );
  }
  return assignment;
}

export function createPhaseRoutingDecision(input: {
  readonly profile: PhaseRoutingProfile;
  readonly target: PhaseRoutingTarget;
  readonly route: ModelRoute;
}): PhaseRoutingDecision {
  const profile = parsePhaseRoutingProfile(input.profile);
  const assignment = resolvePhaseRoutingAssignment(profile, input.target);
  if (!isDeepStrictEqual(assignment.route, input.route)) {
    throw new PhaseRoutingCandidateError(
      "identity_mismatch",
      "selected provider route does not match its exact-target phase assignment",
    );
  }
  const content = decisionContentSchema.parse({
    version: 1,
    profileDigest: profile.profileDigest,
    phase: assignment.phase,
    target: assignment.target,
    selectionRule: profile.selectionRule,
    selectionResult: "selected",
    route: assignment.route,
    fallback: profile.fallback,
    fallbackResult: "not-used",
    escalationResult: assignment.phase === "escalation" ? "selected" : "not-selected",
  });
  return parsePhaseRoutingDecision({
    ...content,
    decisionDigest: calculatePhaseRoutingDecisionDigest(content),
  });
}

export function parsePhaseRoutingDecision(input: unknown): PhaseRoutingDecision {
  const parsed = phaseRoutingDecisionSchema.safeParse(input);
  if (!parsed.success) {
    throw new PhaseRoutingCandidateError("identity_mismatch", "phase-routing decision is invalid");
  }
  const { decisionDigest, ...content } = parsed.data;
  if (calculatePhaseRoutingDecisionDigest(content) !== decisionDigest) {
    throw new PhaseRoutingCandidateError(
      "identity_mismatch",
      "phase-routing decision digest does not match",
    );
  }
  return deepFreeze(parsed.data);
}

export function calculatePhaseRoutingDecisionDigest(
  input: Omit<PhaseRoutingDecision, "decisionDigest">,
): string {
  return sha256(canonicalize({ domain: "flow-phase-routing-decision-v1", ...input }));
}

export function applyPhaseRoutingProfile(input: {
  readonly workflowId: string;
  readonly source: WorkflowSource;
  readonly compiled: CompiledWorkflow;
  readonly before: PhaseRoutingProfile;
  readonly after: PhaseRoutingProfile;
  readonly sourceName: string;
}): PhaseRoutingWorkflowProjection {
  const before = validatePhaseRoutingProfileForWorkflow(input.before, input.compiled);
  const after = parsePhaseRoutingProfile(input.after);
  const { profileDigest: _beforeDigest, ...beforeSource } = before;
  const { profileDigest: _afterDigest, ...afterSource } = after;
  const pair = sourceSchema.shape.profiles.safeParse({
    before: beforeSource,
    after: afterSource,
  });
  if (!pair.success) {
    throw new PhaseRoutingCandidateError(
      "invalid_projection",
      `phase-routing profiles cannot be applied: ${boundedIssues(pair.error.issues)}`,
    );
  }
  const visited = new Set<string>();
  const projectedSource = projectSourceWorkflow({
    source: structuredClone(input.source),
    compiled: input.compiled,
    childPath: [],
    workflowId: input.workflowId,
    before: assignmentMap(before.assignments),
    after: assignmentMap(after.assignments),
    visited,
    sourceName: input.sourceName,
  });
  if (visited.size !== before.assignments.length) {
    throw new PhaseRoutingCandidateError(
      "invalid_target",
      "phase-routing profile contains a target outside the workflow source",
    );
  }
  const source = JSON.stringify(projectedSource);
  if (Buffer.byteLength(source, "utf8") > MAX_PHASE_ROUTING_PROJECTED_WORKFLOW_BYTES) {
    throw new PhaseRoutingCandidateError("limit_exceeded", "projected workflow exceeds its limit");
  }
  const compiled = compileWorkflowText(source, input.sourceName);
  assertOnlyDeclaredRoutesChanged(input.compiled, compiled, before, after);
  return workflowProjection(source, compiled);
}

function projectSourceWorkflow(input: {
  readonly source: WorkflowSource;
  readonly compiled: CompiledWorkflow;
  readonly childPath: readonly string[];
  readonly workflowId: string;
  readonly before: ReadonlyMap<string, PhaseRoutingAssignment>;
  readonly after: ReadonlyMap<string, PhaseRoutingAssignment>;
  readonly visited: Set<string>;
  readonly sourceName: string;
}): WorkflowSource {
  const projected = structuredClone(input.source);
  for (const sourceNode of projected.nodes) {
    const compiledNode = input.compiled.nodes.find((node) => node.id === sourceNode.id);
    if (compiledNode === undefined) {
      throw new PhaseRoutingCandidateError(
        "invalid_projection",
        "phase-routing source node is missing from the compiled workflow",
      );
    }
    const route = sourceNodeRoute(sourceNode);
    if (route !== undefined) {
      const target: PhaseRoutingTarget = {
        workflowId: input.workflowId,
        childPath: input.childPath,
        nodeId: sourceNode.id,
      };
      const key = phaseRoutingTargetKey(target);
      const before = input.before.get(key);
      const after = input.after.get(key);
      if (
        before === undefined ||
        after === undefined ||
        !isDeepStrictEqual(route, before.route) ||
        !isDeepStrictEqual(compiledNodeRoute(compiledNode), before.route)
      ) {
        throw new PhaseRoutingCandidateError(
          "identity_mismatch",
          `phase-routing target "${renderTarget(target)}" does not match its declared baseline route`,
        );
      }
      setSourceNodeRoute(sourceNode, after.route);
      input.visited.add(key);
      continue;
    }
    if (sourceNode.type !== "child" || compiledNode.type !== "child") continue;
    const nextPath = [...input.childPath, sourceNode.id];
    if (!("workflow" in sourceNode.child)) {
      const changed = [...input.after.values()].some(
        (assignment) =>
          startsWithPath(assignment.target.childPath, nextPath) &&
          !isDeepStrictEqual(
            input.before.get(phaseRoutingTargetKey(assignment.target))?.route,
            assignment.route,
          ),
      );
      if (changed) {
        throw new PhaseRoutingCandidateError(
          "invalid_target",
          "phase-routing candidate cannot rewrite a model route inside a packaged child workflow",
        );
      }
      validateCompiledPackageTargets({
        compiled: compiledNode.child.workflow,
        childPath: nextPath,
        workflowId: input.workflowId,
        before: input.before,
        after: input.after,
        visited: input.visited,
      });
      continue;
    }
    const childSource = parseWorkflowSourceText(
      sourceNode.child.workflow,
      `${input.sourceName}#${nextPath.join("/")}`,
    );
    sourceNode.child.workflow = JSON.stringify(
      projectSourceWorkflow({
        ...input,
        source: childSource,
        compiled: compiledNode.child.workflow,
        childPath: nextPath,
      }),
    );
  }
  assertNoUnaddressableCompiledModels(input.compiled, projected, input.childPath);
  return projected;
}

function validateCompiledPackageTargets(input: {
  readonly compiled: CompiledWorkflow;
  readonly childPath: readonly string[];
  readonly workflowId: string;
  readonly before: ReadonlyMap<string, PhaseRoutingAssignment>;
  readonly after: ReadonlyMap<string, PhaseRoutingAssignment>;
  readonly visited: Set<string>;
}): void {
  for (const node of input.compiled.nodes) {
    const route = compiledNodeRoute(node);
    if (route !== undefined) {
      const target = { workflowId: input.workflowId, childPath: input.childPath, nodeId: node.id };
      const key = phaseRoutingTargetKey(target);
      const before = input.before.get(key);
      const after = input.after.get(key);
      if (
        before === undefined ||
        after === undefined ||
        !isDeepStrictEqual(route, before.route) ||
        !isDeepStrictEqual(before.route, after.route)
      ) {
        throw new PhaseRoutingCandidateError(
          "invalid_target",
          "packaged child routes must be declared and remain unchanged",
        );
      }
      input.visited.add(key);
    } else if (node.type === "child") {
      validateCompiledPackageTargets({
        ...input,
        compiled: node.child.workflow,
        childPath: [...input.childPath, node.id],
      });
    }
  }
}

function visitCompiledModelTargets(
  workflow: CompiledWorkflow,
  workflowId: string,
  childPath: readonly string[],
  visit: (target: PhaseRoutingTarget, route: ModelRoute) => void,
): void {
  for (const node of workflow.nodes) {
    const route = compiledNodeRoute(node);
    if (route !== undefined) {
      visit({ workflowId, childPath, nodeId: node.id }, route);
    } else if (node.type === "child") {
      visitCompiledModelTargets(node.child.workflow, workflowId, [...childPath, node.id], visit);
    }
  }
}

function assertOnlyDeclaredRoutesChanged(
  baseline: CompiledWorkflow,
  candidate: CompiledWorkflow,
  before: PhaseRoutingProfile,
  after: PhaseRoutingProfile,
): void {
  const normalized = structuredClone(candidate);
  for (const [index, beforeAssignment] of before.assignments.entries()) {
    const afterAssignment = after.assignments[index];
    if (afterAssignment === undefined) {
      throw new PhaseRoutingCandidateError("invalid_projection", "candidate profile is incomplete");
    }
    const baselineNode = compiledTarget(baseline, beforeAssignment.target);
    const candidateNode = compiledTarget(normalized, afterAssignment.target);
    if (
      !isDeepStrictEqual(compiledNodeRoute(baselineNode), beforeAssignment.route) ||
      !isDeepStrictEqual(compiledNodeRoute(candidateNode), afterAssignment.route)
    ) {
      throw new PhaseRoutingCandidateError(
        "identity_mismatch",
        "phase-routing profile does not match the compiled workflow projections",
      );
    }
    setCompiledNodeRoute(candidateNode, beforeAssignment.route);
  }
  refreshChildWorkflowDigests(normalized);
  if (calculateWorkflowDigest(normalized) !== calculateWorkflowDigest(baseline)) {
    throw new PhaseRoutingCandidateError(
      "invalid_projection",
      "phase-routing candidate changes controls outside declared model routes",
    );
  }
}

function refreshChildWorkflowDigests(workflow: CompiledWorkflow): void {
  for (const node of workflow.nodes) {
    if (node.type !== "child") continue;
    refreshChildWorkflowDigests(node.child.workflow);
    (node.child as { workflowDigest: string }).workflowDigest = calculateWorkflowDigest(
      node.child.workflow,
    );
  }
}

function compiledTarget(workflow: CompiledWorkflow, target: PhaseRoutingTarget): CompiledNode {
  if (workflow.id !== target.workflowId) {
    throw new PhaseRoutingCandidateError("invalid_target", "target root workflow does not match");
  }
  let current = workflow;
  for (const childId of target.childPath) {
    const child = current.nodes.find((node) => node.id === childId);
    if (child?.type !== "child") {
      throw new PhaseRoutingCandidateError("invalid_target", "target child path does not exist");
    }
    current = child.child.workflow;
  }
  const node = current.nodes.find((item) => item.id === target.nodeId);
  if (node === undefined || compiledNodeRoute(node) === undefined) {
    throw new PhaseRoutingCandidateError(
      "invalid_target",
      "phase-routing target is not a model-bearing node",
    );
  }
  return node;
}

function sourceNodeRoute(node: WorkflowSource["nodes"][number]): ModelRoute | undefined {
  if (node.type === "agent") return node.agent.model;
  if (
    node.type === "verifier" &&
    (node.verifier.kind === "model" || node.verifier.kind === "packaged-model")
  ) {
    return node.verifier.model;
  }
  return undefined;
}

function compiledNodeRoute(node: CompiledNode): ModelRoute | undefined {
  if (node.type === "agent") return node.agent.model;
  if (
    node.type === "verifier" &&
    (node.verifier.kind === "model" || node.verifier.kind === "packaged-model")
  ) {
    return node.verifier.model;
  }
  return undefined;
}

function setSourceNodeRoute(node: WorkflowSource["nodes"][number], route: ModelRoute): void {
  if (node.type === "agent") {
    node.agent.model = structuredClone(route);
    return;
  }
  if (
    node.type === "verifier" &&
    (node.verifier.kind === "model" || node.verifier.kind === "packaged-model")
  ) {
    node.verifier.model = structuredClone(route);
    return;
  }
  throw new PhaseRoutingCandidateError("invalid_target", "source target is not model-backed");
}

function setCompiledNodeRoute(node: CompiledNode, route: ModelRoute): void {
  if (node.type === "agent") {
    (node.agent as { model: ModelRoute }).model = structuredClone(route);
    return;
  }
  if (
    node.type === "verifier" &&
    (node.verifier.kind === "model" || node.verifier.kind === "packaged-model")
  ) {
    (node.verifier as { model: ModelRoute }).model = structuredClone(route);
    return;
  }
  throw new PhaseRoutingCandidateError("invalid_target", "compiled target is not model-backed");
}

function assertNoUnaddressableCompiledModels(
  compiled: CompiledWorkflow,
  source: WorkflowSource,
  childPath: readonly string[],
): void {
  const directSourceModels = new Set(
    source.nodes.filter((node) => sourceNodeRoute(node) !== undefined).map((node) => node.id),
  );
  const unaddressable = compiled.nodes.find(
    (node) => compiledNodeRoute(node) !== undefined && !directSourceModels.has(node.id),
  );
  if (unaddressable !== undefined) {
    throw new PhaseRoutingCandidateError(
      "invalid_target",
      `phase-routing profile cannot address expanded model node "${[
        ...childPath,
        unaddressable.id,
      ].join("/")}"`,
    );
  }
}

function assignmentMap(
  assignments: readonly PhaseRoutingAssignment[],
): ReadonlyMap<string, PhaseRoutingAssignment> {
  return new Map(
    assignments.map((assignment) => [phaseRoutingTargetKey(assignment.target), assignment]),
  );
}

function refineUniqueTargets(
  assignments: readonly PhaseRoutingAssignment[],
  context: z.RefinementCtx,
): void {
  const keys = assignments.map((assignment) => phaseRoutingTargetKey(assignment.target));
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      path: ["assignments"],
      message: "phase-routing targets must be unique",
    });
  }
}

function refineProfilePair(
  profiles: {
    readonly before: { readonly assignments: readonly PhaseRoutingAssignment[] };
    readonly after: { readonly assignments: readonly PhaseRoutingAssignment[] };
  },
  context: z.RefinementCtx,
): void {
  const before = profiles.before.assignments;
  const after = profiles.after.assignments;
  if (before.length !== after.length) {
    context.addIssue({
      code: "custom",
      path: ["profiles", "after", "assignments"],
      message: "baseline and candidate phase profiles must cover the same targets",
    });
    return;
  }
  let changed = false;
  for (const [index, left] of before.entries()) {
    const right = after[index];
    if (
      right === undefined ||
      phaseRoutingTargetKey(left.target) !== phaseRoutingTargetKey(right.target) ||
      left.phase !== right.phase
    ) {
      context.addIssue({
        code: "custom",
        path: ["profiles", "after", "assignments", index],
        message: "candidate phase profile must preserve ordered targets and roles",
      });
      continue;
    }
    changed ||= !isDeepStrictEqual(left.route, right.route);
  }
  if (!changed) {
    context.addIssue({
      code: "custom",
      path: ["profiles", "after"],
      message: "candidate phase profile must change at least one route",
    });
  }
}

function workflowProjection(
  source: string,
  compiled: CompiledWorkflow,
): PhaseRoutingWorkflowProjection {
  return deepFreeze({
    source,
    sourceSha256: sha256(source),
    compiled,
    workflowDigest: calculateWorkflowDigest(compiled),
  });
}

function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

function renderTarget(target: PhaseRoutingTarget): string {
  return [target.workflowId, ...target.childPath, target.nodeId].join("/");
}

function validateSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new PhaseRoutingCandidateError("identity_mismatch", `${label} digest is invalid`);
  }
}

function isPortableRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function normalizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function boundedIssues(issues: readonly z.core.$ZodIssue[]): string {
  return boundedMessages(
    issues.map(
      (issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`,
    ),
  );
}

function boundedMessages(messages: readonly string[]): string {
  const retained = messages.slice(0, 12).map((message) => boundedText(message, 512));
  return `${retained.join("; ")}${messages.length > retained.length ? "; additional diagnostics omitted" : ""}`;
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
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
  throw new PhaseRoutingCandidateError(
    "invalid_projection",
    "phase-routing identity is not canonical JSON",
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
