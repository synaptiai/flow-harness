import { createHash } from "node:crypto";

import type {
  PolicyAction,
  PolicyAttribution,
  PolicyAuthority,
  PolicyDecision,
  PolicyDecisionReason,
  PolicyOperation,
} from "./types.js";

export const MAX_POLICY_DECISIONS = 64;
export const MAX_POLICY_TARGET_BYTES = 1024;

const AUTHORITY_BY_ACTION: Readonly<Record<PolicyAction, PolicyAuthority>> = Object.freeze({
  "filesystem.read": "read",
  "filesystem.list": "read",
  "filesystem.write": "write",
  "filesystem.delete": "destructive",
  "process.execute": "execute",
  "network.request": "network",
  "credential.read": "credentials",
});

export class PolicyBroker {
  readonly attribution: PolicyAttribution;
  readonly #allowedActions: ReadonlySet<PolicyAction>;
  readonly #decisions: PolicyDecision[] = [];
  #closed = false;

  constructor(attribution: PolicyAttribution, allowedActions: readonly PolicyAction[]) {
    this.attribution = Object.freeze({ ...attribution });
    this.#allowedActions = new Set(allowedActions);
  }

  authorize(operation: PolicyOperation): PolicyDecision {
    if (this.#closed) {
      throw new PolicyAuditClosedError();
    }
    validateTarget(operation.target);
    if (this.#decisions.length >= MAX_POLICY_DECISIONS) {
      throw new PolicyAuditLimitError(MAX_POLICY_DECISIONS);
    }

    const authority = classifyPolicyAction(operation.action);
    const reason: PolicyDecisionReason =
      operation.boundary === "outside"
        ? "target_outside_workspace"
        : operation.boundary === "unresolved"
          ? "target_resolution_failed"
          : this.#allowedActions.has(operation.action)
            ? "operation_declared"
            : "operation_not_declared";
    const outcome = reason === "operation_declared" ? "allowed" : "denied";
    const request = Object.freeze({
      version: 1 as const,
      ...this.attribution,
      authority,
      action: operation.action,
      target: operation.target,
    });
    const decision: PolicyDecision = Object.freeze({
      ...request,
      sequence: this.#decisions.length + 1,
      requestDigest: calculatePolicyRequestDigest(request),
      outcome,
      reason,
    });
    this.#decisions.push(decision);

    if (outcome === "denied") {
      throw new PolicyDeniedError(decision);
    }
    return decision;
  }

  snapshot(): readonly PolicyDecision[] {
    return Object.freeze([...this.#decisions]);
  }

  close(): readonly PolicyDecision[] {
    this.#closed = true;
    return this.snapshot();
  }
}

export function classifyPolicyAction(action: PolicyAction): PolicyAuthority {
  return AUTHORITY_BY_ACTION[action];
}

export function calculatePolicyRequestDigest(request: {
  readonly version: 1;
  readonly runId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly authority: PolicyAuthority;
  readonly action: PolicyAction;
  readonly target: string;
}): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export class PolicyDeniedError extends Error {
  override readonly name = "PolicyDeniedError";

  constructor(readonly decision: PolicyDecision) {
    super(`Policy denied ${decision.action} for ${decision.target}: ${decision.reason}`);
  }
}

export class PolicyAuditLimitError extends Error {
  override readonly name = "PolicyAuditLimitError";

  constructor(readonly limit: number) {
    super(`Policy audit limit of ${limit} decisions was reached`);
  }
}

export class PolicyAuditClosedError extends Error {
  override readonly name = "PolicyAuditClosedError";

  constructor() {
    super("Policy audit is closed; late operations are denied");
  }
}

function validateTarget(target: string): void {
  const bytes = Buffer.byteLength(target, "utf8");
  if (bytes === 0 || bytes > MAX_POLICY_TARGET_BYTES) {
    throw new RangeError(
      `policy target must contain between 1 and ${MAX_POLICY_TARGET_BYTES} UTF-8 bytes`,
    );
  }
}
