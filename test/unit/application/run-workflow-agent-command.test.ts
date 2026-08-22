import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
  RunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import {
  calculateAgentCommandDigest,
  normalizeAgentCommandRequest,
} from "../../../src/domain/agent-command.js";
import {
  type ArtifactProducer,
  createArtifactReference,
  MAX_COMMAND_ARTIFACT_BYTES,
} from "../../../src/domain/artifact/reference.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import {
  type AgentCommandEvidence,
  type RunEvent,
  reduceRunEvents,
} from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import type { CompiledNode } from "../../../src/domain/workflow/types.js";

type WritableCommandEvidence = {
  -readonly [Field in keyof AgentCommandEvidence]: AgentCommandEvidence[Field];
};

describe("agent command workflow execution", () => {
  it("persists command preparation and settlement and charges output exactly once", async () => {
    const workflow = compileWorkflowText(workflowSource());
    const store = new MemoryRunStore();

    const state = await runWorkflow(workflow, {
      runId: "run-agent-command",
      cwd: process.cwd(),
      protectedPaths: [],
      store,
      executor: new JournalUsingExecutor(),
    });

    expect(state.status).toBe("succeeded");
    expect(state.resources.artifactBytes).toBe(10);
    expect(state.nodes.implement).toMatchObject({
      status: "succeeded",
      commandProtocol: "flow.agent-commands/v1",
      commands: [
        {
          commandSequence: 1,
          request: { executable: "npm", args: ["test"], timeoutMs: 10_000 },
          settlement: {
            outcome: {
              status: "succeeded",
              evidence: { stdout: "tool", stderr: "" },
            },
          },
        },
      ],
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_agent_command_prepared",
      "node_agent_command_settled",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
  });

  it("does not execute when durable command preparation cannot be published", async () => {
    const store = new MemoryRunStore("node_agent_command_prepared");
    let executions = 0;

    await expect(
      runWorkflow(compileWorkflowText(workflowSource()), {
        runId: "run-command-prepare-failure",
        cwd: process.cwd(),
        protectedPaths: [],
        store,
        executor: new JournalUsingExecutor(() => {
          executions += 1;
        }),
      }),
    ).rejects.toThrow(/injected.*node_agent_command_prepared/i);

    expect(executions).toBe(0);
    expect(store.events.map((event) => event.type)).toEqual(["run_started", "node_started"]);
  });

  it("leaves a prepared command unresolved when settlement publication fails", async () => {
    const store = new MemoryRunStore("node_agent_command_settled");
    let executions = 0;

    await expect(
      runWorkflow(compileWorkflowText(workflowSource()), {
        runId: "run-command-settle-failure",
        cwd: process.cwd(),
        protectedPaths: [],
        store,
        executor: new JournalUsingExecutor(() => {
          executions += 1;
        }),
      }),
    ).rejects.toThrow(/injected.*node_agent_command_settled/i);

    expect(executions).toBe(1);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_agent_command_prepared",
    ]);
  });

  it("refuses to replay an open agent command during recovery", async () => {
    const workflow = compileWorkflowText(workflowSource());
    const store = new MemoryRunStore("node_agent_command_settled");
    let executions = 0;
    const executor = new JournalUsingExecutor(() => {
      executions += 1;
    });
    await expect(
      runWorkflow(workflow, {
        runId: "run-command-recovery",
        cwd: process.cwd(),
        protectedPaths: [],
        store,
        executor,
      }),
    ).rejects.toThrow(/injected.*node_agent_command_settled/i);
    store.rejectedType = undefined;

    await expect(
      resumeWorkflow(workflow, {
        runId: "run-command-recovery",
        cwd: process.cwd(),
        protectedPaths: [],
        store,
        executor,
      }),
    ).rejects.toMatchObject({ code: "uncertain_operation" });
    expect(executions).toBe(1);
  });

  it.each([
    ["run", (producer: ArtifactProducer) => ({ ...producer, runId: "other-run" })],
    ["workflow", (producer: ArtifactProducer) => ({ ...producer, workflowId: "other-workflow" })],
    ["node", (producer: ArtifactProducer) => ({ ...producer, nodeId: "other-node" })],
    ["attempt", (producer: ArtifactProducer) => ({ ...producer, attempt: 2 })],
    ["command", (producer: ArtifactProducer) => ({ ...producer, commandId: "other-command" })],
    ["sequence", (producer: ArtifactProducer) => ({ ...producer, commandSequence: 2 })],
    ["stream", (producer: ArtifactProducer) => ({ ...producer, stream: "stderr" as const })],
  ])("rejects a redigested artifact with changed %s provenance", async (_field, mutate) => {
    const events = await artifactRunEvents();
    const settled = events.find((event) => event.type === "node_agent_command_settled");
    if (settled?.type !== "node_agent_command_settled" || settled.outcome.evidence === null) {
      throw new Error("artifact fixture has no command settlement");
    }
    const original = settled.outcome.evidence.stdoutArtifact;
    if (original === undefined) throw new Error("artifact fixture has no stdout reference");
    (settled.outcome.evidence as WritableCommandEvidence).stdoutArtifact = createArtifactReference({
      descriptor: original.descriptor,
      producer: mutate(original.producer),
    });

    expect(() => reduceRunEvents(events)).toThrow(
      _field === "stream" ? /stdout artifact is invalid/i : /stdout artifact producer is invalid/i,
    );
  });

  it.each([
    ["digest", { digest: `sha256:${"c".repeat(64)}` }],
    ["size", { size: 4 }],
    ["command size bound", { size: MAX_COMMAND_ARTIFACT_BYTES + 1 }],
    ["media type", { mediaType: "text/plain" }],
  ])("rejects a redigested artifact with changed %s evidence", async (_field, change) => {
    const events = await artifactRunEvents();
    const settled = events.find((event) => event.type === "node_agent_command_settled");
    if (settled?.type !== "node_agent_command_settled" || settled.outcome.evidence === null) {
      throw new Error("artifact fixture has no command settlement");
    }
    const original = settled.outcome.evidence.stdoutArtifact;
    if (original === undefined) throw new Error("artifact fixture has no stdout reference");
    (settled.outcome.evidence as WritableCommandEvidence).stdoutArtifact = createArtifactReference({
      descriptor: { ...original.descriptor, ...change },
      producer: original.producer,
    });

    expect(() => reduceRunEvents(events)).toThrow(/stdout artifact is invalid/i);
  });

  it.each(["identifier", "reference digest"])(
    "rejects an artifact with a substituted %s",
    async (field) => {
      const events = await artifactRunEvents();
      const settled = events.find((event) => event.type === "node_agent_command_settled");
      if (settled?.type !== "node_agent_command_settled" || settled.outcome.evidence === null) {
        throw new Error("artifact fixture has no command settlement");
      }
      const original = settled.outcome.evidence.stdoutArtifact;
      if (original === undefined) throw new Error("artifact fixture has no stdout reference");
      const substituted = structuredClone(original) as WritableArtifactReference;
      if (field === "identifier") {
        substituted.reference = `artifact:${"f".repeat(64)}`;
      } else {
        substituted.referenceDigest = "f".repeat(64);
        substituted.reference = `artifact:${substituted.referenceDigest}`;
      }
      (settled.outcome.evidence as WritableCommandEvidence).stdoutArtifact = substituted;

      expect(() => reduceRunEvents(events)).toThrow(/stdout artifact is invalid/i);
    },
  );
});

type WritableArtifactReference = {
  -readonly [Field in keyof NonNullable<AgentCommandEvidence["stdoutArtifact"]>]: NonNullable<
    AgentCommandEvidence["stdoutArtifact"]
  >[Field];
};

async function artifactRunEvents(): Promise<RunEvent[]> {
  const store = new MemoryRunStore();
  await runWorkflow(compileWorkflowText(workflowSource()), {
    runId: "run-agent-command",
    cwd: process.cwd(),
    protectedPaths: [],
    store,
    executor: new JournalUsingExecutor(),
  });
  const events = structuredClone(store.events);
  const settled = events.find((event) => event.type === "node_agent_command_settled");
  if (settled?.type !== "node_agent_command_settled" || settled.outcome.evidence === null) {
    throw new Error("artifact fixture has no command settlement");
  }
  const fullStdout = "tool retained beyond preview";
  const evidence = settled.outcome.evidence as WritableCommandEvidence;
  evidence.stdoutHash = sha256(fullStdout);
  evidence.stdoutTruncated = true;
  evidence.stdoutArtifact = createArtifactReference({
    descriptor: {
      digest: `sha256:${evidence.stdoutHash}`,
      size: Buffer.byteLength(fullStdout),
      mediaType: "application/octet-stream",
    },
    producer: {
      kind: "agent-command",
      runId: settled.runId,
      workflowId: settled.workflowId,
      nodeId: settled.nodeId,
      attempt: settled.attempt,
      commandId: settled.commandId,
      commandSequence: 1,
      stream: "stdout",
    },
  });
  expect(reduceRunEvents(events).status).toBe("succeeded");
  return events;
}

class JournalUsingExecutor implements NodeExecutor {
  constructor(readonly onCommand?: () => void) {}

  async execute(node: CompiledNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    if (node.type === "agent") {
      const journal = context.agentCommandJournal;
      if (journal === undefined) {
        throw new Error("agent command journal was not injected");
      }
      const request = normalizeAgentCommandRequest({
        executable: "npm",
        args: ["test"],
        timeoutMs: 10_000,
      });
      const operationDigest = calculateAgentCommandDigest(request);
      const broker = new PolicyBroker(
        {
          runId: context.runId,
          workflowId: context.workflowId,
          nodeId: node.id,
          attempt: context.attempt,
        },
        ["process.execute"],
      );
      const decision = broker.authorize({
        action: "process.execute",
        target: request.executable,
        boundary: "inside",
        operationDigest,
      });
      const prepared = await journal.prepare({ request, operationDigest, decision });
      this.onCommand?.();
      await prepared.settle({
        status: "succeeded",
        evidence: commandEvidence("npm", ["test"], "tool"),
      });
      return {
        status: "succeeded",
        evidence: {
          kind: "agent",
          provider: node.agent.model.provider,
          model: node.agent.model.id,
          text: "done",
          textHash: sha256("done"),
          textTruncated: false,
          durationMs: 5,
          policyDecisions: broker.close(),
          effectReceipts: [],
        },
      };
    }
    if (node.type === "command") {
      const {
        processContainment: _processContainment,
        terminationStatus: _terminationStatus,
        ...evidence
      } = commandEvidence("node", ["--version"], "ok");
      return { status: "succeeded", evidence };
    }
    throw new Error(`unexpected node type ${node.type}`);
  }
}

class MemoryRunStore implements RunEventStore, RecoverableRunEventStore {
  readonly events: RunEvent[] = [];

  constructor(public rejectedType?: RunEvent["type"]) {}

  async append(event: RunEvent): Promise<void> {
    if (event.type === this.rejectedType) {
      throw new Error(`injected persistence failure for ${event.type}`);
    }
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return this.events;
  }

  async claim(): Promise<readonly RunEvent[]> {
    return this.events;
  }

  async release(): Promise<void> {}
}

function commandEvidence(
  executable: string,
  args: readonly string[],
  stdout: string,
): AgentCommandEvidence {
  return {
    kind: "command",
    executable,
    args,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: sha256(stdout),
    stderrHash: sha256(""),
    stdoutRetainedHash: sha256(stdout),
    stderrRetainedHash: sha256(""),
    stdoutRetainedBytes: Buffer.byteLength(stdout, "utf8"),
    stderrRetainedBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    durationMs: 5,
    processContainment: "linux-pid-namespace",
    terminationStatus: "not-required",
    sandbox: {
      backend: "test-sandbox",
      backendVersion: "1",
      profile: "workspace-write-network-deny-v1",
      policyDigest: "b".repeat(64),
    },
  };
}

function workflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: agent-command }
budget: { maxArtifactBytes: 100 }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Run tests.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [exec]
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
