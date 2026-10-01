export interface RuntimeAuditAllowance {
  readonly advisory: string;
  readonly package: string;
  readonly path: string;
  readonly expires: string;
  readonly reason: string;
}

export interface RuntimeAuditAllowances {
  readonly version: 1;
  readonly allowances: readonly RuntimeAuditAllowance[];
}

export interface RuntimeAuditResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly accepted: readonly string[];
}

export function evaluateRuntimeAudit(
  report: unknown,
  allowances: unknown,
  today: string,
): RuntimeAuditResult;
