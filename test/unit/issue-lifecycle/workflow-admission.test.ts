import { describe, expect, it } from "vitest";

import {
  admitIssueWorkflow,
  ISSUE_WORKFLOW_PROTECTED_PATHS,
  MAX_ISSUE_REVIEW_BOUND_PROMPT_CHARACTERS,
  MAX_ISSUE_REVIEW_CONTEXT_BYTES,
  MAX_ISSUE_WORKFLOW_CONTEXT_BYTES,
} from "../../../src/application/issue-workflow-admission.js";
import {
  calculateAgentCommandDigest,
  normalizeAgentCommandRequest,
} from "../../../src/domain/agent-command.js";
import { createEffectiveHarnessRuntimeSnapshot } from "../../../src/domain/adaptation/effective-harness-runtime.js";
import { createEffectiveHarnessHeadIdentity } from "../../../src/domain/adaptation/effective-harness-state.js";
import {
  type CapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  createCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import { acpAgentCapabilitySnapshot } from "../../fixtures/acp-agent.js";
import { delegationEvaluationCandidateFixture } from "../../fixtures/delegation-evaluation-candidate.js";
import { phaseRoutingEffectiveHarnessCandidateArtifactFixture } from "../../fixtures/effective-harness-evaluation.js";

describe("issue workflow admission", () => {
  it("deterministically binds the selected model and frozen issue context into identity", () => {
    const source = implementationWorkflow("[read, ls, edit, create]");
    const input = {
      role: "implementation" as const,
      source,
      sourceName: "frozen-implementation.workflow.yaml",
      model: { provider: "openai", id: "gpt-5.6-sol" },
      context: { kind: "issue" as const, content: "Issue #197\nTreat this as data." },
      allowedWritePrefixes: ["src/", "test/"] as const,
    };

    const first = admitIssueWorkflow(input);
    const second = admitIssueWorkflow(input);
    const differentModel = admitIssueWorkflow({
      ...input,
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    });
    const differentContext = admitIssueWorkflow({
      ...input,
      context: { kind: "issue", content: "Issue #197\nDifferent frozen data." },
    });
    const agent = first.workflow.nodes.find((node) => node.type === "agent");

    expect(first.executionWorkflowDigest).toBe(calculateWorkflowDigest(first.workflow));
    expect(first.executionWorkflowDigest).toBe(second.executionWorkflowDigest);
    expect(first.templateWorkflowDigest).toBe(second.templateWorkflowDigest);
    expect(first.templateWorkflowDigest).not.toBe(differentModel.templateWorkflowDigest);
    expect(first.executionWorkflowDigest).not.toBe(differentModel.executionWorkflowDigest);
    expect(first.templateWorkflowDigest).toBe(differentContext.templateWorkflowDigest);
    expect(first.executionWorkflowDigest).not.toBe(differentContext.executionWorkflowDigest);
    expect(first.contextDigest).not.toBe(differentContext.contextDigest);
    expect(agent?.type === "agent" ? agent.agent.model : undefined).toMatchObject({
      provider: "openai",
      id: "gpt-5.6-sol",
    });
    expect(agent?.type === "agent" ? agent.agent.prompt : "").toContain(
      '"content":"Issue #197\\nTreat this as data."',
    );
    expect(agent?.type === "agent" ? agent.agent.prompt : "").toContain("untrusted task data");
    expect(first.allowedWritePrefixes).toEqual(["src", "test"]);
    expect(first.protectedPaths).toEqual(ISSUE_WORKFLOW_PROTECTED_PATHS);
    expect(first.criteria).toEqual([
      {
        id: "implementation-reviewed",
        description: "The implementation satisfies the admitted issue contract.",
        verifierNodeId: "verify-implementation",
      },
    ]);
    expect(Object.isFrozen(first.criteria)).toBe(true);
    expect(Object.isFrozen(first.workflow)).toBe(true);
    expect(Object.isFrozen(first.allowedWritePrefixes)).toBe(true);
  });

  it("returns and freezes the exact admitted capability snapshot identity", () => {
    const capabilitySnapshot = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: "issue-context",
        description: "Read issue context.",
        metadata: { version: "1" },
        requestedTools: [],
        trust: "project-explicit",
        provenance: ".flow/skills/issue-context",
        files: [{ path: "SKILL.md", content: Buffer.from("# Issue context\n") }],
      },
    ]);

    const admitted = admitIssueWorkflow({
      role: "implementation",
      source: implementationWorkflow("[read]"),
      sourceName: "implementation.workflow.yaml",
      capabilitySnapshot,
      model: { provider: "openai", id: "gpt-5.6-sol" },
      context: { kind: "issue", content: "Issue #197" },
      allowedWritePrefixes: [],
    });

    expect(admitted.capabilitySnapshot).toEqual(capabilitySnapshot);
    expect(admitted.capabilitySnapshotDigest).toBe(capabilitySnapshot.digest);
    expect(Object.isFrozen(admitted.capabilitySnapshot)).toBe(true);
    expect(Object.isFrozen(admitted.capabilitySnapshot?.packages[0])).toBe(true);
  });

  it.each([
    ["ACP", () => acpAgentCapabilitySnapshot()],
    ["delegation", delegationCapabilitySnapshot],
    ["phase routing", phaseRoutingCapabilitySnapshot],
  ])("rejects capability-level %s execution authority", (_name, snapshot) => {
    expect(() =>
      admitIssueWorkflow({
        role: "implementation",
        source: implementationWorkflow("[read]"),
        sourceName: "implementation.workflow.yaml",
        capabilitySnapshot: snapshot(),
        model: { provider: "openai", id: "gpt-5.6-sol" },
        context: { kind: "issue", content: "Issue #197" },
        allowedWritePrefixes: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe_workflow" }));
  });

  it("rejects a context above the UTF-8 byte limit before compilation", () => {
    expect(() =>
      admitIssueWorkflow({
        role: "implementation",
        source: implementationWorkflow("[read]"),
        sourceName: "implementation.workflow.yaml",
        model: { provider: "openai", id: "gpt-5.6-sol" },
        context: { kind: "issue", content: "é".repeat(MAX_ISSUE_WORKFLOW_CONTEXT_BYTES) },
        allowedWritePrefixes: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "context_too_large" }));
  });

  it.each([
    ["command nodes", commandWorkflow()],
    ["approval nodes", approvalWorkflow()],
    ["child delegation", delegatedWorkflow()],
    ["optimization nodes", optimizationWorkflow()],
  ])("rejects implementation %s", (_name, source) => {
    expect(() =>
      admitIssueWorkflow({
        role: "implementation",
        source,
        sourceName: "unsafe-implementation.workflow.yaml",
        model: { provider: "openai", id: "gpt-5.6-sol" },
        context: { kind: "issue", content: "Issue #197" },
        allowedWritePrefixes: ["src/"],
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe_workflow" }));
  });

  it("admits implementation exec only for controller-frozen verification commands", () => {
    const command = { executable: "npm", args: ["test"], timeoutMs: 120_000 } as const;
    const admitted = admitIssueWorkflow({
      role: "implementation",
      source: implementationWorkflow("[read, exec]"),
      sourceName: "implementation.workflow.yaml",
      model: { provider: "openai", id: "gpt-5.6-sol" },
      context: { kind: "issue", content: "Issue #197" },
      allowedWritePrefixes: ["src/"],
      verificationCommands: [command],
    });

    expect(admitted.agentCommandAuthority).toEqual({
      version: 1,
      kind: "frozen-verification",
      requestDigests: [
        calculateAgentCommandDigest(normalizeAgentCommandRequest({ version: 1, ...command })),
      ],
      requests: [{ version: 1, ...command }],
      rejectionLimit: 3,
    });
    expect(Object.isFrozen(admitted.agentCommandAuthority)).toBe(true);
    expect(Object.isFrozen(admitted.agentCommandAuthority?.requestDigests)).toBe(true);
    expect(Object.isFrozen(admitted.agentCommandAuthority?.requests)).toBe(true);
  });

  it("admits an implementation command verifier only for its frozen verification command", () => {
    const command = { executable: "npm", args: ["test"], timeoutMs: 120_000 } as const;
    const admitted = admitIssueWorkflow({
      role: "implementation",
      source: implementationCommandVerifierWorkflow(command),
      sourceName: "implementation.workflow.yaml",
      model: { provider: "openai", id: "gpt-5.6-sol" },
      context: { kind: "issue", content: "Issue #197" },
      allowedWritePrefixes: [],
      verificationCommands: [command],
    });
    const verifier = admitted.workflow.nodes.find((node) => node.id === "verify-command");

    expect(verifier?.type === "verifier" ? verifier.verifier.kind : undefined).toBe("command");
    expect(admitted.agentCommandAuthority?.requestDigests).toEqual([
      calculateAgentCommandDigest(normalizeAgentCommandRequest({ version: 1, ...command })),
    ]);
    expect(admitted.agentCommandAuthority?.requests).toBeUndefined();
    expect(admitted.agentCommandAuthority?.rejectionLimit).toBeUndefined();
  });

  it("does not impose a model-facing catalog byte limit when no agent selects exec", () => {
    const command = { executable: "npm", args: ["test"], timeoutMs: 120_000 };
    const largeCommands = ["node", "python3"].map((executable) => ({
      executable,
      args: Array(4).fill("x".repeat(8_192)),
      timeoutMs: 120_000,
    }));
    const admitted = admitIssueWorkflow({
      role: "implementation",
      source: implementationCommandVerifierWorkflow(command),
      sourceName: "command-verifier.workflow.yaml",
      model: { provider: "openai", id: "gpt-5.6-sol" },
      context: { kind: "issue", content: "Use only the command verifier." },
      allowedWritePrefixes: [],
      verificationCommands: [command, ...largeCommands],
    });
    expect(admitted.agentCommandAuthority?.requestDigests).toHaveLength(3);
    expect(admitted.agentCommandAuthority?.requests).toBeUndefined();
  });

  it("rejects an implementation command verifier outside frozen verification authority", () => {
    const command = { executable: "npm", args: ["test"], timeoutMs: 120_000 } as const;

    expect(() =>
      admitIssueWorkflow({
        role: "implementation",
        source: implementationCommandVerifierWorkflow(command),
        sourceName: "implementation.workflow.yaml",
        model: { provider: "openai", id: "gpt-5.6-sol" },
        context: { kind: "issue", content: "Issue #197" },
        allowedWritePrefixes: [],
        verificationCommands: [{ executable: "npm", args: ["run", "lint"], timeoutMs: 120_000 }],
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe_workflow" }));
  });

  it("validates every implementation command verifier after authority is already in use", () => {
    const command = { executable: "npm", args: ["test"], timeoutMs: 120_000 } as const;
    const undeclared = {
      executable: "npm",
      args: ["run", "lint"],
      timeoutMs: 120_000,
    } as const;

    expect(() =>
      admitIssueWorkflow({
        role: "implementation",
        source: implementationCommandVerifierWorkflow(command, undeclared),
        sourceName: "implementation.workflow.yaml",
        model: { provider: "openai", id: "gpt-5.6-sol" },
        context: { kind: "issue", content: "Issue #197" },
        allowedWritePrefixes: [],
        verificationCommands: [command],
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe_workflow" }));
  });

  it("rejects implementation exec without frozen verification-command authority", () => {
    expect(() =>
      admitIssueWorkflow({
        role: "implementation",
        source: implementationWorkflow("[read, exec]"),
        sourceName: "implementation.workflow.yaml",
        model: { provider: "openai", id: "gpt-5.6-sol" },
        context: { kind: "issue", content: "Issue #197" },
        allowedWritePrefixes: ["src/"],
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe_workflow" }));
  });

  it("requires explicit write prefixes when an implementation agent can mutate files", () => {
    expect(() =>
      admitIssueWorkflow({
        role: "implementation",
        source: implementationWorkflow("[read, edit]"),
        sourceName: "implementation.workflow.yaml",
        model: { provider: "openai", id: "gpt-5.6-sol" },
        context: { kind: "issue", content: "Issue #197" },
        allowedWritePrefixes: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "write_prefix_required" }));
  });

  it("requires a nonempty compiled goal criteria contract for implementation", () => {
    expect(() =>
      admitIssueWorkflow({
        role: "implementation",
        source: implementationWorkflow("[read]").replace(/goal:[\s\S]*?(?=nodes:)/, ""),
        sourceName: "implementation.workflow.yaml",
        model: { provider: "openai", id: "gpt-5.6-sol" },
        context: { kind: "issue", content: "Issue #197" },
        allowedWritePrefixes: [],
      }),
    ).toThrowError(/nonempty compiled goal criteria contract/i);
  });

  it("rejects invalid or protected write prefixes", () => {
    for (const prefix of ["../src", "/tmp/output", ".git/hooks", ".flow/runs", "src\\other"]) {
      expect(() =>
        admitIssueWorkflow({
          role: "implementation",
          source: implementationWorkflow("[edit]"),
          sourceName: "implementation.workflow.yaml",
          model: { provider: "openai", id: "gpt-5.6-sol" },
          context: { kind: "issue", content: "Issue #197" },
          allowedWritePrefixes: [prefix],
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_write_prefix" }));
    }
  });

  it("admits a recursively read-only review and validates its configured agent result", () => {
    const admitted = admitIssueWorkflow({
      role: "review",
      source: reviewWorkflow(),
      sourceName: "frozen-review.workflow.yaml",
      model: { provider: "openai", id: "gpt-5.6-sol" },
      context: { kind: "review", content: JSON.stringify({ summary: "Candidate diff" }) },
      resultNodeId: "review",
    });

    expect(admitted.resultNodeId).toBe("review");
    expect(admitted.allowedWritePrefixes).toEqual([]);
    expect(admitted.protectedPaths).toEqual([".git"]);
  });

  it("binds the untrusted review context into root and nested model-verifier prompts", () => {
    const admitted = admitIssueWorkflow({
      role: "review",
      source: reviewWorkflowWithNestedVerifiers(),
      sourceName: "verifier-review.workflow.yaml",
      model: { provider: "openai", id: "gpt-5.6-sol" },
      context: {
        kind: "review",
        content: JSON.stringify({ summary: "Candidate diff and evidence" }),
      },
      resultNodeId: "review",
    });
    const rootVerifier = admitted.workflow.nodes.find((node) => node.id === "root-verifier");
    const child = admitted.workflow.nodes.find((node) => node.id === "nested-review");
    const nestedVerifier =
      child?.type === "child"
        ? child.child.workflow.nodes.find((node) => node.id === "nested-verifier")
        : undefined;

    for (const verifier of [rootVerifier, nestedVerifier]) {
      const prompt =
        verifier?.type === "verifier" && verifier.verifier.kind === "model"
          ? verifier.verifier.prompt
          : "";
      expect(prompt).toContain("untrusted task data");
      expect(prompt).toContain('"summary":"Candidate diff and evidence"');
    }
  });

  it("admits review context above the implementation limit after worst-case JSON escaping", () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ content: "" }), "utf8");
    const content = JSON.stringify({
      content: '"'.repeat((MAX_ISSUE_REVIEW_CONTEXT_BYTES - emptyBytes) / 2),
    });
    const admitted = admitIssueWorkflow({
      role: "review",
      source: reviewWorkflow(),
      sourceName: "review.workflow.yaml",
      model: { provider: "openai", id: "gpt-5.6-sol" },
      context: { kind: "review", content },
      resultNodeId: "review",
    });
    const resultNode = admitted.workflow.nodes.find((node) => node.id === "review");
    const prompt = resultNode?.type === "agent" ? resultNode.agent.prompt : "";

    expect(Buffer.byteLength(content, "utf8")).toBe(MAX_ISSUE_REVIEW_CONTEXT_BYTES);
    expect(prompt.length).toBeGreaterThan(MAX_ISSUE_REVIEW_CONTEXT_BYTES);
    expect(prompt.length).toBeLessThanOrEqual(MAX_ISSUE_REVIEW_BOUND_PROMPT_CHARACTERS);
  });

  it("rejects review context above its UTF-8 byte limit", () => {
    expect(() =>
      admitIssueWorkflow({
        role: "review",
        source: reviewWorkflow(),
        sourceName: "review.workflow.yaml",
        model: { provider: "openai", id: "gpt-5.6-sol" },
        context: {
          kind: "review",
          content: JSON.stringify({ content: "x".repeat(MAX_ISSUE_REVIEW_CONTEXT_BYTES) }),
        },
        resultNodeId: "review",
      }),
    ).toThrowError(expect.objectContaining({ code: "context_too_large" }));
  });

  it.each(["not-json", "[]", '{"summary": "not canonical"}'])(
    "rejects a noncanonical review context: %s",
    (content) => {
      expect(() =>
        admitIssueWorkflow({
          role: "review",
          source: reviewWorkflow(),
          sourceName: "review.workflow.yaml",
          model: { provider: "openai", id: "gpt-5.6-sol" },
          context: { kind: "review", content },
          resultNodeId: "review",
        }),
      ).toThrowError(expect.objectContaining({ code: "unsafe_workflow" }));
    },
  );

  it("rejects an authored issue-workflow verifier input policy", () => {
    const source = reviewWorkflowWithNestedVerifiers().replace(
      "prompt: Verify the root evidence.",
      [
        "prompt: Verify the root evidence.",
        "      inputPolicy: { kind: issue-workflow, role: review, maxBytes: 786432 }",
      ].join("\n"),
    );
    expect(source).toContain("inputPolicy:");

    expect(() =>
      admitIssueWorkflow({
        role: "review",
        source,
        sourceName: "review.workflow.yaml",
        model: { provider: "openai", id: "gpt-5.6-sol" },
        context: { kind: "review", content: JSON.stringify({ summary: "Candidate diff" }) },
        resultNodeId: "prepare",
      }),
    ).toThrow(/inputPolicy/i);
  });

  it.each([
    [
      "a mutable review agent",
      reviewWorkflow().replace("tools: [read, ls]", "tools: [read, edit]"),
    ],
    ["a command review node", commandReviewWorkflow()],
    ["a command review verifier", commandVerifierReviewWorkflow()],
    ["an exec review agent", reviewWorkflow().replace("[read, ls]", "[read, exec]")],
  ])("rejects %s", (_name, source) => {
    expect(() =>
      admitIssueWorkflow({
        role: "review",
        source,
        sourceName: "review.workflow.yaml",
        model: { provider: "openai", id: "gpt-5.6-sol" },
        context: { kind: "review", content: JSON.stringify({ summary: "Candidate diff" }) },
        resultNodeId: "review",
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe_workflow" }));
  });

  it("rejects a review result binding that is absent or not an agent", () => {
    for (const resultNodeId of ["missing", "publish"]) {
      expect(() =>
        admitIssueWorkflow({
          role: "review",
          source: reviewWorkflow(),
          sourceName: "review.workflow.yaml",
          model: { provider: "openai", id: "gpt-5.6-sol" },
          context: { kind: "review", content: JSON.stringify({ summary: "Candidate diff" }) },
          resultNodeId,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_result_node" }));
    }
  });
});

function implementationWorkflow(tools: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: issue-implementation }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: implement-issue }
  outcome: The admitted issue implementation is complete.
  criteria:
    - id: implementation-reviewed
      description: The implementation satisfies the admitted issue contract.
      verifier: { nodeId: verify-implementation }
nodes:
${agentNode("implement", tools)}
  - id: verify-implementation
    type: verifier
    dependsOn: [implement]
    verifier:
      kind: model
      prompt: Verify the admitted implementation contract.
      evidence: [{ nodeId: implement, field: agent.text }]
      model: { provider: test, id: deterministic }
  - id: publish
    type: result
    dependsOn: [implement]
    result:
      source: { nodeId: implement, field: agent.text }
      schema: { type: string, maxLength: 4096 }
`;
}

function implementationCommandVerifierWorkflow(
  command: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
  },
  trailingCommand?: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
  },
): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: issue-command-verification }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: verify-issue-command }
  outcome: The admitted implementation passes its frozen verification command.
  criteria:
    - id: command-passes
      description: The controller-frozen verification command exits successfully.
      verifier: { nodeId: verify-command }
nodes:
${agentNode("implement", "[read]")}
  - id: verify-command
    type: verifier
    dependsOn: [implement]
    verifier:
      kind: command
      command:
        executable: ${command.executable}
        args: [${command.args.join(", ")}]
        timeoutMs: ${command.timeoutMs}
${
  trailingCommand === undefined
    ? ""
    : `  - id: verify-undeclared-command
    type: verifier
    dependsOn: [implement]
    verifier:
      kind: command
      command:
        executable: ${trailingCommand.executable}
        args: [${trailingCommand.args.join(", ")}]
        timeoutMs: ${trailingCommand.timeoutMs}
`
}
`;
}

function reviewWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: issue-review }
nodes:
${agentNode("review", "[read, ls]")}
  - id: publish
    type: result
    dependsOn: [review]
    result:
      source: { nodeId: review, field: agent.text }
      schema: { type: string, maxLength: 65536 }
`;
}

function reviewWorkflowWithNestedVerifiers(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: verifier-review }
nodes:
${agentNode("prepare", "[read]")}
  - id: root-verifier
    type: verifier
    dependsOn: [prepare]
    verifier:
      kind: model
      prompt: Verify the root evidence.
      evidence: [{ nodeId: prepare, field: agent.text }]
      model: { provider: test, id: deterministic }
  - id: nested-review
    type: child
    dependsOn: [root-verifier]
    child:
      resultNodeId: publish
      workflow: |
        apiVersion: flow.synapti.ai/v1alpha1
        kind: Workflow
        metadata: { id: nested-verifier-review }
        budget:
          maxNodeStarts: 4
          maxModelTokens: 2000
          maxCostUsd: 1
          maxExecutionMs: 60000
          maxArtifactBytes: 8192
        nodes:
          - id: inspect
            type: agent
            agent:
              prompt: Inspect the evidence.
              model: { provider: test, id: deterministic }
              tools: [read]
          - id: nested-verifier
            type: verifier
            dependsOn: [inspect]
            verifier:
              kind: model
              prompt: Verify the nested evidence.
              evidence: [{ nodeId: inspect, field: agent.text }]
              model: { provider: test, id: deterministic }
          - id: publish
            type: result
            dependsOn: [nested-verifier]
            result:
              source: { nodeId: nested-verifier, field: verifier.reason }
              schema: { type: string, maxLength: 4096 }
  - id: review
    type: agent
    dependsOn: [nested-review]
    agent:
      prompt: Produce the final review.
      model: { provider: test, id: deterministic }
      tools: [read]
  - id: publish
    type: result
    dependsOn: [review]
    result:
      source: { nodeId: review, field: agent.text }
      schema: { type: string, maxLength: 65536 }
`;
}

function agentNode(id = "implement", tools = "[read]"): string {
  return `  - id: ${id}
    type: agent
    agent:
      prompt: Perform the configured role.
      model: { provider: anthropic, id: source-model, thinking: medium }
      tools: ${tools}
      timeoutMs: 300000`;
}

function delegationCapabilitySnapshot(): CapabilitySnapshot {
  const delegation = delegationEvaluationCandidateFixture().projected.snapshot;
  return validateCapabilitySnapshot({
    version: 1,
    packages: [],
    delegation,
    digest: calculateCapabilitySnapshotDigest(
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      delegation,
    ),
  });
}

function phaseRoutingCapabilitySnapshot(): CapabilitySnapshot {
  const artifact = phaseRoutingEffectiveHarnessCandidateArtifactFixture();
  const head = createEffectiveHarnessHeadIdentity({
    scopeDigest: artifact.scopeDigest,
    workflowId: artifact.workflowId,
    generation: artifact.baselineHead.generation + 1,
    activationDigest: artifact.artifactDigest,
    transitionDigest: "d".repeat(64),
    stateDigest: artifact.candidateState.stateDigest,
  });
  const effectiveHarness = createEffectiveHarnessRuntimeSnapshot({
    state: artifact.candidateState,
    head,
  });
  return validateCapabilitySnapshot({
    version: 1,
    packages: artifact.candidateState.packages,
    effectiveHarness,
    digest: calculateCapabilitySnapshotDigest(
      artifact.candidateState.packages,
      [],
      effectiveHarness,
    ),
  });
}

function childNode(): string {
  return `  - id: implement
    type: child
    child:
      resultNodeId: publish
      workflow: |
        apiVersion: flow.synapti.ai/v1alpha1
        kind: Workflow
        metadata: { id: delegated-work }
        budget:
          maxNodeStarts: 2
          maxModelTokens: 1000
          maxCostUsd: 1
          maxExecutionMs: 60000
          maxArtifactBytes: 4096
        nodes:
          - id: analyze
            type: agent
            agent:
              prompt: Analyze.
              model: { provider: anthropic, id: source-model }
              tools: [read]
          - id: publish
            type: result
            dependsOn: [analyze]
            result:
              source: { nodeId: analyze, field: agent.text }
              schema: { type: string, maxLength: 4096 }`;
}

function commandWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: command-implementation }
nodes:
  - id: implement
    type: command
    command: { executable: npm, args: [test] }
`;
}

function commandReviewWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: command-review }
nodes:
  - id: review
    type: command
    command: { executable: npm, args: [test] }
`;
}

function commandVerifierReviewWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: command-verifier-review }
nodes:
${agentNode("prepare", "[read]")}
  - id: verify
    type: verifier
    dependsOn: [prepare]
    verifier:
      kind: command
      command: { executable: npm, args: [test], timeoutMs: 120000 }
  - id: review
    type: agent
    dependsOn: [verify]
    agent:
      prompt: Review the verified candidate.
      model: { provider: anthropic, id: source-model, thinking: medium }
      tools: [read]
  - id: publish
    type: result
    dependsOn: [review]
    result:
      source: { nodeId: review, field: agent.text }
      schema: { type: string, maxLength: 4096 }
`;
}

function approvalWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: approval-implementation }
nodes:
  - id: prepare
    type: command
    command: { executable: npm, args: [test] }
  - id: approve
    type: approval
    dependsOn: [prepare]
    approval:
      prompt: Continue?
      evidence: [{ nodeId: prepare, field: command.stdout }]
  - id: implement
    type: command
    dependsOn: [approve]
    command: { executable: npm, args: [test] }
`;
}

function delegatedWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: delegated-implementation }
budget:
  maxNodeStarts: 4
  maxModelTokens: 2000
  maxCostUsd: 1
  maxExecutionMs: 120000
  maxArtifactBytes: 8192
nodes:
${childNode()}
`;
}

function optimizationWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: optimization-implementation }
budget:
  maxNodeStarts: 16
  maxModelTokens: 10000
  maxCostUsd: 2
  maxExecutionMs: 300000
  maxArtifactBytes: 100000
nodes:
  - id: measure-baseline
    type: command
    command: { executable: node, args: [measure] }
  - id: baseline
    type: result
    dependsOn: [measure-baseline]
    result:
      source: { nodeId: measure-baseline, field: command.stdout }
      schema:
        type: object
        properties: { score: { type: number } }
        required: [score]
  - id: implement
    type: optimization
    dependsOn: [baseline]
    optimization:
      baseline: { nodeId: baseline, field: result.value }
      metric: { pointer: /score, direction: maximize }
      invariants: []
      maxCandidates: 1
      stagnation: { maxConsecutiveNonImproving: 1 }
      rollback: previous-best
      candidate:
        resultNodeId: publish
        workflow: |
          apiVersion: flow.synapti.ai/v1alpha1
          kind: Workflow
          metadata: { id: candidate }
          budget:
            maxNodeStarts: 2
            maxModelTokens: 1000
            maxCostUsd: 1
            maxExecutionMs: 60000
            maxArtifactBytes: 4096
          nodes:
            - id: measure
              type: command
              command: { executable: node, args: [measure] }
            - id: publish
              type: result
              dependsOn: [measure]
              result:
                source: { nodeId: measure, field: command.stdout }
                schema:
                  type: object
                  properties: { score: { type: number } }
                  required: [score]
`;
}
