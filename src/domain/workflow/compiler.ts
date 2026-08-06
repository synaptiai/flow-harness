import { parseDocument } from "yaml";

import { workflowSourceSchema, type WorkflowSource } from "./schema.js";
import type {
  CompiledAgentNode,
  CompiledCommandNode,
  CompiledNode,
  CompiledWorkflow,
} from "./types.js";

export interface WorkflowDiagnostic {
  readonly code:
    | "cycle"
    | "duplicate_dependency"
    | "duplicate_node"
    | "entry_count"
    | "invalid_schema"
    | "invalid_yaml"
    | "self_dependency"
    | "terminal_requires_command"
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
    for (const [dependencyIndex, dependency] of node.dependsOn.entries()) {
      const path = `nodes.${nodeIndex}.dependsOn.${dependencyIndex}`;
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

  const entries = workflow.nodes.filter((node) => node.dependsOn.length === 0);
  if (entries.length !== 1) {
    diagnostics.push({
      code: "entry_count",
      path: "nodes",
      message: `workflow must contain exactly one entry node; found ${entries.length}`,
    });
  }

  const dependedUpon = new Set(workflow.nodes.flatMap((node) => node.dependsOn));
  for (const [index, node] of workflow.nodes.entries()) {
    if (!dependedUpon.has(node.id) && node.type !== "command") {
      diagnostics.push({
        code: "terminal_requires_command",
        path: `nodes.${index}.type`,
        message: `terminal node "${node.id}" must be a command verifier`,
      });
    }
  }

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
    for (const dependency of node.dependsOn) {
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
    nodes,
  };
  return Object.freeze(workflow);
}

function freezeNode(source: WorkflowSource["nodes"][number]): CompiledNode {
  const dependsOn = Object.freeze([...source.dependsOn]);
  if (source.type === "command") {
    const node: CompiledCommandNode = {
      id: source.id,
      type: "command",
      dependsOn,
      command: Object.freeze({
        executable: source.command.executable,
        args: Object.freeze([...source.command.args]),
        timeoutMs: source.command.timeoutMs,
      }),
    };
    return Object.freeze(node);
  }

  const node: CompiledAgentNode = {
    id: source.id,
    type: "agent",
    dependsOn,
    agent: Object.freeze({
      prompt: source.agent.prompt,
      model: Object.freeze({ ...source.agent.model }),
      tools: Object.freeze([...source.agent.tools]),
      timeoutMs: source.agent.timeoutMs,
    }),
  };
  return Object.freeze(node);
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "$" : path.map(String).join(".");
}
