import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { NodeExecutorRouter } from "../../../src/application/node-executor-router.js";
import type {
  AgentExecutor,
  CommandExecutor,
  NodeExecutionOutcome,
  RecoverableRunEventStore,
  RunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import {
  type CapabilitySnapshot,
  createCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import type { VerifierPackageSnapshotInput } from "../../../src/domain/capability/verifier-packages.js";
import {
  type AgentEvidence,
  calculateChildRunId,
  type CommandEvidence,
  type RunEvent,
} from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("runWorkflow verifier packages", () => {
  it("rejects an invalid capability snapshot before persistence or execution", async () => {
    const snapshot = commandSnapshot();
    const invalid = { ...snapshot, digest: "0".repeat(64) };
    const command = fakeCommandExecutor();
    const store = new MemoryStore();

    await expect(
      runWorkflow(packagedCommandWorkflow(), {
        cwd: process.cwd(),
        protectedPaths: [],
        runId: "invalid-package-snapshot",
        store,
        executor: new NodeExecutorRouter(command, fakeAgentExecutor()),
        capabilitySnapshot: invalid,
      }),
    ).rejects.toMatchObject({ code: "invalid_snapshot" });

    expect(store.events).toEqual([]);
    expect(command.execute).not.toHaveBeenCalled();
  });

  it("executes the exact selected version from a parent-owned multi-version snapshot", async () => {
    const snapshot = createCapabilitySnapshot(
      [],
      [
        packageInput("release-tests", "0.9.0", {
          kind: "command",
          command: { executable: "node", args: ["--help"], timeoutMs: 30_000 },
        }),
        packageInput("release-tests", "1.0.0", {
          kind: "command",
          command: { executable: "node", args: ["--version"], timeoutMs: 30_000 },
        }),
      ],
    );
    const selected = snapshot.packages.find(
      (item) => item.kind === "verifier-package" && item.version === "1.0.0",
    );
    const command = fakeCommandExecutor(async (node) => {
      expect(node.command.args).toEqual(["--version"]);
      return commandSuccess(node.id, "v22.0.0");
    });
    const store = new MemoryStore();
    const childRunId = calculateChildRunId("parent-run", "delegate", 1);

    const state = await runWorkflow(packagedCommandWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: childRunId,
      store,
      executor: new NodeExecutorRouter(command, fakeAgentExecutor()),
      capabilitySnapshot: snapshot,
      executionWorkspace: {
        backend: "reflink-copy-v1",
        snapshotDigest: "a".repeat(64),
        parentRunId: "parent-run",
        parentNodeId: "delegate",
        parentAttempt: 1,
      },
    });

    expect(state.status).toBe("succeeded");
    expect(state.nodes.release?.evidence).toMatchObject({
      kind: "verifier",
      package: { name: "release-tests", version: "1.0.0", digest: selected?.digest },
    });
  });

  it("binds an immutable model rubric and records exact package use on the verdict", async () => {
    const snapshot = modelSnapshot();
    const command = fakeCommandExecutor(async (node) => commandSuccess(node.id, "verified input"));
    const agent = fakeAgentExecutor(async (node, context) => {
      expect(node.agent.prompt).toContain("Reject unsupported claims.");
      expect(context.verifierSources).toEqual([
        {
          sourceNodeId: "source",
          sourceAttempt: 1,
          sourceField: "command.stdout",
          sourceHash: sha256("verified input"),
          value: "verified input",
          truncated: false,
        },
      ]);
      expect(context).toMatchObject({
        verifierPackage: {
          name: "evidence-review",
          version: "1.2.0",
          digest: snapshot.packages[0]?.digest,
        },
      });
      return agentSuccess('{"verdict":"accepted","reason":"Evidence is sufficient."}');
    });
    const store = new MemoryStore();

    const state = await runWorkflow(packagedModelWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "packaged-model-run",
      store,
      executor: new NodeExecutorRouter(command, agent),
      capabilitySnapshot: snapshot,
    });

    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        review: {
          evidence: {
            kind: "verifier",
            driver: "model",
            verdict: "accepted",
            package: {
              name: "evidence-review",
              version: "1.2.0",
              digest: snapshot.packages[0]?.digest,
            },
          },
        },
      },
    });
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: { digest: snapshot.digest },
      verifierPackageRequirements: [
        {
          nodeId: "review",
          name: "evidence-review",
          version: "1.2.0",
          kind: "model",
        },
      ],
    });
  });

  it("executes a packaged command only through the ordinary command verifier boundary", async () => {
    const snapshot = commandSnapshot();
    const command = fakeCommandExecutor(async (node) => {
      expect(node.command).toEqual({
        executable: "node",
        args: ["--version"],
        timeoutMs: 30_000,
      });
      expect(node).not.toHaveProperty("package");
      return commandSuccess(node.id, "v22.0.0");
    });
    const store = new MemoryStore();

    const state = await runWorkflow(packagedCommandWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "packaged-command-run",
      store,
      executor: new NodeExecutorRouter(command, fakeAgentExecutor()),
      capabilitySnapshot: snapshot,
    });

    expect(command.execute).toHaveBeenCalledOnce();
    expect(state.nodes.release?.evidence).toMatchObject({
      kind: "verifier",
      driver: "command",
      verdict: "accepted",
      package: {
        name: "release-tests",
        version: "1.0.0",
        digest: snapshot.packages[0]?.digest,
      },
    });
  });

  it("resumes from the durable verifier package snapshot and rejects a caller replacement", async () => {
    const snapshot = commandSnapshot();
    const interrupted = new MemoryStore("node_started");

    await expect(
      runWorkflow(packagedCommandWorkflow(), {
        cwd: process.cwd(),
        protectedPaths: [],
        runId: "packaged-command-recovery",
        store: interrupted,
        executor: new NodeExecutorRouter(fakeCommandExecutor(), fakeAgentExecutor()),
        capabilitySnapshot: snapshot,
      }),
    ).rejects.toThrow("injected persistence failure");
    expect(interrupted.events).toHaveLength(1);

    const replacement = createCapabilitySnapshot(
      [],
      [
        packageInput("release-tests", "1.0.0", {
          kind: "command",
          command: { executable: "node", args: ["--help"], timeoutMs: 30_000 },
        }),
      ],
    );
    await expect(
      resumeWorkflow(packagedCommandWorkflow(), {
        cwd: process.cwd(),
        protectedPaths: [],
        runId: "packaged-command-recovery",
        store: new MemoryStore(undefined, interrupted.events),
        executor: new NodeExecutorRouter(fakeCommandExecutor(), fakeAgentExecutor()),
        capabilitySnapshot: replacement,
      }),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });

    const command = fakeCommandExecutor(async (node, context) => {
      expect(node.command.args).toEqual(["--version"]);
      expect(context.verifierPackage).toEqual({
        name: "release-tests",
        version: "1.0.0",
        digest: snapshot.packages[0]?.digest,
      });
      return commandSuccess(node.id, "v22.0.0");
    });
    const recovered = new MemoryStore(undefined, interrupted.events);
    const state = await resumeWorkflow(packagedCommandWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "packaged-command-recovery",
      store: recovered,
      executor: new NodeExecutorRouter(command, fakeAgentExecutor()),
    });

    expect(command.execute).toHaveBeenCalledOnce();
    expect(state.nodes.release?.evidence).toMatchObject({
      kind: "verifier",
      package: {
        name: "release-tests",
        version: "1.0.0",
        digest: snapshot.packages[0]?.digest,
      },
    });
  });
});

class MemoryStore implements RunEventStore, RecoverableRunEventStore {
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
    return await this.read();
  }

  async exists(): Promise<boolean> {
    return this.events.length > 0;
  }

  async release(): Promise<void> {}
}

function fakeCommandExecutor(
  implementation: CommandExecutor["execute"] = async () => {
    throw new Error("unexpected command verifier invocation");
  },
): CommandExecutor & { execute: ReturnType<typeof vi.fn<CommandExecutor["execute"]>> } {
  return { execute: vi.fn(implementation) };
}

function fakeAgentExecutor(
  implementation: AgentExecutor["execute"] = async () => {
    throw new Error("unexpected model verifier invocation");
  },
): AgentExecutor & { execute: ReturnType<typeof vi.fn<AgentExecutor["execute"]>> } {
  return { execute: vi.fn(implementation) };
}

function commandSuccess(id: string, stdout: string): NodeExecutionOutcome {
  return { status: "succeeded", evidence: commandEvidence(id, stdout) };
}

function commandEvidence(id: string, stdout: string): CommandEvidence {
  return {
    kind: "command",
    executable: "node",
    args: id === "release" ? ["--version"] : [],
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
}

function agentSuccess(text: string): NodeExecutionOutcome {
  const evidence: AgentEvidence = {
    kind: "agent",
    provider: "test",
    model: "deterministic",
    text,
    textHash: sha256(text),
    textTruncated: false,
    durationMs: 1,
    policyDecisions: [],
    effectReceipts: [],
  };
  return { status: "succeeded", evidence };
}

function modelSnapshot(): CapabilitySnapshot {
  return createCapabilitySnapshot(
    [],
    [
      packageInput("evidence-review", "1.2.0", {
        kind: "model",
        prompt: "Reject unsupported claims.",
      }),
    ],
  );
}

function commandSnapshot(): CapabilitySnapshot {
  return createCapabilitySnapshot(
    [],
    [
      packageInput("release-tests", "1.0.0", {
        kind: "command",
        command: { executable: "node", args: ["--version"], timeoutMs: 30_000 },
      }),
    ],
  );
}

function packageInput(
  name: string,
  version: string,
  definition: VerifierPackageSnapshotInput["definition"],
): VerifierPackageSnapshotInput {
  const spec =
    definition.kind === "model"
      ? `kind: model\n  prompt: ${definition.prompt}`
      : `kind: command\n  command: { executable: ${definition.command.executable}, args: [${definition.command.args.join(", ")}], timeoutMs: ${definition.command.timeoutMs} }`;
  return {
    kind: "verifier-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name,
    version,
    description: `Reusable ${name} verifier.`,
    trust: "project-explicit",
    provenance: `.flow/verifiers/${name}`,
    definition,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: ${name}, version: ${version}, description: Reusable ${name} verifier. }
spec:
  ${spec}
`),
    },
  };
}

function packagedModelWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: packaged-model }
nodes:
  - id: source
    type: command
    command: { executable: node }
  - id: review
    type: verifier
    dependsOn: [source]
    verifier:
      kind: packaged-model
      package: { name: evidence-review, version: 1.2.0 }
      evidence: [{ nodeId: source, field: command.stdout }]
      model: { provider: test, id: deterministic }
`);
}

function packagedCommandWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: packaged-command }
nodes:
  - id: release
    type: verifier
    verifier:
      kind: packaged-command
      package: { name: release-tests, version: 1.0.0 }
`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
