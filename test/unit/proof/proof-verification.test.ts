import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createLeanProofRequest,
  decideLeanProofVerification,
  LeanProofContractError,
  type LeanProofExecutionEvidence,
  projectPublicLeanProofEvidence,
} from "../../../src/domain/proof/lean-proof-verification.js";

const digest = (value: string): string => value.repeat(64).slice(0, 64);

describe("Lean proof verification contract", () => {
  it("binds bounded private content to an exact runtime and human faithfulness approval", () => {
    const request = createLeanProofRequest(requestInput());

    expect(request).toMatchObject({
      version: 1,
      kind: "lean-proof-v1",
      targetDeclaration: "Flow.Proof.add_zero",
      runtime: {
        platform: "linux",
        architecture: "x64",
        leanVersion: "4.33.1",
        imageDigest: `sha256:${digest("a")}`,
      },
      faithfulness: {
        authority: "human",
        specificationDigest: request.specificationDigest,
        statementDigest: request.statementDigest,
      },
      proofModel: {
        selectionRule: "exact-model-v1",
        fallback: "deny",
        provider: "operator-provider",
        model: "proof-model-1",
      },
    });
    expect(request.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(request.specificationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(request.statementDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(request.proofDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a faithfulness approval for different content", () => {
    expect(() =>
      createLeanProofRequest({
        ...requestInput(),
        faithfulness: {
          ...requestInput().faithfulness,
          statementDigest: digest("f"),
        },
      }),
    ).toThrowError(
      new LeanProofContractError(
        "faithfulness_mismatch",
        "human faithfulness approval does not bind the exact specification and statement",
      ),
    );
  });

  it("requires one exact theorem header and a separate by-term proof", () => {
    expect(() =>
      createLeanProofRequest({
        ...requestInput(),
        statement: "theorem Flow.Proof.add_zero (n : Nat) : n + 0 = n := by",
      }),
    ).toThrow(/header|statement/i);

    expect(() =>
      createLeanProofRequest({
        ...requestInput(),
        statement: "theorem Other.add_zero (n : Nat) : n + 0 = n",
      }),
    ).toThrow(/target declaration/i);

    expect(() =>
      createLeanProofRequest({
        ...requestInput(),
        proof: "omega",
      }),
    ).toThrow(/by-term/i);
  });

  it("accepts Lean declaration delimiters and trailing apostrophes consistently", () => {
    const input = requestInput();
    const statement = "theorem Flow.Proof.identity'\n  (value : Nat) : value = value";
    const request = createLeanProofRequest({
      ...input,
      statement,
      targetDeclaration: "Flow.Proof.identity'",
      faithfulness: {
        ...input.faithfulness,
        statementDigest: sha256(statement),
      },
    });

    expect(request.targetDeclaration).toBe("Flow.Proof.identity'");
  });

  it("accepts only matching compiler, kernel replay, independent checker, and cleanup evidence", () => {
    const request = createLeanProofRequest(requestInput());
    const decision = decideLeanProofVerification(request, acceptedEvidence(request));

    expect(decision).toEqual({
      verdict: "accepted",
      reason:
        "both proof checkers accepted the exact compiled declaration and cleanup is confirmed",
      reasonCode: "proof_accepted",
    });
  });

  it("does not accept compilation without complete independent proof evidence", () => {
    const request = createLeanProofRequest(requestInput());
    const evidence = {
      ...acceptedEvidence(request),
      nanoda: { status: "unavailable", durationMs: 0, reasonCode: "output_missing" },
    } as const satisfies LeanProofExecutionEvidence;

    expect(decideLeanProofVerification(request, evidence)).toEqual({
      verdict: "inconclusive",
      reason: "independent proof-checker evidence is unavailable",
      reasonCode: "independent_checker_unavailable",
    });
  });

  it("treats checker disagreement as inconclusive instead of choosing one checker", () => {
    const request = createLeanProofRequest(requestInput());
    const evidence = {
      ...acceptedEvidence(request),
      nanoda: {
        status: "rejected",
        environmentDigest: digest("4"),
        reasonCode: "environment_rejected",
        durationMs: 25,
      },
    } as const satisfies LeanProofExecutionEvidence;

    expect(decideLeanProofVerification(request, evidence)).toEqual({
      verdict: "inconclusive",
      reason: "the kernel-replay and independent proof checkers disagree",
      reasonCode: "checker_disagreement",
    });
  });

  it("rejects a proof that uses authority outside the closed axiom policy", () => {
    const request = createLeanProofRequest(requestInput());
    const evidence = {
      ...acceptedEvidence(request),
      safeVerify: {
        status: "rejected",
        targetDeclaration: request.targetDeclaration,
        statementDigest: request.statementDigest,
        environmentDigest: digest("4"),
        reasonCode: "disallowed_axiom",
        observedAxioms: ["Classical.choice", "Flow.assumed"],
        durationMs: 40,
      },
      nanoda: {
        ...acceptedEvidence(request).nanoda,
        status: "not_run",
        reasonCode: "prior_check_rejected",
      },
    } as const satisfies LeanProofExecutionEvidence;

    expect(decideLeanProofVerification(request, evidence)).toEqual({
      verdict: "rejected",
      reason: "kernel replay rejected the proof under the closed authority policy",
      reasonCode: "kernel_replay_rejected",
    });
  });

  it("requires confirmed cleanup even after both proof checkers accept", () => {
    const request = createLeanProofRequest(requestInput());
    const evidence = {
      ...acceptedEvidence(request),
      cleanup: "unconfirmed",
    } as const satisfies LeanProofExecutionEvidence;

    expect(decideLeanProofVerification(request, evidence)).toEqual({
      verdict: "inconclusive",
      reason: "proof runtime cleanup is unconfirmed",
      reasonCode: "cleanup_unconfirmed",
    });
  });

  it("projects content-free public evidence", () => {
    const request = createLeanProofRequest(requestInput());
    const publicEvidence = projectPublicLeanProofEvidence(request, acceptedEvidence(request));
    const serialized = JSON.stringify(publicEvidence);

    expect(publicEvidence).toMatchObject({
      version: 1,
      requestDigest: request.requestDigest,
      specification: { digest: request.specificationDigest, bytes: 45 },
      statement: { digest: request.statementDigest, bytes: 49 },
      proof: { digest: request.proofDigest, bytes: 11 },
      targetDeclaration: {
        digest: sha256("Flow.Proof.add_zero"),
        bytes: 19,
      },
      cleanup: "confirmed",
    });
    expect(serialized).not.toContain(request.specification);
    expect(serialized).not.toContain(request.statement);
    expect(serialized).not.toContain(request.proof);
    expect(serialized).not.toContain("private-project-path");
  });
});

function requestInput() {
  const specification = "For every natural number n, n plus zero is n.";
  const statement = "theorem Flow.Proof.add_zero (n : Nat) : n + 0 = n";
  return {
    specification,
    statement,
    proof: "by\n  omega\n",
    targetDeclaration: "Flow.Proof.add_zero",
    runtime: {
      version: 1 as const,
      platform: "linux" as const,
      architecture: "x64" as const,
      imageDigest: `sha256:${digest("a")}`,
      buildAttestationDigest: digest("b"),
      dependencyManifestDigest: digest("c"),
      leanVersion: "4.33.1",
      mathlibRevision: "d".repeat(40),
      safeVerifyRevision: "e".repeat(40),
      nanodaRevision: "1".repeat(40),
      profileDigest: digest("2"),
    },
    faithfulness: {
      version: 1 as const,
      authority: "human" as const,
      approverIdentityHash: digest("3"),
      approvedAt: "2026-08-24T10:00:00.000Z",
      specificationDigest: sha256(specification),
      statementDigest: sha256(statement),
    },
    proofModel: {
      selectionRule: "exact-model-v1" as const,
      fallback: "deny" as const,
      provider: "operator-provider",
      model: "proof-model-1",
      thinking: "high" as const,
    },
  };
}

function acceptedEvidence(
  request: ReturnType<typeof createLeanProofRequest>,
): LeanProofExecutionEvidence {
  return {
    version: 1,
    requestDigest: request.requestDigest,
    runtimeIdentity: request.runtime,
    compiler: {
      status: "accepted",
      targetDeclaration: request.targetDeclaration,
      statementDigest: request.statementDigest,
      environmentDigest: digest("4"),
      durationMs: 120,
    },
    safeVerify: {
      status: "accepted",
      targetDeclaration: request.targetDeclaration,
      statementDigest: request.statementDigest,
      environmentDigest: digest("4"),
      observedAxioms: ["propext", "Quot.sound", "Classical.choice"],
      reasonCode: "accepted",
      durationMs: 40,
    },
    nanoda: {
      status: "accepted",
      environmentDigest: digest("4"),
      reasonCode: "accepted",
      durationMs: 25,
    },
    cleanup: "confirmed",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
