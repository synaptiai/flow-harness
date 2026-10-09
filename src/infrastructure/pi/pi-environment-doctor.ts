import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type {
  EnvironmentDoctorModelRequirement,
  EnvironmentDoctorWorkflowRequirements,
} from "../../application/environment-doctor.js";
import type { CompiledWorkflow } from "../../domain/workflow/types.js";
import { openRouterDynamicBaseModelId } from "./openrouter-dynamic-model.js";

const MAX_MODEL_REQUIREMENTS = 1_024;

interface EnvironmentDoctorModelRuntime {
  getModel(provider: string, model: string): unknown;
  hasConfiguredAuth(provider: string): boolean;
}

export interface PiEnvironmentDoctorOptions {
  readonly createRuntime?: (input: {
    readonly allowModelNetwork: false;
    readonly signal: AbortSignal;
  }) => Promise<EnvironmentDoctorModelRuntime>;
}

export function collectWorkflowModelRequirements(
  workflow: CompiledWorkflow,
): readonly EnvironmentDoctorModelRequirement[] {
  return collectWorkflowEnvironmentRequirements(workflow).modelRequirements;
}

export function collectWorkflowEnvironmentRequirements(
  workflow: CompiledWorkflow,
): EnvironmentDoctorWorkflowRequirements {
  const requirements = new Map<string, EnvironmentDoctorModelRequirement>();
  let requiresLinuxAgentCommands = false;
  const visit = (current: CompiledWorkflow): void => {
    for (const node of current.nodes) {
      if (node.type === "agent") {
        addRequirement(requirements, node.agent.model.provider, node.agent.model.id);
        requiresLinuxAgentCommands ||= node.agent.tools.includes("exec");
      }
      if (
        node.type === "verifier" &&
        (node.verifier.kind === "model" || node.verifier.kind === "packaged-model")
      ) {
        addRequirement(requirements, node.verifier.model.provider, node.verifier.model.id);
      }
      if (node.type === "child") {
        visit(node.child.workflow);
      }
    }
  };
  visit(workflow);
  return Object.freeze({
    modelRequirements: Object.freeze(
      [...requirements.values()].sort(
        (left, right) =>
          left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
      ),
    ),
    requiresLinuxAgentCommands,
  });
}

export async function inspectPiProviderConfiguration(
  requirements: readonly EnvironmentDoctorModelRequirement[],
  signal: AbortSignal,
  options: PiEnvironmentDoctorOptions = {},
): Promise<void> {
  if (requirements.length < 1 || requirements.length > MAX_MODEL_REQUIREMENTS) {
    throw new Error("selected provider configuration is unavailable");
  }
  signal.throwIfAborted();
  let runtime: EnvironmentDoctorModelRuntime;
  try {
    runtime = await (options.createRuntime ?? createOfflineModelRuntime)({
      allowModelNetwork: false,
      signal,
    });
  } catch (cause) {
    signal.throwIfAborted();
    throw new Error("selected provider configuration is unavailable", { cause });
  }
  signal.throwIfAborted();
  for (const requirement of requirements) {
    signal.throwIfAborted();
    if (
      !hasAvailableModel(runtime, requirement) ||
      !runtime.hasConfiguredAuth(requirement.provider)
    ) {
      throw new Error("selected provider configuration is unavailable");
    }
  }
}

function hasAvailableModel(
  runtime: EnvironmentDoctorModelRuntime,
  requirement: EnvironmentDoctorModelRequirement,
): boolean {
  if (runtime.getModel(requirement.provider, requirement.model) !== undefined) return true;
  const baseModel = openRouterDynamicBaseModelId(requirement.provider, requirement.model);
  return baseModel !== undefined && runtime.getModel(requirement.provider, baseModel) !== undefined;
}

async function createOfflineModelRuntime(input: {
  readonly allowModelNetwork: false;
  readonly signal: AbortSignal;
}): Promise<EnvironmentDoctorModelRuntime> {
  return await ModelRuntime.create(input);
}

function addRequirement(
  requirements: Map<string, EnvironmentDoctorModelRequirement>,
  provider: string,
  model: string,
): void {
  const key = `${provider.length}:${provider}${model}`;
  requirements.set(key, Object.freeze({ provider, model }));
  if (requirements.size > MAX_MODEL_REQUIREMENTS) {
    throw new Error("selected workflow model requirements exceed their limit");
  }
}
