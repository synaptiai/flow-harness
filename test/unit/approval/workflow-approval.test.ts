import { describe, expect, it } from "vitest";

import {
  calculateWorkflowApprovalRequestDigest,
  workflowApprovalRequestId,
  type WorkflowApprovalRequest,
} from "../../../src/domain/approval/workflow-approval.js";

describe("workflow approval request", () => {
  it("hashes a canonical exact evidence-bound request", () => {
    const request = workflowApprovalRequest();

    expect(calculateWorkflowApprovalRequestDigest(request)).toMatch(/^[a-f0-9]{64}$/);
    expect(calculateWorkflowApprovalRequestDigest(structuredClone(request))).toBe(
      calculateWorkflowApprovalRequestDigest(request),
    );
    expect(
      calculateWorkflowApprovalRequestDigest({
        ...request,
        evidence: [{ ...firstEvidence(request), sourceHash: "f".repeat(64) }],
      }),
    ).not.toBe(calculateWorkflowApprovalRequestDigest(request));
  });

  it("derives bounded request locators only from positive safe event sequences", () => {
    expect(workflowApprovalRequestId(7)).toBe("approval-7");
    expect(() => workflowApprovalRequestId(0)).toThrow(RangeError);
    expect(() => workflowApprovalRequestId(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

function workflowApprovalRequest(): WorkflowApprovalRequest {
  return {
    version: 1,
    runId: "run-review",
    workflowId: "review-workflow",
    workflowDigest: "a".repeat(64),
    nodeId: "review",
    attempt: 1,
    prompt: "Approve the verified plan.",
    evidence: [
      {
        sourceNodeId: "plan",
        sourceAttempt: 1,
        sourceField: "agent.text",
        sourceHash: "b".repeat(64),
      },
    ],
  };
}

function firstEvidence(
  request: WorkflowApprovalRequest,
): WorkflowApprovalRequest["evidence"][number] {
  const evidence = request.evidence[0];
  if (evidence === undefined) {
    throw new Error("expected workflow approval evidence");
  }
  return evidence;
}
