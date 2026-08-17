import { describe, expect, it } from "vitest";

import {
  createEffectiveHarnessHeadIdentity,
  EffectiveHarnessStateError,
} from "../../../src/domain/adaptation/effective-harness-state.js";
import {
  calculateEffectiveHarnessTransitionDigest,
  createEffectiveHarnessTransition,
  effectiveHarnessHeadFromTransition,
  parseEffectiveHarnessTransition,
} from "../../../src/domain/adaptation/effective-harness-transition.js";

const scopeDigest = "a".repeat(64);

describe("effective harness transitions", () => {
  it("binds one complete state change to the exact prior head and evaluation", () => {
    const prior = priorHead();

    const transition = createEffectiveHarnessTransition({
      prior,
      toStateDigest: "f".repeat(64),
      toActivationDigest: "1".repeat(64),
      surface: "prompt",
      candidate: { kind: "prompt-candidate", digest: "2".repeat(64) },
      evaluation: {
        id: "evaluation-1",
        planDigest: "3".repeat(64),
        terminalRecordDigest: "4".repeat(64),
        reportDigest: "5".repeat(64),
      },
      actor: "operator:test",
      reason: "Keep both reviewed improvements.",
      changedAt: "2026-08-17T17:40:00.000Z",
    });

    expect(
      parseEffectiveHarnessTransition(structuredClone(transition), { scopeDigest, prior }),
    ).toEqual(transition);
    expect(transition).toMatchObject({
      version: 1,
      kind: "effective-harness-transition",
      scopeDigest,
      workflowId: "adaptive-workflow",
      generation: 3,
      fromActivationDigest: prior.activationDigest,
      fromStateDigest: prior.stateDigest,
      previousTransitionDigest: prior.transitionDigest,
      toActivationDigest: "1".repeat(64),
      toStateDigest: "f".repeat(64),
      surface: "prompt",
      candidate: { kind: "prompt-candidate", digest: "2".repeat(64) },
      evaluation: { id: "evaluation-1" },
      transitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(effectiveHarnessHeadFromTransition(transition)).toMatchObject({
      generation: 3,
      activationDigest: transition.toActivationDigest,
      transitionDigest: transition.transitionDigest,
      stateDigest: transition.toStateDigest,
    });
  });

  it.each([
    ["prompt", "agent-skill-candidate"],
    ["agent-skill-resource", "prompt-candidate"],
    ["agent-skill-package", "agent-skill-candidate"],
  ] as const)("rejects %s surface with %s authority", (surface, kind) => {
    expect(() =>
      createEffectiveHarnessTransition({
        prior: priorHead(),
        toStateDigest: "f".repeat(64),
        toActivationDigest: "1".repeat(64),
        surface,
        candidate: { kind, digest: "2".repeat(64) },
        evaluation: {
          id: "evaluation-1",
          planDigest: "3".repeat(64),
          terminalRecordDigest: "4".repeat(64),
          reportDigest: "5".repeat(64),
        },
        actor: "operator:test",
        changedAt: "2026-08-17T17:40:00.000Z",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessStateError>>({ code: "identity_mismatch" }),
    );
  });

  it("rejects an ABA transition whose expected prior head changed", () => {
    const original = priorHead();
    const transition = createEffectiveHarnessTransition({
      prior: original,
      toStateDigest: "f".repeat(64),
      toActivationDigest: "1".repeat(64),
      surface: "prompt",
      candidate: { kind: "prompt-candidate", digest: "2".repeat(64) },
      evaluation: {
        id: "evaluation-1",
        planDigest: "3".repeat(64),
        terminalRecordDigest: "4".repeat(64),
        reportDigest: "5".repeat(64),
      },
      actor: "operator:test",
      changedAt: "2026-08-17T17:40:00.000Z",
    });
    const aba = createEffectiveHarnessHeadIdentity({
      scopeDigest,
      workflowId: original.workflowId,
      generation: original.generation + 2,
      activationDigest: original.activationDigest,
      transitionDigest: "6".repeat(64),
      stateDigest: original.stateDigest,
    });

    expect(() =>
      parseEffectiveHarnessTransition(structuredClone(transition), { scopeDigest, prior: aba }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessStateError>>({ code: "stale_head" }),
    );
  });

  it("rejects redigested authority substitution without private causes", () => {
    const prior = priorHead();
    const transition = structuredClone(
      createEffectiveHarnessTransition({
        prior,
        toStateDigest: "f".repeat(64),
        toActivationDigest: "1".repeat(64),
        surface: "prompt",
        candidate: { kind: "prompt-candidate", digest: "2".repeat(64) },
        evaluation: {
          id: "evaluation-1",
          planDigest: "3".repeat(64),
          terminalRecordDigest: "4".repeat(64),
          reportDigest: "5".repeat(64),
        },
        actor: "operator:test",
        changedAt: "2026-08-17T17:40:00.000Z",
      }),
    ) as MutableTransition;
    transition.workflowId = "private-workflow";
    transition.transitionDigest = calculateEffectiveHarnessTransitionDigest(
      transition as unknown as ReturnType<typeof createEffectiveHarnessTransition>,
    );

    try {
      parseEffectiveHarnessTransition(transition, { scopeDigest, prior });
      throw new Error("mutated effective harness transition unexpectedly parsed");
    } catch (error) {
      expect(error).toBeInstanceOf(EffectiveHarnessStateError);
      expect((error as Error).message).not.toContain("private-workflow");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("does not derive a head from a redigested semantic contradiction", () => {
    const transition = structuredClone(
      createEffectiveHarnessTransition({
        prior: priorHead(),
        toStateDigest: "f".repeat(64),
        toActivationDigest: "1".repeat(64),
        surface: "prompt",
        candidate: { kind: "prompt-candidate", digest: "2".repeat(64) },
        evaluation: {
          id: "evaluation-1",
          planDigest: "3".repeat(64),
          terminalRecordDigest: "4".repeat(64),
          reportDigest: "5".repeat(64),
        },
        actor: "operator:test",
        changedAt: "2026-08-17T17:40:00.000Z",
      }),
    ) as MutableTransition;
    transition.surface = "agent-skill-resource";
    transition.transitionDigest = calculateEffectiveHarnessTransitionDigest(
      transition as unknown as ReturnType<typeof createEffectiveHarnessTransition>,
    );

    expect(() =>
      effectiveHarnessHeadFromTransition(
        transition as unknown as ReturnType<typeof createEffectiveHarnessTransition>,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessStateError>>({ code: "identity_mismatch" }),
    );
  });
});

type DeepMutable<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
      : Value;

type MutableTransition = DeepMutable<ReturnType<typeof createEffectiveHarnessTransition>>;

function priorHead() {
  return createEffectiveHarnessHeadIdentity({
    scopeDigest,
    workflowId: "adaptive-workflow",
    generation: 2,
    activationDigest: "b".repeat(64),
    transitionDigest: "c".repeat(64),
    stateDigest: "d".repeat(64),
  });
}
