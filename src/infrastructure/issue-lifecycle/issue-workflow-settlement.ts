import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import {
  type IssueWorkflowAvailability,
  type IssueWorkflowDispatch,
  type IssueWorkflowSettlement,
  issueWorkflowDispatchSchema,
  issueWorkflowEnvelopeSchema,
  issueWorkflowSettlementSchema,
} from "../../domain/issue-lifecycle/workflow-accounting.js";
import { type RunEvent, type RunState, reduceRunEvents } from "../../domain/run/events.js";
import { calculateWorkflowDigest } from "../../domain/workflow/digest.js";
import type { CompiledWorkflow } from "../../domain/workflow/types.js";
import { JsonlRunStore, RunStoreError } from "../fs/jsonl-run-store.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);
const expectedBindingSchema = z
  .object({
    parentIssueRunId: identifier,
    flowRunId: identifier,
    frozenContractDigest: digest,
    templateWorkflowDigest: digest,
    workspaceIdentityDigest: digest,
    executionCwd: z.string().refine((value) => isAbsolute(value) && resolve(value) === value),
    workspaceAuthorityDigest: digest,
  })
  .strict();

/** The caller derives these bindings from frozen source admission and the host workspace. */
export type IssueWorkflowSettlementHostBinding = Readonly<z.infer<typeof expectedBindingSchema>>;

export type IssueWorkflowSettlementRead =
  | { readonly kind: "absent" }
  | { readonly kind: "incomplete"; readonly state: RunState; readonly ledgerDigest: string }
  | {
      readonly kind: "terminal";
      readonly settlement: IssueWorkflowSettlement;
      readonly state: RunState;
    };

/** Reads committed host evidence only. This does not authenticate caller-supplied bindings. */
export async function readIssueWorkflowSettlement(input: {
  readonly nestedRunRoot: string;
  readonly dispatch: IssueWorkflowDispatch;
  readonly workflow: CompiledWorkflow;
  readonly expected: IssueWorkflowSettlementHostBinding;
}): Promise<IssueWorkflowSettlementRead> {
  const dispatch = issueWorkflowDispatchSchema.parse(input.dispatch);
  const expected = expectedBindingSchema.parse(input.expected);
  for (const field of [
    "parentIssueRunId",
    "flowRunId",
    "frozenContractDigest",
    "templateWorkflowDigest",
    "workspaceIdentityDigest",
  ] as const) {
    if (dispatch[field] !== expected[field])
      throw new Error("child settlement host binding mismatch");
  }
  if (
    calculateWorkflowDigest(input.workflow) !== dispatch.executionWorkflowDigest ||
    !sameEnvelope(input.workflow.budget, dispatch.envelope)
  ) {
    throw new Error("child settlement compiled workflow binding mismatch");
  }

  let events: readonly RunEvent[];
  try {
    events = await new JsonlRunStore(input.nestedRunRoot).read(dispatch.flowRunId);
  } catch (error) {
    if (!(error instanceof RunStoreError) || error.code !== "not_found" || !isMissing(error.cause))
      throw error;
    // Absence is safe only when no child state contradicts it. Never erase or repair files here.
    let entries: string[];
    try {
      entries = await readdir(join(input.nestedRunRoot, dispatch.flowRunId));
    } catch (directoryError) {
      if (!isMissing(directoryError)) throw directoryError;
      try {
        await lstat(join(input.nestedRunRoot, dispatch.flowRunId));
      } catch (entryError) {
        if (!isMissing(entryError)) throw entryError;
        return Object.freeze({ kind: "absent" });
      }
      throw new Error("child ledger is absent but unresolved child state exists");
    }
    if (entries.length !== 0) throw new Error("child ledger is absent but child state exists");
    return Object.freeze({ kind: "absent" });
  }

  // Both replay and digest use this single committed snapshot, including failed attempts.
  const state = reduceRunEvents(events);
  const started = events[0];
  if (
    started?.type !== "run_started" ||
    started.runId !== dispatch.flowRunId ||
    started.workflowId !== input.workflow.id ||
    started.workflowApiVersion !== input.workflow.apiVersion ||
    started.workflowDigest !== dispatch.executionWorkflowDigest ||
    started.workspaceAuthorityDigest !== expected.workspaceAuthorityDigest ||
    started.executionCwd !== expected.executionCwd ||
    state.executionCwd !== expected.executionCwd ||
    JSON.stringify(started.nodeIds) !==
      JSON.stringify(input.workflow.nodes.map((node) => node.id)) ||
    !sameEnvelope(started.budget, dispatch.envelope)
  ) {
    throw new Error("child settlement committed ledger binding mismatch");
  }
  const ledgerDigest = createHash("sha256")
    .update("flow.issue.nested-workflow-evidence.v1\0")
    .update(JSON.stringify(events))
    .digest("hex");
  if (state.status === "running" || state.status === "waiting_for_approval") {
    return Object.freeze({ kind: "incomplete", state, ledgerDigest });
  }

  const settlement = issueWorkflowSettlementSchema.parse({
    version: 1,
    dispatchId: dispatch.dispatchId,
    flowRunId: dispatch.flowRunId,
    executionWorkflowDigest: dispatch.executionWorkflowDigest,
    terminalSequence: state.lastSequence,
    ledgerDigest,
    status: state.status,
    resources: state.resources,
    availability: resourceAvailability(events, state),
  });
  return deepFreeze({ kind: "terminal" as const, settlement, state });
}

function sameEnvelope(left: unknown, right: IssueWorkflowDispatch["envelope"]): boolean {
  const parsed = issueWorkflowEnvelopeSchema.safeParse(left);
  return (
    parsed.success &&
    (Object.keys(right) as (keyof typeof right)[]).every((key) => parsed.data[key] === right[key])
  );
}

function resourceAvailability(
  events: readonly RunEvent[],
  state: RunState,
): IssueWorkflowAvailability {
  const openAttempts = new Set<string>();
  let uncertainAttempt = false;
  for (const event of events) {
    if (event.type === "node_started") openAttempts.add(`${event.nodeId}:${event.attempt}`);
    if (
      event.type === "node_succeeded" ||
      event.type === "node_failed" ||
      event.type === "node_attempt_interrupted"
    ) {
      openAttempts.delete(`${event.nodeId}:${event.attempt}`);
      if (
        event.type === "node_attempt_interrupted" ||
        (event.type === "node_failed" && event.evidence === null)
      )
        uncertainAttempt = true;
    }
  }
  // Do not infer zero model, elapsed, or retained-output resources from a missing attempt closure.
  // Conservatism also covers a failed child or verifier whose effects are not fully represented.
  const unavailable = uncertainAttempt || openAttempts.size > 0;
  return Object.freeze({
    nodeStarts: "complete",
    modelTokens: unavailable
      ? "unavailable"
      : (state.resourceAvailability?.modelTokens ?? "complete"),
    modelCostUsdMicros: unavailable
      ? "unavailable"
      : (state.resourceAvailability?.modelCostUsdMicros ?? "complete"),
    executionMs: unavailable ? "unavailable" : "complete",
    artifactBytes: unavailable ? "unavailable" : "complete",
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
