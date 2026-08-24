import { describe, expect, it } from "vitest";

import {
  compileWorkflowText,
  WorkflowCompilationError,
} from "../../../src/domain/workflow/compiler.js";

describe("Lean proof verifier compiler", () => {
  it("compiles exact proof sources, human faithfulness approval, and runtime identity", () => {
    const workflow = compileWorkflowText(proofWorkflow());

    expect(workflow.nodes.find((node) => node.id === "verify-proof")).toMatchObject({
      type: "verifier",
      dependsOn: ["specification", "statement", "proof", "approve-statement"],
      verifier: {
        kind: "lean-proof",
        targetDeclaration: "Flow.Proof.add_zero",
        specification: { nodeId: "specification", field: "command.stdout" },
        statement: { nodeId: "statement", field: "command.stdout" },
        proof: { nodeId: "proof", field: "agent.text" },
        faithfulnessApprovalNodeId: "approve-statement",
        runtime: {
          version: 1,
          platform: "linux",
          architecture: "x64",
          leanVersion: "4.33.1",
          imageDigest: `sha256:${"a".repeat(64)}`,
        },
        timeoutMs: 300_000,
      },
    });
  });

  it.each([
    [
      "unknown proof source",
      proofWorkflow().replace(
        "proof: { nodeId: proof, field: agent.text }",
        "proof: { nodeId: absent, field: agent.text }",
      ),
      "verifier_source_unknown",
    ],
    [
      "non-direct statement source",
      proofWorkflow().replace(
        "dependsOn: [specification, statement, proof, approve-statement]",
        "dependsOn: [specification, proof, approve-statement]",
      ),
      "verifier_source_requires_dependency",
    ],
    [
      "approval that omits the statement",
      proofWorkflow().replace(
        "evidence:\n        - { nodeId: specification, field: command.stdout }\n        - { nodeId: statement, field: command.stdout }",
        "evidence:\n        - { nodeId: specification, field: command.stdout }",
      ),
      "proof_faithfulness_approval_mismatch",
    ],
    [
      "approval that reverses the specification and statement",
      proofWorkflow().replace(
        "evidence:\n        - { nodeId: specification, field: command.stdout }\n        - { nodeId: statement, field: command.stdout }",
        "evidence:\n        - { nodeId: statement, field: command.stdout }\n        - { nodeId: specification, field: command.stdout }",
      ),
      "proof_faithfulness_approval_mismatch",
    ],
    [
      "non-human control dependency",
      proofWorkflow().replace(
        "faithfulnessApprovalNodeId: approve-statement",
        "faithfulnessApprovalNodeId: statement",
      ),
      "proof_faithfulness_approval_type",
    ],
  ])("rejects an %s", (_label, source, expectedCode) => {
    const error = captureCompilationError(source);

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: expectedCode })]),
    );
  });
});

function proofWorkflow(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: exact-lean-proof }
nodes:
  - id: specification
    type: command
    command: { executable: read-specification }
  - id: statement
    type: command
    dependsOn: [specification]
    command: { executable: read-statement }
  - id: proof
    type: agent
    dependsOn: [statement]
    agent:
      prompt: Propose only a proof for the exact supplied statement.
      model: { provider: operator-provider, id: proof-model-1, thinking: high }
  - id: approve-statement
    type: approval
    dependsOn: [specification, statement]
    approval:
      prompt: Confirm that the exact formal statement represents the exact source specification.
      evidence:
        - { nodeId: specification, field: command.stdout }
        - { nodeId: statement, field: command.stdout }
  - id: verify-proof
    type: verifier
    dependsOn: [specification, statement, proof, approve-statement]
    verifier:
      kind: lean-proof
      targetDeclaration: Flow.Proof.add_zero
      specification: { nodeId: specification, field: command.stdout }
      statement: { nodeId: statement, field: command.stdout }
      proof: { nodeId: proof, field: agent.text }
      faithfulnessApprovalNodeId: approve-statement
      runtime:
        version: 1
        platform: linux
        architecture: x64
        imageDigest: sha256:${"a".repeat(64)}
        buildAttestationDigest: ${"b".repeat(64)}
        dependencyManifestDigest: ${"c".repeat(64)}
        leanVersion: 4.33.1
        mathlibRevision: ${"d".repeat(64)}
        safeVerifyRevision: ${"e".repeat(64)}
        nanodaRevision: "${"1".repeat(64)}"
        profileDigest: "${"2".repeat(64)}"
`;
}

function captureCompilationError(source: string): WorkflowCompilationError {
  try {
    compileWorkflowText(source);
  } catch (error) {
    if (error instanceof WorkflowCompilationError) return error;
    throw error;
  }
  throw new Error("expected workflow compilation to fail");
}
