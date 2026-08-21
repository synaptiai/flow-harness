import { describe, expect, it } from "vitest";

import {
  calculateCapabilitySnapshotDigest,
  combineCapabilitySnapshots,
  createGoalWorkspaceCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  createGoalWorkspaceRevision,
  parseGoalWorkspaceSourceText,
} from "../../../src/domain/goal/workspace.js";

describe("goal workspace capability snapshot", () => {
  it("creates and validates a goal-only selected run surface", () => {
    const goalWorkspace = revision(1, null, "First objective.");
    const snapshot = createGoalWorkspaceCapabilitySnapshot(goalWorkspace);

    expect(snapshot).toEqual({
      version: 1,
      packages: [],
      goalWorkspace,
      digest: calculateCapabilitySnapshotDigest([], [], undefined, undefined, goalWorkspace),
    });
    expect(validateCapabilitySnapshot(structuredClone(snapshot))).toEqual(snapshot);
  });

  it("rejects a changed workspace whose enclosing snapshot digest is stale", () => {
    const goalWorkspace = revision(1, null, "First objective.");
    const snapshot = createGoalWorkspaceCapabilitySnapshot(goalWorkspace);
    const changed = {
      ...snapshot,
      goalWorkspace: { ...goalWorkspace, objective: "PRIVATE_CHANGED_OBJECTIVE" },
    };

    expect(() => validateCapabilitySnapshot(changed)).toThrow(/goal workspace revision digest/i);
  });

  it("combines one identical workspace selection and rejects conflicting revisions", () => {
    const first = revision(1, null, "First objective.");
    const second = revision(2, first.digest, "Second objective.");
    const firstSnapshot = createGoalWorkspaceCapabilitySnapshot(first);

    expect(combineCapabilitySnapshots([firstSnapshot, firstSnapshot])).toEqual(firstSnapshot);
    expect(() =>
      combineCapabilitySnapshots([firstSnapshot, createGoalWorkspaceCapabilitySnapshot(second)]),
    ).toThrow(/conflicting goal workspace selections/i);
  });

  it("binds workspace identity independently of other selected surfaces", () => {
    const first = revision(1, null, "First objective.");
    const second = revision(2, first.digest, "Second objective.");

    expect(calculateCapabilitySnapshotDigest([], [], undefined, undefined, first)).not.toBe(
      calculateCapabilitySnapshotDigest([], [], undefined, undefined, second),
    );
    expect(calculateCapabilitySnapshotDigest([], [], undefined, undefined, first)).not.toBe(
      calculateCapabilitySnapshotDigest([]),
    );
  });
});

function revision(revisionNumber: number, previousDigest: string | null, objective: string) {
  return createGoalWorkspaceRevision(
    parseGoalWorkspaceSourceText(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "GoalWorkspace",
        objective,
        facts: [],
        invariants: [],
        verifiedFacts: [],
        openQuestions: [],
        nextAction: { id: "continue", text: "Continue." },
      }),
      "goal.json",
    ),
    [],
    {
      revision: revisionNumber,
      previousDigest,
      at: `2026-08-21T10:${String(revisionNumber).padStart(2, "0")}:00.000Z`,
    },
  );
}
