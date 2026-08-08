import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { NodeExecutorRouter } from "../../../src/application/node-executor-router.js";
import type {
  AgentExecutor,
  CommandExecutor,
  NodeExecutionOutcome,
  RunEventStore,
} from "../../../src/application/ports.js";
import { runWorkflow } from "../../../src/application/run-workflow.js";
import {
  type AgentCommandRequest,
  calculateAgentCommandDigest,
  normalizeAgentCommandRequest,
} from "../../../src/domain/agent-command.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import { renderToolPackageCommand } from "../../../src/domain/capability/tool-package-renderer.js";
import type {
  ToolPackageSnapshot,
  ToolPackageSnapshotInput,
} from "../../../src/domain/capability/tool-packages.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import type { PolicyDecision } from "../../../src/domain/policy/types.js";
import {
  type AgentCommandSettlementOutcome,
  type CommandEvidence,
  type RunEvent,
  reduceRunEvents,
} from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("tool package run history", () => {
  it("persists exact selection before any call and replays a sourced package command", async () => {
    const events = await packageEvents();
    const started = requireStarted(events);
    const controlAgent = started.controlGraph?.nodes.find((node) => node.nodeId === "agent");

    expect(started.toolPackageRequirements).toEqual([
      {
        nodeId: "agent",
        rawExec: false,
        packages: [{ name: "project-report", version: "1.2.3" }],
      },
    ]);
    expect(controlAgent).toMatchObject({
      type: "agent",
      commandTools: {
        rawExec: false,
        packages: [{ name: "project-report", version: "1.2.3" }],
      },
    });
    const state = reduceRunEvents(events);
    expect(state.toolPackageRequirements).toEqual({
      agent: {
        rawExec: false,
        packages: [{ name: "project-report", version: "1.2.3" }],
      },
    });
    expect(state.status).toBe("succeeded");
  });

  it.each([
    {
      label: "missing requirement",
      mutate(events: RunEvent[]) {
        const started = requireStarted(events);
        const { toolPackageRequirements: _requirements, ...without } = started;
        events[0] = without;
      },
    },
    {
      label: "requirement version drift",
      mutate(events: RunEvent[]) {
        const started = requireStarted(events);
        events[0] = {
          ...started,
          toolPackageRequirements: [
            {
              nodeId: "agent",
              rawExec: false,
              packages: [{ name: "project-report", version: "1.2.4" }],
            },
          ],
        };
      },
    },
    {
      label: "missing control-graph package declaration",
      mutate(events: RunEvent[]) {
        const started = requireStarted(events);
        if (started.controlGraph === undefined) {
          throw new Error("control graph fixture is missing");
        }
        events[0] = {
          ...started,
          controlGraph: {
            nodes: started.controlGraph.nodes.map((node) => {
              if (node.type !== "agent" || node.nodeId !== "agent") {
                return node;
              }
              const { commandTools: _commandTools, ...without } = node;
              return without;
            }),
          },
        };
      },
    },
  ])("rejects $label at run start", async ({ mutate }) => {
    const events = await packageEvents();
    mutate(events);

    expect(() => reduceRunEvents(events)).toThrow(/tool package|control graph|snapshot/i);
  });

  it.each([
    {
      label: "source removed from a package-only node",
      mutate(request: AgentCommandRequest) {
        return normalizeAgentCommandRequest({
          executable: request.executable,
          args: request.args,
          timeoutMs: request.timeoutMs,
        });
      },
    },
    {
      label: "forged package digest",
      mutate: sourceMutation((source) => ({ ...source, digest: "0".repeat(64) })),
    },
    {
      label: "forged model tool name",
      mutate: sourceMutation((source) => ({ ...source, toolName: "other_tool" })),
    },
    {
      label: "forged input",
      mutate: sourceMutation((source) => ({ ...source, input: { path: "other" } })),
    },
    {
      label: "forged input digest",
      mutate: sourceMutation((source) => ({ ...source, inputDigest: "0".repeat(64) })),
    },
    {
      label: "forged rendered argv",
      mutate(request: AgentCommandRequest) {
        return normalizeAgentCommandRequest({ ...request, args: ["other"] });
      },
    },
    {
      label: "unselected package identity",
      mutate: sourceMutation((source) => ({ ...source, name: "other-package" })),
    },
  ])("rejects an internally re-digested $label", async ({ mutate }) => {
    const events = await packageEvents();
    replacePreparedRequest(events, mutate(requirePrepared(events).request));

    expect(() => reduceRunEvents(events)).toThrow(/tool package|source|input|command|selected/i);
  });

  it("rejects forged raw-exec authority combined with stripped package provenance", async () => {
    const events = await packageEvents();
    const started = requireStarted(events);
    if (started.controlGraph === undefined) {
      throw new Error("control graph fixture is missing");
    }
    events[0] = {
      ...started,
      controlGraph: {
        nodes: started.controlGraph.nodes.map((node) =>
          node.type === "agent" && node.nodeId === "agent" && node.commandTools !== undefined
            ? { ...node, commandTools: { ...node.commandTools, rawExec: true } }
            : node,
        ),
      },
    };
    const request = requirePrepared(events).request;
    replacePreparedRequest(
      events,
      normalizeAgentCommandRequest({
        executable: request.executable,
        args: request.args,
        timeoutMs: request.timeoutMs,
      }),
    );

    expect(() => reduceRunEvents(events)).toThrow(/raw exec|tool package|control graph/i);
  });
});

async function packageEvents(): Promise<RunEvent[]> {
  const snapshot = createCapabilitySnapshot([], [], [packageInput()]);
  const packageSnapshot = snapshot.packages[0];
  if (packageSnapshot?.kind !== "tool-package") {
    throw new Error("tool package fixture is missing");
  }
  const store = new MemoryStore();
  const agent: AgentExecutor = {
    execute: vi.fn(async (node, context) => {
      const journal = context.agentCommandJournal;
      if (journal === undefined) {
        throw new Error("package agent did not receive its command journal");
      }
      const request = packageRequest(packageSnapshot, { path: "src" });
      const decision = commandDecision(request);
      const prepared = await journal.prepare({
        request,
        operationDigest: calculateAgentCommandDigest(request),
        decision,
      });
      await prepared.settle(commandSettlement(request));
      return agentSuccess(node.agent.model.provider, node.agent.model.id, decision);
    }),
  };
  await runWorkflow(workflow(), {
    cwd: process.cwd(),
    protectedPaths: [],
    runId: "tool-package-history",
    store,
    executor: new NodeExecutorRouter(fakeCommandExecutor(), agent),
    capabilitySnapshot: snapshot,
  });
  return structuredClone(store.events);
}

function packageRequest(
  snapshot: ToolPackageSnapshot,
  input: Readonly<Record<string, string>>,
): AgentCommandRequest {
  const rendered = renderToolPackageCommand(snapshot, input);
  return normalizeAgentCommandRequest({
    ...rendered.request,
    source: {
      kind: "tool-package",
      name: snapshot.name,
      version: snapshot.version,
      digest: snapshot.digest,
      toolName: snapshot.definition.tool.name,
      input: rendered.input,
      inputDigest: rendered.inputDigest,
    },
  });
}

function replacePreparedRequest(events: RunEvent[], request: AgentCommandRequest): void {
  const preparedIndex = events.findIndex((event) => event.type === "node_agent_command_prepared");
  const prepared = events[preparedIndex];
  if (prepared?.type !== "node_agent_command_prepared") {
    throw new Error("prepared command fixture is missing");
  }
  const decision = commandDecision(request);
  const operationDigest = calculateAgentCommandDigest(request);
  events[preparedIndex] = { ...prepared, request, operationDigest, decision };

  const terminalIndex = events.findIndex(
    (event) => event.type === "node_succeeded" && event.nodeId === "agent",
  );
  const terminal = events[terminalIndex];
  if (terminal?.type !== "node_succeeded" || terminal.evidence.kind !== "agent") {
    throw new Error("terminal agent evidence fixture is missing");
  }
  events[terminalIndex] = {
    ...terminal,
    evidence: { ...terminal.evidence, policyDecisions: [decision] },
  };
}

function sourceMutation(
  mutate: (
    source: NonNullable<AgentCommandRequest["source"]>,
  ) => NonNullable<AgentCommandRequest["source"]>,
): (request: AgentCommandRequest) => AgentCommandRequest {
  return (request) => {
    if (request.source === undefined) {
      throw new Error("sourced command fixture is missing");
    }
    return normalizeAgentCommandRequest({ ...request, source: mutate(request.source) });
  };
}

function commandDecision(request: AgentCommandRequest): PolicyDecision {
  const operationDigest = calculateAgentCommandDigest(request);
  return new PolicyBroker(
    {
      runId: "tool-package-history",
      workflowId: "tool-package-history",
      nodeId: "agent",
      attempt: 1,
    },
    ["process.execute"],
  ).authorize({
    action: "process.execute",
    target: request.executable,
    boundary: "inside",
    operationDigest,
  });
}

function commandSettlement(request: AgentCommandRequest): AgentCommandSettlementOutcome {
  const stdout = "report";
  const stderr = "";
  return {
    status: "succeeded",
    evidence: {
      kind: "command",
      executable: request.executable,
      args: request.args,
      exitCode: 0,
      signal: null,
      stdout,
      stderr,
      stdoutHash: sha256(stdout),
      stderrHash: sha256(stderr),
      stdoutRetainedHash: sha256(stdout),
      stderrRetainedHash: sha256(stderr),
      stdoutRetainedBytes: Buffer.byteLength(stdout),
      stderrRetainedBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
      durationMs: 1,
      processContainment: "linux-pid-namespace",
      terminationStatus: "not-required",
      sandbox: {
        backend: "test-sandbox",
        backendVersion: "1",
        profile: "workspace-write-network-deny-v1",
        policyDigest: "a".repeat(64),
      },
    },
  };
}

function agentSuccess(
  provider: string,
  model: string,
  decision: PolicyDecision,
): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider,
      model,
      text: "done",
      textHash: sha256("done"),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [decision],
      effectReceipts: [],
    },
  };
}

function fakeCommandExecutor(): CommandExecutor {
  return {
    execute: vi.fn(async (node) => ({
      status: "succeeded" as const,
      evidence: commandEvidence(node.command.executable, node.command.args),
    })),
  };
}

function commandEvidence(executable: string, args: readonly string[]): CommandEvidence {
  return {
    kind: "command",
    executable,
    args,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutHash: sha256(""),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function packageInput(): ToolPackageSnapshotInput {
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
    version: "1.2.3",
    description: "Reusable project report tool.",
    trust: "project-explicit",
    provenance: ".flow/tools/project-report",
    definition,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata: { name: project-report, version: 1.2.3, description: Reusable project report tool. }
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

function workflow() {
  return compileWorkflowText(`apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: tool-package-history }
nodes:
  - id: agent
    type: agent
    agent:
      prompt: Produce a report.
      model: { provider: test, id: deterministic }
      toolPackages: [{ name: project-report, version: 1.2.3 }]
  - id: verify
    type: command
    dependsOn: [agent]
    command: { executable: node, args: [--version] }
`);
}

class MemoryStore implements RunEventStore {
  readonly events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }
}

function requireStarted(events: RunEvent[]) {
  const event = events[0];
  if (event?.type !== "run_started") {
    throw new Error("run_started fixture is missing");
  }
  return event;
}

function requirePrepared(events: RunEvent[]) {
  const event = events.find((item) => item.type === "node_agent_command_prepared");
  if (event?.type !== "node_agent_command_prepared") {
    throw new Error("prepared command fixture is missing");
  }
  return event;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
