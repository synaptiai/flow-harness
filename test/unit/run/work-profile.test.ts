import { describe, expect, it } from "vitest";

import type { RunBudgetState } from "../../../src/domain/run/budget.js";
import {
  createModelWorkProfileContext,
  WORK_PROFILE_UNBOUNDED,
} from "../../../src/domain/run/work-profile.js";

describe("model work-profile context", () => {
  it("projects exactly five current remaining dimensions", () => {
    const budget: RunBudgetState = {
      limits: {
        maxNodeStarts: 12,
        maxModelTokens: 2_000,
        maxCostUsdMicros: 75_000,
        maxExecutionMs: 90_000,
        maxArtifactBytes: 1_000_000,
      },
      remaining: {
        nodeStarts: 8,
        modelTokens: 1_500,
        modelCostUsdMicros: 70_000,
        executionMs: 82_000,
        artifactBytes: 900_000,
      },
      exhausted: [],
    };

    const context = createModelWorkProfileContext("long", budget);

    expect(context).toEqual({
      profile: "long",
      remaining: {
        nodeStarts: 8,
        modelTokens: 1_500,
        modelCostUsdMicros: 70_000,
        executionMs: 82_000,
        artifactBytes: 900_000,
      },
    });
    expect(Object.keys(context)).toEqual(["profile", "remaining"]);
    expect(Object.keys(context.remaining)).toEqual([
      "nodeStarts",
      "modelTokens",
      "modelCostUsdMicros",
      "executionMs",
      "artifactBytes",
    ]);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.remaining)).toBe(true);
  });

  it("marks every absent limit as unbounded without creating profile-specific numbers", () => {
    const contexts = (["fast", "standard", "long"] as const).map((profile) =>
      createModelWorkProfileContext(profile, null),
    );

    expect(contexts.map(({ remaining }) => remaining)).toEqual([
      contexts[0]?.remaining,
      contexts[0]?.remaining,
      contexts[0]?.remaining,
    ]);
    expect(contexts[0]).toEqual({
      profile: "fast",
      remaining: {
        nodeStarts: WORK_PROFILE_UNBOUNDED,
        modelTokens: WORK_PROFILE_UNBOUNDED,
        modelCostUsdMicros: WORK_PROFILE_UNBOUNDED,
        executionMs: WORK_PROFILE_UNBOUNDED,
        artifactBytes: WORK_PROFILE_UNBOUNDED,
      },
    });
  });

  it("marks only omitted budget dimensions as unbounded", () => {
    const context = createModelWorkProfileContext("standard", {
      limits: { maxNodeStarts: 4, maxArtifactBytes: 200 },
      remaining: { nodeStarts: 1, artifactBytes: 125 },
      exhausted: [],
    });

    expect(context.remaining).toEqual({
      nodeStarts: 1,
      modelTokens: WORK_PROFILE_UNBOUNDED,
      modelCostUsdMicros: WORK_PROFILE_UNBOUNDED,
      executionMs: WORK_PROFILE_UNBOUNDED,
      artifactBytes: 125,
    });
  });
});
