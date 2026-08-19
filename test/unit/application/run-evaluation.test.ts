import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type HarnessEvaluationRequest,
  HarnessUnsafeStateError,
} from "../../../src/application/evaluation-adapter.js";
import {
  type RunEvaluationTrialsInput,
  runEvaluationTrials as runEvaluationTrialsApplication,
} from "../../../src/application/run-evaluation.js";
import { createEvaluationSchedule } from "../../../src/domain/evaluation/plan.js";
import {
  type EvaluationTrialRecord,
  unavailableEvaluationMetrics,
} from "../../../src/domain/evaluation/records.js";

const temporaryDirectories: string[] = [];

function runEvaluationTrials(
  input: Omit<RunEvaluationTrialsInput, "attempts"> &
    Partial<Pick<RunEvaluationTrialsInput, "attempts">>,
) {
  return runEvaluationTrialsApplication({
    attempts: {
      active: null,
      begin: async () => undefined,
      complete: async () => undefined,
    },
    ...input,
  });
}

function primeOciLease(trialId: string) {
  const ownerNonce = "a".repeat(64);
  const imageId = `sha256:${"b".repeat(64)}` as const;
  const policyDigest = "c".repeat(64);
  return {
    version: 1 as const,
    adapter: "prime-agent-native-v1" as const,
    state: "intent" as const,
    ownerNonce,
    containerName: `flow-prime-${"d".repeat(32)}` as const,
    labels: {
      evaluationId: "evaluation-run",
      trialId,
      ownerNonce,
      imageId,
      policyDigest,
    },
    imageId,
    policyDigest,
    fixtureDigest: "e".repeat(64),
    engineEndpoint: {
      socketPath: "/var/run/docker.sock" as const,
      device: 1,
      inode: 2,
      uid: 0,
      gid: 999,
      mode: 0o660,
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("evaluation trial runner", () => {
  it("sends each paired profile only its exact admitted model route", async () => {
    const root = await temporaryDirectory();
    const base = executionPlan(root);
    const plan = {
      ...base,
      controls: Object.freeze({
        ...base.controls,
        modelRoutes: Object.freeze([
          Object.freeze({
            profileId: "baseline",
            nodeId: "implement",
            route: Object.freeze({ provider: "test", id: "deterministic", thinking: "medium" }),
          }),
          Object.freeze({
            profileId: "candidate",
            nodeId: "implement",
            route: Object.freeze({ provider: "openai", id: "gpt-5.4", thinking: "high" }),
          }),
        ] as const),
      }),
    };
    const observed = new Map<string, HarnessEvaluationRequest["controls"]>();

    await runEvaluationTrials({
      plan,
      committedRecords: [],
      append: async () => undefined,
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "flow-workflow-v1",
        run: async (request) => {
          observed.set(request.trial.profileId, request.controls);
          return {
            harness: { outcome: "completed", runId: "durable-run", reason: null },
            metrics: unavailableEvaluationMetrics(),
          };
        },
      }),
      verifyWorkspace: async (request) => ({
        outcome: "accepted",
        verifierDigest: request.verifier.digest,
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      }),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(observed.get("baseline")?.model).toEqual({
      provider: "test",
      id: "deterministic",
      thinking: "medium",
    });
    expect(observed.get("candidate")?.model).toEqual({
      provider: "openai",
      id: "gpt-5.4",
      thinking: "high",
    });
    expect(observed.get("candidate")).not.toHaveProperty("modelRoutes");
  });

  it("keeps private verifier bodies outside the adapter and records verifier-authoritative failure", async () => {
    const root = await temporaryDirectory();
    const plan = executionPlan(root);
    let adapterRequest: HarnessEvaluationRequest | undefined;
    let privatePath: string | undefined;
    const appended: EvaluationTrialRecord[] = [];

    const workspaceIsolator = isolator(root);
    const records = await runEvaluationTrials({
      plan,
      committedRecords: [],
      append: async (record) => {
        appended.push(record);
      },
      workspaceIsolator,
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "flow-workflow-v1",
        run: async (request) => {
          adapterRequest = request;
          expect(Object.isFrozen(request.workspace)).toBe(true);
          return {
            harness: { outcome: "completed", runId: "durable-run", reason: null },
            metrics: unavailableEvaluationMetrics(),
          };
        },
      }),
      verifyWorkspace: async (request) => {
        privatePath = request.verifier.assertions[0]?.path;
        return {
          outcome: "rejected",
          verifierDigest: request.verifier.digest,
          assertions: [{ kind: "exists", path: "RESULT.md", outcome: false }],
        };
      },
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(records).toHaveLength(2);
    expect(appended).toEqual(records);
    expect(records[0]).toMatchObject({ classification: "false_completion" });
    expect(adapterRequest).toBeDefined();
    expect(JSON.stringify(adapterRequest)).not.toContain("RESULT.md");
    expect(privatePath).toBe("RESULT.md");
    expect(workspaceIsolator.cleanup).toHaveBeenCalledTimes(4);
    expect(workspaceIsolator.cleanup.mock.calls).toEqual([
      [`workspace-${plan.schedule[0]?.trialId}`],
      [`workspace-${plan.schedule[0]?.trialId}`],
      [`workspace-${plan.schedule[1]?.trialId}`],
      [`workspace-${plan.schedule[1]?.trialId}`],
    ]);
    const createdWorkspaces = await Promise.all(
      workspaceIsolator.create.mock.results.map((result) => result.value),
    );
    expect(new Set(createdWorkspaces.map((workspace) => workspace.cwd)).size).toBe(2);

    const resumedIsolator = isolator(root);
    const resumedAdapter = vi.fn();
    await expect(
      runEvaluationTrials({
        plan,
        committedRecords: records,
        append: async () => {
          throw new Error("complete evaluation must not append");
        },
        workspaceIsolator: resumedIsolator,
        observeFixture: async () => fixtureSnapshot(),
        resolveAdapter: () => ({ kind: "flow-workflow-v1", run: resumedAdapter }),
        verifyWorkspace: async () => {
          throw new Error("complete evaluation must not verify");
        },
        now: monotonicDates(),
        environment: testEnvironment(),
      }),
    ).resolves.toEqual(records);
    expect(resumedAdapter).not.toHaveBeenCalled();
    expect(resumedIsolator.cleanup.mock.calls).toEqual([
      [`workspace-${plan.schedule[0]?.trialId}`],
      [`workspace-${plan.schedule[1]?.trialId}`],
    ]);
  });

  it("resumes only the exact missing suffix after a committed prefix", async () => {
    const root = await temporaryDirectory();
    const plan = executionPlan(root);
    const firstPass = await runEvaluationTrials({
      plan,
      committedRecords: [],
      append: async () => undefined,
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "flow-workflow-v1",
        run: async () => ({
          harness: { outcome: "completed", runId: "first-pass", reason: null },
          metrics: unavailableEvaluationMetrics(),
        }),
      }),
      verifyWorkspace: async (request) => ({
        outcome: "accepted",
        verifierDigest: request.verifier.digest,
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      }),
      now: monotonicDates(),
      environment: testEnvironment(),
    });
    const adapter = vi.fn(async () => ({
      harness: { outcome: "completed" as const, runId: "resumed-run", reason: null },
      metrics: unavailableEvaluationMetrics(),
    }));
    const appended: EvaluationTrialRecord[] = [];
    const resumedIsolator = isolator(root);

    const resumed = await runEvaluationTrials({
      plan,
      committedRecords: firstPass.slice(0, 1),
      append: async (record) => {
        appended.push(record);
      },
      workspaceIsolator: resumedIsolator,
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({ kind: "flow-workflow-v1", run: adapter }),
      verifyWorkspace: async (request) => ({
        outcome: "accepted",
        verifierDigest: request.verifier.digest,
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      }),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.position).toBe(2);
    expect(resumed[0]).toStrictEqual(firstPass[0]);
    expect(resumedIsolator.cleanup.mock.calls).toEqual([
      [`workspace-${plan.schedule[0]?.trialId}`],
      [`workspace-${plan.schedule[1]?.trialId}`],
      [`workspace-${plan.schedule[1]?.trialId}`],
    ]);
  });

  it("writes durable adapter start before execution and retires it after terminal append", async () => {
    const root = await temporaryDirectory();
    const plan = executionPlan(root);
    const events: string[] = [];

    const records = await runEvaluationTrials({
      plan,
      committedRecords: [],
      attempts: {
        active: null,
        begin: async (attempt) => {
          events.push(`begin:${attempt.position}`);
        },
        complete: async (attempt) => {
          events.push(`complete:${attempt.position}`);
        },
      },
      append: async (record) => {
        events.push(`append:${record.position}`);
      },
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "flow-workflow-v1",
        run: async (request) => {
          events.push(`adapter:${request.trial.position}`);
          return {
            harness: { outcome: "completed", runId: "durable-run", reason: null },
            metrics: unavailableEvaluationMetrics(),
          };
        },
      }),
      verifyWorkspace: async (request) => ({
        outcome: "accepted",
        verifierDigest: request.verifier.digest,
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      }),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(records).toHaveLength(2);
    expect(events).toEqual([
      "begin:1",
      "adapter:1",
      "append:1",
      "complete:1",
      "begin:2",
      "adapter:2",
      "append:2",
      "complete:2",
    ]);
  });

  it("gives only a Prime adapter one durable OCI lease updater", async () => {
    const root = await temporaryDirectory();
    const base = executionPlan(root);
    const plan: RunEvaluationTrialsInput["plan"] = {
      ...base,
      profiles: base.profiles.map((profile) => ({
        ...profile,
        adapter: "prime-agent-native-v1" as const,
      })),
    };
    const updates: unknown[] = [];
    const completions: unknown[] = [];

    await runEvaluationTrials({
      plan,
      committedRecords: [],
      attempts: {
        active: null,
        begin: async () => undefined,
        update: async (attempt) => {
          updates.push(attempt);
        },
        complete: async (attempt) => {
          completions.push(attempt);
        },
      },
      append: async () => undefined,
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "prime-agent-native-v1",
        run: async (request) => {
          expect(request.durability).toBeDefined();
          await request.durability?.updateOciLease(primeOciLease(request.trial.trialId));
          return {
            harness: { outcome: "completed", runId: "prime-run", reason: null },
            metrics: unavailableEvaluationMetrics(),
          };
        },
      }),
      verifyWorkspace: async (request) => ({
        outcome: "accepted",
        verifierDigest: request.verifier.digest,
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      }),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(updates).toHaveLength(2);
    expect(completions).toEqual(updates);
  });

  it("leaves an unsafe Prime attempt active without a terminal record", async () => {
    const root = await temporaryDirectory();
    const base = executionPlan(root);
    const plan: RunEvaluationTrialsInput["plan"] = {
      ...base,
      profiles: base.profiles.map((profile) => ({
        ...profile,
        adapter: "prime-agent-native-v1" as const,
      })),
    };
    const append = vi.fn();
    const complete = vi.fn();

    await expect(
      runEvaluationTrials({
        plan,
        committedRecords: [],
        attempts: {
          active: null,
          begin: vi.fn(async () => undefined),
          update: vi.fn(async () => undefined),
          complete,
        },
        append,
        workspaceIsolator: isolator(root),
        observeFixture: async () => fixtureSnapshot(),
        resolveAdapter: () => ({
          kind: "prime-agent-native-v1",
          run: async () => {
            throw new HarnessUnsafeStateError("container removal is not confirmed");
          },
        }),
        verifyWorkspace: vi.fn(),
        now: monotonicDates(),
        environment: testEnvironment(),
      }),
    ).rejects.toThrow(/removal is not confirmed/i);

    expect(append).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("converts an unresolved durable start into failure without a second adapter call", async () => {
    const root = await temporaryDirectory();
    const plan = executionPlan(root);
    const activeSchedule = plan.schedule[0];
    if (activeSchedule === undefined) {
      throw new Error("missing active schedule item");
    }
    const adapter = vi.fn(async () => ({
      harness: { outcome: "completed" as const, runId: "second-trial", reason: null },
      metrics: unavailableEvaluationMetrics(),
    }));
    const began: number[] = [];
    const completed: number[] = [];

    const records = await runEvaluationTrials({
      plan,
      committedRecords: [],
      attempts: {
        active: {
          version: 1,
          planDigest: plan.planDigest,
          position: activeSchedule.position,
          trialId: activeSchedule.trialId,
          taskId: activeSchedule.taskId,
          profileId: activeSchedule.profileId,
          adapter: "flow-workflow-v1",
          startedAt: "2026-08-09T09:59:00.000Z",
          workspace: {
            backend: "reflink-copy-v1",
            snapshotDigest: "e".repeat(64),
          },
        },
        begin: async (attempt) => {
          began.push(attempt.position);
        },
        complete: async (attempt) => {
          completed.push(attempt.position);
        },
      },
      append: async () => undefined,
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({ kind: "flow-workflow-v1", run: adapter }),
      verifyWorkspace: async (request) => ({
        outcome: "accepted",
        verifierDigest: request.verifier.digest,
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      }),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      startedAt: "2026-08-09T09:59:00.000Z",
      classification: "harness_failure",
      harness: {
        outcome: "crashed",
        reason: expect.stringMatching(/interrupted.*durable.*start/i),
      },
      environment: { workspaceSnapshotDigest: "e".repeat(64) },
    });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(began).toEqual([2]);
    expect(completed).toEqual([1, 2]);
  });

  it("recovers an active Prime OCI lease before it records interruption", async () => {
    const root = await temporaryDirectory();
    const base = executionPlan(root);
    const plan: RunEvaluationTrialsInput["plan"] = {
      ...base,
      profiles: base.profiles.map((profile) => ({
        ...profile,
        adapter: "prime-agent-native-v1" as const,
      })),
    };
    const schedule = plan.schedule[0];
    if (schedule === undefined) {
      throw new Error("missing active Prime schedule item");
    }
    const intent = primeOciLease(schedule.trialId);
    const active = {
      version: 1 as const,
      planDigest: plan.planDigest,
      position: schedule.position,
      trialId: schedule.trialId,
      taskId: schedule.taskId,
      profileId: schedule.profileId,
      adapter: "prime-agent-native-v1" as const,
      startedAt: "2026-08-09T09:59:00.000Z",
      workspace: {
        backend: "reflink-copy-v1" as const,
        snapshotDigest: "e".repeat(64),
      },
      ociLease: intent,
    };
    const removed = {
      ...active,
      ociLease: {
        ...intent,
        state: "removed" as const,
        containerId: "f".repeat(64),
        inspectedPolicyDigest: intent.policyDigest,
      },
    };
    const events: string[] = [];

    const records = await runEvaluationTrials({
      plan,
      committedRecords: [],
      attempts: {
        active,
        begin: async () => undefined,
        recover: async () => {
          events.push("recover");
          return removed;
        },
        complete: async (attempt) => {
          events.push(`complete:${attempt.ociLease?.state}`);
        },
      },
      append: async () => {
        events.push("append");
      },
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "prime-agent-native-v1",
        run: async () => ({
          harness: { outcome: "completed", runId: "next", reason: null },
          metrics: unavailableEvaluationMetrics(),
        }),
      }),
      verifyWorkspace: async (request) => ({
        outcome: "accepted",
        verifierDigest: request.verifier.digest,
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      }),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(records[0]?.harness).toMatchObject({ outcome: "crashed" });
    expect(events.slice(0, 3)).toEqual(["recover", "append", "complete:removed"]);
  });

  it("recovers Prime global admission before an OCI lease exists", async () => {
    const root = await temporaryDirectory();
    const base = executionPlan(root);
    const plan: RunEvaluationTrialsInput["plan"] = {
      ...base,
      profiles: base.profiles.map((profile) => ({
        ...profile,
        adapter: "prime-agent-native-v1" as const,
      })),
    };
    const schedule = plan.schedule[0];
    if (schedule === undefined) {
      throw new Error("missing active Prime schedule item");
    }
    const active = {
      version: 1 as const,
      planDigest: plan.planDigest,
      position: schedule.position,
      trialId: schedule.trialId,
      taskId: schedule.taskId,
      profileId: schedule.profileId,
      adapter: "prime-agent-native-v1" as const,
      startedAt: "2026-08-09T09:59:00.000Z",
      workspace: {
        backend: "reflink-copy-v1" as const,
        snapshotDigest: "e".repeat(64),
      },
    };
    const recover = vi.fn(async () => active);

    await runEvaluationTrials({
      plan,
      committedRecords: [],
      attempts: {
        active,
        begin: vi.fn(async () => undefined),
        recover,
        complete: vi.fn(async () => undefined),
      },
      append: vi.fn(async () => undefined),
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "prime-agent-native-v1",
        run: async () => ({
          harness: { outcome: "completed", runId: "next", reason: null },
          metrics: unavailableEvaluationMetrics(),
        }),
      }),
      verifyWorkspace: async (request) => ({
        outcome: "accepted",
        verifierDigest: request.verifier.digest,
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      }),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(recover).toHaveBeenCalledWith(active);
  });

  it("keeps an active Prime attempt when recovery is unsafe", async () => {
    const root = await temporaryDirectory();
    const base = executionPlan(root);
    const plan: RunEvaluationTrialsInput["plan"] = {
      ...base,
      profiles: base.profiles.map((profile) => ({
        ...profile,
        adapter: "prime-agent-native-v1" as const,
      })),
    };
    const schedule = plan.schedule[0];
    if (schedule === undefined) {
      throw new Error("missing active Prime schedule item");
    }
    const append = vi.fn();
    const complete = vi.fn();

    await expect(
      runEvaluationTrials({
        plan,
        committedRecords: [],
        attempts: {
          active: {
            version: 1,
            planDigest: plan.planDigest,
            position: schedule.position,
            trialId: schedule.trialId,
            taskId: schedule.taskId,
            profileId: schedule.profileId,
            adapter: "prime-agent-native-v1",
            startedAt: "2026-08-09T09:59:00.000Z",
            workspace: {
              backend: "reflink-copy-v1",
              snapshotDigest: "e".repeat(64),
            },
            ociLease: primeOciLease(schedule.trialId),
          },
          begin: async () => undefined,
          recover: async () => {
            throw new HarnessUnsafeStateError("container recovery is not confirmed");
          },
          complete,
        },
        append,
        workspaceIsolator: isolator(root),
        observeFixture: async () => fixtureSnapshot(),
        resolveAdapter: vi.fn(),
        verifyWorkspace: vi.fn(),
        now: monotonicDates(),
        environment: testEnvironment(),
      }),
    ).rejects.toThrow(/recovery is not confirmed/i);

    expect(append).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("records only the active cancelled trial and leaves the schedule suffix unstarted", async () => {
    const root = await temporaryDirectory();
    const plan = executionPlan(root);
    const controller = new AbortController();
    const adapter = vi.fn(async () => {
      controller.abort(new Error("operator cancelled evaluation"));
      return {
        harness: { outcome: "cancelled" as const, runId: "cancelled-run", reason: "cancelled" },
        metrics: unavailableEvaluationMetrics(),
      };
    });
    const began: number[] = [];
    const completed: number[] = [];

    const records = await runEvaluationTrials({
      plan,
      committedRecords: [],
      attempts: {
        active: null,
        begin: async (attempt) => {
          began.push(attempt.position);
        },
        complete: async (attempt) => {
          completed.push(attempt.position);
        },
      },
      append: async () => undefined,
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({ kind: "flow-workflow-v1", run: adapter }),
      verifyWorkspace: vi.fn(),
      signal: controller.signal,
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      position: 1,
      classification: "harness_failure",
      harness: { outcome: "cancelled" },
    });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(began).toEqual([1]);
    expect(completed).toEqual([1]);
  });

  it.each(["source observation", "workspace creation", "isolated observation"] as const)(
    "records cancellation during %s and does not start the adapter",
    async (stage) => {
      const root = await temporaryDirectory();
      const plan = executionPlan(root);
      const controller = new AbortController();
      const workspaceIsolator = isolator(root);
      if (stage === "workspace creation") {
        workspaceIsolator.create.mockImplementationOnce(async () => {
          controller.abort(new Error("operator cancelled evaluation"));
          throw controller.signal.reason;
        });
      }
      let observations = 0;
      const observeFixture = async () => {
        observations += 1;
        if (
          (stage === "source observation" && observations === 1) ||
          (stage === "isolated observation" && observations === 2)
        ) {
          controller.abort(new Error("operator cancelled evaluation"));
          throw controller.signal.reason;
        }
        return fixtureSnapshot();
      };
      const adapter = vi.fn();
      const begin = vi.fn();

      const records = await runEvaluationTrials({
        plan,
        committedRecords: [],
        attempts: { active: null, begin, complete: vi.fn() },
        append: async () => undefined,
        workspaceIsolator,
        observeFixture,
        resolveAdapter: () => ({ kind: "flow-workflow-v1", run: adapter }),
        verifyWorkspace: vi.fn(),
        signal: controller.signal,
        now: monotonicDates(),
        environment: testEnvironment(),
      });

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        position: 1,
        classification: "harness_failure",
        harness: { outcome: "cancelled", reason: "operator cancelled evaluation" },
      });
      expect(adapter).not.toHaveBeenCalled();
      expect(begin).not.toHaveBeenCalled();
    },
  );

  it.each([
    "workspace cleanup",
    "source observation",
    "workspace creation",
    "isolated observation",
    "durable start",
  ] as const)(
    "does not call the adapter when cancellation arrives during successful %s",
    async (stage) => {
      const root = await temporaryDirectory();
      const plan = executionPlan(root);
      const controller = new AbortController();
      const workspaceIsolator = isolator(root);
      if (stage === "workspace cleanup") {
        workspaceIsolator.cleanup.mockImplementationOnce(async () => {
          controller.abort(new Error("operator cancelled evaluation"));
          return "discarded";
        });
      }
      if (stage === "workspace creation") {
        workspaceIsolator.create.mockImplementationOnce(async ({ workspaceId }) => {
          controller.abort(new Error("operator cancelled evaluation"));
          return {
            workspaceId,
            cwd: join(root, workspaceId),
            backend: "reflink-copy-v1" as const,
            snapshotDigest: "e".repeat(64),
          };
        });
      }
      let observations = 0;
      const observeFixture = async () => {
        observations += 1;
        if (
          (stage === "source observation" && observations === 1) ||
          (stage === "isolated observation" && observations === 2)
        ) {
          controller.abort(new Error("operator cancelled evaluation"));
        }
        return fixtureSnapshot();
      };
      const begin = vi.fn(async () => {
        if (stage === "durable start") {
          controller.abort(new Error("operator cancelled evaluation"));
        }
      });
      const complete = vi.fn(async () => undefined);
      const adapter = vi.fn(async () => ({
        harness: { outcome: "completed" as const, runId: "must-not-run", reason: null },
        metrics: unavailableEvaluationMetrics(),
      }));

      const records = await runEvaluationTrials({
        plan,
        committedRecords: [],
        attempts: { active: null, begin, complete },
        append: async () => undefined,
        workspaceIsolator,
        observeFixture,
        resolveAdapter: () => ({ kind: "flow-workflow-v1", run: adapter }),
        verifyWorkspace: vi.fn(),
        signal: controller.signal,
        now: monotonicDates(),
        environment: testEnvironment(),
      });

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        position: 1,
        classification: "harness_failure",
        harness: { outcome: "cancelled", reason: "operator cancelled evaluation" },
      });
      expect(adapter).not.toHaveBeenCalled();
      if (stage === "durable start") {
        expect(begin).toHaveBeenCalledTimes(1);
        expect(complete).toHaveBeenCalledTimes(1);
      } else {
        expect(begin).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps external process evidence when cancellation stops the active trial", async () => {
    const root = await temporaryDirectory();
    const sourcePlan = executionPlan(root);
    const plan = {
      ...sourcePlan,
      profiles: sourcePlan.profiles.map((profile) => ({
        ...profile,
        adapter: "pi-native-v1" as const,
      })),
    };
    const controller = new AbortController();

    const records = await runEvaluationTrials({
      plan,
      committedRecords: [],
      append: async () => undefined,
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "pi-native-v1",
        run: async () => {
          controller.abort(new Error("operator cancelled evaluation"));
          return {
            harness: {
              outcome: "cancelled",
              runId: "pi-run",
              reason: "cancelled",
              runtime: {
                adapter: "pi-native-v1",
                containment: "process-group",
                exitCode: null,
                signal: "SIGTERM",
                timedOut: false,
                aborted: true,
                treeTermination: "confirmed",
              },
            },
            metrics: unavailableEvaluationMetrics(),
          };
        },
      }),
      verifyWorkspace: vi.fn(),
      signal: controller.signal,
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.harness).toMatchObject({
      outcome: "cancelled",
      runtime: {
        adapter: "pi-native-v1",
        aborted: true,
        treeTermination: "confirmed",
      },
    });
  });

  it("records source drift and adapter exceptions without dropping scheduled trials", async () => {
    const root = await temporaryDirectory();
    const plan = executionPlan(root);
    const adapter = { kind: "flow-workflow-v1", run: vi.fn().mockRejectedValue(new Error("boom")) };
    let observations = 0;

    const records = await runEvaluationTrials({
      plan,
      committedRecords: [],
      append: async () => undefined,
      workspaceIsolator: isolator(root),
      observeFixture: async () => {
        observations += 1;
        return observations === 1
          ? { ...fixtureSnapshot(), digest: "9".repeat(64) }
          : fixtureSnapshot();
      },
      resolveAdapter: () => adapter,
      verifyWorkspace: vi.fn(),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      classification: "harness_failure",
      environment: { workspaceSnapshotDigest: null },
      harness: { outcome: "crashed", reason: expect.stringMatching(/drift/i) },
    });
    expect(records[1]).toMatchObject({
      classification: "harness_failure",
      harness: { outcome: "crashed", reason: "boom" },
    });
    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  it("converts malformed adapter evidence into a durable scheduled harness failure", async () => {
    const root = await temporaryDirectory();
    const plan = executionPlan(root);

    const records = await runEvaluationTrials({
      plan,
      committedRecords: [],
      append: async () => undefined,
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "flow-workflow-v1",
        run: async () =>
          ({
            harness: { outcome: "completed", runId: null, reason: null },
            metrics: unavailableEvaluationMetrics(),
          }) as never,
      }),
      verifyWorkspace: async () => ({
        outcome: "accepted",
        verifierDigest: "b".repeat(64),
        assertions: [],
      }),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(records).toHaveLength(2);
    expect(records).toEqual(
      Array.from({ length: 2 }, () =>
        expect.objectContaining({
          classification: "harness_failure",
          harness: expect.objectContaining({ outcome: "malformed_output" }),
          verification: expect.objectContaining({ outcome: "not_run" }),
        }),
      ),
    );
  });

  it("turns contradictory verifier evidence into verifier error without relabelling the harness", async () => {
    const root = await temporaryDirectory();
    const plan = executionPlan(root);

    const records = await runEvaluationTrials({
      plan,
      committedRecords: [],
      append: async () => undefined,
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "flow-workflow-v1",
        run: async () => ({
          harness: { outcome: "completed", runId: "durable-run", reason: null },
          metrics: unavailableEvaluationMetrics(),
        }),
      }),
      verifyWorkspace: async () => ({
        outcome: "accepted",
        verifierDigest: "f".repeat(64),
        assertions: [],
      }),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(records).toEqual(
      Array.from({ length: 2 }, () =>
        expect.objectContaining({
          classification: "verifier_error",
          harness: expect.objectContaining({ outcome: "completed", runId: "durable-run" }),
          verification: expect.objectContaining({
            outcome: "error",
            verifierDigest: plan.tasks[0]?.verifier.digest,
            reason: expect.stringMatching(/verifier.*evidence|digest/i),
          }),
        }),
      ),
    );
  });

  it("does not re-read hostile adapter evidence while recording malformed output", async () => {
    const root = await temporaryDirectory();
    const plan = executionPlan(root);
    const harness = { outcome: "completed", reason: null } as Record<string, unknown>;
    Object.defineProperty(harness, "runId", {
      enumerable: true,
      get: () => {
        throw new Error("hostile run id getter");
      },
    });

    const records = await runEvaluationTrials({
      plan,
      committedRecords: [],
      append: async () => undefined,
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "flow-workflow-v1",
        run: async () => ({ harness, metrics: unavailableEvaluationMetrics() }) as never,
      }),
      verifyWorkspace: vi.fn(),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(records).toHaveLength(2);
    expect(records.every((record) => record.harness.outcome === "malformed_output")).toBe(true);
  });

  it.each([
    ["missing observed digest on success", { kind: "sha256", path: "RESULT.md", outcome: true }],
    [
      "wrong observed digest on success",
      { kind: "sha256", path: "RESULT.md", outcome: true, observedSha256: "2".repeat(64) },
    ],
    [
      "matching observed digest on rejection",
      { kind: "sha256", path: "RESULT.md", outcome: false, observedSha256: "1".repeat(64) },
    ],
  ] as const)(
    "turns contradictory SHA evidence into verifier error: %s",
    async (_name, evidence) => {
      const root = await temporaryDirectory();
      const plan = shaExecutionPlan(root);

      const records = await runEvaluationTrials({
        plan,
        committedRecords: [],
        append: async () => undefined,
        workspaceIsolator: isolator(root),
        observeFixture: async () => fixtureSnapshot(),
        resolveAdapter: () => ({
          kind: "flow-workflow-v1",
          run: async () => ({
            harness: { outcome: "completed", runId: "durable-run", reason: null },
            metrics: unavailableEvaluationMetrics(),
          }),
        }),
        verifyWorkspace: async (request) => ({
          outcome: evidence.outcome ? "accepted" : "rejected",
          verifierDigest: request.verifier.digest,
          assertions: [evidence],
        }),
        now: monotonicDates(),
        environment: testEnvironment(),
      });

      expect(records.every((record) => record.classification === "verifier_error")).toBe(true);
    },
  );

  it("preserves a valid rejected SHA comparison as false completion", async () => {
    const root = await temporaryDirectory();
    const plan = shaExecutionPlan(root);
    const records = await runEvaluationTrials({
      plan,
      committedRecords: [],
      append: async () => undefined,
      workspaceIsolator: isolator(root),
      observeFixture: async () => fixtureSnapshot(),
      resolveAdapter: () => ({
        kind: "flow-workflow-v1",
        run: async () => ({
          harness: { outcome: "completed", runId: "durable-run", reason: null },
          metrics: unavailableEvaluationMetrics(),
        }),
      }),
      verifyWorkspace: async (request) => ({
        outcome: "rejected",
        verifierDigest: request.verifier.digest,
        assertions: [
          {
            kind: "sha256",
            path: "RESULT.md",
            outcome: false,
            observedSha256: "2".repeat(64),
          },
        ],
      }),
      now: monotonicDates(),
      environment: testEnvironment(),
    });

    expect(records.every((record) => record.classification === "false_completion")).toBe(true);
  });
});

function executionPlan(root: string) {
  const planDigest = "a".repeat(64);
  return Object.freeze({
    planDigest,
    schedule: createEvaluationSchedule(planDigest, ["task"], ["baseline", "candidate"], [11]),
    controls: Object.freeze({
      model: Object.freeze({ provider: "test", id: "deterministic", thinking: "medium" }),
      budget: Object.freeze({
        maxNodeStarts: 8,
        maxModelTokens: 10_000,
        maxCostUsdMicros: 1_000_000,
        maxExecutionMs: 300_000,
        maxArtifactBytes: 1_048_576,
      }),
      network: "deny" as const,
      retry: Object.freeze({ providerRetries: 0 as const, harnessRetries: 0 as const }),
    }),
    tasks: Object.freeze([
      Object.freeze({
        id: "task",
        fixture: Object.freeze({ sourceCwd: join(root, "fixture"), ...fixtureSnapshot() }),
        verifier: Object.freeze({
          kind: "filesystem-v1" as const,
          digest: "b".repeat(64),
          assertions: Object.freeze([{ kind: "exists" as const, path: "RESULT.md" }]),
        }),
      }),
    ]),
    profiles: Object.freeze([
      Object.freeze({ id: "baseline", adapter: "flow-workflow-v1" as const }),
      Object.freeze({ id: "candidate", adapter: "flow-workflow-v1" as const }),
    ]),
  });
}

function shaExecutionPlan(root: string) {
  const plan = executionPlan(root);
  const task = plan.tasks[0];
  if (task === undefined) {
    throw new Error("missing evaluation task");
  }
  return Object.freeze({
    ...plan,
    tasks: Object.freeze([
      Object.freeze({
        ...task,
        verifier: Object.freeze({
          kind: "filesystem-v1" as const,
          digest: "b".repeat(64),
          assertions: Object.freeze([
            { kind: "sha256" as const, path: "RESULT.md", value: "1".repeat(64) },
          ]),
        }),
      }),
    ]),
  });
}

function fixtureSnapshot() {
  return Object.freeze({
    digest: "c".repeat(64),
    entryCount: 1,
    logicalBytes: 10,
    instructionPath: "TASK.md",
    instructionSha256: "d".repeat(64),
  });
}

function isolator(root: string) {
  return {
    create: vi.fn(async ({ workspaceId }: { readonly workspaceId: string }) => ({
      workspaceId,
      cwd: join(root, workspaceId),
      backend: "reflink-copy-v1" as const,
      snapshotDigest: "e".repeat(64),
    })),
    reopen: async () => {
      throw new Error("not used");
    },
    cleanup: vi.fn(async () => "discarded" as const),
  };
}

function testEnvironment() {
  return Object.freeze({
    platform: "darwin" as const,
    architecture: "arm64",
    nodeVersion: "v22.19.0",
    flowVersion: "0.0.0",
  });
}

function monotonicDates(): () => Date {
  let second = 0;
  return () => new Date(`2026-08-09T10:00:${String(second++).padStart(2, "0")}.000Z`);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-runner-")));
  temporaryDirectories.push(directory);
  return directory;
}
