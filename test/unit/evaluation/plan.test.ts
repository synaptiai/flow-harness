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

  it("parses one closed ACP interoperability qualification plan", () => {
    const plan = parseEvaluationPlanText(validAcpQualificationPlan(), "qualification.yaml");

    expect(plan).toMatchObject({
      purpose: "acp-interoperability-v1",
      suite: {
        tasks: [
          {
            id: "answer-contract",
            verifier: {
              kind: "agent-result-v1",
              sha256: "c".repeat(64),
              bytes: 18,
            },
          },
        ],
      },
      profiles: [
        {
          id: "codex-agent",
          adapter: "flow-workflow-v1",
          workflow: "qualification.workflow.yaml",
          acpAgent: "agents/codex.acp-agent.json",
        },
        {
          id: "opencode-agent",
          adapter: "flow-workflow-v1",
          workflow: "qualification.workflow.yaml",
          acpAgent: "agents/opencode.acp-agent.json",
        },
      ],
    });
  });

  it("rejects ACP qualification sources that weaken the paired contract", () => {
    expect(() =>
      parseEvaluationPlanText(
        validAcpQualificationPlan().replace(
          "workflow: qualification.workflow.yaml\n    acpAgent: agents/opencode.acp-agent.json",
          "workflow: other.workflow.yaml\n    acpAgent: agents/opencode.acp-agent.json",
        ),
      ),
    ).toThrow(/qualification|same workflow/i);
    expect(() =>
      parseEvaluationPlanText(
        validAcpQualificationPlan().replace("    acpAgent: agents/opencode.acp-agent.json\n", ""),
      ),
    ).toThrow(/qualification|ACP agent/i);
    expect(() =>
      parseEvaluationPlanText(
        validAcpQualificationPlan().replace("    kind: agent-result-v1", "    kind: filesystem-v1"),
      ),
    ).toThrow(/qualification|agent-result-v1|schema/i);
  });

  it("rejects ACP-only profile and verifier fields from comparison plans", () => {
    expect(() =>
      parseEvaluationPlanText(
        validPlan().replace(
          "    workflow: baseline.workflow.yaml",
          "    workflow: baseline.workflow.yaml\n    acpAgent: agents/codex.acp-agent.json",
        ),
      ),
    ).toThrow(/purpose|ACP agent|schema/i);
    expect(() =>
      parseEvaluationPlanText(
        validPlan().replace(
          /verifier:\n {8}kind: filesystem-v1[\s\S]*? {12}value: [a-f0-9]{64}/,
          `verifier:
        kind: agent-result-v1
        sha256: ${"c".repeat(64)}
        bytes: 18`,
        ),
      ),
    ).toThrow(/purpose|agent-result-v1|schema/i);
  });

  it("parses one ordered explicit route for each paired effective profile", () => {
    const source = validPlan()
      .replace(
        "workflow: baseline.workflow.yaml",
        "effectiveCandidate: route.effective-harness.json\n    selection: baseline",
      )
      .replace(
        "workflow: candidate.workflow.yaml",
        "effectiveCandidate: route.effective-harness.json\n    selection: candidate",
      )
      .replace(
        "  budget:",
        `  modelRoutes:
    - profileId: baseline
      nodeId: implement
      route: { provider: test, id: deterministic, thinking: medium }
    - profileId: candidate
      nodeId: implement
      route: { provider: openai, id: gpt-5.4, thinking: high }
  budget:`,
      );

    expect(parseEvaluationPlanText(source).controls).toMatchObject({
      modelRoutes: [
        {
          profileId: "baseline",
          nodeId: "implement",
          route: { provider: "test", id: "deterministic", thinking: "medium" },
        },
        {
          profileId: "candidate",
          nodeId: "implement",
          route: { provider: "openai", id: "gpt-5.4", thinking: "high" },
        },
      ],
    });
    expect(() =>
      parseEvaluationPlanText(source.replace("profileId: baseline", "profileId: candidate")),
    ).toThrow(/model route|baseline|profile/i);
    expect(() =>
      parseEvaluationPlanText(
        source.replace(
          "profileId: candidate\n      nodeId: implement",
          "profileId: candidate\n      nodeId: private-review",
        ),
      ),
    ).toThrow(/model route|root agent node/i);
    expect(() =>
      parseEvaluationPlanText(
        source.replace(
          "{ provider: openai, id: gpt-5.4, thinking: high }",
          "{ provider: test, id: deterministic, thinking: medium }",
        ),
      ),
    ).toThrow(/distinct route/i);
    expect(() =>
      parseEvaluationPlanText(
        source.replace(
          "effectiveCandidate: route.effective-harness.json\n    selection: baseline",
          "workflow: baseline.workflow.yaml",
        ),
      ),
    ).toThrow(/effective baseline|effective.*profile/i);
  });

  it("parses a closed phase-routing qualification with exact profile identities and thresholds", () => {
    const plan = parseEvaluationPlanText(validPhaseRoutingPlan(), "phase-routing.yaml");

    expect(plan).toMatchObject({
      purpose: "phase-routing-v1",
      profiles: [
        {
          id: "baseline",
          effectiveCandidate: "route.effective-harness.json",
          selection: "baseline",
        },
        {
          id: "candidate",
          effectiveCandidate: "route.effective-harness.json",
          selection: "candidate",
        },
      ],
      controls: {
        phaseRoutingProfiles: [
          { profileId: "baseline", profileDigest: "1".repeat(64) },
          { profileId: "candidate", profileDigest: "2".repeat(64) },
        ],
      },
      comparison: {
        maxVerifiedSuccessRegression: 0,
        minimumCostReductionRate: 0.1,
        minimumLatencyReductionRate: 0.1,
      },
    });

    expect(() =>
      parseEvaluationPlanText(
        validPhaseRoutingPlan().replace("profileId: baseline", "profileId: candidate"),
      ),
    ).toThrow(/phase-routing|profile|baseline/i);
    expect(() =>
      parseEvaluationPlanText(
        validPhaseRoutingPlan().replace("  minimumCostReductionRate: 0.1\n", ""),
      ),
    ).toThrow(/phase-routing|cost.*threshold/i);
    expect(() =>
      parseEvaluationPlanText(
        validPhaseRoutingPlan().replace(
          "minimumLatencyReductionRate: 0.1",
          "minimumLatencyReductionRate: 0",
        ),
      ),
    ).toThrow(/phase-routing|positive.*threshold/i);
    expect(() =>
      parseEvaluationPlanText(validPhaseRoutingPlan().replace("purpose: phase-routing-v1\n", "")),
    ).toThrow(/phase-routing.*purpose|purpose.*phase-routing/i);
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

  it("parses only fixed built-in external profile configurations", () => {
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

    const omp = validPlan().replace(
      "  - id: candidate\n    adapter: flow-workflow-v1\n    workflow: candidate.workflow.yaml",
      "  - id: candidate\n    adapter: omp-native-v1\n    harness:\n      config: omp-evaluation-v1",
    );

    expect(parseEvaluationPlanText(omp).profiles[1]).toEqual({
      id: "candidate",
      adapter: "omp-native-v1",
      harness: { config: "omp-evaluation-v1" },
    });
    expect(() =>
      parseEvaluationPlanText(omp.replace("omp-evaluation-v1", "operator-command")),
    ).toThrow(/config|schema/i);
    expect(() =>
      parseEvaluationPlanText(
        omp.replace(
          "      config: omp-evaluation-v1",
          "      config: omp-evaluation-v1\n      executable: /usr/bin/omp",
        ),
      ),
    ).toThrow(/executable|unrecognized|schema/i);

    const prime = validPlan().replace(
      "  - id: candidate\n    adapter: flow-workflow-v1\n    workflow: candidate.workflow.yaml",
      "  - id: candidate\n    adapter: prime-agent-native-v1\n    harness:\n      config: prime-agent-rlm-evaluation-v1",
    );

    expect(parseEvaluationPlanText(prime).profiles[1]).toEqual({
      id: "candidate",
      adapter: "prime-agent-native-v1",
      harness: { config: "prime-agent-rlm-evaluation-v1" },
    });
    expect(() =>
      parseEvaluationPlanText(prime.replace("prime-agent-rlm-evaluation-v1", "operator-command")),
    ).toThrow(/config|schema/i);
    expect(() =>
      parseEvaluationPlanText(
        prime.replace(
          "      config: prime-agent-rlm-evaluation-v1",
          "      config: prime-agent-rlm-evaluation-v1\n      dockerSocket: /var/run/docker.sock",
        ),
      ),
    ).toThrow(/dockerSocket|unrecognized|schema/i);
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

function validAcpQualificationPlan(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
purpose: acp-interoperability-v1
metadata:
  id: acp-interoperability
suite:
  id: acp-qualification-suite
  version: 1.0.0
  tasks:
    - id: answer-contract
      partition: holdout
      fixture: fixtures/answer-contract
      instruction: TASK.md
      verifier:
        kind: agent-result-v1
        sha256: ${"c".repeat(64)}
        bytes: 18
profiles:
  - id: codex-agent
    adapter: flow-workflow-v1
    workflow: qualification.workflow.yaml
    acpAgent: agents/codex.acp-agent.json
  - id: opencode-agent
    adapter: flow-workflow-v1
    workflow: qualification.workflow.yaml
    acpAgent: agents/opencode.acp-agent.json
controls:
  model:
    provider: openai
    id: gpt-5.4
    thinking: high
  budget:
    maxNodeStarts: 2
    maxModelTokens: 2000
    maxCostUsdMicros: 1000000
    maxExecutionMs: 120000
    maxArtifactBytes: 65536
  network: deny
  retry:
    providerRetries: 0
    harnessRetries: 0
seeds: [11, 22]
order: paired-alternating-v1
comparison:
  baselineProfileId: codex-agent
  candidateProfileId: opencode-agent
  minimumPairedTrials: 2
  confidenceLevel: 0.95
  minimumEffect: 0
  maxFalseCompletionRate: 0
  maxPolicyViolations: 0
  maxVerifiedSuccessRegression: 0
`;
}

function validPhaseRoutingPlan(): string {
  return validPlan()
    .replace("kind: EvaluationPlan\n", "kind: EvaluationPlan\npurpose: phase-routing-v1\n")
    .replace(
      "workflow: baseline.workflow.yaml",
      "effectiveCandidate: route.effective-harness.json\n    selection: baseline",
    )
    .replace(
      "workflow: candidate.workflow.yaml",
      "effectiveCandidate: route.effective-harness.json\n    selection: candidate",
    )
    .replace(
      "  budget:",
      `  phaseRoutingProfiles:
    - { profileId: baseline, profileDigest: "${"1".repeat(64)}" }
    - { profileId: candidate, profileDigest: "${"2".repeat(64)}" }
  budget:`,
    )
    .replace(
      "  maxVerifiedSuccessRegression: 0",
      "  maxVerifiedSuccessRegression: 0\n  minimumCostReductionRate: 0.1\n  minimumLatencyReductionRate: 0.1",
    );
}
