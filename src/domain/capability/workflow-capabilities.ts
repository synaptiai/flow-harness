import type { CompiledWorkflow } from "../workflow/types.js";
import type { CapabilitySnapshot } from "./agent-skills.js";

export type WorkflowCapabilityErrorCode = "missing_skill" | "missing_snapshot" | "unexpected_skill";

export class WorkflowCapabilityError extends Error {
  override readonly name = "WorkflowCapabilityError";

  constructor(
    readonly code: WorkflowCapabilityErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function collectWorkflowAgentSkillNames(workflow: CompiledWorkflow): readonly string[] {
  const names = new Set<string>();
  collect(workflow, names);
  return Object.freeze([...names].sort(compareStrings));
}

export function bindWorkflowCapabilities(
  workflow: CompiledWorkflow,
  snapshot?: CapabilitySnapshot,
  options: { readonly allowUnexpected?: boolean } = {},
): CapabilitySnapshot | undefined {
  const required = collectWorkflowAgentSkillNames(workflow);
  if (required.length === 0) {
    if (snapshot !== undefined && options.allowUnexpected !== true) {
      throw new WorkflowCapabilityError(
        "unexpected_skill",
        `workflow "${workflow.id}" selects no Agent Skills but received a capability snapshot`,
      );
    }
    return snapshot;
  }
  if (snapshot === undefined) {
    throw new WorkflowCapabilityError(
      "missing_snapshot",
      `workflow "${workflow.id}" selects Agent Skills but has no immutable capability snapshot`,
    );
  }
  const available = snapshot.packages.map((skill) => skill.name);
  const missing = required.find((name) => !available.includes(name));
  if (missing !== undefined) {
    throw new WorkflowCapabilityError(
      "missing_skill",
      `workflow "${workflow.id}" selects Agent Skill "${missing}" but the snapshot does not contain it`,
    );
  }
  const unexpected = available.find((name) => !required.includes(name));
  if (unexpected !== undefined && options.allowUnexpected !== true) {
    throw new WorkflowCapabilityError(
      "unexpected_skill",
      `capability snapshot contains Agent Skill "${unexpected}" that workflow "${workflow.id}" does not select`,
    );
  }
  return snapshot;
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
