import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import {
  createAgentCapabilityEvidence,
  createCapabilitySnapshot,
  type CapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import type { RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("run workflow capability snapshots", () => {
  it("persists and passes the exact bound snapshot to selected agent execution", async () => {
    const store = new MemoryStore();
    const snapshot = capabilitySnapshot("review");
    let observed: CapabilitySnapshot | undefined;

    const state = await runWorkflow(skilledWorkflow(), {
      ...options(
        store,
        executorFrom((_node, context) => {
          observed = context.capabilitySnapshot;
          return agentSuccess(context.capabilitySnapshot);
        }),
      ),
      runId: "capability-run",
      capabilitySnapshot: snapshot,
    });

    expect(observed).toBe(snapshot);
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: { digest: snapshot.digest },
      capabilityRequirements: [{ nodeId: "analyze", skills: ["review"] }],
    });
    expect(state.capabilitySnapshot).toEqual(snapshot);
  });

  it("does not persist or pass an empty capability contract for an ordinary workflow", async () => {
    const store = new MemoryStore();
    let context: NodeExecutionContext | undefined;

    const state = await runWorkflow(unskilledWorkflow(), {
      ...options(
        store,
        executorFrom((_node, received) => {
          context = received;
          return agentSuccess();
        }),
      ),
      runId: "no-capability-run",
    });

    expect(store.events[0]).not.toHaveProperty("capabilitySnapshot");
    expect(store.events[0]).not.toHaveProperty("capabilityRequirements");
    expect(state.capabilitySnapshot).toBeNull();
    expect(state.capabilityRequirements).toEqual({});
    expect(context).not.toHaveProperty("capabilitySnapshot");
  });

  it("rejects missing and non-exact snapshots before appending run history", async () => {
    const store = new MemoryStore();

    await expect(
      runWorkflow(skilledWorkflow(), {
        ...options(
          store,
          executorFrom(() => agentSuccess()),
        ),
        runId: "missing-capability-run",
      }),
    ).rejects.toMatchObject({ code: "missing_snapshot" });
    expect(store.events).toEqual([]);

    await expect(
      runWorkflow(skilledWorkflow(), {
        ...options(
          store,
          executorFrom(() => agentSuccess()),
        ),
        runId: "extra-capability-run",
        capabilitySnapshot: createCapabilitySnapshot([skill("review"), skill("unused")]),
      }),
    ).rejects.toMatchObject({ code: "unexpected_skill" });
    expect(store.events).toEqual([]);
  });

  it("binds a child workflow to its subset while preserving the parent snapshot identity", async () => {
    const store = new MemoryStore();
    const parentSnapshot = createCapabilitySnapshot([skill("review"), skill("unused")]);

    const state = await runWorkflow(skilledWorkflow(), {
      ...options(
        store,
        executorFrom((_node, context) => agentSuccess(context.capabilitySnapshot)),
      ),
      runId: "child-capability-run",
      capabilitySnapshot: parentSnapshot,
      executionWorkspace: {
        backend: "reflink-copy-v1",
        snapshotDigest: "a".repeat(64),
        parentRunId: "parent-run",
        parentNodeId: "delegate",
        parentAttempt: 1,
      },
    });

    expect(state.capabilitySnapshot?.digest).toBe(parentSnapshot.digest);
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: { digest: parentSnapshot.digest },
      executionWorkspace: { parentRunId: "parent-run" },
    });
  });

  it("resumes from the durable snapshot without reading live package sources", async () => {
    const interruptedStore = new MemoryStore("node_started");
    const snapshot = capabilitySnapshot("review");
    await expect(
      runWorkflow(skilledWorkflow(), {
        ...options(
          interruptedStore,
          executorFrom(() => agentSuccess()),
        ),
        runId: "resume-capability-run",
        capabilitySnapshot: snapshot,
      }),
    ).rejects.toThrow("injected persistence failure");
    expect(interruptedStore.events.map((event) => event.type)).toEqual(["run_started"]);

    const recoveredStore = new MemoryStore(undefined, interruptedStore.events);
    let observed: CapabilitySnapshot | undefined;
    const state = await resumeWorkflow(skilledWorkflow(), {
      ...options(
        recoveredStore,
        executorFrom((_node, context) => {
          observed = context.capabilitySnapshot;
          return agentSuccess(context.capabilitySnapshot);
        }),
      ),
      runId: "resume-capability-run",
    });

    expect(observed).toEqual(snapshot);
    expect(state).toMatchObject({ status: "succeeded", failureReason: null });
  });

  it("rejects recovery history that attributes a valid package to the wrong agent node", async () => {
    const snapshot = createCapabilitySnapshot([skill("review"), skill("unused")]);
    const completed = new MemoryStore();
    const workflow = twoSkilledAgentsWorkflow();
    await runWorkflow(workflow, {
      ...options(
        completed,
        executorFrom((node, context) => {
          if (node.type !== "agent" || context.capabilitySnapshot === undefined) {
            throw new Error("unexpected test node");
          }
          const text = JSON.stringify("done");
          return {
            status: "succeeded",
            evidence: {
              kind: "agent",
              provider: "test",
              model: "deterministic",
              text,
              textHash: createHash("sha256").update(text).digest("hex"),
              textTruncated: false,
              durationMs: 1,
              policyDecisions: [],
              effectReceipts: [],
              capabilities: createAgentCapabilityEvidence(
                context.capabilitySnapshot,
                node.agent.skills,
              ),
            },
          };
        }),
      ),
      runId: "capability-attribution-run",
      capabilitySnapshot: snapshot,
    });
    const interrupted: RunEvent[] = structuredClone(completed.events.slice(0, 3));
    const firstOutcome = interrupted[2];
    if (firstOutcome?.type !== "node_succeeded" || firstOutcome.evidence.kind !== "agent") {
      throw new Error("agent outcome fixture was not created");
    }
    interrupted[2] = {
      ...firstOutcome,
      evidence: {
        ...firstOutcome.evidence,
        capabilities: createAgentCapabilityEvidence(snapshot, ["unused"]),
      },
    };
    const recovered = new MemoryStore(undefined, interrupted);

    await expect(
      resumeWorkflow(workflow, {
        ...options(
          recovered,
          executorFrom(() => agentSuccess(snapshot)),
        ),
        runId: "capability-attribution-run",
      }),
    ).rejects.toThrow(/durable node declaration/i);
  });
});

class MemoryStore implements RecoverableRunEventStore {
  readonly events: RunEvent[];

  constructor(
    private readonly failingType?: RunEvent["type"],
    initial: readonly RunEvent[] = [],
  ) {
    this.events = structuredClone([...initial]);
  }

  async append(event: RunEvent): Promise<void> {
    if (event.type === this.failingType) {
      throw new Error("injected persistence failure");
    }
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async claim(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async release(): Promise<void> {}
}

function options(store: RecoverableRunEventStore, executor: NodeExecutor) {
  return {
    cwd: process.cwd(),
    protectedPaths: [],
    store,
    executor,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
  };
}

function executorFrom(
  execute: (
    node: Parameters<NodeExecutor["execute"]>[0],
    context: NodeExecutionContext,
  ) => NodeExecutionOutcome,
): NodeExecutor {
  return { execute: async (node, context) => execute(node, context) };
}

function skilledWorkflow() {
  return compileWorkflowText(workflowSource("skills: [review]"));
}

function unskilledWorkflow() {
  return compileWorkflowText(workflowSource(""));
}

function twoSkilledAgentsWorkflow() {
  return compileWorkflowText(`apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: capability-attribution }
nodes:
  - id: review
    type: agent
    agent:
      prompt: Review.
      model: { provider: test, id: deterministic }
      tools: [read]
      skills: [review]
  - id: unused
    type: agent
    dependsOn: [review]
    agent:
      prompt: Check.
      model: { provider: test, id: deterministic }
      tools: [read]
      skills: [unused]
  - id: publish
    type: result
    dependsOn: [unused]
    result:
      source: { nodeId: unused, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`);
}

function workflowSource(skillLine: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: capability-workflow }
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: test, id: deterministic }
      tools: [read]
      ${skillLine}
  - id: publish
    type: result
    dependsOn: [analyze]
    result:
      source: { nodeId: analyze, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}

function capabilitySnapshot(name: string): CapabilitySnapshot {
  return createCapabilitySnapshot([skill(name)]);
}

function skill(name: string) {
  return {
    kind: "agent-skill" as const,
    name,
    description: `Use ${name} when selected.`,
    metadata: { version: "1" },
    requestedTools: ["Bash"],
    trust: "project-explicit" as const,
    provenance: `.flow/skills/${name}`,
    files: [{ path: "SKILL.md", content: Buffer.from(`# ${name}\n`) }],
  };
}

function agentSuccess(snapshot?: CapabilitySnapshot): NodeExecutionOutcome {
  const text = JSON.stringify("done");
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text,
      textHash: createHash("sha256").update(text).digest("hex"),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [],
      effectReceipts: [],
      ...(snapshot === undefined
        ? {}
        : { capabilities: createAgentCapabilityEvidence(snapshot, ["review"]) }),
    },
  };
}
