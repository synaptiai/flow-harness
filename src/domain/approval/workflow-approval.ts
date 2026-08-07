import { createHash } from "node:crypto";

import type { ConditionSourceField } from "../workflow/types.js";

export interface WorkflowApprovalEvidenceObservation {
  readonly sourceNodeId: string;
  readonly sourceAttempt: number;
  readonly sourceField: ConditionSourceField;
  readonly sourceHash: string;
}

export interface WorkflowApprovalRequest {
  readonly version: 1;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowDigest: string;
  readonly nodeId: string;
  readonly attempt: 1;
  readonly prompt: string;
  readonly evidence: readonly WorkflowApprovalEvidenceObservation[];
}

export function calculateWorkflowApprovalRequestDigest(request: WorkflowApprovalRequest): string {
  const canonical = {
    version: request.version,
    runId: request.runId,
    workflowId: request.workflowId,
    workflowDigest: request.workflowDigest,
    nodeId: request.nodeId,
    attempt: request.attempt,
    prompt: request.prompt,
    evidence: request.evidence.map((observation) => ({
      sourceNodeId: observation.sourceNodeId,
      sourceAttempt: observation.sourceAttempt,
      sourceField: observation.sourceField,
      sourceHash: observation.sourceHash,
    })),
  } as const;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function workflowApprovalRequestId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new RangeError("approval request sequence must be a positive safe integer");
  }
  return `approval-${sequence}`;
}

export function workflowApprovalDenialMessage(actor: string, reason: string | undefined): string {
  return `workflow approval denied by ${actor}${reason === undefined ? "" : `: ${reason}`}`;
}

export function workflowApprovalEvidenceTruncationMessage(
  nodeId: string,
  sourceNodeId: string,
  sourceField: ConditionSourceField,
): string {
  return `workflow approval "${nodeId}" source "${sourceNodeId}" field ${sourceField} is truncated`;
}
