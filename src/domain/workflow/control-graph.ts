import type {
  CompiledAgentNode,
  CompiledBranchGuard,
  CompiledChildNode,
  CompiledLoopGuard,
  CompiledLoopInstance,
  CompiledOptimizationGuard,
  CompiledResultSchema,
  CompiledToolPackageReference,
  CompiledVerifierConfig,
  CompiledWorkflow,
  CompiledWorkflowPackageReference,
  ConditionSourceField,
} from "./types.js";
import { DEFAULT_POLICY_DECISION_LIMIT } from "../policy/limits.js";

interface ProjectedNodeBase {
  readonly nodeId: string;
  readonly dependsOn: readonly string[];
  readonly loopInstance?: CompiledLoopInstance;
  readonly loopGuard?: CompiledLoopGuard;
  readonly optimizationGuard?: CompiledOptimizationGuard;
}

type ProjectedControlGraphNode =
  | (ProjectedNodeBase & {
      readonly type: "command";
      readonly when?: CompiledBranchGuard;
    })
  | (ProjectedNodeBase & {
      readonly type: "agent";
      readonly when?: CompiledBranchGuard;
      readonly policyDecisionLimit?: number;
      readonly model?: CompiledAgentNode["agent"]["model"];
      readonly commandTools?: {
        readonly rawExec: boolean;
        readonly packages: readonly CompiledToolPackageReference[];
      };
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
      readonly optimizationCandidate?: NonNullable<CompiledChildNode["optimizationCandidate"]>;
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
    })
  | (ProjectedNodeBase & {
      readonly type: "optimization-check";
      readonly optimizationCheck: Extract<
        CompiledWorkflow["nodes"][number],
        { readonly type: "optimization-check" }
      >["optimizationCheck"];
    })
  | (ProjectedNodeBase & {
      readonly type: "optimization";
      readonly optimization: Extract<
        CompiledWorkflow["nodes"][number],
        { readonly type: "optimization" }
      >["optimization"];
    });

export interface ProjectedControlGraph {
  readonly workflowPackages?: readonly CompiledWorkflowPackageReference[];
  readonly nodes: readonly ProjectedControlGraphNode[];
}

export function workflowRequiresControlGraph(workflow: CompiledWorkflow): boolean {
  return (
    (workflow.concurrency?.maxNodes ?? 1) > 1 ||
    collectWorkflowPackages(workflow).length > 0 ||
    workflow.nodes.some(
      (node) =>
        (node.type === "agent" &&
          (node.agent.toolPackages.length > 0 ||
            (node.agent.policyDecisionLimit ?? DEFAULT_POLICY_DECISION_LIMIT) !==
              DEFAULT_POLICY_DECISION_LIMIT)) ||
        node.type === "condition" ||
        node.type === "join" ||
        node.type === "child" ||
        node.type === "approval" ||
        node.type === "verifier" ||
        node.type === "result" ||
        node.type === "loop-check" ||
        node.type === "loop" ||
        node.type === "optimization-check" ||
        node.type === "optimization",
    )
  );
}

export function projectCompiledControlGraph(workflow: CompiledWorkflow): ProjectedControlGraph {
  const proofModelSourceNodeIds = new Set(
    workflow.nodes.flatMap((node) =>
      node.type === "verifier" && node.verifier.kind === "lean-proof"
        ? [node.verifier.proof.nodeId]
        : [],
    ),
  );
  const nodes = workflow.nodes.map<ProjectedControlGraphNode>((node) => {
    const common: ProjectedNodeBase = {
      nodeId: node.id,
      dependsOn: node.dependsOn,
      ...(node.loopInstance === undefined ? {} : { loopInstance: node.loopInstance }),
      ...(node.loopGuard === undefined ? {} : { loopGuard: node.loopGuard }),
      ...(node.optimizationGuard === undefined
        ? {}
        : { optimizationGuard: node.optimizationGuard }),
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
        ...(node.optimizationCandidate === undefined
          ? {}
          : { optimizationCandidate: node.optimizationCandidate }),
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
    if (node.type === "optimization-check") {
      return { ...common, type: node.type, optimizationCheck: node.optimizationCheck };
    }
    if (node.type === "optimization") {
      return { ...common, type: node.type, optimization: node.optimization };
    }
    if (node.type === "agent") {
      return {
        ...common,
        type: node.type,
        ...(node.when === undefined ? {} : { when: node.when }),
        ...((node.agent.policyDecisionLimit ?? DEFAULT_POLICY_DECISION_LIMIT) ===
        DEFAULT_POLICY_DECISION_LIMIT
          ? {}
          : { policyDecisionLimit: node.agent.policyDecisionLimit }),
        ...(proofModelSourceNodeIds.has(node.id) ? { model: node.agent.model } : {}),
        ...(node.agent.toolPackages.length === 0
          ? {}
          : {
              commandTools: Object.freeze({
                rawExec: node.agent.tools.includes("exec"),
                packages: Object.freeze(
                  node.agent.toolPackages.map((item) => Object.freeze({ ...item })),
                ),
              }),
            }),
      };
    }
    return {
      ...common,
      type: node.type,
      ...(node.when === undefined ? {} : { when: node.when }),
    };
  });
  const workflowPackages = collectWorkflowPackages(workflow);
  return Object.freeze({
    ...(workflowPackages.length === 0 ? {} : { workflowPackages }),
    nodes: Object.freeze(nodes),
  });
}

function collectWorkflowPackages(
  workflow: CompiledWorkflow,
): readonly CompiledWorkflowPackageReference[] {
  const packages = new Map<string, CompiledWorkflowPackageReference>();
  const visit = (current: CompiledWorkflow): void => {
    if (current.sourcePackage !== undefined) {
      packages.set(current.sourcePackage.name, current.sourcePackage);
    }
    for (const node of current.nodes) {
      if (node.type === "child") {
        visit(node.child.workflow);
      }
    }
  };
  visit(workflow);
  return Object.freeze(
    [...packages.values()].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    ),
  );
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
