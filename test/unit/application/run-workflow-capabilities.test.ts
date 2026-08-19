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
  agentSkillActivationWorkflow,
  createAgentSkillActivationSnapshot,
} from "../../../src/domain/adaptation/agent-skill-activation.js";
import { createEffectiveHarnessRuntimeSnapshot } from "../../../src/domain/adaptation/effective-harness-runtime.js";
import {
  createEffectiveHarnessHeadIdentity,
  effectiveHarnessWorkflowSource,
} from "../../../src/domain/adaptation/effective-harness-state.js";
import {
  type CapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  combineCapabilitySnapshots,
  createAgentCapabilityEvidence,
  createCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import type { PolicyPackageSnapshotInput } from "../../../src/domain/capability/policy-packages.js";
import type { ToolPackageSnapshotInput } from "../../../src/domain/capability/tool-packages.js";
import { calculateChildRunId, type RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { agentSkillActivationInput } from "../../fixtures/agent-skill-activation.js";
import {
  effectiveHarnessCandidateArtifactFixture,
  modelRoutingEffectiveHarnessCandidateArtifactFixture,
} from "../../fixtures/effective-harness-evaluation.js";

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

    expect(observed).toEqual(snapshot);
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
    const childRunId = calculateChildRunId("parent-run", "delegate", 1);

    const state = await runWorkflow(skilledWorkflow(), {
      ...options(
        store,
        executorFrom((_node, context) => agentSuccess(context.capabilitySnapshot)),
      ),
      runId: childRunId,
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

  it("persists one Agent Skill activation and package in an isolated child ledger", async () => {
    const activation = createAgentSkillActivationSnapshot(agentSkillActivationInput());
    const packages = [activation.skill];
    const activations = [activation];
    const snapshot = validateCapabilitySnapshot({
      version: 1,
      packages,
      activations,
      digest: calculateCapabilitySnapshotDigest(packages, activations),
    });
    const store = new MemoryStore();
    const childRunId = calculateChildRunId("parent-skill-run", "delegate", 1);

    const state = await runWorkflow(
      compileWorkflowText(
        agentSkillActivationWorkflow(activation),
        "activation:adaptive-skill-workflow",
      ),
      {
        ...options(
          store,
          executorFrom((_node, context) => agentSuccess(context.capabilitySnapshot)),
        ),
        runId: childRunId,
        capabilitySnapshot: snapshot,
        executionWorkspace: {
          backend: "reflink-copy-v1",
          snapshotDigest: "b".repeat(64),
          parentRunId: "parent-skill-run",
          parentNodeId: "delegate",
          parentAttempt: 1,
        },
      },
    );

    expect(store.events[0]).toMatchObject({
      type: "run_started",
      executionWorkspace: { parentRunId: "parent-skill-run" },
      capabilitySnapshot: {
        packages: [{ digest: activation.skill.digest }],
        activations: [{ activationDigest: activation.activationDigest }],
      },
    });
    expect(state).toMatchObject({
      status: "succeeded",
      capabilitySnapshot: { digest: snapshot.digest },
    });
  });

  it("persists one complete effective harness in an isolated child ledger", async () => {
    const snapshot = effectiveHarnessCapabilitySnapshot();
    const effectiveHarness = snapshot.effectiveHarness;
    if (effectiveHarness === undefined) throw new Error("effective harness fixture is missing");
    const store = new MemoryStore();
    const childRunId = calculateChildRunId("parent-effective-run", "delegate", 1);
    const workflow = compileWorkflowText(
      Buffer.from(effectiveHarness.workflow.contentBase64, "base64").toString("utf8"),
      `activation:${effectiveHarness.workflowId}`,
    );

    const state = await runWorkflow(workflow, {
      ...options(
        store,
        executorFrom((node, context) => {
          if (node.type !== "agent" || context.capabilitySnapshot === undefined) {
            throw new Error("effective child fixture executed an unexpected node");
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
              ...(node.agent.skills.length === 0
                ? {}
                : {
                    capabilities: createAgentCapabilityEvidence(
                      context.capabilitySnapshot,
                      node.agent.skills,
                    ),
                  }),
            },
          };
        }),
      ),
      runId: childRunId,
      capabilitySnapshot: snapshot,
      executionWorkspace: {
        backend: "reflink-copy-v1",
        snapshotDigest: "c".repeat(64),
        parentRunId: "parent-effective-run",
        parentNodeId: "delegate",
        parentAttempt: 1,
      },
    });

    expect(store.events[0]).toMatchObject({
      type: "run_started",
      executionWorkspace: { parentRunId: "parent-effective-run" },
      capabilitySnapshot: {
        effectiveHarness: {
          runtimeDigest: effectiveHarness.runtimeDigest,
          head: { headDigest: effectiveHarness.head.headDigest },
        },
      },
    });
    expect(state).toMatchObject({
      status: "succeeded",
      capabilitySnapshot: { digest: snapshot.digest },
    });
  });

  it("executes and resumes the selected route from one durable effective snapshot", async () => {
    const artifact = modelRoutingEffectiveHarnessCandidateArtifactFixture();
    const snapshot = effectiveHarnessCapabilitySnapshot(artifact);
    const effectiveHarness = snapshot.effectiveHarness;
    if (effectiveHarness === undefined) throw new Error("routing harness fixture is missing");
    const workflow = compileWorkflowText(
      Buffer.from(effectiveHarness.workflow.contentBase64, "base64").toString("utf8"),
      `activation:${effectiveHarness.workflowId}`,
    );
    const interrupted = new MemoryStore("node_started");

    await expect(
      runWorkflow(workflow, {
        ...options(
          interrupted,
          executorFrom(() => agentSuccess()),
        ),
        runId: "resume-model-route",
        capabilitySnapshot: snapshot,
      }),
    ).rejects.toThrow("injected persistence failure");
    expect(interrupted.events).toHaveLength(1);

    const recovered = new MemoryStore(undefined, interrupted.events);
    const observed = new Map<string, { provider: string; id: string; thinking: string }>();
    const state = await resumeWorkflow(workflow, {
      ...options(
        recovered,
        executorFrom((node, context) => {
          if (node.type !== "agent") throw new Error("routing fixture executed a non-agent node");
          observed.set(node.id, node.agent.model);
          expect(context.capabilitySnapshot?.effectiveHarness?.runtimeDigest).toBe(
            effectiveHarness.runtimeDigest,
          );
          const text = JSON.stringify("done");
          return {
            status: "succeeded",
            evidence: {
              kind: "agent",
              provider: node.agent.model.provider,
              model: node.agent.model.id,
              text,
              textHash: createHash("sha256").update(text).digest("hex"),
              textTruncated: false,
              durationMs: 1,
              policyDecisions: [],
              effectReceipts: [],
            },
          };
        }),
      ),
      runId: "resume-model-route",
    });

    expect(observed.get("implement")).toEqual({
      provider: "openai",
      id: "gpt-5.4",
      thinking: "high",
    });
    expect(observed.get("private-review")).toEqual({
      provider: "test",
      id: "deterministic",
      thinking: "medium",
    });
    expect(state).toMatchObject({
      status: "succeeded",
      capabilitySnapshot: { digest: snapshot.digest },
    });
  });

  it("applies current policy after loading a historical effective state", async () => {
    const snapshot = effectiveHarnessCapabilitySnapshot();
    const policy = createCapabilitySnapshot([], [], [], [], [currentPolicyInput()]);
    const combined = combineCapabilitySnapshots([snapshot, policy]);
    if (combined === undefined) throw new Error("combined capability fixture is missing");
    const effectiveHarness = combined.effectiveHarness;
    if (effectiveHarness === undefined) throw new Error("effective harness fixture is missing");
    const store = new MemoryStore();
    const workflow = compileWorkflowText(
      effectiveHarnessWorkflowSource(effectiveHarnessCandidateArtifactFixture().candidateState),
      `activation:${effectiveHarness.workflowId}`,
    );

    await expect(
      runWorkflow(workflow, {
        ...options(
          store,
          executorFrom(() => agentSuccess()),
        ),
        runId: "effective-current-policy",
        capabilitySnapshot: combined,
      }),
    ).rejects.toMatchObject({ code: "policy_violation" });
    expect(store.events).toEqual([]);
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

  it("resumes a selected tool package from the durable snapshot alone", async () => {
    const interruptedStore = new MemoryStore("node_started");
    const snapshot = createCapabilitySnapshot([], [], [toolPackage("project-report", "1.2.3")]);
    const workflow = toolPackageWorkflow();
    await expect(
      runWorkflow(workflow, {
        ...options(
          interruptedStore,
          executorFrom(() => agentSuccess()),
        ),
        runId: "resume-tool-package-run",
        capabilitySnapshot: snapshot,
      }),
    ).rejects.toThrow("injected persistence failure");
    expect(interruptedStore.events).toHaveLength(1);

    const recoveredStore = new MemoryStore(undefined, interruptedStore.events);
    let observedDigest: string | undefined;
    const state = await resumeWorkflow(workflow, {
      ...options(
        recoveredStore,
        executorFrom((_node, context) => {
          observedDigest = context.capabilitySnapshot?.packages.find(
            (item) => item.kind === "tool-package",
          )?.digest;
          return agentSuccess();
        }),
      ),
      runId: "resume-tool-package-run",
    });

    expect(observedDigest).toBe(snapshot.packages[0]?.digest);
    expect(state).toMatchObject({
      status: "succeeded",
      capabilitySnapshot: { digest: snapshot.digest },
      toolPackageRequirements: {
        analyze: {
          rawExec: false,
          packages: [{ name: "project-report", version: "1.2.3" }],
        },
      },
    });
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

function toolPackageWorkflow() {
  return compileWorkflowText(`apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: tool-package-recovery }
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: test, id: deterministic }
      tools: [read]
      toolPackages:
        - { name: project-report, version: 1.2.3 }
  - id: publish
    type: result
    dependsOn: [analyze]
    result:
      source: { nodeId: analyze, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`);
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

function effectiveHarnessCapabilitySnapshot(
  artifact = effectiveHarnessCandidateArtifactFixture(),
): CapabilitySnapshot {
  const head = createEffectiveHarnessHeadIdentity({
    scopeDigest: artifact.scopeDigest,
    workflowId: artifact.workflowId,
    generation: artifact.baselineHead.generation + 1,
    activationDigest: artifact.artifactDigest,
    transitionDigest: "d".repeat(64),
    stateDigest: artifact.candidateState.stateDigest,
  });
  const effectiveHarness = createEffectiveHarnessRuntimeSnapshot({
    state: artifact.candidateState,
    head,
  });
  return validateCapabilitySnapshot({
    version: 1,
    packages: artifact.candidateState.packages,
    effectiveHarness,
    digest: calculateCapabilitySnapshotDigest(
      artifact.candidateState.packages,
      [],
      effectiveHarness,
    ),
  });
}

function currentPolicyInput(): PolicyPackageSnapshotInput {
  return {
    kind: "policy-package",
    trust: "project-explicit",
    provenance: ".flow/policies/current-effective-policy",
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: current-effective-policy
  version: 1.0.0
  description: Current policy rejects editing.
spec:
  tools: { allowed: [read] }
`),
    },
  };
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

function toolPackage(name: string, version: string): ToolPackageSnapshotInput {
  return {
    kind: "tool-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name,
    version,
    description: `Reusable ${name} tool.`,
    trust: "project-explicit",
    provenance: `.flow/tools/${name}`,
    definition: {
      tool: {
        name: "create_project_report",
        description: "Print a selected report subject.",
        inputs: [{ name: "subject", description: "Report subject.", type: "string" }],
      },
      driver: {
        kind: "command",
        version: "v1",
        profile: "posix-printf-v1",
        executable: "/usr/bin/printf",
        args: ["%s", "{input:subject}"],
        timeoutMs: 10_000,
      },
      permissions: ["process.execute"],
    },
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata: { name: ${name}, version: ${version}, description: Reusable ${name} tool. }
spec:
  tool:
    name: create_project_report
    description: Print a selected report subject.
    inputs:
      - { name: subject, description: Report subject., type: string }
  driver:
    kind: command
    version: v1
    profile: posix-printf-v1
    executable: /usr/bin/printf
    args: ["%s", "{input:subject}"]
    timeoutMs: 10000
  permissions: [process.execute]
`),
    },
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
