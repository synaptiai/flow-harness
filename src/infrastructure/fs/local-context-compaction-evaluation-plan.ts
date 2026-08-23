import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  type ContextCompactionEvaluationPlanSource,
  type ContextCompactionEvaluationTaskSource,
  calculateContextCompactionEvaluationPlanDigest,
  calculateContextCompactionEvaluationVerifierDigest,
  createContextCompactionEvaluationSchedule,
  MAX_CONTEXT_COMPACTION_EVALUATION_PLAN_BYTES,
  parseContextCompactionEvaluationPlanText,
} from "../../domain/evaluation/context-compaction-evaluation.js";
import type { EvaluationTrialScheduleItem } from "../../domain/evaluation/plan.js";
import { compileWorkflowText } from "../../domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../domain/workflow/digest.js";
import type { CompiledWorkflow } from "../../domain/workflow/types.js";
import {
  type AdmittedEvaluationTask,
  type AdmittedFlowEvaluationProfile,
  assertClosedEvaluationWorkflowCapabilities,
  assertEvaluationWorkflowControls,
  EvaluationAdmissionError,
  MAX_EVALUATION_WORKFLOW_BYTES,
  observeEvaluationFixture,
  resolveAdmittedEvaluationPath,
  stableReadEvaluationFile,
} from "./local-evaluation-plan.js";

export type AdmittedContextCompactionEvaluationTask = Omit<
  AdmittedEvaluationTask,
  "partition" | "verifier"
> & {
  readonly partition: "holdout";
  readonly verifier: Extract<
    AdmittedEvaluationTask["verifier"],
    { readonly kind: "filesystem-v1" }
  >;
  readonly protectedConstraints: readonly string[];
  readonly constraintAssertionIndexes: readonly number[];
};

export interface AdmittedContextCompactionEvaluationPlan {
  readonly apiVersion: ContextCompactionEvaluationPlanSource["apiVersion"];
  readonly id: string;
  readonly planDigest: string;
  readonly sourcePath: string;
  readonly suite: {
    readonly id: string;
    readonly version: string;
    readonly tasks: readonly AdmittedContextCompactionEvaluationTask[];
  };
  readonly profile: Omit<AdmittedFlowEvaluationProfile, "id">;
  readonly controls: ContextCompactionEvaluationPlanSource["controls"];
  readonly seeds: readonly number[];
  readonly modes: ContextCompactionEvaluationPlanSource["modes"];
  readonly order: ContextCompactionEvaluationPlanSource["order"];
  readonly comparison: ContextCompactionEvaluationPlanSource["comparison"];
  readonly schedule: readonly EvaluationTrialScheduleItem[];
}

export async function admitLocalContextCompactionEvaluationPlan(
  planPath: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<AdmittedContextCompactionEvaluationPlan> {
  options.signal?.throwIfAborted();
  const absolutePlanPath = resolve(planPath);
  const planRoot = await realpath(dirname(absolutePlanPath));
  const canonicalPlanPath = join(planRoot, basename(absolutePlanPath));
  const planFile = await stableReadEvaluationFile(
    canonicalPlanPath,
    MAX_CONTEXT_COMPACTION_EVALUATION_PLAN_BYTES,
    "context compaction evaluation plan",
  );
  options.signal?.throwIfAborted();
  const source = parseContextCompactionEvaluationPlanText(
    planFile.content.toString("utf8"),
    basename(planPath),
  );
  const tasks = await Promise.all(
    source.suite.tasks.map(async (task) => await admitTask(planRoot, task)),
  );
  options.signal?.throwIfAborted();
  const workflowPath = await resolveAdmittedEvaluationPath(
    planRoot,
    source.profile.workflow,
    "file",
  );
  const workflowFile = await stableReadEvaluationFile(
    workflowPath,
    MAX_EVALUATION_WORKFLOW_BYTES,
    "context compaction evaluation workflow",
  );
  let compiled: CompiledWorkflow;
  try {
    compiled = compileWorkflowText(workflowFile.content.toString("utf8"), source.profile.workflow);
  } catch (error) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      `context compaction evaluation workflow cannot be compiled: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
  assertEvaluationWorkflowControls("context-compaction", compiled, source.controls);
  assertClosedEvaluationWorkflowCapabilities("context-compaction", compiled);
  if (compiled.nodes.some((node) => node.type === "child")) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      "context compaction evaluation child workflows are not measured by plan version 1",
    );
  }
  const profile = Object.freeze({
    adapter: source.profile.adapter,
    workflow: Object.freeze({
      sourceKind: "file" as const,
      sourcePath: workflowPath,
      provenance: source.profile.workflow,
      source: workflowFile.content.toString("utf8"),
      sourceSha256: workflowFile.sha256,
      workflowDigest: calculateWorkflowDigest(compiled),
      compiled,
    }),
  });
  const planDigest = calculateContextCompactionEvaluationPlanDigest({
    version: 1,
    apiVersion: source.apiVersion,
    id: source.metadata.id,
    suite: {
      id: source.suite.id,
      version: source.suite.version,
      tasks: tasks.map((task) => ({
        id: task.id,
        partition: task.partition,
        fixture: {
          provenance: task.fixture.provenance,
          digest: task.fixture.digest,
          entryCount: task.fixture.entryCount,
          logicalBytes: task.fixture.logicalBytes,
          instructionPath: task.fixture.instructionPath,
          instructionSha256: task.fixture.instructionSha256,
        },
        verifier: {
          kind: task.verifier.kind,
          digest: task.verifier.digest,
          assertionCount: task.verifier.assertions.length,
        },
        protectedConstraints: task.protectedConstraints,
        constraintAssertionIndexes: task.constraintAssertionIndexes,
      })),
    },
    profile: {
      adapter: profile.adapter,
      workflow: {
        provenance: profile.workflow.provenance,
        sourceSha256: profile.workflow.sourceSha256,
        workflowDigest: profile.workflow.workflowDigest,
      },
    },
    controls: source.controls,
    seeds: source.seeds,
    modes: source.modes,
    order: source.order,
    comparison: source.comparison,
  });
  const schedule = createContextCompactionEvaluationSchedule(
    planDigest,
    tasks.map((task) => task.id),
    source.seeds,
  );
  options.signal?.throwIfAborted();
  return Object.freeze({
    apiVersion: source.apiVersion,
    id: source.metadata.id,
    planDigest,
    sourcePath: canonicalPlanPath,
    suite: Object.freeze({
      id: source.suite.id,
      version: source.suite.version,
      tasks: Object.freeze(tasks),
    }),
    profile,
    controls: source.controls,
    seeds: source.seeds,
    modes: source.modes,
    order: source.order,
    comparison: source.comparison,
    schedule,
  });
}

async function admitTask(
  planRoot: string,
  task: ContextCompactionEvaluationTaskSource,
): Promise<AdmittedContextCompactionEvaluationTask> {
  const fixturePath = await resolveAdmittedEvaluationPath(planRoot, task.fixture, "directory");
  const snapshot = await observeEvaluationFixture(fixturePath, task.instruction);
  return Object.freeze({
    id: task.id,
    partition: task.partition,
    fixture: Object.freeze({
      sourceCwd: fixturePath,
      provenance: task.fixture,
      ...snapshot,
    }),
    verifier: Object.freeze({
      kind: task.verifier.kind,
      digest: calculateContextCompactionEvaluationVerifierDigest(task.verifier.assertions),
      assertions: task.verifier.assertions,
    }),
    protectedConstraints: task.protectedConstraints,
    constraintAssertionIndexes: task.constraintAssertionIndexes,
  });
}

function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
