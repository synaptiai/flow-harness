import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { NodeExecutor, RunEventStore } from "../../../src/application/ports.js";
import { runWorkflow } from "../../../src/application/run-workflow.js";
import {
  combineCapabilitySnapshots,
  createCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import type { WorkflowPackageSnapshotInput } from "../../../src/domain/capability/workflow-packages.js";
import { type RunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("workflow package run history", () => {
  it("persists and replays exact requirements against graph and snapshot", async () => {
    const events = await packageEvents();
    const started = requireStarted(events);
    const selected = started.capabilitySnapshot?.packages[0];
    if (selected?.kind !== "workflow-package") {
      throw new Error("workflow package fixture is missing");
    }

    expect(started.workflowPackageRequirements).toEqual([
      { name: "release-check", version: "1.0.0", digest: selected.digest },
    ]);
    expect(started.controlGraph?.workflowPackages).toEqual(started.workflowPackageRequirements);
    expect(reduceRunEvents(events).workflowPackageRequirements).toEqual(
      started.workflowPackageRequirements,
    );
  });

  it.each([
    {
      label: "missing requirement",
      mutate(events: RunEvent[]) {
        const started = requireStarted(events);
        const { workflowPackageRequirements: _requirements, ...without } = started;
        events[0] = without;
      },
    },
    {
      label: "requirement digest drift",
      mutate(events: RunEvent[]) {
        const started = requireStarted(events);
        events[0] = {
          ...started,
          workflowPackageRequirements: [
            { name: "release-check", version: "1.0.0", digest: "0".repeat(64) },
          ],
        };
      },
    },
    {
      label: "compound requirement and graph digest drift",
      mutate(events: RunEvent[]) {
        const started = requireStarted(events);
        if (started.controlGraph === undefined) {
          throw new Error("control graph fixture is missing");
        }
        const forged = { name: "release-check", version: "1.0.0", digest: "0".repeat(64) };
        events[0] = {
          ...started,
          workflowPackageRequirements: [forged],
          controlGraph: { ...started.controlGraph, workflowPackages: [forged] },
        };
      },
    },
  ])("rejects $label at run start", async ({ mutate }) => {
    const events = await packageEvents();
    mutate(events);

    expect(() => reduceRunEvents(events)).toThrow(/workflow package|control graph|snapshot/i);
  });

  it("rejects a recomputed root snapshot containing an undeclared workflow package", async () => {
    const events = await packageEvents();
    const started = requireStarted(events);
    if (started.capabilitySnapshot === undefined) {
      throw new Error("capability snapshot fixture is missing");
    }
    const extra = createCapabilitySnapshot([], [], [], [packageInput("undeclared")]);
    const forged = combineCapabilitySnapshots([started.capabilitySnapshot, extra]);
    if (forged === undefined) {
      throw new Error("combined capability snapshot fixture is missing");
    }
    events[0] = { ...started, capabilitySnapshot: forged };

    expect(() => reduceRunEvents(events)).toThrow(/undeclared|unexpected|workflow package/i);
  });

  it("rejects a root snapshot forgery disguised with self-asserted child provenance", async () => {
    const events = await packageEvents();
    const started = requireStarted(events);
    if (started.capabilitySnapshot === undefined) {
      throw new Error("capability snapshot fixture is missing");
    }
    const extra = createCapabilitySnapshot([], [], [], [packageInput("undeclared")]);
    const forged = combineCapabilitySnapshots([started.capabilitySnapshot, extra]);
    if (forged === undefined) {
      throw new Error("combined capability snapshot fixture is missing");
    }
    events[0] = {
      ...started,
      capabilitySnapshot: forged,
      executionWorkspace: {
        backend: "reflink-copy-v1",
        snapshotDigest: "1".repeat(64),
        parentRunId: "invented-parent",
        parentNodeId: "invented-child-node",
        parentAttempt: 1,
      },
    };

    expect(() => reduceRunEvents(events)).toThrow(/child.*identity|workspace.*provenance/i);
  });
});

async function packageEvents(): Promise<RunEvent[]> {
  const snapshot = createCapabilitySnapshot([], [], [], [packageInput()]);
  const selected = snapshot.packages[0];
  if (selected?.kind !== "workflow-package") {
    throw new Error("workflow package fixture is missing");
  }
  const workflow = compileWorkflowText(workflowSource(), "workflow:release-check@1.0.0", {
    sourcePackage: { name: selected.name, version: selected.version, digest: selected.digest },
  });
  const store = new MemoryStore();
  await runWorkflow(workflow, {
    cwd: process.cwd(),
    protectedPaths: [],
    runId: "workflow-package-history",
    store,
    executor: successfulExecutor(),
    capabilitySnapshot: snapshot,
  });
  return structuredClone(store.events);
}

function packageInput(name = "release-check"): WorkflowPackageSnapshotInput {
  const indented = workflowSource(name)
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return {
    kind: "workflow-package",
    trust: "project-explicit",
    provenance: `.flow/workflows/${name}`,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata: { name: ${name}, version: 1.0.0, description: Release check. }
spec:
  workflow: |-
${indented}
`),
    },
  };
}

function workflowSource(id = "release-check"): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 1
  maxModelTokens: 1
  maxCostUsd: 1
  maxExecutionMs: 1000
  maxArtifactBytes: 1024
nodes:
  - id: finish
    type: command
    command: { executable: /usr/bin/true }
`;
}

function successfulExecutor(): NodeExecutor {
  return {
    execute: vi.fn(async (node) => ({
      status: "succeeded" as const,
      evidence: {
        kind: "command" as const,
        executable: node.type === "command" ? node.command.executable : "/usr/bin/true",
        args: node.type === "command" ? node.command.args : [],
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
      },
    })),
  };
}

function requireStarted(events: RunEvent[]) {
  const event = events[0];
  if (event?.type !== "run_started") {
    throw new Error("run_started fixture is missing");
  }
  return event;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
