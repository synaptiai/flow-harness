import { z } from "zod";

import type { FrozenIssueRunManifest } from "../domain/issue-lifecycle/private-manifest.js";
import {
  calculateIssueReviewReportDigest,
  type IssueReviewReport,
  parseIssueReviewReport,
} from "../domain/issue-lifecycle/review.js";

export const MAX_ISSUE_REVIEW_RESULT_BYTES = 65_536;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const runIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const implementationWorkflowResultSchema = z
  .object({
    parentIssueRunId: runIdSchema,
    iteration: positiveSafeIntegerSchema.max(64),
    flowRunId: runIdSchema,
    templateWorkflowDigest: sha256Schema,
    executionWorkflowDigest: sha256Schema,
    terminalSequence: positiveSafeIntegerSchema,
    evidenceDigest: sha256Schema,
    workspaceIdentityDigest: sha256Schema,
    candidateTreeDigest: sha256Schema,
    commitMessageDigest: sha256Schema,
  })
  .strict();

const reviewWorkflowResultSchema = z
  .object({
    parentIssueRunId: runIdSchema,
    candidateHead: gitCommitSchema,
    flowRunId: runIdSchema,
    templateWorkflowDigest: sha256Schema,
    executionWorkflowDigest: sha256Schema,
    terminalSequence: positiveSafeIntegerSchema,
    evidenceDigest: sha256Schema,
    resultNodeId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    resultTextTruncated: z.boolean(),
    resultText: z
      .string()
      .min(1)
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_ISSUE_REVIEW_RESULT_BYTES,
        `must not exceed ${MAX_ISSUE_REVIEW_RESULT_BYTES} UTF-8 bytes`,
      ),
  })
  .strict();

export type ImplementationWorkflowResult = Readonly<
  z.infer<typeof implementationWorkflowResultSchema>
>;
export type RawReviewWorkflowResult = Readonly<z.infer<typeof reviewWorkflowResultSchema>>;

export interface ValidatedReviewWorkflowResult extends Omit<RawReviewWorkflowResult, "resultText"> {
  readonly resultText: string;
  readonly report: IssueReviewReport;
  readonly reportDigest: string;
}

export class IssueWorkflowResultError extends Error {
  override readonly name = "IssueWorkflowResultError";

  constructor(
    readonly code: "identity_mismatch" | "invalid_result" | "truncated_result",
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export function validateImplementationWorkflowResult(
  manifest: FrozenIssueRunManifest,
  expectedIteration: number,
  workspaceIdentityDigest: string,
  input: unknown,
): ImplementationWorkflowResult {
  const result = parseShape(implementationWorkflowResultSchema, input, "implementation result");
  if (
    result.parentIssueRunId !== manifest.runId ||
    result.iteration !== expectedIteration ||
    result.templateWorkflowDigest !== manifest.implementationWorkflow.templateWorkflowDigest
  ) {
    throw new IssueWorkflowResultError(
      "identity_mismatch",
      "implementation result does not bind the parent run, iteration, and frozen workflow template",
    );
  }
  if (result.workspaceIdentityDigest !== workspaceIdentityDigest) {
    throw new IssueWorkflowResultError(
      "identity_mismatch",
      "implementation result does not bind the prepared workspace identity",
    );
  }
  return deepFreeze(structuredClone(result));
}

export function validateReviewWorkflowResult(
  manifest: FrozenIssueRunManifest,
  candidateHead: string,
  input: unknown,
): ValidatedReviewWorkflowResult {
  const result = parseShape(reviewWorkflowResultSchema, input, "review result");
  if (
    result.parentIssueRunId !== manifest.runId ||
    result.candidateHead !== candidateHead ||
    result.templateWorkflowDigest !== manifest.reviewWorkflow.templateWorkflowDigest
  ) {
    throw new IssueWorkflowResultError(
      "identity_mismatch",
      "review result does not bind the parent run, exact candidate head, and frozen workflow template",
    );
  }
  if (result.resultNodeId !== manifest.reviewWorkflow.resultNodeId) {
    throw new IssueWorkflowResultError(
      "identity_mismatch",
      "review result does not come from the frozen result node",
    );
  }
  if (result.resultTextTruncated) {
    throw new IssueWorkflowResultError(
      "truncated_result",
      "review result must be complete and untruncated",
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(result.resultText);
  } catch (error) {
    throw new IssueWorkflowResultError("invalid_result", "review result is not valid JSON", {
      cause: error,
    });
  }
  const expectedIdentity = {
    candidateHead,
    issueDigest: manifest.issue.contentDigest,
    reviewWorkflowDigest: result.executionWorkflowDigest,
  };
  const report = parseIssueReviewReport(parsedJson, manifest.acceptanceCriteria, expectedIdentity);
  return deepFreeze({
    ...result,
    report,
    reportDigest: calculateIssueReviewReportDigest(
      report,
      manifest.acceptanceCriteria,
      expectedIdentity,
    ),
  });
}

function parseShape<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new IssueWorkflowResultError(
      "invalid_result",
      `${label} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
