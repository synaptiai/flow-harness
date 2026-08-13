import { describe, expect, it } from "vitest";

import type { NodeExecutor, RunEventStore } from "../../../src/application/ports.js";
import { runWorkflow } from "../../../src/application/run-workflow.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import type { ToolPackageSnapshotInput } from "../../../src/domain/capability/tool-packages.js";
import {
  assertWorkflowSatisfiesPolicyPackages,
  PolicyPackageAdmissionError,
} from "../../../src/domain/policy/policy-package-admission.js";
import type {
  CompiledAgentNode,
  CompiledCommandNode,
  CompiledVerifierNode,
  CompiledWorkflow,
} from "../../../src/domain/workflow/types.js";

describe("policy package workflow admission", () => {
  it("admits a workflow that stays inside every composed constraint", () => {
    const workflow = workflowFixture([
      agentNode({ tools: ["read"], approval: false }),
      commandNode({ approval: true }),
      modelVerifierNode(),
    ]);

    expect(() => assertWorkflowSatisfiesPolicyPackages(workflow, policySnapshot())).not.toThrow();
  });

  it.each([
    {
      name: "agent model",
      mutate: () => workflowFixture([agentNode({ model: "forbidden", tools: ["read"] })]),
      fieldPath: "nodes.agent.agent.model",
    },
    {
      name: "model verifier",
      mutate: () =>
        workflowFixture([
          {
            ...modelVerifierNode(),
            verifier: {
              ...modelVerifierNode().verifier,
              model: { provider: "test", id: "forbidden", thinking: "off" as const },
            },
          },
        ]),
      fieldPath: "nodes.verify.verifier.model",
    },
    {
      name: "tool name",
      mutate: () => workflowFixture([agentNode({ tools: ["edit"] })]),
      fieldPath: "nodes.agent.agent.tools",
    },
    {
      name: "tool permission",
      mutate: () => workflowFixture([agentNode({ tools: ["exec"], approval: true })]),
      fieldPath: "nodes.agent.agent.tools",
      snapshot: () =>
        policySnapshot(
          "tools:\n  allowed: [exec, read]\n  allowedPermissions: [filesystem.read]\n",
        ),
    },
    {
      name: "command approval",
      mutate: () => workflowFixture([commandNode({ approval: false })]),
      fieldPath: "nodes.command.approval",
    },
    {
      name: "agent command approval",
      mutate: () => workflowFixture([agentNode({ tools: ["exec"], approval: false })]),
      fieldPath: "nodes.agent.agent.toolApproval",
      snapshot: () =>
        policySnapshot(
          "tools:\n  allowed: [exec, read]\n  allowedPermissions: [filesystem.read, process.execute]\ncommands:\n  requireApproval: true\n",
        ),
    },
    {
      name: "command verifier without an approval contract",
      mutate: () => workflowFixture([commandVerifierNode()]),
      fieldPath: "nodes.verify.verifier",
    },
    {
      name: "missing budget",
      mutate: () => ({ ...workflowFixture([]), budget: undefined }),
      fieldPath: "budget.maxNodeStarts",
    },
    {
      name: "excess budget",
      mutate: () => workflowFixture([], { maxNodeStarts: 9 }),
      fieldPath: "budget.maxNodeStarts",
    },
  ])("rejects a workflow that violates the $name constraint", (testCase) => {
    expect(() =>
      assertWorkflowSatisfiesPolicyPackages(
        testCase.mutate() as CompiledWorkflow,
        testCase.snapshot?.() ?? policySnapshot(),
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "PolicyPackageAdmissionError",
        code: "policy_violation",
        fieldPath: testCase.fieldPath,
      }),
    );
  });

  it("checks embedded child workflows under the same policy", () => {
    const child = workflowFixture([agentNode({ model: "forbidden", tools: ["read"] })]);
    const parent = workflowFixture([
      {
        id: "delegate",
        type: "child" as const,
        dependsOn: [],
        child: {
          workflow: child,
          workflowDigest: "a".repeat(64),
          resultNodeId: "result",
          resultSchema: { type: "null" as const },
          resultSchemaDigest: "b".repeat(64),
        },
      },
    ]);

    expect(() => assertWorkflowSatisfiesPolicyPackages(parent, policySnapshot())).toThrowError(
      expect.objectContaining({
        fieldPath: "nodes.delegate.child.workflow.nodes.agent.agent.model",
      }),
    );
  });

  it("binds package-provided tool names and permissions from the immutable snapshot", () => {
    const workflow = workflowFixture([packagedToolAgent()]);
    const admitted = combinedToolPolicySnapshot(
      "tools:\n  allowed: [create_project_report]\n  allowedPermissions: [process.execute]\ncommands:\n  requireApproval: true\n",
    );
    const wrongName = combinedToolPolicySnapshot(
      "tools:\n  allowed: [project-report]\n  allowedPermissions: [process.execute]\ncommands:\n  requireApproval: true\n",
    );
    const wrongPermission = combinedToolPolicySnapshot(
      "tools:\n  allowed: [create_project_report]\n  allowedPermissions: [filesystem.read]\ncommands:\n  requireApproval: true\n",
    );

    expect(() => assertWorkflowSatisfiesPolicyPackages(workflow, admitted)).not.toThrow();
    expect(() => assertWorkflowSatisfiesPolicyPackages(workflow, wrongName)).toThrowError(
      expect.objectContaining({ fieldPath: "nodes.agent.agent.tools" }),
    );
    expect(() => assertWorkflowSatisfiesPolicyPackages(workflow, wrongPermission)).toThrowError(
      expect.objectContaining({ fieldPath: "nodes.agent.agent.tools" }),
    );
  });

  it("does nothing when the capability snapshot contains no policy package", () => {
    expect(() =>
      assertWorkflowSatisfiesPolicyPackages(workflowFixture([]), undefined),
    ).not.toThrow();
  });

  it("rejects before the run store or executor observes work", async () => {
    const events: unknown[] = [];
    let executions = 0;
    const store: RunEventStore = {
      append: async (event) => {
        events.push(event);
      },
      read: async () => [],
    };
    const executor: NodeExecutor = {
      execute: async () => {
        executions += 1;
        throw new Error("executor must not run");
      },
    };

    await expect(
      runWorkflow(workflowFixture([agentNode({ model: "forbidden", tools: ["read"] })]), {
        runId: "policy-rejected",
        cwd: "/workspace",
        protectedPaths: [],
        capabilitySnapshot: policySnapshot(),
        store,
        executor,
      }),
    ).rejects.toBeInstanceOf(PolicyPackageAdmissionError);
    expect(events).toEqual([]);
    expect(executions).toBe(0);
  });
});

function workflowFixture(
  nodes: CompiledWorkflow["nodes"],
  budget: CompiledWorkflow["budget"] = {
    maxNodeStarts: 8,
    maxModelTokens: 1_000,
    maxCostUsdMicros: 10_000,
    maxExecutionMs: 30_000,
    maxArtifactBytes: 1_024,
  },
): CompiledWorkflow {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    id: "policy-admission",
    budget,
    nodes,
  };
}

function agentNode(input: {
  readonly model?: string;
  readonly tools: CompiledAgentNode["agent"]["tools"];
  readonly approval?: boolean;
}): CompiledAgentNode {
  return {
    id: "agent",
    type: "agent",
    dependsOn: [],
    agent: {
      prompt: "Review the project.",
      model: { provider: "test", id: input.model ?? "allowed", thinking: "off" },
      tools: input.tools,
      skills: [],
      toolPackages: [],
      ...(input.approval === true
        ? { toolApproval: { exec: { mode: "required", grantTtlMs: 60_000 } } }
        : {}),
      timeoutMs: 30_000,
    },
  };
}

function commandNode(input: { readonly approval: boolean }): CompiledCommandNode {
  return {
    id: "command",
    type: "command",
    dependsOn: [],
    ...(input.approval ? { approval: { mode: "required" as const, grantTtlMs: 60_000 } } : {}),
    command: { executable: "node", args: ["--version"], timeoutMs: 30_000 },
  };
}

function packagedToolAgent(): CompiledAgentNode {
  return {
    ...agentNode({ tools: [], approval: true }),
    agent: {
      ...agentNode({ tools: [], approval: true }).agent,
      toolPackages: [{ name: "project-report", version: "1.2.3" }],
    },
  };
}

function modelVerifierNode(): CompiledVerifierNode & {
  readonly verifier: Extract<CompiledVerifierNode["verifier"], { readonly kind: "model" }>;
} {
  return {
    id: "verify",
    type: "verifier",
    dependsOn: [],
    verifier: {
      kind: "model",
      prompt: "Verify the result.",
      evidence: [],
      model: { provider: "test", id: "allowed", thinking: "off" },
      timeoutMs: 30_000,
    },
  };
}

function commandVerifierNode(): CompiledVerifierNode {
  return {
    id: "verify",
    type: "verifier",
    dependsOn: [],
    verifier: {
      kind: "command",
      command: { executable: "/usr/bin/true", args: [], timeoutMs: 30_000 },
    },
  };
}

function policySnapshot(
  spec = `models:
  allowed:
    - { provider: test, model: allowed }
tools:
  allowed: [read]
  allowedPermissions: [filesystem.read]
commands:
  requireApproval: true
budget:
  maxNodeStarts: 8
  maxModelTokens: 1000
  maxCostUsdMicros: 10000
  maxExecutionMs: 30000
  maxArtifactBytes: 1024
`,
) {
  return createCapabilitySnapshot(
    [],
    [],
    [],
    [],
    [
      {
        kind: "policy-package",
        trust: "project-explicit",
        provenance: ".flow/policies/restricted-review",
        manifest: {
          content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: restricted-review
  version: 1.2.3
  description: Policy admission fixture.
spec:
${spec
  .trimEnd()
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
`),
        },
      },
    ],
  );
}

function combinedToolPolicySnapshot(spec: string) {
  return createCapabilitySnapshot(
    [],
    [],
    [toolPackageInput()],
    [],
    [
      {
        kind: "policy-package",
        trust: "project-explicit",
        provenance: ".flow/policies/restricted-review",
        manifest: {
          content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata: { name: restricted-review, version: 1.2.3, description: Tool policy. }
spec:
${spec
  .trimEnd()
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
`),
        },
      },
    ],
  );
}

function toolPackageInput(): ToolPackageSnapshotInput {
  return {
    kind: "tool-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name: "project-report",
    version: "1.2.3",
    description: "Reusable project report tool.",
    trust: "project-explicit",
    provenance: ".flow/tools/project-report",
    definition: {
      tool: {
        name: "create_project_report",
        description: "Print a selected report subject.",
        inputs: [{ name: "subject", description: "Report subject.", type: "string" }],
      },
      driver: {
        kind: "command",
        version: "v1",
        profile: "posix-printf-v1",
        executable: "/usr/bin/printf",
        args: ["%s", "{input:subject}"],
        timeoutMs: 10_000,
      },
      permissions: ["process.execute"],
    },
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata: { name: project-report, version: 1.2.3, description: Reusable project report tool. }
spec:
  tool:
    name: create_project_report
    description: Print a selected report subject.
    inputs:
      - { name: subject, description: Report subject., type: string }
  driver:
    kind: command
    version: v1
    profile: posix-printf-v1
    executable: /usr/bin/printf
    args: ["%s", "{input:subject}"]
    timeoutMs: 10000
  permissions: [process.execute]
`),
    },
  };
}

expect(PolicyPackageAdmissionError).toBeDefined();
