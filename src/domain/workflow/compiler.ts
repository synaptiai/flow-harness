import { parseDocument } from "yaml";

import type { GoalContractSource } from "../goal/schema.js";
import type { CompiledGoal } from "../goal/types.js";
import { workflowSourceSchema, type WorkflowSource } from "./schema.js";
import {
  MAX_CONTROL_GRAPH_SERIALIZED_BYTES,
  type CompiledAgentNode,
  type CompiledCommandNode,
  type CompiledConditionNode,
  type CompiledJoinNode,
  type CompiledNode,
  type CompiledRunBudget,
  type CompiledWorkflow,
  type CompiledWorkflowConcurrency,
} from "./types.js";

export interface WorkflowDiagnostic {
  readonly code:
    | "cycle"
    | "branch_cross_dependency"
    | "branch_guard_requires_condition"
    | "branch_guard_requires_dependency"
    | "branch_guard_unknown_case"
    | "condition_case_requires_branch"
    | "condition_join_count"
    | "control_graph_too_large"
    | "condition_source_field_mismatch"
    | "condition_source_requires_dependency"
    | "condition_source_unknown"
    | "criterion_verifier_requires_command"
    | "criterion_verifier_requires_terminal"
    | "duplicate_dependency"
    | "duplicate_criterion"
    | "duplicate_node"
    | "entry_count"
    | "invalid_schema"
    | "invalid_yaml"
    | "join_branch_incomplete"
    | "join_branch_membership"
    | "join_branch_unknown_node"
    | "join_case_coverage"
    | "join_unknown_condition"
    | "self_dependency"
    | "terminal_requires_command"
    | "unknown_criterion_verifier"
    | "unknown_dependency";
  readonly path: string;
  readonly message: string;
}

export class WorkflowCompilationError extends Error {
  override readonly name = "WorkflowCompilationError";

  constructor(
    readonly sourceName: string,
    readonly diagnostics: readonly WorkflowDiagnostic[],
  ) {
    super(
      `Workflow compilation failed for ${sourceName}: ${diagnostics.map((item) => item.message).join("; ")}`,
    );
  }
}

export function compileWorkflowText(source: string, sourceName = "workflow"): CompiledWorkflow {
  const parsed = parseYaml(source, sourceName);
  const result = workflowSourceSchema.safeParse(parsed);

  if (!result.success) {
    const diagnostics = result.error.issues.map<WorkflowDiagnostic>((issue) => ({
      code: "invalid_schema",
      path: formatPath(issue.path),
      message: issue.message,
    }));
    throw new WorkflowCompilationError(sourceName, Object.freeze(diagnostics));
  }

  const diagnostics = validateGraph(result.data);
  if (diagnostics.length > 0) {
    throw new WorkflowCompilationError(sourceName, Object.freeze(diagnostics));
  }

  return freezeWorkflow(result.data);
}

function parseYaml(source: string, sourceName: string): unknown {
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });

    if (document.errors.length > 0) {
      throw new WorkflowCompilationError(
        sourceName,
        Object.freeze(
          document.errors.map<WorkflowDiagnostic>((error) => ({
            code: "invalid_yaml",
            path: "$",
            message: error.message,
          })),
        ),
      );
    }

    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof WorkflowCompilationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowCompilationError(
      sourceName,
      Object.freeze([{ code: "invalid_yaml", path: "$", message }]),
    );
  }
}

function validateGraph(workflow: WorkflowSource): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const firstIndexById = new Map<string, number>();

  for (const [index, node] of workflow.nodes.entries()) {
    const previousIndex = firstIndexById.get(node.id);
    if (previousIndex !== undefined) {
      diagnostics.push({
        code: "duplicate_node",
        path: `nodes.${index}.id`,
        message: `node id "${node.id}" duplicates nodes.${previousIndex}.id`,
      });
    } else {
      firstIndexById.set(node.id, index);
    }
  }

  for (const [nodeIndex, node] of workflow.nodes.entries()) {
    const seenDependencies = new Set<string>();
    for (const [dependencyIndex, dependency] of sourceDependencies(node).entries()) {
      const path = dependencyPath(node, nodeIndex, dependencyIndex);
      if (dependency === node.id) {
        diagnostics.push({
          code: "self_dependency",
          path,
          message: `node "${node.id}" cannot depend on itself`,
        });
      }
      if (seenDependencies.has(dependency)) {
        diagnostics.push({
          code: "duplicate_dependency",
          path,
          message: `node "${node.id}" declares dependency "${dependency}" more than once`,
        });
      }
      if (!firstIndexById.has(dependency)) {
        diagnostics.push({
          code: "unknown_dependency",
          path,
          message: `node "${node.id}" depends on unknown node "${dependency}"`,
        });
      }
      seenDependencies.add(dependency);
    }
  }

  const entries = workflow.nodes.filter((node) => sourceDependencies(node).length === 0);
  if (entries.length !== 1) {
    diagnostics.push({
      code: "entry_count",
      path: "nodes",
      message: `workflow must contain exactly one entry node; found ${entries.length}`,
    });
  }

  const dependedUpon = new Set(workflow.nodes.flatMap(sourceDependencies));
  for (const [index, node] of workflow.nodes.entries()) {
    if (!dependedUpon.has(node.id) && node.type !== "command") {
      diagnostics.push({
        code: "terminal_requires_command",
        path: `nodes.${index}.type`,
        message: `terminal node "${node.id}" must be a command verifier`,
      });
    }
  }

  if (workflow.goal !== undefined) {
    const seenCriteria = new Set<string>();
    for (const [index, criterion] of workflow.goal.criteria.entries()) {
      const idPath = `goal.criteria.${index}.id`;
      const verifierPath = `goal.criteria.${index}.verifier.nodeId`;
      if (seenCriteria.has(criterion.id)) {
        diagnostics.push({
          code: "duplicate_criterion",
          path: idPath,
          message: `criterion id "${criterion.id}" is declared more than once`,
        });
      }
      seenCriteria.add(criterion.id);

      const verifier = workflow.nodes.find((node) => node.id === criterion.verifier.nodeId);
      if (verifier === undefined) {
        diagnostics.push({
          code: "unknown_criterion_verifier",
          path: verifierPath,
          message: `criterion "${criterion.id}" references unknown verifier node "${criterion.verifier.nodeId}"`,
        });
        continue;
      }
      if (verifier.type !== "command") {
        diagnostics.push({
          code: "criterion_verifier_requires_command",
          path: verifierPath,
          message: `criterion "${criterion.id}" verifier "${verifier.id}" must be a command node`,
        });
      }
      if (dependedUpon.has(verifier.id)) {
        diagnostics.push({
          code: "criterion_verifier_requires_terminal",
          path: verifierPath,
          message: `criterion "${criterion.id}" verifier "${verifier.id}" must be terminal`,
        });
      }
    }
  }

  validateControlFlow(workflow, diagnostics);

  const cycle = findCycle(workflow.nodes);
  if (cycle !== undefined) {
    diagnostics.push({
      code: "cycle",
      path: "nodes",
      message: `workflow contains a dependency cycle: ${cycle.join(" -> ")}`,
    });
  }

  return diagnostics;
}

type SourceNode = WorkflowSource["nodes"][number];

function sourceDependencies(node: SourceNode): readonly string[] {
  return node.type === "join" ? node.join.branches.map((branch) => branch.nodeId) : node.dependsOn;
}

function dependencyPath(node: SourceNode, nodeIndex: number, dependencyIndex: number): string {
  return node.type === "join"
    ? `nodes.${nodeIndex}.join.branches.${dependencyIndex}.nodeId`
    : `nodes.${nodeIndex}.dependsOn.${dependencyIndex}`;
}

function validateControlFlow(workflow: WorkflowSource, diagnostics: WorkflowDiagnostic[]): void {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const indexById = new Map(workflow.nodes.map((node, index) => [node.id, index]));
  const conditions = workflow.nodes.filter(
    (node): node is Extract<SourceNode, { readonly type: "condition" }> =>
      node.type === "condition",
  );
  const joins = workflow.nodes.filter(
    (node): node is Extract<SourceNode, { readonly type: "join" }> => node.type === "join",
  );

  if (
    conditions.length > 0 &&
    Buffer.byteLength(JSON.stringify(sourceControlGraph(workflow.nodes)), "utf8") >
      MAX_CONTROL_GRAPH_SERIALIZED_BYTES
  ) {
    diagnostics.push({
      code: "control_graph_too_large",
      path: "nodes",
      message: `serialized control graph must not exceed ${MAX_CONTROL_GRAPH_SERIALIZED_BYTES} UTF-8 bytes`,
    });
  }

  for (const condition of conditions) {
    const index = indexById.get(condition.id) ?? 0;
    const source = nodeById.get(condition.condition.source.nodeId);
    if (source === undefined) {
      diagnostics.push({
        code: "condition_source_unknown",
        path: `nodes.${index}.condition.source.nodeId`,
        message: `condition "${condition.id}" references unknown source node "${condition.condition.source.nodeId}"`,
      });
    } else {
      if (!condition.dependsOn.includes(source.id)) {
        diagnostics.push({
          code: "condition_source_requires_dependency",
          path: `nodes.${index}.condition.source.nodeId`,
          message: `condition "${condition.id}" source "${source.id}" must be a direct dependency`,
        });
      }
      const fieldMatches =
        (condition.condition.source.field.startsWith("command.") && source.type === "command") ||
        (condition.condition.source.field === "agent.text" && source.type === "agent");
      if (!fieldMatches) {
        diagnostics.push({
          code: "condition_source_field_mismatch",
          path: `nodes.${index}.condition.source.field`,
          message: `condition "${condition.id}" source field "${condition.condition.source.field}" is incompatible with node "${source.id}" of type "${source.type}"`,
        });
      }
    }
  }

  for (const [index, node] of workflow.nodes.entries()) {
    if (node.type === "join" || node.when === undefined) {
      continue;
    }
    const condition = nodeById.get(node.when.conditionId);
    if (condition?.type !== "condition") {
      diagnostics.push({
        code: "branch_guard_requires_condition",
        path: `nodes.${index}.when.conditionId`,
        message: `node "${node.id}" guard must reference a condition node`,
      });
      continue;
    }
    if (!node.dependsOn.includes(condition.id)) {
      diagnostics.push({
        code: "branch_guard_requires_dependency",
        path: `nodes.${index}.when.conditionId`,
        message: `node "${node.id}" must directly depend on guarded condition "${condition.id}"`,
      });
    }
    if (!conditionCases(condition).includes(node.when.case)) {
      diagnostics.push({
        code: "branch_guard_unknown_case",
        path: `nodes.${index}.when.case`,
        message: `node "${node.id}" guard references unknown case "${node.when.case}"`,
      });
    }
  }

  for (const [index, join] of joins.map((node) => [indexById.get(node.id) ?? 0, node] as const)) {
    const condition = nodeById.get(join.join.conditionId);
    if (condition?.type !== "condition") {
      diagnostics.push({
        code: "join_unknown_condition",
        path: `nodes.${index}.join.conditionId`,
        message: `join "${join.id}" must reference a condition node`,
      });
      continue;
    }
    const expectedCases = conditionCases(condition);
    const actualCases = join.join.branches.map((branch) => branch.case);
    if (
      actualCases.length !== expectedCases.length ||
      new Set(actualCases).size !== actualCases.length ||
      expectedCases.some((caseId) => !actualCases.includes(caseId))
    ) {
      diagnostics.push({
        code: "join_case_coverage",
        path: `nodes.${index}.join.branches`,
        message: `join "${join.id}" must map every case of condition "${condition.id}" exactly once`,
      });
    }
    for (const [branchIndex, branch] of join.join.branches.entries()) {
      if (!nodeById.has(branch.nodeId)) {
        diagnostics.push({
          code: "join_branch_unknown_node",
          path: `nodes.${index}.join.branches.${branchIndex}.nodeId`,
          message: `join "${join.id}" references unknown branch terminal "${branch.nodeId}"`,
        });
      }
    }
  }

  for (const condition of conditions) {
    const conditionIndex = indexById.get(condition.id) ?? 0;
    const possibleCases = conditionCases(condition);
    for (const [caseIndex, caseId] of possibleCases.entries()) {
      const roots = workflow.nodes.filter(
        (node) =>
          node.type !== "join" &&
          node.when?.conditionId === condition.id &&
          node.when.case === caseId,
      );
      if (roots.length === 0) {
        diagnostics.push({
          code: "condition_case_requires_branch",
          path:
            caseIndex < condition.condition.cases.length
              ? `nodes.${conditionIndex}.condition.cases.${caseIndex}.id`
              : `nodes.${conditionIndex}.condition.default`,
          message: `condition "${condition.id}" case "${caseId}" has no guarded branch`,
        });
      }
    }

    const matchingJoins = joins.filter((join) => join.join.conditionId === condition.id);
    if (matchingJoins.length !== 1) {
      diagnostics.push({
        code: "condition_join_count",
        path: `nodes.${conditionIndex}.condition`,
        message: `condition "${condition.id}" must have exactly one join; found ${matchingJoins.length}`,
      });
      continue;
    }

    const membership = branchMembership(workflow.nodes, condition.id);
    for (const [nodeId, value] of membership.entries()) {
      if (value !== "cross") {
        continue;
      }
      const nodeIndex = indexById.get(nodeId) ?? 0;
      const node = nodeById.get(nodeId);
      diagnostics.push({
        code: "branch_cross_dependency",
        path:
          node?.type === "join"
            ? `nodes.${nodeIndex}.join.branches`
            : `nodes.${nodeIndex}.dependsOn`,
        message: `node "${nodeId}" depends across cases of condition "${condition.id}" without its explicit join`,
      });
    }

    const join = matchingJoins[0];
    if (join === undefined) {
      continue;
    }
    const joinIndex = indexById.get(join.id) ?? 0;
    for (const [branchIndex, branch] of join.join.branches.entries()) {
      const branchMembershipValue = membership.get(branch.nodeId);
      if (branchMembershipValue !== branch.case) {
        diagnostics.push({
          code: "join_branch_membership",
          path: `nodes.${joinIndex}.join.branches.${branchIndex}.nodeId`,
          message: `join "${join.id}" terminal "${branch.nodeId}" does not belong exclusively to case "${branch.case}"`,
        });
        continue;
      }
      const incomplete = [...membership.entries()].some(
        ([nodeId, value]) =>
          value === branch.case &&
          nodeId !== branch.nodeId &&
          !isAncestor(nodeId, branch.nodeId, nodeById),
      );
      if (incomplete) {
        diagnostics.push({
          code: "join_branch_incomplete",
          path: `nodes.${joinIndex}.join.branches.${branchIndex}.nodeId`,
          message: `join "${join.id}" terminal "${branch.nodeId}" does not wait for every node in case "${branch.case}"`,
        });
      }
    }
  }
}

function sourceControlGraph(nodes: readonly SourceNode[]): object {
  return {
    nodes: nodes.map((node) => {
      if (node.type === "condition") {
        return {
          nodeId: node.id,
          type: node.type,
          dependsOn: node.dependsOn,
          ...(node.when === undefined ? {} : { when: node.when }),
          condition: node.condition,
        };
      }
      if (node.type === "join") {
        return {
          nodeId: node.id,
          type: node.type,
          dependsOn: sourceDependencies(node),
          join: node.join,
        };
      }
      return {
        nodeId: node.id,
        type: node.type,
        dependsOn: node.dependsOn,
        ...(node.when === undefined ? {} : { when: node.when }),
      };
    }),
  };
}

function conditionCases(
  condition: Extract<SourceNode, { readonly type: "condition" }>,
): readonly string[] {
  return [...condition.condition.cases.map((item) => item.id), condition.condition.default];
}

function branchMembership(
  nodes: readonly SourceNode[],
  conditionId: string,
): ReadonlyMap<string, string | "cross" | undefined> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map<string, string | "cross" | undefined>();
  const visiting = new Set<string>();

  function visit(nodeId: string): string | "cross" | undefined {
    if (memo.has(nodeId)) {
      return memo.get(nodeId);
    }
    if (visiting.has(nodeId)) {
      return "cross";
    }
    const node = nodeById.get(nodeId);
    if (node === undefined || node.id === conditionId) {
      return undefined;
    }
    if (node.type === "join" && node.join.conditionId === conditionId) {
      memo.set(nodeId, undefined);
      return undefined;
    }

    visiting.add(nodeId);
    const dependencyMemberships = sourceDependencies(node)
      .map(visit)
      .filter((value): value is string => value !== undefined);
    visiting.delete(nodeId);

    let result: string | "cross" | undefined;
    const directGuard = node.type === "join" ? undefined : node.when;
    if (directGuard?.conditionId === conditionId) {
      result = dependencyMemberships.some(
        (value) => value === "cross" || value !== directGuard.case,
      )
        ? "cross"
        : directGuard.case;
    } else if (dependencyMemberships.includes("cross")) {
      result = "cross";
    } else {
      const unique = new Set(dependencyMemberships);
      result = unique.size > 1 ? "cross" : unique.values().next().value;
    }
    memo.set(nodeId, result);
    return result;
  }

  for (const node of nodes) {
    visit(node.id);
  }
  return memo;
}

function isAncestor(
  ancestorId: string,
  nodeId: string,
  nodeById: ReadonlyMap<string, SourceNode>,
  visited = new Set<string>(),
): boolean {
  if (visited.has(nodeId)) {
    return false;
  }
  visited.add(nodeId);
  const node = nodeById.get(nodeId);
  if (node === undefined) {
    return false;
  }
  return sourceDependencies(node).some(
    (dependency) =>
      dependency === ancestorId || isAncestor(ancestorId, dependency, nodeById, visited),
  );
}

function findCycle(nodes: WorkflowSource["nodes"]): readonly string[] | undefined {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  function visit(nodeId: string): readonly string[] | undefined {
    if (visiting.has(nodeId)) {
      const cycleStart = stack.indexOf(nodeId);
      return [...stack.slice(cycleStart), nodeId];
    }
    if (visited.has(nodeId)) {
      return undefined;
    }

    const node = nodeById.get(nodeId);
    if (node === undefined) {
      return undefined;
    }

    visiting.add(nodeId);
    stack.push(nodeId);
    for (const dependency of sourceDependencies(node)) {
      const cycle = visit(dependency);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
    return undefined;
  }

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle !== undefined) {
      return cycle;
    }
  }
  return undefined;
}

function freezeWorkflow(source: WorkflowSource): CompiledWorkflow {
  const nodes = Object.freeze(source.nodes.map(freezeNode));
  const workflow: CompiledWorkflow = {
    apiVersion: source.apiVersion,
    id: source.metadata.id,
    ...(source.metadata.description === undefined
      ? {}
      : { description: source.metadata.description }),
    ...(source.goal === undefined ? {} : { goal: freezeGoal(source.goal) }),
    ...(source.budget === undefined ? {} : { budget: freezeBudget(source.budget) }),
    ...(source.concurrency === undefined
      ? {}
      : { concurrency: freezeConcurrency(source.concurrency) }),
    nodes,
  };
  return Object.freeze(workflow);
}

function freezeConcurrency(
  source: NonNullable<WorkflowSource["concurrency"]>,
): CompiledWorkflowConcurrency {
  return Object.freeze({ maxNodes: source.maxNodes });
}

function freezeBudget(source: NonNullable<WorkflowSource["budget"]>): CompiledRunBudget {
  return Object.freeze({
    ...(source.maxNodeStarts === undefined ? {} : { maxNodeStarts: source.maxNodeStarts }),
    ...(source.maxModelTokens === undefined ? {} : { maxModelTokens: source.maxModelTokens }),
    ...(source.maxCostUsd === undefined
      ? {}
      : { maxCostUsdMicros: Math.round(source.maxCostUsd * 1_000_000) }),
    ...(source.maxExecutionMs === undefined ? {} : { maxExecutionMs: source.maxExecutionMs }),
  });
}

function freezeGoal(source: GoalContractSource): CompiledGoal {
  return Object.freeze({
    apiVersion: source.apiVersion,
    id: source.metadata.id,
    outcome: source.outcome,
    criteria: Object.freeze(
      source.criteria.map((criterion) =>
        Object.freeze({
          id: criterion.id,
          description: criterion.description,
          verifierNodeId: criterion.verifier.nodeId,
        }),
      ),
    ),
  });
}

function freezeNode(source: WorkflowSource["nodes"][number]): CompiledNode {
  const dependsOn = Object.freeze([...sourceDependencies(source)]);
  if (source.type === "command") {
    const node: CompiledCommandNode = {
      id: source.id,
      type: "command",
      dependsOn,
      ...(source.when === undefined ? {} : { when: Object.freeze({ ...source.when }) }),
      ...(source.approval === undefined ? {} : { approval: Object.freeze({ ...source.approval }) }),
      command: Object.freeze({
        executable: source.command.executable,
        args: Object.freeze([...source.command.args]),
        timeoutMs: source.command.timeoutMs,
      }),
    };
    return Object.freeze(node);
  }

  if (source.type === "agent") {
    const node: CompiledAgentNode = {
      id: source.id,
      type: "agent",
      dependsOn,
      ...(source.when === undefined ? {} : { when: Object.freeze({ ...source.when }) }),
      agent: Object.freeze({
        prompt: source.agent.prompt,
        model: Object.freeze({ ...source.agent.model }),
        tools: Object.freeze([...source.agent.tools]),
        ...(source.agent.recovery === undefined
          ? {}
          : { recovery: Object.freeze({ ...source.agent.recovery }) }),
        timeoutMs: source.agent.timeoutMs,
      }),
    };
    return Object.freeze(node);
  }

  if (source.type === "condition") {
    const node: CompiledConditionNode = {
      id: source.id,
      type: "condition",
      dependsOn,
      ...(source.when === undefined ? {} : { when: Object.freeze({ ...source.when }) }),
      condition: Object.freeze({
        source: Object.freeze({ ...source.condition.source }),
        cases: Object.freeze(source.condition.cases.map((item) => Object.freeze({ ...item }))),
        default: source.condition.default,
      }),
    };
    return Object.freeze(node);
  }

  const node: CompiledJoinNode = {
    id: source.id,
    type: "join",
    dependsOn,
    join: Object.freeze({
      conditionId: source.join.conditionId,
      branches: Object.freeze(source.join.branches.map((branch) => Object.freeze({ ...branch }))),
    }),
  };
  return Object.freeze(node);
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "$" : path.map(String).join(".");
}
