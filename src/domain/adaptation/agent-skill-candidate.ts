import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { parseDocument } from "yaml";
import { z } from "zod";
import { agentSkillNameSchema } from "../capability/agent-skill-contract.js";
import { parseAgentSkillManifest } from "../capability/agent-skill-manifest.js";
import {
  type AgentSkillCapabilitySnapshot,
  type AgentSkillPackageSnapshot,
  calculateCapabilitySnapshotDigest,
  createCapabilitySnapshot,
  MAX_AGENT_SKILL_FILE_BYTES,
  MAX_AGENT_SKILL_PACKAGE_BYTES,
  validateCapabilitySnapshot,
} from "../capability/agent-skills.js";
import {
  parseTuningEvidencePacket,
  type TuningEvidencePacket,
} from "../evaluation/tuning-evidence.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import type { CompiledWorkflow } from "../workflow/types.js";
import {
  agentSkillCandidateGenerationProvenanceSchema,
  calculateAgentSkillCandidateGenerationRequestDigest,
  calculateAgentSkillCandidateGenerationResponseDigest,
  isAgentSkillCandidateGenerationResourcePath,
  renderAgentSkillCandidateGenerationRequest,
  renderAgentSkillCandidateGenerationResponse,
} from "./agent-skill-candidate-generation-contract.js";
import {
  type AgentSkillCandidateIdentity,
  calculateAgentSkillCandidateIdentityDigest,
  MAX_AGENT_SKILL_CANDIDATE_CHANGES,
  MAX_AGENT_SKILL_CANDIDATE_EVIDENCE,
  parseAgentSkillCandidateIdentity as parseAgentSkillCandidateIdentityCore,
} from "./agent-skill-candidate-identity.js";

export {
  type AgentSkillCandidateIdentity,
  calculateAgentSkillCandidateIdentityDigest,
  MAX_AGENT_SKILL_CANDIDATE_CHANGES,
  MAX_AGENT_SKILL_CANDIDATE_EVIDENCE,
} from "./agent-skill-candidate-identity.js";

export const AGENT_SKILL_CANDIDATE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_AGENT_SKILL_CANDIDATE_BYTES = 1_048_576;

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

const agentSkillCandidateSourceSchema = z
  .object({
    apiVersion: z.literal(AGENT_SKILL_CANDIDATE_API_VERSION),
    kind: z.literal("AgentSkillCandidate"),
    metadata: z.object({ id: identifierSchema, version: semverSchema }).strict(),
    scope: z
      .object({
        kind: z.literal("workflow-agent-skill"),
        workflowId: identifierSchema,
        skillName: agentSkillNameSchema,
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
        skill: z.object({ path: portableRelativePathSchema, packageDigest: sha256Schema }).strict(),
      })
      .strict(),
    evidence: z
      .array(evidenceSourceSchema)
      .min(1)
      .max(MAX_AGENT_SKILL_CANDIDATE_EVIDENCE)
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
        resources: z
          .array(
            z
              .object({
                path: portableRelativePathSchema,
                expectedSha256: sha256Schema,
                value: z.string().min(1).max(MAX_AGENT_SKILL_FILE_BYTES),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_AGENT_SKILL_CANDIDATE_CHANGES)
          .superRefine((resources, context) => {
            refineUnique(
              resources.map((item) => item.path),
              "resource paths",
              context,
            );
            const totalBytes = resources.reduce(
              (total, item) => total + Buffer.byteLength(item.value, "utf8"),
              0,
            );
            if (
              totalBytes > MAX_AGENT_SKILL_PACKAGE_BYTES ||
              resources.some(
                (resource) =>
                  Buffer.byteLength(resource.value, "utf8") > MAX_AGENT_SKILL_FILE_BYTES,
              )
            ) {
              context.addIssue({ code: "custom", message: "replacement resources exceed bounds" });
            }
          }),
      })
      .strict(),
    generation: agentSkillCandidateGenerationProvenanceSchema.optional(),
  })
  .strict();

export type AgentSkillCandidateSource = z.infer<typeof agentSkillCandidateSourceSchema>;

export interface AgentSkillCandidateProjectionInput {
  readonly manifestProvenance: string;
  readonly source: AgentSkillCandidateSource;
  readonly sourceSha256: string;
  readonly baseline: {
    readonly workflow: {
      readonly provenance: string;
      readonly sourceSha256: string;
      readonly compiled: CompiledWorkflow;
    };
    readonly skill: AgentSkillPackageSnapshot;
  };
  readonly evidence: readonly {
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly packet: TuningEvidencePacket;
  }[];
}

export interface ProjectedAgentSkillCandidate {
  readonly identity: AgentSkillCandidateIdentity;
  readonly workflow: {
    readonly sourceSha256: string;
    readonly workflowDigest: string;
    readonly compiled: CompiledWorkflow;
  };
  readonly baselineCapabilitySnapshot: AgentSkillCapabilitySnapshot;
  readonly candidateCapabilitySnapshot: AgentSkillCapabilitySnapshot;
}

export type AgentSkillCandidateErrorCode =
  | "identity_mismatch"
  | "invalid_projection"
  | "invalid_schema"
  | "invalid_target"
  | "invalid_yaml"
  | "limit_exceeded";

export class AgentSkillCandidateError extends Error {
  override readonly name = "AgentSkillCandidateError";

  constructor(
    readonly code: AgentSkillCandidateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${boundedText(message, 8_192)}`, options);
  }
}

export function parseAgentSkillCandidateText(
  text: string,
  sourceName = "Agent Skill candidate",
): AgentSkillCandidateSource {
  if (Buffer.byteLength(text, "utf8") > MAX_AGENT_SKILL_CANDIDATE_BYTES) {
    throw new AgentSkillCandidateError(
      "limit_exceeded",
      `candidate exceeds ${MAX_AGENT_SKILL_CANDIDATE_BYTES} UTF-8 bytes`,
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
      throw new AgentSkillCandidateError("invalid_yaml", "candidate is not strict YAML or JSON");
    }
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof AgentSkillCandidateError) {
      throw error;
    }
    throw new AgentSkillCandidateError("invalid_yaml", `${sourceName} is not strict YAML or JSON`);
  }
  const parsed = agentSkillCandidateSourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentSkillCandidateError("invalid_schema", "candidate does not match its schema");
  }
  return deepFreeze(parsed.data);
}

export function parseAgentSkillCandidateIdentity(input: unknown): AgentSkillCandidateIdentity {
  try {
    return parseAgentSkillCandidateIdentityCore(input);
  } catch {
    throw new AgentSkillCandidateError("identity_mismatch", "candidate identity is invalid");
  }
}

export function projectAgentSkillCandidate(
  input: AgentSkillCandidateProjectionInput,
): ProjectedAgentSkillCandidate {
  validateDigest(input.sourceSha256);
  validateDigest(input.baseline.workflow.sourceSha256);
  const source = agentSkillCandidateSourceSchema.parse(input.source);
  const workflowDigest = calculateWorkflowDigest(input.baseline.workflow.compiled);
  if (
    source.baseline.workflow.path !== input.baseline.workflow.provenance ||
    source.baseline.workflow.sourceSha256 !== input.baseline.workflow.sourceSha256 ||
    source.baseline.workflow.workflowDigest !== workflowDigest ||
    source.scope.workflowId !== input.baseline.workflow.compiled.id
  ) {
    throw new AgentSkillCandidateError(
      "identity_mismatch",
      "candidate baseline workflow identity does not match",
    );
  }

  assertAgentSkillCandidateClosedWorkflow(input.baseline.workflow.compiled, source.scope.skillName);
  const baselineCapabilitySnapshot = singleSkillSnapshot(input.baseline.skill);
  const baselineSkill = requiredSkill(baselineCapabilitySnapshot);
  if (
    source.scope.skillName !== baselineSkill.name ||
    source.baseline.skill.path !== baselineSkill.provenance ||
    source.baseline.skill.packageDigest !== baselineSkill.digest
  ) {
    throw new AgentSkillCandidateError(
      "identity_mismatch",
      "candidate baseline skill identity does not match",
    );
  }

  const evidence = admitEvidence(source, input.evidence, workflowDigest);
  validateGenerationProvenance(input, workflowDigest);
  const files = baselineSkill.files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.contentBase64, "base64"),
  }));
  const changes = source.changes.resources.map((change) => {
    const file = files.find((item) => item.path === change.path);
    if (file === undefined) {
      throw new AgentSkillCandidateError(
        "invalid_target",
        "candidate resource target is not in the baseline skill",
      );
    }
    let originalText: string;
    try {
      originalText = new TextDecoder("utf-8", { fatal: true }).decode(file.content);
    } catch {
      throw new AgentSkillCandidateError(
        "invalid_target",
        "candidate resource target is not UTF-8 text",
      );
    }
    const beforeSha256 = sha256(file.content);
    const replacement = Buffer.from(change.value, "utf8");
    const afterSha256 = sha256(replacement);
    if (change.expectedSha256 !== beforeSha256) {
      throw new AgentSkillCandidateError(
        "identity_mismatch",
        "candidate resource target does not match its expected digest",
      );
    }
    if (afterSha256 === beforeSha256) {
      throw new AgentSkillCandidateError(
        "invalid_projection",
        "candidate resource replacement does not change the baseline",
      );
    }
    if (change.path === "SKILL.md") {
      assertManifestAuthorityPreserved(originalText, change.value, baselineSkill);
    }
    file.content = replacement;
    return { path: change.path, beforeSha256, afterSha256 };
  });

  let candidateCapabilitySnapshot: AgentSkillCapabilitySnapshot;
  try {
    candidateCapabilitySnapshot = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: baselineSkill.name,
        description: baselineSkill.description,
        ...(baselineSkill.license === undefined ? {} : { license: baselineSkill.license }),
        ...(baselineSkill.compatibility === undefined
          ? {}
          : { compatibility: baselineSkill.compatibility }),
        metadata: baselineSkill.metadata,
        requestedTools: baselineSkill.requestedTools,
        trust: baselineSkill.trust,
        provenance: baselineSkill.provenance,
        files,
      },
    ]);
  } catch (error) {
    throw new AgentSkillCandidateError(
      "invalid_projection",
      "candidate projected skill exceeds its admitted package bounds",
      { cause: error },
    );
  }
  const candidateSkill = requiredSkill(candidateCapabilitySnapshot);
  if (candidateSkill.digest === baselineSkill.digest) {
    throw new AgentSkillCandidateError(
      "invalid_projection",
      "candidate skill identity does not change the baseline",
    );
  }

  const identityWithoutDigest = {
    version: 1 as const,
    kind: "agent-skill-candidate" as const,
    id: source.metadata.id,
    candidateVersion: source.metadata.version,
    scope: source.scope,
    manifest: {
      provenance: input.manifestProvenance,
      sourceSha256: input.sourceSha256,
    },
    baseline: {
      workflow: {
        provenance: input.baseline.workflow.provenance,
        sourceSha256: input.baseline.workflow.sourceSha256,
        workflowDigest,
      },
      skill: {
        name: baselineSkill.name,
        provenance: baselineSkill.provenance,
        packageDigest: baselineSkill.digest,
        capabilityDigest: baselineCapabilitySnapshot.digest,
      },
    },
    evidence,
    changes,
    projectedSkill: {
      packageDigest: candidateSkill.digest,
      capabilityDigest: candidateCapabilitySnapshot.digest,
    },
    ...(source.generation === undefined ? {} : { generation: source.generation }),
  };
  const identity = parseAgentSkillCandidateIdentity({
    ...identityWithoutDigest,
    candidateDigest: calculateAgentSkillCandidateIdentityDigest(identityWithoutDigest),
  });
  return deepFreeze({
    identity,
    workflow: {
      sourceSha256: input.baseline.workflow.sourceSha256,
      workflowDigest,
      compiled: input.baseline.workflow.compiled,
    },
    baselineCapabilitySnapshot,
    candidateCapabilitySnapshot,
  });
}

function validateGenerationProvenance(
  input: AgentSkillCandidateProjectionInput,
  workflowDigest: string,
): void {
  const generation = input.source.generation;
  if (generation === undefined) {
    return;
  }
  const files = new Map(input.baseline.skill.files.map((file) => [file.path, file]));
  const targets = generation.targets.map((target) => {
    const file = files.get(target.path);
    if (
      file === undefined ||
      file.sha256 !== target.expectedSha256 ||
      !isAgentSkillCandidateGenerationResourcePath(target.path)
    ) {
      throw new AgentSkillCandidateError(
        "identity_mismatch",
        "generation target does not match the admitted baseline package",
      );
    }
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(file.contentBase64, "base64"),
      );
    } catch {
      throw new AgentSkillCandidateError(
        "identity_mismatch",
        "generation target is not admitted UTF-8 text",
      );
    }
    return { path: target.path, value, expectedSha256: target.expectedSha256 };
  });
  const targetDigests = new Map(
    generation.targets.map((target) => [target.path, target.expectedSha256]),
  );
  for (const change of input.source.changes.resources) {
    if (targetDigests.get(change.path) !== change.expectedSha256) {
      throw new AgentSkillCandidateError(
        "identity_mismatch",
        "candidate resource change does not match a generation target",
      );
    }
  }
  const request = {
    baseline: {
      workflowId: input.baseline.workflow.compiled.id,
      sourceSha256: input.baseline.workflow.sourceSha256,
      workflowDigest,
    },
    skill: {
      name: input.baseline.skill.name,
      packageDigest: input.baseline.skill.digest,
      description: input.baseline.skill.description,
      ...(input.baseline.skill.license === undefined
        ? {}
        : { license: input.baseline.skill.license }),
      ...(input.baseline.skill.compatibility === undefined
        ? {}
        : { compatibility: input.baseline.skill.compatibility }),
      metadata: input.baseline.skill.metadata,
      requestedTools: input.baseline.skill.requestedTools,
      trust: input.baseline.skill.trust,
    },
    targets,
    evidence: input.evidence.map((item) => ({
      sourceSha256: item.sourceSha256,
      packet: item.packet,
    })),
    model: {
      provider: generation.provider,
      id: generation.model,
      thinking: generation.thinking,
    },
    limits: {
      timeoutMs: generation.limits.timeoutMs,
      maxOutputTokens: generation.limits.maxOutputTokens,
    },
  };
  if (
    Buffer.byteLength(renderAgentSkillCandidateGenerationRequest(request), "utf8") >
      generation.limits.maxInputBytes ||
    calculateAgentSkillCandidateGenerationRequestDigest(request) !== generation.requestDigest
  ) {
    throw new AgentSkillCandidateError(
      "identity_mismatch",
      "generation request identity does not match the admitted inputs",
    );
  }
  const response = input.source.changes.resources.map((change) => ({
    path: change.path,
    value: change.value,
  }));
  if (
    Buffer.byteLength(renderAgentSkillCandidateGenerationResponse(response), "utf8") >
      generation.limits.maxOutputBytes ||
    calculateAgentSkillCandidateGenerationResponseDigest(response) !== generation.responseDigest
  ) {
    throw new AgentSkillCandidateError(
      "identity_mismatch",
      "generation response identity does not match the accepted resource changes",
    );
  }
}

function singleSkillSnapshot(skill: AgentSkillPackageSnapshot): AgentSkillCapabilitySnapshot {
  const snapshot = validateCapabilitySnapshot({
    version: 1,
    packages: [skill],
    digest: calculateCapabilitySnapshotDigest([skill]),
  });
  const selected = snapshot.packages[0];
  if (snapshot.packages.length !== 1 || selected?.kind !== "agent-skill") {
    throw new AgentSkillCandidateError(
      "identity_mismatch",
      "candidate baseline capability must contain one Agent Skill",
    );
  }
  return snapshot as AgentSkillCapabilitySnapshot;
}

function requiredSkill(snapshot: AgentSkillCapabilitySnapshot): AgentSkillPackageSnapshot {
  const skill = snapshot.packages[0];
  if (skill === undefined) {
    throw new AgentSkillCandidateError("identity_mismatch", "candidate skill is unavailable");
  }
  return skill;
}

function admitEvidence(
  source: AgentSkillCandidateSource,
  evidence: AgentSkillCandidateProjectionInput["evidence"],
  workflowDigest: string,
): AgentSkillCandidateIdentity["evidence"] {
  if (evidence.length !== source.evidence.length) {
    throw new AgentSkillCandidateError(
      "identity_mismatch",
      "candidate evidence count does not match",
    );
  }
  return evidence.map((actual, index) => {
    const declared = source.evidence[index];
    if (declared === undefined) {
      throw new AgentSkillCandidateError("identity_mismatch", "candidate evidence is incomplete");
    }
    const packet = parseTuningEvidencePacket(actual.packet);
    if (
      actual.provenance !== declared.path ||
      actual.sourceSha256 !== declared.sourceSha256 ||
      packet.evidenceDigest !== declared.evidenceDigest ||
      packet.evaluation.planDigest !== declared.planDigest ||
      !packet.profiles.some((profile) => profile.workflowDigest === workflowDigest)
    ) {
      throw new AgentSkillCandidateError(
        "identity_mismatch",
        "candidate evidence does not match the baseline",
      );
    }
    return {
      provenance: actual.provenance,
      sourceSha256: actual.sourceSha256,
      evidenceDigest: packet.evidenceDigest,
      planDigest: packet.evaluation.planDigest,
    };
  });
}

function assertManifestAuthorityPreserved(
  baselineText: string,
  replacementText: string,
  skill: AgentSkillPackageSnapshot,
): void {
  try {
    const baseline = parseAgentSkillManifest(Buffer.from(baselineText), "baseline skill manifest");
    const replacement = parseAgentSkillManifest(
      Buffer.from(replacementText),
      "candidate skill manifest",
    );
    const expected = {
      name: skill.name,
      description: skill.description,
      ...(skill.license === undefined ? {} : { license: skill.license }),
      ...(skill.compatibility === undefined ? {} : { compatibility: skill.compatibility }),
      metadata: skill.metadata,
      requestedTools: skill.requestedTools,
    };
    if (!isDeepStrictEqual(baseline, expected) || !isDeepStrictEqual(replacement, expected)) {
      throw new Error("manifest authority differs");
    }
  } catch {
    throw new AgentSkillCandidateError(
      "invalid_projection",
      "candidate SKILL.md changes package authority",
    );
  }
}

export function assertAgentSkillCandidateClosedWorkflow(
  workflow: CompiledWorkflow,
  skillName: string,
): void {
  const selected = new Set<string>();
  const visit = (nested: CompiledWorkflow): void => {
    if (nested.sourcePackage !== undefined) {
      throw new AgentSkillCandidateError(
        "invalid_projection",
        "candidate workflow contains unsupported capability packages",
      );
    }
    for (const node of nested.nodes) {
      if (node.type === "agent") {
        for (const skill of node.agent.skills) {
          selected.add(skill);
        }
        if (node.agent.toolPackages.length > 0) {
          throw new AgentSkillCandidateError(
            "invalid_projection",
            "candidate workflow contains unsupported capability packages",
          );
        }
      } else if (
        node.type === "verifier" &&
        (node.verifier.kind === "packaged-command" || node.verifier.kind === "packaged-model")
      ) {
        throw new AgentSkillCandidateError(
          "invalid_projection",
          "candidate workflow contains unsupported capability packages",
        );
      } else if (node.type === "child") {
        visit(node.child.workflow);
      }
    }
  };
  visit(workflow);
  if (selected.size !== 1 || !selected.has(skillName)) {
    throw new AgentSkillCandidateError(
      "invalid_projection",
      "candidate workflow must select exactly its scoped Agent Skill",
    );
  }
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

function validateDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new AgentSkillCandidateError("identity_mismatch", "candidate digest is invalid");
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
