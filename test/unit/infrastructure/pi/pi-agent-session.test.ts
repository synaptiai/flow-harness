import { createHash } from "node:crypto";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { streamSimple as anthropicMessagesStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as openAIResponsesStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
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
  renderRollingContextResumeBootstrap,
  selectContextCompactionRange,
} from "../../../../src/domain/run/model-session.js";
import { AgentCommandRecorder } from "../../../../src/infrastructure/pi/agent-command-recorder.js";
import { AgentEffectRecorder } from "../../../../src/infrastructure/pi/agent-effect-recorder.js";
import {
  EmbeddedPiAgentRunner,
  type PiAgentRunRequest,
  rollingReferenceProjectionLimit,
} from "../../../../src/infrastructure/pi/pi-agent-executor.js";

const identity: ModelSessionIdentity = {
  runId: "run-agent",
  workflowId: "agent-workflow",
  nodeId: "analyze",
};

describe("Pi provider-neutral model session", () => {
  it("protects the two most recent completed requests from rolling reference projection", () => {
    expect(
      rollingReferenceProjectionLimit([
        { role: "user" },
        { role: "assistant" },
        { role: "toolResult" },
        { role: "assistant" },
        { role: "toolResult" },
        { role: "assistant" },
        { role: "toolResult" },
      ]),
    ).toBe(3);
    expect(
      rollingReferenceProjectionLimit([
        { role: "user" },
        { role: "assistant" },
        { role: "toolResult" },
        { role: "assistant" },
        { role: "toolResult" },
      ]),
    ).toBe(0);
  });

  it("counts the final OpenAI payload and durably admits it before inference", async () => {
    const model = openAIModel();
    const journal = attemptOneJournal();
    let inferencePayload = "";
    const providerFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const captured = new Request(input, init);
      const url = captured.url;
      if (url.endsWith("/responses/input_tokens")) {
        expect(journal.state.events.at(-1)?.type).toBe("user_message_committed");
        return openAIInputTokenCount(42);
      }
      expect(url).toBe("https://provider.example/v1/responses");
      expect(journal.state.events.at(-1)?.type).toBe("model_request_prepared");
      inferencePayload = await captured.text();
      return Response.json({ error: { message: "fixture terminal response" } }, { status: 500 });
    };
    const runner = openAIRunner(model, providerFetch);

    const result = await runner.run({
      ...agentRequest(model as never, journal),
      provider: model.provider,
      model: model.id,
      thinking: "high",
      contextCompactionMode: "rolling",
      rollingContext: { pressureThresholdPercent: 85, protectedConstraints: [] },
    });

    expect(result.stopReason).toBe("error");
    expect(journal.state.events.slice(2, 5).map((event) => event.type)).toEqual([
      "user_message_committed",
      "model_request_capacity_checked",
      "model_request_prepared",
    ]);
    const capacity = journal.state.events.find(
      (event) => event.type === "model_request_capacity_checked",
    );
    const prepared = journal.state.events.find((event) => event.type === "model_request_prepared");
    expect(capacity).toMatchObject({
      operation: { kind: "task", turn: 1, request: 1 },
      apiAdapter: "openai-responses",
      measurement: {
        status: "measured",
        method: "provider_exact",
        evaluation: {
          contextWindowTokens: 272_000,
          outputAllowanceTokens: 128_000,
          measuredInputTokens: 42,
          decision: "admitted",
        },
      },
    });
    expect(prepared).toMatchObject({
      providerPayload: {
        sha256: createHash("sha256").update(inferencePayload, "utf8").digest("hex"),
        bytes: Buffer.byteLength(inferencePayload, "utf8"),
      },
    });
    expect(prepared).toMatchObject({ providerPayload: capacity?.providerPayload });
  });

  it("fails closed before inference when provider token counting is unavailable", async () => {
    const model = openAIModel();
    const journal = attemptOneJournal();
    let inferenceCalls = 0;
    const runner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/responses/input_tokens")) {
        return new Response(null, { status: 503 });
      }
      inferenceCalls += 1;
      return new Response(null, { status: 500 });
    });

    const result = await runner.run(rollingRequest(model, journal));

    expect(result).toMatchObject({
      stopReason: "error",
      failureCode: "pi_model_context_measurement_unavailable",
    });
    expect(inferenceCalls).toBe(0);
    expect(journal.state.events.at(-1)).toMatchObject({
      type: "model_request_capacity_checked",
      measurement: { status: "unavailable", failureCategory: "response_status" },
    });
    expect(journal.state.events.some((event) => event.type === "model_request_prepared")).toBe(
      false,
    );
  });

  it("rejects serialization drift after admission without sending inference", async () => {
    const model = openAIModel();
    const journal = attemptOneJournal();
    let inferenceCalls = 0;
    const runner = openAIRunner(
      model,
      async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/responses/input_tokens")) {
          return openAIInputTokenCount(42);
        }
        inferenceCalls += 1;
        return new Response(null, { status: 500 });
      },
      (payload, serialization) => ({
        ...(payload as Readonly<Record<string, unknown>>),
        instructions: `serialization-${serialization}`,
      }),
    );

    const result = await runner.run(rollingRequest(model, journal));

    expect(result).toMatchObject({
      stopReason: "error",
      failureCode: "pi_model_context_checkpoint_invalid",
    });
    expect(inferenceCalls).toBe(0);
    expect(journal.state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "model_request_capacity_checked" }),
        expect.objectContaining({ type: "model_request_prepared" }),
      ]),
    );
  });

  it("accepts a durable rolling checkpoint and retries the task with the exact tail", async () => {
    const model = openAIModel();
    const fullToolResult = `FULL_ROLLING_TOOL_RESULT:${"z".repeat(12_000)}`;
    const artifactReference = createArtifactReference({
      descriptor: {
        digest: `sha256:${sha256(fullToolResult)}`,
        size: Buffer.byteLength(fullToolResult),
        mediaType: "application/octet-stream",
      },
      producer: {
        kind: "agent-command",
        ...identity,
        attempt: 1,
        commandId: "rolling-command-1",
        commandSequence: 1,
        stream: "stdout",
      },
    });
    const projectedToolResult = JSON.stringify({
      version: 1,
      kind: "flow.reference-tool-result",
      artifact: artifactReference.reference,
    });
    const journal = rollingPressureJournal({
      fullText: fullToolResult,
      projectedText: projectedToolResult,
      artifactReferences: [artifactReference.reference],
    });
    let countCalls = 0;
    const inferenceAllowances: number[] = [];
    let taskCount = 0;
    let finalInferenceBody: Readonly<Record<string, unknown>> | undefined;
    let summaryBody: Readonly<Record<string, unknown>> | undefined;
    const runner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Readonly<Record<string, unknown>>;
      const allowance = Number(body.max_output_tokens);
      if (request.url.endsWith("/responses/input_tokens")) {
        countCalls += 1;
        taskCount += 1;
        return openAIInputTokenCount(taskCount === 1 ? 108_474 : 42);
      }
      inferenceAllowances.push(allowance);
      if (allowance === 4_096) {
        summaryBody = body;
        return openAITextStream(
          JSON.stringify({
            version: 1,
            summary: "The first historical request completed.",
            protectedConstraints: [],
          }),
        );
      }
      finalInferenceBody = body;
      return openAITextStream("Rolling context admitted.");
    });

    const result = await runner.run({
      ...rollingRequest(model, journal),
      artifactStore: availableArtifactStore(artifactReference),
    });

    expect(result).toMatchObject({ stopReason: "stop", text: "Rolling context admitted." });
    expect(countCalls).toBe(3);
    expect(inferenceAllowances).toEqual([4_096, 128_000]);
    expect(
      journal.state.events
        .filter((event) => event.type === "model_request_capacity_checked")
        .flatMap((event) =>
          event.measurement.status === "measured"
            ? [event.measurement.evaluation.outputAllowanceTokens]
            : [],
        ),
    ).toEqual([128_000, 4_096, 128_000]);
    expect(JSON.stringify(finalInferenceBody)).not.toContain("OLD_ROLLING_CONTEXT");
    expect(JSON.stringify(finalInferenceBody)).toContain("RECENT_ROLLING_CONTEXT_2");
    expect(JSON.stringify(finalInferenceBody)).toContain("RECENT_ROLLING_CONTEXT_3");
    expect(JSON.stringify(summaryBody)).toContain(artifactReference.reference);
    expect(JSON.stringify(summaryBody)).not.toContain("FULL_ROLLING_TOOL_RESULT");
    expect(journal.state).toMatchObject({
      rollingEpochCount: 1,
      rollingGenerationCount: 1,
      acceptedRollingEpochCount: 1,
      activeRollingEpoch: null,
      currentRollingCheckpoint: {
        summaryText: "The first historical request completed.",
        surface: { minimumReductionBytes: 4_096 },
      },
    });
    const acceptedSettlement = journal.state.events.find(
      (event) =>
        event.type === "rolling_context_epoch_settled" && event.settlement.outcome === "accepted",
    );
    if (
      acceptedSettlement?.type !== "rolling_context_epoch_settled" ||
      acceptedSettlement.settlement.outcome !== "accepted"
    ) {
      throw new Error("accepted rolling settlement is missing");
    }
    expect(acceptedSettlement.settlement.checkpoint.usage.costUsdMicros).toBe(1);
    const bootstrap = renderRollingContextResumeBootstrap(journal.state);
    expect(bootstrap.bytes).toBeLessThan(1_024);
    expect(bootstrap.text).toContain("flow.rolling-context-bootstrap");
    expect(bootstrap.text).not.toContain("OLD_ROLLING_CONTEXT");
    expect(bootstrap.text).not.toContain("The first historical request completed.");
    expect(journal.state.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "rolling_context_epoch_started",
        "rolling_context_epoch_settled",
        "model_request_capacity_checked",
      ]),
    );

    let driftState = append(
      journal.state,
      { type: "attempt_interrupted", attempt: 2, reason: "process_interrupted" },
      journal.state.eventCount + 1,
    );
    driftState = append(
      driftState,
      { type: "attempt_started", attempt: 3 },
      driftState.eventCount + 1,
    );
    const driftJournal = new InMemoryJournal(driftState);
    const driftModel = { ...model, contextWindow: model.contextWindow + 1 } as typeof model;
    let driftProviderCalls = 0;
    const driftRunner = openAIRunner(driftModel, async () => {
      driftProviderCalls += 1;
      return openAIInputTokenCount(42);
    });

    const drifted = await driftRunner.run(rollingRequest(driftModel, driftJournal));

    expect(drifted).toMatchObject({
      stopReason: "error",
      failureCode: "pi_model_context_checkpoint_invalid",
    });
    expect(driftProviderCalls).toBe(0);

    journal.state = append(
      journal.state,
      { type: "attempt_interrupted", attempt: 2, reason: "process_interrupted" },
      journal.state.eventCount + 1,
    );
    journal.state = append(
      journal.state,
      { type: "attempt_started", attempt: 3 },
      journal.state.eventCount + 1,
    );
    let recoveredInferenceBody: Readonly<Record<string, unknown>> | undefined;
    const recoveredRunner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Readonly<Record<string, unknown>>;
      if (request.url.endsWith("/responses/input_tokens")) {
        return openAIInputTokenCount(42);
      }
      recoveredInferenceBody = body;
      return openAITextStream("Recovered checkpoint admitted.");
    });

    const recovered = await recoveredRunner.run(rollingRequest(model, journal));

    expect(recovered).toMatchObject({
      stopReason: "stop",
      text: "Recovered checkpoint admitted.",
    });
    expect(JSON.stringify(recoveredInferenceBody)).not.toContain("OLD_ROLLING_CONTEXT");
    expect(JSON.stringify(recoveredInferenceBody)).toContain("flow.context-summary");
    expect(journal.state.rollingEpochCount).toBe(1);
    const latestResume = [...journal.state.events]
      .reverse()
      .find((event) => event.type === "resume_surface_prepared" && event.attempt === 3);
    expect(latestResume).toMatchObject({ type: "resume_surface_prepared", attempt: 3 });
    if (latestResume?.type !== "resume_surface_prepared") {
      throw new Error("attempt three rolling resume surface is missing");
    }
    expect(latestResume.bytes).toBeLessThan(1_024);
  });

  it("fails closed when a rolling artifact changes after summary admission", async () => {
    const model = openAIModel();
    const fullToolResult = `DRIFTING_ROLLING_TOOL_RESULT:${"z".repeat(12_000)}`;
    const artifactReference = createArtifactReference({
      descriptor: {
        digest: `sha256:${sha256(fullToolResult)}`,
        size: Buffer.byteLength(fullToolResult),
        mediaType: "application/octet-stream",
      },
      producer: {
        kind: "agent-command",
        ...identity,
        attempt: 1,
        commandId: "rolling-command-drift",
        commandSequence: 1,
        stream: "stdout",
      },
    });
    const projectedToolResult = JSON.stringify({
      version: 1,
      kind: "flow.reference-tool-result",
      artifact: artifactReference.reference,
    });
    const journal = rollingPressureJournal({
      fullText: fullToolResult,
      projectedText: projectedToolResult,
      artifactReferences: [artifactReference.reference],
    });
    let inspections = 0;
    const artifactStore: ArtifactStore = {
      ...availableArtifactStore(artifactReference),
      async inspect(reference) {
        expect(reference).toBe(artifactReference.reference);
        inspections += 1;
        return {
          reference: artifactReference,
          retention: "retained",
          availability: inspections === 1 ? "available" : "changed",
        };
      },
    };
    let countCalls = 0;
    let inferenceCalls = 0;
    const runner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/responses/input_tokens")) {
        countCalls += 1;
        return openAIInputTokenCount(countCalls === 1 ? 108_474 : 42);
      }
      inferenceCalls += 1;
      return openAITextStream("must not infer from a changed artifact projection");
    });

    const result = await runner.run({
      ...rollingRequest(model, journal),
      artifactStore,
    });

    expect(result).toMatchObject({
      stopReason: "error",
      failureCode: "pi_model_context_checkpoint_invalid",
    });
    expect(inspections).toBe(2);
    expect(countCalls).toBe(2);
    expect(inferenceCalls).toBe(0);
  });

  it("uses complete tool text when a durable rolling artifact is unavailable before admission", async () => {
    const model = openAIModel();
    const fullToolResult = `MISSING_ROLLING_ARTIFACT_RESULT:${"z".repeat(12_000)}`;
    const artifactReference = createArtifactReference({
      descriptor: {
        digest: `sha256:${sha256(fullToolResult)}`,
        size: Buffer.byteLength(fullToolResult),
        mediaType: "application/octet-stream",
      },
      producer: {
        kind: "agent-command",
        ...identity,
        attempt: 1,
        commandId: "rolling-command-missing",
        commandSequence: 1,
        stream: "stdout",
      },
    });
    const projectedToolResult = JSON.stringify({
      version: 1,
      kind: "flow.reference-tool-result",
      artifact: artifactReference.reference,
    });
    const journal = rollingPressureJournal({
      fullText: fullToolResult,
      projectedText: projectedToolResult,
      artifactReferences: [artifactReference.reference],
    });
    let inspections = 0;
    const artifactStore: ArtifactStore = {
      ...availableArtifactStore(artifactReference),
      async inspect(reference) {
        expect(reference).toBe(artifactReference.reference);
        inspections += 1;
        return {
          reference: artifactReference,
          retention: "retained",
          availability: "missing",
        };
      },
    };
    let countCalls = 0;
    let summaryBody: Readonly<Record<string, unknown>> | undefined;
    const runner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Readonly<Record<string, unknown>>;
      if (request.url.endsWith("/responses/input_tokens")) {
        countCalls += 1;
        return openAIInputTokenCount(countCalls === 1 ? 108_474 : 42);
      }
      if (Number(body.max_output_tokens) === 4_096) {
        summaryBody = body;
        return openAITextStream(
          JSON.stringify({
            version: 1,
            summary: "The exact historical result was summarized.",
            protectedConstraints: [],
          }),
        );
      }
      return openAITextStream("Exact fallback admitted.");
    });

    const result = await runner.run({
      ...rollingRequest(model, journal),
      artifactStore,
    });

    expect(result).toMatchObject({ stopReason: "stop", text: "Exact fallback admitted." });
    expect(inspections).toBe(2);
    expect(countCalls).toBe(3);
    expect(JSON.stringify(summaryBody)).toContain("MISSING_ROLLING_ARTIFACT_RESULT");
    expect(JSON.stringify(summaryBody)).not.toContain("flow.reference-tool-result");
  });

  it("admits a schema-constrained rolling checkpoint tool call", async () => {
    const model = {
      ...openAIModel(),
      compat: {
        supportsForcedToolChoice: true,
        supportsNamedToolChoice: true,
        supportsStrictMode: true,
        supportsToolChoice: true,
      },
    } as const;
    const journal = rollingPressureJournal();
    const protectedConstraints = ["Keep the issue boundary exact."];
    let countCalls = 0;
    let summaryBody: Readonly<Record<string, unknown>> | undefined;
    const runner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Readonly<Record<string, unknown>>;
      if (request.url.endsWith("/responses/input_tokens")) {
        countCalls += 1;
        return openAIInputTokenCount(countCalls === 1 ? 108_474 : 42);
      }
      if (Number(body.max_output_tokens) === 4_096) {
        summaryBody = body;
        return openAIToolCallStream("flow_context_checkpoint", {
          version: 1,
          summary: `The bounded implementation remains unfinished. ${protectedConstraints[0]}`,
          protectedConstraints,
        });
      }
      return openAITextStream("Structured rolling checkpoint admitted.");
    });

    const result = await runner.run({
      ...rollingRequest(model, journal),
      rollingContext: { pressureThresholdPercent: 85, protectedConstraints },
    });

    expect({
      result,
      settlements: journal.state.events
        .filter((event) => event.type === "rolling_context_epoch_settled")
        .map((event) => event.settlement.reason),
    }).toMatchObject({
      result: {
        stopReason: "stop",
        text: "Structured rolling checkpoint admitted.",
      },
      settlements: ["accepted"],
    });
    expect(countCalls).toBe(3);
    expect(summaryBody).toMatchObject({
      tools: [
        expect.objectContaining({
          type: "function",
          name: "flow_context_checkpoint",
          parameters: expect.objectContaining({
            additionalProperties: false,
            required: ["version", "summary", "protectedConstraints"],
          }),
        }),
      ],
    });
    expect(
      journal.state.events
        .filter((event) => event.type === "rolling_context_epoch_settled")
        .map((event) => event.settlement.reason),
    ).toEqual(["accepted"]);
  });

  it("rejects schema-expanded checkpoint tool arguments before retrying", async () => {
    const model = openAIModel();
    const journal = rollingPressureJournal();
    let countCalls = 0;
    const runner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Readonly<Record<string, unknown>>;
      if (request.url.endsWith("/responses/input_tokens")) {
        countCalls += 1;
        return openAIInputTokenCount(countCalls === 1 ? 108_474 : 42);
      }
      const allowance = Number(body.max_output_tokens);
      if (allowance === 4_096) {
        return openAIToolCallStream("flow_context_checkpoint", {
          version: 1,
          summary: "The model tried to expand its checkpoint authority.",
          protectedConstraints: [],
          authority: "model-selected",
        });
      }
      if (allowance === 2_048) {
        return openAIToolCallStream("flow_context_checkpoint", {
          version: 1,
          summary: "The retry retained only the reviewed checkpoint fields.",
          protectedConstraints: [],
        });
      }
      return openAITextStream("Validated retry admitted.");
    });

    const result = await runner.run(rollingRequest(model, journal));

    expect(result).toMatchObject({ stopReason: "stop", text: "Validated retry admitted." });
    expect(
      journal.state.events
        .filter((event) => event.type === "rolling_context_epoch_settled")
        .map((event) => event.settlement.reason),
    ).toEqual(["invalid_output", "accepted"]);
  });

  it("retries one rejected rolling summary with the smaller exact allowance", async () => {
    const model = openAIModel();
    const journal = rollingPressureJournal();
    let countCalls = 0;
    const inferenceAllowances: number[] = [];
    const runner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Readonly<Record<string, unknown>>;
      const allowance = Number(body.max_output_tokens);
      if (request.url.endsWith("/responses/input_tokens")) {
        countCalls += 1;
        return openAIInputTokenCount(countCalls === 1 ? 108_474 : 42);
      }
      inferenceAllowances.push(allowance);
      if (allowance === 4_096) return openAITextStream("not canonical summary JSON");
      if (allowance === 2_048) {
        return openAITextStream(
          JSON.stringify({
            version: 1,
            summary: "The historical request completed after one retry.",
            protectedConstraints: [],
          }),
        );
      }
      return openAITextStream("Retried rolling context admitted.");
    });

    const result = await runner.run(rollingRequest(model, journal));

    expect(result).toMatchObject({
      stopReason: "stop",
      text: "Retried rolling context admitted.",
    });
    expect(inferenceAllowances).toEqual([4_096, 2_048, 128_000]);
    expect(
      journal.state.events
        .filter((event) => event.type === "rolling_context_epoch_started")
        .map((event) => event.outputTokenLimit),
    ).toEqual([4_096, 2_048]);
    expect(
      journal.state.events
        .filter((event) => event.type === "rolling_context_epoch_settled")
        .map((event) => event.settlement.reason),
    ).toEqual(["invalid_output", "accepted"]);
  });

  it("stops rolling compaction after one exhausted-credit response", async () => {
    const model = openAIModel();
    const journal = rollingPressureJournal();
    let countCalls = 0;
    let inferenceCalls = 0;
    const runner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/responses/input_tokens")) {
        countCalls += 1;
        return openAIInputTokenCount(countCalls === 1 ? 108_474 : 42);
      }
      inferenceCalls += 1;
      return Response.json(
        {
          error: {
            type: "insufficient_quota",
            code: "credit_balance_exhausted",
            message:
              "You have no credits. Add credits at https://platform.openai.com/settings/organization/billing.",
          },
        },
        { status: 429 },
      );
    });

    const result = await runner.run(rollingRequest(model, journal));

    expect(result).toMatchObject({
      stopReason: "error",
      failureCode: "pi_provider_quota_exhausted",
    });
    expect(countCalls).toBe(2);
    expect(inferenceCalls).toBe(1);
    expect(journal.state.activeRollingEpoch).toBeNull();
    expect(
      journal.state.events
        .filter((event) => event.type === "rolling_context_epoch_settled")
        .map((event) => event.settlement),
    ).toEqual([expect.objectContaining({ outcome: "rejected", reason: "provider_error" })]);
  });

  it("charges rejected rolling summary usage to the failed node", async () => {
    const model = openAIModel();
    const journal = rollingPressureJournal();
    let countCalls = 0;
    const runner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Readonly<Record<string, unknown>>;
      if (request.url.endsWith("/responses/input_tokens")) {
        countCalls += 1;
        return openAIInputTokenCount(countCalls === 1 ? 108_474 : 42);
      }
      const allowance = Number(body.max_output_tokens);
      if (allowance === 4_096 || allowance === 2_048) {
        return openAITextStream("not canonical summary JSON");
      }
      throw new Error("failed compaction must not reach task inference");
    });

    const result = await runner.run(rollingRequest(model, journal));

    expect(result).toMatchObject({
      stopReason: "error",
      failureCode: "pi_model_context_capacity_exceeded",
      usage: {
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 2,
      },
    });
    expect(
      journal.state.events
        .filter((event) => event.type === "rolling_context_epoch_settled")
        .map((event) => event.settlement.reason),
    ).toEqual(["invalid_output", "invalid_output"]);
  });

  it("settles the rolling epoch when summary usage is invalid", async () => {
    const model = openAIModel();
    const journal = rollingPressureJournal();
    let countCalls = 0;
    let inferenceCalls = 0;
    const runner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/responses/input_tokens")) {
        countCalls += 1;
        return openAIInputTokenCount(countCalls === 1 ? 108_474 : 42);
      }
      inferenceCalls += 1;
      return openAITextStream(
        JSON.stringify({
          version: 1,
          summary: "This candidate has invalid provider usage.",
          protectedConstraints: [],
        }),
        0.5,
      );
    });

    const result = await runner.run(rollingRequest(model, journal));

    expect(result).toMatchObject({ stopReason: "error" });
    expect(inferenceCalls).toBe(1);
    expect(journal.state.activeRollingEpoch).toBeNull();
    expect(
      journal.state.events
        .filter((event) => event.type === "rolling_context_epoch_settled")
        .map((event) => event.settlement),
    ).toEqual([{ outcome: "rejected", reason: "provider_error" }]);
  });

  it("interrupts the rolling epoch when cancellation reaches summary counting", async () => {
    const model = openAIModel();
    const journal = rollingPressureJournal();
    const controller = new AbortController();
    let countCalls = 0;
    let inferenceCalls = 0;
    const runner = openAIRunner(model, async (input) => {
      const request = new Request(input);
      if (request.url.endsWith("/responses/input_tokens")) {
        countCalls += 1;
        if (countCalls === 1) return openAIInputTokenCount(108_474);
        controller.abort(new Error("cancelled during summary count"));
        throw new Error("summary count transport stopped");
      }
      inferenceCalls += 1;
      return openAITextStream("unexpected inference");
    });

    const result = await runner.run({
      ...rollingRequest(model, journal),
      signal: controller.signal,
    });

    expect(result).toMatchObject({ stopReason: "aborted" });
    expect(result).not.toHaveProperty("failureCode");
    expect(countCalls).toBe(2);
    expect(inferenceCalls).toBe(0);
    expect(journal.state.activeRollingEpoch).toBeNull();
    expect(
      journal.state.events
        .filter((event) => event.type === "rolling_context_epoch_settled")
        .map((event) => event.settlement),
    ).toEqual([{ outcome: "interrupted", reason: "process_interrupted" }]);
  });

  it("fails before an epoch when the fixed summary allowance has no safe floor", async () => {
    const baseModel = openAIModel();
    const model = {
      ...baseModel,
      contextWindow: 20_000,
      maxTokens: 128_000,
    } as unknown as typeof baseModel;
    const journal = rollingPressureJournal();
    let countCalls = 0;
    let inferenceCalls = 0;
    const runner = openAIRunner(
      model,
      async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/responses/input_tokens")) {
          countCalls += 1;
          return openAIInputTokenCount(2_204);
        }
        inferenceCalls += 1;
        return openAITextStream("unexpected inference");
      },
      (payload, serialization) =>
        serialization === 1 && typeof payload === "object" && payload !== null
          ? { ...payload, max_output_tokens: 1_024 }
          : payload,
    );

    const result = await runner.run(rollingRequest(model, journal));

    expect(result).toMatchObject({
      stopReason: "error",
      failureCode: "pi_model_context_floor_exhausted",
    });
    expect(countCalls).toBe(1);
    expect(inferenceCalls).toBe(0);
    expect(journal.state.activeRollingEpoch).toBeNull();
    expect(
      journal.state.events.filter((event) => event.type.startsWith("rolling_context_epoch_")),
    ).toEqual([]);
  });

  it("fails before an epoch when the model output limit is below the fixed summary allowance", async () => {
    const baseModel = openAIModel();
    const model = {
      ...baseModel,
      maxTokens: 1_024,
    } as unknown as typeof baseModel;
    const journal = rollingPressureJournal();
    let countCalls = 0;
    let inferenceCalls = 0;
    const runner = openAIRunner(model, async (input) => {
      const request = new Request(input);
      if (request.url.endsWith("/responses/input_tokens")) {
        countCalls += 1;
        return openAIInputTokenCount(220_000);
      }
      inferenceCalls += 1;
      return openAITextStream("unexpected inference");
    });

    const result = await runner.run(rollingRequest(model, journal));

    expect(result).toMatchObject({
      stopReason: "error",
      failureCode: "pi_model_context_floor_exhausted",
    });
    expect(countCalls).toBe(1);
    expect(inferenceCalls).toBe(0);
    expect(journal.state.activeRollingEpoch).toBeNull();
    expect(
      journal.state.events.filter((event) => event.type.startsWith("rolling_context_epoch_")),
    ).toEqual([]);
  });

  it("disables Anthropic summary thinking and preserves exact summary allowances", async () => {
    const model = anthropicModel();
    const journal = rollingPressureJournal();
    let countCalls = 0;
    const summaryPayloads: Readonly<Record<string, unknown>>[] = [];
    const runner = anthropicRunner(model, async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Readonly<Record<string, unknown>>;
      if (request.url.endsWith("/messages/count_tokens")) {
        countCalls += 1;
        return Response.json({ input_tokens: countCalls === 1 ? 781_674 : 42 });
      }
      summaryPayloads.push(body);
      return Response.json({ error: { message: "fixture summary rejection" } }, { status: 500 });
    });

    const result = await runner.run({
      ...agentRequest(model as never, journal),
      provider: model.provider,
      model: model.id,
      thinking: "high",
      contextCompactionMode: "rolling",
      rollingContext: { pressureThresholdPercent: 85, protectedConstraints: [] },
    });

    expect(result).toMatchObject({
      stopReason: "error",
      failureCode: "pi_model_context_capacity_exceeded",
    });
    expect(summaryPayloads.map((payload) => payload.max_tokens)).toEqual([4_096, 2_048]);
    expect(summaryPayloads.map((payload) => payload.thinking)).toEqual([
      { type: "disabled" },
      { type: "disabled" },
    ]);
    expect(
      journal.state.events
        .filter((event) => event.type === "model_request_capacity_checked")
        .flatMap((event) =>
          event.measurement.status === "measured"
            ? [
                {
                  method: event.measurement.method,
                  allowance: event.measurement.evaluation.outputAllowanceTokens,
                },
              ]
            : [],
        ),
    ).toEqual([
      { method: "provider_estimate", allowance: 64_000 },
      { method: "provider_estimate", allowance: 4_096 },
      { method: "provider_estimate", allowance: 2_048 },
    ]);
  });

  it("feeds a later epoch only the previous summary and newly eligible delta", async () => {
    const model = openAIModel();
    const journal = rollingPressureJournal();
    let firstCount = 0;
    const firstRunner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Readonly<Record<string, unknown>>;
      if (request.url.endsWith("/responses/input_tokens")) {
        firstCount += 1;
        return openAIInputTokenCount(firstCount === 1 ? 108_474 : 42);
      }
      return Number(body.max_output_tokens) === 4_096
        ? openAITextStream(
            JSON.stringify({
              version: 1,
              summary: "First rolling checkpoint.",
              protectedConstraints: [],
            }),
          )
        : openAITextStream("FIRST_POST_CHECKPOINT_TASK");
    });
    await firstRunner.run(rollingRequest(model, journal));
    const firstRange = journal.state.currentRollingCheckpoint?.cumulativeRange;
    if (firstRange === undefined) throw new Error("first rolling checkpoint is missing");
    journal.state = append(
      journal.state,
      { type: "attempt_interrupted", attempt: 2, reason: "process_interrupted" },
      journal.state.eventCount + 1,
    );
    journal.state = append(
      journal.state,
      { type: "attempt_started", attempt: 3 },
      journal.state.eventCount + 1,
    );
    let secondCount = 0;
    let secondSummaryBody: Readonly<Record<string, unknown>> | undefined;
    let secondTaskBody: Readonly<Record<string, unknown>> | undefined;
    const secondRunner = openAIRunner(model, async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Readonly<Record<string, unknown>>;
      if (request.url.endsWith("/responses/input_tokens")) {
        secondCount += 1;
        return openAIInputTokenCount(secondCount === 1 ? 108_474 : 42);
      }
      if (Number(body.max_output_tokens) === 4_096) {
        secondSummaryBody = body;
        return openAITextStream(
          JSON.stringify({
            version: 1,
            summary: "Second cumulative rolling checkpoint.",
            protectedConstraints: [],
          }),
        );
      }
      secondTaskBody = body;
      return openAITextStream("SECOND_POST_CHECKPOINT_TASK");
    });

    const result = await secondRunner.run(rollingRequest(model, journal));

    expect(result).toMatchObject({ stopReason: "stop", text: "SECOND_POST_CHECKPOINT_TASK" });
    const summaryJson = JSON.stringify(secondSummaryBody);
    expect(summaryJson).toContain("First rolling checkpoint.");
    expect(summaryJson).toContain("RECENT_ROLLING_CONTEXT_2");
    expect(summaryJson).not.toContain("OLD_ROLLING_CONTEXT");
    const taskJson = JSON.stringify(secondTaskBody);
    expect(taskJson).toContain("Second cumulative rolling checkpoint.");
    expect(taskJson).toContain("RECENT_ROLLING_CONTEXT_3");
    expect(taskJson).toContain("FIRST_POST_CHECKPOINT_TASK");
    expect(taskJson).not.toContain("RECENT_ROLLING_CONTEXT_2");
    expect(journal.state).toMatchObject({
      rollingEpochCount: 2,
      acceptedRollingEpochCount: 2,
      currentRollingCheckpoint: {
        summaryText: "Second cumulative rolling checkpoint.",
      },
    });
    expect(journal.state.currentRollingCheckpoint?.cumulativeRange.lastSequence).toBeGreaterThan(
      firstRange.lastSequence,
    );
  });

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
      runtimeVersion: "pi-0.84.4",
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

  it("does not mistake a selected model token limit for a byte limit without opt-in", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false, contextWindow: 32_768 }],
    });
    const model = requireModel(faux.getModel());
    let providerCalls = 0;
    faux.setResponses([
      () => {
        providerCalls += 1;
        return fauxAssistantMessage("Provider request admitted.");
      },
    ]);
    const journal = attemptOneJournal();

    const result = await runnerFor(faux, model).run(agentRequest(model, journal));

    expect(providerCalls).toBe(1);
    expect(result).toMatchObject({ stopReason: "stop", text: "Provider request admitted." });
    expect(journal.state.events.at(-1)?.type).toBe("model_request_settled");
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

  it("accepts one bounded summary, preserves protected surfaces, and accounts for its usage", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false }],
    });
    const model = requireModel(faux.getModel());
    const journal = attemptOneJournal();
    const protectedConstraint = "Never change release policy.";
    const protectedConstraints = [protectedConstraint];
    let summaryPrompt = "";
    let summaryMaxTokens: number | undefined;
    let finalProviderMessages: unknown[] = [];
    let finalProviderTools: unknown[] = [];
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText(`OLD_CONTEXT:${"x".repeat(12_000)}`),
          fauxToolCall("flow_ls", { path: ".", limit: 1 }, { id: "tool-call-1" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxText("LATEST_CONTEXT"),
          fauxToolCall("flow_ls", { path: ".", limit: 1 }, { id: "tool-call-2" }),
        ],
        { stopReason: "toolUse" },
      ),
      (context, options) => {
        summaryPrompt = JSON.stringify(context);
        summaryMaxTokens = options?.maxTokens;
        return fauxAssistantMessage(
          JSON.stringify({
            version: 1,
            summary: `The first inspection completed. ${protectedConstraint}`,
            protectedConstraints,
          }),
        );
      },
      (context) => {
        finalProviderMessages = context.messages;
        finalProviderTools = context.tools ?? [];
        return fauxAssistantMessage("Compacted context observed.");
      },
    ]);

    const result = await runnerFor(faux, model).run({
      ...agentRequest(model, journal),
      contextCompactionMode: "references-and-summary",
      contextSummary: {
        protectedConstraints,
        minimumReductionBytes: 1_000,
        outputTokenLimits: [512, 256],
      },
    });

    expect({
      stopReason: result.stopReason,
      errorMessage: result.errorMessage,
      durableTail: journal.state.events.slice(-4).map((event) => event.type),
    }).toEqual({
      stopReason: "stop",
      errorMessage: undefined,
      durableTail: [
        "context_compaction_settled",
        "model_request_prepared",
        "model_message_committed",
        "model_request_settled",
      ],
    });
    expect(faux.state.callCount).toBe(4);
    expect(summaryMaxTokens).toBe(512);
    expect(summaryPrompt).toContain("OLD_CONTEXT");
    expect(summaryPrompt).toContain(protectedConstraints[0]);
    expect(summaryPrompt).not.toContain("LATEST_CONTEXT");
    expect(finalProviderMessages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(finalProviderMessages[0])).toContain('"text":"Original objective."');
    const summaryMessage = finalProviderMessages[1] as { role?: unknown; content?: unknown };
    expect(summaryMessage.role).toBe("user");
    expect(typeof summaryMessage.content).toBe("string");
    expect(JSON.parse(summaryMessage.content as string)).toMatchObject({
      version: 1,
      kind: "flow.context-summary",
      protectedConstraints,
      summary: expect.stringContaining(protectedConstraint),
    });
    expect(JSON.stringify(finalProviderMessages)).toContain("LATEST_CONTEXT");
    expect(JSON.stringify(finalProviderMessages)).not.toContain("OLD_CONTEXT");
    expect(finalProviderTools).toHaveLength(1);

    const starts = journal.state.events.filter(
      (event) => event.type === "context_compaction_started",
    );
    const settlements = journal.state.events.filter(
      (event) => event.type === "context_compaction_settled",
    );
    expect(starts).toHaveLength(1);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      settlement: {
        outcome: "accepted",
        reason: "accepted",
        usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
        constraints: { checked: 1, retained: 1 },
        surface: { minimumReductionBytes: 1_000 },
      },
    });
    const mainUsage = journal.state.events
      .filter((event) => event.type === "model_message_committed")
      .flatMap((event) => (event.usage === undefined ? [] : [event.usage]))
      .reduce(addUsage, emptyUsage());
    const summaryUsage = settlements.flatMap((event) =>
      event.settlement.outcome === "interrupted" || event.settlement.usage === undefined
        ? []
        : [event.settlement.usage],
    );
    expect(result.usage).toEqual(summaryUsage.reduce(addUsage, mainUsage));
  });

  it("stops references-and-summary compaction after one exhausted-credit response", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false }],
    });
    const model = requireModel(faux.getModel());
    const journal = attemptOneJournal();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText(`OLD_CONTEXT:${"x".repeat(12_000)}`),
          fauxToolCall("flow_ls", { path: ".", limit: 1 }, { id: "tool-call-1" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxText("LATEST_CONTEXT"),
          fauxToolCall("flow_ls", { path: ".", limit: 1 }, { id: "tool-call-2" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage:
          'OpenAI API error (429): {"type":"insufficient_quota","code":"credit_balance_exhausted"}',
      }),
    ]);

    const result = await runnerFor(faux, model).run({
      ...agentRequest(model, journal),
      contextCompactionMode: "references-and-summary",
      contextSummary: {
        protectedConstraints: ["Never change release policy."],
        minimumReductionBytes: 1_000,
        outputTokenLimits: [512, 256],
      },
    });

    expect(result).toMatchObject({
      stopReason: "error",
      failureCode: "pi_provider_quota_exhausted",
    });
    expect(faux.state.callCount).toBe(3);
    expect(
      journal.state.events
        .filter((event) => event.type === "context_compaction_settled")
        .map((event) => event.settlement),
    ).toEqual([expect.objectContaining({ outcome: "rejected", reason: "provider_error" })]);
    const mainUsage = journal.state.events
      .filter((event) => event.type === "model_message_committed")
      .flatMap((event) => (event.usage === undefined ? [] : [event.usage]))
      .reduce(addUsage, emptyUsage());
    const quotaSettlement = journal.state.events.find(
      (event) => event.type === "context_compaction_settled",
    );
    if (
      quotaSettlement?.type !== "context_compaction_settled" ||
      quotaSettlement.settlement.outcome === "interrupted" ||
      quotaSettlement.settlement.usage === undefined
    ) {
      throw new Error("quota compaction usage was not settled");
    }
    expect(quotaSettlement.settlement.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage).toEqual(addUsage(mainUsage, quotaSettlement.settlement.usage));
  });

  it("retries once with a smaller limit and retains the prior surface after rejection", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false }],
    });
    const model = requireModel(faux.getModel());
    const journal = attemptOneJournal();
    const protectedConstraint = "Never change release policy.";
    const summaryLimits: number[] = [];
    let finalProviderMessages: unknown[] = [];
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText(`OLD_CONTEXT_RETAINED:${"y".repeat(12_000)}`),
          fauxToolCall("flow_ls", { path: ".", limit: 1 }, { id: "tool-call-1" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxText("LATEST_CONTEXT_RETAINED"),
          fauxToolCall("flow_ls", { path: ".", limit: 1 }, { id: "tool-call-2" }),
        ],
        { stopReason: "toolUse" },
      ),
      (_context, options) => {
        summaryLimits.push(options?.maxTokens ?? -1);
        return fauxAssistantMessage(
          JSON.stringify({
            version: 1,
            summary: "The first inspection completed under a changed policy.",
            protectedConstraints: ["Change release policy."],
          }),
        );
      },
      (_context, options) => {
        summaryLimits.push(options?.maxTokens ?? -1);
        return fauxAssistantMessage("not canonical summary JSON");
      },
      (context) => {
        finalProviderMessages = context.messages;
        return fauxAssistantMessage("Original context observed.");
      },
    ]);

    const result = await runnerFor(faux, model).run({
      ...agentRequest(model, journal),
      contextCompactionMode: "references-and-summary",
      contextSummary: {
        protectedConstraints: [protectedConstraint],
        minimumReductionBytes: 1_000,
        outputTokenLimits: [512, 256],
      },
    });

    expect(result.stopReason).toBe("stop");
    expect(faux.state.callCount).toBe(5);
    expect(summaryLimits).toEqual([512, 256]);
    expect(JSON.stringify(finalProviderMessages)).toContain("OLD_CONTEXT_RETAINED");
    expect(JSON.stringify(finalProviderMessages)).toContain("LATEST_CONTEXT_RETAINED");
    expect(JSON.stringify(finalProviderMessages)).not.toContain("flow.context-summary");
    expect(
      journal.state.events
        .filter((event) => event.type === "context_compaction_started")
        .map((event) => event.outputTokenLimit),
    ).toEqual([512, 256]);
    expect(
      journal.state.events
        .filter((event) => event.type === "context_compaction_settled")
        .map((event) => event.settlement.reason),
    ).toEqual(["constraint_loss", "invalid_output"]);
  });

  it("retries an interrupted compaction after recovery with the smaller limit", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false }],
    });
    const model = requireModel(faux.getModel());
    const journal = attemptTwoAfterInterruptedCompactionJournal();
    const protectedConstraint = "Never change release policy.";
    let summaryPrompt = "";
    let summaryMaxTokens: number | undefined;
    let finalProviderMessages: unknown[] = [];
    faux.setResponses([
      (context, options) => {
        summaryPrompt = JSON.stringify(context);
        summaryMaxTokens = options?.maxTokens;
        return fauxAssistantMessage(
          JSON.stringify({
            version: 1,
            summary: `The first recovered inspection completed. ${protectedConstraint}`,
            protectedConstraints: [protectedConstraint],
          }),
        );
      },
      (context) => {
        finalProviderMessages = context.messages;
        return fauxAssistantMessage("Recovered compacted context observed.");
      },
    ]);

    const result = await runnerFor(faux, model).run({
      ...agentRequest(model, journal),
      contextCompactionMode: "references-and-summary",
      contextSummary: {
        protectedConstraints: [protectedConstraint],
        minimumReductionBytes: 1_000,
        outputTokenLimits: [512, 256],
      },
    });

    expect(result.stopReason).toBe("stop");
    expect(faux.state.callCount).toBe(2);
    expect(summaryMaxTokens).toBe(256);
    expect(summaryPrompt).toContain("OLD_RECOVERY_CONTEXT");
    expect(summaryPrompt).not.toContain("LATEST_RECOVERY_CONTEXT");
    expect(finalProviderMessages[0]).toMatchObject({
      role: "user",
      content: "Original objective.",
    });
    expect(JSON.stringify(finalProviderMessages)).toContain("flow.context-summary");
    expect(JSON.stringify(finalProviderMessages)).toContain("LATEST_RECOVERY_CONTEXT");
    expect(JSON.stringify(finalProviderMessages)).not.toContain("OLD_RECOVERY_CONTEXT");
    expect(
      journal.state.events
        .filter((event) => event.type === "context_compaction_started")
        .map((event) => event.outputTokenLimit),
    ).toEqual([512, 256]);
    expect(journal.state.acceptedCompactionCount).toBe(1);
    expect(journal.state.interruptedCompactionCount).toBe(1);
  });

  it("does not call a summary or task provider when compaction write-ahead fails", async () => {
    const faux = createFauxCore({
      provider: "flow-session-test",
      models: [{ id: "session-model", reasoning: false }],
    });
    const model = requireModel(faux.getModel());
    const base = attemptOneJournal();
    const journal: ModelSessionJournal = {
      get state() {
        return base.state;
      },
      read: base.read,
      async append(input) {
        if (input.type === "context_compaction_started") {
          throw new Error("compaction journal unavailable");
        }
        return await base.append(input);
      },
    };
    let unexpectedProviderCalls = 0;
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText(`OLD_WRITE_AHEAD_CONTEXT:${"z".repeat(12_000)}`),
          fauxToolCall("flow_ls", { path: ".", limit: 1 }, { id: "tool-call-1" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("flow_ls", { path: ".", limit: 1 }, { id: "tool-call-2" }),
        { stopReason: "toolUse" },
      ),
      () => {
        unexpectedProviderCalls += 1;
        return fauxAssistantMessage("must not run");
      },
    ]);

    const result = await runnerFor(faux, model).run({
      ...agentRequest(model, journal),
      contextCompactionMode: "references-and-summary",
      contextSummary: {
        protectedConstraints: ["Never change release policy."],
        minimumReductionBytes: 1_000,
        outputTokenLimits: [512, 256],
      },
    });

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "compaction journal unavailable",
    });
    expect(faux.state.callCount).toBe(2);
    expect(unexpectedProviderCalls).toBe(0);
    expect(
      base.state.events.filter((event) => event.type.startsWith("context_compaction_")),
    ).toEqual([]);
  });
});

function openAIModel() {
  return {
    id: "gpt-5.6",
    name: "GPT-5.6",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://provider.example/v1",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  } as const;
}

function anthropicModel() {
  return {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://anthropic.example/v1",
    reasoning: true,
    compat: { forceAdaptiveThinking: true },
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  } as const;
}

function openAIRunner(
  model: ReturnType<typeof openAIModel>,
  providerFetch: typeof fetch,
  transformPayload?: (payload: unknown, serialization: number) => unknown,
): EmbeddedPiAgentRunner {
  let serialization = 0;
  const modelRuntime = {
    getModel: (provider: string, modelId: string) =>
      provider === model.provider && modelId === model.id ? model : undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => undefined,
    isUsingOAuth: () => false,
    streamSimple: (
      selected: typeof model,
      context: Parameters<typeof openAIResponsesStreamSimple>[1],
      options: Parameters<typeof openAIResponsesStreamSimple>[2],
    ) =>
      openAIResponsesStreamSimple(selected, context, {
        ...options,
        apiKey: "test-key",
        ...(transformPayload === undefined
          ? {}
          : {
              onPayload: async (payload, selectedModel) => {
                const replacement = await options?.onPayload?.(payload, selectedModel);
                serialization += 1;
                return transformPayload(replacement ?? payload, serialization);
              },
            }),
      }),
  };
  return new EmbeddedPiAgentRunner(
    async () => modelRuntime as never,
    createAgentSession,
    providerFetch,
  );
}

function anthropicRunner(
  model: ReturnType<typeof anthropicModel>,
  providerFetch: typeof fetch,
): EmbeddedPiAgentRunner {
  const modelRuntime = {
    getModel: (provider: string, modelId: string) =>
      provider === model.provider && modelId === model.id ? model : undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => undefined,
    isUsingOAuth: () => false,
    streamSimple: (
      selected: typeof model,
      context: Parameters<typeof anthropicMessagesStreamSimple>[1],
      options: Parameters<typeof anthropicMessagesStreamSimple>[2],
    ) =>
      anthropicMessagesStreamSimple(selected, context, {
        ...options,
        apiKey: "test-key",
      }),
  };
  return new EmbeddedPiAgentRunner(
    async () => modelRuntime as never,
    createAgentSession,
    providerFetch,
  );
}

function rollingRequest(
  model: ReturnType<typeof openAIModel>,
  journal: ModelSessionJournal,
): PiAgentRunRequest {
  return {
    ...agentRequest(model as never, journal),
    provider: model.provider,
    model: model.id,
    thinking: "high",
    contextCompactionMode: "rolling",
    rollingContext: { pressureThresholdPercent: 85, protectedConstraints: [] },
  };
}

function openAITextStream(text: string, inputTokens = 100): Response {
  const item = {
    id: "message-1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: "response-1",
    status: "completed",
    output: [item],
    usage: {
      input_tokens: inputTokens,
      output_tokens: 10,
      total_tokens: inputTokens + 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const events = [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function openAIToolCallStream(name: string, args: Readonly<Record<string, unknown>>): Response {
  const reasoningItem = {
    id: "reasoning-1",
    type: "reasoning",
    summary: [],
  };
  const item = {
    id: "function-1",
    type: "function_call",
    status: "completed",
    call_id: "call-1",
    name,
    arguments: JSON.stringify(args),
  };
  const response = {
    id: "response-1",
    status: "completed",
    output: [reasoningItem, item],
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const events = [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: reasoningItem },
    { type: "response.output_item.done", output_index: 0, item: reasoningItem },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...item, arguments: "" },
    },
    { type: "response.output_item.done", output_index: 1, item },
    { type: "response.completed", response },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function openAIInputTokenCount(inputTokens: number): Response {
  return Response.json({ object: "response.input_tokens", input_tokens: inputTokens });
}

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

function rollingPressureJournal(
  projection?: Readonly<{
    fullText: string;
    projectedText: string;
    artifactReferences: readonly string[];
  }>,
): InMemoryJournal {
  let state = attemptOneJournal().state;
  for (const [request, text] of [
    [1, `OLD_ROLLING_CONTEXT:${"o".repeat(24_000)}`],
    [2, `RECENT_ROLLING_CONTEXT_2:${"r".repeat(12_000)}`],
    [3, "RECENT_ROLLING_CONTEXT_3"],
  ] as const) {
    state = append(
      state,
      {
        type: "model_request_prepared",
        attempt: 1,
        turn: request,
        request,
        identity: {
          version: 1,
          provider: "openai",
          model: "gpt-5.6",
          apiAdapter: "openai-responses",
          thinking: "high",
          runtimeVersion: "pi-0.84.4",
          system: { sha256: "1".repeat(64), bytes: 1 },
          toolCatalog: { sha256: "2".repeat(64), bytes: 1, count: 1 },
          authority: { sha256: "3".repeat(64) },
          portableHistory: calculatePortableHistoryIdentity(state),
          runtimeSurface: { sha256: "5".repeat(64), bytes: 1 },
          attempt: 1,
          turn: request,
          request,
        },
      },
      state.eventCount + 1,
    );
    state = append(
      state,
      {
        type: "model_message_committed",
        attempt: 1,
        turn: request,
        request,
        text,
        stopReason: "stop",
      },
      state.eventCount + 1,
    );
    if (request === 1 && projection !== undefined) {
      state = append(
        state,
        {
          type: "tool_call_committed",
          attempt: 1,
          turn: request,
          request,
          toolCallId: "rolling-tool-call-1",
          toolName: "flow_exec",
          argumentsJson: "{}",
        },
        state.eventCount + 1,
      );
      state = append(
        state,
        {
          type: "tool_result_committed",
          attempt: 1,
          turn: request,
          request,
          toolCallId: "rolling-tool-call-1",
          toolName: "flow_exec",
          text: projection.fullText,
          isError: false,
          referenceProjection: {
            text: projection.projectedText,
            originalBytes: Buffer.byteLength(projection.fullText),
            projectedBytes: Buffer.byteLength(projection.projectedText),
            artifactReferences: projection.artifactReferences,
          },
        },
        state.eventCount + 1,
      );
    }
    state = append(
      state,
      {
        type: "model_request_settled",
        attempt: 1,
        turn: request,
        request,
        outcome: "completed",
      },
      state.eventCount + 1,
    );
  }
  state = append(
    state,
    { type: "attempt_interrupted", attempt: 1, reason: "process_interrupted" },
    state.eventCount + 1,
  );
  state = append(state, { type: "attempt_started", attempt: 2 }, state.eventCount + 1);
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
        runtimeVersion: "pi-0.84.4",
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

function attemptTwoAfterInterruptedCompactionJournal(): InMemoryJournal {
  let state = attemptOneJournal().state;
  for (const [request, text] of [
    [1, `OLD_RECOVERY_CONTEXT:${"r".repeat(12_000)}`],
    [2, "LATEST_RECOVERY_CONTEXT"],
  ] as const) {
    state = append(
      state,
      {
        type: "model_request_prepared",
        attempt: 1,
        turn: request,
        request,
        identity: {
          version: 1,
          provider: "flow-session-test",
          model: "session-model",
          apiAdapter: "faux",
          thinking: "off",
          runtimeVersion: "pi-0.84.4",
          system: { sha256: "1".repeat(64), bytes: 1 },
          toolCatalog: { sha256: "2".repeat(64), bytes: 1, count: 1 },
          authority: { sha256: "3".repeat(64) },
          portableHistory: calculatePortableHistoryIdentity(state),
          runtimeSurface: { sha256: "5".repeat(64), bytes: 1 },
          attempt: 1,
          turn: request,
          request,
        },
      },
      state.eventCount + 1,
    );
    state = append(
      state,
      {
        type: "model_message_committed",
        attempt: 1,
        turn: request,
        request,
        text,
        stopReason: "stop",
      },
      state.eventCount + 1,
    );
    state = append(
      state,
      {
        type: "model_request_settled",
        attempt: 1,
        turn: request,
        request,
        outcome: "completed",
      },
      state.eventCount + 1,
    );
  }
  const selection = selectContextCompactionRange(state);
  if (selection === null) throw new Error("recovery fixture must have a compactable range");
  state = append(
    state,
    {
      type: "context_compaction_started",
      attempt: 1,
      compaction: 1,
      generationAttempt: 1,
      mode: "references-and-summary",
      sourceHead: state.head,
      range: selection.range,
      referenceSurface: {
        sha256: "6".repeat(64),
        bytes: 12_000,
        estimatedTokens: 3_000,
      },
      outputTokenLimit: 512,
    },
    state.eventCount + 1,
  );
  state = append(
    state,
    {
      type: "context_compaction_settled",
      attempt: 1,
      compaction: 1,
      generationAttempt: 1,
      settlement: { outcome: "interrupted", reason: "process_interrupted" },
    },
    state.eventCount + 1,
  );
  state = append(
    state,
    { type: "attempt_interrupted", attempt: 1, reason: "process_interrupted" },
    state.eventCount + 1,
  );
  state = append(state, { type: "attempt_started", attempt: 2 }, state.eventCount + 1);
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

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdMicros: 0,
  };
}

function addUsage(left: ReturnType<typeof emptyUsage>, right: ReturnType<typeof emptyUsage>) {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    costUsdMicros: left.costUsdMicros + right.costUsdMicros,
  };
}
