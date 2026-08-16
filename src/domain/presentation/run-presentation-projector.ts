import { z } from "zod";

import { MAX_AGENT_COMMANDS_PER_ATTEMPT } from "../run/events.js";
import { MAX_COMPILED_WORKFLOW_NODES } from "../workflow/types.js";
import {
  FLOW_PRESENTATION_API_VERSION,
  type FlowPresentationAction,
  type FlowPresentationDocument,
  MAX_FLOW_PRESENTATION_ROWS,
  parseFlowPresentationDocument,
} from "./flow-presentation.js";
import { MAX_SAFE_DISPLAY_TEXT_BYTES, neutralizeDisplayText } from "./safe-display-text.js";

export const MAX_PRESENTED_APPROVALS = 127;

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const boundedPublicTextSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_SAFE_DISPLAY_TEXT_BYTES);
const timestampSchema = boundedPublicTextSchema.max(64);
const approvalSchema = z.object({
  status: z.string().max(32),
  requestId: identifierSchema,
  requestedAt: timestampSchema,
});
const nodeSchema = z.object({
  status: z.enum(["pending", "running", "succeeded", "failed", "omitted"]),
  attempt: z.number().int().nonnegative(),
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
  evidence: z.object({ kind: z.enum(["command", "agent", "verifier", "child"]) }).nullable(),
  error: z.object({ code: boundedPublicTextSchema.max(256) }).nullable(),
  approval: approvalSchema.nullable(),
  workflowApproval: approvalSchema.nullable(),
  agentCommandApprovals: z.array(approvalSchema).max(MAX_AGENT_COMMANDS_PER_ATTEMPT),
});
const publicRunPresentationSourceSchema = z.object({
  runId: identifierSchema,
  workflowId: identifierSchema,
  status: z.enum([
    "running",
    "waiting_for_approval",
    "succeeded",
    "failed",
    "cancelled",
    "resource_exhausted",
  ]),
  lastSequence: z.number().int().positive(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  failedNodeId: identifierSchema.nullable(),
  failureReason: boundedPublicTextSchema.nullable(),
  resources: z.object({
    nodeStarts: z.number().int().nonnegative(),
    modelTokens: z.number().int().nonnegative(),
    modelCostUsdMicros: z.number().int().nonnegative(),
    executionMs: z.number().int().nonnegative(),
    artifactBytes: z.number().int().nonnegative(),
  }),
  nodes: z
    .record(identifierSchema, nodeSchema)
    .refine(
      (nodes) => Object.keys(nodes).length <= MAX_COMPILED_WORKFLOW_NODES,
      `run presentation cannot exceed ${MAX_COMPILED_WORKFLOW_NODES} nodes`,
    ),
});

type PublicRunPresentationSource = z.infer<typeof publicRunPresentationSourceSchema>;
type PublicNodePresentationSource = z.infer<typeof nodeSchema>;

interface PendingApproval {
  readonly nodeId: string;
  readonly kind: "agent command" | "command" | "workflow";
  readonly requestId: string;
  readonly requestedAt: string;
}

export class RunPresentationProjectionError extends Error {
  override readonly name = "RunPresentationProjectionError";
}

export function projectRunPresentation(input: unknown): FlowPresentationDocument {
  const parsed = publicRunPresentationSourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new RunPresentationProjectionError(
      "Cannot project Flow run presentation: public run state is invalid",
    );
  }
  try {
    return parseFlowPresentationDocument(buildDocument(parsed.data));
  } catch {
    throw new RunPresentationProjectionError(
      "Cannot project Flow run presentation: projected document is invalid",
    );
  }
}

function buildDocument(source: PublicRunPresentationSource): FlowPresentationDocument {
  const nodes = Object.entries(source.nodes).sort(([left], [right]) =>
    compareIdentifiers(left, right),
  );
  const completed = nodes.filter(
    ([, node]) =>
      node.status === "succeeded" || node.status === "failed" || node.status === "omitted",
  ).length;
  const approvals = collectPendingApprovals(nodes);
  const isActive = source.status === "running" || source.status === "waiting_for_approval";
  const decisionApprovals = approvals.slice(0, MAX_PRESENTED_APPROVALS);
  const presentedApprovals = approvals.slice(0, MAX_FLOW_PRESENTATION_ROWS);
  const sections: FlowPresentationDocument["sections"] = [
    {
      id: "overview",
      title: "Run overview",
      components: [
        { kind: "heading", level: 1, text: "Flow run" },
        {
          kind: "facts",
          items: [
            { label: "Run", value: display(source.runId) },
            { label: "Workflow", value: display(source.workflowId) },
            { label: "Status", value: display(source.status) },
            { label: "Sequence", value: String(source.lastSequence) },
            { label: "Started", value: display(source.startedAt) },
            { label: "Finished", value: display(source.finishedAt ?? "—") },
          ],
        },
        { kind: "progress", label: "Settled nodes", completed, total: nodes.length },
      ],
    },
    {
      id: "nodes",
      title: "Graph progress",
      components: [
        {
          kind: "table",
          columns: [
            { key: "node", label: "Node" },
            { key: "status", label: "Status" },
            { key: "attempt", label: "Attempt" },
            { key: "evidence", label: "Evidence" },
            { key: "error", label: "Error" },
          ],
          rows: nodes.map(([nodeId, node]) => ({
            id: nodeId,
            cells: [
              display(nodeId),
              display(node.status),
              String(node.attempt),
              display(node.evidence?.kind ?? "—"),
              display(node.error?.code ?? "—"),
            ],
          })),
          truncated: false,
        },
      ],
    },
    {
      id: "resources",
      title: "Resource use",
      components: [
        {
          kind: "facts",
          items: [
            { label: "Node starts", value: String(source.resources.nodeStarts) },
            { label: "Model tokens", value: String(source.resources.modelTokens) },
            {
              label: "Model cost",
              value: `${source.resources.modelCostUsdMicros} µUSD`,
            },
            { label: "Execution", value: `${source.resources.executionMs} ms` },
            { label: "Artifacts", value: `${source.resources.artifactBytes} bytes` },
          ],
        },
      ],
    },
  ];
  if (approvals.length > 0) {
    sections.push({
      id: "approvals",
      title: "Pending approvals",
      components: [
        {
          kind: "table",
          columns: [
            { key: "node", label: "Node" },
            { key: "kind", label: "Kind" },
            { key: "request", label: "Request" },
            { key: "requested", label: "Requested" },
          ],
          rows: presentedApprovals.map((approval) => ({
            id: approval.requestId,
            cells: [
              display(approval.nodeId),
              approval.kind,
              display(approval.requestId),
              display(approval.requestedAt),
            ],
          })),
          truncated: approvals.length > presentedApprovals.length,
        },
      ],
    });
  }
  const outcome = outcomeNotice(source);
  if (outcome !== undefined) {
    sections.push({ id: "outcome", title: "Outcome", components: [outcome] });
  }

  return {
    apiVersion: FLOW_PRESENTATION_API_VERSION,
    run: {
      runId: source.runId,
      workflowId: source.workflowId,
      status: source.status,
      sequence: source.lastSequence,
    },
    sections,
    actions: [
      ...(isActive ? decisionApprovals.flatMap(approvalActions) : []),
      ...(isActive
        ? [
            {
              kind: "cancel" as const,
              actionId: `cancel:${source.runId}`,
              runId: source.runId,
              label: "Cancel run",
            },
          ]
        : []),
    ],
    truncated: approvals.length > decisionApprovals.length,
  };
}

function collectPendingApprovals(
  nodes: readonly [string, PublicNodePresentationSource][],
): readonly PendingApproval[] {
  const approvals: PendingApproval[] = [];
  for (const [nodeId, node] of nodes) {
    if (node.approval?.status === "pending") {
      approvals.push({
        nodeId,
        kind: "command",
        requestId: node.approval.requestId,
        requestedAt: node.approval.requestedAt,
      });
    }
    if (node.workflowApproval?.status === "pending") {
      approvals.push({
        nodeId,
        kind: "workflow",
        requestId: node.workflowApproval.requestId,
        requestedAt: node.workflowApproval.requestedAt,
      });
    }
    for (const approval of node.agentCommandApprovals) {
      if (approval.status === "pending") {
        approvals.push({
          nodeId,
          kind: "agent command",
          requestId: approval.requestId,
          requestedAt: approval.requestedAt,
        });
      }
    }
  }
  return approvals.sort(
    (left, right) =>
      compareIdentifiers(left.nodeId, right.nodeId) ||
      compareIdentifiers(left.kind, right.kind) ||
      compareIdentifiers(left.requestId, right.requestId),
  );
}

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function approvalActions(approval: PendingApproval): readonly FlowPresentationAction[] {
  return [
    {
      kind: "approve",
      actionId: `approve:${approval.requestId}`,
      requestId: approval.requestId,
      label: display(`Approve ${approval.kind} request for ${approval.nodeId}`),
    },
    {
      kind: "deny",
      actionId: `deny:${approval.requestId}`,
      requestId: approval.requestId,
      label: display(`Deny ${approval.kind} request for ${approval.nodeId}`),
    },
  ];
}

function outcomeNotice(
  source: PublicRunPresentationSource,
): FlowPresentationDocument["sections"][number]["components"][number] | undefined {
  switch (source.status) {
    case "succeeded":
      return { kind: "notice", tone: "success", text: "Run succeeded." };
    case "failed":
      return {
        kind: "notice",
        tone: "danger",
        text:
          source.failedNodeId === null
            ? "Run failed."
            : display(`Run failed at node ${source.failedNodeId}.`),
      };
    case "cancelled":
      return { kind: "notice", tone: "warning", text: "Run was cancelled." };
    case "resource_exhausted":
      return { kind: "notice", tone: "danger", text: "Run exhausted its resource budget." };
    case "running":
    case "waiting_for_approval":
      return undefined;
  }
}

function display(value: string): string {
  return neutralizeDisplayText(value);
}
