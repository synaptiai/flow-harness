import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import { parseAgentSkillManifest } from "../capability/agent-skill-manifest.js";
import {
  type AgentSkillCapabilitySnapshot,
  type AgentSkillPackageSnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../capability/agent-skills.js";
import {
  parseTuningEvidencePacket,
  type TuningEvidencePacket,
} from "../evaluation/tuning-evidence.js";
import { parseStrictJson } from "../strict-json.js";
import { compileWorkflowText, WorkflowCompilationError } from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import type { WorkflowSource } from "../workflow/schema.js";
import type { CompiledWorkflow } from "../workflow/types.js";
import {
  AGENT_SKILL_PACKAGE_BLUEPRINT_API_VERSION,
  type AgentSkillPackageBlueprint,
  type AgentSkillPackageCandidateGenerationProvenance,
  agentSkillPackageCandidateGenerationProvenanceSchema,
  type CompletedAgentSkillPackageCandidateGeneration,
  calculateAgentSkillPackageBlueprintDigest,
  calculateAgentSkillPackageCandidateGenerationResponseDigest,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_EVIDENCE,
  type PreparedAgentSkillPackageCandidateGeneration,
  parseAgentSkillPackageBlueprintText,
  prepareAgentSkillPackageCandidateGeneration,
  renderAgentSkillPackageManifestPrefix,
} from "./agent-skill-package-candidate-generation.js";

export const AGENT_SKILL_PACKAGE_CANDIDATE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_AGENT_SKILL_PACKAGE_CANDIDATE_BYTES = 1_048_576;

const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const semverSchema = z
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

const evidenceSourceSchema = z
  .object({
    path: portableRelativePathSchema,
    sourceSha256: sha256Schema,
    evidenceDigest: sha256Schema,
    planDigest: sha256Schema,
  })
  .strict();

const rawSourceSchema = z
  .object({
    apiVersion: z.literal(AGENT_SKILL_PACKAGE_CANDIDATE_API_VERSION),
    kind: z.literal("AgentSkillPackageCandidate"),
    metadata: z.object({ id: identifierSchema, version: semverSchema }).strict(),
    scope: z
      .object({
        kind: z.literal("workflow-agent-skill-package"),
        workflowId: identifierSchema,
        nodeId: identifierSchema,
        skillName: identifierSchema,
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
    blueprint: z
      .object({
        path: portableRelativePathSchema,
        sourceSha256: sha256Schema,
        blueprintDigest: sha256Schema,
        document: z.unknown(),
      })
      .strict(),
    evidence: z
      .array(evidenceSourceSchema)
      .min(1)
      .max(MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_EVIDENCE)
      .superRefine((items, context) => {
        refineUnique(
          items.map((item) => item.path),
          "evidence paths",
          context,
        );
        refineUnique(
          items.map((item) => item.evidenceDigest),
          "evidence digests",
          context,
        );
      }),
    package: z.object({ path: portableRelativePathSchema, packageDigest: sha256Schema }).strict(),
    generation: agentSkillPackageCandidateGenerationProvenanceSchema,
  })
  .strict();

export interface AgentSkillPackageCandidateSource {
  readonly apiVersion: typeof AGENT_SKILL_PACKAGE_CANDIDATE_API_VERSION;
  readonly kind: "AgentSkillPackageCandidate";
  readonly metadata: { readonly id: string; readonly version: string };
  readonly scope: {
    readonly kind: "workflow-agent-skill-package";
    readonly workflowId: string;
    readonly nodeId: string;
    readonly skillName: string;
  };
  readonly baseline: {
    readonly workflow: {
      readonly path: string;
      readonly sourceSha256: string;
      readonly workflowDigest: string;
    };
  };
  readonly blueprint: {
    readonly path: string;
    readonly sourceSha256: string;
    readonly blueprintDigest: string;
    readonly document: AgentSkillPackageBlueprint;
  };
  readonly evidence: readonly {
    readonly path: string;
    readonly sourceSha256: string;
    readonly evidenceDigest: string;
    readonly planDigest: string;
  }[];
  readonly package: { readonly path: string; readonly packageDigest: string };
  readonly generation: AgentSkillPackageCandidateGenerationProvenance;
}

export interface AgentSkillPackageCandidateIdentity {
  readonly version: 1;
  readonly kind: "agent-skill-package-candidate";
  readonly id: string;
  readonly candidateVersion: string;
  readonly scope: AgentSkillPackageCandidateSource["scope"];
  readonly manifest: { readonly provenance: string; readonly sourceSha256: string };
  readonly baseline: {
    readonly workflow: {
      readonly provenance: string;
      readonly sourceSha256: string;
      readonly workflowDigest: string;
    };
  };
  readonly blueprint: {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly blueprintDigest: string;
  };
  readonly evidence: readonly {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly evidenceDigest: string;
    readonly planDigest: string;
  }[];
  readonly package: {
    readonly name: string;
    readonly provenance: string;
    readonly packageDigest: string;
    readonly capabilityDigest: string;
  };
  readonly selection: {
    readonly nodeId: string;
    readonly before: readonly [];
    readonly after: readonly [string];
  };
  readonly projectedWorkflow: {
    readonly sourceSha256: string;
    readonly workflowDigest: string;
  };
  readonly generation: AgentSkillPackageCandidateGenerationProvenance;
  readonly candidateDigest: string;
}

const identitySchema: z.ZodType<AgentSkillPackageCandidateIdentity> = z
  .object({
    version: z.literal(1),
    kind: z.literal("agent-skill-package-candidate"),
    id: identifierSchema,
    candidateVersion: semverSchema,
    scope: rawSourceSchema.shape.scope,
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
    blueprint: z
      .object({
        provenance: portableRelativePathSchema,
        sourceSha256: sha256Schema,
        blueprintDigest: sha256Schema,
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
      .max(MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_EVIDENCE),
    package: z
      .object({
        name: identifierSchema,
        provenance: portableRelativePathSchema,
        packageDigest: sha256Schema,
        capabilityDigest: sha256Schema,
      })
      .strict(),
    selection: z
      .object({
        nodeId: identifierSchema,
        before: z.tuple([]),
        after: z.tuple([identifierSchema]),
      })
      .strict(),
    projectedWorkflow: z
      .object({ sourceSha256: sha256Schema, workflowDigest: sha256Schema })
      .strict(),
    generation: agentSkillPackageCandidateGenerationProvenanceSchema,
    candidateDigest: sha256Schema,
  })
  .strict()
  .superRefine((identity, context) => {
    if (
      identity.scope.nodeId !== identity.selection.nodeId ||
      identity.scope.skillName !== identity.package.name ||
      identity.scope.skillName !== identity.selection.after[0] ||
      identity.package.provenance !== `skill/${identity.package.name}` ||
      identity.generation.blueprintDigest !== identity.blueprint.blueprintDigest
    ) {
      context.addIssue({
        code: "custom",
        message: "candidate identity relationships are inconsistent",
      });
    }
    if (
      new Set(identity.evidence.map((item) => item.provenance)).size !== identity.evidence.length ||
      new Set(identity.evidence.map((item) => item.evidenceDigest)).size !==
        identity.evidence.length
    ) {
      context.addIssue({ code: "custom", message: "candidate evidence must be unique" });
    }
    const { candidateDigest, ...content } = identity;
    if (candidateDigest !== calculateAgentSkillPackageCandidateIdentityDigest(content)) {
      context.addIssue({ code: "custom", message: "candidate identity digest is inconsistent" });
    }
  });

export interface AgentSkillPackageCandidateProjectionInput {
  readonly manifestProvenance: string;
  readonly source: AgentSkillPackageCandidateSource;
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
  readonly package: AgentSkillPackageSnapshot;
}

export interface ProjectedAgentSkillPackageCandidate {
  readonly identity: AgentSkillPackageCandidateIdentity;
  readonly workflow: {
    readonly source: string;
    readonly sourceSha256: string;
    readonly compiled: CompiledWorkflow;
    readonly workflowDigest: string;
  };
  readonly baselineCapabilitySnapshot: undefined;
  readonly candidateCapabilitySnapshot: AgentSkillCapabilitySnapshot;
}

export type AgentSkillPackageCandidateErrorCode =
  | "identity_mismatch"
  | "invalid_projection"
  | "invalid_schema"
  | "limit_exceeded";

export class AgentSkillPackageCandidateError extends Error {
  override readonly name = "AgentSkillPackageCandidateError";

  constructor(
    readonly code: AgentSkillPackageCandidateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function createAgentSkillPackageCandidateSource(
  prepared: PreparedAgentSkillPackageCandidateGeneration,
  completed: CompletedAgentSkillPackageCandidateGeneration,
): AgentSkillPackageCandidateSource {
  if (
    completed.generation.requestDigest !== prepared.requestDigest ||
    completed.generation.blueprintDigest !== prepared.blueprintDigest ||
    !isDeepStrictEqual(completed.generation.targets, prepared.targets) ||
    completed.package.digest === ""
  ) {
    throw identityMismatch("completed generation does not match the admitted request");
  }
  return parseAgentSkillPackageCandidateSource({
    apiVersion: AGENT_SKILL_PACKAGE_CANDIDATE_API_VERSION,
    kind: "AgentSkillPackageCandidate",
    metadata: prepared.input.candidate,
    scope: {
      kind: "workflow-agent-skill-package",
      workflowId: prepared.input.baseline.compiled.id,
      nodeId: prepared.input.targetNodeId,
      skillName: prepared.input.blueprint.document.skill.name,
    },
    baseline: {
      workflow: {
        path: prepared.input.baseline.provenance,
        sourceSha256: prepared.input.baseline.sourceSha256,
        workflowDigest: prepared.input.baseline.workflowDigest,
      },
    },
    blueprint: {
      path: prepared.input.blueprint.provenance,
      sourceSha256: prepared.input.blueprint.sourceSha256,
      blueprintDigest: prepared.blueprintDigest,
      document: prepared.input.blueprint.document,
    },
    evidence: prepared.input.evidence.map((item) => ({
      path: item.provenance,
      sourceSha256: item.sourceSha256,
      evidenceDigest: item.packet.evidenceDigest,
      planDigest: item.packet.evaluation.planDigest,
    })),
    package: {
      path: `skill/${prepared.input.blueprint.document.skill.name}`,
      packageDigest: completed.package.digest,
    },
    generation: completed.generation,
  });
}

export function parseAgentSkillPackageCandidateText(
  text: string,
): AgentSkillPackageCandidateSource {
  if (Buffer.byteLength(text, "utf8") > MAX_AGENT_SKILL_PACKAGE_CANDIDATE_BYTES) {
    throw new AgentSkillPackageCandidateError(
      "limit_exceeded",
      "Agent Skill package candidate exceeds its byte limit",
    );
  }
  let raw: unknown;
  try {
    raw = parseStrictJson(text, {
      maxDepth: 16,
      maxNodes: 4_096,
      valueLabel: "Agent Skill package candidate",
    });
  } catch {
    throw new AgentSkillPackageCandidateError(
      "invalid_schema",
      "Agent Skill package candidate is invalid",
    );
  }
  return parseAgentSkillPackageCandidateSource(raw);
}

export function parseAgentSkillPackageCandidateIdentity(
  input: unknown,
): AgentSkillPackageCandidateIdentity {
  const parsed = identitySchema.safeParse(input);
  if (!parsed.success) {
    throw identityMismatch("candidate identity is invalid");
  }
  return deepFreeze(parsed.data);
}

export function calculateAgentSkillPackageCandidateIdentityDigest(
  identity: Omit<AgentSkillPackageCandidateIdentity, "candidateDigest">,
): string {
  return sha256(canonicalize(identity));
}

export function projectAgentSkillPackageCandidate(
  input: AgentSkillPackageCandidateProjectionInput,
): ProjectedAgentSkillPackageCandidate {
  const source = parseAgentSkillPackageCandidateSource(input.source);
  assertDigest(input.sourceSha256);
  assertDigest(input.baseline.sourceSha256);
  const baselineWorkflowDigest = calculateWorkflowDigest(input.baseline.compiled);
  let parsedBaselineWorkflowDigest: string;
  try {
    parsedBaselineWorkflowDigest = calculateWorkflowDigest(
      compileWorkflowText(JSON.stringify(input.baseline.source), "candidate baseline workflow"),
    );
  } catch {
    throw identityMismatch("candidate baseline workflow identity does not match");
  }
  if (
    parsedBaselineWorkflowDigest !== baselineWorkflowDigest ||
    source.baseline.workflow.path !== input.baseline.provenance ||
    source.baseline.workflow.sourceSha256 !== input.baseline.sourceSha256 ||
    source.baseline.workflow.workflowDigest !== baselineWorkflowDigest ||
    source.scope.workflowId !== input.baseline.compiled.id ||
    source.scope.workflowId !== input.baseline.source.metadata.id
  ) {
    throw identityMismatch("candidate baseline workflow identity does not match");
  }
  const evidence = admitEvidence(source, input.evidence, baselineWorkflowDigest);
  const candidateCapabilitySnapshot = singleSkillSnapshot(input.package);
  const skill = candidateCapabilitySnapshot.packages[0];
  if (
    skill === undefined ||
    skill.name !== source.scope.skillName ||
    skill.provenance !== source.package.path ||
    skill.digest !== source.package.packageDigest
  ) {
    throw identityMismatch("generated package identity does not match the candidate");
  }
  assertPackageAuthority(source.blueprint.document, skill);
  assertGenerationIdentity(input, source, skill, baselineWorkflowDigest);

  const projectedSource = structuredClone(input.baseline.source);
  const target = projectedSource.nodes.find((node) => node.id === source.scope.nodeId);
  if (
    target === undefined ||
    target.type !== "agent" ||
    target.dependsOn.length !== 0 ||
    !target.agent.tools.includes("read") ||
    target.agent.skills.length !== 0 ||
    projectedSource.nodes.some(
      (node) => node.type === "agent" && node.id !== target.id && node.agent.skills.length !== 0,
    )
  ) {
    throw identityMismatch("candidate target does not match the closed baseline workflow");
  }
  target.agent.skills = [skill.name];
  const projectedWorkflowSource = JSON.stringify(projectedSource);
  let compiled: CompiledWorkflow;
  try {
    compiled = compileWorkflowText(projectedWorkflowSource, input.manifestProvenance);
  } catch (error) {
    throw new AgentSkillPackageCandidateError(
      "invalid_projection",
      error instanceof WorkflowCompilationError
        ? "projected workflow is invalid"
        : "projected workflow cannot be compiled",
    );
  }
  const projectedWorkflow = {
    sourceSha256: sha256(projectedWorkflowSource),
    workflowDigest: calculateWorkflowDigest(compiled),
  };
  const identityWithoutDigest = {
    version: 1 as const,
    kind: "agent-skill-package-candidate" as const,
    id: source.metadata.id,
    candidateVersion: source.metadata.version,
    scope: source.scope,
    manifest: { provenance: input.manifestProvenance, sourceSha256: input.sourceSha256 },
    baseline: {
      workflow: {
        provenance: input.baseline.provenance,
        sourceSha256: input.baseline.sourceSha256,
        workflowDigest: baselineWorkflowDigest,
      },
    },
    blueprint: {
      provenance: source.blueprint.path,
      sourceSha256: source.blueprint.sourceSha256,
      blueprintDigest: source.blueprint.blueprintDigest,
    },
    evidence,
    package: {
      name: skill.name,
      provenance: skill.provenance,
      packageDigest: skill.digest,
      capabilityDigest: candidateCapabilitySnapshot.digest,
    },
    selection: {
      nodeId: source.scope.nodeId,
      before: [] as const,
      after: [skill.name] as const,
    },
    projectedWorkflow,
    generation: source.generation,
  };
  const identity = parseAgentSkillPackageCandidateIdentity({
    ...identityWithoutDigest,
    candidateDigest: calculateAgentSkillPackageCandidateIdentityDigest(identityWithoutDigest),
  });
  return deepFreeze({
    identity,
    workflow: {
      source: projectedWorkflowSource,
      sourceSha256: projectedWorkflow.sourceSha256,
      compiled,
      workflowDigest: projectedWorkflow.workflowDigest,
    },
    baselineCapabilitySnapshot: undefined,
    candidateCapabilitySnapshot,
  });
}

function parseAgentSkillPackageCandidateSource(input: unknown): AgentSkillPackageCandidateSource {
  const parsed = rawSourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentSkillPackageCandidateError(
      "invalid_schema",
      "Agent Skill package candidate is invalid",
    );
  }
  let blueprint: AgentSkillPackageBlueprint;
  try {
    blueprint = parseAgentSkillPackageBlueprintText(
      JSON.stringify(parsed.data.blueprint.document),
      "candidate package blueprint",
    );
  } catch {
    throw new AgentSkillPackageCandidateError(
      "invalid_schema",
      "Agent Skill package candidate is invalid",
    );
  }
  if (
    blueprint.apiVersion !== AGENT_SKILL_PACKAGE_BLUEPRINT_API_VERSION ||
    calculateAgentSkillPackageBlueprintDigest(blueprint) !==
      parsed.data.blueprint.blueprintDigest ||
    blueprint.scope.workflowId !== parsed.data.scope.workflowId ||
    blueprint.scope.nodeId !== parsed.data.scope.nodeId ||
    blueprint.skill.name !== parsed.data.scope.skillName ||
    parsed.data.package.path !== `skill/${blueprint.skill.name}`
  ) {
    throw identityMismatch("candidate package blueprint identity does not match");
  }
  return deepFreeze({
    ...parsed.data,
    blueprint: { ...parsed.data.blueprint, document: blueprint },
  });
}

function admitEvidence(
  source: AgentSkillPackageCandidateSource,
  actualEvidence: AgentSkillPackageCandidateProjectionInput["evidence"],
  workflowDigest: string,
): AgentSkillPackageCandidateIdentity["evidence"] {
  if (source.evidence.length !== actualEvidence.length) {
    throw identityMismatch("candidate evidence count does not match");
  }
  return actualEvidence.map((actual, index) => {
    const declared = source.evidence[index];
    if (declared === undefined) {
      throw identityMismatch("candidate evidence is incomplete");
    }
    let packet: TuningEvidencePacket;
    try {
      packet = parseTuningEvidencePacket(actual.packet);
    } catch {
      throw identityMismatch("candidate evidence is invalid");
    }
    if (
      actual.provenance !== declared.path ||
      actual.sourceSha256 !== declared.sourceSha256 ||
      packet.evidenceDigest !== declared.evidenceDigest ||
      packet.evaluation.planDigest !== declared.planDigest ||
      !packet.profiles.some((profile) => profile.workflowDigest === workflowDigest)
    ) {
      throw identityMismatch("candidate evidence does not match the baseline");
    }
    return {
      provenance: actual.provenance,
      sourceSha256: actual.sourceSha256,
      evidenceDigest: packet.evidenceDigest,
      planDigest: packet.evaluation.planDigest,
    };
  });
}

function assertPackageAuthority(
  blueprint: AgentSkillPackageBlueprint,
  skill: AgentSkillPackageSnapshot,
): void {
  const manifestFile = skill.files.find((file) => file.path === "SKILL.md");
  if (manifestFile === undefined) {
    throw identityMismatch("generated package is missing its manifest");
  }
  let manifest: ReturnType<typeof parseAgentSkillManifest>;
  try {
    manifest = parseAgentSkillManifest(
      Buffer.from(manifestFile.contentBase64, "base64"),
      "generated package",
    );
  } catch {
    throw identityMismatch("generated package manifest is invalid");
  }
  const expected = {
    name: blueprint.skill.name,
    description: blueprint.skill.description,
    ...(blueprint.skill.license === undefined ? {} : { license: blueprint.skill.license }),
    ...(blueprint.skill.compatibility === undefined
      ? {}
      : { compatibility: blueprint.skill.compatibility }),
    metadata: blueprint.skill.metadata,
    requestedTools: blueprint.skill.requestedTools,
  };
  if (
    !isDeepStrictEqual(manifest, expected) ||
    skill.description !== blueprint.skill.description ||
    skill.license !== blueprint.skill.license ||
    skill.compatibility !== blueprint.skill.compatibility ||
    !isDeepStrictEqual(skill.metadata, blueprint.skill.metadata) ||
    !isDeepStrictEqual(skill.requestedTools, blueprint.skill.requestedTools) ||
    skill.trust !== blueprint.skill.trust
  ) {
    throw identityMismatch("generated package authority does not match the blueprint");
  }
}

function assertGenerationIdentity(
  input: AgentSkillPackageCandidateProjectionInput,
  source: AgentSkillPackageCandidateSource,
  skill: AgentSkillPackageSnapshot,
  workflowDigest: string,
): void {
  const prepared = prepareAgentSkillPackageCandidateGeneration({
    candidate: source.metadata,
    baseline: {
      provenance: input.baseline.provenance,
      sourceSha256: input.baseline.sourceSha256,
      workflowDigest,
      compiled: input.baseline.compiled,
    },
    targetNodeId: source.scope.nodeId,
    blueprint: {
      provenance: source.blueprint.path,
      sourceSha256: source.blueprint.sourceSha256,
      document: source.blueprint.document,
    },
    evidence: input.evidence,
    model: {
      provider: source.generation.provider,
      id: source.generation.model,
      thinking: source.generation.thinking,
    },
    limits: {
      timeoutMs: source.generation.limits.timeoutMs,
      maxOutputTokens: source.generation.limits.maxOutputTokens,
    },
  });
  if (
    prepared.requestDigest !== source.generation.requestDigest ||
    prepared.blueprintDigest !== source.generation.blueprintDigest ||
    !isDeepStrictEqual(prepared.targets, source.generation.targets)
  ) {
    throw identityMismatch("generation request identity does not match the candidate");
  }
  const expectedPaths = source.blueprint.document.files.map((file) => file.path);
  if (
    !isDeepStrictEqual(
      skill.files.map((file) => file.path),
      expectedPaths,
    )
  ) {
    throw identityMismatch("generated package paths do not match the blueprint");
  }
  const prefix = renderAgentSkillPackageManifestPrefix(source.blueprint.document.skill);
  const files = skill.files.map((file) => {
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(file.contentBase64, "base64"),
      );
    } catch {
      throw identityMismatch("generated package contains invalid text");
    }
    if (file.path === "SKILL.md") {
      if (!content.startsWith(prefix)) {
        throw identityMismatch("generated package manifest bytes do not match the blueprint");
      }
      content = content.slice(prefix.length);
    }
    return { path: file.path, content };
  });
  if (
    calculateAgentSkillPackageCandidateGenerationResponseDigest(files) !==
    source.generation.responseDigest
  ) {
    throw identityMismatch("generation response identity does not match the package");
  }
}

function singleSkillSnapshot(skill: AgentSkillPackageSnapshot): AgentSkillCapabilitySnapshot {
  let snapshot: ReturnType<typeof validateCapabilitySnapshot>;
  try {
    snapshot = validateCapabilitySnapshot({
      version: 1,
      packages: [skill],
      digest: calculateCapabilitySnapshotDigest([skill]),
    });
  } catch {
    throw identityMismatch("generated package snapshot is invalid");
  }
  if (snapshot.packages.length !== 1 || snapshot.packages[0]?.kind !== "agent-skill") {
    throw identityMismatch("candidate capability must contain one Agent Skill package");
  }
  return snapshot as AgentSkillCapabilitySnapshot;
}

function identityMismatch(message: string): AgentSkillPackageCandidateError {
  return new AgentSkillPackageCandidateError("identity_mismatch", message);
}

function assertDigest(value: string): void {
  if (!sha256Schema.safeParse(value).success) {
    throw identityMismatch("source digest is invalid");
  }
}

function isPortableRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value
      .split("/")
      .every(
        (segment) =>
          segment.length > 0 &&
          segment.length <= 128 &&
          segment !== "." &&
          segment !== ".." &&
          !containsControlCharacter(segment),
      )
  );
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function refineUnique(values: readonly string[], label: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `${label} must be unique` });
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
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("value cannot be canonicalized");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
