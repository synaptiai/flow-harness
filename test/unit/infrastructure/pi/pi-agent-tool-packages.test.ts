import { describe, expect, it } from "vitest";

import type {
  AgentCommandExecutor,
  NodeAgentCommandJournal,
  NodeExecutionContext,
} from "../../../../src/application/ports.js";
import { createCapabilitySnapshot } from "../../../../src/domain/capability/agent-skills.js";
import type { ToolPackageSnapshotInput } from "../../../../src/domain/capability/tool-packages.js";
import { compileWorkflowText } from "../../../../src/domain/workflow/compiler.js";
import type { CompiledAgentNode } from "../../../../src/domain/workflow/types.js";
import {
  PiAgentExecutor,
  type PiAgentRunner,
  type PiAgentRunRequest,
} from "../../../../src/infrastructure/pi/pi-agent-executor.js";

describe("Pi agent tool package admission", () => {
  it("passes exact selected snapshots and process authority to the runner", async () => {
    const snapshot = createCapabilitySnapshot([], [], [toolPackage()]);
    let observed: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      run: async (request) => {
        observed = request;
        const decision = request.policyBroker.authorize({
          action: "process.execute",
          target: "/usr/bin/printf",
          boundary: "inside",
          operationDigest: "a".repeat(64),
        });
        expect(decision).toMatchObject({ outcome: "allowed", authority: "execute" });
        return { text: "done", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(
      agentNode([{ name: "project-report", version: "1.2.3" }]),
      executionContext({ capabilitySnapshot: snapshot, withCommands: true }),
    );

    expect(outcome.status).toBe("succeeded");
    expect(observed?.tools).toEqual([]);
    expect(observed?.toolPackages).toEqual([snapshot.packages[0]]);
    expect(Object.isFrozen(observed?.toolPackages)).toBe(true);
  });

  it("does not expose package tools on an unselected node", async () => {
    const snapshot = createCapabilitySnapshot([], [], [toolPackage()]);
    let observed: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      run: async (request) => {
        observed = request;
        return { text: "done", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(
      agentNode([]),
      executionContext({ capabilitySnapshot: snapshot }),
    );

    expect(outcome.status).toBe("succeeded");
    expect(observed?.toolPackages).toEqual([]);
  });

  it.each([
    {
      label: "missing snapshot",
      context: executionContext({ withCommands: true }),
      code: "pi_tool_package_snapshot_unavailable",
    },
    {
      label: "missing command journal",
      context: executionContext({
        capabilitySnapshot: createCapabilitySnapshot([], [], [toolPackage()]),
      }),
      code: "pi_command_journal_unavailable",
    },
  ])("fails before contacting the runner for a $label", async ({ context, code }) => {
    let calls = 0;
    const runner: PiAgentRunner = {
      run: async () => {
        calls += 1;
        return { text: "unexpected", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(
      agentNode([{ name: "project-report", version: "1.2.3" }]),
      context,
    );

    expect(outcome).toMatchObject({ status: "failed", error: { code } });
    expect(calls).toBe(0);
  });

  it("rejects a selected version absent from the immutable snapshot", async () => {
    const snapshot = createCapabilitySnapshot([], [], [toolPackage("1.2.4")]);
    let calls = 0;
    const outcome = await new PiAgentExecutor({
      run: async () => {
        calls += 1;
        return { text: "unexpected", stopReason: "stop" };
      },
    }).execute(
      agentNode([{ name: "project-report", version: "1.2.3" }]),
      executionContext({ capabilitySnapshot: snapshot, withCommands: true }),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_tool_package_snapshot_invalid" },
    });
    expect(calls).toBe(0);
  });
});

function agentNode(
  references: readonly { readonly name: string; readonly version: string }[],
): CompiledAgentNode {
  const workflow = compileWorkflowText(`apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: agent-tool-packages }
nodes:
  - id: agent
    type: agent
    agent:
      prompt: Use only selected tools.
      model: { provider: test, id: deterministic }
      ${references.length === 0 ? "" : `toolPackages: [${references.map((item) => `{ name: ${item.name}, version: ${item.version} }`).join(", ")}]`}
  - id: verify
    type: command
    dependsOn: [agent]
    command: { executable: node }
`);
  const node = workflow.nodes[0];
  if (node?.type !== "agent") {
    throw new Error("agent fixture did not compile");
  }
  return node;
}

function toolPackage(version = "1.2.3"): ToolPackageSnapshotInput {
  const definition: ToolPackageSnapshotInput["definition"] = {
    tool: {
      name: "project_report",
      description: "Produce a report.",
      inputs: [{ name: "path", description: "Path.", type: "string" }],
    },
    driver: {
      kind: "command",
      version: "v1",
      profile: "posix-printf-v1",
      executable: "/usr/bin/printf",
      args: ["%s", "{input:path}"],
      timeoutMs: 10_000,
    },
    permissions: ["process.execute"],
  };
  return {
    kind: "tool-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name: "project-report",
    version,
    description: "Reusable project report tool.",
    trust: "project-explicit",
    provenance: ".flow/tools/project-report",
    definition,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata: { name: project-report, version: ${version}, description: Reusable project report tool. }
spec:
  tool:
    name: project_report
    description: Produce a report.
    inputs: [{ name: path, description: Path., type: string }]
  driver:
    kind: command
    version: v1
    profile: posix-printf-v1
    executable: /usr/bin/printf
    args: ["%s", "{input:path}"]
    timeoutMs: 10000
  permissions: [process.execute]
`),
    },
  };
}

function executionContext(options: {
  readonly capabilitySnapshot?: NodeExecutionContext["capabilitySnapshot"];
  readonly withCommands?: boolean;
}): NodeExecutionContext {
  const journal: NodeAgentCommandJournal = {
    prepare: async () => {
      throw new Error("runner fixture must not execute commands");
    },
  };
  const executor: AgentCommandExecutor = {
    executeAgentCommand: async () => {
      throw new Error("runner fixture must not execute commands");
    },
  };
  return {
    runId: "run-1",
    workflowId: "agent-tool-packages",
    attempt: 1,
    cwd: process.cwd(),
    protectedPaths: [],
    ...(options.capabilitySnapshot === undefined
      ? {}
      : { capabilitySnapshot: options.capabilitySnapshot }),
    ...(options.withCommands === true
      ? { agentCommandJournal: journal, agentCommandExecutor: executor }
      : {}),
  };
}
