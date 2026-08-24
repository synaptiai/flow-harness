import { describe, expect, it } from "vitest";

import {
  type LeanProofQualificationInput,
  qualifyLeanProofProfile,
} from "../../../src/domain/evaluation/lean-proof-qualification.js";

const digest = (value: string): string => value.repeat(64).slice(0, 64);

describe("Lean proof profile qualification", () => {
  it("qualifies only complete proof, faithfulness, ordinary-test, policy, and lifecycle evidence", () => {
    const report = qualifyLeanProofProfile(qualificationInput());

    expect(report).toMatchObject({
      version: 1,
      kind: "lean-proof-qualification-report-v1",
      qualificationId: "proof-profile-release",
      qualificationInputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      verdict: "qualified",
      coverage: {
        tasks: 2,
        proofAccepted: 2,
        statementFaithfulnessApproved: 2,
        ordinaryTestsPassed: 2,
        costObserved: 2,
        latencyObserved: 2,
      },
      measurements: {
        totalCostUsdMicros: 30,
        totalLatencyMs: 300,
        maximumLatencyMs: 200,
      },
      failures: {
        proof: [],
        statementFaithfulness: [],
        ordinaryTests: [],
        policy: [],
        cleanup: [],
      },
      missing: [],
      taskResults: [
        expect.objectContaining({
          taskId: "addition-identity",
          requestDigest: digest("3"),
          specificationDigest: digest("1"),
          statementDigest: digest("2"),
          ordinaryTestSuiteDigest: digest("9"),
        }),
        expect.objectContaining({
          taskId: "multiplication-identity",
          requestDigest: digest("6"),
          specificationDigest: digest("4"),
          statementDigest: digest("5"),
          ordinaryTestSuiteDigest: digest("9"),
        }),
      ],
    });
    expect(report.reportDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes the admitted-input digest when a content-free task identity changes", () => {
    const original = qualificationInput();
    const changed = qualificationInput();
    changed.tasks[0] = {
      ...required(changed.tasks[0]),
      statementDigest: digest("7"),
    };
    const trial = required(changed.trials[0]);
    const faithfulness = trial.faithfulness;
    if (faithfulness === null) throw new Error("test fixture faithfulness is missing");
    changed.trials[0] = {
      ...trial,
      faithfulness: { ...faithfulness, statementDigest: digest("7") },
    };

    expect(qualifyLeanProofProfile(changed).qualificationInputDigest).not.toBe(
      qualifyLeanProofProfile(original).qualificationInputDigest,
    );
  });

  it("returns an exact failure verdict when complete evidence contains a failure", () => {
    const input = qualificationInput();
    input.trials[0] = {
      ...required(input.trials[0]),
      proof: {
        verdict: "rejected",
        reasonCode: "kernel_replay_rejected",
        compiler: "accepted",
        safeVerify: "rejected",
        nanoda: "rejected",
      },
      ordinaryTests: { status: "failed", suiteDigest: digest("9") },
      policyFailures: ["source_policy_rejected"],
      cleanup: "unconfirmed",
    };

    expect(qualifyLeanProofProfile(input)).toMatchObject({
      verdict: "not_qualified",
      coverage: { proofAccepted: 1 },
      failures: {
        proof: [{ taskId: "addition-identity", reasonCode: "kernel_replay_rejected" }],
        ordinaryTests: [{ taskId: "addition-identity", reasonCode: "tests_failed" }],
        policy: [{ taskId: "addition-identity", reasonCode: "source_policy_rejected" }],
        cleanup: [{ taskId: "addition-identity", reasonCode: "cleanup_unconfirmed" }],
      },
    });
  });

  it("reports explicit missingness instead of treating an incomplete trial as a failure", () => {
    const input = qualificationInput();
    input.trials[1] = {
      ...required(input.trials[1]),
      proof: null,
      faithfulness: null,
      ordinaryTests: { status: "missing", suiteDigest: null },
      costUsdMicros: null,
      latencyMs: null,
      cleanup: "missing",
    };

    expect(qualifyLeanProofProfile(input)).toMatchObject({
      verdict: "insufficient_evidence",
      coverage: {
        tasks: 2,
        proofAccepted: 1,
        statementFaithfulnessApproved: 1,
        ordinaryTestsPassed: 1,
        costObserved: 1,
        latencyObserved: 1,
      },
      missing: [
        { taskId: "multiplication-identity", field: "proof" },
        { taskId: "multiplication-identity", field: "statement_faithfulness" },
        { taskId: "multiplication-identity", field: "ordinary_tests" },
        { taskId: "multiplication-identity", field: "cost_usd_micros" },
        { taskId: "multiplication-identity", field: "latency_ms" },
        { taskId: "multiplication-identity", field: "cleanup" },
      ],
    });
  });

  it("treats identity drift and model-only faithfulness as qualification failures", () => {
    const input = qualificationInput();
    input.trials[0] = {
      ...required(input.trials[0]),
      requestDigest: digest("f"),
      runtime: { ...input.profile.runtime, imageDigest: `sha256:${digest("f")}` },
      faithfulness: {
        authority: "model",
        status: "approved",
        specificationDigest: digest("1"),
        statementDigest: digest("2"),
      },
    };

    expect(qualifyLeanProofProfile(input)).toMatchObject({
      verdict: "not_qualified",
      coverage: { proofAccepted: 1 },
      failures: {
        proof: expect.arrayContaining([
          { taskId: "addition-identity", reasonCode: "request_identity_mismatch" },
          { taskId: "addition-identity", reasonCode: "runtime_identity_mismatch" },
        ]),
        statementFaithfulness: [
          { taskId: "addition-identity", reasonCode: "human_approval_required" },
        ],
      },
      taskResults: [
        expect.objectContaining({ taskId: "addition-identity", proof: "failed" }),
        expect.objectContaining({ taskId: "multiplication-identity", proof: "accepted" }),
      ],
    });
  });

  it("rejects duplicate, omitted, and undeclared trial identities", () => {
    const duplicate = qualificationInput();
    duplicate.trials[1] = { ...required(duplicate.trials[0]) };
    expect(() => qualifyLeanProofProfile(duplicate)).toThrow(
      /exactly one trial per declared task/i,
    );

    const omitted = qualificationInput();
    omitted.trials.pop();
    expect(() => qualifyLeanProofProfile(omitted)).toThrow(/exactly one trial per declared task/i);

    const undeclared = qualificationInput();
    undeclared.trials[1] = {
      ...required(undeclared.trials[1]),
      taskId: "undeclared-task",
    };
    expect(() => qualifyLeanProofProfile(undeclared)).toThrow(
      /exactly one trial per declared task/i,
    );
  });

  it("rejects a selected profile digest that contradicts its runtime", () => {
    const input = qualificationInput();
    input.profile.profileDigest = digest("7");

    expect(() => qualifyLeanProofProfile(input)).toThrow(/profile.*runtime.*digest/i);
  });

  it("does not qualify an accepted verdict with a contradictory reason", () => {
    const input = qualificationInput();
    const trial = required(input.trials[0]);
    const proof = trial.proof;
    if (proof === null) throw new Error("test fixture proof is missing");
    input.trials[0] = {
      ...trial,
      proof: {
        ...proof,
        reasonCode: "kernel_replay_rejected",
      },
    };

    expect(qualifyLeanProofProfile(input)).toMatchObject({
      verdict: "not_qualified",
      failures: {
        proof: [{ taskId: "addition-identity", reasonCode: "proof_evidence_inconsistent" }],
      },
    });
  });
});

function qualificationInput(): LeanProofQualificationInput {
  const runtime = {
    version: 1 as const,
    platform: "linux" as const,
    architecture: "x64" as const,
    imageDigest: `sha256:${digest("a")}`,
    buildAttestationDigest: digest("b"),
    dependencyManifestDigest: digest("c"),
    leanVersion: "4.33.1",
    mathlibRevision: digest("d"),
    safeVerifyRevision: digest("e"),
    nanodaRevision: digest("f"),
    profileDigest: digest("0"),
  };
  return {
    version: 1,
    kind: "lean-proof-qualification-v1",
    qualificationId: "proof-profile-release",
    profile: { profileDigest: runtime.profileDigest, runtime },
    tasks: [
      {
        id: "addition-identity",
        requestDigest: digest("3"),
        specificationDigest: digest("1"),
        statementDigest: digest("2"),
      },
      {
        id: "multiplication-identity",
        requestDigest: digest("6"),
        specificationDigest: digest("4"),
        statementDigest: digest("5"),
      },
    ],
    trials: [
      trial("addition-identity", digest("3"), digest("1"), digest("2"), runtime, 10, 100),
      trial("multiplication-identity", digest("6"), digest("4"), digest("5"), runtime, 20, 200),
    ],
  };
}

function trial(
  taskId: string,
  requestDigest: string,
  specificationDigest: string,
  statementDigest: string,
  runtime: LeanProofQualificationInput["profile"]["runtime"],
  costUsdMicros: number,
  latencyMs: number,
) {
  return {
    taskId,
    requestDigest,
    runtime,
    proof: {
      verdict: "accepted" as const,
      reasonCode: "proof_accepted",
      compiler: "accepted" as const,
      safeVerify: "accepted" as const,
      nanoda: "accepted" as const,
    },
    faithfulness: {
      authority: "human" as const,
      status: "approved" as const,
      specificationDigest,
      statementDigest,
    },
    ordinaryTests: { status: "passed" as const, suiteDigest: digest("9") },
    costUsdMicros,
    latencyMs,
    policyFailures: [],
    cleanup: "confirmed" as const,
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("test fixture entry is missing");
  return value;
}
