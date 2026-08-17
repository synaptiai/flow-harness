import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type ProjectedAgentSkillCandidate,
  parseAgentSkillCandidateIdentity,
} from "../domain/adaptation/agent-skill-candidate.js";
import {
  type ProjectedAgentSkillPackageCandidate,
  parseAgentSkillPackageCandidateIdentity,
} from "../domain/adaptation/agent-skill-package-candidate.js";
import {
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
  type EffectiveHarnessHeadIdentity,
  type EffectiveHarnessState,
  effectiveHarnessWorkflowSource,
  parseEffectiveHarnessState,
} from "../domain/adaptation/effective-harness-state.js";
import {
  type ProjectedPromptCandidate,
  parsePromptCandidateIdentity,
} from "../domain/adaptation/prompt-candidate.js";
import {
  type AdaptiveActivationSnapshot,
  type CapabilityPackageSnapshot,
  calculateCapabilitySnapshotDigest,
  parseAdaptiveActivationSnapshot,
  validateCapabilitySnapshot,
} from "../domain/capability/agent-skills.js";
import { compileWorkflowText } from "../domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../domain/workflow/digest.js";
import type { CompiledWorkflow } from "../domain/workflow/types.js";
import {
  LegacyEffectiveHarnessStateError,
  materializeLegacyEffectiveHarnessState,
} from "./legacy-effective-harness-state.js";

export interface EffectiveHarnessActiveHead {
  readonly workflowId: string;
  readonly generation: number;
  readonly activationDigest: string | null;
  readonly lastTransitionDigest: string;
}

export interface EffectiveHarnessActiveReader {
  loadActive(workflowId: string): Promise<{
    readonly snapshot: unknown;
    readonly head: EffectiveHarnessActiveHead;
  }>;
}

export interface LoadEffectiveHarnessCandidateBaselineInput {
  readonly scopeDigest: string;
  readonly workflowId: string;
  readonly store: EffectiveHarnessActiveReader;
  readonly supplementalPackages?: readonly CapabilityPackageSnapshot[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface EffectiveHarnessCandidateBaseline {
  readonly activation: AdaptiveActivationSnapshot;
  readonly state: EffectiveHarnessState;
  readonly head: EffectiveHarnessHeadIdentity;
}

export type EffectiveHarnessCandidateAdmissionErrorCode =
  | "incomplete_closure"
  | "invalid_baseline"
  | "stale_baseline"
  | "surface_mismatch";

export class EffectiveHarnessCandidateAdmissionError extends Error {
  override readonly name = "EffectiveHarnessCandidateAdmissionError";

  constructor(
    readonly code: EffectiveHarnessCandidateAdmissionErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export async function loadEffectiveHarnessCandidateBaseline(
  input: LoadEffectiveHarnessCandidateBaselineInput,
): Promise<EffectiveHarnessCandidateBaseline> {
  input.signal?.throwIfAborted();
  const loaded = await input.store.loadActive(input.workflowId);
  input.signal?.throwIfAborted();
  const activation = parseActivation(loaded.snapshot);
  assertObservedHead(input.workflowId, activation, loaded.head);
  const state = materializeState(input, activation);
  let head: EffectiveHarnessHeadIdentity;
  try {
    head = createEffectiveHarnessHeadIdentity({
      scopeDigest: input.scopeDigest,
      workflowId: state.workflowId,
      generation: loaded.head.generation,
      activationDigest: activation.activationDigest,
      transitionDigest: loaded.head.lastTransitionDigest,
      stateDigest: state.stateDigest,
    });
  } catch {
    throw new EffectiveHarnessCandidateAdmissionError(
      "invalid_baseline",
      "active harness head identity is invalid",
    );
  }
  return Object.freeze({ activation, state, head });
}

export type EffectiveHarnessCandidateProjection =
  | {
      readonly kind: "prompt";
      readonly projection: ProjectedPromptCandidate;
    }
  | {
      readonly kind: "agent-skill-resource";
      readonly projection: ProjectedAgentSkillCandidate;
    }
  | {
      readonly kind: "agent-skill-package";
      readonly projection: ProjectedAgentSkillPackageCandidate;
    };

export interface ProjectEffectiveHarnessCandidateInput {
  readonly baseline: EffectiveHarnessState;
  readonly candidate: EffectiveHarnessCandidateProjection;
}

export interface EffectiveHarnessSurfaceDelta {
  readonly surface: "prompt" | "agent-skill-resource" | "agent-skill-package";
  readonly candidateKind:
    | "prompt-candidate"
    | "agent-skill-candidate"
    | "agent-skill-package-candidate";
  readonly candidateDigest: string;
  readonly beforeStateDigest: string;
  readonly afterStateDigest: string;
}

export interface ProjectedEffectiveHarnessCandidate {
  readonly state: EffectiveHarnessState;
  readonly delta: EffectiveHarnessSurfaceDelta;
}

export function projectEffectiveHarnessCandidate(
  input: ProjectEffectiveHarnessCandidateInput,
): ProjectedEffectiveHarnessCandidate {
  const baseline = parseBaselineState(input.baseline);
  switch (input.candidate.kind) {
    case "prompt":
      return projectPromptSurface(baseline, input.candidate.projection);
    case "agent-skill-resource":
      return projectAgentSkillResourceSurface(baseline, input.candidate.projection);
    case "agent-skill-package":
      return projectAgentSkillPackageSurface(baseline, input.candidate.projection);
  }
}

function parseActivation(input: unknown): AdaptiveActivationSnapshot {
  try {
    return parseAdaptiveActivationSnapshot(input);
  } catch {
    throw new EffectiveHarnessCandidateAdmissionError(
      "invalid_baseline",
      "active harness activation is invalid",
    );
  }
}

function assertObservedHead(
  workflowId: string,
  activation: AdaptiveActivationSnapshot,
  head: EffectiveHarnessActiveHead,
): void {
  if (
    head.workflowId !== workflowId ||
    activation.workflowId !== workflowId ||
    head.activationDigest === null ||
    head.activationDigest !== activation.activationDigest
  ) {
    throw new EffectiveHarnessCandidateAdmissionError(
      "stale_baseline",
      "active harness head and activation do not match",
    );
  }
}

function materializeState(
  input: LoadEffectiveHarnessCandidateBaselineInput,
  activation: AdaptiveActivationSnapshot,
): EffectiveHarnessState {
  try {
    return materializeLegacyEffectiveHarnessState({
      scopeDigest: input.scopeDigest,
      activation,
      supplementalPackages: input.supplementalPackages ?? [],
    });
  } catch (error) {
    if (error instanceof LegacyEffectiveHarnessStateError && error.code === "incomplete_closure") {
      throw new EffectiveHarnessCandidateAdmissionError(
        "incomplete_closure",
        "active harness state needs a complete immutable package closure",
      );
    }
    throw new EffectiveHarnessCandidateAdmissionError(
      "invalid_baseline",
      "active harness state is invalid",
    );
  }
}

function parseBaselineState(input: EffectiveHarnessState): EffectiveHarnessState {
  try {
    return parseEffectiveHarnessState(input, { scopeDigest: input.scopeDigest });
  } catch {
    throw new EffectiveHarnessCandidateAdmissionError(
      "invalid_baseline",
      "effective harness baseline is invalid",
    );
  }
}

function projectPromptSurface(
  baseline: EffectiveHarnessState,
  rawProjection: ProjectedPromptCandidate,
): ProjectedEffectiveHarnessCandidate {
  try {
    const identity = parsePromptCandidateIdentity(rawProjection.identity);
    const source = rawProjection.workflow.source;
    const sourceSha256 = sha256(source);
    const compiled = compileWorkflowText(source, "effective harness prompt candidate");
    const workflowDigest = calculateWorkflowDigest(compiled);
    if (
      identity.scope.workflowId !== baseline.workflowId ||
      identity.baseline.sourceSha256 !== baseline.workflow.sha256 ||
      identity.baseline.workflowDigest !== baseline.workflow.workflowDigest ||
      identity.projectedWorkflow.sourceSha256 !== sourceSha256 ||
      identity.projectedWorkflow.workflowDigest !== workflowDigest ||
      rawProjection.workflow.sourceSha256 !== sourceSha256 ||
      rawProjection.workflow.workflowDigest !== workflowDigest ||
      calculateWorkflowDigest(rawProjection.workflow.compiled) !== workflowDigest
    ) {
      throw new Error("prompt candidate identity mismatch");
    }
    assertPromptOnlyChange(
      compileWorkflowText(
        effectiveHarnessWorkflowSource(baseline),
        "effective harness prompt baseline",
      ),
      compiled,
      identity.changes,
    );
    const state = createEffectiveHarnessState({
      scopeDigest: baseline.scopeDigest,
      workflowSource: source,
      packages: baseline.packages,
    });
    return freezeProjection({
      state,
      surface: "prompt",
      candidateKind: "prompt-candidate",
      candidateDigest: identity.candidateDigest,
      beforeStateDigest: baseline.stateDigest,
    });
  } catch (error) {
    if (error instanceof EffectiveHarnessCandidateAdmissionError) {
      throw error;
    }
    throw new EffectiveHarnessCandidateAdmissionError(
      "surface_mismatch",
      "prompt candidate changes authority outside its declared surface",
    );
  }
}

function projectAgentSkillResourceSurface(
  baseline: EffectiveHarnessState,
  rawProjection: ProjectedAgentSkillCandidate,
): ProjectedEffectiveHarnessCandidate {
  try {
    const identity = parseAgentSkillCandidateIdentity(rawProjection.identity);
    const source = effectiveHarnessWorkflowSource(baseline);
    const compiled = compileWorkflowText(source, "effective harness Agent Skill baseline");
    const workflowDigest = calculateWorkflowDigest(compiled);
    if (
      identity.scope.workflowId !== baseline.workflowId ||
      identity.baseline.workflow.sourceSha256 !== baseline.workflow.sha256 ||
      identity.baseline.workflow.workflowDigest !== baseline.workflow.workflowDigest ||
      rawProjection.workflow.sourceSha256 !== baseline.workflow.sha256 ||
      rawProjection.workflow.workflowDigest !== workflowDigest ||
      calculateWorkflowDigest(rawProjection.workflow.compiled) !== workflowDigest
    ) {
      throw new Error("Agent Skill candidate workflow mismatch");
    }
    const baselineSnapshot = validateCapabilitySnapshot(rawProjection.baselineCapabilitySnapshot);
    const candidateSnapshot = validateCapabilitySnapshot(rawProjection.candidateCapabilitySnapshot);
    const baselineSkill = requiredSingleSkill(baselineSnapshot.packages);
    const candidateSkill = requiredSingleSkill(candidateSnapshot.packages);
    const selectedBaseline = baseline.packages.find(
      (item) => item.kind === "agent-skill" && item.name === identity.scope.skillName,
    );
    if (
      selectedBaseline?.kind !== "agent-skill" ||
      !isDeepStrictEqual(selectedBaseline, baselineSkill) ||
      identity.baseline.skill.name !== baselineSkill.name ||
      identity.baseline.skill.provenance !== baselineSkill.provenance ||
      identity.baseline.skill.packageDigest !== baselineSkill.digest ||
      identity.baseline.skill.capabilityDigest !==
        calculateCapabilitySnapshotDigest([baselineSkill]) ||
      identity.projectedSkill.packageDigest !== candidateSkill.digest ||
      identity.projectedSkill.capabilityDigest !==
        calculateCapabilitySnapshotDigest([candidateSkill])
    ) {
      throw new Error("Agent Skill candidate package mismatch");
    }
    const packages = baseline.packages.map((item) =>
      item.kind === "agent-skill" && item.name === identity.scope.skillName ? candidateSkill : item,
    );
    const state = createEffectiveHarnessState({
      scopeDigest: baseline.scopeDigest,
      workflowSource: source,
      packages,
    });
    return freezeProjection({
      state,
      surface: "agent-skill-resource",
      candidateKind: "agent-skill-candidate",
      candidateDigest: identity.candidateDigest,
      beforeStateDigest: baseline.stateDigest,
    });
  } catch (error) {
    if (error instanceof EffectiveHarnessCandidateAdmissionError) {
      throw error;
    }
    throw new EffectiveHarnessCandidateAdmissionError(
      "surface_mismatch",
      "Agent Skill candidate changes authority outside its declared surface",
    );
  }
}

function projectAgentSkillPackageSurface(
  baseline: EffectiveHarnessState,
  rawProjection: ProjectedAgentSkillPackageCandidate,
): ProjectedEffectiveHarnessCandidate {
  try {
    const identity = parseAgentSkillPackageCandidateIdentity(rawProjection.identity);
    const source = rawProjection.workflow.source;
    const sourceSha256 = sha256(source);
    const compiled = compileWorkflowText(source, "effective harness Agent Skill package candidate");
    const workflowDigest = calculateWorkflowDigest(compiled);
    if (
      identity.scope.workflowId !== baseline.workflowId ||
      identity.baseline.workflow.sourceSha256 !== baseline.workflow.sha256 ||
      identity.baseline.workflow.workflowDigest !== baseline.workflow.workflowDigest ||
      identity.projectedWorkflow.sourceSha256 !== sourceSha256 ||
      identity.projectedWorkflow.workflowDigest !== workflowDigest ||
      rawProjection.workflow.sourceSha256 !== sourceSha256 ||
      rawProjection.workflow.workflowDigest !== workflowDigest ||
      calculateWorkflowDigest(rawProjection.workflow.compiled) !== workflowDigest ||
      rawProjection.baselineCapabilitySnapshot !== undefined
    ) {
      throw new Error("Agent Skill package candidate workflow mismatch");
    }
    const candidateSnapshot = validateCapabilitySnapshot(rawProjection.candidateCapabilitySnapshot);
    const skill = requiredSingleSkill(candidateSnapshot.packages);
    if (
      identity.package.name !== skill.name ||
      identity.package.provenance !== skill.provenance ||
      identity.package.packageDigest !== skill.digest ||
      identity.package.capabilityDigest !== calculateCapabilitySnapshotDigest([skill]) ||
      baseline.packages.some(
        (item) => item.kind === "agent-skill" && item.name === identity.package.name,
      )
    ) {
      throw new Error("Agent Skill package candidate package mismatch");
    }
    assertAgentSkillPackageOnlyChange(
      compileWorkflowText(
        effectiveHarnessWorkflowSource(baseline),
        "effective harness Agent Skill package baseline",
      ),
      compiled,
      identity.scope.nodeId,
      identity.package.name,
    );
    const state = createEffectiveHarnessState({
      scopeDigest: baseline.scopeDigest,
      workflowSource: source,
      packages: [...baseline.packages, skill],
    });
    return freezeProjection({
      state,
      surface: "agent-skill-package",
      candidateKind: "agent-skill-package-candidate",
      candidateDigest: identity.candidateDigest,
      beforeStateDigest: baseline.stateDigest,
    });
  } catch (error) {
    if (error instanceof EffectiveHarnessCandidateAdmissionError) {
      throw error;
    }
    throw new EffectiveHarnessCandidateAdmissionError(
      "surface_mismatch",
      "Agent Skill package candidate changes authority outside its declared surface",
    );
  }
}

function assertPromptOnlyChange(
  baseline: CompiledWorkflow,
  projected: CompiledWorkflow,
  changes: readonly {
    readonly nodeId: string;
    readonly beforeSha256: string;
    readonly afterSha256: string;
  }[],
): void {
  const normalized = structuredClone(projected);
  for (const change of changes) {
    const before = requiredAgentNode(baseline.nodes, change.nodeId);
    const after = requiredAgentNode(normalized.nodes, change.nodeId);
    if (
      sha256(before.agent.prompt) !== change.beforeSha256 ||
      sha256(after.agent.prompt) !== change.afterSha256
    ) {
      throw new Error("prompt change identity mismatch");
    }
    (after.agent as { prompt: string }).prompt = before.agent.prompt;
  }
  if (!isDeepStrictEqual(normalizeJson(normalized), normalizeJson(baseline))) {
    throw new Error("prompt candidate changed immutable workflow controls");
  }
}

function requiredAgentNode(nodes: CompiledWorkflow["nodes"], nodeId: string) {
  const node = nodes.find((item) => item.id === nodeId);
  if (node?.type !== "agent") {
    throw new Error("prompt target is not an agent node");
  }
  return node;
}

function assertAgentSkillPackageOnlyChange(
  baseline: CompiledWorkflow,
  projected: CompiledWorkflow,
  nodeId: string,
  skillName: string,
): void {
  const normalized = structuredClone(projected);
  const before = requiredAgentNode(baseline.nodes, nodeId);
  const after = requiredAgentNode(normalized.nodes, nodeId);
  if (
    before.agent.skills.length !== 0 ||
    after.agent.skills.length !== 1 ||
    after.agent.skills[0] !== skillName
  ) {
    throw new Error("Agent Skill package selection mismatch");
  }
  (after.agent as unknown as { skills: string[] }).skills = [];
  if (!isDeepStrictEqual(normalizeJson(normalized), normalizeJson(baseline))) {
    throw new Error("Agent Skill package candidate changed immutable workflow controls");
  }
}

function requiredSingleSkill(packages: readonly CapabilityPackageSnapshot[]) {
  const skill = packages[0];
  if (packages.length !== 1 || skill?.kind !== "agent-skill") {
    throw new Error("Agent Skill projection must contain one package");
  }
  return skill;
}

function freezeProjection(input: {
  readonly state: EffectiveHarnessState;
  readonly surface: EffectiveHarnessSurfaceDelta["surface"];
  readonly candidateKind: EffectiveHarnessSurfaceDelta["candidateKind"];
  readonly candidateDigest: string;
  readonly beforeStateDigest: string;
}): ProjectedEffectiveHarnessCandidate {
  if (input.state.stateDigest === input.beforeStateDigest) {
    throw new EffectiveHarnessCandidateAdmissionError(
      "surface_mismatch",
      "effective harness candidate does not change its declared surface",
    );
  }
  return Object.freeze({
    state: input.state,
    delta: Object.freeze({
      surface: input.surface,
      candidateKind: input.candidateKind,
      candidateDigest: input.candidateDigest,
      beforeStateDigest: input.beforeStateDigest,
      afterStateDigest: input.state.stateDigest,
    }),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
