import { createHash } from "node:crypto";

import { z } from "zod";
import {
  type AgentSkillActivationSnapshot,
  parseAgentSkillActivationSnapshot,
} from "../adaptation/agent-skill-activation.js";
import {
  type AgentSkillPackageActivationSnapshot,
  parseAgentSkillPackageActivationSnapshot,
} from "../adaptation/agent-skill-package-activation.js";
import {
  type DelegationEvaluationSnapshot,
  parseDelegationEvaluationSnapshot,
} from "../adaptation/delegation-evaluation.js";
import {
  createEffectiveHarnessRuntimeSnapshot,
  type EffectiveHarnessRuntimeSnapshot,
  parseEffectiveHarnessRuntimeSnapshot,
} from "../adaptation/effective-harness-runtime.js";
import type {
  EffectiveHarnessHeadIdentity,
  EffectiveHarnessState,
} from "../adaptation/effective-harness-state.js";
import {
  type PromptActivationSnapshot,
  parsePromptActivationSnapshot,
} from "../adaptation/prompt-activation.js";
import { type GoalWorkspaceRevision, parseGoalWorkspaceRevision } from "../goal/workspace.js";
import { type AcpAgentRuntimeSnapshot, validateAcpAgentRuntimeSnapshot } from "./acp-agent.js";
import { agentSkillNameSchema, MAX_AGENT_SKILL_PACKAGES } from "./agent-skill-contract.js";
import { type LanguageServerSnapshot, validateLanguageServerSnapshot } from "./language-server.js";
import {
  createPolicyPackageSnapshot,
  type PolicyPackageSnapshot,
  type PolicyPackageSnapshotInput,
  policyPackageIdentityKey,
  policyPackageSnapshotSchema,
  validatePolicyPackageSnapshot,
} from "./policy-packages.js";
import {
  createToolPackageSnapshot,
  type ToolPackageSnapshot,
  type ToolPackageSnapshotInput,
  toolPackageIdentityKey,
  toolPackageSnapshotSchema,
  validateToolPackageSnapshot,
} from "./tool-packages.js";
import {
  createVerifierPackageSnapshot,
  type VerifierPackageSnapshot,
  type VerifierPackageSnapshotInput,
  validateVerifierPackageSnapshot,
  verifierPackageIdentityKey,
  verifierPackageSnapshotSchema,
} from "./verifier-packages.js";
import {
  createWorkflowPackageSnapshot,
  validateWorkflowPackageSnapshot,
  type WorkflowPackageSnapshot,
  type WorkflowPackageSnapshotInput,
  workflowPackageIdentityKey,
  workflowPackageSnapshotSchema,
} from "./workflow-packages.js";

export { agentSkillNameSchema, MAX_AGENT_SKILL_PACKAGES } from "./agent-skill-contract.js";
export const MAX_AGENT_SKILL_FILES = 128;
export const MAX_AGENT_SKILL_FILE_BYTES = 128 * 1024;
export const MAX_AGENT_SKILL_PACKAGE_BYTES = 256 * 1024;
export const MAX_AGENT_SKILL_METADATA_ENTRIES = 64;
export const MAX_AGENT_SKILL_METADATA_BYTES = 16 * 1024;
export const MAX_AGENT_SKILL_REQUESTED_TOOLS = 64;
export const MAX_CAPABILITY_PACKAGE_SNAPSHOT_SERIALIZED_BYTES = 512 * 1024;
export const MAX_CAPABILITY_SNAPSHOT_SERIALIZED_BYTES = 16 * 1024 * 1024;
export const MAX_PROMPT_ACTIVATIONS_PER_SNAPSHOT = 1;
export const MAX_CAPABILITY_READ_RECEIPTS = 128;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const portablePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isPortableRelativePath, "must be a normalized portable relative path");
const requestedToolSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !containsControlCharacter(value), "must not contain control characters");
const agentSkillMetadataSchema = z
  .record(z.string().min(1).max(256), z.string().max(4096))
  .refine(
    (metadata) => Object.keys(metadata).length <= MAX_AGENT_SKILL_METADATA_ENTRIES,
    `must contain at most ${MAX_AGENT_SKILL_METADATA_ENTRIES} entries`,
  )
  .refine(
    (metadata) =>
      Buffer.byteLength(JSON.stringify(metadata), "utf8") <= MAX_AGENT_SKILL_METADATA_BYTES,
    `serialized metadata must not exceed ${MAX_AGENT_SKILL_METADATA_BYTES} UTF-8 bytes`,
  );

export interface AgentSkillSnapshotFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentBase64: string;
}

export interface AgentSkillPackageSnapshot {
  readonly kind: "agent-skill";
  readonly name: string;
  readonly description: string;
  readonly license?: string | undefined;
  readonly compatibility?: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly requestedTools: readonly string[];
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly files: readonly AgentSkillSnapshotFile[];
  readonly digest: string;
}

export type CapabilityPackageSnapshot =
  | AgentSkillPackageSnapshot
  | VerifierPackageSnapshot
  | ToolPackageSnapshot
  | WorkflowPackageSnapshot
  | PolicyPackageSnapshot;

export interface CapabilitySnapshot {
  readonly version: 1;
  readonly packages: readonly CapabilityPackageSnapshot[];
  readonly activations?: readonly AdaptiveActivationSnapshot[];
  readonly effectiveHarness?: EffectiveHarnessRuntimeSnapshot;
  readonly languageServer?: LanguageServerSnapshot;
  readonly goalWorkspace?: GoalWorkspaceRevision;
  readonly acpAgent?: AcpAgentRuntimeSnapshot;
  readonly delegation?: DelegationEvaluationSnapshot;
  readonly digest: string;
}

export type AdaptiveActivationSnapshot =
  | PromptActivationSnapshot
  | AgentSkillActivationSnapshot
  | AgentSkillPackageActivationSnapshot;

export interface AgentSkillCapabilitySnapshot extends CapabilitySnapshot {
  readonly packages: readonly AgentSkillPackageSnapshot[];
}

export interface VerifierPackageCapabilitySnapshot extends CapabilitySnapshot {
  readonly packages: readonly VerifierPackageSnapshot[];
}

export interface ToolPackageCapabilitySnapshot extends CapabilitySnapshot {
  readonly packages: readonly ToolPackageSnapshot[];
}

export interface WorkflowPackageCapabilitySnapshot extends CapabilitySnapshot {
  readonly packages: readonly WorkflowPackageSnapshot[];
}

export interface PolicyPackageCapabilitySnapshot extends CapabilitySnapshot {
  readonly packages: readonly PolicyPackageSnapshot[];
}

export interface AgentSkillPackageSnapshotInput
  extends Omit<AgentSkillPackageSnapshot, "digest" | "files" | "metadata" | "requestedTools"> {
  readonly metadata: Readonly<Record<string, string>>;
  readonly requestedTools: readonly string[];
  readonly files: readonly {
    readonly path: string;
    readonly content: Uint8Array;
  }[];
}

export interface AgentSkillSelectionEvidence {
  readonly name: string;
  readonly digest: string;
}

export interface AgentSkillReadReceipt {
  readonly uri: string;
  readonly packageDigest: string;
  readonly fileDigest: string;
  readonly bytes: number;
}

export interface AgentCapabilityEvidence {
  readonly selected: readonly AgentSkillSelectionEvidence[];
  readonly reads: readonly AgentSkillReadReceipt[];
}

const snapshotFileSchema = z
  .object({
    path: portablePathSchema,
    bytes: z.number().int().nonnegative().max(MAX_AGENT_SKILL_FILE_BYTES),
    sha256: sha256Schema,
    contentBase64: z.string().max(Math.ceil((MAX_AGENT_SKILL_FILE_BYTES * 4) / 3) + 4),
  })
  .strict();

const packageSnapshotSchema = z
  .object({
    kind: z.literal("agent-skill"),
    name: agentSkillNameSchema,
    description: z.string().min(1).max(1024),
    license: z.string().min(1).max(1024).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: agentSkillMetadataSchema,
    requestedTools: z
      .array(requestedToolSchema)
      .max(MAX_AGENT_SKILL_REQUESTED_TOOLS)
      .refine((items) => new Set(items).size === items.length, "requested tools must be unique"),
    trust: z.literal("project-explicit"),
    provenance: portablePathSchema,
    files: z.array(snapshotFileSchema).min(1).max(MAX_AGENT_SKILL_FILES),
    digest: sha256Schema,
  })
  .strict();

const capabilitySnapshotSchema = z
  .object({
    version: z.literal(1),
    packages: z
      .array(
        z.discriminatedUnion("kind", [
          packageSnapshotSchema,
          verifierPackageSnapshotSchema,
          toolPackageSnapshotSchema,
          workflowPackageSnapshotSchema,
          policyPackageSnapshotSchema,
        ]),
      )
      .max(MAX_AGENT_SKILL_PACKAGES),
    activations: z.array(z.unknown()).min(1).max(MAX_PROMPT_ACTIVATIONS_PER_SNAPSHOT).optional(),
    effectiveHarness: z.unknown().optional(),
    languageServer: z.unknown().optional(),
    goalWorkspace: z.unknown().optional(),
    acpAgent: z.unknown().optional(),
    delegation: z.unknown().optional(),
    digest: sha256Schema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.packages.length === 0 &&
      snapshot.activations === undefined &&
      snapshot.effectiveHarness === undefined &&
      snapshot.languageServer === undefined &&
      snapshot.goalWorkspace === undefined &&
      snapshot.acpAgent === undefined &&
      snapshot.delegation === undefined
    ) {
      context.addIssue({ code: "custom", message: "capability snapshot cannot be empty" });
    }
    if (snapshot.activations !== undefined && snapshot.effectiveHarness !== undefined) {
      context.addIssue({
        code: "custom",
        message: "legacy activation and effective harness authority cannot be combined",
      });
    }
  });

export const persistedCapabilitySnapshotSchema: z.ZodType<CapabilitySnapshot> = z
  .unknown()
  .transform((input, context) => {
    try {
      return validateCapabilitySnapshot(input);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
        input,
      });
      return z.NEVER;
    }
  });

const selectionEvidenceSchema = z
  .object({ name: agentSkillNameSchema, digest: sha256Schema })
  .strict();

const readReceiptSchema = z
  .object({
    uri: z.string().min(1).max(2048),
    packageDigest: sha256Schema,
    fileDigest: sha256Schema,
    bytes: z.number().int().nonnegative().max(MAX_AGENT_SKILL_FILE_BYTES),
  })
  .strict();

export const agentCapabilityEvidenceSchema: z.ZodType<AgentCapabilityEvidence> = z
  .object({
    selected: z
      .array(selectionEvidenceSchema)
      .min(1)
      .max(MAX_AGENT_SKILL_PACKAGES)
      .refine((items) => new Set(items.map((item) => item.name)).size === items.length),
    reads: z.array(readReceiptSchema).max(MAX_CAPABILITY_READ_RECEIPTS),
  })
  .strict();

export function isAgentSkillName(value: string): boolean {
  return agentSkillNameSchema.safeParse(value).success;
}

export function createCapabilitySnapshot(
  inputs: readonly AgentSkillPackageSnapshotInput[],
): AgentSkillCapabilitySnapshot;
export function createCapabilitySnapshot(
  inputs: readonly [],
  verifierInputs: readonly VerifierPackageSnapshotInput[],
): VerifierPackageCapabilitySnapshot;
export function createCapabilitySnapshot(
  inputs: readonly [],
  verifierInputs: readonly [],
  toolInputs: readonly ToolPackageSnapshotInput[],
): ToolPackageCapabilitySnapshot;
export function createCapabilitySnapshot(
  inputs: readonly [],
  verifierInputs: readonly [],
  toolInputs: readonly [],
  workflowInputs: readonly WorkflowPackageSnapshotInput[],
): WorkflowPackageCapabilitySnapshot;
export function createCapabilitySnapshot(
  inputs: readonly [],
  verifierInputs: readonly [],
  toolInputs: readonly [],
  workflowInputs: readonly [],
  policyInputs: readonly PolicyPackageSnapshotInput[],
): PolicyPackageCapabilitySnapshot;
export function createCapabilitySnapshot(
  inputs: readonly AgentSkillPackageSnapshotInput[],
  verifierInputs: readonly VerifierPackageSnapshotInput[],
  toolInputs?: readonly ToolPackageSnapshotInput[],
  workflowInputs?: readonly WorkflowPackageSnapshotInput[],
  policyInputs?: readonly PolicyPackageSnapshotInput[],
): CapabilitySnapshot;
export function createCapabilitySnapshot(
  inputs: readonly AgentSkillPackageSnapshotInput[],
  verifierInputs: readonly VerifierPackageSnapshotInput[] = [],
  toolInputs: readonly ToolPackageSnapshotInput[] = [],
  workflowInputs: readonly WorkflowPackageSnapshotInput[] = [],
  policyInputs: readonly PolicyPackageSnapshotInput[] = [],
): CapabilitySnapshot {
  if (
    inputs.length +
      verifierInputs.length +
      toolInputs.length +
      workflowInputs.length +
      policyInputs.length ===
    0
  ) {
    throw new RangeError("a capability snapshot requires at least one selected package");
  }
  const skills = inputs
    .map((input): AgentSkillPackageSnapshot => {
      const files = input.files
        .map((file): AgentSkillSnapshotFile => {
          const content = Buffer.from(file.content);
          return {
            path: file.path,
            bytes: content.byteLength,
            sha256: sha256(content),
            contentBase64: content.toString("base64"),
          };
        })
        .sort(comparePath);
      const metadata = Object.fromEntries(
        Object.entries(input.metadata).sort(([left], [right]) => compareStrings(left, right)),
      );
      const requestedTools = [...input.requestedTools].sort(compareStrings);
      const candidate: Omit<AgentSkillPackageSnapshot, "digest"> = {
        kind: input.kind,
        name: input.name,
        description: input.description,
        ...(input.license === undefined ? {} : { license: input.license }),
        ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
        metadata,
        requestedTools,
        trust: input.trust,
        provenance: input.provenance,
        files,
      };
      return {
        ...candidate,
        digest: calculateAgentSkillPackageDigest(candidate),
      };
    })
    .sort((left, right) => compareStrings(left.name, right.name));
  const packages: CapabilityPackageSnapshot[] = [
    ...skills,
    ...verifierInputs.map(createVerifierPackageSnapshot),
    ...toolInputs.map(createToolPackageSnapshot),
    ...workflowInputs.map(createWorkflowPackageSnapshot),
    ...policyInputs.map(createPolicyPackageSnapshot),
  ].sort((left, right) => compareStrings(capabilityPackageKey(left), capabilityPackageKey(right)));
  const candidate = {
    version: 1 as const,
    packages: Object.freeze(packages),
    digest: calculateCapabilitySnapshotDigest(packages),
  };
  return validateCapabilitySnapshot(candidate);
}

export function validateCapabilitySnapshot(input: unknown): CapabilitySnapshot {
  const parsed = capabilitySnapshotSchema.parse(input);
  const activations = (parsed.activations ?? []).map(parseAdaptiveActivationSnapshot);
  assertSortedUnique(parsed.packages.map(capabilityPackageKey), "capability package identities");
  assertSortedUnique(activations.map(adaptiveActivationKey), "adaptive activation identities");
  for (const capability of parsed.packages) {
    if (capability.kind === "verifier-package") {
      validateVerifierPackageSnapshot(capability);
      continue;
    }
    if (capability.kind === "tool-package") {
      validateToolPackageSnapshot(capability);
      continue;
    }
    if (capability.kind === "workflow-package") {
      validateWorkflowPackageSnapshot(capability);
      continue;
    }
    if (capability.kind === "policy-package") {
      validatePolicyPackageSnapshot(capability);
      continue;
    }
    const skill = capability;
    assertSortedUnique(Object.keys(skill.metadata), `skill "${skill.name}" metadata keys`);
    assertSortedUnique(
      skill.files.map((file) => file.path),
      `skill "${skill.name}" file paths`,
    );
    assertSortedUnique([...skill.requestedTools], `skill "${skill.name}" requested tools`);
    if (skill.provenance.split("/").at(-1) !== skill.name) {
      throw new Error(`skill "${skill.name}" provenance must end with its package name`);
    }
    let packageBytes = 0;
    for (const file of skill.files) {
      const content = decodeCanonicalBase64(file.contentBase64, file.path);
      if (content.byteLength !== file.bytes) {
        throw new Error(`skill "${skill.name}" file "${file.path}" byte count does not match`);
      }
      if (sha256(content) !== file.sha256) {
        throw new Error(`skill "${skill.name}" file "${file.path}" digest does not match`);
      }
      packageBytes += content.byteLength;
    }
    if (!skill.files.some((file) => file.path === "SKILL.md")) {
      throw new Error(`skill "${skill.name}" snapshot is missing SKILL.md`);
    }
    if (packageBytes > MAX_AGENT_SKILL_PACKAGE_BYTES) {
      throw new Error(
        `skill "${skill.name}" exceeds ${MAX_AGENT_SKILL_PACKAGE_BYTES} snapshot bytes`,
      );
    }
    if (calculateAgentSkillPackageDigest(skill) !== skill.digest) {
      throw new Error(`skill "${skill.name}" package digest does not match`);
    }
  }
  for (const activation of activations) {
    if (activation.kind === "prompt-activation") {
      continue;
    }
    if (activation.kind === "agent-skill-package-activation") {
      const selected = parsed.packages.find(
        (item) => item.kind === "agent-skill" && item.name === activation.candidate.package.name,
      );
      if (
        activation.selection === "candidate"
          ? activation.skill === undefined || selected?.digest !== activation.skill.digest
          : activation.skill !== undefined || selected !== undefined
      ) {
        throw new Error(
          "Agent Skill package activation does not match its selected capability package",
        );
      }
      continue;
    }
    const selected = parsed.packages.find(
      (item) => item.kind === "agent-skill" && item.name === activation.skill.name,
    );
    if (selected?.digest !== activation.skill.digest) {
      throw new Error("Agent Skill activation does not match its selected capability package");
    }
  }
  const effectiveHarness =
    parsed.effectiveHarness === undefined
      ? undefined
      : parseEffectiveHarnessRuntimeSnapshot(parsed.effectiveHarness, parsed.packages);
  const languageServer =
    parsed.languageServer === undefined
      ? undefined
      : validateLanguageServerSnapshot(parsed.languageServer);
  const goalWorkspace =
    parsed.goalWorkspace === undefined
      ? undefined
      : parseGoalWorkspaceRevision(parsed.goalWorkspace);
  const acpAgent =
    parsed.acpAgent === undefined ? undefined : validateAcpAgentRuntimeSnapshot(parsed.acpAgent);
  const delegation =
    parsed.delegation === undefined
      ? undefined
      : parseDelegationEvaluationSnapshot(parsed.delegation);
  if (
    delegation !== undefined &&
    (activations.length > 0 ||
      effectiveHarness !== undefined ||
      languageServer !== undefined ||
      goalWorkspace !== undefined ||
      acpAgent !== undefined)
  ) {
    throw new Error(
      "delegation evaluation cannot combine with activation, effective-harness, language-server, goal-workspace, or ACP authority",
    );
  }
  if (
    delegation !== undefined &&
    delegation.child.packageClosureDigest !== calculateCapabilitySnapshotDigest(parsed.packages)
  ) {
    throw new Error("delegation evaluation package closure digest does not match");
  }
  if (
    calculateCapabilitySnapshotDigest(
      parsed.packages,
      activations,
      effectiveHarness,
      languageServer,
      goalWorkspace,
      acpAgent,
      delegation,
    ) !== parsed.digest
  ) {
    throw new Error("capability snapshot digest does not match");
  }
  if (
    Buffer.byteLength(
      JSON.stringify({
        version: 1,
        packages: parsed.packages,
        digest: calculateCapabilitySnapshotDigest(parsed.packages),
      }),
      "utf8",
    ) > MAX_CAPABILITY_PACKAGE_SNAPSHOT_SERIALIZED_BYTES
  ) {
    throw new Error(
      `serialized capability packages exceed ${MAX_CAPABILITY_PACKAGE_SNAPSHOT_SERIALIZED_BYTES} UTF-8 bytes`,
    );
  }
  if (
    Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_CAPABILITY_SNAPSHOT_SERIALIZED_BYTES
  ) {
    throw new Error(
      `serialized capability snapshot exceeds ${MAX_CAPABILITY_SNAPSHOT_SERIALIZED_BYTES} UTF-8 bytes`,
    );
  }
  return deepFreeze({
    version: parsed.version,
    packages: parsed.packages,
    ...(activations.length === 0 ? {} : { activations }),
    ...(effectiveHarness === undefined ? {} : { effectiveHarness }),
    ...(languageServer === undefined ? {} : { languageServer }),
    ...(goalWorkspace === undefined ? {} : { goalWorkspace }),
    ...(acpAgent === undefined ? {} : { acpAgent }),
    ...(delegation === undefined ? {} : { delegation }),
    digest: parsed.digest,
  });
}

export function createEffectiveHarnessCapabilitySnapshot(
  state: EffectiveHarnessState,
  head: EffectiveHarnessHeadIdentity,
): CapabilitySnapshot {
  const effectiveHarness = createEffectiveHarnessRuntimeSnapshot({ state, head });
  return validateCapabilitySnapshot({
    version: 1,
    packages: state.packages,
    effectiveHarness,
    digest: calculateCapabilitySnapshotDigest(state.packages, [], effectiveHarness),
  });
}

export function createGoalWorkspaceCapabilitySnapshot(
  goalWorkspace: GoalWorkspaceRevision,
): CapabilitySnapshot {
  const parsed = parseGoalWorkspaceRevision(goalWorkspace);
  return validateCapabilitySnapshot({
    version: 1,
    packages: [],
    goalWorkspace: parsed,
    digest: calculateCapabilitySnapshotDigest([], [], undefined, undefined, parsed),
  });
}

export function calculateAgentSkillPackageDigest(
  skill: Omit<AgentSkillPackageSnapshot, "digest"> | AgentSkillPackageSnapshot,
): string {
  const canonical = {
    kind: skill.kind,
    name: skill.name,
    description: skill.description,
    license: skill.license ?? null,
    compatibility: skill.compatibility ?? null,
    metadata: skill.metadata,
    requestedTools: skill.requestedTools,
    trust: skill.trust,
    provenance: skill.provenance,
    files: skill.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  };
  return sha256(JSON.stringify(canonical));
}

export function calculateCapabilitySnapshotDigest(
  packages: readonly CapabilityPackageSnapshot[],
  activations: readonly AdaptiveActivationSnapshot[] = [],
  effectiveHarness?: EffectiveHarnessRuntimeSnapshot,
  languageServer?: LanguageServerSnapshot,
  goalWorkspace?: GoalWorkspaceRevision,
  acpAgent?: AcpAgentRuntimeSnapshot,
  delegation?: DelegationEvaluationSnapshot,
): string {
  return sha256(
    JSON.stringify({
      version: 1,
      packages: packages.map((capability) =>
        capability.kind === "agent-skill"
          ? { name: capability.name, digest: capability.digest }
          : {
              kind: capability.kind,
              name: capability.name,
              version: capability.version,
              digest: capability.digest,
            },
      ),
      ...(activations.length === 0
        ? {}
        : {
            activations: activations.map(activationDigestIdentity),
          }),
      ...(effectiveHarness === undefined
        ? {}
        : { effectiveHarness: { runtimeDigest: effectiveHarness.runtimeDigest } }),
      ...(languageServer === undefined
        ? {}
        : { languageServer: { digest: languageServer.digest } }),
      ...(goalWorkspace === undefined
        ? {}
        : {
            goalWorkspace: {
              revision: goalWorkspace.revision,
              digest: goalWorkspace.digest,
            },
          }),
      ...(acpAgent === undefined ? {} : { acpAgent: { digest: acpAgent.digest } }),
      ...(delegation === undefined
        ? {}
        : {
            delegation: {
              candidateDigest: delegation.candidateDigest,
              snapshotDigest: delegation.snapshotDigest,
            },
          }),
    }),
  );
}

export function calculateAgentSkillCapabilitySnapshotDigest(
  packages: readonly { readonly name: string; readonly digest: string }[],
): string {
  return sha256(
    JSON.stringify({
      version: 1,
      packages: packages.map((capability) => ({
        name: capability.name,
        digest: capability.digest,
      })),
    }),
  );
}

export function combineCapabilitySnapshots(
  snapshots: readonly CapabilitySnapshot[],
): CapabilitySnapshot | undefined {
  if (snapshots.length === 0) {
    return undefined;
  }
  if (snapshots.length === 1) {
    return snapshots[0];
  }
  const packages = snapshots
    .flatMap((snapshot) => snapshot.packages)
    .sort((left, right) => compareStrings(capabilityPackageKey(left), capabilityPackageKey(right)));
  const activations = snapshots
    .flatMap((snapshot) => snapshot.activations ?? [])
    .sort((left, right) =>
      compareStrings(adaptiveActivationKey(left), adaptiveActivationKey(right)),
    );
  const effectiveHarnesses = snapshots
    .map((snapshot) => snapshot.effectiveHarness)
    .filter((item): item is EffectiveHarnessRuntimeSnapshot => item !== undefined);
  const effectiveHarness = effectiveHarnesses[0];
  if (effectiveHarnesses.some((item) => item.runtimeDigest !== effectiveHarness?.runtimeDigest)) {
    throw new Error("capability snapshots contain conflicting effective harness selections");
  }
  const languageServers = snapshots
    .map((snapshot) => snapshot.languageServer)
    .filter((item): item is LanguageServerSnapshot => item !== undefined);
  const languageServer = languageServers[0];
  if (languageServers.some((item) => item.digest !== languageServer?.digest)) {
    throw new Error("capability snapshots contain conflicting language-server selections");
  }
  const goalWorkspaces = snapshots
    .map((snapshot) => snapshot.goalWorkspace)
    .filter((item): item is GoalWorkspaceRevision => item !== undefined);
  const goalWorkspace = goalWorkspaces[0];
  if (goalWorkspaces.some((item) => item.digest !== goalWorkspace?.digest)) {
    throw new Error("capability snapshots contain conflicting goal workspace selections");
  }
  const acpAgents = snapshots
    .map((snapshot) => snapshot.acpAgent)
    .filter((item): item is AcpAgentRuntimeSnapshot => item !== undefined);
  const acpAgent = acpAgents[0];
  if (acpAgents.some((item) => item.digest !== acpAgent?.digest)) {
    throw new Error("capability snapshots contain conflicting ACP agent selections");
  }
  const delegations = snapshots
    .map((snapshot) => snapshot.delegation)
    .filter((item): item is DelegationEvaluationSnapshot => item !== undefined);
  const delegation = delegations[0];
  if (delegations.some((item) => item.snapshotDigest !== delegation?.snapshotDigest)) {
    throw new Error("capability snapshots contain conflicting delegation evaluations");
  }
  return validateCapabilitySnapshot({
    version: 1,
    packages,
    ...(activations.length === 0 ? {} : { activations }),
    ...(effectiveHarness === undefined ? {} : { effectiveHarness }),
    ...(languageServer === undefined ? {} : { languageServer }),
    ...(goalWorkspace === undefined ? {} : { goalWorkspace }),
    ...(acpAgent === undefined ? {} : { acpAgent }),
    ...(delegation === undefined ? {} : { delegation }),
    digest: calculateCapabilitySnapshotDigest(
      packages,
      activations,
      effectiveHarness,
      languageServer,
      goalWorkspace,
      acpAgent,
      delegation,
    ),
  });
}

export function selectedAgentSkills(
  snapshot: CapabilitySnapshot,
  names: readonly string[],
): readonly AgentSkillPackageSnapshot[] {
  const byName = new Map(
    snapshot.packages
      .filter((item): item is AgentSkillPackageSnapshot => item.kind === "agent-skill")
      .map((skill) => [skill.name, skill]),
  );
  return Object.freeze(
    names.map((name) => {
      const skill = byName.get(name);
      if (skill === undefined) {
        throw new Error(`capability snapshot does not contain selected skill "${name}"`);
      }
      return skill;
    }),
  );
}

function capabilityPackageKey(value: CapabilityPackageSnapshot): string {
  if (value.kind === "agent-skill") {
    return `agent-skill\0${value.name}`;
  }
  if (value.kind === "verifier-package") {
    return verifierPackageIdentityKey(value);
  }
  if (value.kind === "tool-package") {
    return toolPackageIdentityKey(value);
  }
  return value.kind === "workflow-package"
    ? workflowPackageIdentityKey(value)
    : policyPackageIdentityKey(value);
}

export function parseAdaptiveActivationSnapshot(input: unknown): AdaptiveActivationSnapshot {
  if (
    typeof input === "object" &&
    input !== null &&
    "kind" in input &&
    input.kind === "agent-skill-activation"
  ) {
    return parseAgentSkillActivationSnapshot(input);
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "kind" in input &&
    input.kind === "agent-skill-package-activation"
  ) {
    return parseAgentSkillPackageActivationSnapshot(input);
  }
  return parsePromptActivationSnapshot(input);
}

function adaptiveActivationKey(value: AdaptiveActivationSnapshot): string {
  if (value.kind === "prompt-activation") {
    return `${value.workflowId}\0${value.candidateId}\0${value.candidateVersion}`;
  }
  return `${value.workflowId}\0${value.kind}\0${value.candidateId}\0${value.candidateVersion}`;
}

function activationDigestIdentity(value: AdaptiveActivationSnapshot) {
  const identity = {
    workflowId: value.workflowId,
    candidateId: value.candidateId,
    candidateVersion: value.candidateVersion,
    digest: value.activationDigest,
  };
  return value.kind === "prompt-activation" ? identity : { kind: value.kind, ...identity };
}

export function createAgentCapabilityEvidence(
  snapshot: CapabilitySnapshot,
  names: readonly string[],
  reads: readonly AgentSkillReadReceipt[] = [],
): AgentCapabilityEvidence {
  const selectedPackages = selectedAgentSkills(snapshot, names);
  const selected = selectedPackages.map((skill) => ({ name: skill.name, digest: skill.digest }));
  if (new Set(names).size !== names.length) {
    throw new Error("selected Agent Skill names must be unique");
  }
  if (reads.length > MAX_CAPABILITY_READ_RECEIPTS) {
    throw new Error(`Agent Skill reads exceed ${MAX_CAPABILITY_READ_RECEIPTS} receipts`);
  }
  const allowedReceipts = new Map<string, AgentSkillReadReceipt>();
  for (const skill of selectedPackages) {
    for (const file of skill.files) {
      const uri = skillResourceUri(skill.name, file.path);
      allowedReceipts.set(uri, {
        uri,
        packageDigest: skill.digest,
        fileDigest: file.sha256,
        bytes: file.bytes,
      });
    }
  }
  const observedUris = new Set<string>();
  for (const read of reads) {
    const allowed = allowedReceipts.get(read.uri);
    if (allowed === undefined || JSON.stringify(allowed) !== JSON.stringify(read)) {
      throw new Error(`Agent Skill read receipt "${read.uri}" is not bound to selected content`);
    }
    if (observedUris.has(read.uri)) {
      throw new Error(`Agent Skill read receipt "${read.uri}" is duplicated`);
    }
    observedUris.add(read.uri);
  }
  return deepFreeze(agentCapabilityEvidenceSchema.parse({ selected, reads: [...reads] }));
}

export function skillResourceUri(skillName: string, path: string): string {
  if (!isAgentSkillName(skillName) || !isPortableRelativePath(path)) {
    throw new Error("cannot create a skill URI from an invalid name or path");
  }
  return `skill://${skillName}/${path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function decodeCanonicalBase64(value: string, path: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new Error(`skill file "${path}" content is not canonical base64`);
  }
  return content;
}

function isPortableRelativePath(value: string): boolean {
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !Array.from(segment).some((character) => {
        const point = character.codePointAt(0);
        return point !== undefined && (point <= 31 || point === 127);
      }),
  );
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    const previous = values[index - 1];
    if (
      current === undefined ||
      (previous !== undefined && compareStrings(previous, current) >= 0)
    ) {
      throw new Error(`${label} must be strictly sorted and unique`);
    }
  }
}

function comparePath(left: { readonly path: string }, right: { readonly path: string }): number {
  return compareStrings(left.path, right.path);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
