import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  calculateCommandApprovalOperationDigest,
  commandApprovalRequestId,
  createCommandApprovalOperation,
} from "../../../src/domain/approval/command-approval.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("command approval operation", () => {
  it("creates an immutable exact operation with a normalized working directory", () => {
    const operation = createCommandApprovalOperation(commandNode(), "/workspace/nested/..");

    expect(operation).toEqual({
      version: 1,
      action: "process.execute",
      cwd: resolve("/workspace"),
      executable: "node",
      args: ["--version"],
      timeoutMs: 10000,
    });
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.args)).toBe(true);
  });

  it("produces a stable digest and changes it for every executable field", () => {
    const operation = createCommandApprovalOperation(commandNode(), "/workspace");
    const digest = calculateCommandApprovalOperationDigest(operation);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(calculateCommandApprovalOperationDigest(structuredClone(operation))).toBe(digest);
    expect(calculateCommandApprovalOperationDigest({ ...operation, cwd: "/different" })).not.toBe(
      digest,
    );
    expect(calculateCommandApprovalOperationDigest({ ...operation, executable: "npm" })).not.toBe(
      digest,
    );
    expect(calculateCommandApprovalOperationDigest({ ...operation, args: ["test"] })).not.toBe(
      digest,
    );
    expect(calculateCommandApprovalOperationDigest({ ...operation, timeoutMs: 10001 })).not.toBe(
      digest,
    );
  });

  it("derives a request locator from its durable event sequence", () => {
    expect(commandApprovalRequestId(2)).toBe("approval-2");
    expect(() => commandApprovalRequestId(0)).toThrowError(/positive safe integer/i);
    expect(() => commandApprovalRequestId(Number.MAX_SAFE_INTEGER + 1)).toThrowError(
      /positive safe integer/i,
    );
  });
});

function commandNode() {
  const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: approval-operation }
nodes:
  - id: verify
    type: command
    approval: { mode: required, grantTtlMs: 60000 }
    command: { executable: node, args: [--version], timeoutMs: 10000 }
`);
  const node = workflow.nodes[0];
  if (node?.type !== "command") {
    throw new Error("expected a compiled command node");
  }
  return node;
}
