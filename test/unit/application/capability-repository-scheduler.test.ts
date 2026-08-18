import { describe, expect, it, vi } from "vitest";

import {
  CapabilityRepositorySchedulerError,
  type CapabilityRepositorySchedulerStatus,
  runCapabilityRepositoryScheduler,
} from "../../../src/application/capability-repository-scheduler.js";

const INTERVAL_MS = 60_000;

describe("capability repository scheduler", () => {
  it.each([INTERVAL_MS - 1, 24 * 60 * 60 * 1_000 + 1])(
    "rejects interval %d outside the bounded schedule",
    async (intervalMs) => {
      await expect(
        runCapabilityRepositoryScheduler({
          intervalMs,
          signal: new AbortController().signal,
          check: vi.fn(),
          now: () => new Date("2027-01-01T00:00:00.000Z"),
          wait: vi.fn(),
          observe: vi.fn(),
        }),
      ).rejects.toEqual(new CapabilityRepositorySchedulerError("validate schedule"));
    },
  );

  it.each([INTERVAL_MS, 24 * 60 * 60 * 1_000])(
    "accepts interval %d at the bounded schedule edge",
    async (intervalMs) => {
      const controller = new AbortController();
      const reason = new Error("stop after bounded wait");
      const wait = vi.fn(async () => {
        controller.abort(reason);
        throw reason;
      });

      await expect(
        runCapabilityRepositoryScheduler({
          intervalMs,
          signal: controller.signal,
          check: vi.fn(),
          now: () => new Date("2027-01-01T00:00:00.000Z"),
          wait,
          observe: vi.fn(),
        }),
      ).rejects.toBe(reason);

      expect(wait).toHaveBeenCalledWith(intervalMs, controller.signal);
    },
  );

  it("reports restart and missed intervals without catch-up work", async () => {
    const controller = new AbortController();
    const stopReason = new Error("stop scheduler");
    const statuses: CapabilityRepositorySchedulerStatus[] = [];

    await expect(
      runCapabilityRepositoryScheduler({
        intervalMs: INTERVAL_MS,
        previousCompletedAt: "2027-01-01T00:00:00.000Z",
        signal: controller.signal,
        now: sequenceClock([
          "2027-01-01T00:03:30.000Z",
          "2027-01-01T00:06:45.000Z",
          "2027-01-01T00:06:46.000Z",
        ]),
        wait: async () => undefined,
        check: async () => undefined,
        observe: async (status) => {
          statuses.push(status);
          if (status.outcome === "checked") {
            controller.abort(stopReason);
          }
        },
      }),
    ).rejects.toBe(stopReason);

    expect(statuses).toEqual([
      {
        outcome: "scheduler_started",
        attemptedAt: "2027-01-01T00:03:30.000Z",
        completedAt: null,
        missedIntervals: 3,
        consecutiveFailures: 0,
      },
      {
        outcome: "checked",
        attemptedAt: "2027-01-01T00:06:45.000Z",
        completedAt: "2027-01-01T00:06:46.000Z",
        missedIntervals: 2,
        consecutiveFailures: 0,
      },
    ]);
  });

  it("reports and stops when the clock is behind the durable pre-restart completion", async () => {
    const statuses: CapabilityRepositorySchedulerStatus[] = [];
    const wait = vi.fn();
    const check = vi.fn();

    await expect(
      runCapabilityRepositoryScheduler({
        intervalMs: INTERVAL_MS,
        previousCompletedAt: "2027-01-01T00:01:00.000Z",
        signal: new AbortController().signal,
        now: () => new Date("2027-01-01T00:00:59.999Z"),
        wait,
        check,
        observe: async (status) => {
          statuses.push(status);
        },
      }),
    ).rejects.toEqual(new CapabilityRepositorySchedulerError("observe clock"));

    expect(wait).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(statuses).toEqual([
      {
        outcome: "clock_rollback",
        attemptedAt: "2027-01-01T00:00:59.999Z",
        completedAt: null,
        missedIntervals: 0,
        consecutiveFailures: 0,
      },
    ]);
  });

  it("waits after each settled check without overlap or catch-up", async () => {
    const controller = new AbortController();
    const stopReason = new Error("stop scheduler");
    const events: string[] = [];
    let activeChecks = 0;
    let maximumActiveChecks = 0;
    const statuses: CapabilityRepositorySchedulerStatus[] = [];

    await expect(
      runCapabilityRepositoryScheduler({
        intervalMs: INTERVAL_MS,
        signal: controller.signal,
        now: sequenceClock([
          "2027-01-01T00:00:00.000Z",
          "2027-01-01T00:01:00.000Z",
          "2027-01-01T00:01:01.000Z",
          "2027-01-01T00:02:01.000Z",
          "2027-01-01T00:02:02.000Z",
        ]),
        wait: async (milliseconds) => {
          events.push(`wait:${milliseconds}`);
        },
        check: async () => {
          events.push("check");
          activeChecks += 1;
          maximumActiveChecks = Math.max(maximumActiveChecks, activeChecks);
          await Promise.resolve();
          activeChecks -= 1;
        },
        observe: async (status) => {
          statuses.push(status);
          events.push(`observe:${status.outcome}`);
          if (statuses.filter(({ outcome }) => outcome === "checked").length === 2) {
            controller.abort(stopReason);
          }
        },
      }),
    ).rejects.toBe(stopReason);

    expect(maximumActiveChecks).toBe(1);
    expect(events).toEqual([
      "observe:scheduler_started",
      `wait:${INTERVAL_MS}`,
      "check",
      "observe:checked",
      `wait:${INTERVAL_MS}`,
      "check",
      "observe:checked",
    ]);
  });

  it("reports a private check failure and waits before trying again", async () => {
    const controller = new AbortController();
    const stopReason = new Error("stop scheduler");
    const privateFailure = new Error("PRIVATE_REPOSITORY_RESPONSE");
    const statuses: CapabilityRepositorySchedulerStatus[] = [];
    let checks = 0;

    await expect(
      runCapabilityRepositoryScheduler({
        intervalMs: INTERVAL_MS,
        signal: controller.signal,
        now: sequenceClock([
          "2027-01-01T00:00:00.000Z",
          "2027-01-01T00:01:00.000Z",
          "2027-01-01T00:01:01.000Z",
          "2027-01-01T00:02:01.000Z",
          "2027-01-01T00:02:02.000Z",
          "2027-01-01T00:03:02.000Z",
          "2027-01-01T00:03:03.000Z",
        ]),
        wait: async () => undefined,
        check: async () => {
          checks += 1;
          if (checks <= 2) {
            throw privateFailure;
          }
        },
        observe: async (status) => {
          statuses.push(status);
          if (status.outcome === "checked") {
            controller.abort(stopReason);
          }
        },
      }),
    ).rejects.toBe(stopReason);

    expect(statuses.map(({ outcome }) => outcome)).toEqual([
      "scheduler_started",
      "check_failed",
      "check_failed",
      "checked",
    ]);
    expect(statuses.map(({ consecutiveFailures }) => consecutiveFailures)).toEqual([0, 1, 2, 0]);
    expect(JSON.stringify(statuses)).not.toContain("PRIVATE");
  });

  it("stops on a check failure that the caller marks non-retryable", async () => {
    const terminalFailure = new Error("replacement settlement is uncertain");
    const wait = vi.fn().mockResolvedValue(undefined);
    const statuses: CapabilityRepositorySchedulerStatus[] = [];

    await expect(
      runCapabilityRepositoryScheduler({
        intervalMs: INTERVAL_MS,
        signal: new AbortController().signal,
        now: sequenceClock(["2027-01-01T00:00:00.000Z", "2027-01-01T00:01:00.000Z"]),
        wait,
        check: async () => {
          throw terminalFailure;
        },
        shouldRetryCheckFailure: (error) => error !== terminalFailure,
        observe: async (status) => {
          statuses.push(status);
        },
      }),
    ).rejects.toBe(terminalFailure);

    expect(wait).toHaveBeenCalledOnce();
    expect(statuses.map(({ outcome }) => outcome)).toEqual(["scheduler_started"]);
  });

  it("reports and stops on a backward clock before requesting another check", async () => {
    const statuses: CapabilityRepositorySchedulerStatus[] = [];
    const check = vi.fn();

    await expect(
      runCapabilityRepositoryScheduler({
        intervalMs: INTERVAL_MS,
        signal: new AbortController().signal,
        now: sequenceClock(["2027-01-01T00:01:00.000Z", "2027-01-01T00:00:59.999Z"]),
        wait: async () => undefined,
        check,
        observe: async (status) => {
          statuses.push(status);
        },
      }),
    ).rejects.toEqual(new CapabilityRepositorySchedulerError("observe clock"));

    expect(check).not.toHaveBeenCalled();
    expect(statuses).toEqual([
      {
        outcome: "scheduler_started",
        attemptedAt: "2027-01-01T00:01:00.000Z",
        completedAt: null,
        missedIntervals: 0,
        consecutiveFailures: 0,
      },
      {
        outcome: "clock_rollback",
        attemptedAt: "2027-01-01T00:00:59.999Z",
        completedAt: null,
        missedIntervals: 0,
        consecutiveFailures: 0,
      },
    ]);
  });

  it("preserves the exact cancellation reason before a check begins", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    const check = vi.fn();

    await expect(
      runCapabilityRepositoryScheduler({
        intervalMs: INTERVAL_MS,
        signal: controller.signal,
        now: () => new Date("2027-01-01T00:00:00.000Z"),
        wait: async () => {
          controller.abort(reason);
        },
        check,
        observe: vi.fn(),
      }),
    ).rejects.toBe(reason);
    expect(check).not.toHaveBeenCalled();
  });
});

function sequenceClock(values: readonly string[]): () => Date {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error("clock fixture exhausted");
    }
    return new Date(value);
  };
}
