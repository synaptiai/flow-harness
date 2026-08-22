import type { NodeRunState, RunState } from "../domain/run/events.js";
import {
  type ModelRequestMismatchCategory,
  type ModelSessionSummary,
  modelSessionSummary,
} from "../domain/run/model-session.js";
import type { ModelSessionStore } from "./ports.js";

const MISMATCH_CATEGORIES = Object.freeze([
  "provider",
  "model",
  "api_adapter",
  "thinking",
  "runtime_version",
  "system_instructions",
  "tool_catalog",
  "authority",
  "portable_history",
  "runtime_surface",
  "attempt",
  "turn",
  "request",
] as const satisfies readonly ModelRequestMismatchCategory[]);

type UnavailableModelSession = ModelSessionSummary & {
  readonly inspectionStatus: "unavailable";
};

export async function inspectRunModelSessions(
  state: RunState,
  store: ModelSessionStore,
): Promise<unknown> {
  const nodes = await Promise.all(
    Object.entries(state.nodes).map(async ([nodeId, node]) => [
      nodeId,
      await inspectNodeModelSession(state, nodeId, node, store),
    ]),
  );
  return Object.freeze({ ...state, nodes: Object.freeze(Object.fromEntries(nodes)) });
}

async function inspectNodeModelSession(
  state: RunState,
  nodeId: string,
  node: NodeRunState,
  store: ModelSessionStore,
): Promise<
  NodeRunState | (Omit<NodeRunState, "modelSession"> & { modelSession: UnavailableModelSession })
> {
  const durable = node.modelSession;
  if (durable === null) return node;
  try {
    const privateState = await store.read({
      runId: state.runId,
      workflowId: state.workflowId,
      nodeId,
    });
    const current = modelSessionSummary(privateState);
    if (current.sessionId !== durable.sessionId) {
      throw new Error("model session identity mismatch");
    }
    return Object.freeze({
      ...node,
      modelSession: current,
    });
  } catch (error) {
    const mismatchCategories = extractMismatchCategories(error, durable.mismatchCategories);
    return Object.freeze({
      ...node,
      modelSession: Object.freeze({
        ...durable,
        inspectionStatus: "unavailable" as const,
        mismatchCategories,
      }),
    });
  }
}

function extractMismatchCategories(
  error: unknown,
  existing: readonly ModelRequestMismatchCategory[],
): readonly ModelRequestMismatchCategory[] {
  const reported = new Set<ModelRequestMismatchCategory>(existing);
  for (const message of errorChainMessages(error)) {
    for (const match of message.matchAll(/\bmismatch:\s*([a-z_,]+)/gu)) {
      for (const candidate of (match[1] ?? "").split(",")) {
        if (isMismatchCategory(candidate)) reported.add(candidate);
      }
    }
  }
  return Object.freeze(MISMATCH_CATEGORIES.filter((category) => reported.has(category)));
}

function isMismatchCategory(value: string): value is ModelRequestMismatchCategory {
  return MISMATCH_CATEGORIES.some((category) => category === value);
}

function errorChainMessages(error: unknown): readonly string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return Object.freeze(messages);
}
