import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  ModelSessionStore,
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import { parseRunEvent, type RunEvent } from "../../../src/domain/run/events.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import {
  calculatePortableHistoryIdentity,
  createModelSession,
  createModelSessionEvent,
  type ModelSessionEventInput,
  type ModelSessionIdentity,
  type ModelSessionState,
  modelSessionId,
  modelSessionSummary,
  reduceModelSessionEvents,
  selectContextCompactionRange,
  selectRollingContextRange,
} from "../../../src/domain/run/model-session.js";
import { evaluateModelRequestCapacity } from "../../../src/domain/run/model-request-capacity.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("runWorkflow model session coordination", () => {
  it("defaults compaction counters when replaying a pre-compaction run summary", () => {
    const session = createModelSession(
      identity("run-model-session-legacy"),
      "2026-08-22T00:00:00.000Z",
    ).state;
    const event = openAttemptEvents(workflow(), session)[1];
    if (event?.type !== "node_started" || event.modelSession === undefined) {
      throw new Error("legacy fixture requires a model-backed node start");
    }
    const {
      compactionCount: _compactionCount,
      acceptedCompactionCount: _acceptedCompactionCount,
      interruptedCompactionCount: _interruptedCompactionCount,
      activeCompaction: _activeCompaction,
      ...legacySummary
    } = event.modelSession;

    expect(parseRunEvent({ ...event, modelSession: legacySummary })).toMatchObject({
      modelSession: {
        compactionCount: 0,
        acceptedCompactionCount: 0,
        interruptedCompactionCount: 0,
        activeCompaction: null,
      },
    });
  });

  it("creates and seeds a session before publishing a model-backed node start", async () => {
    const operations: string[] = [];
    const store = new MemoryRunStore([], operations);
    const sessions = new MemoryModelSessionStore(operations);
    const executor = recordingExecutor(operations, (context) => {
      if (context.nodeId === "implement") {
        expect(context.modelSession?.state).toMatchObject({
          activeAttempt: 1,
          primaryPromptCommitted: true,
        });
      } else {
        expect(context.modelSession).toBeUndefined();
      }
    });

    const state = await runWorkflow(workflow(), {
      ...runOptions(store, executor, sessions),
      runId: "run-model-session",
    });

    expect(state.status).toBe("succeeded");
    expect(operations).toEqual([
      "run:run_started",
      "session:create",
      "session:attempt_started",
      "session:user_message_committed",
      "run:node_started",
      "executor:implement:1",
      "session:attempt_settled",
      "session:release",
      "run:node_succeeded",
      "run:node_started",
      "executor:verify:1",
      "run:node_succeeded",
      "run:run_succeeded",
      "run:release",
    ]);
    expect(store.events.find((event) => event.type === "node_started")).toMatchObject({
      modelSession: {
        protocol: "flow.model-session/v1",
        sessionId: modelSessionId(identity("run-model-session")),
        eventCount: 3,
        lastAttempt: 1,
      },
    });
    expect(store.events.find((event) => event.type === "node_succeeded")).toMatchObject({
      modelSession: { eventCount: 4, activeAttempt: null },
    });
  });

  it.each([
    ["provider-failed", "pi_agent_error"],
    ["provider-rate-limited", "pi_provider_rate_limited"],
    ["provider-unavailable", "pi_provider_unavailable"],
    ["output-limited", "pi_agent_incomplete"],
  ] as const)(
    "continues a %s edit attempt from its settled model-session ledger",
    async (_case, failureCode) => {
      const operations: string[] = [];
      const store = new MemoryRunStore([], operations);
      const sessions = new MemoryModelSessionStore(operations);
      let agentExecutions = 0;
      const executor: NodeExecutor = {
        async execute(node, context): Promise<NodeExecutionOutcome> {
          operations.push(`executor:${node.id}:${context.attempt}`);
          if (node.type !== "agent") return successfulCommandOutcome(node.id);
          agentExecutions += 1;
          if (agentExecutions > 1) {
            expect(context.modelSession?.state.events).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: "attempt_settled",
                  attempt: 1,
                  outcome: "failed",
                }),
                expect.objectContaining({
                  type: "tool_result_committed",
                  toolCallId: "call-edit-1",
                  isError: false,
                }),
                expect.objectContaining({ type: "attempt_started", attempt: 2 }),
              ]),
            );
            return successfulAgentOutcome();
          }

          const session = context.modelSession;
          const effectJournal = context.effectJournal;
          if (session === undefined || effectJournal === undefined) {
            throw new Error("test requires durable model-session and effect journals");
          }
          let modelState = await session.read();
          modelState = await session.append({
            type: "model_request_prepared",
            attempt: 1,
            turn: 1,
            request: 1,
            identity: requestIdentity(modelState, 1, 1),
          });
          modelState = await session.append({
            type: "model_message_committed",
            attempt: 1,
            turn: 1,
            request: 1,
            text: "I will update the bounded source file.",
            stopReason: "tool_use",
          });
          modelState = await session.append({
            type: "tool_call_committed",
            attempt: 1,
            turn: 1,
            request: 1,
            toolCallId: "call-edit-1",
            toolName: "flow_edit",
            argumentsJson: '{"path":"source.ts"}',
          });
          const prepared = await effectJournal.prepare({
            kind: "filesystem.edit",
            target: resolve(process.cwd(), "source.ts"),
            operationDigest: "a".repeat(64),
            beforeSha256: "b".repeat(64),
            afterSha256: "c".repeat(64),
            mode: 0o644,
          });
          const receipt = await prepared.settle({
            outcome: "committed",
            reason: "directory_synced",
          });
          if (receipt === null) throw new Error("committed effect must return a receipt");
          modelState = await session.append({
            type: "tool_result_committed",
            attempt: 1,
            turn: 1,
            request: 1,
            toolCallId: "call-edit-1",
            toolName: "flow_edit",
            text: "Updated source.ts.",
            isError: false,
          });
          modelState = await session.append({
            type: "model_request_settled",
            attempt: 1,
            turn: 1,
            request: 1,
            outcome: "completed",
          });
          modelState = await session.append({
            type: "model_request_prepared",
            attempt: 1,
            turn: 2,
            request: 2,
            identity: requestIdentity(modelState, 2, 2),
          });
          await session.append({
            type: "model_request_settled",
            attempt: 1,
            turn: 2,
            request: 2,
            outcome: failureCode === "pi_agent_incomplete" ? "output_limited" : "failed",
          });
          const policy = new PolicyBroker(
            {
              runId: context.runId,
              workflowId: context.workflowId,
              nodeId: node.id,
              attempt: context.attempt,
            },
            ["filesystem.write"],
          );
          policy.authorize({
            action: "filesystem.write",
            target: receipt.target,
            boundary: "inside",
            operationDigest: receipt.operationDigest,
          });
          return {
            status: "failed",
            error: {
              code: failureCode,
              message: "agent provider execution failed",
              retryable: true,
              sideEffectStatus: "committed",
            },
            evidence: {
              kind: "agent",
              provider: "test",
              model: "deterministic",
              text: "",
              textHash: sha256(""),
              textTruncated: false,
              durationMs: 5,
              usage: {
                inputTokens: 2,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsdMicros: 7,
              },
              policyDecisions: policy.close(),
              effectReceipts: [receipt],
            },
          };
        },
      };

      const state = await runWorkflow(editWorkflow(), {
        ...runOptions(store, executor, sessions),
        runId: `run-model-${failureCode}-continuation`,
      });

      expect(state).toMatchObject({
        status: "succeeded",
        resources: { nodeStarts: 3, modelTokens: 3, modelCostUsdMicros: 7 },
        nodes: {
          implement: {
            status: "succeeded",
            attempt: 2,
            failedAttempts: [
              {
                attempt: 1,
                error: { code: failureCode, sideEffectStatus: "committed" },
                effects: [{ settlement: { outcome: "committed" } }],
              },
            ],
          },
        },
      });
      expect(operations).toContain("executor:implement:2");
    },
  );

  it("passes the compiled rolling-context policy to the model executor", async () => {
    const operations: string[] = [];
    const store = new MemoryRunStore([], operations);
    const sessions = new MemoryModelSessionStore(operations);
    const executor = recordingExecutor(operations, (context) => {
      if (context.nodeId === "implement") {
        expect(context.contextCompaction).toEqual({
          mode: "rolling",
          pressureThresholdPercent: 85,
          protectedConstraints: ["Keep the acceptance criteria exact."],
        });
      }
    });

    const state = await runWorkflow(rollingWorkflow(), {
      ...runOptions(store, executor, sessions),
      runId: "run-model-session-rolling-policy",
    });

    expect(state.status).toBe("succeeded");
  });

  it("commits the private interruption boundary before the workflow retry disposition", async () => {
    const operations: string[] = [];
    const compiled = workflow();
    const sessions = new MemoryModelSessionStore(operations);
    const openSession = sessions.seedOpen(identity("run-model-recovery"));
    const store = new MemoryRunStore(openAttemptEvents(compiled, openSession), operations);
    const executor = recordingExecutor(operations, (context) => {
      if (context.attempt === 2) {
        expect(context.modelSession?.state.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "attempt_interrupted", attempt: 1 }),
            expect.objectContaining({ type: "attempt_started", attempt: 2 }),
          ]),
        );
      }
    });

    const state = await resumeWorkflow(compiled, {
      ...runOptions(store, executor, sessions),
      runId: "run-model-recovery",
    });

    expect(state.nodes.implement).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(operations.indexOf("session:attempt_interrupted")).toBeLessThan(
      operations.indexOf("session:release"),
    );
    expect(operations.indexOf("session:release")).toBeLessThan(
      operations.indexOf("run:node_attempt_interrupted"),
    );
    expect(operations).toContain("executor:implement:2");
  });

  it("interrupts an unmatched compaction before closing its model attempt", async () => {
    const operations: string[] = [];
    const compiled = workflow();
    const sessions = new MemoryModelSessionStore(operations);
    const openSession = openCompactionSessionState(identity("run-compaction-recovery"));
    sessions.states.set(openSession.sessionId, openSession);
    const store = new MemoryRunStore(openAttemptEvents(compiled, openSession), operations);
    const executor = recordingExecutor(operations, (context) => {
      if (context.attempt !== 2) return;
      expect(context.modelSession?.state.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "context_compaction_settled",
            settlement: { outcome: "interrupted", reason: "process_interrupted" },
          }),
          expect.objectContaining({ type: "attempt_interrupted", attempt: 1 }),
        ]),
      );
    });

    const state = await resumeWorkflow(compiled, {
      ...runOptions(store, executor, sessions),
      runId: "run-compaction-recovery",
    });

    expect(state.nodes.implement).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(operations.indexOf("session:context_compaction_settled")).toBeLessThan(
      operations.indexOf("session:attempt_interrupted"),
    );
    expect(operations.indexOf("session:attempt_interrupted")).toBeLessThan(
      operations.indexOf("run:node_attempt_interrupted"),
    );
  });

  it("interrupts an unmatched rolling epoch before closing its model attempt", async () => {
    const operations: string[] = [];
    const compiled = rollingWorkflow();
    const sessions = new MemoryModelSessionStore(operations);
    const openSession = openRollingSessionState(identity("run-rolling-recovery"));
    sessions.states.set(openSession.sessionId, openSession);
    const store = new MemoryRunStore(openAttemptEvents(compiled, openSession), operations);
    const executor = recordingExecutor(operations, (context) => {
      if (context.attempt !== 2) return;
      expect(context.modelSession?.state.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "rolling_context_epoch_settled",
            settlement: { outcome: "interrupted", reason: "process_interrupted" },
          }),
          expect.objectContaining({ type: "attempt_interrupted", attempt: 1 }),
        ]),
      );
    });

    const state = await resumeWorkflow(compiled, {
      ...runOptions(store, executor, sessions),
      runId: "run-rolling-recovery",
    });

    expect(state.nodes.implement).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(operations.indexOf("session:rolling_context_epoch_settled")).toBeLessThan(
      operations.indexOf("session:attempt_interrupted"),
    );
    expect(operations.indexOf("session:attempt_interrupted")).toBeLessThan(
      operations.indexOf("run:node_attempt_interrupted"),
    );
  });

  it("fails closed without mutating workflow history when a required session is missing", async () => {
    const operations: string[] = [];
    const compiled = workflow();
    const sessions = new MemoryModelSessionStore(operations);
    const orphan = openSessionState(identity("run-model-missing"));
    const store = new MemoryRunStore(openAttemptEvents(compiled, orphan), operations);
    const executor = recordingExecutor(operations);

    await expect(
      resumeWorkflow(compiled, {
        ...runOptions(store, executor, sessions),
        runId: "run-model-missing",
      }),
    ).rejects.toMatchObject({ code: "recovery_retry_ineligible" });

    expect(store.events.map((event) => event.type)).toEqual(["run_started", "node_started"]);
    expect(operations).not.toContain("executor:implement:2");
  });

  it("fails closed when a durable session exists but its store is unavailable", async () => {
    const operations: string[] = [];
    const compiled = workflow();
    const orphan = openSessionState(identity("run-model-store-unavailable"));
    const store = new MemoryRunStore(openAttemptEvents(compiled, orphan), operations);
    const executor = recordingExecutor(operations);

    await expect(
      resumeWorkflow(compiled, {
        cwd: process.cwd(),
        protectedPaths: [],
        store,
        executor,
        runId: "run-model-store-unavailable",
        now: () => new Date("2026-08-22T01:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "recovery_retry_ineligible" });

    expect(store.events.map((event) => event.type)).toEqual(["run_started", "node_started"]);
    expect(operations).not.toContain("executor:implement:2");
  });

  it("fresh-retries when the private attempt settled before workflow success persisted", async () => {
    const operations: string[] = [];
    const compiled = workflow();
    const store = new MemoryRunStore([], operations);
    const sessions = new MemoryModelSessionStore(operations);
    const executor = recordingExecutor(operations);
    store.failNext("node_succeeded");

    await expect(
      runWorkflow(compiled, {
        ...runOptions(store, executor, sessions),
        runId: "run-settlement-window",
      }),
    ).rejects.toThrow(/injected node_succeeded persistence failure/i);
    const privateState = await sessions.read(identity("run-settlement-window"));
    expect(privateState.events.at(-1)).toMatchObject({
      type: "attempt_settled",
      attempt: 1,
      outcome: "succeeded",
    });
    expect(store.events.map((event) => event.type)).toEqual(["run_started", "node_started"]);

    const state = await resumeWorkflow(compiled, {
      ...runOptions(store, executor, sessions),
      runId: "run-settlement-window",
    });

    expect(state.nodes.implement).toMatchObject({ status: "succeeded", attempt: 2 });
    expect((await sessions.read(identity("run-settlement-window"))).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "attempt_interrupted", attempt: 1 }),
        expect.objectContaining({ type: "attempt_started", attempt: 2 }),
      ]),
    );
  });

  it("does not create a model session for a non-model node", async () => {
    const operations: string[] = [];
    const store = new MemoryRunStore([], operations);
    const sessions = new MemoryModelSessionStore(operations);
    const executor = recordingExecutor(operations, (context) => {
      expect(context.modelSession).toBeUndefined();
    });

    await runWorkflow(commandWorkflow(), {
      ...runOptions(store, executor, sessions),
      runId: "run-command-only",
    });

    expect(operations.some((operation) => operation.startsWith("session:"))).toBe(false);
  });
});

class MemoryRunStore implements RecoverableRunEventStore {
  readonly events: RunEvent[];
  private failingType: RunEvent["type"] | undefined;

  constructor(
    initial: readonly RunEvent[],
    private readonly operations: string[],
  ) {
    this.events = structuredClone([...initial]);
  }

  failNext(type: RunEvent["type"]): void {
    this.failingType = type;
  }

  async append(event: RunEvent): Promise<void> {
    this.operations.push(`run:${event.type}`);
    if (event.type === this.failingType) {
      this.failingType = undefined;
      throw new Error(`injected ${event.type} persistence failure`);
    }
    this.events.push(structuredClone(event));
  }

  async claim(): Promise<readonly RunEvent[]> {
    this.operations.push("run:claim");
    return structuredClone(this.events);
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async release(): Promise<void> {
    this.operations.push("run:release");
  }
}

class MemoryModelSessionStore implements ModelSessionStore {
  readonly states = new Map<string, ModelSessionState>();

  constructor(private readonly operations: string[]) {}

  seedOpen(identity: ModelSessionIdentity): ModelSessionState {
    const state = openSessionState(identity);
    this.states.set(state.sessionId, state);
    return state;
  }

  async create(identity: ModelSessionIdentity, at: string): Promise<ModelSessionState> {
    this.operations.push("session:create");
    const state = createModelSession(identity, at).state;
    this.states.set(state.sessionId, state);
    return state;
  }

  async append(
    identity: ModelSessionIdentity,
    input: ModelSessionEventInput,
    at: string,
  ): Promise<ModelSessionState> {
    this.operations.push(`session:${input.type}`);
    const current = this.require(identity);
    const event = createModelSessionEvent(current, input, at);
    const state = reduceModelSessionEvents([...current.events, event]);
    this.states.set(state.sessionId, state);
    return state;
  }

  async read(identity: ModelSessionIdentity): Promise<ModelSessionState> {
    return this.require(identity);
  }

  async claim(identity: ModelSessionIdentity): Promise<ModelSessionState> {
    this.operations.push("session:claim");
    return this.require(identity);
  }

  async release(): Promise<void> {
    this.operations.push("session:release");
  }

  private require(identity: ModelSessionIdentity): ModelSessionState {
    const state = this.states.get(modelSessionId(identity));
    if (state === undefined) throw new Error("model session is missing");
    return state;
  }
}

function recordingExecutor(
  operations: string[],
  assertContext?: (context: NodeExecutionContext) => void,
): NodeExecutor {
  return {
    async execute(node, context): Promise<NodeExecutionOutcome> {
      operations.push(`executor:${node.id}:${context.attempt}`);
      assertContext?.(context);
      return node.type === "agent" ? successfulAgentOutcome() : successfulCommandOutcome(node.id);
    },
  };
}

function runOptions(
  store: RecoverableRunEventStore,
  executor: NodeExecutor,
  modelSessionStore: ModelSessionStore,
) {
  return {
    cwd: process.cwd(),
    protectedPaths: [],
    store,
    executor,
    modelSessionStore,
    now: () => new Date("2026-08-22T01:00:00.000Z"),
  };
}

function openAttemptEvents(
  compiled: ReturnType<typeof workflow>,
  session: ModelSessionState,
): RunEvent[] {
  return [
    parseRunEvent({
      ...eventBase(session.runId, 1),
      type: "run_started",
      nodeIds: compiled.nodes.map((node) => node.id),
      workflowApiVersion: compiled.apiVersion,
      workflowDigest: createHash("sha256").update(JSON.stringify(compiled)).digest("hex"),
      executionCwd: resolve(process.cwd()),
      recoveryRequirements: [
        {
          nodeId: "implement",
          mode: "fresh",
          maxAttempts: 3,
          effectProtocol: "none",
        },
      ],
    }),
    parseRunEvent({
      ...eventBase(session.runId, 2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      modelSession: modelSessionSummary(session),
    }),
  ];
}

function workflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: model-session-workflow }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Implement the requested change.
      model: { provider: test, id: deterministic }
      tools: [read]
      recovery: { mode: fresh, maxAttempts: 3 }
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`);
}

function editWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: model-session-workflow }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Implement the requested change.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
      recovery: { mode: fresh, maxAttempts: 3 }
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`);
}

function rollingWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: model-session-workflow }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Implement the requested change.
      model: { provider: test, id: deterministic }
      tools: [read]
      contextCompaction:
        mode: rolling
        pressureThresholdPercent: 85
        protectedConstraints: [Keep the acceptance criteria exact.]
      recovery: { mode: fresh, maxAttempts: 3 }
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`);
}

function commandWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: command-only-workflow }
nodes:
  - id: verify
    type: command
    command: { executable: node, args: [--version] }
`);
}

function identity(runId: string): ModelSessionIdentity {
  return { runId, workflowId: "model-session-workflow", nodeId: "implement" };
}

function appendState(
  state: ModelSessionState,
  input: ModelSessionEventInput,
  sequence: number,
): ModelSessionState {
  const event = createModelSessionEvent(state, input, timestamp(sequence));
  return reduceModelSessionEvents([...state.events, event]);
}

function openSessionState(identity: ModelSessionIdentity): ModelSessionState {
  let state = createModelSession(identity, timestamp(0)).state;
  state = appendState(state, { type: "attempt_started", attempt: 1 }, 1);
  return appendState(
    state,
    {
      type: "user_message_committed",
      attempt: 1,
      origin: "primary_prompt",
      text: "Implement the requested change.",
    },
    2,
  );
}

function openCompactionSessionState(identity: ModelSessionIdentity): ModelSessionState {
  let state = openSessionState(identity);
  state = appendState(
    state,
    {
      type: "model_request_prepared",
      attempt: 1,
      turn: 1,
      request: 1,
      identity: requestIdentity(state, 1, 1),
    },
    3,
  );
  state = appendState(
    state,
    {
      type: "model_message_committed",
      attempt: 1,
      turn: 1,
      request: 1,
      text: "First response.",
      stopReason: "stop",
    },
    4,
  );
  state = appendState(
    state,
    {
      type: "model_request_settled",
      attempt: 1,
      turn: 1,
      request: 1,
      outcome: "completed",
    },
    5,
  );
  state = appendState(
    state,
    {
      type: "model_request_prepared",
      attempt: 1,
      turn: 2,
      request: 2,
      identity: requestIdentity(state, 2, 2),
    },
    6,
  );
  state = appendState(
    state,
    {
      type: "model_message_committed",
      attempt: 1,
      turn: 2,
      request: 2,
      text: "Second response.",
      stopReason: "stop",
    },
    7,
  );
  state = appendState(
    state,
    {
      type: "model_request_settled",
      attempt: 1,
      turn: 2,
      request: 2,
      outcome: "completed",
    },
    8,
  );
  const selection = selectContextCompactionRange(state);
  if (selection === null) throw new Error("test session has no compactable range");
  return appendState(
    state,
    {
      type: "context_compaction_started",
      attempt: 1,
      compaction: 1,
      generationAttempt: 1,
      mode: "references-and-summary",
      sourceHead: state.head,
      range: selection.range,
      referenceSurface: { sha256: "5".repeat(64), bytes: 1_000, estimatedTokens: 250 },
      outputTokenLimit: 512,
    },
    9,
  );
}

function openRollingSessionState(identity: ModelSessionIdentity): ModelSessionState {
  let state = openSessionState(identity);
  let sequence = 3;
  for (let request = 1; request <= 3; request += 1) {
    state = appendState(
      state,
      {
        type: "model_request_prepared",
        attempt: 1,
        turn: request,
        request,
        identity: requestIdentity(state, request, request),
      },
      sequence++,
    );
    state = appendState(
      state,
      {
        type: "model_message_committed",
        attempt: 1,
        turn: request,
        request,
        text: `Response ${request}.`,
        stopReason: "stop",
      },
      sequence++,
    );
    state = appendState(
      state,
      {
        type: "model_request_settled",
        attempt: 1,
        turn: request,
        request,
        outcome: "completed",
      },
      sequence++,
    );
  }
  state = appendState(
    state,
    {
      type: "model_request_capacity_checked",
      check: 1,
      attempt: 1,
      operation: { kind: "task", turn: 4, request: 4 },
      apiAdapter: "openai-responses",
      providerPayload: { sha256: "5".repeat(64), bytes: 1_000 },
      measurement: {
        status: "measured",
        method: "provider_exact",
        evaluation: evaluateModelRequestCapacity({
          contextWindowTokens: 100_000,
          outputAllowanceTokens: 4_096,
          safetyReserveTokens: 16_384,
          pressureThresholdPercent: 85,
          measuredInputTokens: 70_000,
        }),
      },
    },
    sequence++,
  );
  const selection = selectRollingContextRange(state);
  if (selection === null) throw new Error("test session has no rolling range");
  return appendState(
    state,
    {
      type: "rolling_context_epoch_started",
      attempt: 1,
      epoch: 1,
      generationAttempt: 1,
      task: { turn: 4, request: 4 },
      sourceHead: state.head,
      cumulativeRange: selection.cumulativeRange,
      deltaRange: selection.deltaRange,
      referenceSurface: { sha256: "6".repeat(64), bytes: 10_000, estimatedTokens: 2_500 },
      outputTokenLimit: 4_096,
      bindings: {
        provider: "test",
        model: "deterministic",
        apiAdapter: "openai-responses",
        contextWindowTokens: 100_000,
        maxOutputTokens: 4_096,
        thinking: "off",
        runtimeVersion: "test",
        system: { sha256: "1".repeat(64), bytes: 1 },
        toolCatalog: { sha256: "2".repeat(64), bytes: 1, count: 1 },
        authority: { sha256: "3".repeat(64) },
        routingSha256: null,
      },
      policy: {
        sha256: "4".repeat(64),
        pressureThresholdPercent: 85,
        protectedConstraints: { sha256: "7".repeat(64), count: 1 },
      },
    },
    sequence,
  );
}

function requestIdentity(state: ModelSessionState, turn: number, request: number) {
  return {
    version: 1 as const,
    provider: "test",
    model: "deterministic",
    apiAdapter: "test",
    thinking: "off",
    runtimeVersion: "test",
    system: { sha256: "1".repeat(64), bytes: 1 },
    toolCatalog: { sha256: "2".repeat(64), bytes: 1, count: 1 },
    authority: { sha256: "3".repeat(64) },
    portableHistory: calculatePortableHistoryIdentity(state),
    runtimeSurface: { sha256: "4".repeat(64), bytes: 1 },
    attempt: 1,
    turn,
    request,
  };
}

function successfulAgentOutcome(): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text: "implemented",
      textHash: sha256("implemented"),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [],
      effectReceipts: [],
    },
  };
}

function successfulCommandOutcome(nodeId: string): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: {
      kind: "command",
      executable: "node",
      args: [nodeId],
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      stdoutHash: sha256("ok"),
      stderrHash: sha256(""),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
    },
  };
}

function eventBase(runId: string, sequence: number) {
  return {
    version: 1,
    runId,
    workflowId: "model-session-workflow",
    sequence,
    at: timestamp(sequence),
  };
}

function timestamp(sequence: number): string {
  return `2026-08-22T00:00:${String(sequence).padStart(2, "0")}.000Z`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
