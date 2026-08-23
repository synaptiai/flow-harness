import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import {
  type AgentSkillPackageSnapshot,
  type CapabilityPackageSnapshot,
  calculateCapabilitySnapshotDigest,
} from "../capability/agent-skills.js";
import { parseWorkflowSourceText } from "../workflow/compiler.js";
import type { CompiledWorkflow } from "../workflow/types.js";
import {
  type AgentSkillCandidateIdentity,
  parseAgentSkillCandidateIdentity,
} from "./agent-skill-candidate.js";
import {
  type AgentSkillPackageCandidateIdentity,
  parseAgentSkillPackageCandidateIdentity,
} from "./agent-skill-package-candidate.js";
import {
  type ChildSpecialistCandidateIdentity,
  parseChildSpecialistCandidateIdentity,
} from "./child-specialist-candidate.js";
import {
  compileEffectiveHarnessState,
  type EffectiveHarnessHeadIdentity,
  type EffectiveHarnessState,
  effectiveHarnessWorkflowSource,
  parseEffectiveHarnessHeadIdentity,
  parseEffectiveHarnessState,
} from "./effective-harness-state.js";
import {
  type ModelRoutingCandidateIdentity,
  parseModelRoutingCandidateIdentity,
} from "./model-routing-candidate.js";
import {
  applyPhaseRoutingProfile,
  type PhaseRoutingCandidateIdentity,
  parsePhaseRoutingCandidateIdentity,
} from "./phase-routing-candidate.js";
import { type PromptCandidateIdentity, parsePromptCandidateIdentity } from "./prompt-candidate.js";
import {
  assertSupplementalMemoryCandidateSurface,
  parseSupplementalMemoryCandidateIdentity,
  type SupplementalMemoryCandidateIdentity,
} from "./supplemental-memory-candidate.js";

export const MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES = 40 * 1024 * 1024;
const CANDIDATE_DIGEST_DOMAIN = "flow-effective-harness-candidate-v1";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

const artifactSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("effective-harness-candidate"),
    scopeDigest: sha256Schema,
    workflowId: identifierSchema,
    surface: z.enum([
      "prompt",
      "agent-skill-resource",
      "agent-skill-package",
      "model-routing",
      "phase-routing",
      "child-specialist",
      "supplemental-memory",
    ]),
    candidate: z.unknown(),
    baselineHead: z.unknown(),
    baselineState: z.unknown(),
    candidateState: z.unknown(),
    artifactDigest: sha256Schema,
  })
  .strict();

export type EffectiveHarnessCandidateIdentity =
  | PromptCandidateIdentity
  | AgentSkillCandidateIdentity
  | AgentSkillPackageCandidateIdentity
  | ModelRoutingCandidateIdentity
  | PhaseRoutingCandidateIdentity
  | ChildSpecialistCandidateIdentity
  | SupplementalMemoryCandidateIdentity;

export type EffectiveHarnessCandidateSurface =
  | "prompt"
  | "agent-skill-resource"
  | "agent-skill-package"
  | "model-routing"
  | "phase-routing"
  | "child-specialist"
  | "supplemental-memory";

export interface EffectiveHarnessCandidateArtifact {
  readonly version: 1;
  readonly kind: "effective-harness-candidate";
  readonly scopeDigest: string;
  readonly workflowId: string;
  readonly surface: EffectiveHarnessCandidateSurface;
  readonly candidate: EffectiveHarnessCandidateIdentity;
  readonly baselineHead: EffectiveHarnessHeadIdentity;
  readonly baselineState: EffectiveHarnessState;
  readonly candidateState: EffectiveHarnessState;
  readonly artifactDigest: string;
}

export interface CreateEffectiveHarnessCandidateArtifactInput {
  readonly baselineHead: EffectiveHarnessHeadIdentity;
  readonly baselineState: EffectiveHarnessState;
  readonly candidateState: EffectiveHarnessState;
  readonly candidate: EffectiveHarnessCandidateIdentity;
}

export type EffectiveHarnessCandidateErrorCode =
  | "identity_mismatch"
  | "invalid_schema"
  | "limit_exceeded"
  | "scope_mismatch"
  | "surface_mismatch";

export class EffectiveHarnessCandidateError extends Error {
  override readonly name = "EffectiveHarnessCandidateError";

  constructor(
    readonly code: EffectiveHarnessCandidateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function createEffectiveHarnessCandidateArtifact(
  input: CreateEffectiveHarnessCandidateArtifactInput,
): EffectiveHarnessCandidateArtifact {
  const surface = candidateSurface(input.candidate);
  const content = {
    version: 1 as const,
    kind: "effective-harness-candidate" as const,
    scopeDigest: input.baselineState.scopeDigest,
    workflowId: input.baselineState.workflowId,
    surface,
    candidate: input.candidate,
    baselineHead: input.baselineHead,
    baselineState: input.baselineState,
    candidateState: input.candidateState,
  };
  return parseEffectiveHarnessCandidateArtifact({
    ...content,
    artifactDigest: calculateEffectiveHarnessCandidateDigest(content),
  });
}

export function parseEffectiveHarnessCandidateArtifact(
  input: unknown,
  expected: { readonly scopeDigest?: string | undefined } = {},
): EffectiveHarnessCandidateArtifact {
  const parsed = artifactSchema.safeParse(input);
  if (!parsed.success) {
    throw new EffectiveHarnessCandidateError(
      "invalid_schema",
      "effective harness candidate is invalid",
    );
  }
  assertSerializedBound(parsed.data);
  if (expected.scopeDigest !== undefined && parsed.data.scopeDigest !== expected.scopeDigest) {
    throw new EffectiveHarnessCandidateError(
      "scope_mismatch",
      "effective harness candidate belongs to a different scope",
    );
  }
  const baselineState = parseState(parsed.data.baselineState, parsed.data.scopeDigest);
  const candidateState = parseState(parsed.data.candidateState, parsed.data.scopeDigest);
  const baselineHead = parseHead(parsed.data.baselineHead, parsed.data.scopeDigest);
  const candidate = parseCandidate(parsed.data.candidate);
  const surface = candidateSurface(candidate);
  if (
    parsed.data.workflowId !== baselineState.workflowId ||
    candidateState.workflowId !== baselineState.workflowId ||
    candidateWorkflowId(candidate) !== baselineState.workflowId ||
    baselineHead.workflowId !== baselineState.workflowId ||
    baselineHead.stateDigest !== baselineState.stateDigest ||
    parsed.data.surface !== surface
  ) {
    throw new EffectiveHarnessCandidateError(
      "identity_mismatch",
      "effective harness candidate identities do not match",
    );
  }
  assertSurfaceChange(surface, candidate, baselineState, candidateState);
  const artifact: EffectiveHarnessCandidateArtifact = {
    version: parsed.data.version,
    kind: parsed.data.kind,
    scopeDigest: parsed.data.scopeDigest,
    workflowId: parsed.data.workflowId,
    surface,
    candidate,
    baselineHead,
    baselineState,
    candidateState,
    artifactDigest: parsed.data.artifactDigest,
  };
  if (calculateEffectiveHarnessCandidateDigest(artifact) !== artifact.artifactDigest) {
    throw new EffectiveHarnessCandidateError(
      "identity_mismatch",
      "effective harness candidate digest does not match",
    );
  }
  return deepFreeze(artifact);
}

export function calculateEffectiveHarnessCandidateDigest(
  artifact:
    | Omit<EffectiveHarnessCandidateArtifact, "artifactDigest">
    | EffectiveHarnessCandidateArtifact,
): string {
  return sha256(
    canonicalize({
      domain: CANDIDATE_DIGEST_DOMAIN,
      version: artifact.version,
      kind: artifact.kind,
      scopeDigest: artifact.scopeDigest,
      workflowId: artifact.workflowId,
      surface: artifact.surface,
      candidate: candidateDigestIdentity(artifact.candidate),
      baselineHeadDigest: artifact.baselineHead.headDigest,
      baselineStateDigest: artifact.baselineState.stateDigest,
      candidateStateDigest: artifact.candidateState.stateDigest,
    }),
  );
}

export function encodeEffectiveHarnessCandidateArtifact(
  input: EffectiveHarnessCandidateArtifact,
): Buffer {
  const artifact = parseEffectiveHarnessCandidateArtifact(input);
  const content = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
  if (content.byteLength > MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES) {
    throw new EffectiveHarnessCandidateError(
      "limit_exceeded",
      "effective harness candidate exceeds its byte limit",
    );
  }
  return content;
}

function parseState(input: unknown, scopeDigest: string): EffectiveHarnessState {
  try {
    return parseEffectiveHarnessState(input, { scopeDigest });
  } catch {
    throw new EffectiveHarnessCandidateError(
      "identity_mismatch",
      "effective harness candidate state is invalid",
    );
  }
}

function parseHead(input: unknown, scopeDigest: string): EffectiveHarnessHeadIdentity {
  try {
    return parseEffectiveHarnessHeadIdentity(input, { scopeDigest });
  } catch {
    throw new EffectiveHarnessCandidateError(
      "identity_mismatch",
      "effective harness candidate head is invalid",
    );
  }
}

function parseCandidate(input: unknown): EffectiveHarnessCandidateIdentity {
  if (isObjectWithKind(input, "phase-routing-candidate")) {
    try {
      return parsePhaseRoutingCandidateIdentity(input);
    } catch {
      throw invalidCandidateIdentity();
    }
  }
  if (isObjectWithKind(input, "model-routing-candidate")) {
    try {
      return parseModelRoutingCandidateIdentity(input);
    } catch {
      throw invalidCandidateIdentity();
    }
  }
  if (isObjectWithKind(input, "agent-skill-candidate")) {
    try {
      return parseAgentSkillCandidateIdentity(input);
    } catch {
      throw invalidCandidateIdentity();
    }
  }
  if (isObjectWithKind(input, "agent-skill-package-candidate")) {
    try {
      return parseAgentSkillPackageCandidateIdentity(input);
    } catch {
      throw invalidCandidateIdentity();
    }
  }
  if (isObjectWithKind(input, "child-specialist-candidate")) {
    try {
      return parseChildSpecialistCandidateIdentity(input);
    } catch {
      throw invalidCandidateIdentity();
    }
  }
  if (isObjectWithKind(input, "supplemental-memory-candidate")) {
    try {
      return parseSupplementalMemoryCandidateIdentity(input);
    } catch {
      throw invalidCandidateIdentity();
    }
  }
  try {
    return parsePromptCandidateIdentity(input);
  } catch {
    throw invalidCandidateIdentity();
  }
}

function invalidCandidateIdentity(): EffectiveHarnessCandidateError {
  return new EffectiveHarnessCandidateError(
    "identity_mismatch",
    "effective harness reviewed candidate identity is invalid",
  );
}

function assertSurfaceChange(
  surface: EffectiveHarnessCandidateSurface,
  candidate: EffectiveHarnessCandidateIdentity,
  baseline: EffectiveHarnessState,
  projected: EffectiveHarnessState,
): void {
  try {
    if (
      surface !== "phase-routing" &&
      baseline.phaseRoutingProfile?.profileDigest !== projected.phaseRoutingProfile?.profileDigest
    ) {
      throw new Error("unrelated phase-routing profile changed");
    }
    if (surface === "prompt" && isPromptCandidate(candidate)) {
      assertPromptChange(candidate, baseline, projected);
      return;
    }
    if (surface === "agent-skill-resource" && isAgentSkillCandidate(candidate)) {
      assertAgentSkillResourceChange(candidate, baseline, projected);
      return;
    }
    if (surface === "agent-skill-package" && isAgentSkillPackageCandidate(candidate)) {
      assertAgentSkillPackageChange(candidate, baseline, projected);
      return;
    }
    if (surface === "model-routing" && isModelRoutingCandidate(candidate)) {
      assertModelRoutingChange(candidate, baseline, projected);
      return;
    }
    if (surface === "phase-routing" && isPhaseRoutingCandidate(candidate)) {
      assertPhaseRoutingChange(candidate, baseline, projected);
      return;
    }
    if (surface === "child-specialist" && isChildSpecialistCandidate(candidate)) {
      assertChildSpecialistChange(candidate, baseline, projected);
      return;
    }
    if (surface === "supplemental-memory" && isSupplementalMemoryCandidate(candidate)) {
      assertSupplementalMemoryCandidateSurface(candidate, baseline, projected);
      return;
    }
  } catch {
    throw new EffectiveHarnessCandidateError(
      "surface_mismatch",
      "effective harness candidate changes authority outside its declared surface",
    );
  }
  throw new EffectiveHarnessCandidateError(
    "surface_mismatch",
    "effective harness candidate surface is inconsistent",
  );
}

function assertPhaseRoutingChange(
  candidate: PhaseRoutingCandidateIdentity,
  baseline: EffectiveHarnessState,
  projected: EffectiveHarnessState,
): void {
  if (
    !isDeepStrictEqual(normalizeJson(baseline.packages), normalizeJson(projected.packages)) ||
    baseline.phaseRoutingProfile?.profileDigest !==
      (baseline.phaseRoutingProfile === undefined
        ? undefined
        : candidate.profiles.before.profileDigest) ||
    projected.phaseRoutingProfile?.profileDigest !== candidate.profiles.after.profileDigest
  ) {
    throw new Error("phase-routing state identity mismatch");
  }
  const before = compileStateWorkflow(baseline);
  const applied = applyPhaseRoutingProfile({
    workflowId: baseline.workflowId,
    source: parseWorkflowSourceText(
      effectiveHarnessWorkflowSource(baseline),
      "effective harness phase-routing artifact baseline",
    ),
    compiled: before,
    before: candidate.profiles.before,
    after: candidate.profiles.after,
    sourceName: "effective harness phase-routing artifact candidate",
  });
  if (
    applied.workflowDigest !== projected.workflow.workflowDigest ||
    sha256(applied.source) !== projected.workflow.sha256
  ) {
    throw new Error("phase-routing workflow projection mismatch");
  }
}

function assertPromptChange(
  candidate: PromptCandidateIdentity,
  baseline: EffectiveHarnessState,
  projected: EffectiveHarnessState,
): void {
  if (!isDeepStrictEqual(normalizeJson(baseline.packages), normalizeJson(projected.packages))) {
    throw new Error("prompt state identity mismatch");
  }
  const before = compileStateWorkflow(baseline);
  const after = compileStateWorkflow(projected);
  const normalized = structuredClone(after);
  for (const change of candidate.changes) {
    const beforeNode = requiredAgentNode(before, change.nodeId);
    const afterNode = requiredAgentNode(normalized, change.nodeId);
    if (
      sha256(beforeNode.agent.prompt) !== change.beforeSha256 ||
      sha256(afterNode.agent.prompt) !== change.afterSha256
    ) {
      throw new Error("prompt change identity mismatch");
    }
    (afterNode.agent as { prompt: string }).prompt = beforeNode.agent.prompt;
  }
  assertNormalizedWorkflow(normalized, before);
}

function assertAgentSkillResourceChange(
  candidate: AgentSkillCandidateIdentity,
  baseline: EffectiveHarnessState,
  projected: EffectiveHarnessState,
): void {
  if (
    baseline.workflow.sha256 !== projected.workflow.sha256 ||
    baseline.workflow.workflowDigest !== projected.workflow.workflowDigest
  ) {
    throw new Error("Agent Skill workflow identity mismatch");
  }
  const before = requiredSkill(baseline.packages, candidate.scope.skillName);
  const after = requiredSkill(projected.packages, candidate.scope.skillName);
  if (
    candidate.baseline.skill.packageDigest !== before.digest ||
    candidate.baseline.skill.provenance !== before.provenance ||
    candidate.baseline.skill.capabilityDigest !== calculateCapabilitySnapshotDigest([before]) ||
    candidate.projectedSkill.packageDigest !== after.digest ||
    candidate.projectedSkill.capabilityDigest !== calculateCapabilitySnapshotDigest([after])
  ) {
    throw new Error("Agent Skill package identity mismatch");
  }
  assertOtherPackagesEqual(baseline.packages, projected.packages, candidate.scope.skillName);
}

function assertAgentSkillPackageChange(
  candidate: AgentSkillPackageCandidateIdentity,
  baseline: EffectiveHarnessState,
  projected: EffectiveHarnessState,
): void {
  if (
    baseline.packages.some(
      (item) => item.kind === "agent-skill" && item.name === candidate.package.name,
    )
  ) {
    throw new Error("Agent Skill package state identity mismatch");
  }
  const added = requiredSkill(projected.packages, candidate.package.name);
  if (
    candidate.package.packageDigest !== added.digest ||
    candidate.package.provenance !== added.provenance ||
    candidate.package.capabilityDigest !== calculateCapabilitySnapshotDigest([added])
  ) {
    throw new Error("generated Agent Skill package identity mismatch");
  }
  assertOtherPackagesEqual(baseline.packages, projected.packages, candidate.package.name);
  const before = compileStateWorkflow(baseline);
  const after = compileStateWorkflow(projected);
  const normalized = structuredClone(after);
  const beforeNode = requiredAgentNode(before, candidate.scope.nodeId);
  const afterNode = requiredAgentNode(normalized, candidate.scope.nodeId);
  if (
    beforeNode.agent.skills.length !== 0 ||
    afterNode.agent.skills.length !== 1 ||
    afterNode.agent.skills[0] !== candidate.package.name
  ) {
    throw new Error("generated Agent Skill selection mismatch");
  }
  (afterNode.agent as unknown as { skills: string[] }).skills = [];
  assertNormalizedWorkflow(normalized, before);
}

function assertModelRoutingChange(
  candidate: ModelRoutingCandidateIdentity,
  baseline: EffectiveHarnessState,
  projected: EffectiveHarnessState,
): void {
  if (!isDeepStrictEqual(normalizeJson(baseline.packages), normalizeJson(projected.packages))) {
    throw new Error("model-routing package state changed");
  }
  const before = compileStateWorkflow(baseline);
  const after = compileStateWorkflow(projected);
  const normalized = structuredClone(after);
  const beforeNode = requiredAgentNode(before, candidate.scope.nodeId);
  const afterNode = requiredAgentNode(normalized, candidate.scope.nodeId);
  if (
    !isDeepStrictEqual(beforeNode.agent.model, candidate.route.before) ||
    !isDeepStrictEqual(afterNode.agent.model, candidate.route.after)
  ) {
    throw new Error("model-routing state identity mismatch");
  }
  (afterNode.agent as { model: typeof beforeNode.agent.model }).model = structuredClone(
    beforeNode.agent.model,
  );
  assertNormalizedWorkflow(normalized, before);
}

function assertChildSpecialistChange(
  candidate: ChildSpecialistCandidateIdentity,
  baseline: EffectiveHarnessState,
  projected: EffectiveHarnessState,
): void {
  if (!isDeepStrictEqual(normalizeJson(baseline.packages), normalizeJson(projected.packages))) {
    throw new Error("child-specialist package state changed");
  }
  const before = compileStateWorkflow(baseline);
  const after = compileStateWorkflow(projected);
  const normalized = structuredClone(after);
  const beforeChild = requiredChildNode(before, candidate.scope.childNodeId);
  const afterChild = requiredChildNode(normalized, candidate.scope.childNodeId);
  const baselineSource = parseWorkflowSourceText(
    effectiveHarnessWorkflowSource(baseline),
    "effective harness child-specialist baseline",
  );
  const beforeSourceChild = baselineSource.nodes.find(
    (node) => node.id === candidate.scope.childNodeId,
  );
  if (beforeSourceChild?.type !== "child" || !("workflow" in beforeSourceChild.child)) {
    throw new Error("child-specialist baseline has no exact embedded child source");
  }
  if (
    candidate.baseline.workflow.sourceSha256 !== baseline.workflow.sha256 ||
    candidate.baseline.workflow.workflowDigest !== baseline.workflow.workflowDigest ||
    candidate.baseline.child.sourceSha256 !== sha256(beforeSourceChild.child.workflow) ||
    candidate.baseline.child.workflowDigest !== beforeChild.child.workflowDigest ||
    candidate.baseline.packageClosureDigest !==
      calculateCapabilitySnapshotDigest(baseline.packages) ||
    candidate.projectedWorkflow.sourceSha256 !== projected.workflow.sha256 ||
    candidate.projectedWorkflow.workflowDigest !== projected.workflow.workflowDigest
  ) {
    throw new Error("child-specialist workflow identity mismatch");
  }
  const beforeAgent = requiredAgentNode(beforeChild.child.workflow, candidate.scope.agentNodeId);
  const afterAgent = requiredAgentNode(afterChild.child.workflow, candidate.scope.agentNodeId);
  if (candidate.change.kind === "instructions") {
    if (
      Buffer.byteLength(beforeAgent.agent.prompt, "utf8") !== candidate.change.before.bytes ||
      sha256(beforeAgent.agent.prompt) !== candidate.change.before.sha256 ||
      Buffer.byteLength(afterAgent.agent.prompt, "utf8") !== candidate.change.after.bytes ||
      sha256(afterAgent.agent.prompt) !== candidate.change.after.sha256
    ) {
      throw new Error("child-specialist instructions identity mismatch");
    }
    (afterAgent.agent as { prompt: string }).prompt = beforeAgent.agent.prompt;
  } else {
    if (
      !isDeepStrictEqual(beforeAgent.agent.skills, candidate.change.before) ||
      !isDeepStrictEqual(afterAgent.agent.skills, candidate.change.after)
    ) {
      throw new Error("child-specialist Agent Skill identity mismatch");
    }
    (afterAgent.agent as { skills: readonly string[] }).skills = [...beforeAgent.agent.skills];
  }
  (afterChild.child as { workflowDigest: string }).workflowDigest =
    beforeChild.child.workflowDigest;
  assertNormalizedWorkflow(normalized, before);
}

function assertOtherPackagesEqual(
  baseline: readonly CapabilityPackageSnapshot[],
  projected: readonly CapabilityPackageSnapshot[],
  changedSkillName: string,
): void {
  const before = baseline.filter(
    (item) => !(item.kind === "agent-skill" && item.name === changedSkillName),
  );
  const after = projected.filter(
    (item) => !(item.kind === "agent-skill" && item.name === changedSkillName),
  );
  if (!isDeepStrictEqual(normalizeJson(before), normalizeJson(after))) {
    throw new Error("unrelated package closure changed");
  }
}

function requiredSkill(
  packages: readonly CapabilityPackageSnapshot[],
  name: string,
): AgentSkillPackageSnapshot {
  const selected = packages.filter((item) => item.kind === "agent-skill" && item.name === name);
  if (selected.length !== 1 || selected[0]?.kind !== "agent-skill") {
    throw new Error("effective harness state has no exact selected skill");
  }
  return selected[0];
}

function compileStateWorkflow(state: EffectiveHarnessState): CompiledWorkflow {
  return compileEffectiveHarnessState(state);
}

function requiredAgentNode(workflow: CompiledWorkflow, nodeId: string) {
  const node = workflow.nodes.find((item) => item.id === nodeId);
  if (node?.type !== "agent") {
    throw new Error("candidate target is not an agent node");
  }
  return node;
}

function requiredChildNode(workflow: CompiledWorkflow, nodeId: string) {
  const node = workflow.nodes.find((item) => item.id === nodeId);
  if (node?.type !== "child") {
    throw new Error("effective harness state has no exact selected child");
  }
  return node;
}

function assertNormalizedWorkflow(projected: CompiledWorkflow, baseline: CompiledWorkflow): void {
  if (!isDeepStrictEqual(normalizeJson(projected), normalizeJson(baseline))) {
    throw new Error("candidate changed immutable workflow authority");
  }
}

function candidateSurface(
  candidate: EffectiveHarnessCandidateIdentity,
): EffectiveHarnessCandidateSurface {
  return isAgentSkillCandidate(candidate)
    ? "agent-skill-resource"
    : isAgentSkillPackageCandidate(candidate)
      ? "agent-skill-package"
      : isModelRoutingCandidate(candidate)
        ? "model-routing"
        : isPhaseRoutingCandidate(candidate)
          ? "phase-routing"
          : isChildSpecialistCandidate(candidate)
            ? "child-specialist"
            : isSupplementalMemoryCandidate(candidate)
              ? "supplemental-memory"
              : "prompt";
}

function candidateWorkflowId(candidate: EffectiveHarnessCandidateIdentity): string {
  return candidate.scope.workflowId;
}

function candidateDigestIdentity(candidate: EffectiveHarnessCandidateIdentity) {
  return {
    kind: isPromptCandidate(candidate) ? "prompt-candidate" : candidate.kind,
    candidateDigest: candidate.candidateDigest,
  };
}

function isPromptCandidate(
  candidate: EffectiveHarnessCandidateIdentity,
): candidate is PromptCandidateIdentity {
  return !("kind" in candidate);
}

function isAgentSkillCandidate(
  candidate: EffectiveHarnessCandidateIdentity,
): candidate is AgentSkillCandidateIdentity {
  return "kind" in candidate && candidate.kind === "agent-skill-candidate";
}

function isAgentSkillPackageCandidate(
  candidate: EffectiveHarnessCandidateIdentity,
): candidate is AgentSkillPackageCandidateIdentity {
  return "kind" in candidate && candidate.kind === "agent-skill-package-candidate";
}

function isModelRoutingCandidate(
  candidate: EffectiveHarnessCandidateIdentity,
): candidate is ModelRoutingCandidateIdentity {
  return "kind" in candidate && candidate.kind === "model-routing-candidate";
}

function isPhaseRoutingCandidate(
  candidate: EffectiveHarnessCandidateIdentity,
): candidate is PhaseRoutingCandidateIdentity {
  return "kind" in candidate && candidate.kind === "phase-routing-candidate";
}

function isChildSpecialistCandidate(
  candidate: EffectiveHarnessCandidateIdentity,
): candidate is ChildSpecialistCandidateIdentity {
  return "kind" in candidate && candidate.kind === "child-specialist-candidate";
}

function isSupplementalMemoryCandidate(
  candidate: EffectiveHarnessCandidateIdentity,
): candidate is SupplementalMemoryCandidateIdentity {
  return "kind" in candidate && candidate.kind === "supplemental-memory-candidate";
}

function isObjectWithKind(input: unknown, kind: string): boolean {
  return typeof input === "object" && input !== null && "kind" in input && input.kind === kind;
}

function assertSerializedBound(input: unknown): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  } catch {
    throw new EffectiveHarnessCandidateError(
      "invalid_schema",
      "effective harness candidate is not serializable",
    );
  }
  if (bytes > MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES) {
    throw new EffectiveHarnessCandidateError(
      "limit_exceeded",
      "effective harness candidate exceeds its byte limit",
    );
  }
}

function normalizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new EffectiveHarnessCandidateError(
    "invalid_schema",
    "effective harness candidate identity is not canonical JSON",
  );
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
