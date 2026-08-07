import { createHash } from "node:crypto";

import { z } from "zod";

export const FLOW_CONFIG_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_ACTIVE_WORKERS = 64;
export const MAX_QUEUED_JOBS = 1024;

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

const operatorConfigSchema = z
  .object({
    apiVersion: z.literal(FLOW_CONFIG_API_VERSION),
    kind: z.literal("FlowOperatorConfig"),
    supervisor: supervisorCapacitySchema.optional(),
  })
  .strict();

const projectConfigSchema = z
  .object({
    apiVersion: z.literal(FLOW_CONFIG_API_VERSION),
    kind: z.literal("FlowProjectConfig"),
    supervisor: supervisorCapacitySchema.optional(),
  })
  .strict();

export type OperatorConfig = Readonly<z.infer<typeof operatorConfigSchema>>;
export type ProjectConfig = Readonly<z.infer<typeof projectConfigSchema>>;
export type SupervisorCapacity = Readonly<z.infer<typeof supervisorCapacitySchema>>;

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
}

export interface EffectiveFlowConfig {
  readonly apiVersion: typeof FLOW_CONFIG_API_VERSION;
  readonly supervisor: {
    readonly maxActiveWorkers: number;
    readonly maxQueuedJobs: number;
  };
  readonly policyDigest: string;
  readonly projectRoot: string | null;
  readonly sources: {
    readonly builtIn: typeof BUILT_IN_FLOW_CONFIG;
    readonly operator: {
      readonly path: string;
      readonly values: SupervisorCapacity;
    } | null;
    readonly project: {
      readonly path: string;
      readonly values: SupervisorCapacity;
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
  const canonicalPolicy = {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
  };
  const policyDigest = calculateFlowPolicyDigest(supervisor);

  return deepFreeze({
    ...canonicalPolicy,
    policyDigest,
    projectRoot: input.projectRoot ?? null,
    sources: {
      builtIn: BUILT_IN_FLOW_CONFIG,
      operator:
        input.operator === undefined ? null : { path: input.operator.path, values: operatorValues },
      project:
        input.project === undefined ? null : { path: input.project.path, values: projectValues },
    },
  });
}

export function calculateFlowPolicyDigest(input: {
  readonly maxActiveWorkers: number;
  readonly maxQueuedJobs: number;
}): string {
  const supervisor = effectiveSupervisorCapacitySchema.parse(input);
  return createHash("sha256")
    .update(JSON.stringify({ apiVersion: FLOW_CONFIG_API_VERSION, supervisor }))
    .digest("hex");
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
