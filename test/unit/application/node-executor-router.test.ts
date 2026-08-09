import { describe, expect, it } from "vitest";

import type {
  AgentExecutor,
  CommandExecutor,
  NodeExecutionContext,
} from "../../../src/application/ports.js";
import { NodeExecutorRouter } from "../../../src/application/node-executor-router.js";
import type {
  CompiledAgentNode,
  CompiledCommandNode,
  CompiledNode,
} from "../../../src/domain/workflow/types.js";

const context: NodeExecutionContext = {
  runId: "run-router",
  workflowId: "router-workflow",
  attempt: 1,
  cwd: process.cwd(),
  protectedPaths: [],
};

describe("NodeExecutorRouter", () => {
  it("dispatches command and agent nodes only to their typed executors", async () => {
    const calls: string[] = [];
    const command: CommandExecutor = {
      async execute(node) {
        calls.push(`command:${node.id}`);
        return { status: "succeeded", evidence: commandEvidence() };
      },
    };
    const agent: AgentExecutor = {
      async execute(node) {
        calls.push(`agent:${node.id}`);
        return {
          status: "succeeded",
          evidence: {
            kind: "agent",
            provider: node.agent.model.provider,
            model: node.agent.model.id,
            text: "done",
            textHash: "a".repeat(64),
            textTruncated: false,
            durationMs: 1,
            policyDecisions: [],
            effectReceipts: [],
          },
        };
      },
    };
    const router = new NodeExecutorRouter(command, agent);

    await router.execute(commandNode(), context);
    await router.execute(agentNode(), context);

    expect(calls).toEqual(["command:verify", "agent:analyze"]);
  });

  it.each(controlNodes())("rejects $type control nodes before executor dispatch", async (node) => {
    const command: CommandExecutor = {
      async execute() {
        throw new Error("command executor must not receive a control node");
      },
    };
    const agent: AgentExecutor = {
      async execute() {
        throw new Error("agent executor must not receive a control node");
      },
    };
    const router = new NodeExecutorRouter(command, agent);

    expect(() => router.execute(node, context)).toThrow(
      /control node.*must be resolved by the workflow scheduler/i,
    );
  });
});

function controlNodes(): CompiledNode[] {
  return [
    {
      id: "route",
      type: "condition",
      dependsOn: ["verify"],
      condition: {
        source: { nodeId: "verify", field: "command.stdout" },
        cases: [{ id: "pass", equals: "pass" }],
        default: "retry",
      },
    },
    {
      id: "converge",
      type: "join",
      dependsOn: ["verify"],
      join: { conditionId: "route", branches: [{ case: "pass", nodeId: "verify" }] },
    },
    {
      id: "repair--i1--check",
      type: "loop-check",
      dependsOn: ["verify"],
      loopCheck: {
        loopId: "repair",
        iteration: 1,
        source: { nodeId: "verify", field: "command.stdout" },
        equals: "pass",
      },
    },
    {
      id: "repair",
      type: "loop",
      dependsOn: ["repair--i1--check"],
      loop: { maxIterations: 1, checkNodeIds: ["repair--i1--check"] },
    },
  ];
}

function commandNode(): CompiledCommandNode {
  return {
    id: "verify",
    type: "command",
    dependsOn: ["analyze"],
    command: { executable: "node", args: ["--version"], timeoutMs: 1_000 },
  };
}

function agentNode(): CompiledAgentNode {
  return {
    id: "analyze",
    type: "agent",
    dependsOn: [],
    agent: {
      prompt: "Analyze.",
      model: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
      tools: [],
      skills: [],
      timeoutMs: 300_000,
    },
  };
}

function commandEvidence() {
  return {
    kind: "command" as const,
    executable: "node",
    args: ["--version"],
    exitCode: 0,
    signal: null,
    stdout: "v22.19.0",
    stderr: "",
    stdoutHash: "a".repeat(64),
    stderrHash: "b".repeat(64),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}
