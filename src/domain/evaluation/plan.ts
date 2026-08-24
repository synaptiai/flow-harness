import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { AgentSkillCandidateIdentity } from "../adaptation/agent-skill-candidate.js";
import type { AgentSkillPackageCandidateIdentity } from "../adaptation/agent-skill-package-candidate.js";
import type { ChildSpecialistCandidateIdentity } from "../adaptation/child-specialist-candidate.js";
import type { DelegationEvaluationCandidateIdentity } from "../adaptation/delegation-evaluation-candidate.js";
import type { ModelRoutingCandidateIdentity } from "../adaptation/model-routing-candidate.js";
import type { PhaseRoutingCandidateIdentity } from "../adaptation/phase-routing-candidate.js";
import type { PromptCandidateIdentity } from "../adaptation/prompt-candidate.js";
import type { SupplementalMemoryCandidateIdentity } from "../adaptation/supplemental-memory-candidate.js";
import type { ExternalHarnessIdentity } from "./external-harness.js";
import type { PublicEvaluationAdapterInput } from "../capability/public-capability-reference.js";

export const EVALUATION_PLAN_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_EVALUATION_TASKS = 64;
export const MAX_EVALUATION_PROFILES = 8;
export const MAX_EVALUATION_SEEDS = 32;
export const MAX_EVALUATION_TRIALS = 4_096;
export const MAX_EVALUATION_ASSERTIONS = 16;
export const MAX_EVALUATION_PLAN_BYTES = 1_048_576;
export const MAX_EVALUATION_INSTRUCTION_BYTES = 256 * 1_024;

export const EVALUATION_ADAPTER_REFERENCES = Object.freeze([
  evaluationAdapterReference({
    id: "flow-workflow-v1",
    title: "Flow workflow",
    summary: "Execute an admitted workflow through the ordinary Flow runtime.",
    isolation: "flow-runtime",
  }),
  evaluationAdapterReference({
    id: "omp-native-v1",
    title: "Native OMP",
    summary: "Execute the pinned native OMP harness through a local process adapter.",
    isolation: "local-process",
  }),
  evaluationAdapterReference({
    id: "pi-native-v1",
    title: "Native Pi",
    summary: "Execute the pinned native Pi harness through a local process adapter.",
    isolation: "local-process",
  }),
  evaluationAdapterReference({
    id: "prime-agent-native-v1",
    title: "Prime Agent",
    summary: "Execute the admitted Prime Agent harness through its OCI runtime contract.",
    isolation: "oci-container",
  }),
] as const satisfies readonly PublicEvaluationAdapterInput[]);

export type EvaluationAdapterId = (typeof EVALUATION_ADAPTER_REFERENCES)[number]["id"];

function evaluationAdapterReference<const TReference extends PublicEvaluationAdapterInput>(
  reference: TReference,
): TReference {
  return Object.freeze(reference);
}

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
const evaluationModelSchema = z
  .object({
    provider: z.string().min(1).max(96),
    id: z.string().min(1).max(256),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  })
  .strict();
const modelRouteControlSchema = z
  .object({
    profileId: identifierSchema,
    nodeId: identifierSchema,
    route: evaluationModelSchema,
  })
  .strict();
const phaseRoutingProfileControlSchema = z
  .object({ profileId: identifierSchema, profileDigest: sha256Schema })
  .strict();
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

const filesystemVerifierSchema = z
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
  );

const agentResultVerifierSchema = z
  .object({
    kind: z.literal("agent-result-v1"),
    sha256: sha256Schema,
    bytes: positiveSafeIntegerSchema,
  })
  .strict();

const taskSchema = z
  .object({
    id: identifierSchema,
    partition: z.enum(["tuning", "regression", "holdout"]),
    delegationClass: z.enum(["delegation-fit", "sequential-control"]).optional(),
    fixture: canonicalRelativePathSchema,
    instruction: canonicalRelativePathSchema,
    verifier: z.discriminatedUnion("kind", [filesystemVerifierSchema, agentResultVerifierSchema]),
  })
  .strict();

const profileSchema = z.union([
  z
    .object({
      id: identifierSchema,
      adapter: z.literal(evaluationAdapterId("flow-workflow-v1")),
      workflow: canonicalRelativePathSchema,
      acpAgent: canonicalRelativePathSchema,
    })
    .strict(),
  z
    .object({
      id: identifierSchema,
      adapter: z.literal(evaluationAdapterId("flow-workflow-v1")),
      workflow: canonicalRelativePathSchema,
    })
    .strict(),
  z
    .object({
      id: identifierSchema,
      adapter: z.literal(evaluationAdapterId("flow-workflow-v1")),
      candidate: canonicalRelativePathSchema,
    })
    .strict(),
  z
    .object({
      id: identifierSchema,
      adapter: z.literal(evaluationAdapterId("flow-workflow-v1")),
      effectiveCandidate: canonicalRelativePathSchema,
      selection: z.enum(["baseline", "candidate"]),
    })
    .strict(),
  z
    .object({
      id: identifierSchema,
      adapter: z.literal(evaluationAdapterId("pi-native-v1")),
      harness: z.object({ config: z.literal("pi-evaluation-v1") }).strict(),
    })
    .strict(),
  z
    .object({
      id: identifierSchema,
      adapter: z.literal(evaluationAdapterId("omp-native-v1")),
      harness: z.object({ config: z.literal("omp-evaluation-v1") }).strict(),
    })
    .strict(),
  z
    .object({
      id: identifierSchema,
      adapter: z.literal(evaluationAdapterId("prime-agent-native-v1")),
      harness: z.object({ config: z.literal("prime-agent-rlm-evaluation-v1") }).strict(),
    })
    .strict(),
]);

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
    purpose: z.enum(["acp-interoperability-v1", "phase-routing-v1", "delegation-v1"]).optional(),
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
        model: evaluationModelSchema,
        modelRoutes: z
          .tuple([modelRouteControlSchema, modelRouteControlSchema])
          .readonly()
          .optional(),
        phaseRoutingProfiles: z
          .tuple([phaseRoutingProfileControlSchema, phaseRoutingProfileControlSchema])
          .readonly()
          .optional(),
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
        minimumCostReductionRate: rateSchema.optional(),
        minimumLatencyReductionRate: rateSchema.optional(),
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
    const acpProfiles = plan.profiles.filter(
      (profile) => profile.adapter === "flow-workflow-v1" && "acpAgent" in profile,
    );
    const agentResultTasks = plan.suite.tasks.filter(
      (task) => task.verifier.kind === "agent-result-v1",
    );
    if (plan.purpose === "acp-interoperability-v1") {
      if (acpProfiles.length !== plan.profiles.length) {
        context.addIssue({
          code: "custom",
          path: ["profiles"],
          message: "ACP qualification requires one ACP agent for every profile",
        });
      }
      if (
        acpProfiles.length === 2 &&
        new Set(acpProfiles.map((profile) => profile.workflow)).size !== 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["profiles"],
          message: "ACP qualification profiles must select the same workflow source",
        });
      }
      if (agentResultTasks.length !== plan.suite.tasks.length) {
        context.addIssue({
          code: "custom",
          path: ["suite", "tasks"],
          message: "ACP qualification requires agent-result-v1 verification for every task",
        });
      }
      if (plan.controls.modelRoutes !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["controls", "modelRoutes"],
          message: "ACP qualification uses one shared model control without per-profile routes",
        });
      }
    } else {
      if (acpProfiles.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["profiles"],
          message: "ACP agent profiles require the acp-interoperability-v1 purpose",
        });
      }
      if (agentResultTasks.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["suite", "tasks"],
          message: "agent-result-v1 verification requires the acp-interoperability-v1 purpose",
        });
      }
    }
    const delegatedTasks = plan.suite.tasks.filter((task) => task.delegationClass !== undefined);
    if (plan.purpose === "delegation-v1") {
      const baselineProfile = plan.profiles.find(
        (profile) => profile.id === plan.comparison.baselineProfileId,
      );
      const candidateProfile = plan.profiles.find(
        (profile) => profile.id === plan.comparison.candidateProfileId,
      );
      const classes = new Set(delegatedTasks.map((task) => task.delegationClass));
      if (
        delegatedTasks.length !== plan.suite.tasks.length ||
        classes.size !== 2 ||
        !classes.has("delegation-fit") ||
        !classes.has("sequential-control")
      ) {
        context.addIssue({
          code: "custom",
          path: ["suite", "tasks"],
          message:
            "delegation qualification requires both delegation-fit and sequential-control task classes",
        });
      }
      if (
        plan.suite.tasks.some(
          (task) => task.partition !== "holdout" || task.verifier.kind !== "filesystem-v1",
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["suite", "tasks"],
          message: "delegation qualification requires filesystem-verified holdout tasks only",
        });
      }
      if (
        baselineProfile?.adapter !== "flow-workflow-v1" ||
        candidateProfile?.adapter !== "flow-workflow-v1" ||
        !("workflow" in baselineProfile) ||
        !("candidate" in candidateProfile)
      ) {
        context.addIssue({
          code: "custom",
          path: ["profiles"],
          message:
            "delegation qualification requires one direct Flow baseline and one candidate profile",
        });
      }
      if (plan.controls.modelRoutes !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["controls", "modelRoutes"],
          message: "delegation qualification uses one shared root model control",
        });
      }
    } else if (delegatedTasks.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["suite", "tasks"],
        message: "delegation task classes require the delegation-v1 purpose",
      });
    }
    if (plan.purpose === "phase-routing-v1") {
      const phaseProfiles = plan.controls.phaseRoutingProfiles;
      const baselineProfile = plan.profiles.find(
        (profile) => profile.id === plan.comparison.baselineProfileId,
      );
      const candidateProfile = plan.profiles.find(
        (profile) => profile.id === plan.comparison.candidateProfileId,
      );
      if (plan.controls.modelRoutes !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["controls", "modelRoutes"],
          message: "phase-routing qualification uses exact phase profiles, not root model routes",
        });
      }
      if (
        phaseProfiles === undefined ||
        phaseProfiles[0].profileId !== plan.comparison.baselineProfileId ||
        phaseProfiles[1].profileId !== plan.comparison.candidateProfileId ||
        phaseProfiles[0].profileDigest === phaseProfiles[1].profileDigest
      ) {
        context.addIssue({
          code: "custom",
          path: ["controls", "phaseRoutingProfiles"],
          message:
            "phase-routing profiles must be distinct and ordered by the comparison baseline and candidate profiles",
        });
      }
      if (
        baselineProfile?.adapter !== "flow-workflow-v1" ||
        candidateProfile?.adapter !== "flow-workflow-v1" ||
        !("effectiveCandidate" in baselineProfile) ||
        !("effectiveCandidate" in candidateProfile) ||
        baselineProfile.selection !== "baseline" ||
        candidateProfile.selection !== "candidate" ||
        baselineProfile.effectiveCandidate !== candidateProfile.effectiveCandidate
      ) {
        context.addIssue({
          code: "custom",
          path: ["profiles"],
          message: "phase-routing qualification requires one exact effective profile pair",
        });
      }
      if (
        plan.comparison.minimumCostReductionRate === undefined ||
        plan.comparison.minimumLatencyReductionRate === undefined ||
        plan.comparison.minimumCostReductionRate <= 0 ||
        plan.comparison.minimumLatencyReductionRate <= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["comparison"],
          message:
            "phase-routing qualification requires positive cost and latency reduction thresholds",
        });
      }
      if (
        plan.suite.tasks.some(
          (task) => task.partition !== "holdout" || task.verifier.kind !== "filesystem-v1",
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["suite", "tasks"],
          message: "phase-routing qualification requires filesystem-verified holdout tasks only",
        });
      }
      if (plan.comparison.minimumEffect !== 0) {
        context.addIssue({
          code: "custom",
          path: ["comparison", "minimumEffect"],
          message:
            "phase-routing qualification uses explicit efficiency thresholds and requires minimumEffect to be zero",
        });
      }
    } else if (
      plan.controls.phaseRoutingProfiles !== undefined ||
      plan.comparison.minimumCostReductionRate !== undefined ||
      plan.comparison.minimumLatencyReductionRate !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["controls", "phaseRoutingProfiles"],
        message: "phase-routing controls and thresholds require the phase-routing-v1 purpose",
      });
    }
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
    if (plan.controls.modelRoutes !== undefined) {
      const [baselineRoute, candidateRoute] = plan.controls.modelRoutes;
      const baselineProfile = plan.profiles.find(
        (profile) => profile.id === plan.comparison.baselineProfileId,
      );
      const candidateProfile = plan.profiles.find(
        (profile) => profile.id === plan.comparison.candidateProfileId,
      );
      if (
        baselineRoute.profileId !== plan.comparison.baselineProfileId ||
        candidateRoute.profileId !== plan.comparison.candidateProfileId
      ) {
        context.addIssue({
          code: "custom",
          path: ["controls", "modelRoutes"],
          message: "model routes must be ordered by the comparison baseline and candidate profiles",
        });
      }
      if (baselineRoute.nodeId !== candidateRoute.nodeId) {
        context.addIssue({
          code: "custom",
          path: ["controls", "modelRoutes"],
          message: "paired model routes must select one exact root agent node",
        });
      }
      if (isDeepStrictEqual(baselineRoute.route, candidateRoute.route)) {
        context.addIssue({
          code: "custom",
          path: ["controls", "modelRoutes"],
          message: "paired model routes must contain distinct route identities",
        });
      }
      if (
        baselineProfile?.adapter !== "flow-workflow-v1" ||
        candidateProfile?.adapter !== "flow-workflow-v1" ||
        !("effectiveCandidate" in baselineProfile) ||
        !("effectiveCandidate" in candidateProfile) ||
        baselineProfile.selection !== "baseline" ||
        candidateProfile.selection !== "candidate" ||
        baselineProfile.effectiveCandidate !== candidateProfile.effectiveCandidate
      ) {
        context.addIssue({
          code: "custom",
          path: ["controls", "modelRoutes"],
          message: "model routes require one exact effective baseline and candidate profile pair",
        });
      }
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
export type EvaluationFilesystemVerifierSource = Extract<
  EvaluationTaskSource["verifier"],
  { readonly kind: "filesystem-v1" }
>;
export type EvaluationAgentResultVerifierSource = Extract<
  EvaluationTaskSource["verifier"],
  { readonly kind: "agent-result-v1" }
>;
export type EvaluationFilesystemAssertion =
  EvaluationFilesystemVerifierSource["assertions"][number];

export interface EvaluationPlanIdentity {
  readonly version: 1;
  readonly apiVersion: typeof EVALUATION_PLAN_API_VERSION;
  readonly id: string;
  readonly purpose?: "acp-interoperability-v1" | "phase-routing-v1" | "delegation-v1";
  readonly suite: {
    readonly id: string;
    readonly version: string;
    readonly tasks: readonly {
      readonly id: string;
      readonly partition: EvaluationTaskSource["partition"];
      readonly delegationClass?: "delegation-fit" | "sequential-control" | undefined;
      readonly fixture: {
        readonly provenance: string;
        readonly digest: string;
        readonly entryCount: number;
        readonly logicalBytes: number;
        readonly instructionPath: string;
        readonly instructionSha256: string;
      };
      readonly verifier: {
        readonly kind: "filesystem-v1" | "agent-result-v1";
        readonly digest: string;
        readonly assertionCount: number;
      };
    }[];
  };
  readonly profiles: readonly EvaluationProfileIdentity[];
  readonly controls: EvaluationPlanSource["controls"];
  readonly seeds: readonly number[];
  readonly order: EvaluationPlanSource["order"];
  readonly comparison: EvaluationPlanSource["comparison"];
}

type ExternalEvaluationProfileIdentity = {
  [Adapter in ExternalHarnessIdentity["adapter"]]: {
    readonly id: string;
    readonly adapter: Adapter;
    readonly harness: Extract<ExternalHarnessIdentity, { readonly adapter: Adapter }>;
  };
}[ExternalHarnessIdentity["adapter"]];

export type EvaluationProfileIdentity =
  | {
      readonly id: string;
      readonly adapter: "flow-workflow-v1";
      readonly workflow: {
        readonly sourceKind?:
          | "prompt-candidate-projection"
          | "agent-skill-candidate-projection"
          | "agent-skill-package-candidate-projection"
          | "delegation-evaluation-baseline"
          | "delegation-evaluation-candidate"
          | "effective-harness-baseline"
          | "effective-harness-candidate-projection";
        readonly provenance: string;
        readonly sourceSha256: string;
        readonly workflowDigest: string;
      };
      readonly capabilitySnapshotDigest?: string;
      readonly capabilityPackageDigests?: readonly string[];
      readonly acpAgent?: {
        readonly name: string;
        readonly digest: string;
      };
      readonly candidate?: {
        readonly provenance: string;
        readonly identity:
          | PromptCandidateIdentity
          | AgentSkillCandidateIdentity
          | AgentSkillPackageCandidateIdentity
          | ModelRoutingCandidateIdentity
          | PhaseRoutingCandidateIdentity
          | ChildSpecialistCandidateIdentity
          | DelegationEvaluationCandidateIdentity
          | SupplementalMemoryCandidateIdentity;
      };
      readonly effectiveHarness?: {
        readonly selection: "baseline" | "candidate";
        readonly artifactDigest: string;
        readonly stateDigest: string;
        readonly baselineHeadDigest: string;
        readonly workflowId?: string | undefined;
        readonly workflowSha256: string;
        readonly workflowDigest: string;
        readonly packageDigests: readonly string[];
        readonly surface:
          | "prompt"
          | "agent-skill-resource"
          | "agent-skill-package"
          | "model-routing"
          | "phase-routing"
          | "child-specialist"
          | "supplemental-memory";
        readonly candidateDigest: string;
      };
    }
  | ExternalEvaluationProfileIdentity;

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
  kind: "filesystem-v1" | "agent-result-v1",
  evidence:
    | readonly EvaluationFilesystemAssertion[]
    | Pick<EvaluationAgentResultVerifierSource, "sha256" | "bytes">,
): string {
  const identity =
    kind === "filesystem-v1" ? { kind, assertions: evidence } : { kind, ...evidence };
  return createHash("sha256").update(canonicalEvaluationValue(identity)).digest("hex");
}

function isCanonicalRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function evaluationAdapterId<TId extends EvaluationAdapterId>(id: TId): TId {
  if (!EVALUATION_ADAPTER_REFERENCES.some((item) => item.id === id)) {
    throw new Error(`unsupported evaluation adapter "${id}"`);
  }
  return id;
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
