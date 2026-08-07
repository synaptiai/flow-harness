import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decideCommandApproval } from "../../../src/application/command-approval.js";
import type {
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import type { RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("decideCommandApproval", () => {
  it("records an attributable exact grant without executing the command", async () => {
    const store = await waitingStore("run-approve");

    const state = await decideCommandApproval({
      runId: "run-approve",
      requestId: "approval-2",
      decision: "approve",
      actor: "  operator:daniel  ",
      store,
      now: () => new Date("2026-08-07T15:00:05.000Z"),
    });

    expect(state).toMatchObject({
      status: "running",
      nodes: {
        verify: {
          status: "pending",
          approval: {
            status: "granted",
            actor: "operator:daniel",
            decidedAt: "2026-08-07T15:00:05.000Z",
            expiresAt: "2026-08-07T15:01:05.000Z",
          },
        },
      },
    });
    expect(store.events.at(-1)).toMatchObject({
      type: "command_approval_granted",
      requestId: "approval-2",
      actor: "operator:daniel",
      expiresAt: "2026-08-07T15:01:05.000Z",
    });
    expect(store.claimCalls).toEqual(["run-approve"]);
    expect(store.releaseCalls.at(-1)).toBe("run-approve");
  });

  it("records denial and terminal failure without an execution start", async () => {
    const store = await waitingStore("run-deny");

    const state = await decideCommandApproval({
      runId: "run-deny",
      requestId: "approval-2",
      decision: "deny",
      actor: "operator:daniel",
      reason: " unsafe operation ",
      store,
      now: () => new Date("2026-08-07T15:00:05.000Z"),
    });

    expect(store.events.slice(-2).map((event) => event.type)).toEqual([
      "command_approval_denied",
      "run_failed",
    ]);
    expect(store.events.some((event) => event.type === "node_started")).toBe(false);
    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "verify",
      failureReason: "command approval denied by operator:daniel: unsafe operation",
      nodes: {
        verify: {
          status: "failed",
          error: { code: "command_approval_denied", sideEffectStatus: "none" },
          approval: { status: "denied", reason: "unsafe operation" },
        },
      },
    });
  });

  it("rejects a stale request without appending", async () => {
    const store = await waitingStore("run-stale-decision");
    const before = structuredClone(store.events);

    await expect(
      decideCommandApproval({
        runId: "run-stale-decision",
        requestId: "approval-99",
        decision: "approve",
        actor: "operator:daniel",
        store,
      }),
    ).rejects.toMatchObject({ code: "request_mismatch" });

    expect(store.events).toEqual(before);
    expect(store.releaseCalls.at(-1)).toBe("run-stale-decision");
  });

  it("rejects a duplicate decision without appending", async () => {
    const store = await waitingStore("run-duplicate-decision");
    await decideCommandApproval({
      runId: "run-duplicate-decision",
      requestId: "approval-2",
      decision: "approve",
      actor: "operator:first",
      store,
    });
    const before = structuredClone(store.events);

    await expect(
      decideCommandApproval({
        runId: "run-duplicate-decision",
        requestId: "approval-2",
        decision: "deny",
        actor: "operator:second",
        store,
      }),
    ).rejects.toMatchObject({ code: "not_waiting" });

    expect(store.events).toEqual(before);
  });

  it("releases ownership and preserves the pending request when a grant append fails", async () => {
    const store = await waitingStore("run-grant-write-failure");
    const before = structuredClone(store.events);
    store.failNextAppend("command_approval_granted");

    await expect(
      decideCommandApproval({
        runId: "run-grant-write-failure",
        requestId: "approval-2",
        decision: "approve",
        actor: "operator:daniel",
        store,
      }),
    ).rejects.toThrowError(/injected append failure/i);

    expect(store.events).toEqual(before);
    expect(store.releaseCalls.at(-1)).toBe("run-grant-write-failure");
    await expect(
      decideCommandApproval({
        runId: "run-grant-write-failure",
        requestId: "approval-2",
        decision: "approve",
        actor: "operator:daniel",
        store,
      }),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("repairs a denial interrupted before terminalization without executing", async () => {
    const store = await waitingStore("run-denial-write-failure");
    store.failNextAppend("run_failed");

    await expect(
      decideCommandApproval({
        runId: "run-denial-write-failure",
        requestId: "approval-2",
        decision: "deny",
        actor: "operator:daniel",
        store,
      }),
    ).rejects.toThrowError(/injected append failure/i);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
      "command_approval_denied",
    ]);
    expect(store.releaseCalls.at(-1)).toBe("run-denial-write-failure");

    const executorCalls: string[] = [];
    const state = await resumeWorkflow(approvalWorkflow(), {
      runId: "run-denial-write-failure",
      cwd: "/workspace",
      protectedPaths: [],
      store,
      executor: successfulExecutor(executorCalls),
    });

    expect(executorCalls).toEqual([]);
    expect(state).toMatchObject({ status: "failed", failedNodeId: "verify" });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
      "command_approval_denied",
      "run_resumed",
      "run_failed",
    ]);
  });

  it("preserves a committed grant when ownership release fails", async () => {
    const store = await waitingStore("run-release-failure");
    store.failNextRelease();

    await expect(
      decideCommandApproval({
        runId: "run-release-failure",
        requestId: "approval-2",
        decision: "approve",
        actor: "operator:daniel",
        store,
      }),
    ).rejects.toThrowError(/injected release failure/i);

    expect(store.events.at(-1)).toMatchObject({
      type: "command_approval_granted",
      requestId: "approval-2",
    });
  });

  it("preserves decision and release errors when both operations fail", async () => {
    const store = await waitingStore("run-combined-failure");
    store.failNextRelease();
    const before = structuredClone(store.events);

    const failure = await decideCommandApproval({
      runId: "run-combined-failure",
      requestId: "approval-99",
      decision: "approve",
      actor: "operator:daniel",
      store,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [
        expect.objectContaining({ code: "request_mismatch" }),
        expect.objectContaining({ message: "injected release failure" }),
      ],
    });
    expect(store.events).toEqual(before);
  });

  it.each([
    ["empty actor", "   ", undefined, "invalid_actor"],
    ["control-character actor", "operator\nadmin", undefined, "invalid_actor"],
    ["empty reason", "operator:daniel", "   ", "invalid_reason"],
    ["oversized reason", "operator:daniel", "x".repeat(4097), "invalid_reason"],
  ])("rejects %s before claiming the run", async (_case, actor, reason, code) => {
    const store = await waitingStore(`run-invalid-${code}`);
    const claimCount = store.claimCalls.length;

    await expect(
      decideCommandApproval({
        runId: `run-invalid-${code}`,
        requestId: "approval-2",
        decision: "deny",
        actor,
        ...(reason === undefined ? {} : { reason }),
        store,
      }),
    ).rejects.toMatchObject({ code });

    expect(store.claimCalls).toHaveLength(claimCount);
  });
});

class MemoryRecoverableRunStore implements RecoverableRunEventStore {
  readonly events: RunEvent[] = [];
  readonly claimCalls: string[] = [];
  readonly releaseCalls: string[] = [];
  #failingEventType: RunEvent["type"] | undefined;
  #releaseMustFail = false;

  async append(event: RunEvent): Promise<void> {
    if (event.type === this.#failingEventType) {
      this.#failingEventType = undefined;
      throw new Error(`injected append failure for ${event.type}`);
    }
    this.events.push(structuredClone(event));
  }

  failNextAppend(eventType: RunEvent["type"]): void {
    this.#failingEventType = eventType;
  }

  failNextRelease(): void {
    this.#releaseMustFail = true;
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async claim(runId: string): Promise<readonly RunEvent[]> {
    this.claimCalls.push(runId);
    return structuredClone(this.events);
  }

  async release(runId: string): Promise<void> {
    this.releaseCalls.push(runId);
    if (this.#releaseMustFail) {
      this.#releaseMustFail = false;
      throw new Error("injected release failure");
    }
  }
}

async function waitingStore(runId: string): Promise<MemoryRecoverableRunStore> {
  const store = new MemoryRecoverableRunStore();
  await runWorkflow(approvalWorkflow(), {
    runId,
    cwd: "/workspace",
    protectedPaths: [],
    store,
    executor: successfulExecutor(),
    now: () => new Date("2026-08-07T15:00:01.000Z"),
  });
  return store;
}

function approvalWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: approval-decision }
nodes:
  - id: verify
    type: command
    approval: { mode: required, grantTtlMs: 60000 }
    command: { executable: node, args: [--version] }
`);
}

function successfulExecutor(calls?: string[]): NodeExecutor {
  return {
    async execute(node): Promise<NodeExecutionOutcome> {
      calls?.push(node.id);
      const stdout = "v22.19.0\n";
      return {
        status: "succeeded",
        evidence: {
          kind: "command",
          executable: "node",
          args: ["--version"],
          exitCode: 0,
          signal: null,
          stdout,
          stderr: "",
          stdoutHash: createHash("sha256").update(stdout).digest("hex"),
          stderrHash: createHash("sha256").update("").digest("hex"),
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          durationMs: 1,
        },
      };
    },
  };
}
