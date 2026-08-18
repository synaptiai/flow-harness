import { describe, expect, it } from "vitest";

import type { FlowPresentationDocument } from "../../../../src/domain/presentation/flow-presentation.js";
import {
  FlowAcpPresentationError,
  flowAcpAvailableCommandsUpdate,
  projectFlowAcpPresentation,
  resolveFlowAcpPermissionSelection,
} from "../../../../src/infrastructure/acp/flow-acp-presentation.js";

describe("Flow ACP presentation", () => {
  it("projects standard plan, status, and exact one-shot approval updates", () => {
    const projected = projectFlowAcpPresentation(document());

    expect(projected.sequence).toBe(12);
    expect(projected.updates).toEqual([
      {
        sessionUpdate: "plan",
        entries: [
          { content: "build", priority: "medium", status: "in_progress" },
          { content: "verify", priority: "medium", status: "completed" },
        ],
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "flow-status:12",
        content: { type: "text", text: "Run run-1 is waiting_for_approval at sequence 12." },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "flow-approval:approval-7",
        title: "Flow approval approval-7",
        kind: "execute",
        status: "pending",
      },
    ]);
    expect(projected.permissions).toEqual([
      {
        requestId: "approval-7",
        documentSequence: 12,
        toolCall: {
          toolCallId: "flow-approval:approval-7",
          title: "Flow approval approval-7",
          kind: "execute",
          status: "pending",
        },
        options: [
          { optionId: "approve:approval-7", name: "Approve once", kind: "allow_once" },
          { optionId: "deny:approval-7", name: "Deny once", kind: "reject_once" },
        ],
        approveActionId: "approve:approval-7",
        denyActionId: "deny:approval-7",
      },
    ]);
  });

  it("does not project arbitrary presentation values or ACP raw fields", () => {
    const projected = projectFlowAcpPresentation(document());
    const encoded = JSON.stringify(projected);

    expect(encoded).not.toContain("PRIVATE_RESOURCE_BASE64");
    expect(encoded).not.toContain("PRIVATE_PROVIDER_OUTPUT");
    expect(encoded).not.toContain("contentBase64");
    expect(encoded).not.toContain("rawInput");
    expect(encoded).not.toContain("rawOutput");
    expect(encoded).not.toContain("locations");
    expect(encoded).not.toContain("_meta");
  });

  it("ignores attributed package content without changing ACP output", () => {
    const source = document();
    const projected = projectFlowAcpPresentation(source);
    const withContent = projectFlowAcpPresentation({
      ...source,
      sections: [
        ...source.sections,
        {
          id: "presentation-package-content",
          title: "Package-provided information — operations@1.0.0",
          components: [
            {
              kind: "notice" as const,
              tone: "info" as const,
              text: "PRIVATE_PACKAGE_NOTE_CANARY",
            },
          ],
        },
      ],
    });

    expect(withContent).toEqual(projected);
    expect(JSON.stringify(withContent)).not.toContain("PRIVATE_PACKAGE_NOTE_CANARY");
  });

  it.each([
    ["approve", "approve:approval-7", "approve:approval-7"],
    ["deny", "deny:approval-7", "deny:approval-7"],
  ] as const)("resolves the exact current %s option", (_name, optionId, actionId) => {
    const projected = projectFlowAcpPresentation(document());

    expect(
      resolveFlowAcpPermissionSelection(projected, {
        requestId: "approval-7",
        optionId,
        documentSequence: 12,
      }),
    ).toEqual({ actionId, documentSequence: 12 });
  });

  it.each([
    [
      "stale sequence",
      { requestId: "approval-7", optionId: "approve:approval-7", documentSequence: 11 },
    ],
    [
      "foreign request",
      { requestId: "approval-8", optionId: "approve:approval-8", documentSequence: 12 },
    ],
    [
      "cross-request option",
      { requestId: "approval-7", optionId: "approve:approval-8", documentSequence: 12 },
    ],
    [
      "persistent grant",
      { requestId: "approval-7", optionId: "allow_always", documentSequence: 12 },
    ],
  ] as const)("rejects a %s selection without an action", (_name, selection) => {
    const projected = projectFlowAcpPresentation(document());

    expect(() => resolveFlowAcpPermissionSelection(projected, selection)).toThrow(
      FlowAcpPresentationError,
    );
  });

  it("advertises only explicit Flow operations", () => {
    expect(flowAcpAvailableCommandsUpdate()).toEqual({
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
    });
  });

  it("rejects a malformed document before emitting partial updates", () => {
    expect(() =>
      projectFlowAcpPresentation({
        ...document(),
        run: { ...document().run, sequence: -1 },
      }),
    ).toThrow(FlowAcpPresentationError);
  });
});

function document(): FlowPresentationDocument {
  return {
    apiVersion: "flow.synapti.ai/presentation/v1",
    run: {
      runId: "run-1",
      workflowId: "workflow-1",
      status: "waiting_for_approval",
      sequence: 12,
    },
    sections: [
      {
        id: "overview",
        components: [
          { kind: "heading", level: 1, text: "Flow run" },
          {
            kind: "facts",
            items: [
              { label: "Private package", value: "PRIVATE_RESOURCE_BASE64" },
              { label: "Provider", value: "PRIVATE_PROVIDER_OUTPUT" },
            ],
          },
        ],
      },
      {
        id: "nodes",
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
            rows: [
              { id: "build", cells: ["build", "running", "1", "command", "—"] },
              { id: "verify", cells: ["verify", "succeeded", "1", "verifier", "—"] },
            ],
            truncated: false,
          },
        ],
      },
    ],
    actions: [
      {
        kind: "approve",
        actionId: "approve:approval-7",
        requestId: "approval-7",
        label: "Approve command request for build",
      },
      {
        kind: "deny",
        actionId: "deny:approval-7",
        requestId: "approval-7",
        label: "Deny command request for build",
      },
      { kind: "cancel", actionId: "cancel:run-1", runId: "run-1", label: "Cancel run" },
    ],
    truncated: false,
  };
}
