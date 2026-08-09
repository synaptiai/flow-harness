import { createHash } from "node:crypto";

import { parseDocument } from "yaml";
import { z } from "zod";

import {
  parseTuningEvidencePacket,
  type TuningEvidencePacket,
} from "../evaluation/tuning-evidence.js";
import { compileWorkflowText, WorkflowCompilationError } from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import type { WorkflowSource } from "../workflow/schema.js";
import type { CompiledWorkflow } from "../workflow/types.js";

export const PROMPT_CANDIDATE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_PROMPT_CANDIDATE_BYTES = 1_048_576;
export const MAX_PROMPT_CANDIDATE_EVIDENCE = 16;
export const MAX_PROMPT_CANDIDATE_CHANGES = 16;
export const MAX_PROMPT_CANDIDATE_TOTAL_PROMPT_BYTES = 1_048_576;

const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
const portableRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isPortableRelativePath, "must be a canonical portable relative path");

const promptCandidateSourceSchema = z
  .object({
    apiVersion: z.literal(PROMPT_CANDIDATE_API_VERSION),
    kind: z.literal("PromptCandidate"),
    metadata: z
      .object({
        id: identifierSchema,
        version: semverSchema,
      })
      .strict(),
    scope: z
      .object({
        kind: z.literal("workflow"),
        workflowId: identifierSchema,
      })
      .strict(),
    baseline: z
      .object({
        workflow: portableRelativePathSchema,
        sourceSha256: sha256Schema,
        workflowDigest: sha256Schema,
      })
      .strict(),
    evidence: z
      .array(
        z
          .object({
            path: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            evidenceDigest: sha256Schema,
            planDigest: sha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PROMPT_CANDIDATE_EVIDENCE)
      .superRefine((evidence, context) => {
        refineUnique(
          evidence.map((item) => item.path),
          "evidence paths",
          context,
        );
        refineUnique(
          evidence.map((item) => item.evidenceDigest),
          "evidence digests",
          context,
        );
      }),
    changes: z
      .object({
        prompts: z
          .array(
            z
              .object({
                nodeId: identifierSchema,
                expectedSha256: sha256Schema,
                value: z
                  .string()
                  .min(1)
                  .max(262_144)
                  .refine((value) => value.trim().length > 0, "replacement prompt cannot be blank"),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_PROMPT_CANDIDATE_CHANGES)
          .superRefine((prompts, context) => {
            refineUnique(
              prompts.map((item) => item.nodeId),
              "prompt targets",
              context,
            );
            const totalBytes = prompts.reduce(
              (total, item) => total + Buffer.byteLength(item.value, "utf8"),
              0,
            );
            if (totalBytes > MAX_PROMPT_CANDIDATE_TOTAL_PROMPT_BYTES) {
              context.addIssue({
                code: "custom",
                message: `replacement prompts cannot exceed ${MAX_PROMPT_CANDIDATE_TOTAL_PROMPT_BYTES} UTF-8 bytes`,
              });
            }
          }),
      })
      .strict(),
  })
  .strict();

export type PromptCandidateSource = z.infer<typeof promptCandidateSourceSchema>;

export interface PromptCandidateIdentity {
  readonly version: 1;
  readonly id: string;
  readonly candidateVersion: string;
  readonly scope: { readonly kind: "workflow"; readonly workflowId: string };
  readonly manifest: { readonly provenance: string; readonly sourceSha256: string };
  readonly baseline: {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly workflowDigest: string;
  };
  readonly evidence: readonly {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly evidenceDigest: string;
    readonly planDigest: string;
  }[];
  readonly changes: readonly {
    readonly nodeId: string;
    readonly beforeSha256: string;
    readonly afterSha256: string;
  }[];
  readonly projectedWorkflow: {
    readonly sourceSha256: string;
    readonly workflowDigest: string;
  };
  readonly candidateDigest: string;
}

const promptCandidateIdentitySchema: z.ZodType<PromptCandidateIdentity> = z
  .object({
    version: z.literal(1),
    id: identifierSchema,
    candidateVersion: semverSchema,
    scope: z.object({ kind: z.literal("workflow"), workflowId: identifierSchema }).strict(),
    manifest: z
      .object({ provenance: portableRelativePathSchema, sourceSha256: sha256Schema })
      .strict(),
    baseline: z
      .object({
        provenance: portableRelativePathSchema,
        sourceSha256: sha256Schema,
        workflowDigest: sha256Schema,
      })
      .strict(),
    evidence: z
      .array(
        z
          .object({
            provenance: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            evidenceDigest: sha256Schema,
            planDigest: sha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PROMPT_CANDIDATE_EVIDENCE),
    changes: z
      .array(
        z
          .object({
            nodeId: identifierSchema,
            beforeSha256: sha256Schema,
            afterSha256: sha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PROMPT_CANDIDATE_CHANGES),
    projectedWorkflow: z
      .object({ sourceSha256: sha256Schema, workflowDigest: sha256Schema })
      .strict(),
    candidateDigest: sha256Schema,
  })
  .strict()
  .superRefine((identity, context) => {
    if (
      new Set(identity.evidence.map((item) => item.provenance)).size !== identity.evidence.length ||
      new Set(identity.evidence.map((item) => item.evidenceDigest)).size !==
        identity.evidence.length ||
      new Set(identity.changes.map((item) => item.nodeId)).size !== identity.changes.length
    ) {
      context.addIssue({
        code: "custom",
        message: "candidate identity provenance and prompt targets must be unique",
      });
    }
    const { candidateDigest, ...content } = identity;
    if (candidateDigest !== calculatePromptCandidateIdentityDigest(content)) {
      context.addIssue({ code: "custom", message: "candidate identity digest is inconsistent" });
    }
  });

export interface PromptCandidateProjectionInput {
  readonly manifestProvenance: string;
  readonly source: PromptCandidateSource;
  readonly sourceSha256: string;
  readonly baseline: {
    readonly provenance: string;
    readonly source: WorkflowSource;
    readonly sourceSha256: string;
    readonly compiled: CompiledWorkflow;
  };
  readonly evidence: readonly {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly packet: TuningEvidencePacket;
  }[];
}

export interface ProjectedPromptCandidate {
  readonly identity: PromptCandidateIdentity;
  readonly workflow: {
    readonly source: string;
    readonly sourceSha256: string;
    readonly compiled: CompiledWorkflow;
    readonly workflowDigest: string;
  };
}

export type PromptCandidateErrorCode =
  | "identity_mismatch"
  | "invalid_projection"
  | "invalid_schema"
  | "invalid_target"
  | "invalid_yaml"
  | "limit_exceeded";

export class PromptCandidateError extends Error {
  override readonly name = "PromptCandidateError";

  constructor(
    readonly code: PromptCandidateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export function parsePromptCandidateText(
  text: string,
  sourceName = "prompt candidate",
): PromptCandidateSource {
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_CANDIDATE_BYTES) {
    throw new PromptCandidateError(
      "limit_exceeded",
      `${sourceName} exceeds ${MAX_PROMPT_CANDIDATE_BYTES} UTF-8 bytes`,
    );
  }
  let input: unknown;
  try {
    const document = parseDocument(text, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new PromptCandidateError(
        "invalid_yaml",
        `${sourceName}: ${boundedMessages(document.errors.map((error) => error.message))}`,
      );
    }
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof PromptCandidateError) {
      throw error;
    }
    throw new PromptCandidateError(
      "invalid_yaml",
      `${sourceName}: ${boundedText(error instanceof Error ? error.message : String(error), 1_024)}`,
      { cause: error },
    );
  }
  const parsed = promptCandidateSourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new PromptCandidateError(
      "invalid_schema",
      `${sourceName}: ${boundedMessages(
        parsed.error.issues.map(
          (issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`,
        ),
      )}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

export function parsePromptCandidateIdentity(input: unknown): PromptCandidateIdentity {
  const parsed = promptCandidateIdentitySchema.safeParse(input);
  if (!parsed.success) {
    throw new PromptCandidateError(
      "identity_mismatch",
      `invalid candidate identity: ${boundedMessages(
        parsed.error.issues.map(
          (issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`,
        ),
      )}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

export function calculatePromptCandidateIdentityDigest(
  identity: Omit<PromptCandidateIdentity, "candidateDigest">,
): string {
  return sha256(canonicalize(identity));
}

export function projectPromptCandidate(
  input: PromptCandidateProjectionInput,
): ProjectedPromptCandidate {
  validateDigest(input.sourceSha256, "candidate source");
  validateDigest(input.baseline.sourceSha256, "baseline source");
  const baselineDigest = calculateWorkflowDigest(input.baseline.compiled);
  if (
    input.source.baseline.workflow !== input.baseline.provenance ||
    input.source.baseline.sourceSha256 !== input.baseline.sourceSha256 ||
    input.source.baseline.workflowDigest !== baselineDigest
  ) {
    throw new PromptCandidateError(
      "identity_mismatch",
      "candidate baseline identity does not match the admitted workflow",
    );
  }
  if (
    input.baseline.source.metadata.id !== input.source.scope.workflowId ||
    input.baseline.compiled.id !== input.source.scope.workflowId
  ) {
    throw new PromptCandidateError(
      "identity_mismatch",
      "candidate scope does not match the admitted workflow id",
    );
  }
  if (input.evidence.length !== input.source.evidence.length) {
    throw new PromptCandidateError(
      "identity_mismatch",
      "candidate evidence count does not match admitted evidence",
    );
  }

  const admittedEvidence = input.evidence.map((actual, index) => {
    const declared = input.source.evidence[index];
    if (declared === undefined) {
      throw new PromptCandidateError("identity_mismatch", "candidate evidence is incomplete");
    }
    const packet = parseTuningEvidencePacket(actual.packet);
    validateDigest(actual.sourceSha256, `evidence ${index + 1} source`);
    if (
      actual.provenance !== declared.path ||
      actual.sourceSha256 !== declared.sourceSha256 ||
      packet.evidenceDigest !== declared.evidenceDigest ||
      packet.evaluation.planDigest !== declared.planDigest
    ) {
      throw new PromptCandidateError(
        "identity_mismatch",
        `candidate evidence ${index + 1} does not match its declaration`,
      );
    }
    if (!packet.profiles.some((profile) => profile.workflowDigest === baselineDigest)) {
      throw new PromptCandidateError(
        "identity_mismatch",
        `candidate evidence ${index + 1} does not cover the baseline workflow`,
      );
    }
    return {
      provenance: actual.provenance,
      sourceSha256: actual.sourceSha256,
      evidenceDigest: packet.evidenceDigest,
      planDigest: packet.evaluation.planDigest,
    };
  });

  const projectedSource = structuredClone(input.baseline.source);
  const projectedNodes = projectedSource.nodes as Array<WorkflowSource["nodes"][number]>;
  const changes = input.source.changes.prompts.map((change) => {
    const node = projectedNodes.find((item) => item.id === change.nodeId);
    if (node === undefined || node.type !== "agent") {
      throw new PromptCandidateError(
        "invalid_target",
        `prompt target "${change.nodeId}" is not a root agent node`,
      );
    }
    const beforeSha256 = sha256(node.agent.prompt);
    if (beforeSha256 !== change.expectedSha256) {
      throw new PromptCandidateError(
        "identity_mismatch",
        `prompt target "${change.nodeId}" does not match its expected digest`,
      );
    }
    node.agent.prompt = change.value;
    return {
      nodeId: change.nodeId,
      beforeSha256,
      afterSha256: sha256(change.value),
    };
  });

  const projectedWorkflowSource = JSON.stringify(projectedSource);
  let compiled: CompiledWorkflow;
  try {
    compiled = compileWorkflowText(projectedWorkflowSource, input.manifestProvenance);
  } catch (error) {
    throw new PromptCandidateError(
      "invalid_projection",
      error instanceof WorkflowCompilationError
        ? error.message
        : `projected workflow cannot be compiled: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const projectedWorkflow = {
    sourceSha256: sha256(projectedWorkflowSource),
    workflowDigest: calculateWorkflowDigest(compiled),
  };
  const identityWithoutDigest = {
    version: 1 as const,
    id: input.source.metadata.id,
    candidateVersion: input.source.metadata.version,
    scope: input.source.scope,
    manifest: {
      provenance: input.manifestProvenance,
      sourceSha256: input.sourceSha256,
    },
    baseline: {
      provenance: input.baseline.provenance,
      sourceSha256: input.baseline.sourceSha256,
      workflowDigest: baselineDigest,
    },
    evidence: admittedEvidence,
    changes,
    projectedWorkflow,
  };
  const identity = {
    ...identityWithoutDigest,
    candidateDigest: calculatePromptCandidateIdentityDigest(identityWithoutDigest),
  };
  return deepFreeze({
    identity,
    workflow: {
      source: projectedWorkflowSource,
      sourceSha256: projectedWorkflow.sourceSha256,
      compiled,
      workflowDigest: projectedWorkflow.workflowDigest,
    },
  });
}

function refineUnique(values: readonly string[], label: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `${label} must be unique` });
  }
}

function isPortableRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function validateDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new PromptCandidateError("identity_mismatch", `${label} digest is invalid`);
  }
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new PromptCandidateError("invalid_projection", "candidate identity is not canonical JSON");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedMessages(messages: readonly string[]): string {
  const retained = messages.slice(0, 12).map((message) => boundedText(message, 512));
  return `${retained.join("; ")}${messages.length > retained.length ? "; additional diagnostics omitted" : ""}`;
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return value;
}
