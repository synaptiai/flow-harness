import type { CompiledVerifierNode, CompiledWorkflow } from "../workflow/types.js";
import { type CapabilitySnapshot, validateCapabilitySnapshot } from "./agent-skills.js";
import type { VerifierPackageSnapshot, VerifierPackageUseEvidence } from "./verifier-packages.js";

export type WorkflowCapabilityErrorCode =
  | "conflicting_package"
  | "invalid_snapshot"
  | "missing_package"
  | "missing_skill"
  | "missing_snapshot"
  | "package_kind_mismatch"
  | "unexpected_package"
  | "unexpected_skill"
  | "version_mismatch";

export class WorkflowCapabilityError extends Error {
  override readonly name = "WorkflowCapabilityError";

  constructor(
    readonly code: WorkflowCapabilityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function collectWorkflowAgentSkillNames(workflow: CompiledWorkflow): readonly string[] {
  const names = new Set<string>();
  collect(workflow, names);
  return Object.freeze([...names].sort(compareStrings));
}

export interface WorkflowVerifierPackageReference {
  readonly name: string;
  readonly version: string;
  readonly kind: "command" | "model";
}

type InlineVerifierConfig = Extract<
  CompiledVerifierNode["verifier"],
  { readonly kind: "command" | "model" }
>;

export type ResolvedVerifierNode = Omit<CompiledVerifierNode, "verifier"> & {
  readonly verifier: InlineVerifierConfig;
};

export interface ResolvedVerifierPackageNode {
  readonly node: ResolvedVerifierNode;
  readonly package?: VerifierPackageUseEvidence;
}

export function collectWorkflowVerifierPackageReferences(
  workflow: CompiledWorkflow,
): readonly WorkflowVerifierPackageReference[] {
  const references = new Map<string, WorkflowVerifierPackageReference>();
  collectVerifierPackages(workflow, references);
  return Object.freeze(
    [...references.values()].sort((left, right) => compareStrings(left.name, right.name)),
  );
}

export function bindWorkflowCapabilities(
  workflow: CompiledWorkflow,
  snapshot?: CapabilitySnapshot,
  options: { readonly allowUnexpected?: boolean } = {},
): CapabilitySnapshot | undefined {
  const requiredSkills = collectWorkflowAgentSkillNames(workflow);
  const requiredVerifiers = collectWorkflowVerifierPackageReferences(workflow);
  const boundSnapshot = validateWorkflowCapabilitySnapshot(snapshot);
  if (requiredSkills.length + requiredVerifiers.length === 0) {
    if (boundSnapshot !== undefined && options.allowUnexpected !== true) {
      const unexpectedSkill = boundSnapshot.packages.find((item) => item.kind === "agent-skill");
      if (unexpectedSkill !== undefined) {
        throw new WorkflowCapabilityError(
          "unexpected_skill",
          `capability snapshot contains Agent Skill "${unexpectedSkill.name}" that workflow "${workflow.id}" does not select`,
        );
      }
      const unexpectedVerifier = boundSnapshot.packages.find(
        (item): item is VerifierPackageSnapshot => item.kind === "verifier-package",
      );
      if (unexpectedVerifier === undefined) {
        throw new WorkflowCapabilityError(
          "invalid_snapshot",
          "capability snapshot contains no recognized package",
        );
      }
      throw new WorkflowCapabilityError(
        "unexpected_package",
        `capability snapshot contains verifier package "${unexpectedVerifier.name}" version "${unexpectedVerifier.version}" that workflow "${workflow.id}" does not select`,
      );
    }
    return boundSnapshot;
  }
  if (boundSnapshot === undefined) {
    throw new WorkflowCapabilityError(
      "missing_snapshot",
      `workflow "${workflow.id}" selects ${capabilitySelectionLabel(requiredSkills, requiredVerifiers)} but has no immutable capability snapshot`,
    );
  }
  const availableSkills = boundSnapshot.packages.filter((item) => item.kind === "agent-skill");
  const missing = requiredSkills.find(
    (name) => !availableSkills.some((skill) => skill.name === name),
  );
  if (missing !== undefined) {
    throw new WorkflowCapabilityError(
      "missing_skill",
      `workflow "${workflow.id}" selects Agent Skill "${missing}" but the snapshot does not contain it`,
    );
  }
  const availableVerifiers = boundSnapshot.packages.filter(
    (item): item is VerifierPackageSnapshot => item.kind === "verifier-package",
  );
  for (const required of requiredVerifiers) {
    const selected = availableVerifiers.find(
      (item) => item.name === required.name && item.version === required.version,
    );
    if (selected === undefined) {
      const otherVersions = availableVerifiers
        .filter((item) => item.name === required.name)
        .map((item) => item.version);
      if (otherVersions.length > 0) {
        throw new WorkflowCapabilityError(
          "version_mismatch",
          `workflow "${workflow.id}" selects verifier package "${required.name}" version "${required.version}" but the snapshot contains ${formatVersions(otherVersions)}`,
        );
      }
      throw new WorkflowCapabilityError(
        "missing_package",
        `workflow "${workflow.id}" selects verifier package "${required.name}" but the snapshot does not contain it`,
      );
    }
    if (selected.definition.kind !== required.kind) {
      throw new WorkflowCapabilityError(
        "package_kind_mismatch",
        `workflow "${workflow.id}" selects verifier package "${required.name}" as ${required.kind} but the snapshot defines ${selected.definition.kind}`,
      );
    }
  }
  const unexpected = availableSkills.find((skill) => !requiredSkills.includes(skill.name));
  if (unexpected !== undefined && options.allowUnexpected !== true) {
    throw new WorkflowCapabilityError(
      "unexpected_skill",
      `capability snapshot contains Agent Skill "${unexpected.name}" that workflow "${workflow.id}" does not select`,
    );
  }
  const unexpectedVerifier = availableVerifiers.find(
    (item) =>
      !requiredVerifiers.some(
        (required) => required.name === item.name && required.version === item.version,
      ),
  );
  if (unexpectedVerifier !== undefined && options.allowUnexpected !== true) {
    throw new WorkflowCapabilityError(
      "unexpected_package",
      `capability snapshot contains verifier package "${unexpectedVerifier.name}" version "${unexpectedVerifier.version}" that workflow "${workflow.id}" does not select`,
    );
  }
  return boundSnapshot;
}

export function resolveVerifierPackageNode(
  node: CompiledVerifierNode,
  snapshot?: CapabilitySnapshot,
): ResolvedVerifierPackageNode {
  if (node.verifier.kind === "command" || node.verifier.kind === "model") {
    return Object.freeze({ node: node as ResolvedVerifierNode });
  }
  if (snapshot === undefined) {
    throw new WorkflowCapabilityError(
      "missing_snapshot",
      `verifier node "${node.id}" selects a package but has no immutable capability snapshot`,
    );
  }
  const reference = node.verifier.package;
  const selected = snapshot.packages.find(
    (item): item is VerifierPackageSnapshot =>
      item.kind === "verifier-package" &&
      item.name === reference.name &&
      item.version === reference.version,
  );
  if (selected === undefined) {
    const otherVersions = snapshot.packages
      .filter(
        (item): item is VerifierPackageSnapshot =>
          item.kind === "verifier-package" && item.name === reference.name,
      )
      .map((item) => item.version);
    if (otherVersions.length > 0) {
      throw new WorkflowCapabilityError(
        "version_mismatch",
        `verifier node "${node.id}" selects package "${reference.name}" version "${reference.version}" but the snapshot contains ${formatVersions(otherVersions)}`,
      );
    }
    throw new WorkflowCapabilityError(
      "missing_package",
      `verifier node "${node.id}" selects missing package "${reference.name}"`,
    );
  }
  const expectedKind = node.verifier.kind === "packaged-command" ? "command" : "model";
  if (selected.definition.kind !== expectedKind) {
    throw new WorkflowCapabilityError(
      "package_kind_mismatch",
      `verifier node "${node.id}" selects package "${reference.name}" as ${expectedKind} but the snapshot defines ${selected.definition.kind}`,
    );
  }
  const verifier: InlineVerifierConfig =
    selected.definition.kind === "command"
      ? Object.freeze({
          kind: "command",
          command: Object.freeze({
            executable: selected.definition.command.executable,
            args: Object.freeze([...selected.definition.command.args]),
            timeoutMs: selected.definition.command.timeoutMs,
          }),
        })
      : Object.freeze({
          kind: "model",
          prompt: selected.definition.prompt,
          evidence: Object.freeze(
            node.verifier.kind === "packaged-model"
              ? node.verifier.evidence.map((source) => Object.freeze({ ...source }))
              : [],
          ),
          model:
            node.verifier.kind === "packaged-model"
              ? Object.freeze({ ...node.verifier.model })
              : impossiblePackagedModel(node),
          timeoutMs:
            node.verifier.kind === "packaged-model"
              ? node.verifier.timeoutMs
              : impossiblePackagedModel(node),
        });
  return deepFreeze({
    node: { ...node, verifier },
    package: { name: selected.name, version: selected.version, digest: selected.digest },
  });
}

function collect(workflow: CompiledWorkflow, names: Set<string>): void {
  for (const node of workflow.nodes) {
    if (node.type === "agent") {
      for (const name of node.agent.skills) {
        names.add(name);
      }
    } else if (node.type === "child") {
      collect(node.child.workflow, names);
    }
  }
}

function collectVerifierPackages(
  workflow: CompiledWorkflow,
  references: Map<string, WorkflowVerifierPackageReference>,
): void {
  for (const node of workflow.nodes) {
    if (
      node.type === "verifier" &&
      (node.verifier.kind === "packaged-command" || node.verifier.kind === "packaged-model")
    ) {
      const reference: WorkflowVerifierPackageReference = {
        ...node.verifier.package,
        kind: node.verifier.kind === "packaged-command" ? "command" : "model",
      };
      const existing = references.get(reference.name);
      if (
        existing !== undefined &&
        (existing.version !== reference.version || existing.kind !== reference.kind)
      ) {
        throw new WorkflowCapabilityError(
          "conflicting_package",
          `workflow "${workflow.id}" selects incompatible identities for verifier package "${reference.name}"`,
        );
      }
      references.set(reference.name, Object.freeze(reference));
    } else if (node.type === "child") {
      collectVerifierPackages(node.child.workflow, references);
    }
  }
}

function impossiblePackagedModel(node: CompiledVerifierNode): never {
  throw new Error(`verifier node "${node.id}" has an impossible packaged model definition`);
}

function validateWorkflowCapabilitySnapshot(
  snapshot: CapabilitySnapshot | undefined,
): CapabilitySnapshot | undefined {
  if (snapshot === undefined) {
    return undefined;
  }
  try {
    return validateCapabilitySnapshot(snapshot);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkflowCapabilityError(
      "invalid_snapshot",
      `capability snapshot is invalid: ${boundedMessage(detail)}`,
      { cause: error },
    );
  }
}

function capabilitySelectionLabel(
  skills: readonly string[],
  verifiers: readonly WorkflowVerifierPackageReference[],
): string {
  if (skills.length > 0 && verifiers.length > 0) {
    return "Agent Skills and verifier packages";
  }
  return skills.length > 0 ? "Agent Skills" : "verifier packages";
}

function formatVersions(versions: readonly string[]): string {
  const quoted = versions.map((version) => `"${version}"`);
  return quoted.length === 1
    ? (quoted[0] ?? "an unknown version")
    : `versions ${quoted.join(", ")}`;
}

function boundedMessage(value: string): string {
  return value.length <= 4_096 ? value : `${value.slice(0, 4_060)}… [truncated]`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
