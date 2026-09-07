import { z } from "zod";

import { issueWorkflowRolePoolsSchema } from "./workflow-accounting.js";

export const ISSUE_REVIEW_REPAIR_CLASSES = Object.freeze([
  "review-findings",
  "unsatisfied-criteria",
] as const);

/** Operator-owned policy. No field supplies authority through an implicit default. */
export const issueReviewRepairPolicySchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("preauthorized"),
    // Initial implementation is not a repair cycle; its ordinal must remain representable.
    maxCycles: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
    eligibleClasses: z
      .array(z.enum(ISSUE_REVIEW_REPAIR_CLASSES))
      .min(1)
      .max(ISSUE_REVIEW_REPAIR_CLASSES.length)
      .refine((values) => new Set(values).size === values.length, "repair classes must be unique"),
    aggregateBudget: issueWorkflowRolePoolsSchema,
    stopping: z
      .object({
        disputed: z.literal("stop"),
        unchangedTree: z.literal("stop"),
        repeatedTree: z.literal("stop"),
        uncertainUsage: z.literal("stop"),
        uncertainEffects: z.literal("stop"),
      })
      .strict(),
  })
  .strict();

export type IssueReviewRepairPolicy = Readonly<z.infer<typeof issueReviewRepairPolicySchema>>;
