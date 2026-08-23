import {
  type EvaluationTrialAttempt,
  parseEvaluationTrialAttempt,
} from "../domain/evaluation/attempt.js";
import { verifyEvaluationAgentResult } from "../domain/evaluation/agent-result-verifier.js";
import type { VerifyEvaluationWorkspaceRequest } from "../domain/evaluation/filesystem-verifier.js";
import type {
  EvaluationAgentResultVerifierSource,
  EvaluationFilesystemAssertion,
  EvaluationPlanSource,
  EvaluationProfileSource,
  EvaluationTrialScheduleItem,
} from "../domain/evaluation/plan.js";
import {
  type AcpQualificationObservation,
  createEvaluationTrialRecord,
  type EvaluationEnvironment,
  type EvaluationHarnessOutcome,
  type EvaluationMetrics,
  type EvaluationTrialRecord,
  type EvaluationVerificationOutcome,
  parseAcpQualificationObservation,
  parseEvaluationHarnessOutcome,
  parseEvaluationMetrics,
  parseEvaluationTrialRecord,
  parseEvaluationVerificationOutcome,
  unavailableEvaluationMetrics,
} from "../domain/evaluation/records.js";
import {
  type HarnessEvaluationAdapter,
  type HarnessEvaluationRequest,
  type HarnessEvaluationResult,
  HarnessUnsafeStateError,
} from "./evaluation-adapter.js";
import type { WorkspaceIsolator } from "./ports.js";

export interface EvaluationExecutionPlan {
  readonly planDigest: string;
  readonly purpose?: "acp-interoperability-v1";
  readonly schedule: readonly EvaluationTrialScheduleItem[];
  readonly controls: EvaluationPlanSource["controls"];
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
    readonly verifier:
      | {
          readonly kind: "filesystem-v1";
          readonly digest: string;
          readonly assertions: readonly EvaluationFilesystemAssertion[];
        }
      | (EvaluationAgentResultVerifierSource & { readonly digest: string });
  }[];
  readonly profiles: readonly {
    readonly id: string;
    readonly adapter: EvaluationProfileSource["adapter"];
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
  readonly attempts: {
    readonly active: EvaluationTrialAttempt | null;
    readonly begin: (attempt: EvaluationTrialAttempt) => Promise<void>;
    readonly update?: (attempt: EvaluationTrialAttempt) => Promise<void>;
    readonly recover?: (attempt: EvaluationTrialAttempt) => Promise<EvaluationTrialAttempt>;
    readonly complete: (attempt: EvaluationTrialAttempt) => Promise<void>;
  };
  readonly append: (record: EvaluationTrialRecord) => Promise<void>;
  readonly workspaceIsolator: WorkspaceIsolator;
  readonly observeFixture: (
    sourceCwd: string,
    instructionPath: string,
  ) => Promise<EvaluationFixtureObservation>;
  readonly resolveAdapter: (
    profileId: string,
    adapter: EvaluationProfileSource["adapter"],
  ) => HarnessEvaluationAdapter;
  readonly verifyWorkspace: (
    request: VerifyEvaluationWorkspaceRequest,
  ) => Promise<EvaluationVerificationOutcome>;
  readonly environment: Omit<EvaluationEnvironment, "workspaceBackend" | "workspaceSnapshotDigest">;
  readonly signal?: AbortSignal;
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

  if (input.attempts.active !== null) {
    let attempt = reconcileActiveAttempt(input.plan, records, input.attempts.active);
    if (attempt.adapter === "prime-agent-native-v1") {
      attempt = await recoverPrimeAttempt(attempt, input.attempts.recover);
    }
    const schedule = input.plan.schedule[records.length];
    const task = input.plan.tasks.find((item) => item.id === schedule?.taskId);
    if (schedule === undefined || task === undefined) {
      throw new Error("active evaluation attempt references a missing scheduled trial");
    }
    const record = createEvaluationTrialRecord({
      schedule,
      planDigest: input.plan.planDigest,
      previousDigest,
      startedAt: attempt.startedAt,
      completedAt: now().toISOString(),
      environment: {
        ...input.environment,
        workspaceBackend: attempt.workspace.backend,
        workspaceSnapshotDigest: attempt.workspace.snapshotDigest,
      },
      harness: {
        outcome: "crashed",
        runId: null,
        reason: "adapter execution was interrupted after its durable start record",
      },
      verification: notRun(task.verifier.digest),
      metrics: unavailableEvaluationMetrics(),
    });
    await input.append(record);
    records.push(record);
    previousDigest = record.recordDigest;
    await input.attempts.complete(attempt);
    await input.workspaceIsolator.cleanup(workspaceIdFor(attempt.trialId));
  }

  for (const schedule of input.plan.schedule.slice(records.length)) {
    if (isSignalAborted(input.signal)) {
      break;
    }
    const task = input.plan.tasks.find((item) => item.id === schedule.taskId);
    const profile = input.plan.profiles.find((item) => item.id === schedule.profileId);
    if (task === undefined || profile === undefined) {
      throw new Error(`evaluation schedule trial "${schedule.trialId}" references missing inputs`);
    }
    const workspaceId = workspaceIdFor(schedule.trialId);
    const startedAt = now().toISOString();
    let workspace: Awaited<ReturnType<WorkspaceIsolator["create"]>> | undefined;
    let harness: EvaluationHarnessOutcome = {
      outcome: "crashed",
      runId: null,
      reason: "evaluation trial did not produce harness evidence",
    };
    let metrics: EvaluationMetrics = unavailableEvaluationMetrics();
    let verification: EvaluationVerificationOutcome = notRun(task.verifier.digest);
    let qualification: AcpQualificationObservation | undefined;
    let attempt: EvaluationTrialAttempt | undefined;

    try {
      await input.workspaceIsolator.cleanup(workspaceId);
      assertEvaluationActive(input.signal);
      const sourceObservation = await input.observeFixture(
        task.fixture.sourceCwd,
        task.fixture.instructionPath,
      );
      assertEvaluationActive(input.signal);
      assertFixtureIdentity(
        task.fixture,
        sourceObservation,
        "source fixture drifted after admission",
      );
      const createdWorkspace = await input.workspaceIsolator.create({
        workspaceId,
        sourceCwd: task.fixture.sourceCwd,
      });
      assertEvaluationActive(input.signal);
      workspace = Object.freeze({ ...createdWorkspace });
      const isolatedObservation = await input.observeFixture(
        workspace.cwd,
        task.fixture.instructionPath,
      );
      assertEvaluationActive(input.signal);
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
      attempt = parseEvaluationTrialAttempt({
        version: 1,
        planDigest: input.plan.planDigest,
        position: schedule.position,
        trialId: schedule.trialId,
        taskId: schedule.taskId,
        profileId: schedule.profileId,
        adapter: profile.adapter,
        startedAt,
        workspace: {
          backend: workspace.backend,
          snapshotDigest: workspace.snapshotDigest,
        },
      });
      assertEvaluationActive(input.signal);
      try {
        await input.attempts.begin(attempt);
      } catch (error) {
        throw new EvaluationAttemptDurabilityError(error);
      }
      assertEvaluationActive(input.signal);
      let result: HarnessEvaluationResult | undefined;
      try {
        const durability =
          profile.adapter === "prime-agent-native-v1"
            ? createPrimeAttemptDurability(
                input.attempts.update,
                () => attempt,
                (updated) => {
                  attempt = updated;
                },
              )
            : undefined;
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
          controls: evaluationControlsForProfile(input.plan.controls, profile.id),
          ...(durability === undefined ? {} : { durability }),
        });
      } catch (error) {
        if (error instanceof HarnessUnsafeStateError) {
          throw error;
        }
        harness = { outcome: "crashed", runId: null, reason: boundedReason(error) };
        metrics = unavailableEvaluationMetrics();
      }
      if (result !== undefined) {
        try {
          harness = parseEvaluationHarnessOutcome(result.harness);
          metrics = parseEvaluationMetrics(result.metrics);
          if (result.qualification !== undefined) {
            if (task.verifier.kind !== "agent-result-v1") {
              throw new Error("adapter returned ACP qualification evidence for an ordinary trial");
            }
            qualification = parseAcpQualificationObservation(result.qualification);
          }
        } catch (error) {
          harness = {
            outcome: "malformed_output",
            runId: null,
            reason: `adapter returned invalid evidence: ${boundedReason(error)}`,
          };
          metrics = unavailableEvaluationMetrics();
          qualification = undefined;
        }
      }
      if (harness.outcome === "completed") {
        if (task.verifier.kind === "agent-result-v1") {
          verification = verifyEvaluationAgentResult(qualification, task.verifier);
        } else {
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
      }
    } catch (error) {
      if (error instanceof HarnessUnsafeStateError) {
        throw error;
      }
      if (error instanceof EvaluationAttemptDurabilityError) {
        throw error.cause;
      }
      harness = { outcome: "crashed", runId: null, reason: boundedReason(error) };
      metrics = unavailableEvaluationMetrics();
      qualification = undefined;
    }

    if (isSignalAborted(input.signal)) {
      harness = {
        outcome: "cancelled",
        runId: harness.runId,
        reason: boundedAbortReason(input.signal),
        ...(harness.runtime === undefined ? {} : { runtime: harness.runtime }),
      };
      metrics = unavailableEvaluationMetrics();
      verification = notRun(task.verifier.digest);
      qualification = undefined;
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
        ...(qualification === undefined ? {} : { qualification }),
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
    if (attempt !== undefined) {
      await input.attempts.complete(attempt);
    }
    await input.workspaceIsolator.cleanup(workspaceId);
    if (isSignalAborted(input.signal)) {
      break;
    }
  }
  return Object.freeze(records);
}

function evaluationControlsForProfile(
  controls: EvaluationPlanSource["controls"],
  profileId: string,
): HarnessEvaluationRequest["controls"] {
  const configuredRoute = controls.modelRoutes?.find((item) => item.profileId === profileId);
  if (controls.modelRoutes !== undefined && configuredRoute === undefined) {
    throw new Error(`evaluation profile "${profileId}" has no admitted model route`);
  }
  return Object.freeze({
    model: Object.freeze({ ...(configuredRoute?.route ?? controls.model) }),
    budget: controls.budget,
    network: controls.network,
    retry: controls.retry,
  });
}

async function recoverPrimeAttempt(
  attempt: EvaluationTrialAttempt,
  recover: ((attempt: EvaluationTrialAttempt) => Promise<EvaluationTrialAttempt>) | undefined,
): Promise<EvaluationTrialAttempt> {
  if (recover === undefined) {
    throw new HarnessUnsafeStateError("Prime OCI attempt requires recovery before replay");
  }
  try {
    const recovered = parseEvaluationTrialAttempt(await recover(attempt));
    assertRecoveredAttemptIdentity(attempt, recovered);
    if (
      recovered.ociLease !== undefined &&
      recovered.ociLease.state !== "removed" &&
      recovered.ociLease.state !== "absent"
    ) {
      throw new Error("Prime OCI recovery did not prove container removal");
    }
    return recovered;
  } catch (error) {
    if (error instanceof HarnessUnsafeStateError) {
      throw error;
    }
    throw new HarnessUnsafeStateError("Prime OCI attempt recovery did not prove safe removal", {
      cause: error,
    });
  }
}

function assertRecoveredAttemptIdentity(
  previous: EvaluationTrialAttempt,
  recovered: EvaluationTrialAttempt,
): void {
  const { ociLease: previousLease, ...previousBase } = previous;
  const { ociLease: recoveredLease, ...recoveredBase } = recovered;
  if (JSON.stringify(previousBase) !== JSON.stringify(recoveredBase)) {
    throw new Error("Prime OCI recovery changed the durable attempt identity");
  }
  if (previousLease === undefined && recoveredLease === undefined) {
    return;
  }
  if (previousLease === undefined || recoveredLease === undefined) {
    throw new Error("Prime OCI recovery removed the durable lease identity");
  }
  const { state: _previousState, ...previousIdentity } = previousLease;
  const { state: _recoveredState, ...recoveredIdentity } = recoveredLease;
  if (previousLease.state === "intent") {
    if (recoveredLease.state === "absent") {
      if (JSON.stringify(previousIdentity) !== JSON.stringify(recoveredIdentity)) {
        throw new Error("Prime OCI recovery changed the durable lease identity");
      }
      return;
    }
    const {
      containerId: _containerId,
      inspectedPolicyDigest: _policyDigest,
      ...recoveredBaseIdentity
    } = recoveredIdentity;
    if (JSON.stringify(previousIdentity) !== JSON.stringify(recoveredBaseIdentity)) {
      throw new Error("Prime OCI recovery changed the durable lease identity");
    }
    return;
  }
  if (JSON.stringify(previousIdentity) !== JSON.stringify(recoveredIdentity)) {
    throw new Error("Prime OCI recovery changed the durable lease identity");
  }
}

function createPrimeAttemptDurability(
  update: ((attempt: EvaluationTrialAttempt) => Promise<void>) | undefined,
  current: () => EvaluationTrialAttempt | undefined,
  setCurrent: (attempt: EvaluationTrialAttempt) => void,
): NonNullable<HarnessEvaluationRequest["durability"]> {
  if (update === undefined) {
    throw new Error("Prime adapter requires durable OCI lease updates");
  }
  return Object.freeze({
    updateOciLease: async (lease) => {
      const attempt = current();
      if (attempt === undefined) {
        throw new Error("Prime adapter has no durable active attempt");
      }
      const updated = parseEvaluationTrialAttempt({ ...attempt, ociLease: lease });
      await update(updated);
      setCurrent(updated);
    },
  });
}

class EvaluationAttemptDurabilityError extends Error {
  override readonly name = "EvaluationAttemptDurabilityError";

  constructor(override readonly cause: unknown) {
    super("evaluation adapter start record is not durable", { cause });
  }
}

function reconcileActiveAttempt(
  plan: EvaluationExecutionPlan,
  records: readonly EvaluationTrialRecord[],
  rawAttempt: EvaluationTrialAttempt,
): EvaluationTrialAttempt {
  const attempt = parseEvaluationTrialAttempt(rawAttempt);
  const schedule = plan.schedule[records.length];
  const profile = plan.profiles.find((item) => item.id === schedule?.profileId);
  if (
    schedule === undefined ||
    profile === undefined ||
    attempt.planDigest !== plan.planDigest ||
    attempt.position !== schedule.position ||
    attempt.trialId !== schedule.trialId ||
    attempt.taskId !== schedule.taskId ||
    attempt.profileId !== schedule.profileId ||
    attempt.adapter !== profile.adapter
  ) {
    throw new Error("active evaluation attempt contradicts the next scheduled trial");
  }
  return attempt;
}

function boundedAbortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  const text = reason instanceof Error ? reason.message : String(reason ?? "evaluation cancelled");
  return boundedReason(text);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function assertEvaluationActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error(boundedAbortReason(signal));
  }
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
  expected: Extract<
    EvaluationExecutionPlan["tasks"][number]["verifier"],
    { readonly kind: "filesystem-v1" }
  >,
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
