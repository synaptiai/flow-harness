import { parseDocument } from "yaml";

import type { GoalContractSource } from "../goal/schema.js";
import type { CompiledGoal } from "../goal/types.js";
import { projectCompiledControlGraph, workflowRequiresControlGraph } from "./control-graph.js";
import { workflowSourceSchema, type WorkflowSource } from "./schema.js";
import {
  MAX_CONTROL_GRAPH_SERIALIZED_BYTES,
  MAX_COMPILED_WORKFLOW_NODES,
  type CompiledAgentNode,
  type CompiledApprovalNode,
  type CompiledCommandNode,
  type CompiledConditionNode,
  type CompiledJoinNode,
  type CompiledLoopCheckNode,
  type CompiledLoopNode,
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
    | "approval_source_field_mismatch"
    | "approval_source_requires_dependency"
    | "approval_source_self"
    | "approval_source_unknown"
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
    | "loop_body_entry_count"
    | "loop_expansion_too_large"
    | "loop_instance_id_collision"
    | "loop_instance_id_too_long"
    | "loop_source_field_mismatch"
    | "loop_source_not_unconditional"
    | "loop_source_unknown"
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

  const workflow = freezeWorkflow(result.data);
  if (
    workflowRequiresControlGraph(workflow) &&
    Buffer.byteLength(JSON.stringify(projectCompiledControlGraph(workflow)), "utf8") >
      MAX_CONTROL_GRAPH_SERIALIZED_BYTES
  ) {
    throw new WorkflowCompilationError(
      sourceName,
      Object.freeze([
        {
          code: "control_graph_too_large",
          path: "nodes",
          message: `serialized control graph must not exceed ${MAX_CONTROL_GRAPH_SERIALIZED_BYTES} UTF-8 bytes`,
        },
      ]),
    );
  }
  return workflow;
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
  validateLoops(workflow, diagnostics);

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
type SourceLoopNode = Extract<SourceNode, { readonly type: "loop" }>;
type SourceBodyNode = SourceLoopNode["loop"]["body"]["nodes"][number];

function sourceDependencies(node: SourceNode): readonly string[] {
  return node.type === "join" ? node.join.branches.map((branch) => branch.nodeId) : node.dependsOn;
}

function dependencyPath(node: SourceNode, nodeIndex: number, dependencyIndex: number): string {
  return node.type === "join"
    ? `nodes.${nodeIndex}.join.branches.${dependencyIndex}.nodeId`
    : `nodes.${nodeIndex}.dependsOn.${dependencyIndex}`;
}

function validateLoops(workflow: WorkflowSource, diagnostics: WorkflowDiagnostic[]): void {
  const topLevelIds = new Set(workflow.nodes.map((node) => node.id));
  const compiledIds = new Set(topLevelIds);
  let compiledNodeCount = workflow.nodes.length;

  for (const [loopIndex, node] of workflow.nodes.entries()) {
    if (node.type !== "loop") {
      continue;
    }

    const prefix = `nodes.${loopIndex}.loop.body.nodes`;
    const bodyNodes = node.loop.body.nodes;
    validateLoopBodyGraph(bodyNodes, prefix, diagnostics);
    validateLoopSource(node, loopIndex, diagnostics);

    compiledNodeCount += node.loop.maxIterations * (bodyNodes.length + 1);
    for (let iteration = 1; iteration <= node.loop.maxIterations; iteration += 1) {
      const generatedIds = [
        ...bodyNodes.map((bodyNode) => loopBodyNodeId(node.id, iteration, bodyNode.id)),
        loopCheckNodeId(node.id, iteration),
      ];
      for (const generatedId of generatedIds) {
        if (generatedId.length > 128) {
          diagnostics.push({
            code: "loop_instance_id_too_long",
            path: `nodes.${loopIndex}.id`,
            message: `loop "${node.id}" generates durable node id "${generatedId}" longer than 128 characters`,
          });
        }
        if (compiledIds.has(generatedId)) {
          diagnostics.push({
            code: "loop_instance_id_collision",
            path: `nodes.${loopIndex}.id`,
            message: `loop "${node.id}" generates duplicate durable node id "${generatedId}"`,
          });
        }
        compiledIds.add(generatedId);
      }
    }
  }

  if (compiledNodeCount > MAX_COMPILED_WORKFLOW_NODES) {
    diagnostics.push({
      code: "loop_expansion_too_large",
      path: "nodes",
      message: `compiled workflow must not exceed ${MAX_COMPILED_WORKFLOW_NODES} nodes; loop expansion produces ${compiledNodeCount}`,
    });
  }
}

function validateLoopBodyGraph(
  nodes: readonly SourceBodyNode[],
  prefix: string,
  diagnostics: WorkflowDiagnostic[],
): void {
  const firstIndexById = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    const previousIndex = firstIndexById.get(node.id);
    if (previousIndex === undefined) {
      firstIndexById.set(node.id, index);
    } else {
      diagnostics.push({
        code: "duplicate_node",
        path: `${prefix}.${index}.id`,
        message: `node id "${node.id}" duplicates ${prefix}.${previousIndex}.id`,
      });
    }
  }

  for (const [nodeIndex, node] of nodes.entries()) {
    const seenDependencies = new Set<string>();
    for (const [dependencyIndex, dependency] of sourceDependencies(node).entries()) {
      const path = dependencyPathAt(node, prefix, nodeIndex, dependencyIndex);
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
          message: `node "${node.id}" depends on unknown local node "${dependency}"`,
        });
      }
      seenDependencies.add(dependency);
    }
  }

  const entries = nodes.filter((node) => sourceDependencies(node).length === 0);
  if (entries.length !== 1) {
    diagnostics.push({
      code: "loop_body_entry_count",
      path: prefix,
      message: `loop body must contain exactly one entry node; found ${entries.length}`,
    });
  }

  validateControlFlowNodes(nodes, diagnostics, prefix);
  const cycle = findCycle(nodes);
  if (cycle !== undefined) {
    diagnostics.push({
      code: "cycle",
      path: prefix,
      message: `loop body contains a dependency cycle: ${cycle.join(" -> ")}`,
    });
  }
}

function validateLoopSource(
  loop: SourceLoopNode,
  loopIndex: number,
  diagnostics: WorkflowDiagnostic[],
): void {
  const bodyNodes = loop.loop.body.nodes;
  const sourcePath = `nodes.${loopIndex}.loop.until.source`;
  const source = bodyNodes.find((node) => node.id === loop.loop.until.source.nodeId);
  if (source === undefined) {
    diagnostics.push({
      code: "loop_source_unknown",
      path: `${sourcePath}.nodeId`,
      message: `loop "${loop.id}" references unknown local source node "${loop.loop.until.source.nodeId}"`,
    });
    return;
  }

  const field = loop.loop.until.source.field;
  const compatible =
    (field.startsWith("command.") && source.type === "command") ||
    (field === "agent.text" && source.type === "agent");
  if (!compatible) {
    diagnostics.push({
      code: "loop_source_field_mismatch",
      path: `${sourcePath}.field`,
      message: `loop "${loop.id}" source field "${field}" is incompatible with local node "${source.id}" of type "${source.type}"`,
    });
  }

  const conditions = bodyNodes.filter(
    (node): node is Extract<SourceBodyNode, { readonly type: "condition" }> =>
      node.type === "condition",
  );
  const insideConditionalBranch = conditions.some(
    (condition) => branchMembership(bodyNodes, condition.id).get(source.id) !== undefined,
  );
  const dependedUpon = new Set(bodyNodes.flatMap(sourceDependencies));
  const terminals = bodyNodes.filter((node) => !dependedUpon.has(node.id));
  const notAwaitedByEveryTerminal = terminals.some(
    (terminal) =>
      terminal.id !== source.id && !isAncestor(source.id, terminal.id, nodeMap(bodyNodes)),
  );
  if (insideConditionalBranch || notAwaitedByEveryTerminal) {
    diagnostics.push({
      code: "loop_source_not_unconditional",
      path: `${sourcePath}.nodeId`,
      message: `loop "${loop.id}" source "${source.id}" must execute and be awaited on every successful body path`,
    });
  }
}

function dependencyPathAt(
  node: SourceBodyNode,
  prefix: string,
  nodeIndex: number,
  dependencyIndex: number,
): string {
  return node.type === "join"
    ? `${prefix}.${nodeIndex}.join.branches.${dependencyIndex}.nodeId`
    : `${prefix}.${nodeIndex}.dependsOn.${dependencyIndex}`;
}

function nodeMap<T extends SourceNode | SourceBodyNode>(
  nodes: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function loopBodyNodeId(loopId: string, iteration: number, nodeId: string): string {
  return `${loopId}--i${iteration}--node--${nodeId}`;
}

function loopCheckNodeId(loopId: string, iteration: number): string {
  return `${loopId}--i${iteration}--check`;
}

function validateControlFlow(workflow: WorkflowSource, diagnostics: WorkflowDiagnostic[]): void {
  validateControlFlowNodes(workflow.nodes, diagnostics, "nodes");
}

function validateControlFlowNodes<T extends SourceNode | SourceBodyNode>(
  nodes: readonly T[],
  diagnostics: WorkflowDiagnostic[],
  prefix: string,
): void {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const conditions = nodes.filter(
    (node): node is Extract<T, { readonly type: "condition" }> => node.type === "condition",
  );
  const joins = nodes.filter(
    (node): node is Extract<T, { readonly type: "join" }> => node.type === "join",
  );

  if (
    conditions.length > 0 &&
    Buffer.byteLength(JSON.stringify(sourceControlGraph(nodes)), "utf8") >
      MAX_CONTROL_GRAPH_SERIALIZED_BYTES
  ) {
    diagnostics.push({
      code: "control_graph_too_large",
      path: prefix,
      message: `serialized control graph must not exceed ${MAX_CONTROL_GRAPH_SERIALIZED_BYTES} UTF-8 bytes`,
    });
  }

  for (const condition of conditions) {
    const index = indexById.get(condition.id) ?? 0;
    const source = nodeById.get(condition.condition.source.nodeId);
    if (source === undefined) {
      diagnostics.push({
        code: "condition_source_unknown",
        path: `${prefix}.${index}.condition.source.nodeId`,
        message: `condition "${condition.id}" references unknown source node "${condition.condition.source.nodeId}"`,
      });
    } else {
      if (!condition.dependsOn.includes(source.id)) {
        diagnostics.push({
          code: "condition_source_requires_dependency",
          path: `${prefix}.${index}.condition.source.nodeId`,
          message: `condition "${condition.id}" source "${source.id}" must be a direct dependency`,
        });
      }
      const fieldMatches =
        (condition.condition.source.field.startsWith("command.") && source.type === "command") ||
        (condition.condition.source.field === "agent.text" && source.type === "agent");
      if (!fieldMatches) {
        diagnostics.push({
          code: "condition_source_field_mismatch",
          path: `${prefix}.${index}.condition.source.field`,
          message: `condition "${condition.id}" source field "${condition.condition.source.field}" is incompatible with node "${source.id}" of type "${source.type}"`,
        });
      }
    }
  }

  for (const [index, approval] of nodes.entries()) {
    if (approval.type !== "approval") {
      continue;
    }
    for (const [sourceIndex, declaration] of approval.approval.evidence.entries()) {
      const path = `${prefix}.${index}.approval.evidence.${sourceIndex}`;
      const source = nodeById.get(declaration.nodeId);
      if (declaration.nodeId === approval.id) {
        diagnostics.push({
          code: "approval_source_self",
          path: `${path}.nodeId`,
          message: `approval "${approval.id}" cannot review its own evidence`,
        });
        continue;
      }
      if (source === undefined) {
        diagnostics.push({
          code: "approval_source_unknown",
          path: `${path}.nodeId`,
          message: `approval "${approval.id}" references unknown evidence node "${declaration.nodeId}"`,
        });
        continue;
      }
      if (!approval.dependsOn.includes(source.id)) {
        diagnostics.push({
          code: "approval_source_requires_dependency",
          path: `${path}.nodeId`,
          message: `approval "${approval.id}" evidence source "${source.id}" must be a direct dependency`,
        });
      }
      const compatible =
        (declaration.field.startsWith("command.") && source.type === "command") ||
        (declaration.field === "agent.text" && source.type === "agent");
      if (!compatible) {
        diagnostics.push({
          code: "approval_source_field_mismatch",
          path: `${path}.field`,
          message: `approval "${approval.id}" evidence field "${declaration.field}" is incompatible with node "${source.id}" of type "${source.type}"`,
        });
      }
    }
  }

  for (const [index, node] of nodes.entries()) {
    if (node.type === "join" || node.type === "loop" || node.when === undefined) {
      continue;
    }
    const condition = nodeById.get(node.when.conditionId);
    if (condition?.type !== "condition") {
      diagnostics.push({
        code: "branch_guard_requires_condition",
        path: `${prefix}.${index}.when.conditionId`,
        message: `node "${node.id}" guard must reference a condition node`,
      });
      continue;
    }
    if (!node.dependsOn.includes(condition.id)) {
      diagnostics.push({
        code: "branch_guard_requires_dependency",
        path: `${prefix}.${index}.when.conditionId`,
        message: `node "${node.id}" must directly depend on guarded condition "${condition.id}"`,
      });
    }
    if (!conditionCases(condition).includes(node.when.case)) {
      diagnostics.push({
        code: "branch_guard_unknown_case",
        path: `${prefix}.${index}.when.case`,
        message: `node "${node.id}" guard references unknown case "${node.when.case}"`,
      });
    }
  }

  for (const [index, join] of joins.map((node) => [indexById.get(node.id) ?? 0, node] as const)) {
    const condition = nodeById.get(join.join.conditionId);
    if (condition?.type !== "condition") {
      diagnostics.push({
        code: "join_unknown_condition",
        path: `${prefix}.${index}.join.conditionId`,
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
        path: `${prefix}.${index}.join.branches`,
        message: `join "${join.id}" must map every case of condition "${condition.id}" exactly once`,
      });
    }
    for (const [branchIndex, branch] of join.join.branches.entries()) {
      if (!nodeById.has(branch.nodeId)) {
        diagnostics.push({
          code: "join_branch_unknown_node",
          path: `${prefix}.${index}.join.branches.${branchIndex}.nodeId`,
          message: `join "${join.id}" references unknown branch terminal "${branch.nodeId}"`,
        });
      }
    }
  }

  for (const condition of conditions) {
    const conditionIndex = indexById.get(condition.id) ?? 0;
    const possibleCases = conditionCases(condition);
    for (const [caseIndex, caseId] of possibleCases.entries()) {
      const roots = nodes.filter(
        (node) =>
          node.type !== "join" &&
          node.type !== "loop" &&
          node.when?.conditionId === condition.id &&
          node.when.case === caseId,
      );
      if (roots.length === 0) {
        diagnostics.push({
          code: "condition_case_requires_branch",
          path:
            caseIndex < condition.condition.cases.length
              ? `${prefix}.${conditionIndex}.condition.cases.${caseIndex}.id`
              : `${prefix}.${conditionIndex}.condition.default`,
          message: `condition "${condition.id}" case "${caseId}" has no guarded branch`,
        });
      }
    }

    const matchingJoins = joins.filter((join) => join.join.conditionId === condition.id);
    if (matchingJoins.length !== 1) {
      diagnostics.push({
        code: "condition_join_count",
        path: `${prefix}.${conditionIndex}.condition`,
        message: `condition "${condition.id}" must have exactly one join; found ${matchingJoins.length}`,
      });
      continue;
    }

    const membership = branchMembership(nodes, condition.id);
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
            ? `${prefix}.${nodeIndex}.join.branches`
            : `${prefix}.${nodeIndex}.dependsOn`,
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
          path: `${prefix}.${joinIndex}.join.branches.${branchIndex}.nodeId`,
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
          path: `${prefix}.${joinIndex}.join.branches.${branchIndex}.nodeId`,
          message: `join "${join.id}" terminal "${branch.nodeId}" does not wait for every node in case "${branch.case}"`,
        });
      }
    }
  }
}

function sourceControlGraph<T extends SourceNode | SourceBodyNode>(nodes: readonly T[]): object {
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
      if (node.type === "approval") {
        return {
          nodeId: node.id,
          type: node.type,
          dependsOn: node.dependsOn,
          ...(node.when === undefined ? {} : { when: node.when }),
          approval: node.approval,
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
      if (node.type === "loop") {
        return {
          nodeId: node.id,
          type: node.type,
          dependsOn: node.dependsOn,
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
  condition: Extract<SourceNode | SourceBodyNode, { readonly type: "condition" }>,
): readonly string[] {
  return [...condition.condition.cases.map((item) => item.id), condition.condition.default];
}

function branchMembership(
  nodes: readonly (SourceNode | SourceBodyNode)[],
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
    const directGuard = node.type === "join" || node.type === "loop" ? undefined : node.when;
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
  nodeById: ReadonlyMap<string, SourceNode | SourceBodyNode>,
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

function findCycle(nodes: readonly (SourceNode | SourceBodyNode)[]): readonly string[] | undefined {
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
  const nodes = Object.freeze(
    source.nodes.flatMap((node) => (node.type === "loop" ? freezeLoop(node) : [freezeNode(node)])),
  );
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

function freezeNode(source: Exclude<SourceNode, SourceLoopNode> | SourceBodyNode): CompiledNode {
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

  if (source.type === "approval") {
    const node: CompiledApprovalNode = {
      id: source.id,
      type: "approval",
      dependsOn,
      ...(source.when === undefined ? {} : { when: Object.freeze({ ...source.when }) }),
      approval: Object.freeze({
        prompt: source.approval.prompt,
        evidence: Object.freeze(source.approval.evidence.map((item) => Object.freeze({ ...item }))),
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

function freezeLoop(source: SourceLoopNode): readonly CompiledNode[] {
  const bodyNodes = source.loop.body.nodes;
  const entry = bodyNodes.find((node) => sourceDependencies(node).length === 0);
  if (entry === undefined) {
    throw new Error(`validated loop "${source.id}" has no body entry`);
  }
  const dependedUpon = new Set(bodyNodes.flatMap(sourceDependencies));
  const terminals = bodyNodes.filter((node) => !dependedUpon.has(node.id));
  const expanded: CompiledNode[] = [];
  const checkNodeIds: string[] = [];

  for (let iteration = 1; iteration <= source.loop.maxIterations; iteration += 1) {
    const idByTemplate = new Map(
      bodyNodes.map((node) => [node.id, loopBodyNodeId(source.id, iteration, node.id)]),
    );
    const priorCheckNodeId =
      iteration === 1 ? undefined : loopCheckNodeId(source.id, iteration - 1);
    for (const bodyNode of bodyNodes) {
      expanded.push(
        freezeLoopBodyNode(source, bodyNode, entry.id, iteration, idByTemplate, priorCheckNodeId),
      );
    }

    const checkNodeId = loopCheckNodeId(source.id, iteration);
    const sourceNodeId = requireMappedLoopNode(
      idByTemplate,
      source.loop.until.source.nodeId,
      source.id,
    );
    const terminalIds = terminals.map((node) =>
      requireMappedLoopNode(idByTemplate, node.id, source.id),
    );
    const checkDependsOn = Object.freeze(
      terminalIds.includes(sourceNodeId) ? terminalIds : [...terminalIds, sourceNodeId],
    );
    const check: CompiledLoopCheckNode = {
      id: checkNodeId,
      type: "loop-check",
      dependsOn: checkDependsOn,
      loopCheck: Object.freeze({
        loopId: source.id,
        iteration,
        source: Object.freeze({
          nodeId: sourceNodeId,
          field: source.loop.until.source.field,
        }),
        equals: source.loop.until.equals,
      }),
    };
    expanded.push(Object.freeze(check));
    checkNodeIds.push(checkNodeId);
  }

  const controller: CompiledLoopNode = {
    id: source.id,
    type: "loop",
    dependsOn: Object.freeze([...checkNodeIds]),
    loop: Object.freeze({
      maxIterations: source.loop.maxIterations,
      checkNodeIds: Object.freeze([...checkNodeIds]),
    }),
  };
  expanded.push(Object.freeze(controller));
  return expanded;
}

function freezeLoopBodyNode(
  loop: SourceLoopNode,
  source: SourceBodyNode,
  entryNodeId: string,
  iteration: number,
  idByTemplate: ReadonlyMap<string, string>,
  priorCheckNodeId: string | undefined,
): CompiledNode {
  const id = requireMappedLoopNode(idByTemplate, source.id, loop.id);
  const isEntry = source.id === entryNodeId;
  const dependsOn = Object.freeze(
    isEntry
      ? iteration === 1
        ? [...loop.dependsOn]
        : [requirePriorLoopCheck(priorCheckNodeId, loop.id, iteration)]
      : sourceDependencies(source).map((dependency) =>
          requireMappedLoopNode(idByTemplate, dependency, loop.id),
        ),
  );
  const loopInstance = Object.freeze({
    loopId: loop.id,
    iteration,
    templateNodeId: source.id,
  });
  const loopGuard =
    isEntry && iteration > 1
      ? Object.freeze({
          loopId: loop.id,
          iteration,
          checkNodeId: requirePriorLoopCheck(priorCheckNodeId, loop.id, iteration),
        })
      : undefined;
  const when =
    source.type !== "join" && source.when !== undefined
      ? Object.freeze({
          conditionId: requireMappedLoopNode(idByTemplate, source.when.conditionId, loop.id),
          case: source.when.case,
        })
      : undefined;
  const common = {
    id,
    dependsOn,
    loopInstance,
    ...(loopGuard === undefined ? {} : { loopGuard }),
  };

  if (source.type === "command") {
    const node: CompiledCommandNode = {
      ...common,
      type: "command",
      ...(when === undefined ? {} : { when }),
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
      ...common,
      type: "agent",
      ...(when === undefined ? {} : { when }),
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
      ...common,
      type: "condition",
      ...(when === undefined ? {} : { when }),
      condition: Object.freeze({
        source: Object.freeze({
          nodeId: requireMappedLoopNode(idByTemplate, source.condition.source.nodeId, loop.id),
          field: source.condition.source.field,
        }),
        cases: Object.freeze(source.condition.cases.map((item) => Object.freeze({ ...item }))),
        default: source.condition.default,
      }),
    };
    return Object.freeze(node);
  }

  if (source.type === "approval") {
    const node: CompiledApprovalNode = {
      ...common,
      type: "approval",
      ...(when === undefined ? {} : { when }),
      approval: Object.freeze({
        prompt: source.approval.prompt,
        evidence: Object.freeze(
          source.approval.evidence.map((item) =>
            Object.freeze({
              nodeId: requireMappedLoopNode(idByTemplate, item.nodeId, loop.id),
              field: item.field,
            }),
          ),
        ),
      }),
    };
    return Object.freeze(node);
  }

  const node: CompiledJoinNode = {
    ...common,
    type: "join",
    join: Object.freeze({
      conditionId: requireMappedLoopNode(idByTemplate, source.join.conditionId, loop.id),
      branches: Object.freeze(
        source.join.branches.map((branch) =>
          Object.freeze({
            case: branch.case,
            nodeId: requireMappedLoopNode(idByTemplate, branch.nodeId, loop.id),
          }),
        ),
      ),
    }),
  };
  return Object.freeze(node);
}

function requireMappedLoopNode(
  idByTemplate: ReadonlyMap<string, string>,
  templateNodeId: string,
  loopId: string,
): string {
  const nodeId = idByTemplate.get(templateNodeId);
  if (nodeId === undefined) {
    throw new Error(`validated loop "${loopId}" references unknown body node "${templateNodeId}"`);
  }
  return nodeId;
}

function requirePriorLoopCheck(
  priorCheckNodeId: string | undefined,
  loopId: string,
  iteration: number,
): string {
  if (priorCheckNodeId === undefined) {
    throw new Error(`validated loop "${loopId}" iteration ${iteration} has no prior check`);
  }
  return priorCheckNodeId;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "$" : path.map(String).join(".");
}
