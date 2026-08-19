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
  type ProjectedModelRoutingCandidate,
  parseModelRoutingCandidateIdentity,
} from "../domain/adaptation/model-routing-candidate.js";
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
import { compileWorkflowText, parseWorkflowSourceText } from "../domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../domain/workflow/digest.js";
import type { WorkflowSource } from "../domain/workflow/schema.js";
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
      readonly baselineWorkflowSource: string;
    }
  | {
      readonly kind: "agent-skill-resource";
      readonly projection: ProjectedAgentSkillCandidate;
      readonly baselineWorkflowSource: string;
    }
  | {
      readonly kind: "agent-skill-package";
      readonly projection: ProjectedAgentSkillPackageCandidate;
      readonly baselineWorkflowSource: string;
    }
  | {
      readonly kind: "model-routing";
      readonly projection: ProjectedModelRoutingCandidate;
      readonly baselineWorkflowSource: string;
    };

export interface ProjectEffectiveHarnessCandidateInput {
  readonly baseline: EffectiveHarnessState;
  readonly candidate: EffectiveHarnessCandidateProjection;
}

export interface EffectiveHarnessSurfaceDelta {
  readonly surface: "prompt" | "agent-skill-resource" | "agent-skill-package" | "model-routing";
  readonly candidateKind:
    | "prompt-candidate"
    | "agent-skill-candidate"
    | "agent-skill-package-candidate"
    | "model-routing-candidate";
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
      return projectPromptSurface(
        baseline,
        input.candidate.projection,
        input.candidate.baselineWorkflowSource,
      );
    case "agent-skill-resource":
      return projectAgentSkillResourceSurface(
        baseline,
        input.candidate.projection,
        input.candidate.baselineWorkflowSource,
      );
    case "agent-skill-package":
      return projectAgentSkillPackageSurface(
        baseline,
        input.candidate.projection,
        input.candidate.baselineWorkflowSource,
      );
    case "model-routing":
      return projectModelRoutingSurface(
        baseline,
        input.candidate.projection,
        input.candidate.baselineWorkflowSource,
      );
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
  baselineWorkflowSource: string,
): ProjectedEffectiveHarnessCandidate {
  try {
    const identity = parsePromptCandidateIdentity(rawProjection.identity);
    const ordinaryBaseline = compileWorkflowText(
      baselineWorkflowSource,
      "ordinary prompt candidate baseline",
    );
    const ordinaryBaselineSha256 = sha256(baselineWorkflowSource);
    const ordinaryBaselineDigest = calculateWorkflowDigest(ordinaryBaseline);
    const projectedSource = rawProjection.workflow.source;
    const projectedSourceSha256 = sha256(projectedSource);
    const projected = compileWorkflowText(projectedSource, "effective harness prompt candidate");
    const projectedDigest = calculateWorkflowDigest(projected);
    if (
      identity.scope.workflowId !== baseline.workflowId ||
      ordinaryBaseline.id !== identity.scope.workflowId ||
      identity.baseline.sourceSha256 !== ordinaryBaselineSha256 ||
      identity.baseline.workflowDigest !== ordinaryBaselineDigest ||
      identity.projectedWorkflow.sourceSha256 !== projectedSourceSha256 ||
      identity.projectedWorkflow.workflowDigest !== projectedDigest ||
      rawProjection.workflow.sourceSha256 !== projectedSourceSha256 ||
      rawProjection.workflow.workflowDigest !== projectedDigest ||
      calculateWorkflowDigest(rawProjection.workflow.compiled) !== projectedDigest
    ) {
      throw new Error("prompt candidate identity mismatch");
    }
    assertPromptOnlyChange(ordinaryBaseline, projected, identity.changes);
    const source = rebasePromptChanges(
      effectiveHarnessWorkflowSource(baseline),
      projectedSource,
      identity.changes,
    );
    const state = createEffectiveHarnessState({
      scopeDigest: baseline.scopeDigest,
      workflowSource: source,
      ...(baseline.rootPackage === undefined ? {} : { rootPackage: baseline.rootPackage }),
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
  baselineWorkflowSource: string,
): ProjectedEffectiveHarnessCandidate {
  try {
    const identity = parseAgentSkillCandidateIdentity(rawProjection.identity);
    const source = effectiveHarnessWorkflowSource(baseline);
    const ordinaryBaseline = compileWorkflowText(
      baselineWorkflowSource,
      "ordinary Agent Skill candidate baseline",
    );
    const ordinaryBaselineSha256 = sha256(baselineWorkflowSource);
    const ordinaryBaselineDigest = calculateWorkflowDigest(ordinaryBaseline);
    if (
      identity.scope.workflowId !== baseline.workflowId ||
      ordinaryBaseline.id !== identity.scope.workflowId ||
      identity.baseline.workflow.sourceSha256 !== ordinaryBaselineSha256 ||
      identity.baseline.workflow.workflowDigest !== ordinaryBaselineDigest ||
      rawProjection.workflow.sourceSha256 !== ordinaryBaselineSha256 ||
      rawProjection.workflow.workflowDigest !== ordinaryBaselineDigest ||
      calculateWorkflowDigest(rawProjection.workflow.compiled) !== ordinaryBaselineDigest
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
      ...(baseline.rootPackage === undefined ? {} : { rootPackage: baseline.rootPackage }),
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
  baselineWorkflowSource: string,
): ProjectedEffectiveHarnessCandidate {
  try {
    const identity = parseAgentSkillPackageCandidateIdentity(rawProjection.identity);
    const ordinaryBaseline = compileWorkflowText(
      baselineWorkflowSource,
      "ordinary Agent Skill package candidate baseline",
    );
    const ordinaryBaselineSha256 = sha256(baselineWorkflowSource);
    const ordinaryBaselineDigest = calculateWorkflowDigest(ordinaryBaseline);
    const projectedSource = rawProjection.workflow.source;
    const projectedSourceSha256 = sha256(projectedSource);
    const projected = compileWorkflowText(
      projectedSource,
      "effective harness Agent Skill package candidate",
    );
    const projectedDigest = calculateWorkflowDigest(projected);
    if (
      identity.scope.workflowId !== baseline.workflowId ||
      ordinaryBaseline.id !== identity.scope.workflowId ||
      identity.baseline.workflow.sourceSha256 !== ordinaryBaselineSha256 ||
      identity.baseline.workflow.workflowDigest !== ordinaryBaselineDigest ||
      identity.projectedWorkflow.sourceSha256 !== projectedSourceSha256 ||
      identity.projectedWorkflow.workflowDigest !== projectedDigest ||
      rawProjection.workflow.sourceSha256 !== projectedSourceSha256 ||
      rawProjection.workflow.workflowDigest !== projectedDigest ||
      calculateWorkflowDigest(rawProjection.workflow.compiled) !== projectedDigest ||
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
      ordinaryBaseline,
      projected,
      identity.scope.nodeId,
      identity.package.name,
    );
    const source = rebaseAgentSkillPackageSelection(
      effectiveHarnessWorkflowSource(baseline),
      baselineWorkflowSource,
      identity.scope.nodeId,
      identity.package.name,
    );
    const state = createEffectiveHarnessState({
      scopeDigest: baseline.scopeDigest,
      workflowSource: source,
      ...(baseline.rootPackage === undefined ? {} : { rootPackage: baseline.rootPackage }),
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

function projectModelRoutingSurface(
  baseline: EffectiveHarnessState,
  rawProjection: ProjectedModelRoutingCandidate,
  baselineWorkflowSource: string,
): ProjectedEffectiveHarnessCandidate {
  try {
    const identity = parseModelRoutingCandidateIdentity(rawProjection.identity);
    const ordinaryBaseline = compileWorkflowText(
      baselineWorkflowSource,
      "ordinary model-routing candidate baseline",
    );
    const ordinaryBaselineSha256 = sha256(baselineWorkflowSource);
    const ordinaryBaselineDigest = calculateWorkflowDigest(ordinaryBaseline);
    const projectedSourceSha256 = sha256(rawProjection.workflow.source);
    const projected = compileWorkflowText(
      rawProjection.workflow.source,
      "effective harness model-routing candidate",
    );
    const projectedDigest = calculateWorkflowDigest(projected);
    if (
      identity.scope.workflowId !== baseline.workflowId ||
      ordinaryBaseline.id !== identity.scope.workflowId ||
      identity.baseline.workflow.sourceSha256 !== ordinaryBaselineSha256 ||
      identity.baseline.workflow.workflowDigest !== ordinaryBaselineDigest ||
      identity.projectedWorkflow.sourceSha256 !== projectedSourceSha256 ||
      identity.projectedWorkflow.workflowDigest !== projectedDigest ||
      rawProjection.workflow.sourceSha256 !== projectedSourceSha256 ||
      rawProjection.workflow.workflowDigest !== projectedDigest ||
      calculateWorkflowDigest(rawProjection.workflow.compiled) !== projectedDigest
    ) {
      throw new Error("model-routing candidate workflow mismatch");
    }
    assertModelRoutingOnlyChange(
      ordinaryBaseline,
      projected,
      identity.scope.nodeId,
      identity.route.before,
      identity.route.after,
    );
    const source = rebaseModelRoute(
      effectiveHarnessWorkflowSource(baseline),
      baselineWorkflowSource,
      identity,
    );
    const state = createEffectiveHarnessState({
      scopeDigest: baseline.scopeDigest,
      workflowSource: source,
      ...(baseline.rootPackage === undefined ? {} : { rootPackage: baseline.rootPackage }),
      packages: baseline.packages,
    });
    return freezeProjection({
      state,
      surface: "model-routing",
      candidateKind: "model-routing-candidate",
      candidateDigest: identity.candidateDigest,
      beforeStateDigest: baseline.stateDigest,
    });
  } catch (error) {
    if (error instanceof EffectiveHarnessCandidateAdmissionError) throw error;
    throw new EffectiveHarnessCandidateAdmissionError(
      "surface_mismatch",
      "model-routing candidate changes authority outside its declared surface",
    );
  }
}

function rebaseModelRoute(
  currentSource: string,
  ordinaryBaselineSource: string,
  identity: ReturnType<typeof parseModelRoutingCandidateIdentity>,
): string {
  const current = structuredClone(
    parseWorkflowSourceText(currentSource, "effective harness current model-routing state"),
  );
  const ordinaryBaseline = parseWorkflowSourceText(
    ordinaryBaselineSource,
    "ordinary model-routing candidate baseline",
  );
  const target = requiredAgentSourceNode(current, identity.scope.nodeId);
  const ordinaryTarget = requiredAgentSourceNode(ordinaryBaseline, identity.scope.nodeId);
  if (
    !isDeepStrictEqual(ordinaryTarget.agent.model, identity.route.before) ||
    !isDeepStrictEqual(target.agent.model, ordinaryTarget.agent.model)
  ) {
    throw new Error("model-routing candidate rebase target changed");
  }
  target.agent.model = structuredClone(identity.route.after);
  return JSON.stringify(current);
}

function rebasePromptChanges(
  currentSource: string,
  projectedSource: string,
  changes: readonly {
    readonly nodeId: string;
    readonly beforeSha256: string;
    readonly afterSha256: string;
  }[],
): string {
  const current = structuredClone(
    parseWorkflowSourceText(currentSource, "effective harness current prompt state"),
  );
  const projected = parseWorkflowSourceText(
    projectedSource,
    "ordinary prompt candidate projection",
  );
  for (const change of changes) {
    const before = requiredAgentSourceNode(current, change.nodeId);
    const after = requiredAgentSourceNode(projected, change.nodeId);
    if (
      sha256(before.agent.prompt) !== change.beforeSha256 ||
      sha256(after.agent.prompt) !== change.afterSha256
    ) {
      throw new Error("prompt rebase target changed");
    }
    before.agent.prompt = after.agent.prompt;
  }
  return JSON.stringify(current);
}

function rebaseAgentSkillPackageSelection(
  currentSource: string,
  ordinaryBaselineSource: string,
  nodeId: string,
  skillName: string,
): string {
  const current = structuredClone(
    parseWorkflowSourceText(currentSource, "effective harness current package state"),
  );
  const ordinaryBaseline = parseWorkflowSourceText(
    ordinaryBaselineSource,
    "ordinary Agent Skill package baseline",
  );
  const target = requiredAgentSourceNode(current, nodeId);
  const ordinaryTarget = requiredAgentSourceNode(ordinaryBaseline, nodeId);
  if (
    ordinaryTarget.agent.skills.length !== 0 ||
    !isDeepStrictEqual(target.agent.skills, ordinaryTarget.agent.skills)
  ) {
    throw new Error("Agent Skill package rebase target changed");
  }
  target.agent.skills = [skillName];
  return JSON.stringify(current);
}

function requiredAgentSourceNode(source: WorkflowSource, nodeId: string) {
  const node = source.nodes.find((item) => item.id === nodeId);
  if (node?.type !== "agent") throw new Error("candidate target is not an agent node");
  return node;
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

function assertModelRoutingOnlyChange(
  baseline: CompiledWorkflow,
  projected: CompiledWorkflow,
  nodeId: string,
  beforeRoute: { readonly provider: string; readonly id: string; readonly thinking: string },
  afterRoute: { readonly provider: string; readonly id: string; readonly thinking: string },
): void {
  const normalized = structuredClone(projected);
  const before = requiredAgentNode(baseline.nodes, nodeId);
  const after = requiredAgentNode(normalized.nodes, nodeId);
  if (
    !isDeepStrictEqual(before.agent.model, beforeRoute) ||
    !isDeepStrictEqual(after.agent.model, afterRoute)
  ) {
    throw new Error("model-routing candidate route mismatch");
  }
  (after.agent as { model: typeof before.agent.model }).model = structuredClone(before.agent.model);
  if (!isDeepStrictEqual(normalizeJson(normalized), normalizeJson(baseline))) {
    throw new Error("model-routing candidate changed immutable workflow controls");
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
