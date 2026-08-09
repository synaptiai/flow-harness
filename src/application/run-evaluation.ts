import type { VerifyEvaluationWorkspaceRequest } from "../domain/evaluation/filesystem-verifier.js";
import type {
  EvaluationFilesystemAssertion,
  EvaluationTrialScheduleItem,
} from "../domain/evaluation/plan.js";
import {
  createEvaluationTrialRecord,
  type EvaluationEnvironment,
  type EvaluationHarnessOutcome,
  type EvaluationMetrics,
  type EvaluationTrialRecord,
  type EvaluationVerificationOutcome,
  parseEvaluationHarnessOutcome,
  parseEvaluationMetrics,
  parseEvaluationTrialRecord,
  parseEvaluationVerificationOutcome,
  unavailableEvaluationMetrics,
} from "../domain/evaluation/records.js";
import type {
  HarnessEvaluationAdapter,
  HarnessEvaluationRequest,
  HarnessEvaluationResult,
} from "./evaluation-adapter.js";
import type { WorkspaceIsolator } from "./ports.js";

export interface EvaluationExecutionPlan {
  readonly planDigest: string;
  readonly schedule: readonly EvaluationTrialScheduleItem[];
  readonly controls: HarnessEvaluationRequest["controls"];
  readonly tasks: readonly {
    readonly id: string;
    readonly fixture: {
      readonly sourceCwd: string;
      readonly digest: string;
      readonly entryCount: number;
      readonly logicalBytes: number;
      readonly instructionPath: string;
      readonly instructionSha256: string;
    };
    readonly verifier: {
      readonly kind: "filesystem-v1";
      readonly digest: string;
      readonly assertions: readonly EvaluationFilesystemAssertion[];
    };
  }[];
  readonly profiles: readonly {
    readonly id: string;
    readonly adapter: "flow-workflow-v1";
  }[];
}

export interface EvaluationFixtureObservation {
  readonly digest: string;
  readonly entryCount: number;
  readonly logicalBytes: number;
  readonly instructionPath: string;
  readonly instructionSha256: string;
}

export interface RunEvaluationTrialsInput {
  readonly plan: EvaluationExecutionPlan;
  readonly committedRecords: readonly EvaluationTrialRecord[];
  readonly append: (record: EvaluationTrialRecord) => Promise<void>;
  readonly workspaceIsolator: WorkspaceIsolator;
  readonly observeFixture: (
    sourceCwd: string,
    instructionPath: string,
  ) => Promise<EvaluationFixtureObservation>;
  readonly resolveAdapter: (
    profileId: string,
    adapter: "flow-workflow-v1",
  ) => HarnessEvaluationAdapter;
  readonly verifyWorkspace: (
    request: VerifyEvaluationWorkspaceRequest,
  ) => Promise<EvaluationVerificationOutcome>;
  readonly environment: Omit<EvaluationEnvironment, "workspaceBackend" | "workspaceSnapshotDigest">;
  readonly now?: () => Date;
}

export async function runEvaluationTrials(
  input: RunEvaluationTrialsInput,
): Promise<readonly EvaluationTrialRecord[]> {
  const records = validateRunnerPrefix(input.plan, input.committedRecords);
  const now = input.now ?? (() => new Date());
  let previousDigest = records.at(-1)?.recordDigest ?? null;

  for (const record of records) {
    await input.workspaceIsolator.cleanup(workspaceIdFor(record.trialId));
  }

  for (const schedule of input.plan.schedule.slice(records.length)) {
    const task = input.plan.tasks.find((item) => item.id === schedule.taskId);
    const profile = input.plan.profiles.find((item) => item.id === schedule.profileId);
    if (task === undefined || profile === undefined) {
      throw new Error(`evaluation schedule trial "${schedule.trialId}" references missing inputs`);
    }
    const workspaceId = workspaceIdFor(schedule.trialId);
    await input.workspaceIsolator.cleanup(workspaceId);
    const startedAt = now().toISOString();
    let workspace: Awaited<ReturnType<WorkspaceIsolator["create"]>> | undefined;
    let harness: EvaluationHarnessOutcome = {
      outcome: "crashed",
      runId: null,
      reason: "evaluation trial did not produce harness evidence",
    };
    let metrics: EvaluationMetrics = unavailableEvaluationMetrics();
    let verification: EvaluationVerificationOutcome = notRun(task.verifier.digest);

    try {
      const sourceObservation = await input.observeFixture(
        task.fixture.sourceCwd,
        task.fixture.instructionPath,
      );
      assertFixtureIdentity(
        task.fixture,
        sourceObservation,
        "source fixture drifted after admission",
      );
      const createdWorkspace = await input.workspaceIsolator.create({
        workspaceId,
        sourceCwd: task.fixture.sourceCwd,
      });
      workspace = Object.freeze({ ...createdWorkspace });
      const isolatedObservation = await input.observeFixture(
        workspace.cwd,
        task.fixture.instructionPath,
      );
      assertFixtureIdentity(
        task.fixture,
        isolatedObservation,
        "isolated fixture does not match its admitted source",
      );
      const adapter = input.resolveAdapter(profile.id, profile.adapter);
      if (adapter.kind !== profile.adapter) {
        throw new Error(
          `adapter "${adapter.kind}" cannot execute profile adapter "${profile.adapter}"`,
        );
      }
      let result: HarnessEvaluationResult | undefined;
      try {
        result = await adapter.run({
          planDigest: input.plan.planDigest,
          trial: Object.freeze({
            trialId: schedule.trialId,
            position: schedule.position,
            taskId: schedule.taskId,
            profileId: schedule.profileId,
            seed: schedule.seed,
            repetition: schedule.repetition,
          }),
          workspace,
          instruction: Object.freeze({
            path: task.fixture.instructionPath,
            sha256: task.fixture.instructionSha256,
          }),
          controls: input.plan.controls,
        });
      } catch (error) {
        harness = { outcome: "crashed", runId: null, reason: boundedReason(error) };
        metrics = unavailableEvaluationMetrics();
      }
      if (result !== undefined) {
        try {
          harness = parseEvaluationHarnessOutcome(result.harness);
          metrics = parseEvaluationMetrics(result.metrics);
        } catch (error) {
          harness = {
            outcome: "malformed_output",
            runId: null,
            reason: `adapter returned invalid evidence: ${boundedReason(error)}`,
          };
          metrics = unavailableEvaluationMetrics();
        }
      }
      if (harness.outcome === "completed") {
        try {
          verification = reconcileVerificationEvidence(
            await input.verifyWorkspace({
              workspace,
              expectedIdentity: Object.freeze({
                workspaceId: workspace.workspaceId,
                backend: workspace.backend,
                snapshotDigest: workspace.snapshotDigest,
              }),
              verifier: task.verifier,
            }),
            task.verifier,
          );
        } catch (error) {
          verification = verifierError(
            task.verifier.digest,
            `verifier returned invalid evidence: ${boundedReason(error)}`,
          );
        }
      }
    } catch (error) {
      harness = { outcome: "crashed", runId: null, reason: boundedReason(error) };
      metrics = unavailableEvaluationMetrics();
    }

    const completedAt = now().toISOString();
    let record: EvaluationTrialRecord;
    try {
      record = createEvaluationTrialRecord({
        schedule,
        planDigest: input.plan.planDigest,
        previousDigest,
        startedAt,
        completedAt,
        environment: {
          ...input.environment,
          workspaceBackend: "reflink-copy-v1",
          workspaceSnapshotDigest: workspace?.snapshotDigest ?? null,
        },
        harness,
        verification,
        metrics,
      });
    } catch (error) {
      record = createEvaluationTrialRecord({
        schedule,
        planDigest: input.plan.planDigest,
        previousDigest,
        startedAt,
        completedAt,
        environment: {
          ...input.environment,
          workspaceBackend: "reflink-copy-v1",
          workspaceSnapshotDigest: workspace?.snapshotDigest ?? null,
        },
        harness: {
          outcome: "malformed_output",
          runId: null,
          reason: `adapter or verifier returned invalid evidence: ${boundedReason(error)}`,
        },
        verification: notRun(task.verifier.digest),
        metrics: unavailableEvaluationMetrics(),
      });
    }
    await input.append(record);
    records.push(record);
    previousDigest = record.recordDigest;
    await input.workspaceIsolator.cleanup(workspaceId);
  }
  return Object.freeze(records);
}

function workspaceIdFor(trialId: string): string {
  return `workspace-${trialId}`;
}

function validateRunnerPrefix(
  plan: EvaluationExecutionPlan,
  rawRecords: readonly EvaluationTrialRecord[],
): EvaluationTrialRecord[] {
  if (rawRecords.length > plan.schedule.length) {
    throw new Error("evaluation record prefix exceeds its admitted schedule");
  }
  const records: EvaluationTrialRecord[] = [];
  let previousDigest: string | null = null;
  for (const [index, rawRecord] of rawRecords.entries()) {
    const record = parseEvaluationTrialRecord(rawRecord);
    const scheduled = plan.schedule[index];
    if (
      scheduled === undefined ||
      record.planDigest !== plan.planDigest ||
      record.position !== scheduled.position ||
      record.trialId !== scheduled.trialId ||
      record.taskId !== scheduled.taskId ||
      record.profileId !== scheduled.profileId ||
      record.seed !== scheduled.seed ||
      record.repetition !== scheduled.repetition ||
      record.previousDigest !== previousDigest
    ) {
      throw new Error(`evaluation record ${index + 1} contradicts the admitted schedule`);
    }
    records.push(record);
    previousDigest = record.recordDigest;
  }
  return records;
}

function assertFixtureIdentity(
  expected: EvaluationFixtureObservation,
  actual: EvaluationFixtureObservation,
  message: string,
): void {
  if (
    expected.digest !== actual.digest ||
    expected.entryCount !== actual.entryCount ||
    expected.logicalBytes !== actual.logicalBytes ||
    expected.instructionPath !== actual.instructionPath ||
    expected.instructionSha256 !== actual.instructionSha256
  ) {
    throw new Error(message);
  }
}

function notRun(verifierDigest: string): EvaluationVerificationOutcome {
  return { outcome: "not_run", verifierDigest, assertions: [] };
}

function verifierError(verifierDigest: string, reason: string): EvaluationVerificationOutcome {
  return {
    outcome: "error",
    verifierDigest,
    assertions: [],
    reason: reason.slice(0, 4_096),
  };
}

function reconcileVerificationEvidence(
  raw: unknown,
  expected: EvaluationExecutionPlan["tasks"][number]["verifier"],
): EvaluationVerificationOutcome {
  const verification = parseEvaluationVerificationOutcome(raw);
  if (verification.verifierDigest !== expected.digest) {
    throw new Error("verifier evidence digest does not match the admitted verifier");
  }
  if (verification.outcome === "not_run") {
    throw new Error("a completed harness trial requires verifier evidence");
  }
  if (
    (verification.outcome === "accepted" || verification.outcome === "rejected") &&
    verification.assertions.length !== expected.assertions.length
  ) {
    throw new Error("verifier evidence does not cover every admitted assertion");
  }
  if (verification.assertions.length > expected.assertions.length) {
    throw new Error("verifier evidence contains undeclared assertions");
  }
  for (const [index, evidence] of verification.assertions.entries()) {
    const assertion = expected.assertions[index];
    if (
      assertion === undefined ||
      evidence.kind !== assertion.kind ||
      evidence.path !== assertion.path
    ) {
      throw new Error(`verifier evidence assertion ${index + 1} contradicts admission`);
    }
    if (assertion.kind === "sha256") {
      if (evidence.observedSha256 === undefined) {
        if (evidence.outcome || evidence.reason === undefined) {
          throw new Error(
            `verifier SHA-256 evidence assertion ${index + 1} is missing its observed digest`,
          );
        }
      } else if (evidence.outcome !== (evidence.observedSha256 === assertion.value)) {
        throw new Error(
          `verifier SHA-256 evidence assertion ${index + 1} contradicts its observed digest`,
        );
      }
    } else if (evidence.observedSha256 !== undefined) {
      throw new Error(`non-SHA verifier evidence assertion ${index + 1} contains a digest`);
    }
  }
  return verification;
}

function boundedReason(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
  } catch {
    return "unprintable runtime error";
  }
}
