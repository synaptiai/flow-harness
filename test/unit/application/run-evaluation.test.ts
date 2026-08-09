import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessEvaluationRequest } from "../../../src/application/evaluation-adapter.js";
import { runEvaluationTrials } from "../../../src/application/run-evaluation.js";
import { createEvaluationSchedule } from "../../../src/domain/evaluation/plan.js";
import {
  type EvaluationTrialRecord,
  unavailableEvaluationMetrics,
} from "../../../src/domain/evaluation/records.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("evaluation trial runner", () => {
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
