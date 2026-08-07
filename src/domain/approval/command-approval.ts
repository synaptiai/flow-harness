import { createHash } from "node:crypto";
import { resolve } from "node:path";

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
