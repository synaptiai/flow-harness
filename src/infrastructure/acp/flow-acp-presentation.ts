import type {
  AvailableCommandsUpdate,
  PermissionOption,
  SessionUpdate,
  ToolCall,
} from "@agentclientprotocol/sdk";

import {
  type FlowPresentationAction,
  type FlowPresentationDocument,
  parseFlowPresentationDocument,
} from "../../domain/presentation/flow-presentation.js";

export interface FlowAcpPermission {
  readonly requestId: string;
  readonly documentSequence: number;
  readonly toolCall: ToolCall;
  readonly options: readonly PermissionOption[];
  readonly approveActionId: string;
  readonly denyActionId: string;
}

export interface FlowAcpPresentation {
  readonly runId: string;
  readonly sequence: number;
  readonly updates: readonly SessionUpdate[];
  readonly permissions: readonly FlowAcpPermission[];
}

export class FlowAcpPresentationError extends Error {
  override readonly name = "FlowAcpPresentationError";

  constructor() {
    super("Cannot project Flow run through ACP");
  }
}

export function projectFlowAcpPresentation(input: unknown): FlowAcpPresentation {
  let document: FlowPresentationDocument;
  try {
    document = parseFlowPresentationDocument(input);
  } catch {
    throw new FlowAcpPresentationError();
  }

  const entries = projectPlanEntries(document);
  const permissions = projectPermissions(document);
  const updates: SessionUpdate[] = [
    { sessionUpdate: "plan", entries },
    {
      sessionUpdate: "agent_message_chunk",
      messageId: `flow-status:${document.run.sequence}`,
      content: {
        type: "text",
        text: `Run ${document.run.runId} is ${document.run.status} at sequence ${document.run.sequence}.`,
      },
    },
    ...permissions.map(({ toolCall }) => ({ sessionUpdate: "tool_call" as const, ...toolCall })),
  ];
  return {
    runId: document.run.runId,
    sequence: document.run.sequence,
    updates,
    permissions,
  };
}

export function resolveFlowAcpPermissionSelection(
  presentation: FlowAcpPresentation,
  selection: {
    readonly requestId: string;
    readonly optionId: string;
    readonly documentSequence: number;
  },
): { readonly actionId: string; readonly documentSequence: number } {
  if (
    !Number.isSafeInteger(selection.documentSequence) ||
    selection.documentSequence !== presentation.sequence
  ) {
    throw new FlowAcpPresentationError();
  }
  const permission = presentation.permissions.find(
    ({ requestId }) => requestId === selection.requestId,
  );
  if (permission === undefined || permission.documentSequence !== selection.documentSequence) {
    throw new FlowAcpPresentationError();
  }
  if (selection.optionId === `approve:${permission.requestId}`) {
    return {
      actionId: permission.approveActionId,
      documentSequence: permission.documentSequence,
    };
  }
  if (selection.optionId === `deny:${permission.requestId}`) {
    return {
      actionId: permission.denyActionId,
      documentSequence: permission.documentSequence,
    };
  }
  throw new FlowAcpPresentationError();
}

export function flowAcpAvailableCommandsUpdate(): AvailableCommandsUpdate & {
  readonly sessionUpdate: "available_commands_update";
} {
  return {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      {
        name: "flow-run",
        description: "Start one admitted Flow workflow in this session",
        input: { hint: "<workflow source>" },
      },
      {
        name: "flow-continue",
        description: "Observe and steer the Flow run bound to this session",
      },
    ],
  };
}

function projectPlanEntries(
  document: FlowPresentationDocument,
): Array<{ content: string; priority: "medium"; status: "pending" | "in_progress" | "completed" }> {
  const section = document.sections.find(({ id }) => id === "nodes");
  const table = section?.components.find(({ kind }) => kind === "table");
  if (table === undefined || table.kind !== "table" || table.truncated) {
    throw new FlowAcpPresentationError();
  }
  const nodeIndex = table.columns.findIndex(({ key }) => key === "node");
  const statusIndex = table.columns.findIndex(({ key }) => key === "status");
  if (nodeIndex === -1 || statusIndex === -1) {
    throw new FlowAcpPresentationError();
  }
  return table.rows.map((row) => {
    const content = row.cells[nodeIndex];
    const status = row.cells[statusIndex];
    if (content === undefined || status === undefined) {
      throw new FlowAcpPresentationError();
    }
    return { content, priority: "medium", status: projectPlanStatus(status) };
  });
}

function projectPlanStatus(status: string): "pending" | "in_progress" | "completed" {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "in_progress";
    case "failed":
    case "omitted":
    case "succeeded":
      return "completed";
    default:
      throw new FlowAcpPresentationError();
  }
}

function projectPermissions(document: FlowPresentationDocument): FlowAcpPermission[] {
  const approvals = new Map<string, Extract<FlowPresentationAction, { kind: "approve" }>>();
  const denials = new Map<string, Extract<FlowPresentationAction, { kind: "deny" }>>();
  for (const action of document.actions) {
    if (action.kind === "approve") {
      if (approvals.has(action.requestId)) {
        throw new FlowAcpPresentationError();
      }
      approvals.set(action.requestId, action);
    } else if (action.kind === "deny") {
      if (denials.has(action.requestId)) {
        throw new FlowAcpPresentationError();
      }
      denials.set(action.requestId, action);
    }
  }
  if (
    approvals.size !== denials.size ||
    [...approvals.keys()].some((requestId) => !denials.has(requestId))
  ) {
    throw new FlowAcpPresentationError();
  }

  return [...approvals.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([requestId, approve]) => {
      const deny = denials.get(requestId);
      if (deny === undefined) {
        throw new FlowAcpPresentationError();
      }
      const toolCall: ToolCall = {
        toolCallId: `flow-approval:${requestId}`,
        title: `Flow approval ${requestId}`,
        kind: "execute",
        status: "pending",
      };
      return {
        requestId,
        documentSequence: document.run.sequence,
        toolCall,
        options: [
          { optionId: `approve:${requestId}`, name: "Approve once", kind: "allow_once" },
          { optionId: `deny:${requestId}`, name: "Deny once", kind: "reject_once" },
        ],
        approveActionId: approve.actionId,
        denyActionId: deny.actionId,
      };
    });
}
