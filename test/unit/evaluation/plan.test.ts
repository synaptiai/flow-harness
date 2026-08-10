import { describe, expect, it } from "vitest";

import {
  createEvaluationSchedule,
  EvaluationPlanError,
  parseEvaluationPlanText,
} from "../../../src/domain/evaluation/plan.js";

describe("evaluation plan", () => {
  it("parses a closed bounded provider-neutral plan", () => {
    const plan = parseEvaluationPlanText(validPlan(), "evaluation.yaml");

    expect(plan).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "EvaluationPlan",
      metadata: { id: "harness-comparison" },
      suite: {
        id: "foundation-suite",
        version: "1.0.0",
        tasks: [
          {
            id: "edit-readme",
            partition: "holdout",
            fixture: "fixtures/edit-readme",
            instruction: "TASK.md",
          },
        ],
      },
      profiles: [
        { id: "baseline", adapter: "flow-workflow-v1", workflow: "baseline.workflow.yaml" },
        { id: "candidate", adapter: "flow-workflow-v1", workflow: "candidate.workflow.yaml" },
      ],
      controls: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
        network: "deny",
        retry: { providerRetries: 0, harnessRetries: 0 },
      },
      seeds: [11, 22],
      order: "paired-alternating-v1",
      comparison: {
        baselineProfileId: "baseline",
        candidateProfileId: "candidate",
        minimumPairedTrials: 2,
        confidenceLevel: 0.95,
        minimumEffect: 0,
      },
    });
  });

  it("rejects unknown fields and ambiguous profile identities", () => {
    expect(() =>
      parseEvaluationPlanText(validPlan().replace("order:", "unexpected: true\norder:")),
    ).toThrow(EvaluationPlanError);
    expect(() =>
      parseEvaluationPlanText(validPlan().replace("  - id: candidate", "  - id: baseline")),
    ).toThrow(/unique/i);
    expect(() =>
      parseEvaluationPlanText(
        validPlan().replace("candidateProfileId: candidate", "candidateProfileId: missing"),
      ),
    ).toThrow(/candidate.*profile/i);
  });

  it("admits exactly one direct-workflow or prompt-candidate source per profile", () => {
    const candidatePlan = validPlan().replace(
      "workflow: candidate.workflow.yaml",
      "candidate: better.prompt-candidate.yaml",
    );
    expect(parseEvaluationPlanText(candidatePlan).profiles[1]).toEqual({
      id: "candidate",
      adapter: "flow-workflow-v1",
      candidate: "better.prompt-candidate.yaml",
    });

    expect(() =>
      parseEvaluationPlanText(
        candidatePlan.replace(
          "candidate: better.prompt-candidate.yaml",
          "workflow: candidate.workflow.yaml\n    candidate: better.prompt-candidate.yaml",
        ),
      ),
    ).toThrow(/invalid_schema|unrecognized|exactly one/i);
    expect(() =>
      parseEvaluationPlanText(
        candidatePlan.replace("    candidate: better.prompt-candidate.yaml\n", ""),
      ),
    ).toThrow(/invalid_schema|required|exactly one/i);
  });

  it("parses only the built-in native Pi profile configuration", () => {
    const external = validPlan().replace(
      "  - id: candidate\n    adapter: flow-workflow-v1\n    workflow: candidate.workflow.yaml",
      "  - id: candidate\n    adapter: pi-native-v1\n    harness:\n      config: pi-evaluation-v1",
    );

    expect(parseEvaluationPlanText(external).profiles[1]).toEqual({
      id: "candidate",
      adapter: "pi-native-v1",
      harness: { config: "pi-evaluation-v1" },
    });
    expect(() =>
      parseEvaluationPlanText(external.replace("pi-evaluation-v1", "operator-command")),
    ).toThrow(/config|schema/i);
    expect(() =>
      parseEvaluationPlanText(
        external.replace(
          "      config: pi-evaluation-v1",
          "      config: pi-evaluation-v1\n      executable: /usr/bin/pi",
        ),
      ),
    ).toThrow(/executable|unrecognized|schema/i);
  });

  it("rejects a comparison minimum that exceeds the holdout pair schedule", () => {
    const mixed = validPlan()
      .replace(
        "profiles:",
        `    - id: tuning-task
      partition: tuning
      fixture: fixtures/edit-readme
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions:
          - kind: exists
            path: RESULT.md
profiles:`,
      )
      .replace("minimumPairedTrials: 2", "minimumPairedTrials: 3");

    expect(() => parseEvaluationPlanText(mixed)).toThrow(/holdout.*pair|paired.*holdout/i);
  });

  it("builds deterministic adjacent pairs with alternating leading profiles", () => {
    const schedule = createEvaluationSchedule(
      "a".repeat(64),
      ["task-a", "task-b"],
      ["baseline", "candidate"],
      [11, 22],
    );

    expect(
      schedule.map(({ taskId, profileId, seed, repetition, position }) => ({
        taskId,
        profileId,
        seed,
        repetition,
        position,
      })),
    ).toEqual([
      { taskId: "task-a", profileId: "baseline", seed: 11, repetition: 1, position: 1 },
      { taskId: "task-a", profileId: "candidate", seed: 11, repetition: 1, position: 2 },
      { taskId: "task-a", profileId: "candidate", seed: 22, repetition: 2, position: 3 },
      { taskId: "task-a", profileId: "baseline", seed: 22, repetition: 2, position: 4 },
      { taskId: "task-b", profileId: "baseline", seed: 11, repetition: 1, position: 5 },
      { taskId: "task-b", profileId: "candidate", seed: 11, repetition: 1, position: 6 },
      { taskId: "task-b", profileId: "candidate", seed: 22, repetition: 2, position: 7 },
      { taskId: "task-b", profileId: "baseline", seed: 22, repetition: 2, position: 8 },
    ]);
    expect(schedule.map((trial) => trial.trialId)).toEqual(
      schedule.map(() => expect.stringMatching(/^trial-[a-f0-9]{48}$/)),
    );
    expect(new Set(schedule.map((trial) => trial.trialId)).size).toBe(8);
    expect(
      createEvaluationSchedule(
        "a".repeat(64),
        ["task-a", "task-b"],
        ["baseline", "candidate"],
        [11, 22],
      ),
    ).toEqual(schedule);

    const acrossTasks = createEvaluationSchedule(
      "b".repeat(64),
      ["task-a", "task-b"],
      ["baseline", "candidate"],
      [11],
    );
    expect(acrossTasks.map((trial) => `${trial.taskId}:${trial.profileId}`)).toEqual([
      "task-a:baseline",
      "task-a:candidate",
      "task-b:candidate",
      "task-b:baseline",
    ]);
  });
});

function validPlan(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata:
  id: harness-comparison
suite:
  id: foundation-suite
  version: 1.0.0
  tasks:
    - id: edit-readme
      partition: holdout
      fixture: fixtures/edit-readme
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions:
          - kind: exists
            path: RESULT.md
          - kind: sha256
            path: README.md
            value: ${"b".repeat(64)}
profiles:
  - id: baseline
    adapter: flow-workflow-v1
    workflow: baseline.workflow.yaml
  - id: candidate
    adapter: flow-workflow-v1
    workflow: candidate.workflow.yaml
controls:
  model:
    provider: anthropic
    id: claude-sonnet-4-5
    thinking: medium
  budget:
    maxNodeStarts: 8
    maxModelTokens: 10000
    maxCostUsdMicros: 1000000
    maxExecutionMs: 300000
    maxArtifactBytes: 1048576
  network: deny
  retry:
    providerRetries: 0
    harnessRetries: 0
seeds: [11, 22]
order: paired-alternating-v1
comparison:
  baselineProfileId: baseline
  candidateProfileId: candidate
  minimumPairedTrials: 2
  confidenceLevel: 0.95
  minimumEffect: 0
  maxFalseCompletionRate: 0
  maxPolicyViolations: 0
  maxVerifiedSuccessRegression: 0
`;
}
