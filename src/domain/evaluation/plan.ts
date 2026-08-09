import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";

export const EVALUATION_PLAN_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_EVALUATION_TASKS = 64;
export const MAX_EVALUATION_PROFILES = 8;
export const MAX_EVALUATION_SEEDS = 32;
export const MAX_EVALUATION_TRIALS = 4_096;
export const MAX_EVALUATION_ASSERTIONS = 16;
export const MAX_EVALUATION_PLAN_BYTES = 1_048_576;

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "must be a canonical lowercase identifier");
const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "must be an exact semantic version",
  );
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rateSchema = z.number().min(0).max(1);
const canonicalRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isCanonicalRelativePath, "must be a canonical portable relative path");

const assertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exists"), path: canonicalRelativePathSchema }).strict(),
  z.object({ kind: z.literal("absent"), path: canonicalRelativePathSchema }).strict(),
  z
    .object({ kind: z.literal("sha256"), path: canonicalRelativePathSchema, value: sha256Schema })
    .strict(),
]);

const taskSchema = z
  .object({
    id: identifierSchema,
    partition: z.enum(["tuning", "regression", "holdout"]),
    fixture: canonicalRelativePathSchema,
    instruction: canonicalRelativePathSchema,
    verifier: z
      .object({
        kind: z.literal("filesystem-v1"),
        assertions: z.array(assertionSchema).min(1).max(MAX_EVALUATION_ASSERTIONS),
      })
      .strict()
      .refine(
        (verifier) =>
          new Set(verifier.assertions.map((item) => `${item.kind}\0${item.path}`)).size ===
          verifier.assertions.length,
        "verifier assertions must be unique",
      ),
  })
  .strict();

const profileSchema = z
  .object({
    id: identifierSchema,
    adapter: z.literal("flow-workflow-v1"),
    workflow: canonicalRelativePathSchema,
  })
  .strict();

const budgetSchema = z
  .object({
    maxNodeStarts: positiveSafeIntegerSchema,
    maxModelTokens: positiveSafeIntegerSchema,
    maxCostUsdMicros: positiveSafeIntegerSchema,
    maxExecutionMs: positiveSafeIntegerSchema,
    maxArtifactBytes: positiveSafeIntegerSchema,
  })
  .strict();

const evaluationPlanSourceSchema = z
  .object({
    apiVersion: z.literal(EVALUATION_PLAN_API_VERSION),
    kind: z.literal("EvaluationPlan"),
    metadata: z.object({ id: identifierSchema }).strict(),
    suite: z
      .object({
        id: identifierSchema,
        version: semverSchema,
        tasks: z.array(taskSchema).min(1).max(MAX_EVALUATION_TASKS),
      })
      .strict(),
    profiles: z.array(profileSchema).length(2).max(MAX_EVALUATION_PROFILES),
    controls: z
      .object({
        model: z
          .object({
            provider: z.string().min(1).max(96),
            id: z.string().min(1).max(256),
            thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
          })
          .strict(),
        budget: budgetSchema,
        network: z.literal("deny"),
        retry: z
          .object({
            providerRetries: z.literal(0),
            harnessRetries: z.literal(0),
          })
          .strict(),
      })
      .strict(),
    seeds: z.array(nonNegativeSafeIntegerSchema).min(1).max(MAX_EVALUATION_SEEDS),
    order: z.literal("paired-alternating-v1"),
    comparison: z
      .object({
        baselineProfileId: identifierSchema,
        candidateProfileId: identifierSchema,
        minimumPairedTrials: positiveSafeIntegerSchema,
        confidenceLevel: z.literal(0.95),
        minimumEffect: rateSchema,
        maxFalseCompletionRate: rateSchema,
        maxPolicyViolations: nonNegativeSafeIntegerSchema,
        maxVerifiedSuccessRegression: rateSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    refineUnique(
      plan.suite.tasks.map((item) => item.id),
      "suite task ids",
      ["suite", "tasks"],
      context,
    );
    refineUnique(
      plan.profiles.map((item) => item.id),
      "profile ids",
      ["profiles"],
      context,
    );
    refineUnique(plan.seeds, "seeds", ["seeds"], context);
    const profileIds = new Set(plan.profiles.map((item) => item.id));
    if (!profileIds.has(plan.comparison.baselineProfileId)) {
      context.addIssue({
        code: "custom",
        path: ["comparison", "baselineProfileId"],
        message: "comparison baseline profile must reference a declared profile",
      });
    }
    if (!profileIds.has(plan.comparison.candidateProfileId)) {
      context.addIssue({
        code: "custom",
        path: ["comparison", "candidateProfileId"],
        message: "comparison candidate profile must reference a declared profile",
      });
    }
    if (plan.comparison.baselineProfileId === plan.comparison.candidateProfileId) {
      context.addIssue({
        code: "custom",
        path: ["comparison"],
        message: "comparison baseline and candidate profiles must differ",
      });
    }
    const scheduled = plan.suite.tasks.length * plan.profiles.length * plan.seeds.length;
    if (!Number.isSafeInteger(scheduled) || scheduled > MAX_EVALUATION_TRIALS) {
      context.addIssue({
        code: "custom",
        path: ["seeds"],
        message: `evaluation schedule must not exceed ${MAX_EVALUATION_TRIALS} trials`,
      });
    }
    const holdoutPairs =
      plan.suite.tasks.filter((task) => task.partition === "holdout").length * plan.seeds.length;
    if (plan.comparison.minimumPairedTrials > holdoutPairs) {
      context.addIssue({
        code: "custom",
        path: ["comparison", "minimumPairedTrials"],
        message: "minimum paired trials cannot exceed the declared holdout pair schedule",
      });
    }
  });

export type EvaluationPlanSource = z.infer<typeof evaluationPlanSourceSchema>;
export type EvaluationTaskSource = EvaluationPlanSource["suite"]["tasks"][number];
export type EvaluationProfileSource = EvaluationPlanSource["profiles"][number];
export type EvaluationFilesystemAssertion = EvaluationTaskSource["verifier"]["assertions"][number];

export interface EvaluationPlanIdentity {
  readonly version: 1;
  readonly apiVersion: typeof EVALUATION_PLAN_API_VERSION;
  readonly id: string;
  readonly suite: {
    readonly id: string;
    readonly version: string;
    readonly tasks: readonly {
      readonly id: string;
      readonly partition: EvaluationTaskSource["partition"];
      readonly fixture: {
        readonly provenance: string;
        readonly digest: string;
        readonly entryCount: number;
        readonly logicalBytes: number;
        readonly instructionPath: string;
        readonly instructionSha256: string;
      };
      readonly verifier: {
        readonly kind: "filesystem-v1";
        readonly digest: string;
        readonly assertionCount: number;
      };
    }[];
  };
  readonly profiles: readonly {
    readonly id: string;
    readonly adapter: EvaluationProfileSource["adapter"];
    readonly workflow: {
      readonly provenance: string;
      readonly sourceSha256: string;
      readonly workflowDigest: string;
    };
  }[];
  readonly controls: EvaluationPlanSource["controls"];
  readonly seeds: readonly number[];
  readonly order: EvaluationPlanSource["order"];
  readonly comparison: EvaluationPlanSource["comparison"];
}

export interface EvaluationTrialScheduleItem {
  readonly version: 1;
  readonly position: number;
  readonly trialId: string;
  readonly taskId: string;
  readonly profileId: string;
  readonly seed: number;
  readonly repetition: number;
}

export type EvaluationPlanErrorCode = "invalid_schema" | "invalid_yaml" | "limit_exceeded";

export class EvaluationPlanError extends Error {
  override readonly name = "EvaluationPlanError";

  constructor(
    readonly code: EvaluationPlanErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export function parseEvaluationPlanText(
  source: string,
  sourceName = "evaluation plan",
): EvaluationPlanSource {
  if (Buffer.byteLength(source, "utf8") > MAX_EVALUATION_PLAN_BYTES) {
    throw new EvaluationPlanError(
      "limit_exceeded",
      `${sourceName} exceeds ${MAX_EVALUATION_PLAN_BYTES} UTF-8 bytes`,
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
      throw new EvaluationPlanError(
        "invalid_yaml",
        `${sourceName}: ${document.errors.map((error) => error.message).join("; ")}`,
      );
    }
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof EvaluationPlanError) {
      throw error;
    }
    throw new EvaluationPlanError(
      "invalid_yaml",
      `${sourceName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = evaluationPlanSourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvaluationPlanError(
      "invalid_schema",
      `${sourceName}: ${parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

export function createEvaluationSchedule(
  planDigest: string,
  taskIds: readonly string[],
  profileIds: readonly string[],
  seeds: readonly number[],
): readonly EvaluationTrialScheduleItem[] {
  if (!/^[a-f0-9]{64}$/.test(planDigest)) {
    throw new EvaluationPlanError("invalid_schema", "plan digest must be a SHA-256 digest");
  }
  if (taskIds.length === 0 || taskIds.length > MAX_EVALUATION_TASKS) {
    throw new EvaluationPlanError("limit_exceeded", "evaluation tasks are missing or excessive");
  }
  if (profileIds.length !== 2 || new Set(profileIds).size !== profileIds.length) {
    throw new EvaluationPlanError(
      "invalid_schema",
      "paired evaluation requires exactly two unique profile ids",
    );
  }
  if (
    seeds.length === 0 ||
    seeds.length > MAX_EVALUATION_SEEDS ||
    new Set(seeds).size !== seeds.length
  ) {
    throw new EvaluationPlanError(
      "invalid_schema",
      "evaluation seeds are missing, duplicate, or excessive",
    );
  }
  const scheduled = taskIds.length * profileIds.length * seeds.length;
  if (!Number.isSafeInteger(scheduled) || scheduled > MAX_EVALUATION_TRIALS) {
    throw new EvaluationPlanError(
      "limit_exceeded",
      `evaluation schedule must not exceed ${MAX_EVALUATION_TRIALS} trials`,
    );
  }

  const schedule: EvaluationTrialScheduleItem[] = [];
  let pairIndex = 0;
  for (const taskId of taskIds) {
    identifierSchema.parse(taskId);
    for (const [seedIndex, seed] of seeds.entries()) {
      nonNegativeSafeIntegerSchema.parse(seed);
      const orderedProfiles = pairIndex % 2 === 0 ? profileIds : [profileIds[1], profileIds[0]];
      for (const profileId of orderedProfiles) {
        if (profileId === undefined) {
          throw new EvaluationPlanError("invalid_schema", "paired profile ordering is incomplete");
        }
        identifierSchema.parse(profileId);
        const position = schedule.length + 1;
        const repetition = seedIndex + 1;
        const identity = `${planDigest}\0${taskId}\0${profileId}\0${seed}\0${repetition}\0${position}`;
        schedule.push(
          Object.freeze({
            version: 1,
            position,
            trialId: `trial-${createHash("sha256").update(identity).digest("hex").slice(0, 48)}`,
            taskId,
            profileId,
            seed,
            repetition,
          }),
        );
      }
      pairIndex += 1;
    }
  }
  return Object.freeze(schedule);
}

export function calculateEvaluationPlanDigest(identity: EvaluationPlanIdentity): string {
  return createHash("sha256").update(canonicalEvaluationValue(identity)).digest("hex");
}

export function calculateEvaluationVerifierDigest(
  kind: "filesystem-v1",
  assertions: readonly EvaluationFilesystemAssertion[],
): string {
  return createHash("sha256").update(canonicalEvaluationValue({ kind, assertions })).digest("hex");
}

function isCanonicalRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function refineUnique(
  values: readonly unknown[],
  label: string,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: `${label} must be unique` });
  }
}

function canonicalEvaluationValue(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalEvaluationValue).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalEvaluationValue((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new EvaluationPlanError("invalid_schema", "evaluation identity is not canonical JSON");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return value;
}
