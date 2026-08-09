import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  type AgentCommandRequest,
  agentCommandRequestSchema,
  calculateAgentCommandDigest,
} from "../agent-command.js";
import type { CompiledCommandNode } from "../workflow/types.js";

export interface CommandApprovalOperation {
  readonly version: 1;
  readonly action: "process.execute";
  readonly cwd: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export function createCommandApprovalOperation(
  node: CompiledCommandNode,
  cwd: string,
): CommandApprovalOperation {
  return Object.freeze({
    version: 1,
    action: "process.execute",
    cwd: resolve(cwd),
    executable: node.command.executable,
    args: Object.freeze([...node.command.args]),
    timeoutMs: node.command.timeoutMs,
  });
}

export function calculateCommandApprovalOperationDigest(
  operation: CommandApprovalOperation,
): string {
  const canonical = {
    version: operation.version,
    action: operation.action,
    cwd: operation.cwd,
    executable: operation.executable,
    args: [...operation.args],
    timeoutMs: operation.timeoutMs,
  } as const;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function commandApprovalRequestId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new RangeError("approval request sequence must be a positive safe integer");
  }
  return `approval-${sequence}`;
}

export function isValidApprovalActor(actor: string): boolean {
  return (
    actor.length > 0 &&
    actor.length <= 128 &&
    !Array.from(actor).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}

export interface AgentCommandApprovalRequest {
  readonly version: 1;
  readonly runId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly tool: "exec";
  readonly cwd: string;
  readonly command: AgentCommandRequest;
  readonly operationDigest: string;
  readonly grantTtlMs: number;
}

export function createAgentCommandApprovalRequest(input: {
  readonly runId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly cwd: string;
  readonly command: AgentCommandRequest;
  readonly grantTtlMs: number;
}): AgentCommandApprovalRequest {
  validateApprovalIdentifier(input.runId, "run id");
  validateApprovalIdentifier(input.workflowId, "workflow id");
  validateApprovalIdentifier(input.nodeId, "node id");
  if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0) {
    throw new RangeError("agent command approval attempt must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(input.grantTtlMs) ||
    input.grantTtlMs <= 0 ||
    input.grantTtlMs > 86_400_000
  ) {
    throw new RangeError("agent command approval grant lifetime must be between 1 and 86400000ms");
  }
  const parsed = agentCommandRequestSchema.parse(input.command);
  const command: AgentCommandRequest = Object.freeze({
    version: 1,
    executable: parsed.executable,
    args: Object.freeze([...parsed.args]),
    timeoutMs: parsed.timeoutMs,
  });
  return Object.freeze({
    version: 1,
    runId: input.runId,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    tool: "exec",
    cwd: resolve(input.cwd),
    command,
    operationDigest: calculateAgentCommandDigest(command),
    grantTtlMs: input.grantTtlMs,
  });
}

export function calculateAgentCommandApprovalRequestDigest(
  request: AgentCommandApprovalRequest,
): string {
  const canonical = {
    version: request.version,
    runId: request.runId,
    workflowId: request.workflowId,
    nodeId: request.nodeId,
    attempt: request.attempt,
    tool: request.tool,
    cwd: request.cwd,
    command: {
      version: request.command.version,
      executable: request.command.executable,
      args: [...request.command.args],
      timeoutMs: request.command.timeoutMs,
    },
    operationDigest: request.operationDigest,
    grantTtlMs: request.grantTtlMs,
  } as const;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function agentCommandApprovalRequestId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new RangeError("agent command approval sequence must be a positive safe integer");
  }
  return `agent-approval-${sequence}`;
}

function validateApprovalIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) || value.length > 128) {
    throw new RangeError(`${label} must be a valid bounded Flow identifier`);
  }
}
