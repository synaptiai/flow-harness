import { describe, expect, it } from "vitest";

import type { NodeEffectJournal } from "../../../../src/application/ports.js";
import {
  EMPTY_DIRECTORY_STATE_SHA256,
  MAX_AGENT_EFFECT_RECEIPTS,
} from "../../../../src/domain/run/events.js";
import {
  AgentEffectAuditClosedError,
  AgentEffectAuditLimitError,
  AgentEffectRecorder,
  AgentEffectReservationError,
} from "../../../../src/infrastructure/pi/agent-effect-recorder.js";

const attribution = {
  runId: "run-edit",
  workflowId: "edit-workflow",
  nodeId: "implement",
  attempt: 1,
} as const;

describe("AgentEffectRecorder", () => {
  it("projects a durably settled journal effect into its receipt snapshot", async () => {
    const preparedDescriptors: unknown[] = [];
    const journal = journalThatRecords(preparedDescriptors);
    const recorder = new AgentEffectRecorder(attribution, journal);
    const reservation = recorder.reserve(effectIdentity());

    await reservation.prepare({
      beforeSha256: "a".repeat(64),
      afterSha256: "b".repeat(64),
      mode: 0o640,
    });
    const receipt = await reservation.settle({
      outcome: "committed",
      reason: "directory_synced",
    });

    expect(preparedDescriptors).toEqual([
      {
        ...effectIdentity(),
        beforeSha256: "a".repeat(64),
        afterSha256: "b".repeat(64),
        mode: 0o640,
      },
    ]);
    expect(receipt).toMatchObject({ sequence: 1, outcome: "committed" });
    expect(recorder.snapshot()).toEqual([receipt]);
  });

  it("projects a create receipt with an explicit absent pre-state", async () => {
    const preparedDescriptors: unknown[] = [];
    const recorder = new AgentEffectRecorder(attribution, journalThatRecords(preparedDescriptors));
    const reservation = recorder.reserve({
      kind: "filesystem.create",
      target: "/workspace/MIGRATIONS.md",
      operationDigest: "e".repeat(64),
    });

    await reservation.prepare({
      beforeSha256: null,
      afterSha256: "f".repeat(64),
      mode: 0o644,
    });
    await reservation.settle({ outcome: "committed", reason: "directory_synced" });

    expect(preparedDescriptors).toEqual([
      {
        kind: "filesystem.create",
        target: "/workspace/MIGRATIONS.md",
        operationDigest: "e".repeat(64),
        beforeSha256: null,
        afterSha256: "f".repeat(64),
        mode: 0o644,
      },
    ]);
    expect(recorder.snapshot()).toEqual([
      expect.objectContaining({ kind: "filesystem.create", beforeSha256: null }),
    ]);
  });

  it("projects only the fixed empty-directory state for mkdir", async () => {
    const preparedDescriptors: unknown[] = [];
    const recorder = new AgentEffectRecorder(attribution, journalThatRecords(preparedDescriptors));
    const reservation = recorder.reserve({
      kind: "filesystem.mkdir",
      target: "/workspace/src/new-package",
      operationDigest: "d".repeat(64),
    });

    await reservation.prepare({
      beforeSha256: null,
      afterSha256: EMPTY_DIRECTORY_STATE_SHA256,
      mode: 0o755,
    });
    await reservation.settle({ outcome: "committed", reason: "directory_synced" });

    expect(preparedDescriptors).toEqual([
      {
        kind: "filesystem.mkdir",
        target: "/workspace/src/new-package",
        operationDigest: "d".repeat(64),
        beforeSha256: null,
        afterSha256: EMPTY_DIRECTORY_STATE_SHA256,
        mode: 0o755,
      },
    ]);
    expect(recorder.snapshot()).toEqual([
      expect.objectContaining({ kind: "filesystem.mkdir", beforeSha256: null }),
    ]);
  });

  it.each([
    { afterSha256: "f".repeat(64), mode: 0o755 },
    { afterSha256: EMPTY_DIRECTORY_STATE_SHA256, mode: 0o700 },
  ])("rejects an invalid mkdir state before journal preparation", async (preparation) => {
    const recorder = new AgentEffectRecorder(attribution, journalThatRecords([]));
    const reservation = recorder.reserve({
      kind: "filesystem.mkdir",
      target: "/workspace/src/new-package",
      operationDigest: "d".repeat(64),
    });

    await expect(reservation.prepare({ beforeSha256: null, ...preparation })).rejects.toThrow(
      /filesystem\.mkdir/i,
    );
  });

  it("rejects edit/create pre-state mismatches before journal preparation", async () => {
    const recorder = new AgentEffectRecorder(attribution, journalThatRecords([]));
    const create = recorder.reserve({
      kind: "filesystem.create",
      target: "/workspace/new.ts",
      operationDigest: "e".repeat(64),
    });

    await expect(create.prepare(effectPreparation("a", "b"))).rejects.toThrow(/absent/i);
  });

  it("records immutable, contiguous, attributable edit receipts", async () => {
    const recorder = new AgentEffectRecorder(attribution, journalThatRecords([]));
    const first = recorder.reserve(effectIdentity());
    const second = recorder.reserve(effectIdentity());

    await first.prepare(effectPreparation("a", "b"));
    await second.prepare(effectPreparation("b", "c"));
    await second.settle({ outcome: "unknown", reason: "post_commit_failure" });
    await first.settle({ outcome: "committed", reason: "directory_synced" });

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

  it("counts not-applied preparations against the durable audit limit", async () => {
    const preparedDescriptors: unknown[] = [];
    const recorder = new AgentEffectRecorder(attribution, journalThatRecords(preparedDescriptors));

    for (let index = 0; index < MAX_AGENT_EFFECT_RECEIPTS; index += 1) {
      const reservation = recorder.reserve({
        ...effectIdentity(),
        target: `/workspace/source-${index}.ts`,
      });
      await reservation.prepare(effectPreparation("a", "b"));
      await reservation.settle({ outcome: "not_applied", reason: "commit_not_entered" });
    }

    expect(preparedDescriptors).toHaveLength(MAX_AGENT_EFFECT_RECEIPTS);
    expect(recorder.snapshot()).toEqual([]);
    expect(() => recorder.reserve(effectIdentity())).toThrowError(AgentEffectAuditLimitError);
  });

  it("rejects a journal receipt whose hashes differ from the prepared descriptor", async () => {
    const journal: NodeEffectJournal = {
      prepare: async (descriptor) => ({
        effectId: "effect-3",
        effectSequence: 1,
        settle: async () => ({
          version: 1,
          sequence: 1,
          ...attribution,
          kind: descriptor.kind,
          target: descriptor.target,
          operationDigest: descriptor.operationDigest,
          beforeSha256: descriptor.beforeSha256,
          afterSha256: "c".repeat(64),
          outcome: "committed",
        }),
      }),
    };
    const reservation = new AgentEffectRecorder(attribution, journal).reserve(effectIdentity());
    await reservation.prepare(effectPreparation("a", "b"));

    await expect(
      reservation.settle({ outcome: "committed", reason: "directory_synced" }),
    ).rejects.toThrowError(AgentEffectReservationError);
  });

  it("rejects a journal result that contradicts the requested settlement", async () => {
    const journal: NodeEffectJournal = {
      prepare: async (descriptor) => ({
        effectId: "effect-3",
        effectSequence: 1,
        settle: async () => ({
          version: 1,
          sequence: 1,
          ...attribution,
          kind: descriptor.kind,
          target: descriptor.target,
          operationDigest: descriptor.operationDigest,
          beforeSha256: descriptor.beforeSha256,
          afterSha256: descriptor.afterSha256,
          outcome: "committed",
        }),
      }),
    };
    const reservation = new AgentEffectRecorder(attribution, journal).reserve(effectIdentity());
    await reservation.prepare(effectPreparation("a", "b"));

    await expect(
      reservation.settle({ outcome: "not_applied", reason: "commit_not_entered" }),
    ).rejects.toThrowError(AgentEffectReservationError);
  });

  it("releases cancelled reservations without recording an effect", async () => {
    const recorder = new AgentEffectRecorder(attribution);
    const reservation = recorder.reserve(effectIdentity());

    reservation.cancel();
    reservation.cancel();

    expect(recorder.snapshot()).toEqual([]);
    await expect(reservation.prepare(effectPreparation("a", "b"))).rejects.toThrowError(
      /not active/i,
    );
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

  it("closes the audit and rejects new or outstanding effects", async () => {
    const recorder = new AgentEffectRecorder(attribution);
    const reservation = recorder.reserve(effectIdentity());

    expect(recorder.close()).toEqual([]);
    expect(() => recorder.reserve(effectIdentity())).toThrowError(AgentEffectAuditClosedError);
    await expect(reservation.prepare(effectPreparation("a", "b"))).rejects.toThrowError(
      AgentEffectAuditClosedError,
    );
  });
});

function journalThatRecords(preparedDescriptors: unknown[]): NodeEffectJournal {
  let effectSequence = 0;
  return {
    prepare: async (descriptor) => {
      preparedDescriptors.push(structuredClone(descriptor));
      effectSequence += 1;
      const sequence = effectSequence;
      return {
        effectId: `effect-${sequence + 2}`,
        effectSequence: sequence,
        settle: async (settlement) =>
          settlement.outcome === "not_applied"
            ? null
            : {
                version: 1,
                sequence,
                ...attribution,
                kind: descriptor.kind,
                target: descriptor.target,
                operationDigest: descriptor.operationDigest,
                beforeSha256: descriptor.beforeSha256,
                afterSha256: descriptor.afterSha256,
                outcome: settlement.outcome === "committed" ? "committed" : "uncertain",
              },
      };
    },
  };
}

function effectIdentity() {
  return {
    kind: "filesystem.edit" as const,
    target: "/workspace/source.ts",
    operationDigest: "d".repeat(64),
  };
}

function effectPreparation(before: string, after: string) {
  return {
    beforeSha256: before.repeat(64),
    afterSha256: after.repeat(64),
    mode: 0o640,
  };
}
