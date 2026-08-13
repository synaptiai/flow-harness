import { createHash } from "node:crypto";

import { z } from "zod";

import {
  type PolicyPackageCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../capability/agent-skills.js";
import type { PolicyPackageSnapshot } from "../capability/policy-packages.js";
import {
  verifierPackageNameSchema,
  verifierPackageVersionSchema,
} from "../capability/verifier-packages.js";
import {
  composePolicyPackages,
  type EffectivePolicyPackages,
} from "../policy/policy-package-composition.js";
import { FLOW_SANDBOX_PROFILES, type FlowSandboxProfile } from "./sandbox-profiles.js";

export { FLOW_SANDBOX_PROFILES, type FlowSandboxProfile } from "./sandbox-profiles.js";

export const FLOW_CONFIG_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_ACTIVE_WORKERS = 64;
export const MAX_QUEUED_JOBS = 1024;
export const MAX_CONFIGURED_POLICY_PACKAGES = 32;

export const BUILT_IN_FLOW_CONFIG = Object.freeze({
  maxActiveWorkers: 1,
  maxQueuedJobs: 32,
});

const supervisorCapacitySchema = z
  .object({
    maxActiveWorkers: z.number().int().positive().safe().max(MAX_ACTIVE_WORKERS).optional(),
    maxQueuedJobs: z.number().int().nonnegative().safe().max(MAX_QUEUED_JOBS).optional(),
  })
  .strict();

const effectiveSupervisorCapacitySchema = z
  .object({
    maxActiveWorkers: z.number().int().positive().safe().max(MAX_ACTIVE_WORKERS),
    maxQueuedJobs: z.number().int().nonnegative().safe().max(MAX_QUEUED_JOBS),
  })
  .strict();

const sandboxConfigSchema = z
  .object({
    profile: z.enum(FLOW_SANDBOX_PROFILES),
  })
  .strict();

const policyPackageReferenceSchema = z
  .object({
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function configuredPolicyReferencesSchema(label: string) {
  return z
    .array(policyPackageReferenceSchema)
    .min(1)
    .max(MAX_CONFIGURED_POLICY_PACKAGES)
    .refine(
      (references) =>
        references.every(
          (reference, index) => index === 0 || (references[index - 1]?.name ?? "") < reference.name,
        ),
      `${label} must be sorted and unique by package name`,
    );
}

const operatorPolicyConfigSchema = z
  .object({ required: configuredPolicyReferencesSchema("required policy packages") })
  .strict();
const projectPolicyConfigSchema = z
  .object({ additional: configuredPolicyReferencesSchema("additional policy packages") })
  .strict();

const operatorConfigSchema = z
  .object({
    apiVersion: z.literal(FLOW_CONFIG_API_VERSION),
    kind: z.literal("FlowOperatorConfig"),
    policies: operatorPolicyConfigSchema.optional(),
    sandbox: sandboxConfigSchema.optional(),
    supervisor: supervisorCapacitySchema.optional(),
  })
  .strict();

const projectConfigSchema = z
  .object({
    apiVersion: z.literal(FLOW_CONFIG_API_VERSION),
    kind: z.literal("FlowProjectConfig"),
    policies: projectPolicyConfigSchema.optional(),
    supervisor: supervisorCapacitySchema.optional(),
  })
  .strict();

export type OperatorConfig = Readonly<z.infer<typeof operatorConfigSchema>>;
export type ProjectConfig = Readonly<z.infer<typeof projectConfigSchema>>;
export type SupervisorCapacity = Readonly<z.infer<typeof supervisorCapacitySchema>>;
export type SandboxConfig = Readonly<z.infer<typeof sandboxConfigSchema>>;
export type ConfiguredPolicyPackageReference = Readonly<
  z.infer<typeof policyPackageReferenceSchema>
>;

export type FlowConfigErrorCode = "invalid_config" | "unsafe_widening";

export class FlowConfigError extends Error {
  override readonly name = "FlowConfigError";
  readonly sourcePath?: string;
  readonly fieldPath?: string;

  constructor(
    readonly code: FlowConfigErrorCode,
    message: string,
    options: ErrorOptions & { readonly sourcePath?: string; readonly fieldPath?: string } = {},
  ) {
    super(message, options);
    if (options.sourcePath !== undefined) {
      this.sourcePath = options.sourcePath;
    }
    if (options.fieldPath !== undefined) {
      this.fieldPath = options.fieldPath;
    }
  }
}

export interface ConfigContribution<TConfig> {
  readonly path: string;
  readonly config: TConfig;
}

export interface ResolveFlowConfigInput {
  readonly operator?: ConfigContribution<OperatorConfig>;
  readonly project?: ConfigContribution<ProjectConfig>;
  readonly projectRoot?: string;
  readonly policyPackages?: PolicyPackageCapabilitySnapshot;
}

export interface EffectiveFlowConfig {
  readonly apiVersion: typeof FLOW_CONFIG_API_VERSION;
  readonly supervisor: {
    readonly maxActiveWorkers: number;
    readonly maxQueuedJobs: number;
  };
  readonly sandbox: SandboxConfig;
  readonly policyPackages?: {
    readonly snapshot: PolicyPackageCapabilitySnapshot;
    readonly effective: EffectivePolicyPackages;
  };
  readonly policyDigest: string;
  readonly projectRoot: string | null;
  readonly sources: {
    readonly builtIn: typeof BUILT_IN_FLOW_CONFIG;
    readonly operator: {
      readonly path: string;
      readonly values: SupervisorCapacity;
      readonly sandbox: SandboxConfig | null;
      readonly policies?: readonly ConfiguredPolicyPackageReference[];
    } | null;
    readonly project: {
      readonly path: string;
      readonly values: SupervisorCapacity;
      readonly policies?: readonly ConfiguredPolicyPackageReference[];
    } | null;
  };
}

export function parseOperatorConfig(input: unknown, sourcePath: string): OperatorConfig {
  return parseConfig(operatorConfigSchema, input, sourcePath);
}

export function parseProjectConfig(input: unknown, sourcePath: string): ProjectConfig {
  return parseConfig(projectConfigSchema, input, sourcePath);
}

export function resolveFlowConfig(input: ResolveFlowConfigInput): EffectiveFlowConfig {
  const operatorValues = input.operator?.config.supervisor ?? {};
  const operatorCeiling = {
    maxActiveWorkers: operatorValues.maxActiveWorkers ?? BUILT_IN_FLOW_CONFIG.maxActiveWorkers,
    maxQueuedJobs: operatorValues.maxQueuedJobs ?? BUILT_IN_FLOW_CONFIG.maxQueuedJobs,
  };
  const projectValues = input.project?.config.supervisor ?? {};

  assertProjectDoesNotWiden(
    "maxActiveWorkers",
    projectValues.maxActiveWorkers,
    operatorCeiling.maxActiveWorkers,
    input.project?.path,
  );
  assertProjectDoesNotWiden(
    "maxQueuedJobs",
    projectValues.maxQueuedJobs,
    operatorCeiling.maxQueuedJobs,
    input.project?.path,
  );

  const supervisor = Object.freeze({
    maxActiveWorkers: projectValues.maxActiveWorkers ?? operatorCeiling.maxActiveWorkers,
    maxQueuedJobs: projectValues.maxQueuedJobs ?? operatorCeiling.maxQueuedJobs,
  });
  const sandbox = Object.freeze({
    profile: input.operator?.config.sandbox?.profile ?? "native",
  });
  const policyPackages = resolvePolicyPackages(input, sandbox.profile);
  const canonicalPolicy = {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
    sandbox,
  };
  const policyDigest = calculateFlowPolicyDigest(
    supervisor,
    sandbox.profile,
    policyPackages?.effective.digest,
  );

  return deepFreeze({
    ...canonicalPolicy,
    ...(policyPackages === undefined ? {} : { policyPackages }),
    policyDigest,
    projectRoot: input.projectRoot ?? null,
    sources: {
      builtIn: BUILT_IN_FLOW_CONFIG,
      operator:
        input.operator === undefined
          ? null
          : {
              path: input.operator.path,
              values: operatorValues,
              sandbox: input.operator.config.sandbox ?? null,
              ...(input.operator.config.policies === undefined
                ? {}
                : { policies: input.operator.config.policies.required }),
            },
      project:
        input.project === undefined
          ? null
          : {
              path: input.project.path,
              values: projectValues,
              ...(input.project.config.policies === undefined
                ? {}
                : { policies: input.project.config.policies.additional }),
            },
    },
  });
}

export function calculateFlowPolicyDigest(
  input: {
    readonly maxActiveWorkers: number;
    readonly maxQueuedJobs: number;
  },
  sandboxProfile: FlowSandboxProfile = "native",
  effectivePolicyPackageDigest?: string,
): string {
  const supervisor = effectiveSupervisorCapacitySchema.parse(input);
  const sandbox = sandboxConfigSchema.parse({ profile: sandboxProfile });
  return createHash("sha256")
    .update(
      JSON.stringify({
        apiVersion: FLOW_CONFIG_API_VERSION,
        supervisor,
        sandbox,
        ...(effectivePolicyPackageDigest === undefined
          ? {}
          : { policyPackages: { digest: effectivePolicyPackageDigest } }),
      }),
    )
    .digest("hex");
}

function resolvePolicyPackages(
  input: ResolveFlowConfigInput,
  sandboxProfile: FlowSandboxProfile,
): EffectiveFlowConfig["policyPackages"] {
  const operatorReferences = input.operator?.config.policies?.required ?? [];
  const projectReferences = input.project?.config.policies?.additional ?? [];
  const references = [...operatorReferences, ...projectReferences];
  if (references.length === 0) {
    if (input.policyPackages !== undefined) {
      throw configError(
        "invalid_config",
        "policyPackages",
        "a policy package snapshot was supplied without configured package references",
      );
    }
    return undefined;
  }
  if (input.projectRoot === undefined) {
    throw configError(
      "invalid_config",
      "policies",
      "configured policy packages require a Flow project root",
    );
  }
  for (const projectReference of projectReferences) {
    if (operatorReferences.some((reference) => reference.name === projectReference.name)) {
      throw configError(
        "unsafe_widening",
        `policies.additional.${projectReferences.indexOf(projectReference)}.name`,
        `project policy package "${projectReference.name}" duplicates an operator-required package`,
        input.project?.path,
      );
    }
  }
  if (input.policyPackages === undefined) {
    throw configError(
      "invalid_config",
      operatorReferences.length > 0 ? "policies.required" : "policies.additional",
      "configured policy package snapshots are missing",
      operatorReferences.length > 0 ? input.operator?.path : input.project?.path,
    );
  }
  let snapshot: PolicyPackageCapabilitySnapshot;
  try {
    const validated = validateCapabilitySnapshot(input.policyPackages);
    if (!validated.packages.every((item) => item.kind === "policy-package")) {
      throw new Error("snapshot contains a non-policy capability");
    }
    snapshot = validated as PolicyPackageCapabilitySnapshot;
  } catch (error) {
    throw configError(
      "invalid_config",
      "policyPackages",
      "configured policy package snapshot is invalid",
      undefined,
      error,
    );
  }
  const byName = new Map(
    snapshot.packages.map((policy) => [policy.name, policy as PolicyPackageSnapshot]),
  );
  for (const [index, reference] of references.entries()) {
    const selected = byName.get(reference.name);
    const source = index < operatorReferences.length ? input.operator?.path : input.project?.path;
    const prefix = index < operatorReferences.length ? "policies.required" : "policies.additional";
    const referenceIndex =
      index < operatorReferences.length ? index : index - operatorReferences.length;
    if (selected === undefined) {
      throw configError(
        "invalid_config",
        `${prefix}.${referenceIndex}.name`,
        `configured policy package "${reference.name}" is absent from the selected snapshot`,
        source,
      );
    }
    if (selected.version !== reference.version) {
      throw configError(
        "invalid_config",
        `${prefix}.${referenceIndex}.version`,
        `configured policy package "${reference.name}" version does not match its snapshot`,
        source,
      );
    }
    if (selected.digest !== reference.digest) {
      throw configError(
        "invalid_config",
        `${prefix}.${referenceIndex}.digest`,
        `configured policy package "${reference.name}" digest does not match its snapshot`,
        source,
      );
    }
  }
  if (byName.size !== references.length) {
    throw configError(
      "invalid_config",
      "policyPackages",
      "selected policy package snapshot contains an unconfigured package",
    );
  }
  const effective = composePolicyPackages([...byName.values()]);
  if (effective === undefined) {
    throw configError("invalid_config", "policyPackages", "policy package composition is empty");
  }
  if (
    effective.constraints.sandbox !== undefined &&
    !effective.constraints.sandbox.allowedProfiles.includes(sandboxProfile)
  ) {
    throw configError(
      "unsafe_widening",
      "sandbox.profile",
      `sandbox profile "${sandboxProfile}" is not allowed by the selected policy packages`,
      input.operator?.path,
    );
  }
  return deepFreeze({ snapshot, effective });
}

function configError(
  code: FlowConfigErrorCode,
  fieldPath: string,
  message: string,
  sourcePath?: string,
  cause?: unknown,
): FlowConfigError {
  const prefix = sourcePath === undefined ? "Flow configuration" : sourcePath;
  return new FlowConfigError(code, `${prefix}: ${fieldPath}: ${message}`, {
    ...(sourcePath === undefined ? {} : { sourcePath }),
    fieldPath,
    ...(cause === undefined ? {} : { cause }),
  });
}

function parseConfig<T>(schema: z.ZodType<T>, input: unknown, sourcePath: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return deepFreeze(parsed.data);
  }
  const issue = parsed.error.issues[0];
  const fieldPath = issue?.path.map(String).join(".") || "<root>";
  const detail = issue?.message ?? "configuration is invalid";
  throw new FlowConfigError("invalid_config", `${sourcePath}: ${fieldPath}: ${detail}`, {
    sourcePath,
    fieldPath,
    cause: parsed.error,
  });
}

function assertProjectDoesNotWiden(
  field: keyof typeof BUILT_IN_FLOW_CONFIG,
  requested: number | undefined,
  ceiling: number,
  sourcePath: string | undefined,
): void {
  if (requested === undefined || requested <= ceiling) {
    return;
  }
  const fieldPath = `supervisor.${field}`;
  throw new FlowConfigError(
    "unsafe_widening",
    `${sourcePath ?? "project configuration"}: ${fieldPath}: project value ${requested} exceeds operator ceiling ${ceiling}`,
    { ...(sourcePath === undefined ? {} : { sourcePath }), fieldPath },
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
