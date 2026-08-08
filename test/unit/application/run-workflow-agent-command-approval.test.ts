import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  AgentCommandApprovalDecision,
  AgentCommandApprovalDecisionSource,
  AgentCommandApprovalWait,
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RunEventStore,
} from "../../../src/application/ports.js";
import { AgentCommandApprovalDecisionSourceError } from "../../../src/application/ports.js";
import { runWorkflow } from "../../../src/application/run-workflow.js";
import {
  calculateAgentCommandDigest,
  normalizeAgentCommandRequest,
} from "../../../src/domain/agent-command.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import type { AgentCommandEvidence, RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import type { CompiledNode } from "../../../src/domain/workflow/types.js";

describe("agent command approval application gate", () => {
  it("waits for an exact durable grant before command preparation", async () => {
    const store = new MemoryRunStore();
    const decisions = new ImmediateDecisionSource("approve");
    let executions = 0;

    const state = await runWorkflow(approvalWorkflow(), {
      runId: "run-agent-approval",
      cwd: "/workspace/project",
      protectedPaths: [],
      store,
      executor: new ApprovalUsingExecutor(() => {
        executions += 1;
      }),
      agentCommandApprovalDecisions: decisions,
      now: monotonicNow(),
    });

    expect(executions).toBe(1);
    expect(state.status).toBe("succeeded");
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "agent_command_approval_requested",
      "agent_command_approval_granted",
      "node_agent_command_prepared",
      "node_agent_command_settled",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(decisions.waits).toHaveLength(1);
    expect(decisions.waits[0]).toMatchObject({
      requestId: "agent-approval-3",
      request: {
        runId: "run-agent-approval",
        workflowId: "agent-command-approval",
        nodeId: "implement",
        attempt: 1,
        cwd: "/workspace/project",
        command: { executable: "npm", args: ["test"], timeoutMs: 10_000 },
        grantTtlMs: 300_000,
      },
    });
    expect(state.nodes.implement?.agentCommandApprovals[0]).toMatchObject({
      status: "consumed",
      actor: "operator:alice",
      consumedByCommandId: "command-5",
    });
  });

  it("returns denial to the agent as a tool-level failure without preparing or executing", async () => {
    const store = new MemoryRunStore();
    let executions = 0;

    const state = await runWorkflow(approvalWorkflow(), {
      runId: "run-agent-denial",
      cwd: "/workspace/project",
      protectedPaths: [],
      store,
      executor: new ApprovalUsingExecutor(() => {
        executions += 1;
      }),
      agentCommandApprovalDecisions: new ImmediateDecisionSource(
        "deny",
        "command is not authorized",
      ),
      now: monotonicNow(),
    });

    expect(executions).toBe(0);
    expect(state.status).toBe("succeeded");
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "agent_command_approval_requested",
      "agent_command_approval_denied",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(state.nodes.implement).toMatchObject({
      status: "succeeded",
      commands: [],
      agentCommandApprovals: [
        {
          status: "denied",
          actor: "operator:alice",
          reason: "command is not authorized",
        },
      ],
    });
  });

  it("closes the pending request when the decision channel returns forged identity", async () => {
    const store = new MemoryRunStore();
    let executions = 0;
    const decisions: AgentCommandApprovalDecisionSource = {
      waitForDecision: async (wait) => ({
        version: 1,
        runId: wait.request.runId,
        requestId: wait.requestId,
        requestDigest: "f".repeat(64),
        operationDigest: wait.request.operationDigest,
        decision: "approve",
        actor: "operator:alice",
        submittedAt: "2026-08-08T10:00:03.500Z",
      }),
    };

    const state = await runWorkflow(approvalWorkflow(), {
      runId: "run-agent-forged-decision",
      cwd: "/workspace/project",
      protectedPaths: [],
      store,
      executor: new ApprovalUsingExecutor(() => {
        executions += 1;
      }),
      agentCommandApprovalDecisions: decisions,
      now: monotonicNow(),
    });

    expect(executions).toBe(0);
    expect(state.status).toBe("failed");
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "agent_command_approval_requested",
      "agent_command_approval_cancelled",
      "node_failed",
      "run_failed",
    ]);
    expect(state.nodes.implement?.agentCommandApprovals[0]).toMatchObject({
      status: "cancelled",
      cancellationReason: "decision_invalid",
    });
    expect(state.nodes.implement?.commands).toEqual([]);
  });

  it("audits a typed invalid decision-source failure as decision_invalid", async () => {
    const store = new MemoryRunStore();
    let executions = 0;
    const decisions: AgentCommandApprovalDecisionSource = {
      async waitForDecision() {
        throw new AgentCommandApprovalDecisionSourceError(
          "decision_invalid",
          "approval receipt does not match the pending request",
        );
      },
    };

    const state = await runWorkflow(approvalWorkflow(), {
      runId: "run-agent-invalid-receipt",
      cwd: "/workspace/project",
      protectedPaths: [],
      store,
      executor: new ApprovalUsingExecutor(() => {
        executions += 1;
      }),
      agentCommandApprovalDecisions: decisions,
      now: monotonicNow(),
    });

    expect(executions).toBe(0);
    expect(state.status).toBe("failed");
    expect(state.nodes.implement?.agentCommandApprovals[0]).toMatchObject({
      status: "cancelled",
      cancellationReason: "decision_invalid",
    });
  });

  it("retries a temporarily unavailable decision source without closing the request", async () => {
    const store = new MemoryRunStore();
    let executions = 0;
    let waitCalls = 0;
    const approved = new ImmediateDecisionSource("approve");
    const decisions: AgentCommandApprovalDecisionSource = {
      async waitForDecision(wait, _signal): Promise<AgentCommandApprovalDecision> {
        waitCalls += 1;
        if (waitCalls === 1) {
          throw new AgentCommandApprovalDecisionSourceError(
            "temporarily_unavailable",
            "temporary filesystem read failure",
            1,
          );
        }
        return await approved.waitForDecision(wait);
      },
    };

    const state = await runWorkflow(approvalWorkflow(), {
      runId: "run-agent-transient-channel",
      cwd: "/workspace/project",
      protectedPaths: [],
      store,
      executor: new ApprovalUsingExecutor(() => {
        executions += 1;
      }),
      agentCommandApprovalDecisions: decisions,
      now: monotonicNow(),
    });

    expect(waitCalls).toBe(2);
    expect(executions).toBe(1);
    expect(state.status).toBe("succeeded");
    expect(store.events.map((event) => event.type)).not.toContain(
      "agent_command_approval_cancelled",
    );
  });

  it("keeps retrying an unavailable decision source until cancellation", async () => {
    const store = new MemoryRunStore();
    const controller = new AbortController();
    let signalFirstWait: () => void = () => undefined;
    const firstWait = new Promise<void>((resolve) => {
      signalFirstWait = resolve;
    });
    let waitCalls = 0;
    const decisions: AgentCommandApprovalDecisionSource = {
      async waitForDecision() {
        waitCalls += 1;
        signalFirstWait();
        throw new AgentCommandApprovalDecisionSourceError(
          "temporarily_unavailable",
          "temporary filesystem read failure",
          50,
        );
      },
    };
    const running = runWorkflow(approvalWorkflow(), {
      runId: "run-agent-channel-cancelled",
      cwd: "/workspace/project",
      protectedPaths: [],
      store,
      executor: new ApprovalUsingExecutor(() => undefined),
      agentCommandApprovalDecisions: decisions,
      signal: controller.signal,
      now: monotonicNow(),
    });

    await firstWait;
    controller.abort(new Error("agent approval wait timed out"));
    const state = await running;

    expect(waitCalls).toBeGreaterThanOrEqual(1);
    expect(state.status).toBe("cancelled");
    expect(state.nodes.implement?.agentCommandApprovals[0]).toMatchObject({
      status: "cancelled",
      cancellationReason: "agent_aborted",
    });
  });

  it("durably expires a grant before command preparation without executing", async () => {
    const store = new MemoryRunStore();
    let executions = 0;

    const state = await runWorkflow(approvalWorkflow(1), {
      runId: "run-agent-expired-grant",
      cwd: "/workspace/project",
      protectedPaths: [],
      store,
      executor: new ApprovalUsingExecutor(() => {
        executions += 1;
      }),
      agentCommandApprovalDecisions: new ImmediateDecisionSource("approve"),
      now: monotonicNow(),
    });

    expect(executions).toBe(0);
    expect(state.status).toBe("succeeded");
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "agent_command_approval_requested",
      "agent_command_approval_granted",
      "agent_command_approval_expired",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(state.nodes.implement).toMatchObject({
      status: "succeeded",
      commands: [],
      agentCommandApprovals: [{ status: "expired" }],
    });
  });

  it("cancels a pending request when the active agent wait is aborted", async () => {
    const store = new MemoryRunStore();
    const decisions = new BlockingDecisionSource();
    const controller = new AbortController();
    let executions = 0;
    const running = runWorkflow(approvalWorkflow(), {
      runId: "run-agent-approval-timeout",
      cwd: "/workspace/project",
      protectedPaths: [],
      store,
      executor: new ApprovalUsingExecutor(() => {
        executions += 1;
      }),
      agentCommandApprovalDecisions: decisions,
      signal: controller.signal,
      now: monotonicNow(),
    });

    await decisions.waitStarted;
    controller.abort(new Error("agent approval wait timed out"));
    const state = await running;

    expect(executions).toBe(0);
    expect(state.status).toBe("cancelled");
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "agent_command_approval_requested",
      "agent_command_approval_cancelled",
      "node_failed",
      "run_cancelled",
    ]);
    expect(state.nodes.implement?.agentCommandApprovals[0]).toMatchObject({
      status: "cancelled",
      cancellationReason: "agent_aborted",
    });
    expect(state.nodes.implement?.commands).toEqual([]);
  });

  it("lets cancellation win when it races a returned approval decision", async () => {
    const store = new MemoryRunStore();
    const controller = new AbortController();
    let executions = 0;

    const state = await runWorkflow(approvalWorkflow(), {
      runId: "run-agent-decision-abort-race",
      cwd: "/workspace/project",
      protectedPaths: [],
      store,
      executor: new ApprovalUsingExecutor(() => {
        executions += 1;
      }),
      agentCommandApprovalDecisions: new AbortingDecisionSource(controller),
      signal: controller.signal,
      now: monotonicNow(),
    });

    expect(executions).toBe(0);
    expect(state.status).toBe("cancelled");
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "agent_command_approval_requested",
      "agent_command_approval_cancelled",
      "node_failed",
      "run_cancelled",
    ]);
    expect(state.nodes.implement?.agentCommandApprovals[0]).toMatchObject({
      status: "cancelled",
      cancellationReason: "agent_aborted",
    });
  });

  it("serializes exact approval waits across concurrent agent nodes", async () => {
    const store = new MemoryRunStore();
    const decisions = new ImmediateDecisionSource("approve");
    let executions = 0;

    const state = await runWorkflow(concurrentApprovalWorkflow(), {
      runId: "run-concurrent-agent-approvals",
      cwd: "/workspace/project",
      protectedPaths: [],
      store,
      executor: new ApprovalUsingExecutor(() => {
        executions += 1;
      }),
      agentCommandApprovalDecisions: decisions,
      now: monotonicNow(),
    });

    expect(executions).toBe(2);
    expect(state.status).toBe("succeeded");
    expect(decisions.waits.map((wait) => wait.request.nodeId)).toEqual([
      "implement-a",
      "implement-b",
    ]);
    expect(
      store.events
        .filter((event) => event.type.startsWith("agent_command_approval_"))
        .map((event) => event.type),
    ).toEqual([
      "agent_command_approval_requested",
      "agent_command_approval_granted",
      "agent_command_approval_requested",
      "agent_command_approval_granted",
    ]);
  });
});

class ImmediateDecisionSource implements AgentCommandApprovalDecisionSource {
  readonly waits: AgentCommandApprovalWait[] = [];

  constructor(
    readonly decision: "approve" | "deny",
    readonly reason?: string,
  ) {}

  async waitForDecision(wait: AgentCommandApprovalWait) {
    this.waits.push(structuredClone(wait));
    return {
      version: 1 as const,
      runId: wait.request.runId,
      requestId: wait.requestId,
      requestDigest: wait.requestDigest,
      operationDigest: wait.request.operationDigest,
      decision: this.decision,
      actor: "operator:alice",
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      submittedAt: "2026-08-08T10:00:03.500Z",
    };
  }
}

class BlockingDecisionSource implements AgentCommandApprovalDecisionSource {
  readonly waitStarted: Promise<void>;
  readonly #resolveWaitStarted: () => void;

  constructor() {
    let resolveWaitStarted: (() => void) | undefined;
    this.waitStarted = new Promise((resolve) => {
      resolveWaitStarted = resolve;
    });
    if (resolveWaitStarted === undefined) {
      throw new Error("blocking decision source did not initialize");
    }
    this.#resolveWaitStarted = resolveWaitStarted;
  }

  async waitForDecision(_wait: AgentCommandApprovalWait, signal?: AbortSignal): Promise<never> {
    this.#resolveWaitStarted();
    return await new Promise<never>((_resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

class AbortingDecisionSource implements AgentCommandApprovalDecisionSource {
  constructor(readonly controller: AbortController) {}

  async waitForDecision(wait: AgentCommandApprovalWait) {
    this.controller.abort(new Error("agent aborted as the decision arrived"));
    return {
      version: 1 as const,
      runId: wait.request.runId,
      requestId: wait.requestId,
      requestDigest: wait.requestDigest,
      operationDigest: wait.request.operationDigest,
      decision: "approve" as const,
      actor: "operator:alice",
      submittedAt: "2026-08-08T10:00:03.500Z",
    };
  }
}

class ApprovalUsingExecutor implements NodeExecutor {
  constructor(readonly onExecution: () => void) {}

  async execute(node: CompiledNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    if (node.type === "command") {
      const {
        processContainment: _processContainment,
        terminationStatus: _terminationStatus,
        aborted: _aborted,
        stdoutRetainedHash: _stdoutRetainedHash,
        stderrRetainedHash: _stderrRetainedHash,
        stdoutRetainedBytes: _stdoutRetainedBytes,
        stderrRetainedBytes: _stderrRetainedBytes,
        sandbox: _sandbox,
        ...evidence
      } = commandEvidence();
      return { status: "succeeded", evidence };
    }
    if (node.type !== "agent") {
      throw new Error(`unexpected node type ${node.type}`);
    }
    const journal = context.agentCommandJournal;
    const approvalGate = context.agentCommandApprovalGate;
    if (journal === undefined || approvalGate === undefined) {
      throw new Error("agent command approval dependencies were not injected");
    }
    const request = normalizeAgentCommandRequest({
      executable: "npm",
      args: ["test"],
      timeoutMs: 10_000,
    });
    const operationDigest = calculateAgentCommandDigest(request);
    const broker = new PolicyBroker(
      {
        runId: context.runId,
        workflowId: context.workflowId,
        nodeId: node.id,
        attempt: context.attempt,
      },
      ["process.execute"],
    );
    const decision = broker.authorize({
      action: "process.execute",
      target: request.executable,
      boundary: "inside",
      operationDigest,
    });
    try {
      const approval = await approvalGate.authorize(request, context.signal);
      const prepared = await journal.prepare({ request, operationDigest, decision, approval });
      this.onExecution();
      await prepared.settle({
        status: "succeeded",
        evidence: commandEvidence(),
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !["AgentCommandApprovalDeniedError", "AgentCommandApprovalExpiredError"].includes(
          error.name,
        )
      ) {
        throw error;
      }
    }
    return {
      status: "succeeded",
      evidence: {
        kind: "agent",
        provider: node.agent.model.provider,
        model: node.agent.model.id,
        text: "done",
        textHash: sha256("done"),
        textTruncated: false,
        durationMs: 5,
        policyDecisions: broker.close(),
        effectReceipts: [],
      },
    };
  }
}

class MemoryRunStore implements RunEventStore {
  readonly events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return this.events;
  }
}

function approvalWorkflow(grantTtlMs = 300_000) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: agent-command-approval }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Run tests.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [exec]
      toolApproval:
        exec: { mode: required, grantTtlMs: ${grantTtlMs} }
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: npm, args: [test], timeoutMs: 10000 }
`);
}

function concurrentApprovalWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: concurrent-agent-command-approval }
concurrency: { maxNodes: 2 }
nodes:
  - id: start
    type: command
    command: { executable: npm, args: [test], timeoutMs: 10000 }
  - id: implement-a
    type: agent
    dependsOn: [start]
    agent:
      prompt: Run tests for A.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [exec]
      toolApproval:
        exec: { mode: required }
  - id: implement-b
    type: agent
    dependsOn: [start]
    agent:
      prompt: Run tests for B.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [exec]
      toolApproval:
        exec: { mode: required }
  - id: verify
    type: command
    dependsOn: [implement-a, implement-b]
    command: { executable: npm, args: [test], timeoutMs: 10000 }
`);
}

function monotonicNow(): () => Date {
  let milliseconds = Date.parse("2026-08-08T10:00:00.000Z");
  return () => {
    milliseconds += 1_000;
    return new Date(milliseconds);
  };
}

function commandEvidence(): AgentCommandEvidence {
  return {
    kind: "command",
    executable: "npm",
    args: ["test"],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutHash: sha256(""),
    stderrHash: sha256(""),
    stdoutRetainedHash: sha256(""),
    stderrRetainedHash: sha256(""),
    stdoutRetainedBytes: 0,
    stderrRetainedBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    durationMs: 5,
    processContainment: "linux-pid-namespace",
    terminationStatus: "not-required",
    sandbox: {
      backend: "test-sandbox",
      backendVersion: "1",
      profile: "workspace-write-network-deny-v1",
      policyDigest: "b".repeat(64),
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
