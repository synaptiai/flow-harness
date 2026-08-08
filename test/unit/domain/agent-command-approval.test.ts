import { describe, expect, it } from "vitest";

import { normalizeAgentCommandRequest } from "../../../src/domain/agent-command.js";
import {
  agentCommandApprovalRequestId,
  calculateAgentCommandApprovalRequestDigest,
  createAgentCommandApprovalRequest,
} from "../../../src/domain/approval/command-approval.js";

describe("agent command approval contract", () => {
  it("binds one normalized command to its run, attempt, workspace, and lifetime", () => {
    const command = normalizeAgentCommandRequest({
      executable: "npm",
      args: ["test", "--", "approval"],
      timeoutMs: 10_000,
    });

    const request = createAgentCommandApprovalRequest({
      runId: "run-1",
      workflowId: "agent-approval",
      nodeId: "implement",
      attempt: 2,
      cwd: "/workspace/project/../project",
      command,
      grantTtlMs: 300_000,
    });

    expect(request).toMatchObject({
      version: 1,
      runId: "run-1",
      workflowId: "agent-approval",
      nodeId: "implement",
      attempt: 2,
      tool: "exec",
      cwd: "/workspace/project",
      command,
      grantTtlMs: 300_000,
    });
    expect(request.operationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(calculateAgentCommandApprovalRequestDigest(request)).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.command)).toBe(true);
    expect(Object.isFrozen(request.command.args)).toBe(true);
  });

  it.each([
    ["run", { runId: "run-2" }],
    ["workflow", { workflowId: "other-workflow" }],
    ["node", { nodeId: "verify" }],
    ["attempt", { attempt: 3 }],
    ["workspace", { cwd: "/workspace/other" }],
    ["lifetime", { grantTtlMs: 1 }],
  ])("changes the request digest when %s identity changes", (_label, override) => {
    const request = createAgentCommandApprovalRequest({
      runId: "run-1",
      workflowId: "agent-approval",
      nodeId: "implement",
      attempt: 2,
      cwd: "/workspace/project",
      command: normalizeAgentCommandRequest({ executable: "npm", args: ["test"] }),
      grantTtlMs: 300_000,
    });
    const changed = createAgentCommandApprovalRequest({
      ...request,
      ...override,
    });

    expect(calculateAgentCommandApprovalRequestDigest(changed)).not.toBe(
      calculateAgentCommandApprovalRequestDigest(request),
    );
  });

  it("derives a request id from the durable event sequence", () => {
    expect(agentCommandApprovalRequestId(7)).toBe("agent-approval-7");
    expect(() => agentCommandApprovalRequestId(0)).toThrow(/positive safe integer/i);
  });
});
