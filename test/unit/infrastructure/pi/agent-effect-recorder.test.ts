import { describe, expect, it } from "vitest";

import { MAX_AGENT_EFFECT_RECEIPTS } from "../../../../src/domain/run/events.js";
import {
  AgentEffectAuditClosedError,
  AgentEffectAuditLimitError,
  AgentEffectRecorder,
} from "../../../../src/infrastructure/pi/agent-effect-recorder.js";

const attribution = {
  runId: "run-edit",
  workflowId: "edit-workflow",
  nodeId: "implement",
  attempt: 1,
} as const;

describe("AgentEffectRecorder", () => {
  it("records immutable, contiguous, attributable edit receipts", () => {
    const recorder = new AgentEffectRecorder(attribution);
    const first = recorder.reserve(effectIdentity());
    const second = recorder.reserve(effectIdentity());

    first.commit(effectOutcome("a", "b"));
    second.commit(effectOutcome("b", "c", "uncertain"));

    expect(recorder.snapshot()).toEqual([
      expect.objectContaining({
        version: 1,
        sequence: 1,
        ...attribution,
        beforeSha256: "a".repeat(64),
        afterSha256: "b".repeat(64),
        outcome: "committed",
      }),
      expect.objectContaining({ sequence: 2, outcome: "uncertain" }),
    ]);
    expect(Object.isFrozen(recorder.snapshot())).toBe(true);
    expect(recorder.snapshot().every(Object.isFrozen)).toBe(true);
  });

  it("releases cancelled reservations without recording an effect", () => {
    const recorder = new AgentEffectRecorder(attribution);
    const reservation = recorder.reserve(effectIdentity());

    reservation.cancel();
    reservation.cancel();

    expect(recorder.snapshot()).toEqual([]);
    expect(() => reservation.commit(effectOutcome("a", "b"))).toThrowError(/not active/i);
  });

  it("reserves bounded audit capacity before an effect can start", () => {
    const recorder = new AgentEffectRecorder(attribution);
    const reservations = Array.from({ length: MAX_AGENT_EFFECT_RECEIPTS }, () =>
      recorder.reserve(effectIdentity()),
    );

    expect(() => recorder.reserve(effectIdentity())).toThrowError(AgentEffectAuditLimitError);
    reservations[0]?.cancel();
    expect(() => recorder.reserve(effectIdentity())).not.toThrow();
  });

  it("waits until every active reservation is committed or cancelled", async () => {
    const recorder = new AgentEffectRecorder(attribution);
    const reservation = recorder.reserve({
      kind: "filesystem.edit",
      target: "/workspace/source.ts",
      operationDigest: "a".repeat(64),
    });
    let idle = false;
    const waiting = recorder.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    reservation.cancel();
    await waiting;

    expect(idle).toBe(true);
  });

  it("closes the audit and rejects new or outstanding effects", () => {
    const recorder = new AgentEffectRecorder(attribution);
    const reservation = recorder.reserve(effectIdentity());

    expect(recorder.close()).toEqual([]);
    expect(() => recorder.reserve(effectIdentity())).toThrowError(AgentEffectAuditClosedError);
    expect(() => reservation.commit(effectOutcome("a", "b"))).toThrowError(
      AgentEffectAuditClosedError,
    );
  });
});

function effectIdentity() {
  return {
    kind: "filesystem.edit" as const,
    target: "/workspace/source.ts",
    operationDigest: "d".repeat(64),
  };
}

function effectOutcome(
  before: string,
  after: string,
  outcome: "committed" | "uncertain" = "committed",
) {
  return {
    beforeSha256: before.repeat(64),
    afterSha256: after.repeat(64),
    outcome,
  };
}
