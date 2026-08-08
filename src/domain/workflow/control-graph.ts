import type {
  CompiledBranchGuard,
  CompiledChildNode,
  CompiledLoopGuard,
  CompiledLoopInstance,
  CompiledResultSchema,
  CompiledVerifierConfig,
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
      readonly type: "child";
      readonly when?: CompiledBranchGuard;
      readonly child: {
        readonly workflowId: string;
        readonly workflowDigest: string;
        readonly resultNodeId: string;
        readonly resultSchema: CompiledResultSchema;
        readonly resultSchemaDigest: string;
      };
    })
  | (ProjectedNodeBase & {
      readonly type: "approval";
      readonly when?: CompiledBranchGuard;
      readonly approval: {
        readonly prompt: string;
        readonly evidence: readonly {
          readonly nodeId: string;
          readonly field: ConditionSourceField;
        }[];
      };
    })
  | (ProjectedNodeBase & {
      readonly type: "verifier";
      readonly when?: CompiledBranchGuard;
      readonly verifier: CompiledVerifierConfig;
    })
  | (ProjectedNodeBase & {
      readonly type: "result";
      readonly when?: CompiledBranchGuard;
      readonly result: {
        readonly source: { readonly nodeId: string; readonly field: ConditionSourceField };
        readonly schema: CompiledResultSchema;
        readonly schemaDigest: string;
      };
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
        node.type === "child" ||
        node.type === "approval" ||
        node.type === "verifier" ||
        node.type === "result" ||
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
    if (node.type === "approval") {
      return {
        ...common,
        type: node.type,
        ...(node.when === undefined ? {} : { when: node.when }),
        approval: node.approval,
      };
    }
    if (node.type === "verifier") {
      return {
        ...common,
        type: node.type,
        ...(node.when === undefined ? {} : { when: node.when }),
        verifier: node.verifier,
      };
    }
    if (node.type === "result") {
      return {
        ...common,
        type: node.type,
        ...(node.when === undefined ? {} : { when: node.when }),
        result: node.result,
      };
    }
    if (node.type === "child") {
      return {
        ...common,
        type: node.type,
        ...(node.when === undefined ? {} : { when: node.when }),
        child: projectChild(node),
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

function projectChild(node: CompiledChildNode) {
  return Object.freeze({
    workflowId: node.child.workflow.id,
    workflowDigest: node.child.workflowDigest,
    resultNodeId: node.child.resultNodeId,
    resultSchema: node.child.resultSchema,
    resultSchemaDigest: node.child.resultSchemaDigest,
  });
}
