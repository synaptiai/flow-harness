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
import { VERIFIER_SYSTEM_PROMPT } from "../../../src/application/verifier-executor.js";
import type { AgentEvidence, CommandEvidence, RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("runWorkflow verifier nodes", () => {
  it("executes a command verifier through the router and releases its dependent", async () => {
    const command = fakeCommandExecutor(async (node) => commandSuccess(node.id, "ok"));
    const state = await runWorkflow(commandVerifierWorkflow(), {
      ...options(new MemoryRunStore(), new NodeExecutorRouter(command, fakeAgentExecutor())),
      runId: "run-command-verifier",
    });

    expect(command.execute).toHaveBeenCalledTimes(2);
    expect(command.execute.mock.calls.map(([node]) => node.id)).toEqual(["verify", "finish"]);
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: { verify: { evidence: { kind: "verifier", verdict: "accepted" } } },
    });
  });

  it("records a thrown verifier adapter as inconclusive without corrupting the ledger", async () => {
    const command = fakeCommandExecutor(async () => {
      throw new Error("adapter crashed after invocation");
    });

    const state = await runWorkflow(terminalCommandVerifierWorkflow(), {
      ...options(new MemoryRunStore(), new NodeExecutorRouter(command, fakeAgentExecutor())),
      runId: "run-verifier-adapter-error",
    });

    expect(state).toMatchObject({
      status: "failed",
      nodes: {
        verify: {
          error: {
            code: "verifier_inconclusive",
            sideEffectStatus: "uncertain",
          },
          evidence: null,
        },
      },
    });
  });

  it("binds exact durable sources into a zero-tool model verifier and accepts its goal", async () => {
    const command = fakeCommandExecutor(async (node) =>
      commandSuccess(node.id, node.id === "source" ? "verified input" : "done"),
    );
    const agent = fakeAgentExecutor(async (node, context) => {
      expect(node.agent.tools).toEqual([]);
      expect(node.agent.prompt).toContain('"value":"verified input"');
      expect(context.agentSystemPrompt).toBe(VERIFIER_SYSTEM_PROMPT);
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
      return agentSuccess(verdict("accepted", "The evidence proves the criterion."));
    });

    const state = await runWorkflow(modelVerifierWorkflow(), {
      ...options(new MemoryRunStore(), new NodeExecutorRouter(command, agent)),
      runId: "run-model-verifier",
    });

    expect(agent.execute).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      status: "succeeded",
      goal: { status: "accepted", criteria: { reviewed: { status: "accepted" } } },
      nodes: { review: { evidence: { driver: "model", verdict: "accepted" } } },
    });
  });

  it("fresh-retries strict-invalid model output and retains both verifier attempts", async () => {
    const command = fakeCommandExecutor(async (node) => commandSuccess(node.id, "verified input"));
    let calls = 0;
    const malformed = '{"verdict":"accepted","reason":"proven","extra":null}';
    const agent = fakeAgentExecutor(async () => {
      calls += 1;
      return agentSuccess(
        calls === 1 ? malformed : verdict("accepted", "The evidence proves the criterion."),
      );
    });

    const state = await runWorkflow(modelVerifierWorkflow(true), {
      ...options(new MemoryRunStore(), new NodeExecutorRouter(command, agent)),
      runId: "run-model-verifier-retry",
    });

    expect(agent.execute).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 3, modelTokens: 10, modelCostUsdMicros: 10 },
      nodes: {
        review: {
          status: "succeeded",
          attempt: 2,
          failedAttempts: [
            {
              attempt: 1,
              error: { code: "verifier_inconclusive", retryable: true },
              evidence: { result: "invalid_output", raw: malformed },
            },
          ],
          evidence: { result: "parsed", verdict: "accepted" },
        },
      },
    });
  });

  it("fails closed after the declared model-verifier attempt ceiling", async () => {
    const command = fakeCommandExecutor(async (node) => commandSuccess(node.id, "verified input"));
    const malformed = '{"verdict":"accepted","reason":"proven","extra":null}';
    const agent = fakeAgentExecutor(async () => agentSuccess(malformed));

    const state = await runWorkflow(modelVerifierWorkflow(true), {
      ...options(new MemoryRunStore(), new NodeExecutorRouter(command, agent)),
      runId: "run-model-verifier-retry-exhausted",
    });

    expect(agent.execute).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "review",
      goal: { status: "not_accepted", criteria: { reviewed: { status: "inconclusive" } } },
      nodes: {
        review: {
          status: "failed",
          attempt: 2,
          error: { code: "verifier_inconclusive", retryable: false },
          failedAttempts: [{ attempt: 1, error: { retryable: true } }],
        },
      },
    });
  });

  it("does not treat model-verifier output recovery as authority to repeat an open attempt", async () => {
    const workflow = modelVerifierWorkflow(true);
    const completeStore = new MemoryRunStore();
    const initialAgent = fakeAgentExecutor(async () =>
      agentSuccess(verdict("accepted", "The evidence proves the criterion.")),
    );
    await runWorkflow(workflow, {
      ...options(
        completeStore,
        new NodeExecutorRouter(
          fakeCommandExecutor(async (node) => commandSuccess(node.id, "verified input")),
          initialAgent,
        ),
      ),
      runId: "run-open-model-verifier",
    });
    const reviewStartIndex = completeStore.events.findIndex(
      (event) => event.type === "node_started" && event.nodeId === "review",
    );
    if (reviewStartIndex < 0) throw new Error("fixture has no model-verifier start");
    const openStore = new MemoryRecoverableRunStore(
      completeStore.events.slice(0, reviewStartIndex + 1),
    );
    const resumedAgent = fakeAgentExecutor();

    await expect(
      resumeWorkflow(workflow, {
        ...resumeOptions(openStore, new NodeExecutorRouter(fakeCommandExecutor(), resumedAgent)),
        runId: "run-open-model-verifier",
      }),
    ).rejects.toMatchObject({ code: "uncertain_operation" });
    expect(resumedAgent.execute).not.toHaveBeenCalled();
    expect(openStore.events.some((event) => event.type === "node_attempt_interrupted")).toBe(false);
  });

  it("fails the run and goal on a rejected model verdict", async () => {
    const command = fakeCommandExecutor(async (node) => commandSuccess(node.id, "unproven"));
    const agent = fakeAgentExecutor(async () =>
      agentSuccess(verdict("rejected", "The evidence does not prove the criterion.")),
    );

    const state = await runWorkflow(modelVerifierWorkflow(), {
      ...options(new MemoryRunStore(), new NodeExecutorRouter(command, agent)),
      runId: "run-model-rejected",
    });

    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "review",
      goal: { status: "not_accepted", criteria: { reviewed: { status: "rejected" } } },
      nodes: {
        review: {
          error: { code: "verifier_rejected", sideEffectStatus: "none" },
          evidence: { result: "parsed", verdict: "rejected" },
        },
      },
    });
  });

  it("refuses truncated evidence before model invocation", async () => {
    const command = fakeCommandExecutor(async (node) => ({
      status: "succeeded",
      evidence: { ...commandEvidence(node.id, "partial"), stdoutTruncated: true },
    }));
    const agent = fakeAgentExecutor();

    const state = await runWorkflow(modelVerifierWorkflow(), {
      ...options(new MemoryRunStore(), new NodeExecutorRouter(command, agent)),
      runId: "run-model-truncated",
    });

    expect(agent.execute).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      status: "failed",
      nodes: {
        review: {
          error: { code: "verifier_inconclusive", sideEffectStatus: "none" },
          evidence: { result: "execution_failed", verdict: "inconclusive" },
        },
      },
    });
  });

  it("enforces the aggregate verifier input ceiling before model invocation", async () => {
    const command = fakeCommandExecutor(async (node) =>
      commandSuccess(node.id, "x".repeat(32_768)),
    );
    const agent = fakeAgentExecutor();

    const state = await runWorkflow(oversizedModelInputWorkflow(), {
      ...options(new MemoryRunStore(), new NodeExecutorRouter(command, agent)),
      runId: "run-model-input-limit",
    });

    expect(agent.execute).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "review",
      nodes: { review: { error: { code: "verifier_inconclusive" } } },
    });
  });

  it("routes and terminates a bounded loop through accepted verifier fields", async () => {
    const command = fakeCommandExecutor(async (node) => commandSuccess(node.id, "ok"));

    const state = await runWorkflow(verifierControlWorkflow(), {
      ...options(new MemoryRunStore(), new NodeExecutorRouter(command, fakeAgentExecutor())),
      runId: "run-verifier-control",
    });

    expect(command.execute.mock.calls.map(([node]) => node.id)).toEqual([
      "verify",
      "accepted-path",
      "convergence--i1--node--loop-verify",
      "finish",
    ]);
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "unexpected-path": { status: "omitted" },
        "convergence--i2--node--loop-verify": { status: "omitted" },
      },
    });
  });

  it("binds accepted verifier reasoning into a durable approval request", async () => {
    const store = new MemoryRunStore();
    const command = fakeCommandExecutor(async (node) => commandSuccess(node.id, "ok"));

    const state = await runWorkflow(verifierApprovalWorkflow(), {
      ...options(store, new NodeExecutorRouter(command, fakeAgentExecutor())),
      runId: "run-verifier-approval",
    });

    expect(state.status).toBe("waiting_for_approval");
    expect(store.events.at(-1)).toMatchObject({
      type: "workflow_approval_requested",
      request: {
        evidence: [
          {
            sourceNodeId: "verify",
            sourceAttempt: 1,
            sourceField: "verifier.reason",
            sourceHash: sha256("command exited with code 0"),
          },
        ],
      },
    });
  });

  it("bounds a model verifier timeout by the remaining execution budget", async () => {
    const command = fakeCommandExecutor(async (node) => commandSuccess(node.id, "verified input"));
    const agent = fakeAgentExecutor(async (node) => {
      expect(node.agent.timeoutMs).toBe(100);
      return agentSuccess(verdict("accepted", "Accepted within the remaining budget."));
    });

    await runWorkflow(budgetedModelVerifierWorkflow(), {
      ...options(new MemoryRunStore(), new NodeExecutorRouter(command, agent)),
      runId: "run-model-budget",
    });

    expect(agent.execute).toHaveBeenCalledOnce();
  });

  it("does not re-invoke committed verifier work and refuses an open verifier attempt", async () => {
    const workflow = terminalCommandVerifierWorkflow();
    const initialStore = new MemoryRunStore();
    const initialCommand = fakeCommandExecutor(async (node) => commandSuccess(node.id, "ok"));
    await runWorkflow(workflow, {
      ...options(initialStore, new NodeExecutorRouter(initialCommand, fakeAgentExecutor())),
      runId: "run-verifier-recovery",
    });

    const resumedCommand = fakeCommandExecutor(async (node) => commandSuccess(node.id, "ok"));
    await expect(
      resumeWorkflow(workflow, {
        ...resumeOptions(
          new MemoryRecoverableRunStore(initialStore.events),
          new NodeExecutorRouter(resumedCommand, fakeAgentExecutor()),
        ),
        runId: "run-verifier-recovery",
      }),
    ).rejects.toThrow(/already terminal/i);
    expect(resumedCommand.execute).not.toHaveBeenCalled();

    const openStore = new MemoryRecoverableRunStore(initialStore.events.slice(0, 2));
    await expect(
      resumeWorkflow(workflow, {
        ...resumeOptions(openStore, new NodeExecutorRouter(resumedCommand, fakeAgentExecutor())),
        runId: "run-verifier-recovery",
      }),
    ).rejects.toThrow(/no committed outcome/i);
    expect(resumedCommand.execute).not.toHaveBeenCalled();
  });

  it("lets cancellation override a late accepted verifier result", async () => {
    const controller = new AbortController();
    const command = fakeCommandExecutor(async (node) => commandSuccess(node.id, "verified input"));
    const agent = fakeAgentExecutor(async () => {
      controller.abort(new Error("operator cancelled"));
      return agentSuccess(verdict("accepted", "Late acceptance must not advance the graph."));
    });

    const state = await runWorkflow(modelVerifierWorkflow(), {
      ...options(new MemoryRunStore(), new NodeExecutorRouter(command, agent)),
      runId: "run-model-cancelled",
      signal: controller.signal,
    });

    expect(state.status).toBe("cancelled");
    expect(state.goal?.status).toBe("not_accepted");
  });
});

class MemoryRunStore implements RunEventStore {
  readonly events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(runId: string): Promise<readonly RunEvent[]> {
    return this.events
      .filter((event) => event.runId === runId)
      .map((event) => structuredClone(event));
  }
}

class MemoryRecoverableRunStore extends MemoryRunStore implements RecoverableRunEventStore {
  constructor(events: readonly RunEvent[]) {
    super();
    this.events.push(...structuredClone(events));
  }

  async claim(runId: string): Promise<readonly RunEvent[]> {
    return await this.read(runId);
  }

  async release(): Promise<void> {}
}

function fakeCommandExecutor(
  implementation: CommandExecutor["execute"] = async (node) => commandSuccess(node.id, "ok"),
): CommandExecutor & { execute: ReturnType<typeof vi.fn<CommandExecutor["execute"]>> } {
  return { execute: vi.fn<CommandExecutor["execute"]>(implementation) };
}

function fakeAgentExecutor(
  implementation: AgentExecutor["execute"] = async () =>
    agentSuccess(verdict("accepted", "Accepted.")),
): AgentExecutor & { execute: ReturnType<typeof vi.fn<AgentExecutor["execute"]>> } {
  return { execute: vi.fn<AgentExecutor["execute"]>(implementation) };
}

function options(store: RunEventStore, executor: NodeExecutorRouter) {
  return {
    cwd: process.cwd(),
    protectedPaths: [] as readonly string[],
    store,
    executor,
    now: () => new Date("2026-08-07T20:00:00.000Z"),
  };
}

function resumeOptions(store: RecoverableRunEventStore, executor: NodeExecutorRouter) {
  return {
    cwd: process.cwd(),
    protectedPaths: [] as readonly string[],
    store,
    executor,
    now: () => new Date("2026-08-07T20:00:00.000Z"),
  };
}

function commandSuccess(nodeId: string, stdout: string): NodeExecutionOutcome {
  return { status: "succeeded", evidence: commandEvidence(nodeId, stdout) };
}

function commandEvidence(nodeId: string, stdout: string): CommandEvidence {
  return {
    kind: "command",
    executable: nodeId === "finish" ? "node" : nodeId.startsWith("verify") ? "npm" : "node",
    args: nodeId === "finish" ? [] : nodeId.startsWith("verify") ? ["test"] : [],
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

function agentSuccess(raw: string): NodeExecutionOutcome {
  const evidence: AgentEvidence = {
    kind: "agent",
    provider: "test",
    model: "deterministic",
    text: raw,
    textHash: sha256(raw),
    textTruncated: false,
    durationMs: 2,
    usage: {
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdMicros: 5,
    },
    policyDecisions: [],
    effectReceipts: [],
  };
  return { status: "succeeded", evidence };
}

function verdict(value: "accepted" | "rejected" | "inconclusive", reason: string): string {
  return JSON.stringify({ verdict: value, reason });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandVerifierWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: command-verifier }
nodes:
  - id: verify
    type: verifier
    verifier:
      kind: command
      command: { executable: npm, args: [test] }
  - id: finish
    type: command
    dependsOn: [verify]
    command: { executable: node }
`);
}

function terminalCommandVerifierWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: terminal-command-verifier }
nodes:
  - id: verify
    type: verifier
    verifier:
      kind: command
      command: { executable: npm, args: [test] }
`);
}

function modelVerifierWorkflow(recovery = false) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: model-verifier }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: reviewed-change }
  outcome: The declared evidence is accepted.
  criteria:
    - id: reviewed
      description: The model verifier accepts the evidence.
      verifier: { nodeId: review }
nodes:
  - id: source
    type: command
    command: { executable: node }
  - id: review
    type: verifier
    dependsOn: [source]
    verifier:
      kind: model
      prompt: Decide whether the evidence proves the criterion.
      evidence: [{ nodeId: source, field: command.stdout }]
      model: { provider: test, id: deterministic }
      ${recovery ? "recovery: { mode: fresh, maxAttempts: 2 }" : ""}
`);
}

function budgetedModelVerifierWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: budgeted-model-verifier }
budget: { maxExecutionMs: 101 }
nodes:
  - id: source
    type: command
    command: { executable: node }
  - id: review
    type: verifier
    dependsOn: [source]
    verifier:
      kind: model
      prompt: Review.
      evidence: [{ nodeId: source, field: command.stdout }]
      model: { provider: test, id: deterministic }
      timeoutMs: 1000
`);
}

function oversizedModelInputWorkflow() {
  const sources = Array.from({ length: 9 }, (_, index) => `source-${index + 1}`);
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: oversized-model-input }
nodes:
  - id: root
    type: command
    command: { executable: node }
${sources.map((id) => `  - id: ${id}\n    type: command\n    dependsOn: [root]\n    command: { executable: node }`).join("\n")}
  - id: review
    type: verifier
    dependsOn: [${sources.join(", ")}]
    verifier:
      kind: model
      prompt: Review all evidence.
      evidence:
${sources.map((id) => `        - { nodeId: ${id}, field: command.stdout }`).join("\n")}
      model: { provider: test, id: deterministic }
`);
}

function verifierControlWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: verifier-control }
nodes:
  - id: verify
    type: verifier
    verifier:
      kind: command
      command: { executable: npm, args: [test] }
  - id: route
    type: condition
    dependsOn: [verify]
    condition:
      source: { nodeId: verify, field: verifier.verdict }
      cases: [{ id: accepted, equals: accepted }]
      default: unexpected
  - id: accepted-path
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: accepted }
    command: { executable: node }
  - id: unexpected-path
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: unexpected }
    command: { executable: node }
  - id: joined
    type: join
    join:
      conditionId: route
      branches:
        - { case: accepted, nodeId: accepted-path }
        - { case: unexpected, nodeId: unexpected-path }
  - id: convergence
    type: loop
    dependsOn: [joined]
    loop:
      maxIterations: 2
      until:
        source: { nodeId: loop-verify, field: verifier.verdict }
        equals: accepted
      body:
        nodes:
          - id: loop-verify
            type: verifier
            verifier:
              kind: command
              command: { executable: node }
  - id: finish
    type: command
    dependsOn: [convergence]
    command: { executable: node }
`);
}

function verifierApprovalWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: verifier-approval }
nodes:
  - id: verify
    type: verifier
    verifier:
      kind: command
      command: { executable: npm, args: [test] }
  - id: approve
    type: approval
    dependsOn: [verify]
    approval:
      prompt: Confirm the verifier result.
      evidence: [{ nodeId: verify, field: verifier.reason }]
  - id: finish
    type: command
    dependsOn: [approve]
    command: { executable: node }
`);
}
