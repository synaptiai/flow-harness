import type {
  CompiledBranchGuard,
  CompiledLoopGuard,
  CompiledLoopInstance,
  CompiledWorkflow,
  ConditionSourceField,
} from "./types.js";

interface ProjectedNodeBase {
  readonly nodeId: string;
  readonly dependsOn: readonly string[];
  readonly loopInstance?: CompiledLoopInstance;
  readonly loopGuard?: CompiledLoopGuard;
}

type ProjectedControlGraphNode =
  | (ProjectedNodeBase & {
      readonly type: "command" | "agent";
      readonly when?: CompiledBranchGuard;
    })
  | (ProjectedNodeBase & {
      readonly type: "condition";
      readonly when?: CompiledBranchGuard;
      readonly condition: {
        readonly source: { readonly nodeId: string; readonly field: ConditionSourceField };
        readonly cases: readonly { readonly id: string; readonly equals: string }[];
        readonly default: string;
      };
    })
  | (ProjectedNodeBase & {
      readonly type: "join";
      readonly join: {
        readonly conditionId: string;
        readonly branches: readonly { readonly case: string; readonly nodeId: string }[];
      };
    })
  | (ProjectedNodeBase & {
      readonly type: "loop-check";
      readonly loopCheck: {
        readonly loopId: string;
        readonly iteration: number;
        readonly source: { readonly nodeId: string; readonly field: ConditionSourceField };
        readonly equals: string;
      };
    })
  | (ProjectedNodeBase & {
      readonly type: "loop";
      readonly loop: {
        readonly maxIterations: number;
        readonly checkNodeIds: readonly string[];
      };
    });

export interface ProjectedControlGraph {
  readonly nodes: readonly ProjectedControlGraphNode[];
}

export function workflowRequiresControlGraph(workflow: CompiledWorkflow): boolean {
  return (
    (workflow.concurrency?.maxNodes ?? 1) > 1 ||
    workflow.nodes.some(
      (node) =>
        node.type === "condition" ||
        node.type === "join" ||
        node.type === "loop-check" ||
        node.type === "loop",
    )
  );
}

export function projectCompiledControlGraph(workflow: CompiledWorkflow): ProjectedControlGraph {
  const nodes = workflow.nodes.map<ProjectedControlGraphNode>((node) => {
    const common: ProjectedNodeBase = {
      nodeId: node.id,
      dependsOn: node.dependsOn,
      ...(node.loopInstance === undefined ? {} : { loopInstance: node.loopInstance }),
      ...(node.loopGuard === undefined ? {} : { loopGuard: node.loopGuard }),
    };
    if (node.type === "condition") {
      return {
        ...common,
        type: node.type,
        ...(node.when === undefined ? {} : { when: node.when }),
        condition: node.condition,
      };
    }
    if (node.type === "join") {
      return { ...common, type: node.type, join: node.join };
    }
    if (node.type === "loop-check") {
      return { ...common, type: node.type, loopCheck: node.loopCheck };
    }
    if (node.type === "loop") {
      return { ...common, type: node.type, loop: node.loop };
    }
    return {
      ...common,
      type: node.type,
      ...(node.when === undefined ? {} : { when: node.when }),
    };
  });
  return Object.freeze({ nodes: Object.freeze(nodes) });
}
