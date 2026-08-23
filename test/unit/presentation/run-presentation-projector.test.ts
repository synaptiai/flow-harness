import { describe, expect, it } from "vitest";
import { MAX_FLOW_PRESENTATION_ROWS } from "../../../src/domain/presentation/flow-presentation.js";
import {
  MAX_PRESENTED_APPROVALS,
  projectRunPresentation,
  RunPresentationProjectionError,
} from "../../../src/domain/presentation/run-presentation-projector.js";
import { MAX_COMPILED_WORKFLOW_NODES } from "../../../src/domain/workflow/types.js";

describe("run presentation projector", () => {
  it("projects deterministic public summaries and exact current actions", () => {
    const first = projectRunPresentation(waitingRun());
    const reordered = projectRunPresentation({
      ...waitingRun(),
      nodes: Object.fromEntries(Object.entries(waitingRun().nodes).reverse()),
    });

    expect(reordered).toEqual(first);
    expect(first.run).toEqual({
      runId: "run-1",
      workflowId: "review-workflow",
      status: "waiting_for_approval",
      sequence: 12,
    });
    expect(table(first, "nodes").rows.map((row) => row.cells.slice(0, 3))).toEqual([
      ["agent", "running", "1"],
      ["command", "succeeded", "1"],
      ["review", "running", "1"],
    ]);
    expect(table(first, "approvals").rows.map((row) => row.cells.slice(0, 3))).toEqual([
      ["agent", "agent command", "agent-request-3"],
      ["command", "command", "command-request-1"],
      ["review", "workflow", "workflow-request-2"],
    ]);
    expect(first.actions).toEqual([
      {
        kind: "approve",
        actionId: "approve:agent-request-3",
        requestId: "agent-request-3",
        label: "Approve agent command request for agent",
      },
      {
        kind: "deny",
        actionId: "deny:agent-request-3",
        requestId: "agent-request-3",
        label: "Deny agent command request for agent",
      },
      {
        kind: "approve",
        actionId: "approve:command-request-1",
        requestId: "command-request-1",
        label: "Approve command request for command",
      },
      {
        kind: "deny",
        actionId: "deny:command-request-1",
        requestId: "command-request-1",
        label: "Deny command request for command",
      },
      {
        kind: "approve",
        actionId: "approve:workflow-request-2",
        requestId: "workflow-request-2",
        label: "Approve workflow request for review",
      },
      {
        kind: "deny",
        actionId: "deny:workflow-request-2",
        requestId: "workflow-request-2",
        label: "Deny workflow request for review",
      },
      { kind: "cancel", actionId: "cancel:run-1", runId: "run-1", label: "Cancel run" },
    ]);
  });

  it("orders ASCII identifiers by stable code units instead of the host locale", () => {
    const input = waitingRun();
    input.nodes = {
      "a-node": node("pending", 0),
      "Z-node": node("pending", 0),
    };

    const document = projectRunPresentation(input);

    expect(table(document, "nodes").rows.map((row) => row.cells[0])).toEqual(["Z-node", "a-node"]);
  });

  it("never projects private capability, evidence, operation, path, or error content", () => {
    const privateBytes = Buffer.from("PRIVATE_AGENT_SKILL_RESOURCE").toString("base64");
    const input = waitingRun();
    input.capabilitySnapshot = {
      packages: [{ files: [{ contentBase64: privateBytes }] }],
    };
    input.executionCwd = "/PRIVATE/protected/workspace";
    input.failureReason = "\u001b]52;c;PRIVATE_FAILURE\u0007";
    const command = input.nodes.command;
    if (command?.evidence === null || command?.approval === null || command === undefined) {
      throw new Error("test fixture must contain command evidence and approval");
    }
    command.evidence.stdout = "PRIVATE_STDOUT";
    command.error = {
      code: "command_failed",
      message: "/PRIVATE/protected/file",
      cause: { contentBase64: "PRIVATE_CAUSE" },
    };
    command.approval.operation = {
      executable: "/PRIVATE/bin/tool",
      args: ["PRIVATE_ARGUMENT"],
    };

    const encoded = JSON.stringify(projectRunPresentation(input));

    expect(encoded).not.toContain("contentBase64");
    expect(encoded).not.toContain(privateBytes);
    expect(encoded).not.toContain("PRIVATE_");
    expect(encoded).not.toContain("/PRIVATE");
    expect(encoded).not.toContain("\u001b");
    expect(encoded).toContain("command_failed");
  });

  it("projects fixed resource facts and a value-free failure notice", () => {
    const input = waitingRun();
    input.status = "failed";
    input.failedNodeId = "command";
    input.failureReason = "PRIVATE failure at /PRIVATE/path";
    input.finishedAt = "2026-08-16T08:00:13.000Z";

    const document = projectRunPresentation(input);

    expect(facts(document, "resources")).toEqual([
      { label: "Node starts", value: "2" },
      { label: "Model tokens", value: "300" },
      { label: "Model cost", value: "42 µUSD" },
      { label: "Execution", value: "1250 ms" },
      { label: "Artifacts", value: "4096 bytes" },
    ]);
    expect(section(document, "outcome").components).toEqual([
      { kind: "notice", tone: "danger", text: "Run failed at node command." },
    ]);
    expect(document.actions).toEqual([]);
  });

  it("distinguishes unavailable model resource dimensions from measured zero", () => {
    const input = waitingRun();
    input.resources.modelTokens = 0;
    input.resources.modelCostUsdMicros = 0;
    input.resourceAvailability = {
      modelTokens: "unavailable",
      modelCostUsdMicros: "unavailable",
    };

    const document = projectRunPresentation(input);

    expect(facts(document, "resources")).toEqual([
      { label: "Node starts", value: "2" },
      { label: "Model tokens", value: "Unavailable" },
      { label: "Model cost", value: "Unavailable" },
      { label: "Execution", value: "1250 ms" },
      { label: "Artifacts", value: "4096 bytes" },
    ]);
  });

  it.each([
    ["succeeded", "success", "Run succeeded."],
    ["cancelled", "warning", "Run was cancelled."],
    ["resource_exhausted", "danger", "Run exhausted its resource budget."],
  ])("projects the fixed %s outcome", (status, tone, text) => {
    const input = waitingRun();
    input.status = status;
    input.finishedAt = "2026-08-16T08:00:13.000Z";

    const document = projectRunPresentation(input);

    expect(section(document, "outcome").components).toEqual([{ kind: "notice", tone, text }]);
    expect(document.actions).toEqual([]);
  });

  it("fits the exact maximum node count and rejects one more", () => {
    const exact = waitingRun();
    exact.nodes = Object.fromEntries(
      Array.from({ length: MAX_COMPILED_WORKFLOW_NODES }, (_, index) => [
        `node-${String(index).padStart(3, "0")}`,
        node("pending", 0),
      ]),
    );

    const document = projectRunPresentation(exact);

    expect(table(document, "nodes").rows).toHaveLength(MAX_COMPILED_WORKFLOW_NODES);
    expect(document.truncated).toBe(false);

    exact.nodes["node-excess"] = node("pending", 0);
    expect(() => projectRunPresentation(exact)).toThrow(RunPresentationProjectionError);
  });

  it("retains cancel and deterministically truncates excessive approval actions", () => {
    const input = waitingRun();
    input.nodes = Object.fromEntries(
      Array.from({ length: MAX_COMPILED_WORKFLOW_NODES }, (_, index) => {
        const nodeId = `node-${String(index).padStart(3, "0")}`;
        return [
          nodeId,
          {
            ...node("running", 1),
            approval: {
              status: "pending",
              requestId: `request-${String(index).padStart(3, "0")}`,
              requestedAt: "2026-08-16T08:00:01.000Z",
            },
          },
        ];
      }),
    );

    const document = projectRunPresentation(input);

    expect(table(document, "approvals").rows).toHaveLength(MAX_COMPILED_WORKFLOW_NODES);
    expect(document.actions.filter((action) => action.kind === "approve")).toHaveLength(
      MAX_PRESENTED_APPROVALS,
    );
    expect(document.actions.at(-1)).toEqual({
      kind: "cancel",
      actionId: "cancel:run-1",
      runId: "run-1",
      label: "Cancel run",
    });
    expect(document.truncated).toBe(true);
  });

  it("bounds approval rows when nodes expose more than one pending approval kind", () => {
    const input = waitingRun();
    input.nodes = Object.fromEntries(
      Array.from({ length: MAX_FLOW_PRESENTATION_ROWS / 2 + 1 }, (_, index) => {
        const suffix = String(index).padStart(3, "0");
        return [
          `node-${suffix}`,
          {
            ...node("running", 1),
            approval: {
              status: "pending",
              requestId: `command-${suffix}`,
              requestedAt: "2026-08-16T08:00:01.000Z",
            },
            workflowApproval: {
              status: "pending",
              requestId: `workflow-${suffix}`,
              requestedAt: "2026-08-16T08:00:02.000Z",
            },
          },
        ];
      }),
    );

    const document = projectRunPresentation(input);
    const approvals = table(document, "approvals");

    expect(approvals.rows).toHaveLength(MAX_FLOW_PRESENTATION_ROWS);
    expect(approvals.truncated).toBe(true);
    expect(document.truncated).toBe(true);
  });

  it("rejects malformed public run input with one value-free stage", () => {
    const input = waitingRun();
    input.resources.modelTokens = -1;

    expect(() => projectRunPresentation(input)).toThrow(
      "Cannot project Flow run presentation: public run state is invalid",
    );
  });
});

interface FixtureApproval {
  status: string;
  requestId: string;
  requestedAt: string;
  operation?: unknown;
  request?: unknown;
}

interface FixtureNode {
  status: string;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  evidence: { kind: string; stdout?: string; durationMs?: number } | null;
  error: { code: string; message?: string; cause?: unknown } | null;
  approval: FixtureApproval | null;
  workflowApproval: FixtureApproval | null;
  agentCommandApprovals: FixtureApproval[];
}

interface FixtureRun {
  runId: string;
  workflowId: string;
  status: string;
  lastSequence: number;
  startedAt: string;
  finishedAt: string | null;
  failedNodeId: string | null;
  failureReason: string | null;
  resources: {
    nodeStarts: number;
    modelTokens: number;
    modelCostUsdMicros: number;
    executionMs: number;
    artifactBytes: number;
  };
  resourceAvailability?: {
    modelTokens: "complete" | "unavailable";
    modelCostUsdMicros: "complete" | "unavailable";
  };
  nodes: Record<string, FixtureNode>;
  capabilitySnapshot?: unknown;
  executionCwd?: string;
}

function waitingRun(): FixtureRun {
  return {
    runId: "run-1",
    workflowId: "review-workflow",
    status: "waiting_for_approval",
    lastSequence: 12,
    startedAt: "2026-08-16T08:00:01.000Z",
    finishedAt: null,
    failedNodeId: null,
    failureReason: null,
    resources: {
      nodeStarts: 2,
      modelTokens: 300,
      modelCostUsdMicros: 42,
      executionMs: 1250,
      artifactBytes: 4096,
    },
    nodes: {
      review: {
        ...node("running", 1),
        workflowApproval: {
          status: "pending",
          requestId: "workflow-request-2",
          requestedAt: "2026-08-16T08:00:04.000Z",
          request: { prompt: "PRIVATE_WORKFLOW_PROMPT" },
        },
      },
      command: {
        ...node("succeeded", 1),
        evidence: { kind: "command", stdout: "PRIVATE_COMMAND_OUTPUT", durationMs: 20 },
        approval: {
          status: "pending",
          requestId: "command-request-1",
          requestedAt: "2026-08-16T08:00:03.000Z",
          operation: { executable: "PRIVATE_COMMAND", args: ["PRIVATE_ARGUMENT"] },
        },
      },
      agent: {
        ...node("running", 1),
        agentCommandApprovals: [
          {
            status: "pending",
            requestId: "agent-request-3",
            requestedAt: "2026-08-16T08:00:02.000Z",
            request: { executable: "PRIVATE_AGENT_COMMAND" },
          },
        ],
      },
    },
  };
}

function node(status: string, attempt: number): FixtureNode {
  return {
    status,
    attempt,
    startedAt: attempt === 0 ? null : "2026-08-16T08:00:02.000Z",
    finishedAt: status === "succeeded" ? "2026-08-16T08:00:03.000Z" : null,
    evidence: null,
    error: null,
    approval: null,
    workflowApproval: null,
    agentCommandApprovals: [],
  };
}

function section(document: ReturnType<typeof projectRunPresentation>, id: string) {
  const found = document.sections.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`expected section ${id}`);
  }
  return found;
}

function table(document: ReturnType<typeof projectRunPresentation>, id: string) {
  const component = section(document, id).components.find((item) => item.kind === "table");
  if (component?.kind !== "table") {
    throw new Error(`expected table in section ${id}`);
  }
  return component;
}

function facts(document: ReturnType<typeof projectRunPresentation>, id: string) {
  const component = section(document, id).components.find((item) => item.kind === "facts");
  if (component?.kind !== "facts") {
    throw new Error(`expected facts in section ${id}`);
  }
  return component.items;
}
