import { createHash } from "node:crypto";
import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const unicodeControlCharacterPattern = /\p{Cc}/u;
const reviewTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 8_192, "must not exceed 8192 UTF-8 bytes");
const reviewFileSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 1_024, "must not exceed 1024 UTF-8 bytes")
  .refine((value) => {
    if (
      value.startsWith("/") ||
      value.includes("\\") ||
      value.endsWith("/") ||
      unicodeControlCharacterPattern.test(value)
    ) {
      return false;
    }
    const segments = value.split("/");
    return segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        segment !== ".git" &&
        segment !== ".flow",
    );
  }, "must be a strict project-relative source path");
const acceptanceMappingSchema = z
  .object({
    criterionId: identifierSchema,
    status: z.enum(["satisfied", "unsatisfied"]),
    evidence: reviewTextSchema,
  })
  .strict();
const findingSchema = z
  .object({
    id: identifierSchema,
    severity: z.enum(["P1", "P2", "P3"]),
    category: z.enum([
      "security",
      "correctness",
      "performance",
      "reliability",
      "maintainability",
      "tests",
      "documentation",
    ]),
    file: reviewFileSchema,
    startLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    endLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    summary: reviewTextSchema,
    evidence: reviewTextSchema,
    recommendation: reviewTextSchema,
  })
  .strict()
  .refine((finding) => finding.endLine === undefined || finding.endLine >= finding.startLine, {
    path: ["endLine"],
    message: "end line must not precede start line",
  });
const issueReviewReportSchema = z
  .object({
    version: z.literal(1),
    candidateHead: gitCommitSchema,
    issueDigest: sha256Schema,
    reviewWorkflowDigest: sha256Schema,
    acceptanceMapping: z.array(acceptanceMappingSchema).min(1).max(128),
    findings: z.array(findingSchema).max(128),
    verdict: z.enum(["clear", "blocked"]),
  })
  .strict();

type ParsedIssueReviewReport = z.infer<typeof issueReviewReportSchema>;
declare const validatedIssueReviewReport: unique symbol;
export type IssueReviewReport = Readonly<ParsedIssueReviewReport> & {
  readonly [validatedIssueReviewReport]: true;
};
export interface ExpectedIssueReviewIdentity {
  readonly candidateHead: string;
  readonly issueDigest: string;
  readonly reviewWorkflowDigest: string;
}
export type IssueReviewReportErrorCode =
  | "invalid_schema"
  | "identity_mismatch"
  | "incomplete_mapping"
  | "inconsistent_verdict";

export class IssueReviewReportError extends Error {
  override readonly name = "IssueReviewReportError";

  constructor(
    readonly code: IssueReviewReportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export function parseIssueReviewReport(
  input: unknown,
  expectedAcceptanceCriteria: readonly string[],
  expectedIdentity: ExpectedIssueReviewIdentity,
): IssueReviewReport {
  const expectedHead = gitCommitSchema.safeParse(expectedIdentity.candidateHead);
  const expectedIssueDigest = sha256Schema.safeParse(expectedIdentity.issueDigest);
  const expectedWorkflowDigest = sha256Schema.safeParse(expectedIdentity.reviewWorkflowDigest);
  const expectedCriteria = z
    .array(identifierSchema)
    .min(1)
    .max(128)
    .safeParse(expectedAcceptanceCriteria);
  if (
    !expectedHead.success ||
    !expectedIssueDigest.success ||
    !expectedWorkflowDigest.success ||
    !expectedCriteria.success
  ) {
    const cause = !expectedHead.success
      ? expectedHead.error
      : !expectedIssueDigest.success
        ? expectedIssueDigest.error
        : !expectedWorkflowDigest.success
          ? expectedWorkflowDigest.error
          : expectedCriteria.error;
    throw new IssueReviewReportError("invalid_schema", "expected review identity is invalid", {
      cause,
    });
  }
  if (new Set(expectedCriteria.data).size !== expectedCriteria.data.length) {
    throw new IssueReviewReportError(
      "invalid_schema",
      "expected acceptance criteria must be unique",
    );
  }
  const parsed = parseIssueReviewReportShape(input);
  if (parsed.candidateHead !== expectedHead.data) {
    throw new IssueReviewReportError(
      "identity_mismatch",
      "review does not bind the candidate head",
    );
  }
  if (parsed.issueDigest !== expectedIssueDigest.data) {
    throw new IssueReviewReportError(
      "identity_mismatch",
      "review does not bind the expected issue digest",
    );
  }
  if (parsed.reviewWorkflowDigest !== expectedWorkflowDigest.data) {
    throw new IssueReviewReportError(
      "identity_mismatch",
      "review does not bind the expected workflow digest",
    );
  }
  assertUniqueAcceptanceMappings(parsed);
  const observedIds = parsed.acceptanceMapping.map((mapping) => mapping.criterionId);
  const expectedSet = new Set(expectedCriteria.data);
  if (
    observedIds.length !== expectedSet.size ||
    observedIds.some((criterionId) => !expectedSet.has(criterionId))
  ) {
    throw new IssueReviewReportError(
      "incomplete_mapping",
      "review must contain one complete mapping for every acceptance criterion",
    );
  }
  assertUniqueFindingIdentifiers(parsed);
  assertConsistentVerdict(parsed);
  return deepFreeze(structuredClone(parsed)) as IssueReviewReport;
}

export function calculateIssueReviewReportDigest(
  report: unknown,
  expectedAcceptanceCriteria: readonly string[],
  expectedIdentity: ExpectedIssueReviewIdentity,
): string {
  const parsed = parseIssueReviewReport(report, expectedAcceptanceCriteria, expectedIdentity);
  return createHash("sha256")
    .update("flow.issue.review-report.v1\0")
    .update(JSON.stringify(parsed))
    .digest("hex");
}

function parseIssueReviewReportShape(input: unknown): ParsedIssueReviewReport {
  const parsed = issueReviewReportSchema.safeParse(input);
  if (!parsed.success) {
    throw new IssueReviewReportError(
      "invalid_schema",
      parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
        .join("; "),
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function assertUniqueAcceptanceMappings(report: ParsedIssueReviewReport): void {
  const observedIds = report.acceptanceMapping.map((mapping) => mapping.criterionId);
  if (new Set(observedIds).size !== observedIds.length) {
    throw new IssueReviewReportError("incomplete_mapping", "acceptance mappings must be unique");
  }
}

function assertUniqueFindingIdentifiers(report: ParsedIssueReviewReport): void {
  if (new Set(report.findings.map((finding) => finding.id)).size !== report.findings.length) {
    throw new IssueReviewReportError("invalid_schema", "review finding identifiers must be unique");
  }
}

function assertConsistentVerdict(report: ParsedIssueReviewReport): void {
  const mustBlock =
    report.findings.length > 0 ||
    report.acceptanceMapping.some((mapping) => mapping.status !== "satisfied");
  if ((report.verdict === "blocked") !== mustBlock) {
    throw new IssueReviewReportError(
      "inconsistent_verdict",
      "review verdict must block every P1, P2, P3 finding and unsatisfied acceptance criterion",
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
