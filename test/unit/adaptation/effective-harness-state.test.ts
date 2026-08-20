import { describe, expect, it } from "vitest";

import {
  calculateEffectiveHarnessStateDigest,
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
  EffectiveHarnessStateError,
  effectiveHarnessWorkflowSource,
  parseEffectiveHarnessHeadIdentity,
  parseEffectiveHarnessState,
} from "../../../src/domain/adaptation/effective-harness-state.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import { createPolicyPackageSnapshot } from "../../../src/domain/capability/policy-packages.js";
import {
  createWorkflowPackageSnapshot,
  workflowPackageSource,
} from "../../../src/domain/capability/workflow-packages.js";
import {
  agentSkillActivationInput,
  agentSkillActivationWorkflowSource,
} from "../../fixtures/agent-skill-activation.js";

const scopeDigest = "a".repeat(64);

describe("effective harness states", () => {
  it("stores one deterministic complete workflow and non-policy package closure", () => {
    const skill = agentSkillActivationInput().skill;

    const first = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: agentSkillActivationWorkflowSource,
      packages: [skill],
    });
    const second = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: agentSkillActivationWorkflowSource,
      packages: [structuredClone(skill)],
    });

    expect(first).toEqual(second);
    expect(parseEffectiveHarnessState(structuredClone(first), { scopeDigest })).toEqual(first);
    expect(first).toMatchObject({
      version: 1,
      kind: "effective-harness-state",
      scopeDigest,
      workflowId: "adaptive-skill-workflow",
      workflow: {
        bytes: Buffer.byteLength(agentSkillActivationWorkflowSource, "utf8"),
        contentBase64: Buffer.from(agentSkillActivationWorkflowSource).toString("base64"),
      },
      packages: [{ kind: "agent-skill", name: "review", digest: skill.digest }],
      stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(effectiveHarnessWorkflowSource(first)).toBe(agentSkillActivationWorkflowSource);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.packages[0])).toBe(true);
  });

  it("rejects policy packages from rollbackable harness state", () => {
    const policy = createPolicyPackageSnapshot({
      kind: "policy-package",
      trust: "project-explicit",
      provenance: ".flow/policies/restricted-review",
      manifest: { content: policyManifest() },
    });

    expect(() =>
      createEffectiveHarnessState({
        scopeDigest,
        workflowSource: workflowWithoutPackages(),
        packages: [policy],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessStateError>>({ code: "unexpected_policy" }),
    );
  });

  it("stores an exact package-free state", () => {
    const state = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: workflowWithoutPackages(),
      packages: [],
    });

    expect(state.packages).toEqual([]);
    expect(state.workflowId).toBe("policy-free-workflow");
    expect(parseEffectiveHarnessState(structuredClone(state), { scopeDigest })).toEqual(state);
  });

  it("stores one exact supplemental-memory entry for one existing root agent", () => {
    const content = "Use the reviewed fixture before changing generated output.";
    const state = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: rootAgentWorkflow(),
      packages: [],
      supplementalMemory: [
        {
          id: "reviewed-fixture",
          target: {
            workflowId: "memory-workflow",
            childPath: [],
            agentNodeId: "implement",
          },
          content,
        },
      ],
    } as Parameters<typeof createEffectiveHarnessState>[0] & {
      readonly supplementalMemory: readonly unknown[];
    });

    expect(state).toMatchObject({
      supplementalMemory: [
        {
          id: "reviewed-fixture",
          target: {
            workflowId: "memory-workflow",
            childPath: [],
            agentNodeId: "implement",
          },
          bytes: Buffer.byteLength(content, "utf8"),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          contentBase64: Buffer.from(content).toString("base64"),
        },
      ],
    });
    expect(parseEffectiveHarnessState(structuredClone(state), { scopeDigest })).toEqual(state);
    expect(Object.isFrozen(state.supplementalMemory?.[0])).toBe(true);
  });

  it("stores and recompiles a complete transitive workflow-package closure", () => {
    const first = workflowPackage("first", childWorkflow("first", "second"));
    const second = workflowPackage("second", childWorkflow("second"));

    const state = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: parentWorkflow("first"),
      packages: [first, second],
    });

    expect(state.packages.map((item) => `${item.kind}:${item.name}`)).toEqual([
      "workflow-package:first",
      "workflow-package:second",
    ]);
    expect(parseEffectiveHarnessState(structuredClone(state), { scopeDigest })).toEqual(state);
    expect(() =>
      createEffectiveHarnessState({
        scopeDigest,
        workflowSource: parentWorkflow("first"),
        packages: [first],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessStateError>>({ code: "invalid_workflow" }),
    );
  });

  it("binds a packaged root separately from nested workflow packages", () => {
    const root = workflowPackage("root-flow", childWorkflow("root-flow"));
    const rootPackage = { name: root.name, version: root.version, digest: root.digest };

    const state = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: workflowPackageSource(root),
      rootPackage,
      packages: [root],
    });

    expect(state.rootPackage).toEqual(rootPackage);
    expect(parseEffectiveHarnessState(structuredClone(state), { scopeDigest })).toEqual(state);
    expect(() =>
      createEffectiveHarnessState({
        scopeDigest,
        workflowSource: workflowPackageSource(root),
        packages: [root],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessStateError>>({ code: "invalid_closure" }),
    );
  });

  it("rejects extra non-policy packages that the workflow does not select", () => {
    const selected = agentSkillActivationInput().skill;
    const extraSnapshot = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: "extra",
        description: "An unrelated skill.",
        metadata: {},
        requestedTools: [],
        trust: "project-explicit",
        provenance: ".flow/skills/extra",
        files: [{ path: "SKILL.md", content: Buffer.from("# Extra\n") }],
      },
    ]);
    const extra = extraSnapshot.packages[0];
    if (extra === undefined) {
      throw new Error("extra package fixture is missing");
    }

    expect(() =>
      createEffectiveHarnessState({
        scopeDigest,
        workflowSource: agentSkillActivationWorkflowSource,
        packages: [selected, extra],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessStateError>>({ code: "invalid_closure" }),
    );
  });

  it.each([
    {
      name: "workflow bytes",
      mutate: (state: MutableState) => {
        state.workflow.contentBase64 = Buffer.from("PRIVATE_WORKFLOW").toString("base64");
      },
      expectedScopeDigest: scopeDigest,
    },
    {
      name: "package bytes",
      mutate: (state: MutableState) => {
        const file = state.packages[0]?.kind === "agent-skill" ? state.packages[0].files[0] : null;
        if (file !== null && file !== undefined) {
          file.contentBase64 = Buffer.from("PRIVATE_PACKAGE").toString("base64");
        }
      },
      expectedScopeDigest: scopeDigest,
    },
    {
      name: "redigested project scope",
      mutate: (state: MutableState) => {
        state.scopeDigest = "b".repeat(64);
        state.stateDigest = calculateEffectiveHarnessStateDigest(
          state as unknown as ReturnType<typeof createEffectiveHarnessState>,
        );
      },
      expectedScopeDigest: scopeDigest,
    },
  ])(
    "rejects $name substitution without retaining private values",
    ({ mutate, expectedScopeDigest }) => {
      const state = structuredClone(
        createEffectiveHarnessState({
          scopeDigest,
          workflowSource: agentSkillActivationWorkflowSource,
          packages: [agentSkillActivationInput().skill],
        }),
      ) as MutableState;
      mutate(state);

      try {
        parseEffectiveHarnessState(state, { scopeDigest: expectedScopeDigest });
        throw new Error("mutated effective harness state unexpectedly parsed");
      } catch (error) {
        expect(error).toBeInstanceOf(EffectiveHarnessStateError);
        expect((error as Error).message).not.toContain("PRIVATE");
        expect((error as Error).cause).toBeUndefined();
      }
    },
  );

  it("binds generation and transition identity so an ABA head is distinct", () => {
    const state = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: agentSkillActivationWorkflowSource,
      packages: [agentSkillActivationInput().skill],
    });
    const first = createEffectiveHarnessHeadIdentity({
      scopeDigest,
      workflowId: state.workflowId,
      generation: 1,
      activationDigest: "b".repeat(64),
      transitionDigest: "c".repeat(64),
      stateDigest: state.stateDigest,
    });
    const aba = createEffectiveHarnessHeadIdentity({
      scopeDigest,
      workflowId: state.workflowId,
      generation: 3,
      activationDigest: first.activationDigest,
      transitionDigest: "d".repeat(64),
      stateDigest: first.stateDigest,
    });

    expect(parseEffectiveHarnessHeadIdentity(structuredClone(first), { scopeDigest })).toEqual(
      first,
    );
    expect(first.headDigest).not.toBe(aba.headDigest);
    expect(first).not.toEqual(aba);
  });
});

type DeepMutable<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
      : Value;

type MutableState = DeepMutable<ReturnType<typeof createEffectiveHarnessState>>;

function workflowWithoutPackages(): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "policy-free-workflow" },
    budget: {
      maxNodeStarts: 2,
      maxModelTokens: 1,
      maxCostUsd: 1,
      maxExecutionMs: 1_000,
      maxArtifactBytes: 1_024,
    },
    nodes: [
      {
        id: "done",
        type: "command",
        command: { executable: "/usr/bin/true", timeoutMs: 1_000 },
      },
    ],
  });
}

function rootAgentWorkflow(): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "memory-workflow" },
    budget: {
      maxNodeStarts: 1,
      maxModelTokens: 1_000,
      maxCostUsd: 1,
      maxExecutionMs: 10_000,
      maxArtifactBytes: 1_024,
    },
    nodes: [
      {
        id: "implement",
        type: "agent",
        agent: {
          prompt: "Implement the requested change.",
          model: { provider: "test", id: "deterministic", thinking: "medium" },
          tools: [],
          skills: [],
          toolPackages: [],
          timeoutMs: 10_000,
        },
      },
      {
        id: "publish",
        type: "result",
        dependsOn: ["implement"],
        result: {
          source: { nodeId: "implement", field: "agent.text" },
          schema: { type: "string", maxLength: 1_024 },
        },
      },
    ],
  });
}

function policyManifest(): Buffer {
  return Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: restricted-review
  version: 1.0.0
  description: Require approval for commands.
spec:
  commands:
    requireApproval: true
`);
}

function workflowPackage(name: string, workflow: string) {
  const indented = workflow
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return createWorkflowPackageSnapshot({
    kind: "workflow-package",
    trust: "project-explicit",
    provenance: `.flow/workflows/${name}`,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata:
  name: ${name}
  version: 1.0.0
  description: Reusable ${name} workflow.
spec:
  workflow: |-
${indented}
`),
    },
  });
}

function parentWorkflow(packageName: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: parent }
budget:
  maxNodeStarts: 32
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 10000
nodes:
  - id: nested
    type: child
    child:
      resultNodeId: publish
      package: { name: ${packageName}, version: 1.0.0 }
`;
}

function childWorkflow(id: string, packageName?: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 32
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 10000
nodes:
  ${
    packageName === undefined
      ? `- id: collect
    type: command
    command: { executable: /usr/bin/true }
  - id: publish
    type: result
    dependsOn: [collect]
    result:
      source: { nodeId: collect, field: command.stdout }
      schema: { type: boolean }`
      : `- id: nested
    type: child
    child:
      resultNodeId: publish
      package: { name: ${packageName}, version: 1.0.0 }
  - id: publish
    type: result
    dependsOn: [nested]
    result:
      source: { nodeId: nested, field: result.value }
      schema: { type: boolean }`
  }
`;
}
