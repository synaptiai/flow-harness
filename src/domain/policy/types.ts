export type PolicyAuthority =
  | "read"
  | "write"
  | "execute"
  | "network"
  | "credentials"
  | "destructive";

export type PolicyAction =
  | "filesystem.read"
  | "filesystem.list"
  | "filesystem.write"
  | "filesystem.delete"
  | "process.execute"
  | "network.request"
  | "credential.read"
  | "artifact.read";

export interface PolicyAttribution {
  readonly runId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly attempt: number;
}

interface PolicyOperationBase {
  readonly target: string;
  readonly boundary: "inside" | "outside" | "protected" | "unresolved";
}

export type PolicyOperation =
  | (PolicyOperationBase & {
      readonly action: "filesystem.write" | "process.execute";
      readonly operationDigest: string;
    })
  | (PolicyOperationBase & {
      readonly action: Exclude<PolicyAction, "filesystem.write" | "process.execute">;
      readonly operationDigest?: string;
    });

export type PolicyDecisionReason =
  | "operation_declared"
  | "operation_not_declared"
  | "target_outside_workspace"
  | "target_protected"
  | "target_resolution_failed";

export interface PolicyDecision extends PolicyAttribution {
  readonly version: 1;
  readonly sequence: number;
  readonly requestDigest: string;
  readonly authority: PolicyAuthority;
  readonly action: PolicyAction;
  readonly target: string;
  readonly operationDigest?: string;
  readonly outcome: "allowed" | "denied";
  readonly reason: PolicyDecisionReason;
}
