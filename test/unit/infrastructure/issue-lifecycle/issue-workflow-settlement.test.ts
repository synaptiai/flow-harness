import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { IssueWorkflowDispatch } from "../../../../src/domain/issue-lifecycle/workflow-accounting.js";
import type { AgentEvidence, RunEvent } from "../../../../src/domain/run/events.js";
import { calculateWorkflowDigest } from "../../../../src/domain/workflow/digest.js";
import type { CompiledWorkflow } from "../../../../src/domain/workflow/types.js";
import { JsonlRunStore } from "../../../../src/infrastructure/fs/jsonl-run-store.js";
import { readIssueWorkflowSettlement } from "../../../../src/infrastructure/issue-lifecycle/issue-workflow-settlement.js";

const directories: string[] = [];
const envelope = {
  maxNodeStarts: 10,
  maxModelTokens: 1000,
  maxCostUsdMicros: 1000,
  maxExecutionMs: 1000,
  maxArtifactBytes: 1000,
};
const workflow: CompiledWorkflow = {
  apiVersion: "flow.synapti.ai/v1alpha1",
  id: "repair",
  budget: envelope,
  nodes: [
    {
      id: "repair",
      type: "agent",
      dependsOn: [],
      agent: {
        prompt: "Repair the approved issue.",
        model: { provider: "openrouter", id: "approved-model", thinking: "off" },
        tools: ["read", "edit"],
        skills: [],
        toolPackages: [],
        timeoutMs: 1000,
      },
    },
  ],
};
const dispatch: IssueWorkflowDispatch = {
  version: 1,
  dispatchId: "dispatch-1",
  parentIssueRunId: "issue-1",
  ordinal: 1,
  role: "implementation",
  cycle: 1,
  flowRunId: "issue-1-repair-1",
  frozenContractDigest: "a".repeat(64),
  templateWorkflowDigest: "b".repeat(64),
  executionWorkflowDigest: calculateWorkflowDigest(workflow),
  workspaceIdentityDigest: "c".repeat(64),
  candidateHead: "d".repeat(40),
  reportDigest: "e".repeat(64),
  envelope,
};
const expected = {
  parentIssueRunId: dispatch.parentIssueRunId,
  flowRunId: dispatch.flowRunId,
  frozenContractDigest: dispatch.frozenContractDigest,
  templateWorkflowDigest: dispatch.templateWorkflowDigest,
  workspaceIdentityDigest: dispatch.workspaceIdentityDigest,
  executionCwd: "/host/isolated-workspace",
  workspaceAuthorityDigest: "f".repeat(64),
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readIssueWorkflowSettlement", () => {
  it("settles exact persisted terminal resources and hashes the same committed event array", async () => {
    const root = await persist(success());
    const result = await read(root);
    expect(result.kind).toBe("terminal");
    if (result.kind !== "terminal") throw new Error("Expected terminal result");
    const events = await new JsonlRunStore(root).read(dispatch.flowRunId);
    expect(result.settlement).toEqual({
      version: 1,
      dispatchId: dispatch.dispatchId,
      flowRunId: dispatch.flowRunId,
      executionWorkflowDigest: dispatch.executionWorkflowDigest,
      terminalSequence: 4,
      ledgerDigest: sha256(`flow.issue.nested-workflow-evidence.v1\0${JSON.stringify(events)}`),
      status: "succeeded",
      resources: {
        nodeStarts: 1,
        modelTokens: 12,
        modelCostUsdMicros: 7,
        executionMs: 3,
        artifactBytes: 4,
      },
      availability: {
        nodeStarts: "complete",
        modelTokens: "complete",
        modelCostUsdMicros: "complete",
        executionMs: "complete",
        artifactBytes: "complete",
      },
    });
    expect(result.state.lastSequence).toBe(result.settlement.terminalSequence);
    expect(Object.isFrozen(result.settlement.resources)).toBe(true);
  });

  it("distinguishes genuinely absent work from a valid incomplete ledger", async () => {
    const root = await temporary();
    expect(await read(root)).toEqual({ kind: "absent" });
    await mkdir(join(root, dispatch.flowRunId));
    expect(await read(root)).toEqual({ kind: "absent" });
    await persist([started(), nodeStarted()], root);
    expect(await read(root)).toMatchObject({
      kind: "incomplete",
      state: { status: "running", resources: { nodeStarts: 1 } },
    });
  });

  it.each(["artifact.json", ".owner"])(
    "does not call an absent ledger with %s no work",
    async (name) => {
      const root = await temporary();
      await mkdir(join(root, dispatch.flowRunId));
      await writeFile(join(root, dispatch.flowRunId, name), "existing child state");
      await expect(read(root)).rejects.toThrow(/absent.*state/i);
    },
  );

  it.each(["{malformed}\n", "", "{torn-first-record"])(
    "rejects malformed or empty ledgers rather than releasing reservations: %s",
    async (contents) => {
      const root = await temporary();
      await mkdir(join(root, dispatch.flowRunId));
      await writeFile(join(root, dispatch.flowRunId, "events.jsonl"), contents);
      await expect(read(root)).rejects.toThrow();
    },
  );

  it("rejects a dangling child directory link as uncertain state, not absence", async () => {
    const root = await temporary();
    await symlink(join(root, "missing-state"), join(root, dispatch.flowRunId));
    await expect(read(root)).rejects.toThrow(/absent.*state/i);
  });

  it.each([
    "parentIssueRunId",
    "flowRunId",
    "frozenContractDigest",
    "templateWorkflowDigest",
    "workspaceIdentityDigest",
  ] as const)("rejects a mismatched host %s binding", async (field) => {
    const root = await persist(success());
    await expect(
      readIssueWorkflowSettlement({
        nestedRunRoot: root,
        workflow,
        dispatch,
        expected: { ...expected, [field]: field.endsWith("Digest") ? "0".repeat(64) : "mismatch" },
      }),
    ).rejects.toThrow();
  });

  it.each(["workflowDigest", "workspaceAuthorityDigest", "executionCwd"] as const)(
    "rejects mismatched child %s metadata",
    async (field) => {
      const events = success();
      events[0] = {
        ...started(),
        [field]: field === "executionCwd" ? "/different-workspace" : "0".repeat(64),
      };
      await expect(read(await persist(events))).rejects.toThrow();
    },
  );

  it("rejects a ledger with absent workspace authority metadata", async () => {
    const { workspaceAuthorityDigest: _omitted, ...legacy } = started();
    const events = success();
    events[0] = legacy;
    await expect(read(await persist(events))).rejects.toThrow();
  });

  it("rejects a different compiled execution workflow", async () => {
    const root = await persist(success());
    await expect(
      readIssueWorkflowSettlement({
        nestedRunRoot: root,
        workflow: { ...workflow, description: "different" },
        dispatch,
        expected,
      }),
    ).rejects.toThrow();
  });

  it.each(Object.keys(envelope) as (keyof typeof envelope)[])(
    "checks exact child envelope dimension %s",
    async (dimension) => {
      const events = success();
      events[0] = { ...started(), budget: { ...envelope, [dimension]: envelope[dimension] + 1 } };
      await expect(read(await persist(events))).rejects.toThrow();
    },
  );

  it("rejects a dispatch envelope that differs from the compiled workflow", async () => {
    const root = await persist(success());
    await expect(
      readIssueWorkflowSettlement({
        nestedRunRoot: root,
        workflow,
        dispatch: { ...dispatch, envelope: { ...envelope, maxModelTokens: 999 } },
        expected,
      }),
    ).rejects.toThrow();
  });

  it("retains known failed usage without treating failure as invalid settlement", async () => {
    const result = await read(await persist(failed(evidence())));
    expect(result).toMatchObject({
      kind: "terminal",
      settlement: {
        status: "failed",
        resources: { modelTokens: 12 },
        availability: { modelTokens: "complete" },
      },
    });
  });

  it("marks missing failed evidence unavailable instead of zero complete", async () => {
    const result = await read(await persist(failed(null)));
    expect(result).toMatchObject({
      kind: "terminal",
      settlement: {
        resources: { nodeStarts: 1, modelTokens: 0 },
        availability: {
          nodeStarts: "complete",
          modelTokens: "unavailable",
          modelCostUsdMicros: "unavailable",
          executionMs: "unavailable",
          artifactBytes: "unavailable",
        },
      },
    });
  });

  it("keeps absent model usage unavailable even when evidence and duration exist", async () => {
    const { usage: _omitted, ...withoutUsage } = evidence();
    const result = await read(await persist(failed(withoutUsage)));
    expect(result).toMatchObject({
      kind: "terminal",
      settlement: {
        resources: { executionMs: 3, artifactBytes: 4 },
        availability: {
          modelTokens: "unavailable",
          modelCostUsdMicros: "unavailable",
          executionMs: "complete",
          artifactBytes: "complete",
        },
      },
    });
  });

  it("marks a cancelled attempt with missing evidence unavailable", async () => {
    const result = await read(
      await persist([
        ...failed(null).slice(0, 3),
        {
          ...base(4),
          type: "run_cancelled",
          reason: "operator cancelled",
          cancelledNodeId: "repair",
        },
      ]),
    );
    expect(result).toMatchObject({
      kind: "terminal",
      settlement: {
        status: "cancelled",
        availability: { modelTokens: "unavailable", executionMs: "unavailable" },
      },
    });
  });

  it("records complete zero consumption when cancelled before any node starts", async () => {
    const result = await read(
      await persist([
        started(),
        { ...base(2), type: "run_cancelled", reason: "operator cancelled" },
      ]),
    );
    expect(result).toMatchObject({
      kind: "terminal",
      settlement: {
        resources: { nodeStarts: 0, modelTokens: 0 },
        availability: { modelTokens: "complete", executionMs: "complete" },
      },
    });
  });

  it("settles a resource-exhausted ledger without clipping observed consumption to its limit", async () => {
    const events = success();
    events[2] = {
      ...base(3),
      type: "node_succeeded",
      nodeId: "repair",
      attempt: 1,
      evidence: {
        ...evidence(),
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 1001,
        },
      },
    };
    events[3] = {
      ...base(4),
      type: "run_budget_exhausted",
      exhausted: [{ dimension: "modelCostUsdMicros", limit: 1000, consumed: 1001 }],
    };
    expect(await read(await persist(events))).toMatchObject({
      kind: "terminal",
      settlement: {
        status: "resource_exhausted",
        resources: { modelCostUsdMicros: 1001 },
        availability: { modelCostUsdMicros: "complete" },
      },
    });
  });

  it("preserves independently unavailable cost while retaining complete observed tokens", async () => {
    const { usage: _legacy, ...observedEvidence } = evidence();
    const result = await read(
      await persist(
        failed({
          ...observedEvidence,
          usageObservation: {
            modelTokens: { status: "complete", totalTokens: 12 },
            costUsd: { status: "unavailable" },
          },
        }),
      ),
    );
    expect(result).toMatchObject({
      kind: "terminal",
      settlement: {
        resources: { modelTokens: 12, modelCostUsdMicros: 0 },
        availability: { modelTokens: "complete", modelCostUsdMicros: "unavailable" },
      },
    });
  });
});

function read(nestedRunRoot: string) {
  return readIssueWorkflowSettlement({ nestedRunRoot, workflow, dispatch, expected });
}
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "flow-settlement-"));
  directories.push(root);
  return root;
}
async function persist(events: readonly RunEvent[], root?: string) {
  const directory = root ?? (await temporary());
  const store = new JsonlRunStore(directory);
  try {
    for (const event of events) await store.append(event);
  } finally {
    await store.release(dispatch.flowRunId);
  }
  return directory;
}
function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: "2026-09-06T12:00:00.000Z",
    runId: dispatch.flowRunId,
    workflowId: workflow.id,
  };
}
function started(): Extract<RunEvent, { type: "run_started" }> {
  return {
    ...base(1),
    type: "run_started",
    nodeIds: ["repair"],
    workflowApiVersion: workflow.apiVersion,
    workflowDigest: dispatch.executionWorkflowDigest,
    workspaceAuthorityDigest: expected.workspaceAuthorityDigest,
    executionCwd: expected.executionCwd,
    budget: envelope,
  };
}
function nodeStarted(): Extract<RunEvent, { type: "node_started" }> {
  return { ...base(2), type: "node_started", nodeId: "repair", attempt: 1 };
}
function evidence(): AgentEvidence {
  return {
    kind: "agent",
    provider: "openrouter",
    model: "approved-model",
    text: "done",
    textHash: sha256("done"),
    textTruncated: false,
    durationMs: 3,
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdMicros: 7,
    },
    policyDecisions: [],
    effectReceipts: [],
  };
}
function success(): RunEvent[] {
  return [
    started(),
    nodeStarted(),
    { ...base(3), type: "node_succeeded", nodeId: "repair", attempt: 1, evidence: evidence() },
    { ...base(4), type: "run_succeeded" },
  ];
}
function failed(value: AgentEvidence | null): RunEvent[] {
  return [
    started(),
    nodeStarted(),
    {
      ...base(3),
      type: "node_failed",
      nodeId: "repair",
      attempt: 1,
      error: {
        code: "execution_failed",
        message: "Execution failed",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: value,
    },
    { ...base(4), type: "run_failed", failedNodeId: "repair", reason: "Execution failed" },
  ];
}
function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
