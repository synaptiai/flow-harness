import { createHash } from "node:crypto";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../../../../src/application/artifact-store.js";
import type { ModelSessionJournal } from "../../../../src/application/ports.js";
import { createArtifactReference } from "../../../../src/domain/artifact/reference.js";
import { PolicyBroker } from "../../../../src/domain/policy/broker.js";
import {
  calculatePortableHistoryIdentity,
  createModelSession,
  createModelSessionEvent,
  MODEL_SESSION_RESUME_INSTRUCTION,
  type ModelSessionEventInput,
  type ModelSessionIdentity,
  type ModelSessionState,
  reduceModelSessionEvents,
} from "../../../../src/domain/run/model-session.js";
import { AgentCommandRecorder } from "../../../../src/infrastructure/pi/agent-command-recorder.js";
import { AgentEffectRecorder } from "../../../../src/infrastructure/pi/agent-effect-recorder.js";
import {
  EmbeddedPiAgentRunner,
  type PiAgentRunRequest,
} from "../../../../src/infrastructure/pi/pi-agent-executor.js";

const identity: ModelSessionIdentity = {
  runId: "run-agent",
  workflowId: "agent-workflow",
  nodeId: "analyze",
};

describe("Pi provider-neutral model session", () => {
  it("commits a model-verifier prompt before preparing its first provider request", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false }],
    });
    const model = requireModel(faux.getModel());
    const journal = attemptOneUnseededJournal();
    let promptCommittedBeforeProvider = false;
    faux.setResponses([
      () => {
        promptCommittedBeforeProvider = journal.state.primaryPromptCommitted;
        return fauxAssistantMessage("Verified.");
      },
    ]);

    await runnerFor(faux, model).run(agentRequest(model, journal));

    expect(promptCommittedBeforeProvider).toBe(true);
    expect(journal.state.events.slice(0, 4).map((event) => event.type)).toEqual([
      "session_created",
      "attempt_started",
      "user_message_committed",
      "model_request_prepared",
    ]);
  });

  it("commits request preparation before provider I/O and complete events in lifecycle order", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false }],
    });
    const model = requireModel(faux.getModel());
    const journal = attemptOneJournal();
    let preparedBeforeProvider = false;
    faux.setResponses([
      () => {
        preparedBeforeProvider = journal.state.events.at(-1)?.type === "model_request_prepared";
        return {
          ...fauxAssistantMessage(
            fauxToolCall("flow_ls", { path: ".", limit: 1 }, { id: "tool-call-1" }),
            { stopReason: "toolUse" },
          ),
          responseId: "provider-private-response",
          diagnostics: [
            {
              type: "warning",
              message: "provider-private-diagnostic",
              timestamp: Date.now(),
            },
          ],
        };
      },
      fauxAssistantMessage("Inspection complete."),
    ]);
    const runner = runnerFor(faux, model);

    await runner.run(agentRequest(model, journal));

    expect(preparedBeforeProvider).toBe(true);
    expect(journal.state.events.map((event) => event.type)).toEqual([
      "session_created",
      "attempt_started",
      "user_message_committed",
      "model_request_prepared",
      "model_message_committed",
      "tool_call_committed",
      "tool_result_committed",
      "model_request_settled",
      "model_request_prepared",
      "model_message_committed",
      "model_request_settled",
    ]);
    expect(journal.state.primaryEvents.at(-1)).toMatchObject({
      type: "model_message_committed",
      text: "Inspection complete.",
    });
    const prepared = journal.state.events.filter(
      (event) => event.type === "model_request_prepared",
    );
    expect(prepared).toHaveLength(2);
    expect(prepared[0]?.identity).toMatchObject({
      version: 1,
      provider: "flow-session-test",
      model: "session-model",
      apiAdapter: model.api,
      thinking: "off",
      runtimeVersion: "pi-0.84.0",
      system: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      toolCatalog: {
        bytes: expect.any(Number),
        count: 1,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      authority: { sha256: "a".repeat(64) },
      portableHistory: {
        bytes: expect.any(Number),
        eventCount: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      runtimeSurface: {
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      attempt: 1,
      turn: 1,
      request: 1,
    });
    const serialized = JSON.stringify(journal.state.events);
    expect(serialized).not.toContain("provider-private-response");
    expect(serialized).not.toContain("provider-private-diagnostic");
    expect(serialized).not.toContain("thoughtSignature");
  });

  it("does not enter provider I/O when write-ahead preparation fails", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false }],
    });
    const model = requireModel(faux.getModel());
    let providerCalls = 0;
    faux.setResponses([
      () => {
        providerCalls += 1;
        return fauxAssistantMessage("must not run");
      },
    ]);
    const base = attemptOneJournal();
    const journal: ModelSessionJournal = {
      get state() {
        return base.state;
      },
      read: base.read,
      async append(input) {
        if (input.type === "model_request_prepared") {
          throw new Error("durable recorder unavailable");
        }
        return await base.append(input);
      },
    };

    const result = await runnerFor(faux, model).run(agentRequest(model, journal));

    expect(providerCalls).toBe(0);
    expect(result).toMatchObject({ stopReason: "error" });
    expect(result.errorMessage).toMatch(/durable recorder unavailable/i);
  });

  it("does not commit an aborted partial assistant message", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false }],
    });
    const model = requireModel(faux.getModel());
    const journal = attemptOneJournal();
    faux.setResponses([
      fauxAssistantMessage("PRIVATE_PARTIAL_TEXT", {
        stopReason: "aborted",
        errorMessage: "provider stream interrupted",
      }),
    ]);

    await runnerFor(faux, model).run(agentRequest(model, journal));

    expect(journal.state.primaryEvents).toHaveLength(1);
    expect(JSON.stringify(journal.state.events)).not.toContain("PRIVATE_PARTIAL_TEXT");
  });

  it("starts recovery as one fresh untrusted-data user turn without recursive capsule content", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false }],
    });
    const model = requireModel(faux.getModel());
    const journal = attemptTwoJournal();
    let observedPrompt = "";
    faux.setResponses([
      (context) => {
        observedPrompt = JSON.stringify(
          context.messages.filter((message) => message.role === "user"),
        );
        return fauxAssistantMessage("Recovered.");
      },
    ]);

    await runnerFor(faux, model).run(agentRequest(model, journal));

    expect(observedPrompt).toContain(MODEL_SESSION_RESUME_INSTRUCTION);
    expect(observedPrompt).toContain("Original objective.");
    expect(observedPrompt).toContain("Prior completed answer.");
    expect(observedPrompt).not.toContain("resume_surface_prepared");
    expect(
      journal.state.events.filter((event) => event.type === "resume_surface_prepared"),
    ).toHaveLength(1);
    expect(
      journal.state.events.find((event) => event.type === "resume_surface_prepared"),
    ).not.toHaveProperty("text");
  });

  it("rejects a request above selected-model capacity before provider I/O", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false, contextWindow: 32_768 }],
    });
    const model = requireModel(faux.getModel());
    let providerCalls = 0;
    faux.setResponses([
      () => {
        providerCalls += 1;
        return fauxAssistantMessage("must not run");
      },
    ]);
    const journal = attemptOneJournal();

    const result = await runnerFor(faux, model).run(agentRequest(model, journal));

    expect(providerCalls).toBe(0);
    expect(result).toMatchObject({ stopReason: "error" });
    expect(result.errorMessage).toMatch(/capacity/i);
    expect(journal.state.events.at(-1)?.type).toBe("user_message_committed");
  });

  it("sends a validated reference projection while retaining complete durable tool text", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false }],
    });
    const model = requireModel(faux.getModel());
    const journal = attemptOneJournal();
    const fullStdout = "x".repeat(16_384);
    const retainedStdout = "x".repeat(8_192);
    const stdoutArtifact = createArtifactReference({
      descriptor: {
        digest: `sha256:${sha256(fullStdout)}`,
        size: Buffer.byteLength(fullStdout),
        mediaType: "application/octet-stream",
      },
      producer: {
        kind: "agent-command",
        ...identity,
        attempt: 1,
        commandId: "command-1",
        commandSequence: 1,
        stream: "stdout",
      },
    });
    const artifactStore = availableArtifactStore(stdoutArtifact);
    const commandRecorder = new AgentCommandRecorder(
      {
        async executeAgentCommand(request) {
          return {
            status: "succeeded",
            evidence: {
              kind: "command",
              executable: request.executable,
              args: request.args,
              exitCode: 0,
              signal: null,
              stdout: retainedStdout,
              stderr: "",
              stdoutHash: sha256(fullStdout),
              stderrHash: sha256(""),
              stdoutRetainedHash: sha256(retainedStdout),
              stderrRetainedHash: sha256(""),
              stdoutRetainedBytes: Buffer.byteLength(retainedStdout),
              stderrRetainedBytes: 0,
              stdoutArtifact,
              stdoutTruncated: true,
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
            },
          };
        },
      },
      {
        async prepare() {
          return {
            commandId: "command-1",
            commandSequence: 1,
            async settle() {
              return { artifactBudgetExhausted: false };
            },
          };
        },
      },
      { ...identity, attempt: 1, cwd: process.cwd(), protectedPaths: [], artifactStore },
    );
    let providerToolResult = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "flow_exec",
          { executable: "npm", args: ["test"], timeoutMs: 5_000 },
          { id: "tool-call-1" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const message = context.messages.at(-1);
        if (message?.role === "toolResult") {
          providerToolResult = message.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("");
        }
        return fauxAssistantMessage("Reference observed.");
      },
    ]);

    await runnerFor(faux, model).run({
      ...agentRequest(model, journal),
      tools: ["exec"],
      policyBroker: new PolicyBroker({ ...identity, attempt: 1 }, ["process.execute"]),
      commandRecorder,
      artifactStore,
      contextCompactionMode: "references",
    });

    expect(providerToolResult).toContain('"kind":"flow.reference-tool-result"');
    expect(providerToolResult).toContain(stdoutArtifact.reference);
    expect(providerToolResult).not.toContain("x".repeat(1_024));
    const durableResult = journal.state.primaryEvents.find(
      (event) => event.type === "tool_result_committed",
    );
    expect(durableResult?.text).toContain(retainedStdout);
    expect(durableResult?.text).not.toContain("flow.reference-tool-result");
  });
});

function runnerFor(
  faux: ReturnType<typeof createFauxCore>,
  model: NonNullable<ReturnType<ReturnType<typeof createFauxCore>["getModel"]>>,
): EmbeddedPiAgentRunner {
  const modelRuntime = {
    getModel: (provider: string, modelId: string) =>
      provider === model.provider && modelId === model.id ? model : undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => undefined,
    isUsingOAuth: () => false,
    streamSimple: faux.streamSimple,
  };
  return new EmbeddedPiAgentRunner(async () => modelRuntime as never, createAgentSession);
}

function agentRequest(
  model: NonNullable<ReturnType<ReturnType<typeof createFauxCore>["getModel"]>>,
  journal: ModelSessionJournal,
): PiAgentRunRequest {
  return {
    cwd: process.cwd(),
    prompt: "Original objective.",
    provider: model.provider,
    model: model.id,
    thinking: "off",
    tools: ["ls"],
    maxOutputBytes: 65_536,
    policyBroker: new PolicyBroker({ ...identity, attempt: journal.state.lastAttempt }, [
      "filesystem.list",
    ]),
    protectedPaths: [],
    effectRecorder: new AgentEffectRecorder(
      { ...identity, attempt: journal.state.lastAttempt },
      {
        async prepare() {
          throw new Error("read-only test must not prepare effects");
        },
      },
    ),
    authorityDigest: "a".repeat(64),
    modelSession: journal,
  };
}

function attemptOneJournal(): InMemoryJournal {
  let state = attemptOneUnseededJournal().state;
  state = append(
    state,
    {
      type: "user_message_committed",
      attempt: 1,
      origin: "primary_prompt",
      text: "Original objective.",
    },
    2,
  );
  return new InMemoryJournal(state);
}

function attemptOneUnseededJournal(): InMemoryJournal {
  let state = createModelSession(identity, at(0)).state;
  state = append(state, { type: "attempt_started", attempt: 1 }, 1);
  return new InMemoryJournal(state);
}

function attemptTwoJournal(): InMemoryJournal {
  let state = attemptOneJournal().state;
  state = append(
    state,
    {
      type: "model_request_prepared",
      attempt: 1,
      turn: 1,
      request: 1,
      identity: {
        version: 1,
        provider: "flow-session-test",
        model: "session-model",
        apiAdapter: "faux",
        thinking: "off",
        runtimeVersion: "pi-0.84.0",
        system: { sha256: "1".repeat(64), bytes: 1 },
        toolCatalog: { sha256: "2".repeat(64), bytes: 1, count: 1 },
        authority: { sha256: "3".repeat(64) },
        portableHistory: calculatePortableHistoryIdentity(state),
        runtimeSurface: { sha256: "5".repeat(64), bytes: 1 },
        attempt: 1,
        turn: 1,
        request: 1,
      },
    },
    3,
  );
  state = append(
    state,
    {
      type: "model_message_committed",
      attempt: 1,
      turn: 1,
      request: 1,
      text: "Prior completed answer.",
      stopReason: "stop",
    },
    4,
  );
  state = append(
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
  state = append(
    state,
    { type: "attempt_interrupted", attempt: 1, reason: "process_interrupted" },
    6,
  );
  state = append(state, { type: "attempt_started", attempt: 2 }, 7);
  return new InMemoryJournal(state);
}

class InMemoryJournal implements ModelSessionJournal {
  constructor(public state: ModelSessionState) {}

  readonly read = async (): Promise<ModelSessionState> => this.state;

  readonly append = async (input: ModelSessionEventInput): Promise<ModelSessionState> => {
    this.state = append(this.state, input, this.state.eventCount + 1);
    return this.state;
  };
}

function append(
  state: ModelSessionState,
  input: ModelSessionEventInput,
  sequence: number,
): ModelSessionState {
  const event = createModelSessionEvent(state, input, at(sequence));
  return reduceModelSessionEvents([...state.events, event]);
}

function requireModel<T>(model: T | undefined): T {
  if (model === undefined) throw new Error("faux model fixture was not created");
  return model;
}

function at(sequence: number): string {
  return `2026-08-22T00:00:${String(sequence).padStart(2, "0")}.000Z`;
}

function availableArtifactStore(
  reference: ReturnType<typeof createArtifactReference>,
): ArtifactStore {
  return {
    async inspect(input) {
      expect(input).toBe(reference.reference);
      return { reference, retention: "retained", availability: "available" };
    },
    async retain() {
      throw new Error("test artifact is already retained");
    },
    async read() {
      throw new Error("test does not reopen the artifact");
    },
    async list() {
      return [{ reference, retention: "retained" }];
    },
    async setRetention() {
      throw new Error("test does not change retention");
    },
    async planPrune() {
      throw new Error("test does not prune artifacts");
    },
    async applyPrune() {
      throw new Error("test does not prune artifacts");
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
