export const MIN_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS = 60_000;
export const MAX_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type CapabilityRepositorySchedulerStage =
  | "validate schedule"
  | "wait interval"
  | "observe clock"
  | "report status";

export class CapabilityRepositorySchedulerError extends Error {
  override readonly name = "CapabilityRepositorySchedulerError";
  readonly code = "capability_repository_scheduler_failed" as const;

  constructor(readonly stage: CapabilityRepositorySchedulerStage) {
    super(`Capability repository scheduler failed during ${stage}`);
  }
}

export type CapabilityRepositorySchedulerOutcome =
  | "scheduler_started"
  | "checked"
  | "check_failed"
  | "clock_rollback";

export interface CapabilityRepositorySchedulerStatus {
  readonly outcome: CapabilityRepositorySchedulerOutcome;
  readonly attemptedAt: string;
  readonly completedAt: string | null;
  readonly missedIntervals: number;
  readonly consecutiveFailures: number;
}

export interface RunCapabilityRepositorySchedulerInput {
  readonly intervalMs: number;
  readonly previousCompletedAt?: string;
  readonly signal: AbortSignal;
  readonly check: (signal: AbortSignal) => Promise<void>;
  readonly now: () => Date;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly observe: (status: CapabilityRepositorySchedulerStatus) => void | Promise<void>;
}

export async function runCapabilityRepositoryScheduler(
  input: RunCapabilityRepositorySchedulerInput,
): Promise<never> {
  if (
    !Number.isSafeInteger(input.intervalMs) ||
    input.intervalMs < MIN_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS ||
    input.intervalMs > MAX_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS
  ) {
    throw new CapabilityRepositorySchedulerError("validate schedule");
  }
  const previousCompletedAt = parsePreviousCompletion(input.previousCompletedAt);

  throwIfAborted(input.signal);
  let lastObservedAt = readClock(input.now);
  if (
    previousCompletedAt !== undefined &&
    previousCompletedAt.getTime() > lastObservedAt.getTime()
  ) {
    await reportClockRollback(input, lastObservedAt, 0, 0);
  }
  await reportStatus(input, {
    outcome: "scheduler_started",
    attemptedAt: lastObservedAt.toISOString(),
    completedAt: null,
    missedIntervals:
      previousCompletedAt === undefined
        ? 0
        : elapsedIntervals(previousCompletedAt, lastObservedAt, input.intervalMs),
    consecutiveFailures: 0,
  });
  throwIfAborted(input.signal);
  let consecutiveFailures = 0;
  while (true) {
    try {
      await input.wait(input.intervalMs, input.signal);
    } catch {
      throwIfAborted(input.signal);
      throw new CapabilityRepositorySchedulerError("wait interval");
    }
    throwIfAborted(input.signal);

    const attemptedAt = readClock(input.now);
    if (attemptedAt.getTime() < lastObservedAt.getTime()) {
      await reportClockRollback(input, attemptedAt, 0, consecutiveFailures);
    }
    const missedIntervals = Math.max(
      0,
      elapsedIntervals(lastObservedAt, attemptedAt, input.intervalMs) - 1,
    );
    lastObservedAt = attemptedAt;

    let outcome: "checked" | "check_failed" = "checked";
    try {
      throwIfAborted(input.signal);
      await input.check(input.signal);
      throwIfAborted(input.signal);
    } catch {
      throwIfAborted(input.signal);
      outcome = "check_failed";
    }
    consecutiveFailures = outcome === "checked" ? 0 : consecutiveFailures + 1;

    const completedAt = readClock(input.now);
    if (completedAt.getTime() < lastObservedAt.getTime()) {
      await reportClockRollback(input, completedAt, missedIntervals, consecutiveFailures);
    }
    lastObservedAt = completedAt;
    await reportStatus(input, {
      outcome,
      attemptedAt: attemptedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      missedIntervals,
      consecutiveFailures,
    });
    throwIfAborted(input.signal);
  }
}

function parsePreviousCompletion(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new CapabilityRepositorySchedulerError("validate schedule");
  }
  return parsed;
}

function elapsedIntervals(from: Date, to: Date, intervalMs: number): number {
  return Math.floor((to.getTime() - from.getTime()) / intervalMs);
}

function readClock(now: () => Date): Date {
  let value: Date;
  try {
    value = now();
  } catch {
    throw new CapabilityRepositorySchedulerError("observe clock");
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CapabilityRepositorySchedulerError("observe clock");
  }
  return new Date(value.getTime());
}

async function reportClockRollback(
  input: RunCapabilityRepositorySchedulerInput,
  observedAt: Date,
  missedIntervals: number,
  consecutiveFailures: number,
): Promise<never> {
  try {
    await input.observe({
      outcome: "clock_rollback",
      attemptedAt: observedAt.toISOString(),
      completedAt: null,
      missedIntervals,
      consecutiveFailures,
    });
  } catch {
    // The clock failure remains primary even if its observer also fails.
  }
  throw new CapabilityRepositorySchedulerError("observe clock");
}

async function reportStatus(
  input: RunCapabilityRepositorySchedulerInput,
  status: CapabilityRepositorySchedulerStatus,
): Promise<void> {
  try {
    await input.observe(Object.freeze(status));
  } catch {
    throwIfAborted(input.signal);
    throw new CapabilityRepositorySchedulerError("report status");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}
