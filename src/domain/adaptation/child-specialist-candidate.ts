import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { parseDocument } from "yaml";
import { z } from "zod";

import {
  agentSkillNameSchema,
  type CapabilityPackageSnapshot,
  calculateCapabilitySnapshotDigest,
  MAX_AGENT_SKILL_PACKAGES,
  validateCapabilitySnapshot,
} from "../capability/agent-skills.js";
import { bindWorkflowCapabilities } from "../capability/workflow-capabilities.js";
import {
  compileWorkflowText,
  parseWorkflowSourceText,
  WorkflowCompilationError,
} from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import type { WorkflowSource } from "../workflow/schema.js";
import type { CompiledWorkflow } from "../workflow/types.js";

export const CHILD_SPECIALIST_CANDIDATE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_CHILD_SPECIALIST_CANDIDATE_BYTES = 1_048_576;
export const MAX_CHILD_SPECIALIST_INSTRUCTIONS_BYTES = 262_144;
export const MAX_CHILD_SPECIALIST_PROJECTED_WORKFLOW_BYTES = 8 * 1024 * 1024;

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
const scopeSchema = z
  .object({
    kind: z.literal("workflow-child-specialist"),
    workflowId: identifierSchema,
    childNodeId: identifierSchema,
    agentNodeId: identifierSchema,
  })
  .strict();
const byteIdentitySchema = z
  .object({
    bytes: z.number().int().min(1).max(MAX_CHILD_SPECIALIST_INSTRUCTIONS_BYTES),
    sha256: sha256Schema,
  })
  .strict();
const instructionsChangeSchema = z
  .object({
    kind: z.literal("instructions"),
    beforeSha256: sha256Schema,
    value: z
      .string()
      .refine((value) => value.trim().length > 0, "instructions must not be blank")
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_CHILD_SPECIALIST_INSTRUCTIONS_BYTES,
        `instructions must not exceed ${MAX_CHILD_SPECIALIST_INSTRUCTIONS_BYTES} UTF-8 bytes`,
      ),
  })
  .strict();
const skillSelectionSchema = z
  .array(agentSkillNameSchema)
  .max(MAX_AGENT_SKILL_PACKAGES)
  .superRefine((skills, context) => {
    if (new Set(skills).size !== skills.length) {
      context.addIssue({ code: "custom", message: "Agent Skill names must be unique" });
    }
  });
const skillsChangeSchema = z
  .object({
    kind: z.literal("skills"),
    before: skillSelectionSchema,
    after: skillSelectionSchema,
  })
  .strict()
  .refine((change) => !isDeepStrictEqual(change.before, change.after), {
    path: ["after"],
    message: "replacement Agent Skill selection must differ from the baseline selection",
  });
const changeSchema = z.discriminatedUnion("kind", [instructionsChangeSchema, skillsChangeSchema]);

const sourceSchema = z
  .object({
    apiVersion: z.literal(CHILD_SPECIALIST_CANDIDATE_API_VERSION),
    kind: z.literal("ChildSpecialistCandidate"),
    metadata: z.object({ id: identifierSchema, version: semanticVersionSchema }).strict(),
    scope: scopeSchema,
    baseline: z
      .object({
        workflow: z
          .object({
            path: portableRelativePathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
          })
          .strict(),
        child: z.object({ sourceSha256: sha256Schema, workflowDigest: sha256Schema }).strict(),
        packageClosureDigest: sha256Schema,
      })
      .strict(),
    change: changeSchema,
  })
  .strict();

export type ChildSpecialistCandidateSource = Readonly<z.infer<typeof sourceSchema>>;

export interface ChildSpecialistCandidateIdentity {
  readonly version: 1;
  readonly kind: "child-specialist-candidate";
  readonly id: string;
  readonly candidateVersion: string;
  readonly scope: ChildSpecialistCandidateSource["scope"];
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
    readonly child: {
      readonly sourceSha256: string;
      readonly workflowDigest: string;
    };
    readonly packageClosureDigest: string;
  };
  readonly change:
    | {
        readonly kind: "instructions";
        readonly before: { readonly bytes: number; readonly sha256: string };
        readonly after: { readonly bytes: number; readonly sha256: string };
      }
    | {
        readonly kind: "skills";
        readonly before: readonly string[];
        readonly after: readonly string[];
      };
  readonly projectedWorkflow: {
    readonly sourceSha256: string;
    readonly workflowDigest: string;
  };
  readonly candidateDigest: string;
}

const identitySchema: z.ZodType<ChildSpecialistCandidateIdentity> = z
  .object({
    version: z.literal(1),
    kind: z.literal("child-specialist-candidate"),
    id: identifierSchema,
    candidateVersion: semanticVersionSchema,
    scope: scopeSchema,
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
        child: z.object({ sourceSha256: sha256Schema, workflowDigest: sha256Schema }).strict(),
        packageClosureDigest: sha256Schema,
      })
      .strict(),
    change: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("instructions"),
          before: byteIdentitySchema,
          after: byteIdentitySchema,
        })
        .strict()
        .refine((change) => change.before.sha256 !== change.after.sha256, {
          path: ["after"],
          message: "replacement instructions must differ from the baseline instructions",
        }),
      z
        .object({
          kind: z.literal("skills"),
          before: skillSelectionSchema,
          after: skillSelectionSchema,
        })
        .strict()
        .refine((change) => !isDeepStrictEqual(change.before, change.after), {
          path: ["after"],
          message: "replacement Agent Skill selection must differ from the baseline selection",
        }),
    ]),
    projectedWorkflow: z
      .object({ sourceSha256: sha256Schema, workflowDigest: sha256Schema })
      .strict(),
    candidateDigest: sha256Schema,
  })
  .strict();

export interface ChildSpecialistCandidateProjectionInput {
  readonly manifestProvenance: string;
  readonly sourceSha256: string;
  readonly source: ChildSpecialistCandidateSource;
  readonly baseline: {
    readonly provenance: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly source: WorkflowSource;
    readonly compiled: CompiledWorkflow;
    readonly packages: readonly CapabilityPackageSnapshot[];
  };
}

export interface ProjectedChildSpecialistCandidate {
  readonly identity: ChildSpecialistCandidateIdentity;
  readonly workflow: {
    readonly source: string;
    readonly sourceSha256: string;
    readonly compiled: CompiledWorkflow;
    readonly workflowDigest: string;
  };
}

export type ChildSpecialistCandidateErrorCode =
  | "identity_mismatch"
  | "invalid_projection"
  | "invalid_schema"
  | "invalid_target"
  | "invalid_yaml"
  | "limit_exceeded";

export class ChildSpecialistCandidateError extends Error {
  override readonly name = "ChildSpecialistCandidateError";

  constructor(
    readonly code: ChildSpecialistCandidateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${boundedText(message, 8_192)}`, options);
  }
}

export function parseChildSpecialistCandidateText(
  text: string,
  sourceName = "child-specialist candidate",
): ChildSpecialistCandidateSource {
  if (Buffer.byteLength(text, "utf8") > MAX_CHILD_SPECIALIST_CANDIDATE_BYTES) {
    throw new ChildSpecialistCandidateError(
      "limit_exceeded",
      `candidate exceeds ${MAX_CHILD_SPECIALIST_CANDIDATE_BYTES} UTF-8 bytes`,
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
      throw new ChildSpecialistCandidateError(
        "invalid_yaml",
        `${sourceName}: ${boundedMessages(document.errors.map((error) => error.message))}`,
      );
    }
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof ChildSpecialistCandidateError) throw error;
    throw new ChildSpecialistCandidateError("invalid_yaml", `${sourceName} cannot be parsed`, {
      cause: error,
    });
  }
  const parsed = sourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new ChildSpecialistCandidateError(
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

export function parseChildSpecialistCandidateIdentity(
  input: unknown,
): ChildSpecialistCandidateIdentity {
  const parsed = identitySchema.safeParse(input);
  if (!parsed.success) {
    throw new ChildSpecialistCandidateError(
      "identity_mismatch",
      `child-specialist candidate identity is invalid: ${boundedMessages(
        parsed.error.issues.map(
          (issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`,
        ),
      )}`,
    );
  }
  const identity = parsed.data;
  const { candidateDigest: _candidateDigest, ...withoutDigest } = identity;
  if (calculateChildSpecialistCandidateDigest(withoutDigest) !== identity.candidateDigest) {
    throw new ChildSpecialistCandidateError(
      "identity_mismatch",
      "child-specialist candidate identity digest does not match",
    );
  }
  return deepFreeze(identity);
}

export function calculateChildSpecialistCandidateDigest(
  input: Omit<ChildSpecialistCandidateIdentity, "candidateDigest">,
): string {
  return sha256(canonicalize(input));
}

export function projectChildSpecialistCandidate(
  input: ChildSpecialistCandidateProjectionInput,
): ProjectedChildSpecialistCandidate {
  validateSha256(input.sourceSha256, "candidate source");
  validateSha256(input.baseline.sourceSha256, "baseline workflow source");
  const baselineDigest = calculateWorkflowDigest(input.baseline.compiled);
  const packageSnapshot = validateCapabilitySnapshot({
    version: 1,
    packages: input.baseline.packages,
    digest: calculateCapabilitySnapshotDigest(input.baseline.packages),
  });
  try {
    bindWorkflowCapabilities(input.baseline.compiled, packageSnapshot);
  } catch {
    throw new ChildSpecialistCandidateError(
      "identity_mismatch",
      "child-specialist candidate package closure does not bind the admitted harness",
    );
  }
  if (
    sha256(input.baseline.sourceText) !== input.baseline.sourceSha256 ||
    !isDeepStrictEqual(
      normalizeJson(parseWorkflowSourceText(input.baseline.sourceText, input.baseline.provenance)),
      normalizeJson(input.baseline.source),
    ) ||
    input.source.baseline.workflow.path !== input.baseline.provenance ||
    input.source.baseline.workflow.sourceSha256 !== input.baseline.sourceSha256 ||
    input.source.baseline.workflow.workflowDigest !== baselineDigest ||
    input.source.baseline.packageClosureDigest !== packageSnapshot.digest ||
    input.baseline.source.metadata.id !== input.source.scope.workflowId ||
    input.baseline.compiled.id !== input.source.scope.workflowId
  ) {
    throw new ChildSpecialistCandidateError(
      "identity_mismatch",
      "child-specialist candidate baseline does not match the admitted harness",
    );
  }

  const projectedSource = structuredClone(input.baseline.source);
  const sourceChild = projectedSource.nodes.find(
    (node) => node.id === input.source.scope.childNodeId,
  );
  const compiledChild = input.baseline.compiled.nodes.find(
    (node) => node.id === input.source.scope.childNodeId,
  );
  if (
    sourceChild?.type !== "child" ||
    compiledChild?.type !== "child" ||
    !("workflow" in sourceChild.child)
  ) {
    throw new ChildSpecialistCandidateError(
      "invalid_target",
      "child-specialist candidate target is not an embedded child workflow",
    );
  }

  const baselineChildText = sourceChild.child.workflow;
  const baselineChildSource = parseWorkflowSourceText(
    baselineChildText,
    `${input.baseline.provenance}#${input.source.scope.childNodeId}`,
  );
  const baselineChildDigest = calculateWorkflowDigest(compiledChild.child.workflow);
  if (
    sha256(baselineChildText) !== input.source.baseline.child.sourceSha256 ||
    baselineChildDigest !== input.source.baseline.child.workflowDigest
  ) {
    throw new ChildSpecialistCandidateError(
      "identity_mismatch",
      "child-specialist candidate child baseline does not match the admitted harness",
    );
  }

  const sourceAgent = baselineChildSource.nodes.find(
    (node) => node.id === input.source.scope.agentNodeId,
  );
  const compiledAgent = compiledChild.child.workflow.nodes.find(
    (node) => node.id === input.source.scope.agentNodeId,
  );
  if (sourceAgent?.type !== "agent" || compiledAgent?.type !== "agent") {
    throw new ChildSpecialistCandidateError(
      "invalid_target",
      "child-specialist candidate target is not an agent in the selected child workflow",
    );
  }
  let identityChange: ChildSpecialistCandidateIdentity["change"];
  if (input.source.change.kind === "instructions") {
    if (
      sha256(sourceAgent.agent.prompt) !== input.source.change.beforeSha256 ||
      sourceAgent.agent.prompt !== compiledAgent.agent.prompt
    ) {
      throw new ChildSpecialistCandidateError(
        "identity_mismatch",
        "child-specialist candidate instructions do not match the declared baseline",
      );
    }
    if (sourceAgent.agent.prompt === input.source.change.value) {
      throw new ChildSpecialistCandidateError(
        "invalid_projection",
        "child-specialist candidate must change its declared axis",
      );
    }
    const beforeInstructions = sourceAgent.agent.prompt;
    sourceAgent.agent.prompt = input.source.change.value;
    identityChange = {
      kind: "instructions",
      before: byteIdentity(beforeInstructions),
      after: byteIdentity(input.source.change.value),
    };
  } else {
    if (
      !isDeepStrictEqual(sourceAgent.agent.skills, input.source.change.before) ||
      !isDeepStrictEqual(compiledAgent.agent.skills, input.source.change.before)
    ) {
      throw new ChildSpecialistCandidateError(
        "identity_mismatch",
        "child-specialist candidate Agent Skills do not match the declared baseline",
      );
    }
    const admittedSkills = new Set(
      packageSnapshot.packages
        .filter((capability) => capability.kind === "agent-skill")
        .map((capability) => capability.name),
    );
    if (input.source.change.after.some((skill) => !admittedSkills.has(skill))) {
      throw new ChildSpecialistCandidateError(
        "invalid_target",
        "child-specialist candidate selects an Agent Skill outside the admitted package closure",
      );
    }
    sourceAgent.agent.skills = [...input.source.change.after];
    identityChange = {
      kind: "skills",
      before: input.source.change.before,
      after: input.source.change.after,
    };
  }
  sourceChild.child.workflow = JSON.stringify(baselineChildSource);
  const projectedWorkflowSource = JSON.stringify(projectedSource);
  if (
    Buffer.byteLength(projectedWorkflowSource, "utf8") >
    MAX_CHILD_SPECIALIST_PROJECTED_WORKFLOW_BYTES
  ) {
    throw new ChildSpecialistCandidateError(
      "limit_exceeded",
      `projected workflow exceeds ${MAX_CHILD_SPECIALIST_PROJECTED_WORKFLOW_BYTES} UTF-8 bytes`,
    );
  }

  let compiled: CompiledWorkflow;
  try {
    compiled = compileWorkflowText(projectedWorkflowSource, input.manifestProvenance);
  } catch (error) {
    throw new ChildSpecialistCandidateError(
      "invalid_projection",
      error instanceof WorkflowCompilationError
        ? error.message
        : "child-specialist candidate workflow cannot be compiled",
      { cause: error },
    );
  }
  assertOnlyDeclaredChange({
    baseline: input.baseline.compiled,
    candidate: compiled,
    childNodeId: input.source.scope.childNodeId,
    agentNodeId: input.source.scope.agentNodeId,
    change: identityChange,
  });

  const projectedWorkflow = {
    sourceSha256: sha256(projectedWorkflowSource),
    workflowDigest: calculateWorkflowDigest(compiled),
  };
  const identityWithoutDigest: Omit<ChildSpecialistCandidateIdentity, "candidateDigest"> = {
    version: 1,
    kind: "child-specialist-candidate",
    id: input.source.metadata.id,
    candidateVersion: input.source.metadata.version,
    scope: input.source.scope,
    manifest: { provenance: input.manifestProvenance, sourceSha256: input.sourceSha256 },
    baseline: {
      workflow: {
        provenance: input.baseline.provenance,
        sourceSha256: input.baseline.sourceSha256,
        workflowDigest: baselineDigest,
      },
      child: {
        sourceSha256: sha256(baselineChildText),
        workflowDigest: baselineChildDigest,
      },
      packageClosureDigest: packageSnapshot.digest,
    },
    change: identityChange,
    projectedWorkflow,
  };
  const identity = parseChildSpecialistCandidateIdentity({
    ...identityWithoutDigest,
    candidateDigest: calculateChildSpecialistCandidateDigest(identityWithoutDigest),
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

function assertOnlyDeclaredChange(input: {
  readonly baseline: CompiledWorkflow;
  readonly candidate: CompiledWorkflow;
  readonly childNodeId: string;
  readonly agentNodeId: string;
  readonly change: ChildSpecialistCandidateIdentity["change"];
}): void {
  const normalized = structuredClone(input.candidate);
  const baselineChild = input.baseline.nodes.find((node) => node.id === input.childNodeId);
  const candidateChild = normalized.nodes.find((node) => node.id === input.childNodeId);
  if (baselineChild?.type !== "child" || candidateChild?.type !== "child") {
    throw new ChildSpecialistCandidateError(
      "invalid_projection",
      "child-specialist candidate target changed during compilation",
    );
  }
  const baselineAgent = baselineChild.child.workflow.nodes.find(
    (node) => node.id === input.agentNodeId,
  );
  const candidateAgent = candidateChild.child.workflow.nodes.find(
    (node) => node.id === input.agentNodeId,
  );
  if (baselineAgent?.type !== "agent" || candidateAgent?.type !== "agent") {
    throw new ChildSpecialistCandidateError(
      "identity_mismatch",
      "child-specialist candidate target does not match the compiled workflows",
    );
  }
  if (input.change.kind === "instructions") {
    if (
      byteIdentity(baselineAgent.agent.prompt).sha256 !== input.change.before.sha256 ||
      byteIdentity(candidateAgent.agent.prompt).sha256 !== input.change.after.sha256
    ) {
      throw new ChildSpecialistCandidateError(
        "identity_mismatch",
        "child-specialist candidate instructions do not match the compiled workflows",
      );
    }
    (candidateAgent.agent as { prompt: string }).prompt = baselineAgent.agent.prompt;
  } else {
    if (
      !isDeepStrictEqual(baselineAgent.agent.skills, input.change.before) ||
      !isDeepStrictEqual(candidateAgent.agent.skills, input.change.after)
    ) {
      throw new ChildSpecialistCandidateError(
        "identity_mismatch",
        "child-specialist candidate Agent Skills do not match the compiled workflows",
      );
    }
    (candidateAgent.agent as { skills: readonly string[] }).skills = [
      ...baselineAgent.agent.skills,
    ];
  }
  (candidateChild.child as { workflowDigest: string }).workflowDigest =
    baselineChild.child.workflowDigest;
  if (!isDeepStrictEqual(normalizeJson(normalized), normalizeJson(input.baseline))) {
    throw new ChildSpecialistCandidateError(
      "invalid_projection",
      "child-specialist candidate changes controls outside its declared axis",
    );
  }
}

function byteIdentity(value: string): { readonly bytes: number; readonly sha256: string } {
  return { bytes: Buffer.byteLength(value, "utf8"), sha256: sha256(value) };
}

function normalizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ChildSpecialistCandidateError("identity_mismatch", `${label} digest is invalid`);
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
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new ChildSpecialistCandidateError(
    "invalid_projection",
    "child-specialist candidate identity is not canonical JSON",
  );
}

function boundedMessages(messages: readonly string[]): string {
  const retained = messages.slice(0, 12).map((message) => boundedText(message, 512));
  return `${retained.join("; ")}${messages.length > retained.length ? "; additional diagnostics omitted" : ""}`;
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
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
