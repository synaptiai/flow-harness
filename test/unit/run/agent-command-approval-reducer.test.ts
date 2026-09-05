import { describe, expect, it } from "vitest";

import { normalizeAgentCommandRequest } from "../../../src/domain/agent-command.js";
import {
  calculateAgentCommandApprovalRequestDigest,
  createAgentCommandApprovalRequest,
} from "../../../src/domain/approval/command-approval.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import { DEFAULT_POLICY_DECISION_LIMIT } from "../../../src/domain/policy/limits.js";
import {
  MAX_AGENT_COMMANDS_PER_ATTEMPT,
  parseRunEvent,
  type RunEvent,
  reduceRunEvents,
} from "../../../src/domain/run/events.js";

describe("durable agent command approval replay", () => {
  it("replays an exact grant and consumes it with one matching command preparation", () => {
    const state = reduceRunEvents(approvedPreparationEvents());

    expect(state.status).toBe("running");
    expect(state.agentCommandApprovalRequirements).toEqual({
      implement: { grantTtlMs: 300_000 },
    });
    expect(state.nodes.implement).toMatchObject({
      status: "running",
      agentCommandApprovals: [
        {
          status: "consumed",
          requestId: "agent-approval-3",
          request: approvalRequest,
          requestDigest: approvalRequestDigest,
          operationDigest: approvalRequest.operationDigest,
          actor: "operator:alice",
          consumedAt: "2026-08-08T10:00:05.000Z",
          consumedByCommandId: "command-5",
        },
      ],
      commands: [{ commandId: "command-5", approval: approvalReference }],
    });
    expect(Object.isFrozen(state.nodes.implement?.agentCommandApprovals)).toBe(true);
  });

  it("keeps the running node blocked on one exact pending request", () => {
    const state = reduceRunEvents(requestedEvents());

    expect(state.status).toBe("waiting_for_approval");
    expect(state.nodes.implement).toMatchObject({
      status: "running",
      commands: [],
      agentCommandApprovals: [
        {
          status: "pending",
          requestId: "agent-approval-3",
          request: approvalRequest,
          requestedAt: "2026-08-08T10:00:03.000Z",
        },
      ],
    });
  });

  it("records denial as a tool-level decision and returns the run to active execution", () => {
    const state = reduceRunEvents([...requestedEvents(), deniedEvent(4)]);

    expect(state.status).toBe("running");
    expect(state.nodes.implement).toMatchObject({
      status: "running",
      commands: [],
      agentCommandApprovals: [
        {
          status: "denied",
          actor: "operator:alice",
          reason: "command is not authorized",
          decidedAt: "2026-08-08T10:00:04.000Z",
        },
      ],
    });
  });

  it("closes an aborted wait before the running node can settle", () => {
    const events = [
      ...requestedEvents(),
      parseRunEvent({
        ...base(4),
        type: "agent_command_approval_cancelled",
        nodeId: "implement",
        attempt: 1,
        requestId: "agent-approval-3",
        requestDigest: approvalRequestDigest,
        operationDigest: approvalRequest.operationDigest,
        reason: "agent_aborted",
      }),
    ] as const;
    const state = reduceRunEvents(events);

    expect(state.status).toBe("running");
    expect(state.nodes.implement?.agentCommandApprovals[0]).toMatchObject({
      status: "cancelled",
      cancelledAt: "2026-08-08T10:00:04.000Z",
      cancellationReason: "agent_aborted",
    });
    expect(() => reduceRunEvents([...events, grantedEvent(5)])).toThrow(
      /pending|waiting|cancelled/i,
    );
  });

  it("expires an unconsumed grant and forbids its later use", () => {
    const granted = grantedEvents();
    const expired = parseRunEvent({
      ...base(5, "2026-08-08T10:05:04.000Z"),
      type: "agent_command_approval_expired",
      nodeId: "implement",
      attempt: 1,
      requestId: "agent-approval-3",
      requestDigest: approvalRequestDigest,
      operationDigest: approvalRequest.operationDigest,
    });
    const state = reduceRunEvents([...granted, expired]);

    expect(state.nodes.implement?.agentCommandApprovals[0]).toMatchObject({
      status: "expired",
      expiredAt: "2026-08-08T10:05:04.000Z",
    });
    expect(() => reduceRunEvents([...granted, expired, preparedEvent(6)])).toThrow(
      /approval.*granted|expired|matching/i,
    );
  });

  it("rejects command preparation before the required approval is granted", () => {
    const started = startedEvents();

    expect(() => reduceRunEvents([...started, preparedEvent(3)])).toThrow(
      /requires.*approval|matching.*grant/i,
    );
  });

  it("rejects a grant for a changed request digest", () => {
    expect(() =>
      reduceRunEvents([
        ...requestedEvents(),
        parseRunEvent({ ...grantedEvent(4), requestDigest: "f".repeat(64) }),
      ]),
    ).toThrow(/approval.*request|identity|digest/i);
  });

  it("rejects reusing one consumed grant for a later command", () => {
    const events = approvedPreparationEvents();
    const settled = parseRunEvent({
      ...base(6),
      type: "node_agent_command_settled",
      nodeId: "implement",
      attempt: 1,
      commandId: "command-5",
      outcome: {
        status: "failed",
        error: {
          code: "command_sandbox_unavailable",
          message: "sandbox unavailable",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: null,
      },
    });

    expect(() =>
      reduceRunEvents([
        ...events,
        settled,
        parseRunEvent({
          ...preparedEvent(7),
          commandId: "command-7",
          commandSequence: 2,
        }),
      ]),
    ).toThrow(/consumed|distinct|matching.*grant/i);
  });

  it("rejects a terminal node outcome while an approval grant remains unconsumed", () => {
    expect(() =>
      reduceRunEvents([
        ...grantedEvents(),
        parseRunEvent({
          ...base(5),
          type: "node_failed",
          nodeId: "implement",
          attempt: 1,
          error: {
            code: "pi_agent_failed",
            message: "agent stopped",
            retryable: false,
            sideEffectStatus: "none",
          },
          evidence: null,
        }),
      ]),
    ).toThrow(/approval.*unconsumed|grant/i);
  });

  it("rejects approval history beyond the runtime command-attempt limit", () => {
    const events: RunEvent[] = [...startedEvents()];
    for (let index = 0; index < DEFAULT_POLICY_DECISION_LIMIT; index += 1) {
      const requestSequence = events.length + 1;
      const requestId = `agent-approval-${requestSequence}`;
      events.push(requestedEvent(requestSequence, requestId));
      events.push(deniedEvent(events.length + 1, requestId));
    }

    expect(reduceRunEvents(events).nodes.implement?.agentCommandApprovals).toHaveLength(
      DEFAULT_POLICY_DECISION_LIMIT,
    );
    const requestSequence = events.length + 1;
    expect(() =>
      reduceRunEvents([
        ...events,
        requestedEvent(requestSequence, `agent-approval-${requestSequence}`),
      ]),
    ).toThrow(/agent command limit/i);
  });

  it("replays approval history up to the agent's explicit policy budget", () => {
    const events: RunEvent[] = [...startedEvents(MAX_AGENT_COMMANDS_PER_ATTEMPT)];
    for (let index = 0; index < MAX_AGENT_COMMANDS_PER_ATTEMPT; index += 1) {
      const requestSequence = events.length + 1;
      const requestId = `agent-approval-${requestSequence}`;
      events.push(requestedEvent(requestSequence, requestId));
      events.push(deniedEvent(events.length + 1, requestId));
    }

    expect(reduceRunEvents(events).nodes.implement?.agentCommandApprovals).toHaveLength(
      MAX_AGENT_COMMANDS_PER_ATTEMPT,
    );
  });
});

const command = normalizeAgentCommandRequest({
  executable: "npm",
  args: ["test"],
  timeoutMs: 10_000,
});
const approvalRequest = createAgentCommandApprovalRequest({
  runId: "run-1",
  workflowId: "agent-exec",
  nodeId: "implement",
  attempt: 1,
  cwd: "/workspace/project",
  command,
  grantTtlMs: 300_000,
});
const approvalRequestDigest = calculateAgentCommandApprovalRequestDigest(approvalRequest);
const approvalReference = {
  requestId: "agent-approval-3",
  requestDigest: approvalRequestDigest,
  operationDigest: approvalRequest.operationDigest,
};

function startedEvents(policyDecisionLimit?: number): readonly [RunEvent, RunEvent] {
  return [
    parseRunEvent({
      ...base(1),
      type: "run_started",
      nodeIds: policyDecisionLimit === undefined ? ["implement"] : ["implement", "verify"],
      workflowApiVersion: "flow.synapti.ai/v1alpha1",
      workflowDigest: "a".repeat(64),
      executionCwd: "/workspace/project",
      agentCommandApprovalRequirements: [{ nodeId: "implement", grantTtlMs: 300_000 }],
      ...(policyDecisionLimit === undefined
        ? {}
        : {
            controlGraph: {
              nodes: [
                {
                  nodeId: "implement",
                  dependsOn: [],
                  type: "agent",
                  policyDecisionLimit,
                },
                { nodeId: "verify", dependsOn: ["implement"], type: "command" },
              ],
            },
          }),
    }),
    parseRunEvent({
      ...base(2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      commandProtocol: "flow.agent-commands/v1",
    }),
  ];
}

function requestedEvents(): readonly [RunEvent, RunEvent, RunEvent] {
  return [...startedEvents(), requestedEvent(3, "agent-approval-3")];
}

function grantedEvents(): readonly [RunEvent, RunEvent, RunEvent, RunEvent] {
  return [...requestedEvents(), grantedEvent(4)];
}

function approvedPreparationEvents(): readonly [RunEvent, RunEvent, RunEvent, RunEvent, RunEvent] {
  return [...grantedEvents(), preparedEvent(5)];
}

function grantedEvent(sequence: number): RunEvent {
  return parseRunEvent({
    ...base(sequence),
    type: "agent_command_approval_granted",
    nodeId: "implement",
    attempt: 1,
    requestId: "agent-approval-3",
    requestDigest: approvalRequestDigest,
    operationDigest: approvalRequest.operationDigest,
    actor: "operator:alice",
    expiresAt: "2026-08-08T10:05:04.000Z",
  });
}

function requestedEvent(sequence: number, requestId: string): RunEvent {
  return parseRunEvent({
    ...base(sequence),
    type: "agent_command_approval_requested",
    nodeId: "implement",
    attempt: 1,
    requestId,
    request: approvalRequest,
    requestDigest: approvalRequestDigest,
  });
}

function deniedEvent(sequence: number, requestId = "agent-approval-3"): RunEvent {
  return parseRunEvent({
    ...base(sequence),
    type: "agent_command_approval_denied",
    nodeId: "implement",
    attempt: 1,
    requestId,
    requestDigest: approvalRequestDigest,
    operationDigest: approvalRequest.operationDigest,
    actor: "operator:alice",
    reason: "command is not authorized",
  });
}

function preparedEvent(sequence: number): RunEvent {
  const decision = new PolicyBroker(
    { runId: "run-1", workflowId: "agent-exec", nodeId: "implement", attempt: 1 },
    ["process.execute"],
  ).authorize({
    action: "process.execute",
    target: command.executable,
    boundary: "inside",
    operationDigest: approvalRequest.operationDigest,
  });
  return parseRunEvent({
    ...base(sequence),
    type: "node_agent_command_prepared",
    nodeId: "implement",
    attempt: 1,
    commandId: `command-${sequence}`,
    commandSequence: 1,
    request: command,
    operationDigest: approvalRequest.operationDigest,
    decision,
    approval: approvalReference,
  });
}

function base(
  sequence: number,
  at = new Date(Date.parse("2026-08-08T10:00:00.000Z") + sequence * 1_000).toISOString(),
) {
  return {
    version: 1 as const,
    sequence,
    at,
    runId: "run-1",
    workflowId: "agent-exec",
  };
}
