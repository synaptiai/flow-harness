import { describe, expect, it } from "vitest";

import {
  CONTEXT_COMPACTION_EVALUATION_MODES,
  ContextCompactionEvaluationPlanError,
  createContextCompactionEvaluationSchedule,
  parseContextCompactionEvaluationPlanText,
} from "../../../src/domain/evaluation/context-compaction-evaluation.js";

const digest = "a".repeat(64);

describe("context compaction evaluation plan", () => {
  it("admits holdout tasks and schedules every three-mode order in six-seed blocks", () => {
    const plan = parseContextCompactionEvaluationPlanText(planText());
    const schedule = createContextCompactionEvaluationSchedule(
      digest,
      plan.suite.tasks.map((task) => task.id),
      plan.seeds,
    );

    expect(plan.kind).toBe("ContextCompactionEvaluationPlan");
    expect(plan.modes).toEqual(CONTEXT_COMPACTION_EVALUATION_MODES);
    expect(schedule).toHaveLength(18);
    expect(
      Array.from({ length: 6 }, (_, index) =>
        schedule.slice(index * 3, index * 3 + 3).map((trial) => trial.profileId),
      ),
    ).toEqual([
      ["none", "references", "references-and-summary"],
      ["none", "references-and-summary", "references"],
      ["references", "none", "references-and-summary"],
      ["references", "references-and-summary", "none"],
      ["references-and-summary", "none", "references"],
      ["references-and-summary", "references", "none"],
    ]);
    for (const mode of CONTEXT_COMPACTION_EVALUATION_MODES) {
      expect(
        [0, 1, 2].map(
          (position) =>
            schedule.filter((trial, index) => trial.profileId === mode && index % 3 === position)
              .length,
        ),
      ).toEqual([2, 2, 2]);
    }
  });

  it.each([
    ["five seeds", planText().replace("  - 16\n", "")],
    ["non-holdout task", planText().replace("partition: holdout", "partition: regression")],
    [
      "missing constraint assertion",
      planText().replace("constraintAssertionIndexes: [0]", "constraintAssertionIndexes: []"),
    ],
    [
      "reordered modes",
      planText().replace(
        "modes: [none, references, references-and-summary]",
        "modes: [references, none, references-and-summary]",
      ),
    ],
  ])("rejects %s", (_label, source) => {
    expect(() => parseContextCompactionEvaluationPlanText(source)).toThrow(
      ContextCompactionEvaluationPlanError,
    );
  });
});

function planText(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ContextCompactionEvaluationPlan
metadata:
  id: reference-first-compaction
suite:
  id: context-compaction-holdout
  version: 1.0.0
  tasks:
    - id: preserve-release-policy
      partition: holdout
      fixture: fixtures/release-policy
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions:
          - kind: sha256
            path: release-policy.txt
            value: ${"b".repeat(64)}
      protectedConstraints:
        - Never change release policy.
      constraintAssertionIndexes: [0]
profile:
  adapter: flow-workflow-v1
  workflow: workflows/agent.yaml
controls:
  model:
    provider: test-provider
    id: test-model
    thinking: low
  budget:
    maxNodeStarts: 8
    maxModelTokens: 100000
    maxCostUsdMicros: 1000000
    maxExecutionMs: 60000
    maxArtifactBytes: 1048576
  network: deny
  retry:
    providerRetries: 0
    harnessRetries: 0
  compaction:
    minimumReductionBytes: 1024
    summaryOutputTokenLimits: [512, 256]
seeds:
  - 11
  - 12
  - 13
  - 14
  - 15
  - 16
modes: [none, references, references-and-summary]
order: six-order-balanced-v1
comparison:
  minimumPairedTrials: 6
  maxVerifiedSuccessRegression: 0
  maxTotalTokenIncreaseRate: 0.1
  maxConstraintLosses: 0
`;
}
