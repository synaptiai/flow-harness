import { agentSkillActivationWorkflow } from "../domain/adaptation/agent-skill-activation.js";
import { agentSkillPackageActivationWorkflow } from "../domain/adaptation/agent-skill-package-activation.js";
import {
  createEffectiveHarnessState,
  type EffectiveHarnessState,
  EffectiveHarnessStateError,
} from "../domain/adaptation/effective-harness-state.js";
import { promptActivationSource } from "../domain/adaptation/prompt-activation.js";
import {
  type AdaptiveActivationSnapshot,
  type CapabilityPackageSnapshot,
  parseAdaptiveActivationSnapshot,
} from "../domain/capability/agent-skills.js";

export type LegacyEffectiveHarnessClosure =
  | {
      readonly kind: "closed";
      readonly activationDigest: string;
      readonly state: EffectiveHarnessState;
    }
  | {
      readonly kind: "live-dependent";
      readonly workflowId: string;
      readonly activationDigest: string;
    };

export interface LegacyEffectiveHarnessStateInput {
  readonly scopeDigest: string;
  readonly activation: unknown;
  readonly supplementalPackages: readonly CapabilityPackageSnapshot[];
}

export type LegacyEffectiveHarnessStateErrorCode =
  | "incomplete_closure"
  | "invalid_activation"
  | "invalid_supplement";

export class LegacyEffectiveHarnessStateError extends Error {
  override readonly name = "LegacyEffectiveHarnessStateError";

  constructor(
    readonly code: LegacyEffectiveHarnessStateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function inspectLegacyEffectiveHarnessClosure(input: {
  readonly scopeDigest: string;
  readonly activation: unknown;
}): LegacyEffectiveHarnessClosure {
  let activation: AdaptiveActivationSnapshot;
  try {
    activation = parseAdaptiveActivationSnapshot(input.activation);
  } catch {
    throw new LegacyEffectiveHarnessStateError(
      "invalid_activation",
      "legacy activation is invalid",
    );
  }
  try {
    return Object.freeze({
      kind: "closed" as const,
      activationDigest: activation.activationDigest,
      state: materializeParsedLegacyState(input.scopeDigest, activation, []),
    });
  } catch (error) {
    if (error instanceof LegacyEffectiveHarnessStateError && error.code === "incomplete_closure") {
      return Object.freeze({
        kind: "live-dependent" as const,
        workflowId: activation.workflowId,
        activationDigest: activation.activationDigest,
      });
    }
    throw error;
  }
}

export function materializeLegacyEffectiveHarnessState(
  input: LegacyEffectiveHarnessStateInput,
): EffectiveHarnessState {
  let activation: AdaptiveActivationSnapshot;
  try {
    activation = parseAdaptiveActivationSnapshot(input.activation);
  } catch {
    throw new LegacyEffectiveHarnessStateError(
      "invalid_activation",
      "legacy activation is invalid",
    );
  }
  return materializeParsedLegacyState(input.scopeDigest, activation, input.supplementalPackages);
}

function materializeParsedLegacyState(
  scopeDigest: string,
  activation: AdaptiveActivationSnapshot,
  supplementalPackages: readonly CapabilityPackageSnapshot[],
): EffectiveHarnessState {
  const embeddedPackages = embeddedActivationPackages(activation);
  assertNoPackageOverlap(embeddedPackages, supplementalPackages);
  try {
    return createEffectiveHarnessState({
      scopeDigest,
      workflowSource: activationWorkflowSource(activation),
      packages: [...embeddedPackages, ...supplementalPackages],
    });
  } catch (error) {
    if (error instanceof EffectiveHarnessStateError) {
      if (error.code === "invalid_closure" || error.code === "invalid_workflow") {
        throw new LegacyEffectiveHarnessStateError(
          "incomplete_closure",
          "legacy activation does not contain a complete immutable package closure",
        );
      }
      if (
        error.code === "unexpected_policy" ||
        error.code === "invalid_schema" ||
        error.code === "identity_mismatch"
      ) {
        throw new LegacyEffectiveHarnessStateError(
          "invalid_supplement",
          "supplemental package closure is invalid",
        );
      }
    }
    throw new LegacyEffectiveHarnessStateError(
      "invalid_activation",
      "legacy activation cannot form an effective harness state",
    );
  }
}

function embeddedActivationPackages(
  activation: AdaptiveActivationSnapshot,
): readonly CapabilityPackageSnapshot[] {
  if (activation.kind === "agent-skill-activation") {
    return [activation.skill];
  }
  if (activation.kind === "agent-skill-package-activation" && activation.skill !== undefined) {
    return [activation.skill];
  }
  return [];
}

function activationWorkflowSource(activation: AdaptiveActivationSnapshot): string {
  if (activation.kind === "agent-skill-activation") {
    return agentSkillActivationWorkflow(activation);
  }
  if (activation.kind === "agent-skill-package-activation") {
    return agentSkillPackageActivationWorkflow(activation);
  }
  return promptActivationSource(activation);
}

function assertNoPackageOverlap(
  embedded: readonly CapabilityPackageSnapshot[],
  supplemental: readonly CapabilityPackageSnapshot[],
): void {
  const identities = new Set(embedded.map(packageIdentity));
  for (const capability of supplemental) {
    const identity = packageIdentity(capability);
    if (identities.has(identity)) {
      throw new LegacyEffectiveHarnessStateError(
        "invalid_supplement",
        "supplemental package closure overlaps an activation-owned package",
      );
    }
    identities.add(identity);
  }
}

function packageIdentity(capability: CapabilityPackageSnapshot): string {
  return capability.kind === "agent-skill"
    ? `${capability.kind}\0${capability.name}`
    : `${capability.kind}\0${capability.name}\0${capability.version}`;
}
