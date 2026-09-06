import { z } from "zod";
import {
  calculateIssueCandidateTreeDigest,
  calculateIssueCommitMessageDigest,
} from "../domain/issue-lifecycle/issue-delivery-contract.js";
import type { FrozenIssueRunManifest } from "../domain/issue-lifecycle/private-manifest.js";
import {
  calculateIssueReviewReportDigest,
  type IssueReviewReport,
  parseIssueReviewReport,
} from "../domain/issue-lifecycle/review.js";
import {
  type IssueReviewRepairDisposition,
  type IssueReviewRepairProjection,
  parseIssueReviewRepairDisposition,
} from "./issue-review-repair-projection.js";

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
    iteration: positiveSafeIntegerSchema,
    flowRunId: runIdSchema,
    templateWorkflowDigest: sha256Schema,
    executionWorkflowDigest: sha256Schema,
    terminalSequence: positiveSafeIntegerSchema,
    evidenceDigest: sha256Schema,
    workspaceIdentityDigest: sha256Schema,
    candidateTreeDigest: sha256Schema,
    candidateTree: gitCommitSchema.optional(),
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

const repairResultCommon = {
  parentIssueRunId: runIdSchema,
  cycle: positiveSafeIntegerSchema.max(Number.MAX_SAFE_INTEGER - 1),
  iteration: positiveSafeIntegerSchema,
  candidateHead: gitCommitSchema,
  repairContextDigest: sha256Schema,
  reviewReportDigest: sha256Schema,
  flowRunId: runIdSchema,
  templateWorkflowDigest: sha256Schema,
  executionWorkflowDigest: sha256Schema,
  terminalSequence: positiveSafeIntegerSchema,
  evidenceDigest: sha256Schema,
  workspaceIdentityDigest: sha256Schema,
  resultNodeId: reviewWorkflowResultSchema.shape.resultNodeId,
  resultText: reviewWorkflowResultSchema.shape.resultText,
  resultTextTruncated: z.boolean(),
};
const repairWorkflowResultSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      ...repairResultCommon,
      disposition: z.literal("changed"),
      candidateTree: gitCommitSchema,
      candidateTreeDigest: sha256Schema,
      commitMessageDigest: sha256Schema,
    })
    .strict(),
  z.object({ ...repairResultCommon, disposition: z.literal("disputed") }).strict(),
]);
export type RepairWorkflowResult = Readonly<z.infer<typeof repairWorkflowResultSchema>>;
export type ValidatedRepairWorkflowResult = RepairWorkflowResult & {
  readonly report: IssueReviewRepairDisposition;
};

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

export type IssueWorkflowExecutionErrorCode =
  | "nested_workflow_identity_mismatch"
  | "implementation_workflow_failed"
  | "implementation_workflow_cancelled"
  | "implementation_resource_exhausted"
  | "implementation_workflow_incomplete"
  | "review_workflow_failed"
  | "review_workflow_cancelled"
  | "review_resource_exhausted"
  | "review_workflow_incomplete"
  | "repair_workflow_failed"
  | "repair_workflow_cancelled"
  | "repair_resource_exhausted"
  | "repair_workflow_incomplete";

/** A content-free classification of a failed nested issue workflow. */
export class IssueWorkflowExecutionError extends Error {
  override readonly name = "IssueWorkflowExecutionError";

  constructor(
    readonly code: IssueWorkflowExecutionErrorCode,
    readonly role: "implementation" | "review" | "repair",
    readonly nestedStatus: string,
    readonly failedNodeId: string | null,
    readonly nestedFailureCode: string | null,
  ) {
    super(
      `${code}: nested ${role} workflow status=${nestedStatus}; ` +
        `node=${failedNodeId ?? "none"}; nodeError=${nestedFailureCode ?? "none"}`,
    );
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
    result.iteration >
    (manifest.reviewRepair === undefined ? 64 : manifest.reviewRepair.maxCycles + 1)
  ) {
    throw new IssueWorkflowResultError(
      "identity_mismatch",
      "implementation iteration exceeds the frozen limit",
    );
  }
  if (
    manifest.reviewRepair !== undefined &&
    (result.candidateTree === undefined ||
      calculateIssueCandidateTreeDigest(result.candidateTree) !== result.candidateTreeDigest)
  ) {
    throw new IssueWorkflowResultError(
      "identity_mismatch",
      "implementation result must bind its exact candidate tree",
    );
  }
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
    reviewWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
  };
  const acceptanceCriterionIds = manifest.acceptanceCriteria.map((criterion) => criterion.id);
  const report = parseIssueReviewReport(parsedJson, acceptanceCriterionIds, expectedIdentity);
  return deepFreeze({
    ...result,
    report,
    reportDigest: calculateIssueReviewReportDigest(
      report,
      acceptanceCriterionIds,
      expectedIdentity,
    ),
  });
}

export function validateRepairWorkflowResult(
  manifest: FrozenIssueRunManifest,
  projection: IssueReviewRepairProjection,
  workspaceIdentityDigest: string,
  input: unknown,
): ValidatedRepairWorkflowResult {
  const result = parseShape(repairWorkflowResultSchema, input, "repair result");
  const repair = manifest.reviewRepair;
  if (
    repair === undefined ||
    result.parentIssueRunId !== manifest.runId ||
    result.cycle !== projection.context.binding.cycle ||
    result.cycle > repair.maxCycles ||
    result.iteration !== result.cycle + 1 ||
    result.templateWorkflowDigest !== repair.workflow.templateWorkflowDigest ||
    result.workspaceIdentityDigest !== workspaceIdentityDigest ||
    result.resultNodeId !== repair.workflow.resultNodeId ||
    result.candidateHead !== projection.context.binding.candidateHead ||
    result.repairContextDigest !== projection.digest ||
    result.reviewReportDigest !== projection.context.binding.reviewReportDigest
  ) {
    throw new IssueWorkflowResultError(
      "identity_mismatch",
      "repair result does not bind the frozen repair dispatch",
    );
  }
  const report = parseIssueReviewRepairDisposition(
    result.resultText,
    projection,
    result.resultTextTruncated,
  );
  if (
    report.disposition !== result.disposition ||
    (result.disposition === "changed" &&
      (calculateIssueCandidateTreeDigest(result.candidateTree) !== result.candidateTreeDigest ||
        calculateIssueCommitMessageDigest(manifest.issue.number) !== result.commitMessageDigest))
  ) {
    throw new IssueWorkflowResultError(
      "identity_mismatch",
      "repair result contradicts its disposition or candidate tree",
    );
  }
  return deepFreeze({ ...result, report });
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
