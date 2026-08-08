import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { NodeExecutorRouter } from "../../../src/application/node-executor-router.js";
import type {
  AgentExecutor,
  CommandExecutor,
  IsolatedWorkspace,
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
  WorkspaceIsolator,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import type { ToolPackageSnapshotInput } from "../../../src/domain/capability/tool-packages.js";
import type { VerifierPackageSnapshotInput } from "../../../src/domain/capability/verifier-packages.js";
import {
  calculateChildRunId,
  parseRunEvent,
  type RunEvent,
  reduceRunEvents,
} from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import type { CompiledNode } from "../../../src/domain/workflow/types.js";

describe("child workflow execution", () => {
  it("runs a separately-ledgered child in an isolated workspace and imports its result", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const executor = new ChildCommandExecutor();
    const workflow = compileWorkflowText(parentWorkflow());

    const state = await runWorkflow(workflow, {
      runId: "parent-run",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor,
      workspaceIsolator: isolator,
      now: clock(),
    });

    const childRunId = calculateChildRunId("parent-run", "delegate", 1);
    expect(state).toMatchObject({
      status: "succeeded",
      resources: {
        nodeStarts: 2,
        modelTokens: 0,
        modelCostUsdMicros: 0,
        executionMs: 5,
        artifactBytes: 4,
      },
      nodes: {
        delegate: {
          childRun: { runId: childRunId },
          evidence: {
            kind: "child",
            childRunId,
            result: { canonicalValue: "true", valueHash: sha256("true") },
            resources: { nodeStarts: 1, executionMs: 5, artifactBytes: 4 },
            workspace: {
              snapshotDigest: "a".repeat(64),
              disposition: "discarded",
            },
          },
        },
      },
    });
    expect(reduceRunEvents(await store.read(childRunId)).status).toBe("succeeded");
    expect(executor.calls).toEqual([
      expect.objectContaining({ nodeId: "produce", cwd: `/isolated/${childRunId}` }),
    ]);
    expect(isolator.cleaned).toEqual([childRunId]);
  });

  it("charges a child's bounded artifact overshoot to its parent exactly once", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const workflow = compileWorkflowText(parentWorkflow(2));

    const state = await runWorkflow(workflow, {
      runId: "parent-child-artifact-overshoot",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor: new ChildCommandExecutor(),
      workspaceIsolator: isolator,
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "failed",
      resources: { artifactBytes: 4 },
      nodes: {
        delegate: {
          error: { code: "child_run_resource_exhausted" },
          evidence: {
            kind: "child",
            outcome: "resource_exhausted",
            resources: { artifactBytes: 4 },
          },
        },
      },
    });
  });

  it("binds a nested verifier to the parent's frozen package snapshot", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const snapshot = createCapabilitySnapshot(
      [],
      [
        verifierPackageInput("release-tests", "1.0.0", {
          kind: "command",
          command: { executable: "node", args: ["--version"], timeoutMs: 30_000 },
        }),
      ],
    );
    const command: CommandExecutor = {
      async execute(node, context) {
        const isVerifier = node.id === "verify";
        if (isVerifier) {
          expect(node.command.args).toEqual(["--version"]);
          expect(context.verifierPackage).toEqual({
            name: "release-tests",
            version: "1.0.0",
            digest: snapshot.packages[0]?.digest,
          });
        } else {
          expect(node.id).toBe("produce");
          expect(context.verifierPackage).toBeUndefined();
        }
        const stdout = isVerifier ? "verified" : '"verified"';
        return {
          status: "succeeded",
          evidence: {
            kind: "command",
            executable: node.command.executable,
            args: node.command.args,
            exitCode: 0,
            signal: null,
            stdout,
            stderr: "",
            stdoutHash: sha256(stdout),
            stderrHash: sha256(""),
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            durationMs: 1,
          },
        };
      },
    };
    const agent: AgentExecutor = {
      async execute() {
        throw new Error("nested command verifier unexpectedly invoked a model");
      },
    };
    const workflow = compileWorkflowText(parentPackagedVerifierWorkflow());

    const state = await runWorkflow(workflow, {
      runId: "parent-packaged-verifier",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor: new NodeExecutorRouter(command, agent),
      workspaceIsolator: isolator,
      capabilitySnapshot: snapshot,
      now: clock(),
    });

    const childRunId = calculateChildRunId("parent-packaged-verifier", "delegate", 1);
    const childState = reduceRunEvents(await store.read(childRunId));
    expect(state.status).toBe("succeeded");
    expect(childState).toMatchObject({
      status: "succeeded",
      capabilitySnapshot: { digest: snapshot.digest },
      verifierPackageRequirements: {
        verify: { name: "release-tests", version: "1.0.0", kind: "command" },
      },
      nodes: {
        verify: {
          evidence: {
            kind: "verifier",
            package: {
              name: "release-tests",
              version: "1.0.0",
              digest: snapshot.packages[0]?.digest,
            },
          },
        },
      },
    });
  });

  it("binds a nested agent tool to the parent's frozen package snapshot", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const snapshot = createCapabilitySnapshot(
      [],
      [],
      [toolPackageInput("project-report", "1.2.3")],
    );
    let observedDigest: string | undefined;
    const executor: NodeExecutor = {
      async execute(node, context) {
        if (node.type !== "agent" || context.capabilitySnapshot === undefined) {
          throw new Error(`unexpected nested tool package node "${node.type}"`);
        }
        const selected = context.capabilitySnapshot.packages.find(
          (item) => item.kind === "tool-package",
        );
        observedDigest = selected?.digest;
        const text = JSON.stringify("inspected");
        return {
          status: "succeeded",
          evidence: {
            kind: "agent",
            provider: "test",
            model: "deterministic",
            text,
            textHash: sha256(text),
            textTruncated: false,
            durationMs: 1,
            policyDecisions: [],
            effectReceipts: [],
          },
        };
      },
    };
    const workflow = compileWorkflowText(parentToolPackageWorkflow());

    const state = await runWorkflow(workflow, {
      runId: "parent-tool-package",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor,
      workspaceIsolator: isolator,
      capabilitySnapshot: snapshot,
      now: clock(),
    });

    const childRunId = calculateChildRunId("parent-tool-package", "delegate", 1);
    const childState = reduceRunEvents(await store.read(childRunId));
    expect(state.status).toBe("succeeded");
    expect(observedDigest).toBe(snapshot.packages[0]?.digest);
    expect(childState).toMatchObject({
      status: "succeeded",
      capabilitySnapshot: { digest: snapshot.digest },
      toolPackageRequirements: {
        inspect: {
          rawExec: false,
          packages: [{ name: "project-report", version: "1.2.3" }],
        },
      },
    });
  });

  it("recovers a terminal child after a crash before the parent outcome append", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const executor = new ChildCommandExecutor();
    const workflow = compileWorkflowText(parentWorkflow());
    store.rejectNextParentOutcome = true;

    await expect(
      runWorkflow(workflow, {
        runId: "parent-crash",
        cwd: "/workspace",
        protectedPaths: ["/state/runs"],
        store,
        executor,
        workspaceIsolator: isolator,
        now: clock(),
      }),
    ).rejects.toThrow(/simulated parent outcome crash/i);

    const resumed = await resumeWorkflow(workflow, {
      runId: "parent-crash",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor,
      workspaceIsolator: isolator,
      now: clock(20),
    });

    expect(resumed.status).toBe("succeeded");
    expect(executor.calls).toHaveLength(1);
    expect(
      isolator.cleaned.filter((id) => id === calculateChildRunId("parent-crash", "delegate", 1)),
    ).toHaveLength(2);
  });

  it("revalidates a settled child tree before recovering the parent terminal event", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const executor = new ChildCommandExecutor();
    const workflow = compileWorkflowText(parentWorkflow());
    store.rejectNextParentSuccess = true;

    await expect(
      runWorkflow(workflow, {
        runId: "parent-settled-child-recovery",
        cwd: "/workspace",
        protectedPaths: ["/state/runs"],
        store,
        executor,
        workspaceIsolator: isolator,
        now: clock(),
      }),
    ).rejects.toThrow(/simulated parent success crash/i);

    const resumed = await resumeWorkflow(workflow, {
      runId: "parent-settled-child-recovery",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor,
      workspaceIsolator: isolator,
      now: clock(20),
    });

    expect(resumed).toMatchObject({ status: "succeeded", resources: { artifactBytes: 4 } });
    expect(executor.calls).toHaveLength(1);
  });

  it("rejects a settled child artifact total that diverges from its child ledger", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const executor = new ChildCommandExecutor();
    const workflow = compileWorkflowText(parentWorkflow());
    const runId = "parent-forged-child-artifacts";
    store.rejectNextParentSuccess = true;

    await expect(
      runWorkflow(workflow, {
        runId,
        cwd: "/workspace",
        protectedPaths: ["/state/runs"],
        store,
        executor,
        workspaceIsolator: isolator,
        now: clock(),
      }),
    ).rejects.toThrow(/simulated parent success crash/i);

    rewriteChildArtifactTotal(store, runId, 1);

    await expect(
      resumeWorkflow(workflow, {
        runId,
        cwd: "/workspace",
        protectedPaths: ["/state/runs"],
        store,
        executor,
        workspaceIsolator: isolator,
        now: clock(20),
      }),
    ).rejects.toMatchObject({ code: "child_recovery_ineligible" });
  });

  it("recursively rejects a forged grandchild total hidden by a matching parent projection", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const executor = new ChildCommandExecutor();
    const workflow = compileWorkflowText(nestedParentWorkflow());
    const runId = "parent-forged-grandchild-artifacts";
    store.rejectNextParentSuccess = true;

    await expect(
      runWorkflow(workflow, {
        runId,
        cwd: "/workspace",
        protectedPaths: ["/state/runs"],
        store,
        executor,
        workspaceIsolator: isolator,
        now: clock(),
      }),
    ).rejects.toThrow(/simulated parent success crash/i);

    const childRunId = calculateChildRunId(runId, "delegate", 1);
    rewriteChildArtifactTotal(store, childRunId, 1);
    rewriteChildArtifactTotal(store, runId, 1);

    await expect(
      resumeWorkflow(workflow, {
        runId,
        cwd: "/workspace",
        protectedPaths: ["/state/runs"],
        store,
        executor,
        workspaceIsolator: isolator,
        now: clock(30),
      }),
    ).rejects.toMatchObject({ code: "child_recovery_ineligible" });
  });

  it("cannot forge legacy status to hide a current child's artifact total", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const executor = new ChildCommandExecutor();
    const workflow = compileWorkflowText(parentWorkflow());
    const runId = "parent-forged-child-budget";
    store.rejectNextParentSuccess = true;

    await expect(
      runWorkflow(workflow, {
        runId,
        cwd: "/workspace",
        protectedPaths: ["/state/runs"],
        store,
        executor,
        workspaceIsolator: isolator,
        now: clock(),
      }),
    ).rejects.toThrow(/simulated parent success crash/i);

    const childRunId = calculateChildRunId(runId, "delegate", 1);
    const childEvents = store.events.get(childRunId);
    if (childEvents === undefined) {
      throw new Error("expected child events");
    }
    store.events.set(
      childRunId,
      childEvents.map((event) =>
        event.type === "run_started" && event.budget !== undefined
          ? {
              ...event,
              budget: {
                ...(event.budget.maxNodeStarts === undefined
                  ? {}
                  : { maxNodeStarts: event.budget.maxNodeStarts }),
                ...(event.budget.maxModelTokens === undefined
                  ? {}
                  : { maxModelTokens: event.budget.maxModelTokens }),
                ...(event.budget.maxCostUsdMicros === undefined
                  ? {}
                  : { maxCostUsdMicros: event.budget.maxCostUsdMicros }),
                ...(event.budget.maxExecutionMs === undefined
                  ? {}
                  : { maxExecutionMs: event.budget.maxExecutionMs }),
              },
            }
          : event,
      ),
    );
    rewriteChildArtifactTotal(store, runId, 0);

    await expect(
      resumeWorkflow(workflow, {
        runId,
        cwd: "/workspace",
        protectedPaths: ["/state/runs"],
        store,
        executor,
        workspaceIsolator: isolator,
        now: clock(30),
      }),
    ).rejects.toMatchObject({ code: "child_recovery_ineligible" });
  });

  it("does not materialize a child whose ceiling exceeds the parent remaining budget", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const workflow = compileWorkflowText(
      parentWorkflow().replace("maxNodeStarts: 32", "maxNodeStarts: 2"),
    );

    const state = await runWorkflow(workflow, {
      runId: "parent-budget",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor: new ChildCommandExecutor(),
      workspaceIsolator: isolator,
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "failed",
      nodes: {
        delegate: {
          error: { code: "child_budget_unavailable", sideEffectStatus: "none" },
          evidence: null,
        },
      },
    });
    expect(isolator.created).toEqual([]);
  });

  it("does not materialize a child whose artifact ceiling exceeds parent capacity", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const workflow = compileWorkflowText(
      parentWorkflow().replace("maxArtifactBytes: 1000000", "maxArtifactBytes: 99999"),
    );

    const state = await runWorkflow(workflow, {
      runId: "parent-artifact-budget",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor: new ChildCommandExecutor(),
      workspaceIsolator: isolator,
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "failed",
      nodes: {
        delegate: {
          error: {
            code: "child_budget_unavailable",
            message: expect.stringMatching(/artifactBytes/),
          },
          evidence: null,
        },
      },
    });
    expect(isolator.created).toEqual([]);
  });

  it("imports a failed child as terminal linked evidence", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const workflow = compileWorkflowText(parentWorkflow());

    const state = await runWorkflow(workflow, {
      runId: "parent-child-failure",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor: new FailingChildCommandExecutor(),
      workspaceIsolator: isolator,
      now: clock(),
    });

    const childRunId = calculateChildRunId("parent-child-failure", "delegate", 1);
    expect(state).toMatchObject({
      status: "failed",
      nodes: {
        delegate: {
          error: { code: "child_run_failed", sideEffectStatus: "none" },
          evidence: {
            kind: "child",
            childRunId,
            outcome: "failed",
            result: null,
            workspace: { disposition: "discarded" },
          },
        },
      },
    });
    expect(reduceRunEvents(await store.read(childRunId)).status).toBe("failed");
    expect(isolator.cleaned).toContain(childRunId);
  });

  it("propagates cancellation to the active child and terminalizes both ledgers", async () => {
    const controller = new AbortController();
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const workflow = compileWorkflowText(parentWorkflow());

    const state = await runWorkflow(workflow, {
      runId: "parent-cancel",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor: new CancellingChildCommandExecutor(controller),
      workspaceIsolator: isolator,
      signal: controller.signal,
      now: clock(),
    });

    const childRunId = calculateChildRunId("parent-cancel", "delegate", 1);
    const childState = reduceRunEvents(await store.read(childRunId));
    expect(state.status).toBe("cancelled");
    expect(childState.status).toBe("cancelled");
    expect(state.nodes.delegate?.evidence).toMatchObject({
      kind: "child",
      childRunId,
      outcome: "cancelled",
      workspace: { disposition: "discarded" },
    });
  });

  it("imports a durable child success when cancellation arrives during terminal cleanup", async () => {
    const controller = new AbortController();
    const store = new TreeMemoryStore();
    const isolator = new CancellingCleanupWorkspaceIsolator(controller);
    const workflow = compileWorkflowText(parentWorkflow());

    const state = await runWorkflow(workflow, {
      runId: "parent-cancel-after-child",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor: new ChildCommandExecutor(),
      workspaceIsolator: isolator,
      signal: controller.signal,
      now: clock(),
    });

    const childRunId = calculateChildRunId("parent-cancel-after-child", "delegate", 1);
    expect(reduceRunEvents(await store.read(childRunId)).status).toBe("succeeded");
    expect(state).toMatchObject({
      status: "cancelled",
      nodes: {
        delegate: {
          status: "succeeded",
          evidence: {
            kind: "child",
            childRunId,
            outcome: "succeeded",
            workspace: { disposition: "discarded" },
          },
        },
      },
    });
  });

  it("cancels a durably admitted child before workspace materialization", async () => {
    const controller = new AbortController();
    const store = new TreeMemoryStore();
    store.abortOnParentChildStart = controller;
    const isolator = new MemoryWorkspaceIsolator();
    const workflow = compileWorkflowText(parentWorkflow());

    const state = await runWorkflow(workflow, {
      runId: "parent-cancel-before-child",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor: new ChildCommandExecutor(),
      workspaceIsolator: isolator,
      signal: controller.signal,
      now: clock(),
    });

    const childRunId = calculateChildRunId("parent-cancel-before-child", "delegate", 1);
    expect(state).toMatchObject({
      status: "cancelled",
      nodes: {
        delegate: {
          status: "failed",
          error: { code: "child_cancelled_before_start", sideEffectStatus: "none" },
          evidence: null,
        },
      },
    });
    expect(await store.exists(childRunId)).toBe(false);
    expect(isolator.created).toEqual([]);
  });

  it("executes ready sibling children concurrently in distinct workspaces", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const executor = new ConcurrentChildCommandExecutor(2);
    const workflow = compileWorkflowText(parentWorkflowWithTwoChildren(64));

    const state = await runWorkflow(workflow, {
      runId: "parent-concurrent",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor,
      workspaceIsolator: isolator,
      now: clock(),
    });

    expect(state.status).toBe("succeeded");
    expect(executor.maximumActive).toBe(2);
    expect(
      new Set(executor.calls.filter((call) => call.nodeId === "produce").map((call) => call.cwd))
        .size,
    ).toBe(2);
    expect(isolator.created).toHaveLength(2);
  });

  it("reserves sibling child ceilings as a tree-wide aggregate", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const workflow = compileWorkflowText(parentWorkflowWithTwoChildren(18));

    const state = await runWorkflow(workflow, {
      runId: "parent-sibling-budget",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor: new ChildCommandExecutor(),
      workspaceIsolator: isolator,
      now: clock(),
    });

    expect(state.status).toBe("failed");
    expect(state.nodes["delegate-b"]?.error?.code).toBe("child_budget_unavailable");
    expect(isolator.created).toHaveLength(1);
  });

  it("reserves concurrent sibling artifact ceilings without overcommit", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const workflow = compileWorkflowText(
      parentWorkflowWithTwoChildren(64).replace(
        "maxArtifactBytes: 1000000",
        "maxArtifactBytes: 150000",
      ),
    );

    const state = await runWorkflow(workflow, {
      runId: "parent-sibling-artifact-budget",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor: new ChildCommandExecutor(),
      workspaceIsolator: isolator,
      now: clock(),
    });

    expect(state.status).toBe("failed");
    expect(state.nodes["delegate-b"]?.error).toMatchObject({
      code: "child_budget_unavailable",
      message: expect.stringMatching(/artifactBytes/),
    });
    expect(isolator.created).toHaveLength(1);
  });

  it("recreates a stale pre-ledger workspace after an interrupted child start", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const executor = new ChildCommandExecutor();
    const workflow = compileWorkflowText(parentWorkflow());
    store.rejectNextChildRunStart = true;

    await expect(
      runWorkflow(workflow, {
        runId: "parent-pre-ledger-crash",
        cwd: "/workspace",
        protectedPaths: ["/state/runs"],
        store,
        executor,
        workspaceIsolator: isolator,
        now: clock(),
      }),
    ).rejects.toThrow(/simulated child start crash/i);

    const childRunId = calculateChildRunId("parent-pre-ledger-crash", "delegate", 1);
    expect(isolator.workspaces.has(childRunId)).toBe(true);
    expect(await store.exists(childRunId)).toBe(false);

    const resumed = await resumeWorkflow(workflow, {
      runId: "parent-pre-ledger-crash",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor,
      workspaceIsolator: isolator,
      now: clock(20),
    });

    expect(resumed.status).toBe("succeeded");
    expect(isolator.created.filter((id) => id === childRunId)).toHaveLength(2);
  });

  it("fails closed when a nonterminal child loses its exact workspace", async () => {
    const store = new TreeMemoryStore();
    const isolator = new MemoryWorkspaceIsolator();
    const workflow = compileWorkflowText(parentWorkflow());
    store.rejectNextChildOutcome = true;

    await expect(
      runWorkflow(workflow, {
        runId: "parent-missing-child-workspace",
        cwd: "/workspace",
        protectedPaths: ["/state/runs"],
        store,
        executor: new ChildCommandExecutor(),
        workspaceIsolator: isolator,
        now: clock(),
      }),
    ).rejects.toThrow(/simulated child outcome crash/i);

    const childRunId = calculateChildRunId("parent-missing-child-workspace", "delegate", 1);
    isolator.workspaces.delete(childRunId);

    await expect(
      resumeWorkflow(workflow, {
        runId: "parent-missing-child-workspace",
        cwd: "/workspace",
        protectedPaths: ["/state/runs"],
        store,
        executor: new ChildCommandExecutor(),
        workspaceIsolator: isolator,
        now: clock(20),
      }),
    ).rejects.toMatchObject({
      code: "child_recovery_ineligible",
      message: expect.stringMatching(/workspace .* is missing/i),
    });
  });

  it("publishes an outer typed result from the imported child value", async () => {
    const workflow = compileWorkflowText(`${parentWorkflow()}  - id: outer-result
    type: result
    dependsOn: [delegate]
    result:
      source: { nodeId: delegate, field: result.value }
      schema: { type: boolean }
`);

    const state = await runWorkflow(workflow, {
      runId: "parent-result-composition",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store: new TreeMemoryStore(),
      executor: new ChildCommandExecutor(),
      workspaceIsolator: new MemoryWorkspaceIsolator(),
      now: clock(),
    });

    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "outer-result": {
          control: { kind: "result", canonicalValue: "true", valueHash: sha256("true") },
        },
      },
    });
  });

  it("binds imported child result provenance into a model verifier", async () => {
    const workflow = compileWorkflowText(`${parentWorkflow()}  - id: review
    type: verifier
    dependsOn: [delegate]
    verifier:
      kind: model
      prompt: Verify the child result.
      evidence: [{ nodeId: delegate, field: result.value }]
      model: { provider: test, id: deterministic }
`);
    const executor = new ChildResultVerifierExecutor();

    const state = await runWorkflow(workflow, {
      runId: "parent-verifier-composition",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store: new TreeMemoryStore(),
      executor,
      workspaceIsolator: new MemoryWorkspaceIsolator(),
      now: clock(),
    });

    expect(state.status).toBe("succeeded");
    expect(executor.verifierSources).toEqual([
      {
        sourceNodeId: "delegate",
        sourceAttempt: 1,
        sourceField: "result.value",
        sourceHash: sha256("true"),
        value: "true",
        truncated: false,
      },
    ]);
  });
});

class TreeMemoryStore implements RecoverableRunEventStore {
  readonly events = new Map<string, RunEvent[]>();
  abortOnParentChildStart: AbortController | undefined;
  rejectNextParentOutcome = false;
  rejectNextParentSuccess = false;
  rejectNextChildRunStart = false;
  rejectNextChildOutcome = false;

  async append(input: RunEvent): Promise<void> {
    const event = parseRunEvent(input);
    if (
      this.rejectNextParentOutcome &&
      event.runId.startsWith("parent-") &&
      event.type === "node_succeeded" &&
      event.nodeId === "delegate"
    ) {
      this.rejectNextParentOutcome = false;
      throw new Error("simulated parent outcome crash");
    }
    if (
      this.rejectNextParentSuccess &&
      event.runId.startsWith("parent-") &&
      event.type === "run_succeeded"
    ) {
      this.rejectNextParentSuccess = false;
      throw new Error("simulated parent success crash");
    }
    if (
      this.rejectNextChildRunStart &&
      event.runId.startsWith("child-") &&
      event.type === "run_started"
    ) {
      this.rejectNextChildRunStart = false;
      throw new Error("simulated child start crash");
    }
    if (
      this.rejectNextChildOutcome &&
      event.runId.startsWith("child-") &&
      event.type === "node_succeeded"
    ) {
      this.rejectNextChildOutcome = false;
      throw new Error("simulated child outcome crash");
    }
    const existing = this.events.get(event.runId) ?? [];
    this.events.set(event.runId, [...existing, event]);
    if (
      event.runId.startsWith("parent-") &&
      event.type === "node_started" &&
      event.child !== undefined
    ) {
      this.abortOnParentChildStart?.abort("operator stop before child materialization");
    }
  }

  async read(runId: string): Promise<readonly RunEvent[]> {
    return this.events.get(runId) ?? [];
  }

  async claim(runId: string): Promise<readonly RunEvent[]> {
    const events = await this.read(runId);
    if (events.length === 0) {
      throw new Error(`run "${runId}" is missing`);
    }
    return events;
  }

  async exists(runId: string): Promise<boolean> {
    return (this.events.get(runId)?.length ?? 0) > 0;
  }

  async release(_runId: string): Promise<void> {}
}

class MemoryWorkspaceIsolator implements WorkspaceIsolator {
  readonly workspaces = new Map<string, IsolatedWorkspace>();
  readonly created: string[] = [];
  readonly reopened: string[] = [];
  readonly cleaned: string[] = [];

  async create(request: {
    readonly workspaceId: string;
    readonly sourceCwd: string;
  }): Promise<IsolatedWorkspace> {
    if (this.workspaces.has(request.workspaceId)) {
      throw new Error(`workspace "${request.workspaceId}" already exists`);
    }
    const workspace = Object.freeze({
      workspaceId: request.workspaceId,
      cwd: `/isolated/${request.workspaceId}`,
      backend: "reflink-copy-v1" as const,
      snapshotDigest: "a".repeat(64),
    });
    this.created.push(request.workspaceId);
    this.workspaces.set(request.workspaceId, workspace);
    return workspace;
  }

  async reopen(request: {
    readonly workspaceId: string;
    readonly sourceCwd: string;
  }): Promise<IsolatedWorkspace> {
    this.reopened.push(request.workspaceId);
    const workspace = this.workspaces.get(request.workspaceId);
    if (workspace === undefined) {
      throw new Error(`workspace "${request.workspaceId}" is missing`);
    }
    return workspace;
  }

  async cleanup(workspaceId: string): Promise<"discarded"> {
    this.cleaned.push(workspaceId);
    this.workspaces.delete(workspaceId);
    return "discarded";
  }
}

class CancellingCleanupWorkspaceIsolator extends MemoryWorkspaceIsolator {
  constructor(private readonly controller: AbortController) {
    super();
  }

  override async cleanup(workspaceId: string): Promise<"discarded"> {
    const disposition = await super.cleanup(workspaceId);
    this.controller.abort("operator stop after child completion");
    return disposition;
  }
}

class ChildCommandExecutor implements NodeExecutor {
  readonly calls: Array<{ readonly nodeId: string; readonly cwd: string }> = [];

  async execute(node: CompiledNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    if (node.type !== "command") {
      throw new Error(`unexpected executor node "${node.type}"`);
    }
    this.calls.push({ nodeId: node.id, cwd: context.cwd });
    return {
      status: "succeeded",
      evidence: {
        kind: "command",
        executable: node.command.executable,
        args: node.command.args,
        exitCode: 0,
        signal: null,
        stdout: "true",
        stderr: "",
        stdoutHash: sha256("true"),
        stderrHash: sha256(""),
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        durationMs: 5,
      },
    };
  }
}

class FailingChildCommandExecutor implements NodeExecutor {
  async execute(node: CompiledNode, _context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    if (node.type !== "command") {
      throw new Error(`unexpected executor node "${node.type}"`);
    }
    return {
      status: "failed",
      error: {
        code: "command_failed",
        message: "child command failed",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: {
        kind: "command",
        executable: node.command.executable,
        args: node.command.args,
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "failed",
        stdoutHash: sha256(""),
        stderrHash: sha256("failed"),
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        durationMs: 5,
      },
    };
  }
}

class CancellingChildCommandExecutor extends ChildCommandExecutor {
  constructor(private readonly controller: AbortController) {
    super();
  }

  override async execute(
    node: CompiledNode,
    context: NodeExecutionContext,
  ): Promise<NodeExecutionOutcome> {
    const outcome = await super.execute(node, context);
    this.controller.abort("operator stop");
    return outcome;
  }
}

class ConcurrentChildCommandExecutor extends ChildCommandExecutor {
  active = 0;
  maximumActive = 0;
  readonly #target: number;
  #release: (() => void) | undefined;
  readonly #barrier: Promise<void>;

  constructor(target: number) {
    super();
    this.#target = target;
    this.#barrier = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  override async execute(
    node: CompiledNode,
    context: NodeExecutionContext,
  ): Promise<NodeExecutionOutcome> {
    if (node.id === "bootstrap") {
      return await super.execute(node, context);
    }
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    if (this.active === this.#target) {
      this.#release?.();
    }
    await this.#barrier;
    try {
      return await super.execute(node, context);
    } finally {
      this.active -= 1;
    }
  }
}

class ChildResultVerifierExecutor extends ChildCommandExecutor {
  verifierSources: NodeExecutionContext["verifierSources"];

  override async execute(
    node: CompiledNode,
    context: NodeExecutionContext,
  ): Promise<NodeExecutionOutcome> {
    if (node.type !== "verifier") {
      return await super.execute(node, context);
    }
    this.verifierSources = context.verifierSources;
    const reason = "child result is accepted";
    return {
      status: "succeeded",
      evidence: {
        kind: "verifier",
        verdict: "accepted",
        reason,
        reasonHash: sha256(reason),
        durationMs: 1,
        sources: (context.verifierSources ?? []).map((source) => ({
          sourceNodeId: source.sourceNodeId,
          sourceAttempt: source.sourceAttempt,
          sourceField: source.sourceField,
          sourceHash: source.sourceHash,
        })),
        driver: "model",
        result: "parsed",
        provider: "test",
        model: "deterministic",
        raw: '{"verdict":"accepted","reason":"child result is accepted"}',
        rawHash: sha256('{"verdict":"accepted","reason":"child result is accepted"}'),
        rawTruncated: false,
      },
    };
  }
}

function parentWorkflow(childMaxArtifactBytes = 100000): string {
  const child = childWorkflowSource(childMaxArtifactBytes);
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: parent-workflow }
budget:
  maxNodeStarts: 32
  maxModelTokens: 10000
  maxCostUsd: 2
  maxExecutionMs: 300000
  maxArtifactBytes: 1000000
nodes:
${childNode("delegate", child)}
`;
}

function nestedParentWorkflow(): string {
  const leaf = childWorkflowSource();
  const middle = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: middle-child-analysis }
budget:
  maxNodeStarts: 16
  maxModelTokens: 2000
  maxCostUsd: 0.5
  maxExecutionMs: 120000
  maxArtifactBytes: 200000
nodes:
${childNode("nested", leaf)}  - id: publish
    type: result
    dependsOn: [nested]
    result:
      source: { nodeId: nested, field: result.value }
      schema: { type: boolean }
`.trim();
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: nested-parent-workflow }
budget:
  maxNodeStarts: 32
  maxModelTokens: 10000
  maxCostUsd: 2
  maxExecutionMs: 300000
  maxArtifactBytes: 1000000
nodes:
${childNode("delegate", middle)}
`;
}

function parentWorkflowWithTwoChildren(maxNodeStarts: number): string {
  const child = childWorkflowSource();
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: parent-concurrent-workflow }
budget:
  maxNodeStarts: ${maxNodeStarts}
  maxModelTokens: 10000
  maxCostUsd: 2
  maxExecutionMs: 300000
  maxArtifactBytes: 1000000
concurrency: { maxNodes: 2 }
nodes:
  - id: bootstrap
    type: command
    command: { executable: node }
${childNode("delegate-a", child, ["bootstrap"])}
${childNode("delegate-b", child, ["bootstrap"])}
`;
}

function parentPackagedVerifierWorkflow(): string {
  const child = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: packaged-verifier-child }
budget:
  maxNodeStarts: 4
  maxModelTokens: 100
  maxCostUsd: 0.01
  maxExecutionMs: 10000
  maxArtifactBytes: 100000
nodes:
  - id: verify
    type: verifier
    verifier:
      kind: packaged-command
      package: { name: release-tests, version: 1.0.0 }
  - id: produce
    type: command
    dependsOn: [verify]
    command: { executable: node, args: [produce] }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: string, maxLength: 1024 }
`.trim();
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: parent-packaged-verifier }
nodes:
${childNode("delegate", child)}
`;
}

function parentToolPackageWorkflow(): string {
  const child = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: tool-package-child }
budget:
  maxNodeStarts: 4
  maxModelTokens: 100
  maxCostUsd: 0.01
  maxExecutionMs: 10000
  maxArtifactBytes: 100000
nodes:
  - id: inspect
    type: agent
    agent:
      prompt: Inspect the project.
      model: { provider: test, id: deterministic }
      tools: [read]
      toolPackages:
        - { name: project-report, version: 1.2.3 }
  - id: publish
    type: result
    dependsOn: [inspect]
    result:
      source: { nodeId: inspect, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`.trim();
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: parent-tool-package }
nodes:
${childNode("delegate", child)}
`;
}

function childWorkflowSource(maxArtifactBytes = 100000): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: child-analysis }
budget:
  maxNodeStarts: 8
  maxModelTokens: 1000
  maxCostUsd: 0.25
  maxExecutionMs: 60000
  maxArtifactBytes: ${maxArtifactBytes}
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
`.trim();
}

function childNode(id: string, child: string, dependsOn: readonly string[] = []): string {
  return `  - id: ${id}
    type: child
${dependsOn.length === 0 ? "" : `    dependsOn: [${dependsOn.join(", ")}]\n`}    child:
      resultNodeId: publish
      workflow: |
${child
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
`;
}

function rewriteChildArtifactTotal(store: TreeMemoryStore, runId: string, artifactBytes: number) {
  const events = store.events.get(runId);
  if (events === undefined) {
    throw new Error(`expected events for run "${runId}"`);
  }
  store.events.set(
    runId,
    events.map((event) =>
      (event.type === "node_succeeded" || event.type === "node_failed") &&
      event.evidence?.kind === "child"
        ? {
            ...event,
            evidence: {
              ...event.evidence,
              resources: { ...event.evidence.resources, artifactBytes },
            },
          }
        : event,
    ),
  );
}

function clock(start = 0): () => Date {
  let seconds = start;
  return () => {
    seconds += 1;
    return new Date(`2026-08-08T00:00:${String(seconds).padStart(2, "0")}.000Z`);
  };
}

function verifierPackageInput(
  name: string,
  version: string,
  definition: VerifierPackageSnapshotInput["definition"],
): VerifierPackageSnapshotInput {
  if (definition.kind !== "command") {
    throw new Error("child verifier fixture requires a command package");
  }
  return {
    kind: "verifier-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name,
    version,
    description: `Reusable ${name} verifier.`,
    trust: "project-explicit",
    provenance: `.flow/verifiers/${name}`,
    definition,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: ${name}, version: ${version}, description: Reusable ${name} verifier. }
spec:
  kind: command
  command: { executable: ${definition.command.executable}, args: [${definition.command.args.join(", ")}], timeoutMs: ${definition.command.timeoutMs} }
`),
    },
  };
}

function toolPackageInput(name: string, version: string): ToolPackageSnapshotInput {
  const definition: ToolPackageSnapshotInput["definition"] = {
    tool: {
      name: "create_project_report",
      description: "Print a selected report subject.",
      inputs: [{ name: "subject", description: "Report subject.", type: "string" }],
    },
    driver: {
      kind: "command",
      version: "v1",
      profile: "posix-printf-v1",
      executable: "/usr/bin/printf",
      args: ["%s", "{input:subject}"],
      timeoutMs: 10_000,
    },
    permissions: ["process.execute"],
  };
  return {
    kind: "tool-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name,
    version,
    description: `Reusable ${name} tool.`,
    trust: "project-explicit",
    provenance: `.flow/tools/${name}`,
    definition,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata: { name: ${name}, version: ${version}, description: Reusable ${name} tool. }
spec:
  tool:
    name: create_project_report
    description: Print a selected report subject.
    inputs:
      - { name: subject, description: Report subject., type: string }
  driver:
    kind: command
    version: v1
    profile: posix-printf-v1
    executable: /usr/bin/printf
    args: ["%s", "{input:subject}"]
    timeoutMs: 10000
  permissions: [process.execute]
`),
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
