import { describe, expect, it } from "vitest";
import { inspectRunModelSessions } from "../../../src/application/model-session-inspection.js";
import type { ModelSessionStore } from "../../../src/application/ports.js";
import type { RunState } from "../../../src/domain/run/events.js";
import {
  createModelSession,
  createModelSessionEvent,
  type ModelSessionIdentity,
  type ModelSessionState,
  modelSessionSummary,
  reduceModelSessionEvents,
} from "../../../src/domain/run/model-session.js";

const identity: ModelSessionIdentity = {
  runId: "run-inspect",
  workflowId: "inspect-workflow",
  nodeId: "analyze",
};

describe("model session public inspection", () => {
  it("refreshes safe metadata without exposing private session content", async () => {
    const state = privateSession();
    const runState = publicRunState(modelSessionSummary(state));
    const store = storeReturning(state);

    const inspected = await inspectRunModelSessions(runState, store);
    const serialized = JSON.stringify(inspected);

    expect(inspected).toMatchObject({
      nodes: {
        analyze: {
          modelSession: {
            sessionId: state.sessionId,
            eventCount: state.eventCount,
            committedBytes: state.committedBytes,
            primaryEventCount: 1,
            mismatchCategories: [],
          },
        },
      },
    });
    expect(serialized).not.toContain("PRIVATE_CONVERSATION_CANARY");
    expect(serialized).not.toContain("events");
    expect(serialized).not.toContain("primaryEvents");
  });

  it("reports only stable mismatch categories when replay is unavailable", async () => {
    const state = privateSession();
    const runState = publicRunState(modelSessionSummary(state));
    const store = storeReturning(
      new Error(
        "PRIVATE_ACTUAL_DIGEST model request identity mismatch: portable_history,tool_catalog",
      ),
    );

    const inspected = await inspectRunModelSessions(runState, store);
    const serialized = JSON.stringify(inspected);

    expect(inspected).toMatchObject({
      nodes: {
        analyze: {
          modelSession: {
            inspectionStatus: "unavailable",
            mismatchCategories: ["tool_catalog", "portable_history"],
          },
        },
      },
    });
    expect(serialized).not.toContain("PRIVATE_ACTUAL_DIGEST");
  });
});

function privateSession(): ModelSessionState {
  let state = createModelSession(identity, "2026-08-22T00:00:00.000Z").state;
  state = append(state, { type: "attempt_started", attempt: 1 });
  state = append(state, {
    type: "user_message_committed",
    attempt: 1,
    origin: "primary_prompt",
    text: "PRIVATE_CONVERSATION_CANARY",
  });
  return state;
}

function publicRunState(summary: ReturnType<typeof modelSessionSummary>): RunState {
  return {
    runId: identity.runId,
    workflowId: identity.workflowId,
    nodes: { analyze: { modelSession: summary } },
  } as unknown as RunState;
}

function storeReturning(result: ModelSessionState | Error): ModelSessionStore {
  return {
    async read() {
      if (result instanceof Error) throw result;
      return result;
    },
    async create() {
      throw new Error("not used");
    },
    async append() {
      throw new Error("not used");
    },
    async claim() {
      throw new Error("not used");
    },
    async release() {},
  };
}

function append(
  state: ModelSessionState,
  input: Parameters<typeof createModelSessionEvent>[1],
): ModelSessionState {
  const event = createModelSessionEvent(state, input, "2026-08-22T00:00:01.000Z");
  return reduceModelSessionEvents([...state.events, event]);
}
