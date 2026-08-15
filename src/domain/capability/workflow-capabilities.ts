import { calculateWorkflowDigest } from "../workflow/digest.js";
import type {
  CompiledAgentNode,
  CompiledVerifierNode,
  CompiledWorkflow,
} from "../workflow/types.js";
import { type CapabilitySnapshot, validateCapabilitySnapshot } from "./agent-skills.js";
import type { ToolPackageSnapshot } from "./tool-packages.js";
import type { VerifierPackageSnapshot, VerifierPackageUseEvidence } from "./verifier-packages.js";
import type { WorkflowPackageSnapshot } from "./workflow-packages.js";

export type WorkflowCapabilityErrorCode =
  | "conflicting_package"
  | "digest_mismatch"
  | "invalid_snapshot"
  | "missing_package"
  | "missing_skill"
  | "missing_snapshot"
  | "package_kind_mismatch"
  | "tool_name_collision"
  | "unexpected_activation"
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

export interface WorkflowToolPackageReference {
  readonly name: string;
  readonly version: string;
}

export interface WorkflowPackageReference {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
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

export function collectWorkflowToolPackageReferences(
  workflow: CompiledWorkflow,
): readonly WorkflowToolPackageReference[] {
  const references = new Map<string, WorkflowToolPackageReference>();
  collectToolPackages(workflow, references);
  return Object.freeze(
    [...references.values()].sort((left, right) => compareStrings(left.name, right.name)),
  );
}

export function collectWorkflowPackageReferences(
  workflow: CompiledWorkflow,
): readonly WorkflowPackageReference[] {
  const references = new Map<string, WorkflowPackageReference>();
  collectWorkflowPackages(workflow, references);
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
  const requiredTools = collectWorkflowToolPackageReferences(workflow);
  const requiredWorkflows = collectWorkflowPackageReferences(workflow);
  const boundSnapshot = validateWorkflowCapabilitySnapshot(snapshot);
  assertPromptActivationBinding(workflow, boundSnapshot, options.allowUnexpected === true);
  if (
    requiredSkills.length +
      requiredVerifiers.length +
      requiredTools.length +
      requiredWorkflows.length ===
    0
  ) {
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
      if (unexpectedVerifier !== undefined) {
        throw new WorkflowCapabilityError(
          "unexpected_package",
          `capability snapshot contains verifier package "${unexpectedVerifier.name}" version "${unexpectedVerifier.version}" that workflow "${workflow.id}" does not select`,
        );
      }
      const unexpectedTool = boundSnapshot.packages.find(
        (item): item is ToolPackageSnapshot => item.kind === "tool-package",
      );
      if (unexpectedTool !== undefined) {
        throw new WorkflowCapabilityError(
          "unexpected_package",
          `capability snapshot contains tool package "${unexpectedTool.name}" version "${unexpectedTool.version}" that workflow "${workflow.id}" does not select`,
        );
      }
      const unexpectedWorkflow = boundSnapshot.packages.find(
        (item): item is WorkflowPackageSnapshot => item.kind === "workflow-package",
      );
      if (unexpectedWorkflow !== undefined) {
        throw new WorkflowCapabilityError(
          "unexpected_package",
          `capability snapshot contains workflow package "${unexpectedWorkflow.name}" version "${unexpectedWorkflow.version}" that workflow "${workflow.id}" does not select`,
        );
      }
      if (
        (boundSnapshot.activations?.length ?? 0) === 0 &&
        !boundSnapshot.packages.some((item) => item.kind === "policy-package")
      ) {
        throw new WorkflowCapabilityError(
          "invalid_snapshot",
          "capability snapshot contains no recognized package or activation",
        );
      }
    }
    return boundSnapshot;
  }
  if (boundSnapshot === undefined) {
    throw new WorkflowCapabilityError(
      "missing_snapshot",
      `workflow "${workflow.id}" selects ${capabilitySelectionLabel(requiredSkills, requiredVerifiers, requiredTools, requiredWorkflows)} but has no immutable capability snapshot`,
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
  const availableTools = boundSnapshot.packages.filter(
    (item): item is ToolPackageSnapshot => item.kind === "tool-package",
  );
  for (const required of requiredTools) {
    const selected = availableTools.find(
      (item) => item.name === required.name && item.version === required.version,
    );
    if (selected === undefined) {
      const otherVersions = availableTools
        .filter((item) => item.name === required.name)
        .map((item) => item.version);
      if (otherVersions.length > 0) {
        throw new WorkflowCapabilityError(
          "version_mismatch",
          `workflow "${workflow.id}" selects tool package "${required.name}" version "${required.version}" but the snapshot contains ${formatVersions(otherVersions)}`,
        );
      }
      throw new WorkflowCapabilityError(
        "missing_package",
        `workflow "${workflow.id}" selects tool package "${required.name}" but the snapshot does not contain it`,
      );
    }
  }
  const availableWorkflows = boundSnapshot.packages.filter(
    (item): item is WorkflowPackageSnapshot => item.kind === "workflow-package",
  );
  for (const required of requiredWorkflows) {
    const selected = availableWorkflows.find(
      (item) => item.name === required.name && item.version === required.version,
    );
    if (selected === undefined) {
      const otherVersions = availableWorkflows
        .filter((item) => item.name === required.name)
        .map((item) => item.version);
      if (otherVersions.length > 0) {
        throw new WorkflowCapabilityError(
          "version_mismatch",
          `workflow "${workflow.id}" selects workflow package "${required.name}" version "${required.version}" but the snapshot contains ${formatVersions(otherVersions)}`,
        );
      }
      throw new WorkflowCapabilityError(
        "missing_package",
        `workflow "${workflow.id}" selects workflow package "${required.name}" but the snapshot does not contain it`,
      );
    }
    if (selected.digest !== required.digest) {
      throw new WorkflowCapabilityError(
        "digest_mismatch",
        `workflow "${workflow.id}" selects workflow package "${required.name}@${required.version}" digest "${required.digest}" but the snapshot contains "${selected.digest}"`,
      );
    }
  }
  assertAgentToolNames(workflow, availableTools);
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
  const unexpectedTool = availableTools.find(
    (item) =>
      !requiredTools.some(
        (required) => required.name === item.name && required.version === item.version,
      ),
  );
  if (unexpectedTool !== undefined && options.allowUnexpected !== true) {
    throw new WorkflowCapabilityError(
      "unexpected_package",
      `capability snapshot contains tool package "${unexpectedTool.name}" version "${unexpectedTool.version}" that workflow "${workflow.id}" does not select`,
    );
  }
  const unexpectedWorkflow = availableWorkflows.find(
    (item) =>
      !requiredWorkflows.some(
        (required) =>
          required.name === item.name &&
          required.version === item.version &&
          required.digest === item.digest,
      ),
  );
  if (unexpectedWorkflow !== undefined && options.allowUnexpected !== true) {
    throw new WorkflowCapabilityError(
      "unexpected_package",
      `capability snapshot contains workflow package "${unexpectedWorkflow.name}" version "${unexpectedWorkflow.version}" that workflow "${workflow.id}" does not select`,
    );
  }
  return boundSnapshot;
}

function assertPromptActivationBinding(
  workflow: CompiledWorkflow,
  snapshot: CapabilitySnapshot | undefined,
  allowUnexpected: boolean,
): void {
  const activation = snapshot?.activations?.[0];
  if (activation === undefined) {
    return;
  }
  if (activation.workflowId !== workflow.id) {
    if (allowUnexpected) {
      return;
    }
    throw new WorkflowCapabilityError(
      "unexpected_activation",
      `capability snapshot contains activation for workflow "${activation.workflowId}", not "${workflow.id}"`,
    );
  }
  const workflowDigest = calculateWorkflowDigest(workflow);
  const expectedWorkflowDigest =
    activation.selection === "candidate"
      ? activation.candidate.projectedWorkflow.workflowDigest
      : activation.candidate.baseline.workflowDigest;
  if (expectedWorkflowDigest !== workflowDigest) {
    throw new WorkflowCapabilityError(
      "digest_mismatch",
      `workflow "${workflow.id}" does not match activation digest "${activation.activationDigest}"`,
    );
  }
}

export function resolveAgentToolPackages(
  node: CompiledAgentNode,
  snapshot?: CapabilitySnapshot,
): readonly ToolPackageSnapshot[] {
  if (node.agent.toolPackages.length === 0) {
    return Object.freeze([]);
  }
  if (snapshot === undefined) {
    throw new WorkflowCapabilityError(
      "missing_snapshot",
      `agent node "${node.id}" selects tool packages but has no immutable capability snapshot`,
    );
  }
  const selected = node.agent.toolPackages.map((reference) => {
    const exact = snapshot.packages.find(
      (item): item is ToolPackageSnapshot =>
        item.kind === "tool-package" &&
        item.name === reference.name &&
        item.version === reference.version,
    );
    if (exact !== undefined) {
      return exact;
    }
    const otherVersions = snapshot.packages
      .filter(
        (item): item is ToolPackageSnapshot =>
          item.kind === "tool-package" && item.name === reference.name,
      )
      .map((item) => item.version);
    if (otherVersions.length > 0) {
      throw new WorkflowCapabilityError(
        "version_mismatch",
        `agent node "${node.id}" selects tool package "${reference.name}" version "${reference.version}" but the snapshot contains ${formatVersions(otherVersions)}`,
      );
    }
    throw new WorkflowCapabilityError(
      "missing_package",
      `agent node "${node.id}" selects missing tool package "${reference.name}"`,
    );
  });
  assertUniqueToolNames(node, selected);
  return Object.freeze(selected);
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

function collectToolPackages(
  workflow: CompiledWorkflow,
  references: Map<string, WorkflowToolPackageReference>,
): void {
  for (const node of workflow.nodes) {
    if (node.type === "agent") {
      for (const selected of node.agent.toolPackages) {
        const existing = references.get(selected.name);
        if (existing !== undefined && existing.version !== selected.version) {
          throw new WorkflowCapabilityError(
            "conflicting_package",
            `workflow "${workflow.id}" selects incompatible versions of tool package "${selected.name}"`,
          );
        }
        references.set(selected.name, Object.freeze({ ...selected }));
      }
    } else if (node.type === "child") {
      collectToolPackages(node.child.workflow, references);
    }
  }
}

function collectWorkflowPackages(
  workflow: CompiledWorkflow,
  references: Map<string, WorkflowPackageReference>,
): void {
  if (workflow.sourcePackage !== undefined) {
    const existing = references.get(workflow.sourcePackage.name);
    if (
      existing !== undefined &&
      (existing.version !== workflow.sourcePackage.version ||
        existing.digest !== workflow.sourcePackage.digest)
    ) {
      throw new WorkflowCapabilityError(
        "conflicting_package",
        `workflow "${workflow.id}" selects incompatible identities for workflow package "${workflow.sourcePackage.name}"`,
      );
    }
    references.set(workflow.sourcePackage.name, workflow.sourcePackage);
  }
  for (const node of workflow.nodes) {
    if (node.type === "child") {
      collectWorkflowPackages(node.child.workflow, references);
    }
  }
}

function assertAgentToolNames(
  workflow: CompiledWorkflow,
  available: readonly ToolPackageSnapshot[],
): void {
  for (const node of workflow.nodes) {
    if (node.type === "agent") {
      const selected = node.agent.toolPackages.map((reference) => {
        const exact = available.find(
          (item) => item.name === reference.name && item.version === reference.version,
        );
        if (exact === undefined) {
          throw new WorkflowCapabilityError(
            "missing_package",
            `agent node "${node.id}" cannot bind tool package "${reference.name}"`,
          );
        }
        return exact;
      });
      assertUniqueToolNames(node, selected);
    } else if (node.type === "child") {
      assertAgentToolNames(node.child.workflow, available);
    }
  }
}

function assertUniqueToolNames(
  node: CompiledAgentNode,
  packages: readonly ToolPackageSnapshot[],
): void {
  const names = new Set<string>();
  for (const item of packages) {
    const toolName = item.definition.tool.name;
    if (names.has(toolName)) {
      throw new WorkflowCapabilityError(
        "tool_name_collision",
        `agent node "${node.id}" selects multiple packages with model tool name "${toolName}"`,
      );
    }
    names.add(toolName);
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
  tools: readonly WorkflowToolPackageReference[],
  workflows: readonly WorkflowPackageReference[],
): string {
  const selected = [
    ...(skills.length > 0 ? ["Agent Skills"] : []),
    ...(verifiers.length > 0 ? ["verifier packages"] : []),
    ...(tools.length > 0 ? ["tool packages"] : []),
    ...(workflows.length > 0 ? ["workflow packages"] : []),
  ];
  return selected.length === 1
    ? (selected[0] ?? "capabilities")
    : `${selected.slice(0, -1).join(", ")} and ${selected.at(-1)}`;
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
