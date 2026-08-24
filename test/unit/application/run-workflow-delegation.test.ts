import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type {
  IsolatedWorkspace,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
  WorkspaceIsolator,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import {
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  calculateChildRunId,
  parseRunEvent,
  reduceRunEvents,
  type AgentDelegationReceipt,
  type RunEvent,
} from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { delegationEvaluationCandidateFixture } from "../../fixtures/delegation-evaluation-candidate.js";

describe("bounded delegation runtime", () => {
  it("runs one sealed child call and charges its resources once", async () => {
    const fixture = delegationEvaluationCandidateFixture();
    const capabilitySnapshot = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      delegation: fixture.projected.snapshot,
      digest: calculateCapabilitySnapshotDigest(
        [],
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        fixture.projected.snapshot,
      ),
    });
    const store = new MemoryRunStore();
    const isolator = new MemoryWorkspaceIsolator();
    const observations: string[] = [];
    const executor: NodeExecutor = {
      async execute(node, context) {
        if (node.type !== "agent") {
          throw new Error(`unexpected executor node "${node.type}"`);
        }
        if (node.id === "review") {
          expect(context.capabilitySnapshot?.delegation).toBeUndefined();
          expect(context.delegationSession).toBeUndefined();
          expect(context.agentSystemPrompt).toContain(fixture.source.delegation.objective);
          expect(context.agentSystemPrompt).toContain("Do not delegate");
          observations.push("child");
          return agentSuccess(JSON.stringify("approved"), 3);
        }
        if (node.id !== "manager" || context.delegationSession === undefined) {
          throw new Error(`manager "${node.id}" has no delegation session`);
        }

        const result = await context.delegationSession.delegate(context.signal);
        observations.push(`manager:${result.canonicalValue}`);
        await expect(context.delegationSession.delegate(context.signal)).rejects.toThrow(
          /already invoked/i,
        );
        return agentSuccess(JSON.stringify("completed"), 7, context.delegationSession.receipts());
      },
    };

    const state = await runWorkflow(compileWorkflowText(fixture.baselineText), {
      runId: "delegation-runtime",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor,
      workspaceIsolator: isolator,
      capabilitySnapshot,
      now: clock(),
    });

    const childRunId = calculateChildRunId("delegation-runtime", "manager", 1);
    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 2 },
      nodes: {
        manager: {
          delegations: [
            {
              sequence: 1,
              child: { runId: childRunId },
              settlement: {
                evidence: {
                  kind: "child",
                  childRunId,
                  outcome: "succeeded",
                  result: { canonicalValue: JSON.stringify("approved") },
                  resources: { nodeStarts: 1 },
                  workspace: { disposition: "discarded" },
                },
              },
            },
          ],
          evidence: {
            kind: "agent",
            delegationReceipts: [
              {
                version: 1,
                sequence: 1,
                childRunId,
                outcome: "succeeded",
              },
            ],
          },
        },
      },
    });
    expect(observations).toEqual(["child", `manager:${JSON.stringify("approved")}`]);
    expect(isolator.cleaned).toEqual([childRunId]);
    expect(store.events.get("delegation-runtime")?.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_delegation_prepared",
      "node_delegation_settled",
      "node_succeeded",
      "node_result_published",
      "run_succeeded",
    ]);
    const parentEvents = store.events.get("delegation-runtime") ?? [];
    expect(() =>
      reduceRunEvents(
        parentEvents
          .filter((event) => event.type !== "node_delegation_settled")
          .map((event) =>
            event.sequence > 4 ? { ...event, sequence: event.sequence - 1 } : event,
          ),
      ),
    ).toThrow(/remains prepared/i);
    expect(() =>
      reduceRunEvents(
        parentEvents.map((event) =>
          event.type === "node_delegation_prepared"
            ? { ...event, snapshotDigest: "f".repeat(64) }
            : event,
        ),
      ),
    ).toThrow(/preparation does not match/i);
    expect(() =>
      reduceRunEvents(
        parentEvents.map((event) =>
          event.type === "node_succeeded" && event.evidence.kind === "agent"
            ? {
                ...event,
                evidence: {
                  ...event.evidence,
                  delegationReceipts: (event.evidence.delegationReceipts ?? []).map((receipt) => ({
                    ...receipt,
                    childRunId: "child-forged",
                  })),
                },
              }
            : event,
        ),
      ),
    ).toThrow(/receipt does not match/i);
    const unsuccessfulEvents = parentEvents.map((event): RunEvent => {
      if (event.type === "node_delegation_settled") {
        return {
          ...event,
          evidence: { ...event.evidence, outcome: "failed", result: null },
        };
      }
      if (event.type === "node_succeeded" && event.evidence.kind === "agent") {
        return {
          ...event,
          evidence: {
            ...event.evidence,
            delegationReceipts: (event.evidence.delegationReceipts ?? []).map((receipt) => ({
              ...receipt,
              outcome: "failed",
              resultValueHash: null,
            })),
          },
        };
      }
      return event;
    });
    expect(() => reduceRunEvents(unsuccessfulEvents)).toThrow(/unsuccessful delegation/i);
  });

  it("reconciles the exact terminal child but never retries an interrupted manager", async () => {
    const fixture = delegationEvaluationCandidateFixture();
    const capabilitySnapshot = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      delegation: fixture.projected.snapshot,
      digest: calculateCapabilitySnapshotDigest(
        [],
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        fixture.projected.snapshot,
      ),
    });
    const store = new MemoryRunStore();
    store.rejectNextDelegationSettlement = true;
    const isolator = new MemoryWorkspaceIsolator();
    let managerCalls = 0;
    let childCalls = 0;
    const executor: NodeExecutor = {
      async execute(node, context) {
        if (node.type !== "agent") throw new Error(`unexpected executor node "${node.type}"`);
        if (node.id === "review") {
          childCalls += 1;
          return agentSuccess(JSON.stringify("approved"), 3);
        }
        managerCalls += 1;
        if (context.delegationSession === undefined) throw new Error("missing delegation session");
        const result = await context.delegationSession.delegate(context.signal);
        return agentSuccess(result.canonicalValue, 7, context.delegationSession.receipts());
      },
    };
    const workflow = compileWorkflowText(fixture.baselineText);
    const options = {
      runId: "delegation-recovery",
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor,
      workspaceIsolator: isolator,
      capabilitySnapshot,
      now: clock(),
    } as const;

    await expect(runWorkflow(workflow, options)).rejects.toThrow(
      /simulated delegation settlement crash/i,
    );
    const childRunId = calculateChildRunId("delegation-recovery", "manager", 1);
    expect(store.events.get(childRunId)?.at(-1)?.type).toBe("run_succeeded");
    expect(store.events.get("delegation-recovery")?.at(-1)?.type).toBe("node_delegation_prepared");

    await expect(
      resumeWorkflow(workflow, { ...options, runId: "delegation-recovery", now: clock() }),
    ).rejects.toMatchObject({ code: "uncertain_operation" });

    expect(managerCalls).toBe(1);
    expect(childCalls).toBe(1);
    expect(store.events.get("delegation-recovery")?.at(-1)).toMatchObject({
      type: "node_delegation_settled",
      evidence: { childRunId, outcome: "succeeded" },
    });
  });

  it("propagates cancellation through the child boundary and cleans before manager settlement", async () => {
    const fixture = delegationEvaluationCandidateFixture();
    const capabilitySnapshot = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      delegation: fixture.projected.snapshot,
      digest: calculateCapabilitySnapshotDigest(
        [],
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        fixture.projected.snapshot,
      ),
    });
    const store = new MemoryRunStore();
    const isolator = new MemoryWorkspaceIsolator();
    const controller = new AbortController();
    const runId = "delegation-cancelled";
    const childRunId = calculateChildRunId(runId, "manager", 1);
    let releaseChildStart: () => void = () => undefined;
    const childStarted = new Promise<void>((resolve) => {
      releaseChildStart = resolve;
    });
    let managerObservedCleanup = false;
    const executor: NodeExecutor = {
      async execute(node, context) {
        if (node.type !== "agent") throw new Error(`unexpected executor node "${node.type}"`);
        if (node.id === "review") {
          releaseChildStart();
          await aborted(context.signal);
          return agentFailure("delegated child was cancelled");
        }
        if (context.delegationSession === undefined) throw new Error("missing delegation session");
        try {
          await context.delegationSession.delegate(context.signal);
          throw new Error("cancelled delegation unexpectedly succeeded");
        } catch {
          managerObservedCleanup = !isolator.workspaces.has(childRunId);
          return agentFailure("delegation was cancelled", context.delegationSession.receipts());
        }
      },
    };

    const execution = runWorkflow(compileWorkflowText(fixture.baselineText), {
      runId,
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor,
      workspaceIsolator: isolator,
      capabilitySnapshot,
      signal: controller.signal,
      now: clock(),
    });
    await childStarted;
    controller.abort(new Error("operator cancelled delegation evaluation"));

    const state = await execution;

    expect(state.status).toBe("cancelled");
    expect(managerObservedCleanup).toBe(true);
    expect(isolator.workspaces.has(childRunId)).toBe(false);
    const parentEventTypes = store.events.get(runId)?.map((event) => event.type) ?? [];
    expect(parentEventTypes.indexOf("node_delegation_settled")).toBeGreaterThan(
      parentEventTypes.indexOf("node_delegation_prepared"),
    );
    expect(parentEventTypes.at(-1)).toBe("run_cancelled");
  });

  it("cleans a prepared delegation with no child ledger and leaves it uncertain", async () => {
    const fixture = delegationEvaluationCandidateFixture();
    const capabilitySnapshot = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      delegation: fixture.projected.snapshot,
      digest: calculateCapabilitySnapshotDigest(
        [],
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        fixture.projected.snapshot,
      ),
    });
    const store = new MemoryRunStore();
    store.rejectNextChildRunStart = true;
    const isolator = new MemoryWorkspaceIsolator();
    let managerCalls = 0;
    let childCalls = 0;
    const executor: NodeExecutor = {
      async execute(node, context) {
        if (node.type !== "agent") throw new Error(`unexpected executor node "${node.type}"`);
        if (node.id === "review") {
          childCalls += 1;
          return agentSuccess(JSON.stringify("approved"), 3);
        }
        managerCalls += 1;
        if (context.delegationSession === undefined) throw new Error("missing delegation session");
        await context.delegationSession.delegate(context.signal);
        return agentSuccess(JSON.stringify("completed"), 7, context.delegationSession.receipts());
      },
    };
    const workflow = compileWorkflowText(fixture.baselineText);
    const runId = "delegation-pre-ledger";
    const childRunId = calculateChildRunId(runId, "manager", 1);
    const options = {
      runId,
      cwd: "/workspace",
      protectedPaths: ["/state/runs"],
      store,
      executor,
      workspaceIsolator: isolator,
      capabilitySnapshot,
      now: clock(),
    } as const;

    await expect(runWorkflow(workflow, options)).rejects.toThrow(/remains prepared/i);
    expect(store.events.has(childRunId)).toBe(false);
    expect(isolator.workspaces.has(childRunId)).toBe(true);

    await expect(
      resumeWorkflow(workflow, { ...options, runId, now: clock() }),
    ).rejects.toMatchObject({ code: "uncertain_operation" });

    expect(managerCalls).toBe(1);
    expect(childCalls).toBe(0);
    expect(isolator.workspaces.has(childRunId)).toBe(false);
    expect(store.events.get(runId)?.at(-1)?.type).toBe("node_delegation_prepared");
  });
});

function agentSuccess(
  text: string,
  durationMs: number,
  delegationReceipts?: readonly AgentDelegationReceipt[],
): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text,
      textHash: sha256(text),
      textTruncated: false,
      durationMs,
      policyDecisions: [],
      effectReceipts: [],
      ...(delegationReceipts === undefined ? {} : { delegationReceipts }),
    },
  };
}

function agentFailure(
  message: string,
  delegationReceipts?: readonly AgentDelegationReceipt[],
): NodeExecutionOutcome {
  const text = JSON.stringify(message);
  return {
    status: "failed",
    error: {
      code: "test_cancelled",
      message,
      retryable: false,
      sideEffectStatus: "none",
    },
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
      ...(delegationReceipts === undefined ? {} : { delegationReceipts }),
    },
  };
}

async function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) throw new Error("delegated child received no cancellation signal");
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

class MemoryRunStore implements RecoverableRunEventStore {
  readonly events = new Map<string, RunEvent[]>();
  rejectNextDelegationSettlement = false;
  rejectNextChildRunStart = false;

  async append(input: RunEvent): Promise<void> {
    const event = parseRunEvent(input);
    if (this.rejectNextDelegationSettlement && event.type === "node_delegation_settled") {
      this.rejectNextDelegationSettlement = false;
      throw new Error("simulated delegation settlement crash");
    }
    if (
      this.rejectNextChildRunStart &&
      event.runId.startsWith("child-") &&
      event.type === "run_started"
    ) {
      this.rejectNextChildRunStart = false;
      throw new Error("simulated child start crash");
    }
    this.events.set(event.runId, [...(this.events.get(event.runId) ?? []), event]);
  }

  async read(runId: string): Promise<readonly RunEvent[]> {
    return this.events.get(runId) ?? [];
  }

  async claim(runId: string): Promise<readonly RunEvent[]> {
    const events = await this.read(runId);
    if (events.length === 0) throw new Error(`run "${runId}" is missing`);
    return events;
  }

  async exists(runId: string): Promise<boolean> {
    return (this.events.get(runId)?.length ?? 0) > 0;
  }

  async release(_runId: string): Promise<void> {}
}

class MemoryWorkspaceIsolator implements WorkspaceIsolator {
  readonly workspaces = new Map<string, IsolatedWorkspace>();
  readonly cleaned: string[] = [];

  async create(request: { readonly workspaceId: string }): Promise<IsolatedWorkspace> {
    const workspace = Object.freeze({
      workspaceId: request.workspaceId,
      cwd: `/isolated/${request.workspaceId}`,
      backend: "reflink-copy-v1" as const,
      snapshotDigest: "a".repeat(64),
    });
    this.workspaces.set(request.workspaceId, workspace);
    return workspace;
  }

  async reopen(request: { readonly workspaceId: string }): Promise<IsolatedWorkspace> {
    const workspace = this.workspaces.get(request.workspaceId);
    if (workspace === undefined) throw new Error(`workspace "${request.workspaceId}" is missing`);
    return workspace;
  }

  async cleanup(workspaceId: string): Promise<"discarded"> {
    this.cleaned.push(workspaceId);
    this.workspaces.delete(workspaceId);
    return "discarded";
  }
}

function clock(): () => Date {
  let seconds = 0;
  return () => {
    seconds += 1;
    return new Date(`2026-08-24T10:00:${String(seconds).padStart(2, "0")}.000Z`);
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
