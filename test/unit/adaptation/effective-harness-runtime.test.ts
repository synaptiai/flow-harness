import { describe, expect, it } from "vitest";

import {
  calculateEffectiveHarnessRuntimeDigest,
  createEffectiveHarnessRuntimeSnapshot,
  EffectiveHarnessRuntimeError,
  parseEffectiveHarnessRuntimeSnapshot,
  restoreEffectiveHarnessRuntimeState,
} from "../../../src/domain/adaptation/effective-harness-runtime.js";
import {
  compileEffectiveHarnessState,
  createEffectiveHarnessHeadIdentity,
} from "../../../src/domain/adaptation/effective-harness-state.js";
import {
  calculateCapabilitySnapshotDigest,
  combineCapabilitySnapshots,
  createEffectiveHarnessCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import { createPolicyPackageSnapshot } from "../../../src/domain/capability/policy-packages.js";
import { bindWorkflowCapabilities } from "../../../src/domain/capability/workflow-capabilities.js";
import { effectiveHarnessCandidateArtifactFixture } from "../../fixtures/effective-harness-evaluation.js";

describe("effective harness runtime snapshots", () => {
  it("reconstructs the exact state from one compact runtime proof and package closure", () => {
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const head = activeHead(artifact);

    const runtime = createEffectiveHarnessRuntimeSnapshot({
      state: artifact.candidateState,
      head,
    });

    expect(runtime).toMatchObject({
      version: 1,
      kind: "effective-harness-runtime",
      scopeDigest: artifact.candidateState.scopeDigest,
      workflowId: artifact.candidateState.workflowId,
      head,
      workflow: artifact.candidateState.workflow,
      packageDigests: artifact.candidateState.packages.map((item) => item.digest),
      runtimeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      parseEffectiveHarnessRuntimeSnapshot(structuredClone(runtime), [
        ...artifact.candidateState.packages,
        currentPolicyPackage(),
      ]),
    ).toEqual(runtime);
    expect(
      restoreEffectiveHarnessRuntimeState(runtime, [
        ...artifact.candidateState.packages,
        currentPolicyPackage(),
      ]),
    ).toEqual(artifact.candidateState);
  });

  it("rejects missing, substituted, and ambient non-policy package authority", () => {
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const runtime = createEffectiveHarnessRuntimeSnapshot({
      state: artifact.candidateState,
      head: activeHead(artifact),
    });
    const selected = artifact.candidateState.packages[0];
    if (selected === undefined) throw new Error("fixture package is missing");

    expect(() => restoreEffectiveHarnessRuntimeState(runtime, [])).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessRuntimeError>>({ code: "closure_mismatch" }),
    );
    expect(() =>
      restoreEffectiveHarnessRuntimeState(runtime, [{ ...selected, digest: "9".repeat(64) }]),
    ).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessRuntimeError>>({ code: "closure_mismatch" }),
    );
    expect(() =>
      restoreEffectiveHarnessRuntimeState(runtime, [
        ...artifact.candidateState.packages,
        { ...selected, name: "ambient", provenance: ".flow/skills/ambient" },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessRuntimeError>>({ code: "closure_mismatch" }),
    );
  });

  it("binds the runtime proof into a durable capability snapshot with current policy", () => {
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const effective = createEffectiveHarnessCapabilitySnapshot(
      artifact.candidateState,
      activeHead(artifact),
    );
    const policy = currentPolicyPackage();
    const policySnapshot = validateCapabilitySnapshot({
      version: 1,
      packages: [policy],
      digest: calculateCapabilitySnapshotDigest([policy]),
    });

    expect(validateCapabilitySnapshot(structuredClone(effective))).toEqual(effective);
    expect(combineCapabilitySnapshots([effective, policySnapshot])).toMatchObject({
      packages: [...artifact.candidateState.packages, policy],
      effectiveHarness: effective.effectiveHarness,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const forged = structuredClone(effective) as DeepMutable<typeof effective>;
    if (forged.effectiveHarness === undefined) throw new Error("runtime proof is missing");
    forged.effectiveHarness.runtimeDigest = "6".repeat(64);
    forged.digest = calculateCapabilitySnapshotDigest(
      effective.packages,
      effective.activations,
      forged.effectiveHarness,
    );
    expect(() => validateCapabilitySnapshot(forged)).toThrow(/runtime/i);
  });

  it("admits a package-free effective baseline as the workflow's exact authority", () => {
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const state = artifact.baselineState;
    const head = createEffectiveHarnessHeadIdentity({
      scopeDigest: state.scopeDigest,
      workflowId: state.workflowId,
      generation: 4,
      activationDigest: "5".repeat(64),
      transitionDigest: "4".repeat(64),
      stateDigest: state.stateDigest,
    });
    const snapshot = createEffectiveHarnessCapabilitySnapshot(state, head);

    expect(snapshot.packages).toEqual([]);
    expect(bindWorkflowCapabilities(compileEffectiveHarnessState(state), snapshot)).toEqual(
      snapshot,
    );
  });

  it.each([
    {
      label: "workflow bytes",
      mutate: (runtime: MutableRuntime) => {
        runtime.workflow.contentBase64 = Buffer.from("PRIVATE_WORKFLOW").toString("base64");
        runtime.runtimeDigest = calculateEffectiveHarnessRuntimeDigest(runtime);
      },
    },
    {
      label: "package digest",
      mutate: (runtime: MutableRuntime) => {
        runtime.packageDigests[0] = "8".repeat(64);
        runtime.runtimeDigest = calculateEffectiveHarnessRuntimeDigest(runtime);
      },
    },
    {
      label: "runtime digest",
      mutate: (runtime: MutableRuntime) => {
        runtime.runtimeDigest = "7".repeat(64);
      },
    },
  ])("rejects a redigested $label substitution without private output", ({ mutate }) => {
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const runtime = structuredClone(
      createEffectiveHarnessRuntimeSnapshot({
        state: artifact.candidateState,
        head: activeHead(artifact),
      }),
    ) as MutableRuntime;
    mutate(runtime);

    try {
      parseEffectiveHarnessRuntimeSnapshot(runtime, artifact.candidateState.packages);
      throw new Error("mutated runtime snapshot unexpectedly parsed");
    } catch (error) {
      expect(error).toBeInstanceOf(EffectiveHarnessRuntimeError);
      expect((error as Error).message).not.toContain("PRIVATE");
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

function activeHead(artifact: ReturnType<typeof effectiveHarnessCandidateArtifactFixture>) {
  return createEffectiveHarnessHeadIdentity({
    scopeDigest: artifact.candidateState.scopeDigest,
    workflowId: artifact.candidateState.workflowId,
    generation: artifact.baselineHead.generation + 1,
    activationDigest: artifact.artifactDigest,
    transitionDigest: "d".repeat(64),
    stateDigest: artifact.candidateState.stateDigest,
  });
}

function currentPolicyPackage() {
  return createPolicyPackageSnapshot({
    kind: "policy-package",
    trust: "project-explicit",
    provenance: ".flow/policies/current",
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: current
  version: 1.0.0
  description: Require command approval for the current run.
spec:
  commands:
    requireApproval: true
`),
    },
  });
}

type DeepMutable<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
      : Value;

type MutableRuntime = DeepMutable<ReturnType<typeof createEffectiveHarnessRuntimeSnapshot>>;
