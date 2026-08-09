import { parseDocument } from "yaml";

import {
  workflowPackageNameSchema,
  workflowPackageVersionSchema,
} from "../capability/workflow-packages.js";
import type { GoalContractSource } from "../goal/schema.js";
import type { CompiledGoal } from "../goal/types.js";
import {
  OptimizationResultError,
  resolveOptimizationPointerSchema,
} from "../result/optimization-result.js";
import { calculateResultSchemaDigest, evaluateTypedResult } from "../result/typed-result.js";
import { projectCompiledControlGraph, workflowRequiresControlGraph } from "./control-graph.js";
import { calculateWorkflowDigest } from "./digest.js";
import { type WorkflowSource, workflowSourceSchema } from "./schema.js";
import {
  type CompiledAgentNode,
  type CompiledApprovalNode,
  type CompiledChildNode,
  type CompiledCommandNode,
  type CompiledConditionNode,
  type CompiledJoinNode,
  type CompiledLoopCheckNode,
  type CompiledLoopNode,
  type CompiledNode,
  type CompiledOptimizationCheckNode,
  type CompiledOptimizationNode,
  type CompiledResultNode,
  type CompiledResultSchema,
  type CompiledRunBudget,
  type CompiledVerifierNode,
  type CompiledWorkflow,
  type CompiledWorkflowConcurrency,
  type CompiledWorkflowPackageReference,
  MAX_CHILD_WORKFLOW_DEPTH,
  MAX_CHILD_WORKFLOW_SOURCE_BYTES,
  MAX_COMPILED_WORKFLOW_NODES,
  MAX_CONTROL_GRAPH_SERIALIZED_BYTES,
  MAX_RUN_TREE_NODES,
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
    | "child_budget_required"
    | "child_depth_exceeded"
    | "child_result_not_terminal"
    | "child_result_not_unconditional"
    | "child_tree_too_large"
    | "child_wait_unsupported"
    | "workflow_package_cycle"
    | "workflow_package_unresolved"
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
    | "optimization_barrier_unordered"
    | "optimization_baseline_not_unconditional"
    | "optimization_baseline_requires_dependency"
    | "optimization_baseline_requires_result"
    | "optimization_baseline_unknown"
    | "optimization_evaluator_not_deterministic"
    | "optimization_expansion_too_large"
    | "optimization_instance_id_collision"
    | "optimization_instance_id_too_long"
    | "optimization_invariant_mismatch"
    | "optimization_invariant_not_scalar"
    | "optimization_metric_not_numeric"
    | "optimization_nested_unsupported"
    | "optimization_pointer_invalid"
    | "optimization_pointer_unresolved"
    | "optimization_schema_mismatch"
    | "result_source_field_mismatch"
    | "result_source_requires_dependency"
    | "result_source_self"
    | "result_source_unknown"
    | "self_dependency"
    | "terminal_requires_command"
    | "unknown_criterion_verifier"
    | "unknown_dependency"
    | "verifier_source_field_mismatch"
    | "verifier_source_requires_dependency"
    | "verifier_source_self"
    | "verifier_source_unknown";
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

export interface WorkflowPackageReference {
  readonly name: string;
  readonly version: string;
}

export interface ResolvedWorkflowPackage extends WorkflowPackageReference {
  readonly digest: string;
  readonly source: string;
}

export interface WorkflowPackageResolver {
  resolve(reference: WorkflowPackageReference): ResolvedWorkflowPackage;
}

export interface CompileWorkflowOptions {
  readonly packageResolver?: WorkflowPackageResolver;
  readonly sourcePackage?: CompiledWorkflowPackageReference;
}

export function compileWorkflowText(
  source: string,
  sourceName = "workflow",
  options: CompileWorkflowOptions = {},
): CompiledWorkflow {
  const sourcePackage =
    options.sourcePackage === undefined
      ? undefined
      : freezeWorkflowPackageReference(options.sourcePackage, sourceName);
  return compileWorkflowTextInternal(source, sourceName, {
    depth: 0,
    nodeCount: { value: 0 },
    ...(options.packageResolver === undefined ? {} : { packageResolver: options.packageResolver }),
    packageStack:
      sourcePackage === undefined ? Object.freeze([]) : Object.freeze([packageKey(sourcePackage)]),
    ...(sourcePackage === undefined ? {} : { sourcePackage }),
  });
}

interface CompilationContext {
  readonly depth: number;
  readonly nodeCount: { value: number };
  readonly packageResolver?: WorkflowPackageResolver;
  readonly packageStack: readonly string[];
  readonly sourcePackage?: CompiledWorkflowPackageReference;
}

function compileWorkflowTextInternal(
  source: string,
  sourceName: string,
  context: CompilationContext,
): CompiledWorkflow {
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

  if (context.depth > 0 && result.data.nodes.some((node) => node.type === "optimization")) {
    throw new WorkflowCompilationError(
      sourceName,
      Object.freeze([
        {
          code: "optimization_nested_unsupported",
          path: "nodes",
          message: "optimization nodes are only supported in the root workflow",
        },
      ]),
    );
  }

  const diagnostics = validateGraph(result.data);
  if (diagnostics.length > 0) {
    throw new WorkflowCompilationError(sourceName, Object.freeze(diagnostics));
  }

  const workflow = freezeWorkflow(result.data, context);
  context.nodeCount.value += workflow.nodes.length;
  if (context.nodeCount.value > MAX_RUN_TREE_NODES) {
    throw new WorkflowCompilationError(
      sourceName,
      Object.freeze([
        {
          code: "child_tree_too_large",
          path: "nodes",
          message: `compiled run tree must not exceed ${MAX_RUN_TREE_NODES} nodes`,
        },
      ]),
    );
  }
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
    if (
      !dependedUpon.has(node.id) &&
      node.type !== "command" &&
      node.type !== "verifier" &&
      node.type !== "result" &&
      node.type !== "child" &&
      node.type !== "optimization"
    ) {
      diagnostics.push({
        code: "terminal_requires_command",
        path: `nodes.${index}.type`,
        message: `terminal node "${node.id}" must be a command, child, verifier, or result node`,
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
      if (verifier.type !== "command" && verifier.type !== "verifier") {
        diagnostics.push({
          code: "criterion_verifier_requires_command",
          path: verifierPath,
          message: `criterion "${criterion.id}" verifier "${verifier.id}" must be a command or verifier node`,
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
  validateOptimizations(workflow, diagnostics);

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
type SourceOptimizationNode = Extract<SourceNode, { readonly type: "optimization" }>;
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

function validateOptimizations(workflow: WorkflowSource, diagnostics: WorkflowDiagnostic[]): void {
  const optimizations = workflow.nodes.filter(
    (node): node is SourceOptimizationNode => node.type === "optimization",
  );
  if (optimizations.length === 0) {
    return;
  }

  const nodesById = nodeMap(workflow.nodes);
  const compiledIds = new Set(workflow.nodes.map((node) => node.id));
  const expandedNodeCount =
    workflow.nodes.length +
    workflow.nodes.reduce(
      (count, node) =>
        count +
        (node.type === "loop"
          ? node.loop.maxIterations * (node.loop.body.nodes.length + 1)
          : node.type === "optimization"
            ? node.optimization.maxCandidates * 2
            : 0),
      0,
    );
  if (expandedNodeCount > MAX_COMPILED_WORKFLOW_NODES) {
    diagnostics.push({
      code: "optimization_expansion_too_large",
      path: "nodes",
      message: `compiled workflow must not exceed ${MAX_COMPILED_WORKFLOW_NODES} nodes; bounded expansion produces ${expandedNodeCount}`,
    });
  }

  for (const optimization of optimizations) {
    const optimizationIndex = workflow.nodes.indexOf(optimization);
    const prefix = `nodes.${optimizationIndex}.optimization`;
    validateOptimizationBaseline(optimization, optimizationIndex, workflow, diagnostics);

    for (const [otherIndex, other] of workflow.nodes.entries()) {
      if (other.id === optimization.id) {
        continue;
      }
      const ordered =
        isAncestor(other.id, optimization.id, nodesById) ||
        isAncestor(optimization.id, other.id, nodesById);
      if (!ordered) {
        diagnostics.push({
          code: "optimization_barrier_unordered",
          path: `nodes.${otherIndex}.dependsOn`,
          message: `node "${other.id}" must be ordered before or after optimization "${optimization.id}"`,
        });
      }
    }

    for (let candidate = 1; candidate <= optimization.optimization.maxCandidates; candidate += 1) {
      for (const generatedId of [
        optimizationCandidateNodeId(optimization.id, candidate),
        optimizationCheckNodeId(optimization.id, candidate),
      ]) {
        if (generatedId.length > 128) {
          diagnostics.push({
            code: "optimization_instance_id_too_long",
            path: `nodes.${optimizationIndex}.id`,
            message: `optimization "${optimization.id}" generates durable node id "${generatedId}" longer than 128 characters`,
          });
        }
        if (compiledIds.has(generatedId)) {
          diagnostics.push({
            code: "optimization_instance_id_collision",
            path: `nodes.${optimizationIndex}.id`,
            message: `optimization "${optimization.id}" generates duplicate durable node id "${generatedId}"`,
          });
        }
        compiledIds.add(generatedId);
      }
    }

    const baseline = workflow.nodes.find(
      (node): node is Extract<SourceNode, { readonly type: "result" }> =>
        node.id === optimization.optimization.baseline.nodeId && node.type === "result",
    );
    if (baseline === undefined) {
      continue;
    }
    validateOptimizationPointers(optimization, baseline.result.schema, prefix, diagnostics);
  }
}

function validateOptimizationBaseline(
  optimization: SourceOptimizationNode,
  optimizationIndex: number,
  workflow: WorkflowSource,
  diagnostics: WorkflowDiagnostic[],
): void {
  const baselinePath = `nodes.${optimizationIndex}.optimization.baseline.nodeId`;
  const baseline = workflow.nodes.find(
    (node) => node.id === optimization.optimization.baseline.nodeId,
  );
  if (baseline === undefined) {
    diagnostics.push({
      code: "optimization_baseline_unknown",
      path: baselinePath,
      message: `optimization "${optimization.id}" references unknown baseline result "${optimization.optimization.baseline.nodeId}"`,
    });
    return;
  }
  if (baseline.type !== "result") {
    diagnostics.push({
      code: "optimization_baseline_requires_result",
      path: baselinePath,
      message: `optimization "${optimization.id}" baseline "${baseline.id}" must be a result node`,
    });
    return;
  }
  if (!optimization.dependsOn.includes(baseline.id)) {
    diagnostics.push({
      code: "optimization_baseline_requires_dependency",
      path: baselinePath,
      message: `optimization "${optimization.id}" must directly depend on baseline result "${baseline.id}"`,
    });
  }
  if (baseline.when !== undefined) {
    diagnostics.push({
      code: "optimization_baseline_not_unconditional",
      path: baselinePath,
      message: `optimization "${optimization.id}" baseline result "${baseline.id}" must be unconditional`,
    });
  }
  const evaluator = workflow.nodes.find((node) => node.id === baseline.result.source.nodeId);
  if (
    evaluator?.type !== "command" ||
    (baseline.result.source.field !== "command.stdout" &&
      baseline.result.source.field !== "command.stderr")
  ) {
    diagnostics.push({
      code: "optimization_evaluator_not_deterministic",
      path: baselinePath,
      message: `optimization "${optimization.id}" baseline must be published directly from command evidence`,
    });
  }
}

function validateOptimizationPointers(
  optimization: SourceOptimizationNode,
  schema: CompiledResultSchema,
  prefix: string,
  diagnostics: WorkflowDiagnostic[],
): void {
  const metricPath = `${prefix}.metric.pointer`;
  try {
    const metricSchema = resolveOptimizationPointerSchema(
      schema,
      optimization.optimization.metric.pointer,
    );
    if (metricSchema.type !== "number" && metricSchema.type !== "integer") {
      diagnostics.push({
        code: "optimization_metric_not_numeric",
        path: metricPath,
        message: `optimization metric pointer ${JSON.stringify(optimization.optimization.metric.pointer)} must resolve to a number or integer schema`,
      });
    }
  } catch (error) {
    pushOptimizationPointerDiagnostic(error, metricPath, diagnostics);
  }

  for (const [index, invariant] of optimization.optimization.invariants.entries()) {
    const pointerPath = `${prefix}.invariants.${index}.pointer`;
    let invariantSchema: CompiledResultSchema;
    try {
      invariantSchema = resolveOptimizationPointerSchema(schema, invariant.pointer);
    } catch (error) {
      pushOptimizationPointerDiagnostic(error, pointerPath, diagnostics);
      continue;
    }
    if (invariantSchema.type === "array" || invariantSchema.type === "object") {
      diagnostics.push({
        code: "optimization_invariant_not_scalar",
        path: pointerPath,
        message: `optimization invariant pointer ${JSON.stringify(invariant.pointer)} must resolve to a scalar schema`,
      });
      continue;
    }
    try {
      evaluateTypedResult(JSON.stringify(invariant.equals), invariantSchema);
    } catch {
      diagnostics.push({
        code: "optimization_invariant_mismatch",
        path: `${prefix}.invariants.${index}.equals`,
        message: `optimization invariant value at ${JSON.stringify(invariant.pointer)} does not match its result schema`,
      });
    }
  }
}

function pushOptimizationPointerDiagnostic(
  error: unknown,
  path: string,
  diagnostics: WorkflowDiagnostic[],
): void {
  if (
    error instanceof OptimizationResultError &&
    (error.code === "optimization_pointer_invalid" ||
      error.code === "optimization_pointer_unresolved")
  ) {
    diagnostics.push({ code: error.code, path, message: error.message });
    return;
  }
  throw error;
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
  const compatible = evidenceFieldMatchesNode(field, source.type);
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

function optimizationCandidateNodeId(optimizationId: string, candidate: number): string {
  return `${optimizationId}--c${candidate}--candidate`;
}

function optimizationCheckNodeId(optimizationId: string, candidate: number): string {
  return `${optimizationId}--c${candidate}--check`;
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
      const fieldMatches = evidenceFieldMatchesNode(condition.condition.source.field, source.type);
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
      const compatible = evidenceFieldMatchesNode(declaration.field, source.type);
      if (!compatible) {
        diagnostics.push({
          code: "approval_source_field_mismatch",
          path: `${path}.field`,
          message: `approval "${approval.id}" evidence field "${declaration.field}" is incompatible with node "${source.id}" of type "${source.type}"`,
        });
      }
    }
  }

  for (const [index, verifier] of nodes.entries()) {
    if (
      verifier.type !== "verifier" ||
      (verifier.verifier.kind !== "model" && verifier.verifier.kind !== "packaged-model")
    ) {
      continue;
    }
    for (const [sourceIndex, declaration] of verifier.verifier.evidence.entries()) {
      const path = `${prefix}.${index}.verifier.evidence.${sourceIndex}`;
      const source = nodeById.get(declaration.nodeId);
      if (declaration.nodeId === verifier.id) {
        diagnostics.push({
          code: "verifier_source_self",
          path: `${path}.nodeId`,
          message: `verifier "${verifier.id}" cannot evaluate its own evidence`,
        });
        continue;
      }
      if (source === undefined) {
        diagnostics.push({
          code: "verifier_source_unknown",
          path: `${path}.nodeId`,
          message: `verifier "${verifier.id}" references unknown evidence node "${declaration.nodeId}"`,
        });
        continue;
      }
      if (!verifier.dependsOn.includes(source.id)) {
        diagnostics.push({
          code: "verifier_source_requires_dependency",
          path: `${path}.nodeId`,
          message: `verifier "${verifier.id}" evidence source "${source.id}" must be a direct dependency`,
        });
      }
      if (!evidenceFieldMatchesNode(declaration.field, source.type)) {
        diagnostics.push({
          code: "verifier_source_field_mismatch",
          path: `${path}.field`,
          message: `verifier "${verifier.id}" evidence field "${declaration.field}" is incompatible with node "${source.id}" of type "${source.type}"`,
        });
      }
    }
  }

  for (const [index, result] of nodes.entries()) {
    if (result.type !== "result") {
      continue;
    }
    const declaration = result.result.source;
    const path = `${prefix}.${index}.result.source`;
    const source = nodeById.get(declaration.nodeId);
    if (declaration.nodeId === result.id) {
      diagnostics.push({
        code: "result_source_self",
        path: `${path}.nodeId`,
        message: `result "${result.id}" cannot publish its own value`,
      });
      continue;
    }
    if (source === undefined) {
      diagnostics.push({
        code: "result_source_unknown",
        path: `${path}.nodeId`,
        message: `result "${result.id}" references unknown source node "${declaration.nodeId}"`,
      });
      continue;
    }
    if (!result.dependsOn.includes(source.id)) {
      diagnostics.push({
        code: "result_source_requires_dependency",
        path: `${path}.nodeId`,
        message: `result "${result.id}" source "${source.id}" must be a direct dependency`,
      });
    }
    if (!evidenceFieldMatchesNode(declaration.field, source.type)) {
      diagnostics.push({
        code: "result_source_field_mismatch",
        path: `${path}.field`,
        message: `result "${result.id}" source field "${declaration.field}" is incompatible with node "${source.id}" of type "${source.type}"`,
      });
    }
  }

  for (const [index, node] of nodes.entries()) {
    if (
      node.type === "join" ||
      node.type === "loop" ||
      node.type === "optimization" ||
      node.when === undefined
    ) {
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
          node.type !== "optimization" &&
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
      if (node.type === "verifier") {
        return {
          nodeId: node.id,
          type: node.type,
          dependsOn: node.dependsOn,
          ...(node.when === undefined ? {} : { when: node.when }),
          verifier: node.verifier,
        };
      }
      if (node.type === "result") {
        return {
          nodeId: node.id,
          type: node.type,
          dependsOn: node.dependsOn,
          ...(node.when === undefined ? {} : { when: node.when }),
          result: node.result,
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
      if (node.type === "optimization") {
        return {
          nodeId: node.id,
          type: node.type,
          dependsOn: node.dependsOn,
          optimization: node.optimization,
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

function evidenceFieldMatchesNode(
  field: string,
  nodeType: SourceNode["type"] | SourceBodyNode["type"],
): boolean {
  return (
    (field.startsWith("command.") && nodeType === "command") ||
    (field === "agent.text" && nodeType === "agent") ||
    (field.startsWith("verifier.") && nodeType === "verifier") ||
    (field === "result.value" && (nodeType === "result" || nodeType === "child"))
  );
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
    const directGuard =
      node.type === "join" || node.type === "loop" || node.type === "optimization"
        ? undefined
        : node.when;
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

function freezeWorkflow(source: WorkflowSource, context: CompilationContext): CompiledWorkflow {
  const nodes = Object.freeze(
    source.nodes.flatMap((node, index) => {
      if (node.type === "loop") {
        return freezeLoop(node, context);
      }
      if (node.type === "optimization") {
        return freezeOptimization(source, node, index, context);
      }
      return [freezeNode(node, context)];
    }),
  );
  const workflow: CompiledWorkflow = {
    apiVersion: source.apiVersion,
    id: source.metadata.id,
    ...(source.metadata.description === undefined
      ? {}
      : { description: source.metadata.description }),
    ...(context.sourcePackage === undefined ? {} : { sourcePackage: context.sourcePackage }),
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
    ...(source.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: source.maxArtifactBytes }),
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

function freezeNode(
  source: Exclude<SourceNode, SourceLoopNode | SourceOptimizationNode> | SourceBodyNode,
  context: CompilationContext,
): CompiledNode {
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
        skills: Object.freeze([...source.agent.skills]),
        toolPackages: Object.freeze(
          source.agent.toolPackages.map((item) => Object.freeze({ ...item })),
        ),
        ...(source.agent.toolApproval === undefined
          ? {}
          : {
              toolApproval: Object.freeze({
                exec: Object.freeze({ ...source.agent.toolApproval.exec }),
              }),
            }),
        ...(source.agent.recovery === undefined
          ? {}
          : { recovery: Object.freeze({ ...source.agent.recovery }) }),
        timeoutMs: source.agent.timeoutMs,
      }),
    };
    return Object.freeze(node);
  }

  if (source.type === "verifier") {
    let verifier: CompiledVerifierNode["verifier"];
    if (source.verifier.kind === "command") {
      verifier = Object.freeze({
        kind: "command" as const,
        command: Object.freeze({
          executable: source.verifier.command.executable,
          args: Object.freeze([...source.verifier.command.args]),
          timeoutMs: source.verifier.command.timeoutMs,
        }),
      });
    } else if (source.verifier.kind === "model") {
      verifier = Object.freeze({
        kind: "model" as const,
        prompt: source.verifier.prompt,
        evidence: Object.freeze(source.verifier.evidence.map((item) => Object.freeze({ ...item }))),
        model: Object.freeze({ ...source.verifier.model }),
        timeoutMs: source.verifier.timeoutMs,
      });
    } else if (source.verifier.kind === "packaged-command") {
      verifier = Object.freeze({
        kind: "packaged-command" as const,
        package: Object.freeze({ ...source.verifier.package }),
      });
    } else {
      verifier = Object.freeze({
        kind: "packaged-model" as const,
        package: Object.freeze({ ...source.verifier.package }),
        evidence: Object.freeze(source.verifier.evidence.map((item) => Object.freeze({ ...item }))),
        model: Object.freeze({ ...source.verifier.model }),
        timeoutMs: source.verifier.timeoutMs,
      });
    }
    const node: CompiledVerifierNode = {
      id: source.id,
      type: "verifier",
      dependsOn,
      ...(source.when === undefined ? {} : { when: Object.freeze({ ...source.when }) }),
      verifier,
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

  if (source.type === "result") {
    return freezeResultNode({
      id: source.id,
      dependsOn,
      ...(source.when === undefined ? {} : { when: Object.freeze({ ...source.when }) }),
      sourceNodeId: source.result.source.nodeId,
      sourceField: source.result.source.field,
      schema: source.result.schema,
    });
  }

  if (source.type === "child") {
    const node: CompiledChildNode = {
      id: source.id,
      type: "child",
      dependsOn,
      ...(source.when === undefined ? {} : { when: Object.freeze({ ...source.when }) }),
      child: freezeChildDefinition(source.id, source.child, context),
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

function freezeLoop(source: SourceLoopNode, context: CompilationContext): readonly CompiledNode[] {
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
        freezeLoopBodyNode(
          source,
          bodyNode,
          entry.id,
          iteration,
          idByTemplate,
          priorCheckNodeId,
          context,
        ),
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

function freezeOptimization(
  workflow: WorkflowSource,
  source: SourceOptimizationNode,
  sourceIndex: number,
  context: CompilationContext,
): readonly CompiledNode[] {
  const baseline = workflow.nodes.find(
    (node): node is Extract<SourceNode, { readonly type: "result" }> =>
      node.id === source.optimization.baseline.nodeId && node.type === "result",
  );
  if (baseline === undefined) {
    throw new Error(`validated optimization "${source.id}" has no baseline result`);
  }
  const baselineSchema = freezeResultSchema(baseline.result.schema);
  const baselineSchemaDigest = calculateResultSchemaDigest(baselineSchema);
  const metric = Object.freeze({ ...source.optimization.metric });
  const invariants = Object.freeze(
    source.optimization.invariants.map((invariant) => Object.freeze({ ...invariant })),
  );
  const candidateNodeIds: string[] = [];
  const checkNodeIds: string[] = [];
  const expanded: CompiledNode[] = [];

  for (let candidate = 1; candidate <= source.optimization.maxCandidates; candidate += 1) {
    const candidateNodeId = optimizationCandidateNodeId(source.id, candidate);
    const checkNodeId = optimizationCheckNodeId(source.id, candidate);
    const priorCheckNodeId =
      candidate === 1 ? undefined : optimizationCheckNodeId(source.id, candidate - 1);
    const guard =
      priorCheckNodeId === undefined
        ? undefined
        : Object.freeze({
            optimizationId: source.id,
            candidate,
            checkNodeId: priorCheckNodeId,
          });
    const child = freezeChildDefinition(candidateNodeId, source.optimization.candidate, context);
    if (child.resultSchemaDigest !== baselineSchemaDigest) {
      throw new WorkflowCompilationError(
        `${source.id}.optimization.candidate.workflow`,
        Object.freeze([
          {
            code: "optimization_schema_mismatch",
            path: `nodes.${sourceIndex}.optimization.candidate.resultNodeId`,
            message: `optimization "${source.id}" candidate result schema must match baseline result "${baseline.id}"`,
          },
        ]),
      );
    }
    if (!compiledResultUsesCommandEvidence(child.workflow, child.resultNodeId)) {
      throw new WorkflowCompilationError(
        `${source.id}.optimization.candidate.workflow`,
        Object.freeze([
          {
            code: "optimization_evaluator_not_deterministic",
            path: `nodes.${sourceIndex}.optimization.candidate.resultNodeId`,
            message: `optimization "${source.id}" candidate result must be published directly from command evidence`,
          },
        ]),
      );
    }

    const candidateNode: CompiledChildNode = {
      id: candidateNodeId,
      type: "child",
      dependsOn: Object.freeze(
        priorCheckNodeId === undefined ? [...source.dependsOn] : [priorCheckNodeId],
      ),
      ...(guard === undefined ? {} : { optimizationGuard: guard }),
      optimizationCandidate: Object.freeze({
        optimizationId: source.id,
        candidate,
        checkNodeId,
      }),
      child,
    };
    expanded.push(Object.freeze(candidateNode));

    const checkNode: CompiledOptimizationCheckNode = {
      id: checkNodeId,
      type: "optimization-check",
      dependsOn: Object.freeze([candidateNodeId]),
      ...(guard === undefined ? {} : { optimizationGuard: guard }),
      optimizationCheck: Object.freeze({
        optimizationId: source.id,
        candidate,
        candidateNodeId,
        ...(priorCheckNodeId === undefined ? {} : { priorCheckNodeId }),
        baseline: Object.freeze({ ...source.optimization.baseline }),
        metric,
        invariants,
        maxConsecutiveNonImproving: source.optimization.stagnation.maxConsecutiveNonImproving,
        rollback: source.optimization.rollback,
      }),
    };
    expanded.push(Object.freeze(checkNode));
    candidateNodeIds.push(candidateNodeId);
    checkNodeIds.push(checkNodeId);
  }

  const controller: CompiledOptimizationNode = {
    id: source.id,
    type: "optimization",
    dependsOn: Object.freeze([...checkNodeIds]),
    optimization: Object.freeze({
      baseline: Object.freeze({ ...source.optimization.baseline }),
      baselineSchemaDigest,
      metric,
      invariants,
      maxCandidates: source.optimization.maxCandidates,
      maxConsecutiveNonImproving: source.optimization.stagnation.maxConsecutiveNonImproving,
      rollback: source.optimization.rollback,
      candidateNodeIds: Object.freeze([...candidateNodeIds]),
      checkNodeIds: Object.freeze([...checkNodeIds]),
    }),
  };
  expanded.push(Object.freeze(controller));
  return Object.freeze(expanded);
}

function compiledResultUsesCommandEvidence(
  workflow: CompiledWorkflow,
  resultNodeId: string,
): boolean {
  const result = workflow.nodes.find((node) => node.id === resultNodeId);
  if (result?.type !== "result") {
    return false;
  }
  const evaluator = workflow.nodes.find((node) => node.id === result.result.source.nodeId);
  return (
    evaluator?.type === "command" &&
    (result.result.source.field === "command.stdout" ||
      result.result.source.field === "command.stderr")
  );
}

function freezeLoopBodyNode(
  loop: SourceLoopNode,
  source: SourceBodyNode,
  entryNodeId: string,
  iteration: number,
  idByTemplate: ReadonlyMap<string, string>,
  priorCheckNodeId: string | undefined,
  context: CompilationContext,
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
        skills: Object.freeze([...source.agent.skills]),
        toolPackages: Object.freeze(
          source.agent.toolPackages.map((item) => Object.freeze({ ...item })),
        ),
        ...(source.agent.toolApproval === undefined
          ? {}
          : {
              toolApproval: Object.freeze({
                exec: Object.freeze({ ...source.agent.toolApproval.exec }),
              }),
            }),
        ...(source.agent.recovery === undefined
          ? {}
          : { recovery: Object.freeze({ ...source.agent.recovery }) }),
        timeoutMs: source.agent.timeoutMs,
      }),
    };
    return Object.freeze(node);
  }

  if (source.type === "verifier") {
    let verifier: CompiledVerifierNode["verifier"];
    if (source.verifier.kind === "command") {
      verifier = Object.freeze({
        kind: "command" as const,
        command: Object.freeze({
          executable: source.verifier.command.executable,
          args: Object.freeze([...source.verifier.command.args]),
          timeoutMs: source.verifier.command.timeoutMs,
        }),
      });
    } else if (source.verifier.kind === "model") {
      verifier = Object.freeze({
        kind: "model" as const,
        prompt: source.verifier.prompt,
        evidence: Object.freeze(
          source.verifier.evidence.map((item) =>
            Object.freeze({
              nodeId: requireMappedLoopNode(idByTemplate, item.nodeId, loop.id),
              field: item.field,
            }),
          ),
        ),
        model: Object.freeze({ ...source.verifier.model }),
        timeoutMs: source.verifier.timeoutMs,
      });
    } else if (source.verifier.kind === "packaged-command") {
      verifier = Object.freeze({
        kind: "packaged-command" as const,
        package: Object.freeze({ ...source.verifier.package }),
      });
    } else {
      verifier = Object.freeze({
        kind: "packaged-model" as const,
        package: Object.freeze({ ...source.verifier.package }),
        evidence: Object.freeze(
          source.verifier.evidence.map((item) =>
            Object.freeze({
              nodeId: requireMappedLoopNode(idByTemplate, item.nodeId, loop.id),
              field: item.field,
            }),
          ),
        ),
        model: Object.freeze({ ...source.verifier.model }),
        timeoutMs: source.verifier.timeoutMs,
      });
    }
    const node: CompiledVerifierNode = {
      ...common,
      type: "verifier",
      ...(when === undefined ? {} : { when }),
      verifier,
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

  if (source.type === "result") {
    return freezeResultNode({
      ...common,
      ...(when === undefined ? {} : { when }),
      sourceNodeId: requireMappedLoopNode(idByTemplate, source.result.source.nodeId, loop.id),
      sourceField: source.result.source.field,
      schema: source.result.schema,
    });
  }

  if (source.type === "child") {
    const node: CompiledChildNode = {
      ...common,
      type: "child",
      ...(when === undefined ? {} : { when }),
      child: freezeChildDefinition(source.id, source.child, context),
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

function freezeChildDefinition(
  nodeId: string,
  source: Extract<SourceNode, { readonly type: "child" }>["child"],
  context: CompilationContext,
): CompiledChildNode["child"] {
  const resolved = resolveChildWorkflow(nodeId, source, context);
  const sourceName = resolved.sourceName;
  if (context.depth >= MAX_CHILD_WORKFLOW_DEPTH) {
    throw new WorkflowCompilationError(
      sourceName,
      Object.freeze([
        {
          code: "child_depth_exceeded",
          path: "child.workflow",
          message: `child workflow nesting must not exceed ${MAX_CHILD_WORKFLOW_DEPTH}`,
        },
      ]),
    );
  }
  const workflow = compileWorkflowTextInternal(resolved.source, sourceName, {
    depth: context.depth + 1,
    nodeCount: context.nodeCount,
    ...(context.packageResolver === undefined ? {} : { packageResolver: context.packageResolver }),
    packageStack: resolved.packageStack,
    ...(resolved.sourcePackage === undefined ? {} : { sourcePackage: resolved.sourcePackage }),
  });
  if (
    workflow.budget?.maxNodeStarts === undefined ||
    workflow.budget.maxModelTokens === undefined ||
    workflow.budget.maxCostUsdMicros === undefined ||
    workflow.budget.maxExecutionMs === undefined ||
    workflow.budget.maxArtifactBytes === undefined
  ) {
    throw new WorkflowCompilationError(
      sourceName,
      Object.freeze([
        {
          code: "child_budget_required",
          path: "budget",
          message:
            "child workflow must declare node-start, model-token, cost, execution, and artifact ceilings",
        },
      ]),
    );
  }
  const result = workflow.nodes.find((node) => node.id === source.resultNodeId);
  if (result?.type !== "result") {
    throw new WorkflowCompilationError(
      sourceName,
      Object.freeze([
        {
          code: "invalid_schema",
          path: "child.resultNodeId",
          message: `child result node "${source.resultNodeId}" must name a result node`,
        },
      ]),
    );
  }
  if (
    result.when !== undefined ||
    result.loopInstance !== undefined ||
    result.loopGuard !== undefined
  ) {
    throw new WorkflowCompilationError(
      sourceName,
      Object.freeze([
        {
          code: "child_result_not_unconditional",
          path: "child.resultNodeId",
          message: `child result node "${result.id}" must be unconditional`,
        },
      ]),
    );
  }
  if (workflow.nodes.some((node) => node.dependsOn.includes(result.id))) {
    throw new WorkflowCompilationError(
      sourceName,
      Object.freeze([
        {
          code: "child_result_not_terminal",
          path: "child.resultNodeId",
          message: `child result node "${result.id}" must be terminal`,
        },
      ]),
    );
  }
  if (
    workflow.nodes.some(
      (node) =>
        node.type === "approval" ||
        (node.type === "command" && node.approval !== undefined) ||
        (node.type === "agent" && node.agent.toolApproval !== undefined),
    )
  ) {
    throw new WorkflowCompilationError(
      sourceName,
      Object.freeze([
        {
          code: "child_wait_unsupported",
          path: "nodes",
          message: "child workflows cannot contain human approval waits",
        },
      ]),
    );
  }
  return Object.freeze({
    workflow,
    workflowDigest: calculateWorkflowDigest(workflow),
    resultNodeId: result.id,
    resultSchema: result.result.schema,
    resultSchemaDigest: result.result.schemaDigest,
  });
}

function resolveChildWorkflow(
  nodeId: string,
  source: Extract<SourceNode, { readonly type: "child" }>["child"],
  context: CompilationContext,
): {
  readonly source: string;
  readonly sourceName: string;
  readonly packageStack: readonly string[];
  readonly sourcePackage?: CompiledWorkflowPackageReference;
} {
  if ("workflow" in source) {
    return {
      source: source.workflow,
      sourceName: `${nodeId}.child.workflow`,
      packageStack: context.packageStack,
    };
  }
  const reference = source.package;
  const key = packageKey(reference);
  const sourceName = `workflow:${reference.name}@${reference.version}`;
  if (context.packageStack.includes(key)) {
    throw new WorkflowCompilationError(
      sourceName,
      Object.freeze([
        {
          code: "workflow_package_cycle",
          path: "child.package",
          message: `workflow package cycle detected: ${[...context.packageStack, key].join(" -> ")}`,
        },
      ]),
    );
  }
  if (context.packageResolver === undefined) {
    throw unresolvedWorkflowPackage(
      sourceName,
      reference,
      "no immutable package resolver was supplied",
    );
  }
  let resolved: ResolvedWorkflowPackage;
  try {
    resolved = context.packageResolver.resolve(reference);
  } catch (error) {
    throw unresolvedWorkflowPackage(
      sourceName,
      reference,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    resolved.name !== reference.name ||
    resolved.version !== reference.version ||
    !/^[a-f0-9]{64}$/.test(resolved.digest) ||
    resolved.source.trim().length === 0 ||
    Buffer.byteLength(resolved.source, "utf8") > MAX_CHILD_WORKFLOW_SOURCE_BYTES
  ) {
    throw unresolvedWorkflowPackage(
      sourceName,
      reference,
      "the resolver returned mismatched or invalid package content",
    );
  }
  const sourcePackage = Object.freeze({
    name: resolved.name,
    version: resolved.version,
    digest: resolved.digest,
  });
  return {
    source: resolved.source,
    sourceName,
    packageStack: Object.freeze([...context.packageStack, key]),
    sourcePackage,
  };
}

function unresolvedWorkflowPackage(
  sourceName: string,
  reference: WorkflowPackageReference,
  detail: string,
): WorkflowCompilationError {
  const prefix = `workflow package "${reference.name}@${reference.version}" could not be resolved exactly: `;
  return new WorkflowCompilationError(
    sourceName,
    Object.freeze([
      {
        code: "workflow_package_unresolved",
        path: "child.package",
        message: boundedUtf8(`${prefix}${detail}`, 4_096),
      },
    ]),
  );
}

function freezeWorkflowPackageReference(
  reference: CompiledWorkflowPackageReference,
  sourceName: string,
): CompiledWorkflowPackageReference {
  if (
    !workflowPackageNameSchema.safeParse(reference.name).success ||
    !workflowPackageVersionSchema.safeParse(reference.version).success ||
    !/^[a-f0-9]{64}$/.test(reference.digest)
  ) {
    throw unresolvedWorkflowPackage(
      sourceName,
      reference,
      "the source package identity is invalid",
    );
  }
  return Object.freeze({ ...reference });
}

function packageKey(reference: WorkflowPackageReference): string {
  return `${reference.name}@${reference.version}`;
}

function boundedUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  const suffix = "… [truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let end = maxBytes - suffixBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) {
    end -= 1;
  }
  return `${bytes.subarray(0, end).toString("utf8")}${suffix}`;
}

function freezeResultNode(input: {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly loopInstance?: CompiledResultNode["loopInstance"];
  readonly loopGuard?: CompiledResultNode["loopGuard"];
  readonly when?: CompiledResultNode["when"];
  readonly sourceNodeId: string;
  readonly sourceField: CompiledResultNode["result"]["source"]["field"];
  readonly schema: CompiledResultSchema;
}): CompiledResultNode {
  const schema = freezeResultSchema(input.schema);
  const node: CompiledResultNode = {
    id: input.id,
    type: "result",
    dependsOn: input.dependsOn,
    ...(input.loopInstance === undefined ? {} : { loopInstance: input.loopInstance }),
    ...(input.loopGuard === undefined ? {} : { loopGuard: input.loopGuard }),
    ...(input.when === undefined ? {} : { when: input.when }),
    result: Object.freeze({
      source: Object.freeze({ nodeId: input.sourceNodeId, field: input.sourceField }),
      schema,
      schemaDigest: calculateResultSchemaDigest(schema),
    }),
  };
  return Object.freeze(node);
}

function freezeResultSchema(schema: CompiledResultSchema): CompiledResultSchema {
  if (schema.type === "array") {
    return Object.freeze({
      type: schema.type,
      maxItems: schema.maxItems,
      items: freezeResultSchema(schema.items),
    });
  }
  if (schema.type === "object") {
    const properties = Object.fromEntries(
      Object.entries(schema.properties)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => [key, freezeResultSchema(value)]),
    );
    return Object.freeze({
      type: schema.type,
      properties: Object.freeze(properties),
      required: Object.freeze([...schema.required].sort()),
    });
  }
  if (schema.type === "number" || schema.type === "integer") {
    return Object.freeze({
      type: schema.type,
      ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }),
      ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }),
    });
  }
  if (schema.type === "string") {
    return Object.freeze({ type: schema.type, maxLength: schema.maxLength });
  }
  return Object.freeze({ type: schema.type });
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
