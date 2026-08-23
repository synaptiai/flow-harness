import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type {
  AgentExecutor,
  CommandExecutor,
  LeanProofDriver,
  NodeExecutionContext,
} from "../../../src/application/ports.js";
import { VerifierNodeExecutor } from "../../../src/application/verifier-executor.js";
import type {
  LeanProofExecutionEvidence,
  LeanProofRequest,
} from "../../../src/domain/proof/lean-proof-verification.js";
import type { CompiledVerifierNode } from "../../../src/domain/workflow/types.js";

describe("Lean proof verifier executor", () => {
  it("passes one exact human-approved request to the proof driver", async () => {
    const driver = fakeProofDriver();
    const executor = new VerifierNodeExecutor(fakeCommandExecutor(), fakeAgentExecutor(), driver);

    const outcome = await executor.execute(proofVerifier(), context());

    expect(driver.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "lean-proof-v1",
        targetDeclaration: "Flow.Proof.add_zero",
        specification: specification,
        statement,
        proof,
        faithfulness: expect.objectContaining({
          authority: "human",
          approverIdentityHash: sha256("operator@example.test"),
          specificationDigest: sha256(specification),
          statementDigest: sha256(statement),
        }),
        proofModel: {
          selectionRule: "exact-model-v1",
          fallback: "deny",
          provider: "operator-provider",
          model: "proof-model-1",
          thinking: "high",
        },
      }),
      expect.objectContaining({
        runId: "run-1",
        workflowId: "proof-workflow",
        nodeId: "verify-proof",
        attempt: 1,
        cwd: "/private/workspace",
        timeoutMs: 300_000,
      }),
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "verifier",
        driver: "lean-proof",
        result: "completed",
        verdict: "accepted",
        request: {
          specification,
          statement,
          proof,
        },
        execution: {
          cleanup: "confirmed",
          safeVerify: { status: "accepted" },
          nanoda: { status: "accepted" },
        },
      },
    });
  });

  it("fails before proof execution when human approval does not bind the exact sources", async () => {
    const driver = fakeProofDriver();
    const executor = new VerifierNodeExecutor(fakeCommandExecutor(), fakeAgentExecutor(), driver);
    const input = context();
    const approval = input.proofFaithfulnessApproval;
    if (approval === undefined) throw new Error("test approval is unavailable");
    const outcome = await executor.execute(proofVerifier(), {
      ...input,
      proofFaithfulnessApproval: {
        ...approval,
        evidence: approval.evidence.slice(0, 1),
      },
    });

    expect(driver.execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "verifier_inconclusive",
        sideEffectStatus: "none",
      },
      evidence: {
        driver: "lean-proof",
        result: "execution_failed",
        verdict: "inconclusive",
        request: null,
        execution: null,
      },
    });
  });

  it("preserves uncertain cleanup as an inconclusive side effect", async () => {
    const driver = fakeProofDriver((request) => ({
      ...acceptedExecution(request),
      cleanup: "unconfirmed",
    }));
    const executor = new VerifierNodeExecutor(fakeCommandExecutor(), fakeAgentExecutor(), driver);

    const outcome = await executor.execute(proofVerifier(), context());

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "verifier_inconclusive",
        sideEffectStatus: "uncertain",
      },
      evidence: {
        driver: "lean-proof",
        verdict: "inconclusive",
        execution: { cleanup: "unconfirmed" },
      },
    });
  });
});

const specification = "For every natural number n, n plus zero is n.";
const statement = "theorem add_zero (n : Nat) : n + 0 = n := by";
const proof = "  omega\n";

function proofVerifier(): CompiledVerifierNode {
  return {
    id: "verify-proof",
    type: "verifier",
    dependsOn: ["specification", "statement", "proof", "approve-statement"],
    verifier: {
      kind: "lean-proof",
      targetDeclaration: "Flow.Proof.add_zero",
      specification: { nodeId: "specification", field: "command.stdout" },
      statement: { nodeId: "statement", field: "command.stdout" },
      proof: { nodeId: "proof", field: "agent.text" },
      faithfulnessApprovalNodeId: "approve-statement",
      runtime: runtimeIdentity(),
      timeoutMs: 300_000,
    },
  };
}

function context(): NodeExecutionContext {
  return {
    runId: "run-1",
    workflowId: "proof-workflow",
    nodeId: "verify-proof",
    attempt: 1,
    cwd: "/private/workspace",
    protectedPaths: [],
    verifierSources: [
      source("specification", "command.stdout", specification),
      source("statement", "command.stdout", statement),
      {
        ...source("proof", "agent.text", proof),
        proofModel: {
          selectionRule: "exact-model-v1",
          fallback: "deny",
          provider: "operator-provider",
          model: "proof-model-1",
          thinking: "high",
        },
      },
    ],
    proofFaithfulnessApproval: {
      nodeId: "approve-statement",
      actor: "operator@example.test",
      approvedAt: "2026-08-24T10:00:00.000Z",
      requestDigest: "9".repeat(64),
      evidence: [
        {
          sourceNodeId: "specification",
          sourceAttempt: 1,
          sourceField: "command.stdout",
          sourceHash: sha256(specification),
        },
        {
          sourceNodeId: "statement",
          sourceAttempt: 1,
          sourceField: "command.stdout",
          sourceHash: sha256(statement),
        },
      ],
    },
  };
}

function source(sourceNodeId: string, sourceField: "command.stdout" | "agent.text", value: string) {
  return {
    sourceNodeId,
    sourceAttempt: 1,
    sourceField,
    sourceHash: sha256(value),
    value,
    truncated: false,
  } as const;
}

function fakeProofDriver(
  result: (request: LeanProofRequest) => LeanProofExecutionEvidence = acceptedExecution,
): LeanProofDriver & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async (request: LeanProofRequest) => result(request)),
  };
}

function acceptedExecution(request: LeanProofRequest): LeanProofExecutionEvidence {
  return {
    version: 1,
    requestDigest: request.requestDigest,
    runtimeIdentity: request.runtime,
    compiler: {
      status: "accepted",
      targetDeclaration: request.targetDeclaration,
      statementDigest: request.statementDigest,
      environmentDigest: "4".repeat(64),
      durationMs: 120,
    },
    safeVerify: {
      status: "accepted",
      targetDeclaration: request.targetDeclaration,
      statementDigest: request.statementDigest,
      environmentDigest: "4".repeat(64),
      observedAxioms: ["propext", "Quot.sound", "Classical.choice"],
      reasonCode: "accepted",
      durationMs: 40,
    },
    nanoda: {
      status: "accepted",
      environmentDigest: "4".repeat(64),
      reasonCode: "accepted",
      durationMs: 25,
    },
    cleanup: "confirmed",
  };
}

function runtimeIdentity() {
  return {
    version: 1 as const,
    platform: "linux" as const,
    architecture: "x64" as const,
    imageDigest: `sha256:${"a".repeat(64)}`,
    buildAttestationDigest: "b".repeat(64),
    dependencyManifestDigest: "c".repeat(64),
    leanVersion: "4.33.1",
    mathlibRevision: "d".repeat(64),
    safeVerifyRevision: "e".repeat(64),
    nanodaRevision: "1".repeat(64),
    profileDigest: "2".repeat(64),
  };
}

function fakeCommandExecutor(): CommandExecutor {
  return { execute: vi.fn() };
}

function fakeAgentExecutor(): AgentExecutor {
  return { execute: vi.fn() };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
