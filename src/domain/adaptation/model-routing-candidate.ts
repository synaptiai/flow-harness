import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { parseDocument } from "yaml";
import { z } from "zod";

import { compileWorkflowText, WorkflowCompilationError } from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import type { WorkflowSource } from "../workflow/schema.js";
import type { CompiledWorkflow, ThinkingLevel } from "../workflow/types.js";

export const MODEL_ROUTING_CANDIDATE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_MODEL_ROUTING_CANDIDATE_BYTES = 65_536;
export const MAX_MODEL_ROUTING_PROJECTED_WORKFLOW_BYTES = 8 * 1024 * 1024;

const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const semanticVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const portableRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isPortableRelativePath, "must be a canonical portable relative path");
const modelRouteSchema = z
  .object({
    provider: identifierSchema,
    id: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value === value.trim(), "model id must not contain outer whitespace"),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  })
  .strict();

const sourceSchema = z
  .object({
    apiVersion: z.literal(MODEL_ROUTING_CANDIDATE_API_VERSION),
    kind: z.literal("ModelRoutingCandidate"),
    metadata: z.object({ id: identifierSchema, version: semanticVersionSchema }).strict(),
    scope: z
      .object({
        kind: z.literal("workflow-model-route"),
        workflowId: identifierSchema,
        nodeId: identifierSchema,
      })
      .strict(),
    baseline: z
      .object({
        workflow: z
          .object({
            path: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    route: z.object({ before: modelRouteSchema, after: modelRouteSchema }).strict(),
  })
  .strict()
  .refine((source) => !isDeepStrictEqual(source.route.before, source.route.after), {
    path: ["route", "after"],
    message: "replacement route must differ from the baseline route",
  });

export type ModelRoute = Readonly<z.infer<typeof modelRouteSchema>>;
export type ModelRoutingCandidateSource = Readonly<z.infer<typeof sourceSchema>>;

export interface ModelRoutingCandidateIdentity {
  readonly version: 1;
  readonly kind: "model-routing-candidate";
  readonly id: string;
  readonly candidateVersion: string;
  readonly scope: ModelRoutingCandidateSource["scope"];
  readonly manifest: {
    readonly provenance: string;
    readonly sourceSha256: string;
  };
  readonly baseline: {
    readonly workflow: {
      readonly provenance: string;
      readonly sourceSha256: string;
      readonly workflowDigest: string;
    };
  };
  readonly route: {
    readonly before: ModelRoute;
    readonly after: ModelRoute;
  };
  readonly projectedWorkflow: {
    readonly sourceSha256: string;
    readonly workflowDigest: string;
  };
  readonly candidateDigest: string;
}

const identitySchema: z.ZodType<ModelRoutingCandidateIdentity> = z
  .object({
    version: z.literal(1),
    kind: z.literal("model-routing-candidate"),
    id: identifierSchema,
    candidateVersion: semanticVersionSchema,
    scope: sourceSchema.shape.scope,
    manifest: z
      .object({ provenance: portableRelativePathSchema, sourceSha256: sha256Schema })
      .strict(),
    baseline: z
      .object({
        workflow: z
          .object({
            provenance: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    route: z.object({ before: modelRouteSchema, after: modelRouteSchema }).strict(),
    projectedWorkflow: z
      .object({ sourceSha256: sha256Schema, workflowDigest: sha256Schema })
      .strict(),
    candidateDigest: sha256Schema,
  })
  .strict()
  .refine((identity) => !isDeepStrictEqual(identity.route.before, identity.route.after), {
    path: ["route", "after"],
    message: "replacement route must differ from the baseline route",
  });

export interface ModelRoutingCandidateProjectionInput {
  readonly manifestProvenance: string;
  readonly sourceSha256: string;
  readonly source: ModelRoutingCandidateSource;
  readonly baseline: {
    readonly provenance: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly source: WorkflowSource;
    readonly compiled: CompiledWorkflow;
  };
}

export interface ProjectedModelRoutingCandidate {
  readonly identity: ModelRoutingCandidateIdentity;
  readonly workflow: {
    readonly source: string;
    readonly sourceSha256: string;
    readonly compiled: CompiledWorkflow;
    readonly workflowDigest: string;
  };
}

export type ModelRoutingCandidateErrorCode =
  | "identity_mismatch"
  | "invalid_projection"
  | "invalid_schema"
  | "invalid_target"
  | "invalid_yaml"
  | "limit_exceeded";

export class ModelRoutingCandidateError extends Error {
  override readonly name = "ModelRoutingCandidateError";

  constructor(
    readonly code: ModelRoutingCandidateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export function parseModelRoutingCandidateText(
  source: string,
  sourceName = "model-routing candidate",
): ModelRoutingCandidateSource {
  if (Buffer.byteLength(source, "utf8") > MAX_MODEL_ROUTING_CANDIDATE_BYTES) {
    throw new ModelRoutingCandidateError(
      "limit_exceeded",
      `${sourceName} exceeds ${MAX_MODEL_ROUTING_CANDIDATE_BYTES} UTF-8 bytes`,
    );
  }
  let input: unknown;
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new ModelRoutingCandidateError(
        "invalid_yaml",
        `${sourceName}: ${boundedMessages(document.errors.map((error) => error.message))}`,
      );
    }
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof ModelRoutingCandidateError) throw error;
    throw new ModelRoutingCandidateError("invalid_yaml", `${sourceName} cannot be parsed`, {
      cause: error,
    });
  }
  const parsed = sourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new ModelRoutingCandidateError(
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

export function parseModelRoutingCandidateIdentity(input: unknown): ModelRoutingCandidateIdentity {
  const parsed = identitySchema.safeParse(input);
  if (!parsed.success) {
    throw new ModelRoutingCandidateError(
      "identity_mismatch",
      `model-routing candidate identity is invalid: ${boundedMessages(
        parsed.error.issues.map(
          (issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`,
        ),
      )}`,
    );
  }
  const identity = parsed.data;
  const { candidateDigest: _candidateDigest, ...withoutDigest } = identity;
  if (calculateModelRoutingCandidateDigest(withoutDigest) !== identity.candidateDigest) {
    throw new ModelRoutingCandidateError(
      "identity_mismatch",
      "model-routing candidate identity digest does not match",
    );
  }
  return deepFreeze(identity);
}

export function calculateModelRoutingCandidateDigest(
  input: Omit<ModelRoutingCandidateIdentity, "candidateDigest">,
): string {
  return sha256(canonicalize(input));
}

export function projectModelRoutingCandidate(
  input: ModelRoutingCandidateProjectionInput,
): ProjectedModelRoutingCandidate {
  validateSha256(input.sourceSha256, "candidate source");
  validateSha256(input.baseline.sourceSha256, "baseline workflow source");
  const baselineDigest = calculateWorkflowDigest(input.baseline.compiled);
  if (
    input.source.baseline.workflow.path !== input.baseline.provenance ||
    input.source.baseline.workflow.sourceSha256 !== input.baseline.sourceSha256 ||
    input.source.baseline.workflow.workflowDigest !== baselineDigest ||
    input.baseline.source.metadata.id !== input.source.scope.workflowId ||
    input.baseline.compiled.id !== input.source.scope.workflowId
  ) {
    throw new ModelRoutingCandidateError(
      "identity_mismatch",
      "model-routing candidate baseline does not match the admitted workflow",
    );
  }

  const projectedSource = structuredClone(input.baseline.source);
  const sourceNode = projectedSource.nodes.find((node) => node.id === input.source.scope.nodeId);
  const compiledNode = input.baseline.compiled.nodes.find(
    (node) => node.id === input.source.scope.nodeId,
  );
  if (sourceNode?.type !== "agent" || compiledNode?.type !== "agent") {
    throw new ModelRoutingCandidateError(
      "invalid_target",
      "model-routing candidate target is not a root agent node",
    );
  }
  if (
    !isDeepStrictEqual(sourceNode.agent.model, input.source.route.before) ||
    !isDeepStrictEqual(compiledNode.agent.model, input.source.route.before)
  ) {
    throw new ModelRoutingCandidateError(
      "identity_mismatch",
      "model-routing candidate target does not match its declared baseline route",
    );
  }
  (sourceNode.agent as { model: ModelRoute }).model = structuredClone(input.source.route.after);
  const projectedWorkflowSource = JSON.stringify(projectedSource);
  if (
    Buffer.byteLength(projectedWorkflowSource, "utf8") > MAX_MODEL_ROUTING_PROJECTED_WORKFLOW_BYTES
  ) {
    throw new ModelRoutingCandidateError(
      "limit_exceeded",
      `projected workflow exceeds ${MAX_MODEL_ROUTING_PROJECTED_WORKFLOW_BYTES} UTF-8 bytes`,
    );
  }

  let compiled: CompiledWorkflow;
  try {
    compiled = compileWorkflowText(projectedWorkflowSource, input.manifestProvenance);
  } catch (error) {
    throw new ModelRoutingCandidateError(
      "invalid_projection",
      error instanceof WorkflowCompilationError
        ? error.message
        : "model-routing candidate workflow cannot be compiled",
      { cause: error },
    );
  }
  assertOnlyDeclaredRouteChanged(
    input.baseline.compiled,
    compiled,
    input.source.scope.nodeId,
    input.source.route.before,
    input.source.route.after,
  );
  const projectedWorkflow = {
    sourceSha256: sha256(projectedWorkflowSource),
    workflowDigest: calculateWorkflowDigest(compiled),
  };
  const identityWithoutDigest: Omit<ModelRoutingCandidateIdentity, "candidateDigest"> = {
    version: 1,
    kind: "model-routing-candidate",
    id: input.source.metadata.id,
    candidateVersion: input.source.metadata.version,
    scope: input.source.scope,
    manifest: {
      provenance: input.manifestProvenance,
      sourceSha256: input.sourceSha256,
    },
    baseline: {
      workflow: {
        provenance: input.baseline.provenance,
        sourceSha256: input.baseline.sourceSha256,
        workflowDigest: baselineDigest,
      },
    },
    route: input.source.route,
    projectedWorkflow,
  };
  const identity = parseModelRoutingCandidateIdentity({
    ...identityWithoutDigest,
    candidateDigest: calculateModelRoutingCandidateDigest(identityWithoutDigest),
  });
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

function assertOnlyDeclaredRouteChanged(
  baseline: CompiledWorkflow,
  candidate: CompiledWorkflow,
  nodeId: string,
  before: ModelRoute,
  after: ModelRoute,
): void {
  const normalized = structuredClone(candidate);
  const target = normalized.nodes.find((node) => node.id === nodeId);
  if (
    target?.type !== "agent" ||
    !isDeepStrictEqual(target.agent.model, after) ||
    !isDeepStrictEqual(
      baseline.nodes.find((node) => node.id === nodeId)?.type === "agent"
        ? (
            baseline.nodes.find((node) => node.id === nodeId) as Extract<
              CompiledWorkflow["nodes"][number],
              { type: "agent" }
            >
          ).agent.model
        : undefined,
      before,
    )
  ) {
    throw new ModelRoutingCandidateError(
      "identity_mismatch",
      "model-routing candidate route identity does not match the compiled workflows",
    );
  }
  (target.agent as { model: { provider: string; id: string; thinking: ThinkingLevel } }).model =
    structuredClone(before);
  if (!isDeepStrictEqual(normalizeJson(normalized), normalizeJson(baseline))) {
    throw new ModelRoutingCandidateError(
      "invalid_projection",
      "model-routing candidate changes controls outside its declared route",
    );
  }
}

function normalizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ModelRoutingCandidateError("identity_mismatch", `${label} digest is invalid`);
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
  throw new ModelRoutingCandidateError(
    "invalid_projection",
    "model-routing candidate identity is not canonical JSON",
  );
}

function boundedMessages(messages: readonly string[]): string {
  const retained = messages
    .slice(0, 12)
    .map((message) => (message.length <= 512 ? message : `${message.slice(0, 512)}…`));
  return `${retained.join("; ")}${messages.length > retained.length ? "; additional diagnostics omitted" : ""}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
