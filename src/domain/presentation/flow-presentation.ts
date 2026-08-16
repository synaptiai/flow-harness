import { z } from "zod";

import { isSafeDisplayText, MAX_SAFE_DISPLAY_TEXT_BYTES } from "./safe-display-text.js";

export const FLOW_PRESENTATION_API_VERSION = "flow.synapti.ai/presentation/v1" as const;
export const MAX_FLOW_PRESENTATION_BYTES = 1024 * 1024;
export const MAX_FLOW_PRESENTATION_SECTIONS = 16;
export const MAX_FLOW_PRESENTATION_COMPONENTS_PER_SECTION = 64;
export const MAX_FLOW_PRESENTATION_FACTS = 64;
export const MAX_FLOW_PRESENTATION_COLUMNS = 8;
export const MAX_FLOW_PRESENTATION_ROWS = 256;
export const MAX_FLOW_PRESENTATION_ACTIONS = 256;
export const MAX_FLOW_PRESENTATION_JSON_DEPTH = 9;
export const MAX_FLOW_PRESENTATION_JSON_NODES = 16_384;

const safeTextSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_SAFE_DISPLAY_TEXT_BYTES)
  .refine(isSafeDisplayText);
const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const runStatusSchema = z.enum([
  "running",
  "waiting_for_approval",
  "succeeded",
  "failed",
  "cancelled",
  "resource_exhausted",
]);

const headingComponentSchema = z
  .object({
    kind: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: safeTextSchema,
  })
  .strict();
const factsComponentSchema = z
  .object({
    kind: z.literal("facts"),
    items: z
      .array(z.object({ label: safeTextSchema, value: safeTextSchema }).strict())
      .max(MAX_FLOW_PRESENTATION_FACTS),
  })
  .strict();
const progressComponentSchema = z
  .object({
    kind: z.literal("progress"),
    label: safeTextSchema,
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.completed <= value.total, "completed progress must not exceed total");
const tableComponentSchema = z
  .object({
    kind: z.literal("table"),
    columns: z
      .array(z.object({ key: identifierSchema, label: safeTextSchema }).strict())
      .min(1)
      .max(MAX_FLOW_PRESENTATION_COLUMNS),
    rows: z
      .array(
        z
          .object({
            id: identifierSchema,
            cells: z.array(safeTextSchema).max(MAX_FLOW_PRESENTATION_COLUMNS),
          })
          .strict(),
      )
      .max(MAX_FLOW_PRESENTATION_ROWS),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const columnKeys = value.columns.map((column) => column.key);
    if (new Set(columnKeys).size !== columnKeys.length) {
      context.addIssue({ code: "custom", message: "table column keys must be unique" });
    }
    const rowIds = value.rows.map((row) => row.id);
    if (new Set(rowIds).size !== rowIds.length) {
      context.addIssue({ code: "custom", message: "table row ids must be unique" });
    }
    for (const [index, row] of value.rows.entries()) {
      if (row.cells.length !== value.columns.length) {
        context.addIssue({
          code: "custom",
          path: ["rows", index, "cells"],
          message: "table row cell count must match the column count",
        });
      }
    }
  });
const noticeComponentSchema = z
  .object({
    kind: z.literal("notice"),
    tone: z.enum(["info", "success", "warning", "danger"]),
    text: safeTextSchema,
  })
  .strict();
const dividerComponentSchema = z.object({ kind: z.literal("divider") }).strict();
const componentSchema = z.discriminatedUnion("kind", [
  headingComponentSchema,
  factsComponentSchema,
  progressComponentSchema,
  tableComponentSchema,
  noticeComponentSchema,
  dividerComponentSchema,
]);

const decisionActionFields = {
  actionId: identifierSchema,
  requestId: identifierSchema,
  label: safeTextSchema,
};
const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve"), ...decisionActionFields }).strict(),
  z.object({ kind: z.literal("deny"), ...decisionActionFields }).strict(),
  z
    .object({
      kind: z.literal("cancel"),
      actionId: identifierSchema,
      runId: identifierSchema,
      label: safeTextSchema,
    })
    .strict(),
]);

const flowPresentationDocumentSchema = z
  .object({
    apiVersion: z.literal(FLOW_PRESENTATION_API_VERSION),
    run: z
      .object({
        runId: identifierSchema,
        workflowId: identifierSchema,
        status: runStatusSchema,
        sequence: z.number().int().positive(),
      })
      .strict(),
    sections: z
      .array(
        z
          .object({
            id: identifierSchema,
            title: safeTextSchema.optional(),
            components: z
              .array(componentSchema)
              .min(1)
              .max(MAX_FLOW_PRESENTATION_COMPONENTS_PER_SECTION),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_FLOW_PRESENTATION_SECTIONS),
    actions: z.array(actionSchema).max(MAX_FLOW_PRESENTATION_ACTIONS),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const sectionIds = value.sections.map((section) => section.id);
    if (new Set(sectionIds).size !== sectionIds.length) {
      context.addIssue({ code: "custom", message: "section ids must be unique" });
    }
    const actionIds = value.actions.map((action) => action.actionId);
    if (new Set(actionIds).size !== actionIds.length) {
      context.addIssue({ code: "custom", message: "action ids must be unique" });
    }
  });

export type FlowPresentationDocument = z.infer<typeof flowPresentationDocumentSchema>;
export type FlowPresentationComponent =
  FlowPresentationDocument["sections"][number]["components"][number];
export type FlowPresentationAction = FlowPresentationDocument["actions"][number];

export class FlowPresentationError extends Error {
  override readonly name = "FlowPresentationError";
}

export function parseFlowPresentationDocument(input: unknown): FlowPresentationDocument {
  assertJsonShapeBounded(input);
  const parsed = flowPresentationDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new FlowPresentationError("Flow presentation document is invalid");
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
  if (serializedBytes > MAX_FLOW_PRESENTATION_BYTES) {
    throw new FlowPresentationError(
      `Flow presentation document must not exceed ${MAX_FLOW_PRESENTATION_BYTES} UTF-8 bytes`,
    );
  }
  return parsed.data;
}

export function encodeFlowPresentationDocument(input: FlowPresentationDocument): string {
  return JSON.stringify(parseFlowPresentationDocument(input));
}

function assertJsonShapeBounded(input: unknown): void {
  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value: input, depth: 1 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    nodes += 1;
    if (nodes > MAX_FLOW_PRESENTATION_JSON_NODES) {
      throw new FlowPresentationError("Flow presentation document contains too many values");
    }
    if (current.depth > MAX_FLOW_PRESENTATION_JSON_DEPTH) {
      throw new FlowPresentationError("Flow presentation document is too deeply nested");
    }
    if (Array.isArray(current.value)) {
      for (const value of current.value) {
        pending.push({ value, depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      for (const value of Object.values(current.value)) {
        pending.push({ value, depth: current.depth + 1 });
      }
    }
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
