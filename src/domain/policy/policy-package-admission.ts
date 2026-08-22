import type { CapabilitySnapshot } from "../capability/agent-skills.js";
import type {
  PolicyPackageDefinition,
  PolicyPackageSnapshot,
} from "../capability/policy-packages.js";
import type { ToolPackageSnapshot } from "../capability/tool-packages.js";
import type { AgentToolName, CompiledRunBudget, CompiledWorkflow } from "../workflow/types.js";
import { composePolicyPackages } from "./policy-package-composition.js";
import type { PolicyAction } from "./types.js";

export type PolicyPackageAdmissionErrorCode = "policy_violation";

export class PolicyPackageAdmissionError extends Error {
  override readonly name = "PolicyPackageAdmissionError";

  constructor(
    readonly code: PolicyPackageAdmissionErrorCode,
    readonly fieldPath: string,
    message: string,
  ) {
    super(`${fieldPath}: ${message}`);
  }
}

export function assertWorkflowSatisfiesPolicyPackages(
  workflow: CompiledWorkflow,
  capabilitySnapshot?: CapabilitySnapshot,
): void {
  const policies =
    capabilitySnapshot?.packages.filter(
      (item): item is PolicyPackageSnapshot => item.kind === "policy-package",
    ) ?? [];
  const effective = composePolicyPackages(policies);
  if (effective === undefined) {
    return;
  }
  const toolPackages = new Map(
    (capabilitySnapshot?.packages ?? [])
      .filter((item): item is ToolPackageSnapshot => item.kind === "tool-package")
      .map((item) => [`${item.name}\0${item.version}`, item]),
  );
  assertWorkflow(workflow, effective.constraints, toolPackages, "");
}

function assertWorkflow(
  workflow: CompiledWorkflow,
  constraints: NonNullable<ReturnType<typeof composePolicyPackages>>["constraints"],
  toolPackages: ReadonlyMap<string, ToolPackageSnapshot>,
  prefix: string,
): void {
  assertBudget(workflow.budget, constraints.budget, `${prefix}budget`);
  for (const node of workflow.nodes) {
    const path = `${prefix}nodes.${node.id}`;
    if (node.type === "agent") {
      assertModel(
        node.agent.model.provider,
        node.agent.model.id,
        constraints.models?.allowed,
        `${path}.agent.model`,
      );
      const tools: string[] = [...node.agent.tools];
      const permissions: PolicyAction[] = node.agent.tools.map(builtInToolPermission);
      for (const reference of node.agent.toolPackages) {
        const selected = toolPackages.get(`${reference.name}\0${reference.version}`);
        if (selected === undefined) {
          throw violation(
            `${path}.agent.toolPackages`,
            `selected tool package "${reference.name}@${reference.version}" is absent from the immutable snapshot`,
          );
        }
        tools.push(selected.definition.tool.name);
        permissions.push(...selected.definition.permissions);
      }
      assertAllowedValues(tools, constraints.tools?.allowed, `${path}.agent.tools`, "tool");
      assertAllowedValues(
        permissions,
        constraints.tools?.allowedPermissions,
        `${path}.agent.tools`,
        "tool permission",
      );
      if (
        constraints.commands?.requireApproval === true &&
        (node.agent.tools.includes("exec") || node.agent.toolPackages.length > 0) &&
        node.agent.toolApproval?.exec.mode !== "required"
      ) {
        throw violation(
          `${path}.agent.toolApproval`,
          "command-capable agent tools require explicit approval",
        );
      }
      continue;
    }
    if (node.type === "command") {
      if (constraints.commands?.requireApproval === true && node.approval?.mode !== "required") {
        throw violation(`${path}.approval`, "command execution requires explicit approval");
      }
      continue;
    }
    if (
      node.type === "verifier" &&
      (node.verifier.kind === "model" || node.verifier.kind === "packaged-model")
    ) {
      assertModel(
        node.verifier.model.provider,
        node.verifier.model.id,
        constraints.models?.allowed,
        `${path}.verifier.model`,
      );
      continue;
    }
    if (
      node.type === "verifier" &&
      constraints.commands?.requireApproval === true &&
      (node.verifier.kind === "command" || node.verifier.kind === "packaged-command")
    ) {
      throw violation(
        `${path}.verifier`,
        "command verifier execution has no supported approval contract",
      );
    }
    if (node.type === "child") {
      assertWorkflow(node.child.workflow, constraints, toolPackages, `${path}.child.workflow.`);
    }
  }
}

function assertModel(
  provider: string,
  model: string,
  allowed: readonly { readonly provider: string; readonly model: string }[] | undefined,
  fieldPath: string,
): void {
  if (
    allowed !== undefined &&
    !allowed.some((candidate) => candidate.provider === provider && candidate.model === model)
  ) {
    throw violation(fieldPath, `model "${provider}/${model}" is not allowed`);
  }
}

function assertAllowedValues<T extends string>(
  actual: readonly T[],
  allowed: readonly T[] | undefined,
  fieldPath: string,
  label: string,
): void {
  if (allowed === undefined) {
    return;
  }
  const allowedValues = new Set(allowed);
  const rejected = actual.find((value) => !allowedValues.has(value));
  if (rejected !== undefined) {
    throw violation(fieldPath, `${label} "${rejected}" is not allowed`);
  }
}

function assertBudget(
  budget: CompiledRunBudget | undefined,
  ceiling: PolicyPackageDefinition["budget"],
  fieldPath: string,
): void {
  if (ceiling === undefined) {
    return;
  }
  for (const field of budgetFields) {
    const maximum = ceiling[field];
    if (maximum === undefined) {
      continue;
    }
    const selected = budget?.[field];
    if (selected === undefined) {
      throw violation(
        `${fieldPath}.${field}`,
        `workflow must declare a value at or below ${maximum}`,
      );
    }
    if (selected > maximum) {
      throw violation(
        `${fieldPath}.${field}`,
        `workflow value ${selected} exceeds ceiling ${maximum}`,
      );
    }
  }
}

const budgetFields = Object.freeze([
  "maxNodeStarts",
  "maxModelTokens",
  "maxCostUsdMicros",
  "maxExecutionMs",
  "maxArtifactBytes",
] as const satisfies readonly (keyof CompiledRunBudget)[]);

function builtInToolPermission(tool: AgentToolName): PolicyAction {
  switch (tool) {
    case "read":
      return "filesystem.read";
    case "ls":
      return "filesystem.list";
    case "edit":
      return "filesystem.write";
    case "exec":
      return "process.execute";
    case "semantic":
      return "filesystem.read";
    case "artifact":
      return "artifact.read";
  }
}

function violation(fieldPath: string, message: string): PolicyPackageAdmissionError {
  return new PolicyPackageAdmissionError("policy_violation", fieldPath, message);
}
