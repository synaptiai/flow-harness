import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  CandidateDelta,
  CandidatePromotionLifecycle,
  CandidatePromotionRequest,
  CandidatePromotionSettlement,
  CandidateWorkspaceManager,
  IsolatedWorkspace,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
  WorkspaceIsolator,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import type { RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("optimization workflow runtime", () => {
  it("evaluates, promotes, cleans, and completes an improving candidate", async () => {
    const store = new MemoryRunStore();
    const workspaces = new MemoryCandidateWorkspaces();

    const state = await runWorkflow(compileWorkflowText(workflowSource()), {
      runId: "optimization-parent",
      cwd: "/workspace",
      protectedPaths: [".flow"],
      store,
      executor: executor(),
      workspaceIsolator: workspaces,
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "optimize--c1--check": {
          control: {
            kind: "optimization-check",
            outcome: "accepted",
            bestMetric: 8,
          },
        },
        optimize: {
          control: {
            kind: "optimization",
            completedCandidates: 1,
            stopReason: "max_candidates",
          },
        },
      },
    });
    expect(workspaces.activity).toEqual([
      "create",
      "capture",
      "prepare",
      "settle:committed",
      "cleanup",
    ]);
    expect(store.events("optimization-parent").map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "node_optimization_evaluated",
        "node_optimization_promotion_prepared",
        "node_optimization_promotion_settled",
        "node_optimization_candidate_cleaned",
        "node_optimization_checked",
        "node_optimization_completed",
      ]),
    );
  });

  it("stops at the stagnation bound and omits every later finite candidate", async () => {
    const store = new MemoryRunStore();
    const workspaces = new MemoryCandidateWorkspaces();
    const workflow = compileWorkflowText(
      workflowSource().replace("maxCandidates: 1", "maxCandidates: 2"),
    );

    const state = await runWorkflow(workflow, {
      runId: "optimization-stagnates",
      cwd: "/workspace",
      protectedPaths: [".flow"],
      store,
      executor: executor(12),
      workspaceIsolator: workspaces,
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "optimize--c1--check": {
          control: { kind: "optimization-check", outcome: "rejected", stop: true },
        },
        "optimize--c2--candidate": {
          status: "omitted",
          omission: { reason: "optimization_stopped" },
        },
        "optimize--c2--check": { status: "omitted" },
        optimize: {
          control: { kind: "optimization", stopReason: "stagnation", bestCandidate: null },
        },
      },
    });
    expect(workspaces.activity).toEqual(["create", "cleanup"]);
  });

  it("accounts for a failed candidate as a rejection and still completes the parent", async () => {
    const store = new MemoryRunStore();
    const workspaces = new MemoryCandidateWorkspaces();

    const state = await runWorkflow(compileWorkflowText(workflowSource()), {
      runId: "optimization-candidate-fails",
      cwd: "/workspace",
      protectedPaths: [".flow"],
      store,
      executor: executor(8, true),
      workspaceIsolator: workspaces,
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "optimize--c1--candidate": {
          status: "succeeded",
          evidence: { kind: "child", outcome: "failed" },
        },
        "optimize--c1--check": {
          control: { outcome: "rejected", reason: "candidate_failed", stop: true },
        },
      },
    });
    expect(workspaces.activity).toEqual(["create", "cleanup"]);
  });

  it("reconciles a prepared promotion after settlement publication is interrupted", async () => {
    const store = new MemoryRunStore("node_optimization_promotion_settled");
    const workspaces = new MemoryCandidateWorkspaces(true);
    const workflow = compileWorkflowText(workflowSource());
    const now = clock();
    const options = {
      cwd: "/workspace",
      protectedPaths: [".flow"],
      executor: executor(),
      workspaceIsolator: workspaces,
      now,
    };

    await expect(
      runWorkflow(workflow, {
        ...options,
        runId: "optimization-reconcile",
        store,
      }),
    ).rejects.toThrow(/simulated publication interruption/i);
    expect(store.events("optimization-reconcile").at(-1)?.type).toBe(
      "node_optimization_promotion_prepared",
    );

    const state = await resumeWorkflow(workflow, {
      ...options,
      runId: "optimization-reconcile",
      store,
    });

    expect(state.status).toBe("succeeded");
    expect(workspaces.activity).toEqual([
      "create",
      "capture",
      "prepare",
      "settle:committed",
      "reconcile",
      "cleanup",
    ]);
    expect(
      store
        .events("optimization-reconcile")
        .filter((event) => event.type === "node_optimization_promotion_prepared"),
    ).toHaveLength(1);
  });

  it("retries idempotent cleanup without reapplying an already settled promotion", async () => {
    const store = new MemoryRunStore("node_optimization_candidate_cleaned");
    const workspaces = new MemoryCandidateWorkspaces();
    const workflow = compileWorkflowText(workflowSource());
    const now = clock();
    const options = {
      cwd: "/workspace",
      protectedPaths: [".flow"],
      executor: executor(),
      workspaceIsolator: workspaces,
      now,
    };

    await expect(
      runWorkflow(workflow, {
        ...options,
        runId: "optimization-cleanup-retry",
        store,
      }),
    ).rejects.toThrow(/simulated publication interruption/i);

    const state = await resumeWorkflow(workflow, {
      ...options,
      runId: "optimization-cleanup-retry",
      store,
    });

    expect(state.status).toBe("succeeded");
    expect(workspaces.activity).toEqual([
      "create",
      "capture",
      "prepare",
      "settle:committed",
      "cleanup",
      "cleanup",
    ]);
    expect(
      store
        .events("optimization-cleanup-retry")
        .filter((event) => event.type === "node_optimization_promotion_settled"),
    ).toHaveLength(1);
  });

  it("blocks the run when promotion reconciliation cannot prove the affected paths", async () => {
    const store = new MemoryRunStore();
    const workspaces = new MemoryCandidateWorkspaces(false, {
      outcome: "unknown",
      reason: "affected_path_diverged",
    });

    const state = await runWorkflow(compileWorkflowText(workflowSource()), {
      runId: "optimization-uncertain",
      cwd: "/workspace",
      protectedPaths: [".flow"],
      store,
      executor: executor(),
      workspaceIsolator: workspaces,
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "optimize--c1--check",
      nodes: {
        "optimize--c1--check": {
          status: "failed",
          error: {
            code: "candidate_promotion_uncertain",
            retryable: false,
            sideEffectStatus: "uncertain",
          },
          optimization: { settlement: { outcome: "unknown" }, cleanedAt: null },
        },
        finish: { status: "pending" },
      },
    });
    expect(workspaces.activity).not.toContain("cleanup");
  });

  it("does not evaluate, promote, or launch another candidate after boundary cancellation", async () => {
    const controller = new AbortController();
    const store = new MemoryRunStore(undefined, (event) => {
      if (event.type === "node_succeeded" && event.nodeId === "optimize--c1--candidate") {
        controller.abort("operator cancelled after candidate completion");
      }
    });
    const workspaces = new MemoryCandidateWorkspaces();
    const workflow = compileWorkflowText(
      workflowSource().replace("maxCandidates: 1", "maxCandidates: 2"),
    );

    const state = await runWorkflow(workflow, {
      runId: "optimization-boundary-cancelled",
      cwd: "/workspace",
      protectedPaths: [".flow"],
      store,
      executor: executor(),
      workspaceIsolator: workspaces,
      signal: controller.signal,
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "cancelled",
      nodes: {
        "optimize--c1--candidate": { status: "succeeded" },
        "optimize--c1--check": { status: "pending" },
        "optimize--c2--candidate": { status: "pending" },
      },
    });
    expect(workspaces.activity).toEqual(["create"]);
    expect(
      store
        .events("optimization-boundary-cancelled")
        .some((event) => event.type.startsWith("node_optimization_")),
    ).toBe(false);
  });

  it("charges candidate resources to the root and exhausts before evaluation or later candidates", async () => {
    const store = new MemoryRunStore();
    const workspaces = new MemoryCandidateWorkspaces();
    const workflow = compileWorkflowText(
      workflowSource()
        .replace("maxCandidates: 1", "maxCandidates: 2")
        .replace("maxExecutionMs: 60000", "maxExecutionMs: 2")
        .replace("maxExecutionMs: 10000", "maxExecutionMs: 1"),
    );

    const state = await runWorkflow(workflow, {
      runId: "optimization-budget-exhausted",
      cwd: "/workspace",
      protectedPaths: [".flow"],
      store,
      executor: executor(),
      workspaceIsolator: workspaces,
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "resource_exhausted",
      resources: { executionMs: 2 },
      budget: {
        exhausted: [{ dimension: "executionMs", limit: 2, consumed: 2 }],
      },
      nodes: {
        "optimize--c1--candidate": {
          status: "succeeded",
          evidence: { kind: "child", outcome: "resource_exhausted" },
        },
        "optimize--c1--check": { status: "pending" },
        "optimize--c2--candidate": { status: "pending" },
      },
    });
    expect(workspaces.activity).toEqual(["create", "cleanup"]);
    expect(
      store
        .events("optimization-budget-exhausted")
        .some((event) => event.type.startsWith("node_optimization_")),
    ).toBe(false);
  });

  it("records an oversized candidate delta as a bounded rejection and discards it", async () => {
    const store = new MemoryRunStore();
    const workspaces = new MemoryCandidateWorkspaces(
      false,
      { outcome: "committed", reason: "local_commit_durable" },
      "candidate_delta_limit_exceeded",
    );

    const state = await runWorkflow(compileWorkflowText(workflowSource()), {
      runId: "optimization-evaluation-fails",
      cwd: "/workspace",
      protectedPaths: [".flow"],
      store,
      executor: executor(),
      workspaceIsolator: workspaces,
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "optimize--c1--check": {
          status: "succeeded",
          control: {
            kind: "optimization-check",
            outcome: "rejected",
            reason: "candidate_delta_limit_exceeded",
            stop: true,
          },
        },
      },
    });
    expect(workspaces.activity).toEqual(["create", "capture", "cleanup"]);
  });

  it("rejects oversized delta evidence returned by a custom candidate manager", async () => {
    const store = new MemoryRunStore();
    const workspaces = new MemoryCandidateWorkspaces(
      false,
      { outcome: "committed", reason: "local_commit_durable" },
      undefined,
      1_000,
    );

    const state = await runWorkflow(compileWorkflowText(workflowSource()), {
      runId: "optimization-custom-manager-oversized",
      cwd: "/workspace",
      protectedPaths: [".flow"],
      store,
      executor: executor(),
      workspaceIsolator: workspaces,
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "optimize--c1--check": {
          control: {
            kind: "optimization-check",
            outcome: "rejected",
            reason: "candidate_delta_limit_exceeded",
          },
        },
      },
    });
    expect(workspaces.activity).toEqual(["create", "capture", "cleanup"]);
    const evaluation = store
      .events("optimization-custom-manager-oversized")
      .find((event) => event.type === "node_optimization_evaluated");
    expect(evaluation).toMatchObject({
      decision: "reject",
      reason: "candidate_delta_limit_exceeded",
      promotion: null,
      deltaEntries: null,
    });
  });
});

class MemoryRunStore implements RecoverableRunEventStore {
  readonly #events = new Map<string, RunEvent[]>();
  readonly #failOnceType: RunEvent["type"] | undefined;
  readonly #onAppend: ((event: RunEvent) => void) | undefined;
  #failed = false;

  constructor(failOnceType?: RunEvent["type"], onAppend?: (event: RunEvent) => void) {
    this.#failOnceType = failOnceType;
    this.#onAppend = onAppend;
  }

  async append(event: RunEvent): Promise<void> {
    if (!this.#failed && event.type === this.#failOnceType) {
      this.#failed = true;
      throw new Error("simulated publication interruption");
    }
    const events = this.#events.get(event.runId) ?? [];
    events.push(structuredClone(event));
    this.#events.set(event.runId, events);
    this.#onAppend?.(event);
  }

  async read(runId: string): Promise<readonly RunEvent[]> {
    return structuredClone(this.#events.get(runId) ?? []);
  }

  async claim(runId: string): Promise<readonly RunEvent[]> {
    return await this.read(runId);
  }

  async release(_runId: string): Promise<void> {}

  async exists(runId: string): Promise<boolean> {
    return this.#events.has(runId);
  }

  events(runId: string): readonly RunEvent[] {
    return this.#events.get(runId) ?? [];
  }
}

class MemoryCandidateWorkspaces implements WorkspaceIsolator, CandidateWorkspaceManager {
  readonly activity: string[] = [];
  readonly #allowReconcile: boolean;
  readonly #settlement: CandidatePromotionSettlement;
  readonly #captureFailureCode: string | undefined;
  readonly #captureEntryCount: number;

  constructor(
    allowReconcile = false,
    settlement: CandidatePromotionSettlement = {
      outcome: "committed",
      reason: "local_commit_durable",
    },
    captureFailureCode?: string,
    captureEntryCount = 1,
  ) {
    this.#allowReconcile = allowReconcile;
    this.#settlement = settlement;
    this.#captureFailureCode = captureFailureCode;
    this.#captureEntryCount = captureEntryCount;
  }

  async create(request: { readonly workspaceId: string }): Promise<IsolatedWorkspace> {
    this.activity.push("create");
    return {
      workspaceId: request.workspaceId,
      cwd: `/isolated/${request.workspaceId}`,
      backend: "reflink-copy-v1",
      snapshotDigest: "a".repeat(64),
    };
  }

  async reopen(request: { readonly workspaceId: string }): Promise<IsolatedWorkspace> {
    return {
      workspaceId: request.workspaceId,
      cwd: `/isolated/${request.workspaceId}`,
      backend: "reflink-copy-v1",
      snapshotDigest: "a".repeat(64),
    };
  }

  async cleanup(_workspaceId: string): Promise<"discarded"> {
    this.activity.push("cleanup");
    return "discarded";
  }

  async captureCandidateDelta(request: {
    readonly workspaceId: string;
    readonly expectedSnapshotDigest: string;
  }): Promise<CandidateDelta> {
    this.activity.push("capture");
    if (this.#captureFailureCode !== undefined) {
      throw Object.assign(new Error("simulated candidate capture failure"), {
        code: this.#captureFailureCode,
      });
    }
    const entries = Array.from({ length: this.#captureEntryCount }, (_, index) => ({
      path: `scores/${String(index).padStart(5, "0")}.json`,
      before: { kind: "missing" as const },
      after: {
        kind: "file" as const,
        mode: 0o644,
        size: 8,
        sha256: "f".repeat(64),
      },
    }));
    const manifest = {
      version: 1 as const,
      workspaceId: request.workspaceId,
      baselineSnapshotDigest: request.expectedSnapshotDigest,
      candidateSnapshotDigest: "b".repeat(64),
      entryCount: entries.length,
      logicalBytes: entries.length * 8,
      entries,
    };
    return { ...manifest, deltaDigest: sha256(JSON.stringify(manifest)) };
  }

  async promoteCandidateDelta(
    request: CandidatePromotionRequest,
    lifecycle: CandidatePromotionLifecycle,
  ): Promise<CandidatePromotionSettlement> {
    const boundary = {
      promotionId: request.promotionId,
      workspaceId: request.workspaceId,
      deltaDigest: request.deltaDigest,
      baselineSnapshotDigest: "a".repeat(64),
      candidateSnapshotDigest: "b".repeat(64),
      entryCount: 1,
      logicalBytes: 8,
    };
    this.activity.push("prepare");
    await lifecycle.prepare(boundary);
    this.activity.push(`settle:${this.#settlement.outcome}`);
    await lifecycle.settle(this.#settlement);
    return this.#settlement;
  }

  async reconcileCandidatePromotion(
    _request: CandidatePromotionRequest,
  ): Promise<CandidatePromotionSettlement> {
    if (!this.#allowReconcile) {
      throw new Error("unexpected reconciliation");
    }
    this.activity.push("reconcile");
    return { outcome: "committed", reason: "local_commit_durable" };
  }
}

function executor(candidateScore = 8, failCandidate = false): NodeExecutor {
  return {
    async execute(node): Promise<NodeExecutionOutcome> {
      if (node.id === "improve" && failCandidate) {
        return {
          status: "failed",
          error: {
            code: "candidate_command_failed",
            message: "candidate command failed",
            retryable: false,
            sideEffectStatus: "none",
          },
          evidence: commandEvidence("failed", 1),
        };
      }
      const stdout =
        node.id === "measure"
          ? '{"score":10,"tests-passed":true}'
          : node.id === "improve"
            ? `{"score":${candidateScore},"tests-passed":true}`
            : "done";
      return {
        status: "succeeded",
        evidence: commandEvidence(stdout, 0),
      };
    },
  };
}

function commandEvidence(stdout: string, exitCode: number) {
  return {
    kind: "command" as const,
    executable: "node",
    args: [],
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: sha256(stdout),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function workflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: optimization-runtime }
budget:
  maxNodeStarts: 16
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
nodes:
  - id: measure
    type: command
    command: { executable: node, args: [measure] }
  - id: baseline
    type: result
    dependsOn: [measure]
    result:
      source: { nodeId: measure, field: command.stdout }
      schema: &score
        type: object
        properties:
          score: { type: number }
          tests-passed: { type: boolean }
        required: [score, tests-passed]
  - id: optimize
    type: optimization
    dependsOn: [baseline]
    optimization:
      baseline: { nodeId: baseline, field: result.value }
      metric: { pointer: /score, direction: minimize }
      invariants: [{ pointer: /tests-passed, equals: true }]
      maxCandidates: 1
      stagnation: { maxConsecutiveNonImproving: 1 }
      rollback: previous-best
      candidate:
        resultNodeId: publish
        workflow: |
          apiVersion: flow.synapti.ai/v1alpha1
          kind: Workflow
          metadata: { id: candidate }
          budget:
            maxNodeStarts: 4
            maxModelTokens: 100
            maxCostUsd: 0.1
            maxExecutionMs: 10000
          nodes:
            - id: improve
              type: command
              command: { executable: node, args: [improve] }
            - id: publish
              type: result
              dependsOn: [improve]
              result:
                source: { nodeId: improve, field: command.stdout }
                schema:
                  type: object
                  properties:
                    score: { type: number }
                    tests-passed: { type: boolean }
                  required: [score, tests-passed]
  - id: finish
    type: command
    dependsOn: [optimize]
    command: { executable: node, args: [finish] }
`;
}

function clock(): () => Date {
  let milliseconds = Date.parse("2026-08-08T00:00:00.000Z");
  return () => {
    milliseconds += 1;
    return new Date(milliseconds);
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
