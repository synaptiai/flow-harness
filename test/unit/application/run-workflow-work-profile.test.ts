import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { NodeExecutorRouter } from "../../../src/application/node-executor-router.js";
import type {
  AgentExecutor,
  CommandExecutor,
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RunEventStore,
} from "../../../src/application/ports.js";
import { runWorkflow } from "../../../src/application/run-workflow.js";
import type { AgentEvidence, CommandEvidence, RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("runWorkflow work profiles", () => {
  it("gives concurrent model attempts one post-admission remaining-budget snapshot", async () => {
    const contexts = new Map<string, NodeExecutionContext>();
    const executor: NodeExecutor = {
      async execute(node, context) {
        contexts.set(node.id, context);
        return node.type === "agent" ? agentSuccess(node.id) : commandSuccess("ok");
      },
    };

    const state = await runWorkflow(concurrentWorkflow(), {
      runId: "work-profile-concurrent",
      cwd: "/workspace",
      protectedPaths: [],
      store: new MemoryRunStore(),
      executor,
      workProfile: "long",
      now: fixedClock(),
    });

    const expected = {
      profile: "long",
      remaining: {
        nodeStarts: 3,
        modelTokens: 100,
        modelCostUsdMicros: 1_000,
        executionMs: 49,
        artifactBytes: 198,
      },
    };
    expect(contexts.get("left")?.modelWorkProfile).toEqual(expected);
    expect(contexts.get("right")?.modelWorkProfile).toEqual(expected);
    expect(contexts.get("side")?.modelWorkProfile).toBeUndefined();
    expect(contexts.get("join")?.modelWorkProfile).toBeUndefined();
    expect(state.status).toBe("succeeded");
  });

  it("passes the current profile and budget through the model-verifier adapter", async () => {
    let observed: NodeExecutionContext["modelWorkProfile"];
    const command: CommandExecutor = {
      async execute() {
        return commandSuccess("evidence");
      },
    };
    const agent: AgentExecutor = {
      async execute(_node, context) {
        observed = context.modelWorkProfile;
        return agentSuccess(
          "verifier",
          JSON.stringify({ verdict: "accepted", reason: "Evidence accepted." }),
        );
      },
    };

    const state = await runWorkflow(modelVerifierWorkflow(), {
      runId: "work-profile-verifier",
      cwd: "/workspace",
      protectedPaths: [],
      store: new MemoryRunStore(),
      executor: new NodeExecutorRouter(command, agent),
      workProfile: "fast",
      now: fixedClock(),
    });

    expect(observed).toEqual({
      profile: "fast",
      remaining: {
        nodeStarts: 2,
        modelTokens: 10,
        modelCostUsdMicros: 100,
        executionMs: 19,
        artifactBytes: 92,
      },
    });
    expect(state.status).toBe("succeeded");
  });

  it("does not change scheduling, model, tools, accounting, or outcomes between profiles", async () => {
    const observations = [];
    for (const profile of ["fast", "standard", "long"] as const) {
      const called: Array<{ readonly model: unknown; readonly tools: readonly string[] }> = [];
      const state = await runWorkflow(singleAgentWorkflow(), {
        runId: `work-profile-${profile}`,
        cwd: "/workspace",
        protectedPaths: [],
        store: new MemoryRunStore(),
        executor: {
          async execute(node) {
            if (node.type === "agent") {
              called.push({ model: node.agent.model, tools: node.agent.tools });
              return agentSuccess(node.id);
            }
            return commandSuccess("ok");
          },
        },
        workProfile: profile,
        now: fixedClock(),
      });
      observations.push({
        called,
        status: state.status,
        resources: state.resources,
        budget: state.budget,
        approvalRequirements: state.agentCommandApprovalRequirements,
        node: state.nodes.analyze,
      });
    }

    expect(observations[1]).toEqual(observations[0]);
    expect(observations[2]).toEqual(observations[0]);
  });
});

class MemoryRunStore implements RunEventStore {
  readonly events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(runId: string): Promise<readonly RunEvent[]> {
    return this.events
      .filter((event) => event.runId === runId)
      .map((event) => structuredClone(event));
  }
}

function concurrentWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: concurrent-work-profile }
concurrency: { maxNodes: 3 }
budget:
  maxNodeStarts: 7
  maxModelTokens: 100
  maxCostUsd: 0.001
  maxExecutionMs: 50
  maxArtifactBytes: 200
nodes:
  - id: root
    type: command
    command: { executable: node }
  - id: left
    type: agent
    dependsOn: [root]
    agent:
      prompt: Analyze left.
      model: { provider: test, id: deterministic }
  - id: right
    type: agent
    dependsOn: [root]
    agent:
      prompt: Analyze right.
      model: { provider: test, id: deterministic }
  - id: side
    type: command
    dependsOn: [root]
    command: { executable: node }
  - id: join
    type: command
    dependsOn: [left, right, side]
    command: { executable: node }
`);
}

function modelVerifierWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: verifier-work-profile }
budget:
  maxNodeStarts: 4
  maxModelTokens: 10
  maxCostUsd: 0.0001
  maxExecutionMs: 20
  maxArtifactBytes: 100
nodes:
  - id: source
    type: command
    command: { executable: node }
  - id: review
    type: verifier
    dependsOn: [source]
    verifier:
      kind: model
      prompt: Review the evidence.
      evidence: [{ nodeId: source, field: command.stdout }]
      model: { provider: test, id: deterministic }
`);
}

function singleAgentWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: informational-work-profile }
budget:
  maxNodeStarts: 2
  maxModelTokens: 20
  maxCostUsd: 0.0002
  maxExecutionMs: 30
  maxArtifactBytes: 100
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: test, id: deterministic }
      tools: [read, exec]
      toolApproval:
        exec: { mode: required, grantTtlMs: 300000 }
  - id: finish
    type: command
    dependsOn: [analyze]
    command: { executable: node }
`);
}

function agentSuccess(nodeId: string, text = `${nodeId} complete`): NodeExecutionOutcome {
  const evidence: AgentEvidence = {
    kind: "agent",
    provider: "test",
    model: "deterministic",
    text,
    textHash: sha256(text),
    textTruncated: false,
    durationMs: 1,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdMicros: 1,
    },
    policyDecisions: [],
    effectReceipts: [],
  };
  return { status: "succeeded", evidence };
}

function commandSuccess(stdout: string): NodeExecutionOutcome {
  const evidence: CommandEvidence = {
    kind: "command",
    executable: "node",
    args: [],
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
  };
  return { status: "succeeded", evidence };
}

function fixedClock(): () => Date {
  return () => new Date("2026-08-22T06:00:00.000Z");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
