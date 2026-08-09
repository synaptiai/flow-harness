import { describe, expect, it } from "vitest";

import { trySubmitAgentCommandApprovalDecision } from "../../../src/application/command-approval.js";
import type {
  AgentCommandApprovalDecision,
  AgentCommandApprovalDecisionSink,
  RunEventStore,
} from "../../../src/application/ports.js";
import { normalizeAgentCommandRequest } from "../../../src/domain/agent-command.js";
import {
  calculateAgentCommandApprovalRequestDigest,
  createAgentCommandApprovalRequest,
} from "../../../src/domain/approval/command-approval.js";
import { parseRunEvent, type RunEvent } from "../../../src/domain/run/events.js";

describe("agent command approval decision submission", () => {
  it("routes an exact live-tool decision to the sidecar without claiming or appending the ledger", async () => {
    const store = new ReadOnlyRunStore(pendingEvents());
    const sink = new CapturingDecisionSink();

    const result = await trySubmitAgentCommandApprovalDecision({
      runId: "run-1",
      requestId: "agent-approval-3",
      actor: "operator:alice",
      decision: "approve",
      store,
      sink,
      now: () => new Date("2026-08-08T10:00:04.000Z"),
    });

    expect(result).toEqual({
      kind: "agent_command_approval_decision_submitted",
      runId: "run-1",
      requestId: "agent-approval-3",
      decision: "approve",
      actor: "operator:alice",
    });
    expect(sink.decisions).toEqual([
      {
        version: 1,
        runId: "run-1",
        requestId: "agent-approval-3",
        requestDigest,
        operationDigest: request.operationDigest,
        decision: "approve",
        actor: "operator:alice",
        submittedAt: "2026-08-08T10:00:04.000Z",
      },
    ]);
    expect(store.appendCalls).toBe(0);
  });

  it("returns null when the pending approval belongs to a workflow or command node", async () => {
    const store = new ReadOnlyRunStore(pendingEvents().slice(0, 2));

    await expect(
      trySubmitAgentCommandApprovalDecision({
        runId: "run-1",
        requestId: "approval-2",
        actor: "operator:alice",
        decision: "approve",
        store,
        sink: new CapturingDecisionSink(),
      }),
    ).resolves.toBeNull();
  });

  it("rejects a stale request id before publishing a sidecar", async () => {
    const sink = new CapturingDecisionSink();

    await expect(
      trySubmitAgentCommandApprovalDecision({
        runId: "run-1",
        requestId: "agent-approval-99",
        actor: "operator:alice",
        decision: "deny",
        reason: "no",
        store: new ReadOnlyRunStore(pendingEvents()),
        sink,
      }),
    ).rejects.toMatchObject({ code: "request_mismatch" });
    expect(sink.decisions).toEqual([]);
  });
});

class CapturingDecisionSink implements AgentCommandApprovalDecisionSink {
  readonly decisions: AgentCommandApprovalDecision[] = [];

  async submitDecision(decision: AgentCommandApprovalDecision): Promise<void> {
    this.decisions.push(structuredClone(decision));
  }
}

class ReadOnlyRunStore implements RunEventStore {
  appendCalls = 0;

  constructor(readonly events: readonly RunEvent[]) {}

  async append(): Promise<void> {
    this.appendCalls += 1;
  }

  async read(): Promise<readonly RunEvent[]> {
    return this.events;
  }
}

const request = createAgentCommandApprovalRequest({
  runId: "run-1",
  workflowId: "agent-exec",
  nodeId: "implement",
  attempt: 1,
  cwd: "/workspace/project",
  command: normalizeAgentCommandRequest({ executable: "npm", args: ["test"] }),
  grantTtlMs: 300_000,
});
const requestDigest = calculateAgentCommandApprovalRequestDigest(request);

function pendingEvents(): readonly RunEvent[] {
  return [
    parseRunEvent({
      ...base(1),
      type: "run_started",
      nodeIds: ["implement"],
      workflowApiVersion: "flow.synapti.ai/v1alpha1",
      workflowDigest: "a".repeat(64),
      executionCwd: "/workspace/project",
      agentCommandApprovalRequirements: [{ nodeId: "implement", grantTtlMs: 300_000 }],
    }),
    parseRunEvent({
      ...base(2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      commandProtocol: "flow.agent-commands/v1",
    }),
    parseRunEvent({
      ...base(3),
      type: "agent_command_approval_requested",
      nodeId: "implement",
      attempt: 1,
      requestId: "agent-approval-3",
      request,
      requestDigest,
    }),
  ];
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-08T10:00:0${sequence}.000Z`,
    runId: "run-1",
    workflowId: "agent-exec",
  };
}
