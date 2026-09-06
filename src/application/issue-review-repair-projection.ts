import { z } from "zod";

import {
  calculateFrozenGitHubIssueContentDigest,
  type FrozenGitHubIssueSnapshotContent,
} from "../domain/issue-lifecycle/frozen-github-issue-snapshot.js";
import { calculateIssueLifecycleDomainDigest } from "../domain/issue-lifecycle/private-manifest.js";
import {
  calculateIssueReviewReportDigest,
  type IssueReviewReport,
  parseIssueReviewReport,
} from "../domain/issue-lifecycle/review.js";
import {
  MAX_ISSUE_REVIEW_CONTEXT_BYTES,
  normalizeIssueWorkflowWritePrefixes,
} from "./issue-workflow-admission.js";
import { MAX_ISSUE_REVIEW_RESULT_BYTES } from "./issue-workflow-runner.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const identifiersSchema = z
  .array(identifierSchema)
  .max(128)
  .refine((values) => new Set(values).size === values.length);
const bindingSchema = z
  .object({
    cycle: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    candidateHead: gitObjectSchema,
    candidateTree: gitObjectSchema,
    issueDigest: digestSchema,
    reviewWorkflowDigest: digestSchema,
    reviewReportDigest: digestSchema,
    repairWorkflowDigest: digestSchema,
  })
  .strict();
const criteriaSchema = z
  .array(
    z
      .object({
        id: z
          .string()
          .min(1)
          .max(96)
          .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
        description: z.string().trim().min(1).max(4_096),
      })
      .strict(),
  )
  .min(1)
  .max(128)
  .refine((values) => new Set(values.map((value) => value.id)).size === values.length);
const dispositionBinding = {
  version: z.literal(1),
  repairContextDigest: digestSchema,
  candidateHead: gitObjectSchema,
  reviewReportDigest: digestSchema,
};
const dispositionSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      ...dispositionBinding,
      disposition: z.literal("changed"),
      addressedFindingIds: identifiersSchema,
      addressedCriterionIds: identifiersSchema,
    })
    .strict(),
  z
    .object({
      ...dispositionBinding,
      disposition: z.literal("disputed"),
      disputedFindingIds: identifiersSchema,
      disputedCriterionIds: identifiersSchema,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(8_192)
        .refine((value) => Buffer.byteLength(value, "utf8") <= 8_192),
    })
    .strict(),
]);

export interface IssueReviewRepairProjectionInput {
  readonly issue: FrozenGitHubIssueSnapshotContent;
  readonly acceptanceCriteria: readonly { readonly id: string; readonly description: string }[];
  readonly allowedWritePrefixes: readonly string[];
  readonly report: IssueReviewReport;
  readonly binding: Readonly<z.infer<typeof bindingSchema>>;
}

export interface IssueReviewRepairContext {
  readonly version: 1;
  readonly issue: {
    readonly version: 1;
    readonly repository: { readonly identity: string };
    readonly issue: {
      readonly number: number;
      readonly title: string;
      readonly body: string;
      readonly updatedAt: string;
    };
  };
  readonly acceptanceCriteria: IssueReviewRepairProjectionInput["acceptanceCriteria"];
  readonly allowedWritePrefixes: readonly string[];
  readonly binding: IssueReviewRepairProjectionInput["binding"];
  readonly acceptanceMapping: IssueReviewReport["acceptanceMapping"];
  readonly findings: IssueReviewReport["findings"];
}

export interface IssueReviewRepairProjection {
  readonly context: IssueReviewRepairContext;
  readonly serialized: string;
  readonly digest: string;
}

export type IssueReviewRepairDisposition = Readonly<z.infer<typeof dispositionSchema>>;

export class IssueReviewRepairProjectionError extends Error {
  override readonly name = "IssueReviewRepairProjectionError";

  constructor(
    readonly code:
      | "invalid_context"
      | "identity_mismatch"
      | "context_too_large"
      | "invalid_result"
      | "truncated_result"
      | "result_too_large"
      | "incomplete_disposition",
  ) {
    super(
      code === "context_too_large"
        ? `repair context exceeds ${MAX_ISSUE_REVIEW_CONTEXT_BYTES} UTF-8 bytes`
        : code === "result_too_large"
          ? `repair result exceeds ${MAX_ISSUE_REVIEW_RESULT_BYTES} UTF-8 bytes`
          : `issue review repair ${code}`,
    );
  }
}

/** Selects repair evidence, not permissions or a finding-truth judgment. */
export function buildIssueReviewRepairProjection(
  input: IssueReviewRepairProjectionInput,
): IssueReviewRepairProjection {
  const binding = parseShape(bindingSchema, input.binding, "invalid_context");
  const acceptanceCriteria = parseShape(
    criteriaSchema,
    input.acceptanceCriteria.map(({ id, description }) => ({ id, description })),
    "invalid_context",
  );
  if (calculateFrozenGitHubIssueContentDigest(input.issue) !== binding.issueDigest) {
    throw new IssueReviewRepairProjectionError("identity_mismatch");
  }
  const criterionIds = acceptanceCriteria.map((criterion) => criterion.id);
  const report = parseIssueReviewReport(input.report, criterionIds, binding);
  if (
    calculateIssueReviewReportDigest(report, criterionIds, binding) !== binding.reviewReportDigest
  ) {
    throw new IssueReviewRepairProjectionError("identity_mismatch");
  }
  if (report.verdict !== "blocked") throw new IssueReviewRepairProjectionError("invalid_context");
  const allowedWritePrefixes = [
    ...normalizeIssueWorkflowWritePrefixes(input.allowedWritePrefixes),
  ].sort();
  if (allowedWritePrefixes.length === 0)
    throw new IssueReviewRepairProjectionError("invalid_context");
  const context: IssueReviewRepairContext = {
    version: 1,
    issue: {
      version: 1,
      repository: { identity: input.issue.repository.identity },
      issue: {
        number: input.issue.issue.number,
        title: input.issue.issue.title,
        body: input.issue.issue.body,
        updatedAt: input.issue.issue.updatedAt,
      },
    },
    acceptanceCriteria,
    allowedWritePrefixes,
    binding,
    acceptanceMapping: report.acceptanceMapping.map(({ criterionId, status, evidence }) => ({
      criterionId,
      status,
      evidence,
    })),
    findings: report.findings.map(
      ({
        id,
        severity,
        category,
        file,
        startLine,
        endLine,
        summary,
        evidence,
        recommendation,
      }) => ({
        id,
        severity,
        category,
        file,
        startLine,
        ...(endLine === undefined ? {} : { endLine }),
        summary,
        evidence,
        recommendation,
      }),
    ),
  };
  const serialized = JSON.stringify(context);
  if (Buffer.byteLength(serialized, "utf8") > MAX_ISSUE_REVIEW_CONTEXT_BYTES) {
    throw new IssueReviewRepairProjectionError("context_too_large");
  }
  return deepFreeze({ context, serialized, digest: contextDigest(context) });
}

/** Supplies host-computed result bindings and counts the entire transmitted data envelope. */
export function serializeIssueReviewRepairProviderContext(
  projection: IssueReviewRepairProjection,
): string {
  if (
    projection.digest !== contextDigest(projection.context) ||
    projection.serialized !== JSON.stringify(projection.context)
  ) {
    throw new IssueReviewRepairProjectionError("identity_mismatch");
  }
  const binding = parseShape(bindingSchema, projection.context.binding, "invalid_context");
  const serialized = JSON.stringify({
    context: projection.context,
    expectedResultBinding: {
      version: 1,
      repairContextDigest: projection.digest,
      candidateHead: binding.candidateHead,
      reviewReportDigest: binding.reviewReportDigest,
    },
  });
  if (Buffer.byteLength(serialized, "utf8") > MAX_ISSUE_REVIEW_CONTEXT_BYTES) {
    throw new IssueReviewRepairProjectionError("context_too_large");
  }
  return serialized;
}

/** Validates the model's bound disposition; the host still verifies any changed tree. */
export function parseIssueReviewRepairDisposition(
  resultText: string,
  projection: IssueReviewRepairProjection,
  resultTextTruncated = false,
): IssueReviewRepairDisposition {
  if (resultTextTruncated) throw new IssueReviewRepairProjectionError("truncated_result");
  if (Buffer.byteLength(resultText, "utf8") > MAX_ISSUE_REVIEW_RESULT_BYTES) {
    throw new IssueReviewRepairProjectionError("result_too_large");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(resultText);
  } catch {
    throw new IssueReviewRepairProjectionError("invalid_result");
  }
  const result = parseShape(dispositionSchema, raw, "invalid_result");
  if (
    projection.digest !== contextDigest(projection.context) ||
    projection.serialized !== JSON.stringify(projection.context) ||
    result.repairContextDigest !== projection.digest ||
    result.candidateHead !== projection.context.binding.candidateHead ||
    result.reviewReportDigest !== projection.context.binding.reviewReportDigest
  ) {
    throw new IssueReviewRepairProjectionError("identity_mismatch");
  }
  const findings = projection.context.findings.map((finding) => finding.id);
  const criteria = projection.context.acceptanceMapping
    .filter((mapping) => mapping.status === "unsatisfied")
    .map((mapping) => mapping.criterionId);
  const findingIds =
    result.disposition === "changed" ? result.addressedFindingIds : result.disputedFindingIds;
  const criterionIds =
    result.disposition === "changed" ? result.addressedCriterionIds : result.disputedCriterionIds;
  if (
    findingIds.some((id) => !findings.includes(id)) ||
    criterionIds.some((id) => !criteria.includes(id)) ||
    (result.disposition === "changed" &&
      (findingIds.length !== findings.length || criterionIds.length !== criteria.length)) ||
    (result.disposition === "disputed" && findingIds.length + criterionIds.length === 0)
  ) {
    throw new IssueReviewRepairProjectionError("incomplete_disposition");
  }
  return deepFreeze(result);
}

function contextDigest(context: IssueReviewRepairContext): string {
  return calculateIssueLifecycleDomainDigest("flow.issue.review-repair-context.v1", context);
}

function parseShape<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: "invalid_context" | "invalid_result",
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new IssueReviewRepairProjectionError(code);
  return parsed.data;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
