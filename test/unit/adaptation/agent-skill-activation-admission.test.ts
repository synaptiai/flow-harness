import { describe, expect, it } from "vitest";

import { createAgentSkillActivationFromEvaluation } from "../../../src/application/prepare-agent-skill-activation.js";
import { calculateAgentSkillCandidateIdentityDigest } from "../../../src/domain/adaptation/agent-skill-candidate.js";
import { createEvaluationSchedule } from "../../../src/domain/evaluation/plan.js";
import { createEvaluationTrialRecord } from "../../../src/domain/evaluation/records.js";
import type { StoredEvaluation } from "../../../src/infrastructure/fs/local-evaluation-store.js";
import {
  agentSkillActivationInput,
  agentSkillActivationWorkflowSource,
} from "../../fixtures/agent-skill-activation.js";

describe("Agent Skill activation evaluation admission", () => {
  it("creates exact baseline and candidate snapshots from complete superior evidence", () => {
    const live = liveCandidate();
    const stored = superiorStoredEvaluation();

    const activations = createAgentSkillActivationFromEvaluation(live, stored);

    expect(activations).toMatchObject({
      candidate: {
        kind: "agent-skill-activation",
        selection: "candidate",
        workflowId: "adaptive-skill-workflow",
        skill: { digest: live.candidateSkill.digest },
        evaluation: {
          evaluationId: "evaluation-1",
          planDigest: stored.header.planDigest,
          terminalRecordDigest: stored.records.at(-1)?.recordDigest,
          baselineProfileId: "baseline",
          candidateProfileId: "candidate",
          scheduledTrials: 4,
          committedTrials: 4,
          comparison: { verdict: "superior", completePairs: 2, comparablePairs: 2 },
        },
      },
      baseline: {
        kind: "agent-skill-activation",
        selection: "baseline",
        workflowId: "adaptive-skill-workflow",
        skill: { digest: live.baselineSkill.digest },
      },
    });
    expect(activations.baseline.workflow).toEqual(activations.candidate.workflow);
    expect(activations.baseline.evaluation).toEqual(activations.candidate.evaluation);
  });

  it("accepts one plan-relative nested candidate selection bound to the manifest basename", () => {
    const stored = structuredClone(superiorStoredEvaluation()) as MutableStoredEvaluation;
    const candidate = requiredProfile(stored, "candidate");
    candidate.workflow.provenance = "candidates/candidate.yaml";
    if (candidate.candidate === undefined) {
      throw new Error("Agent Skill activation fixture has no candidate identity");
    }
    candidate.candidate.provenance = "candidates/candidate.yaml";

    expect(() => createAgentSkillActivationFromEvaluation(liveCandidate(), stored)).not.toThrow();
  });

  it("rejects incomplete evidence before creating activation authority", () => {
    const stored = superiorStoredEvaluation();

    expect(() =>
      createAgentSkillActivationFromEvaluation(liveCandidate(), {
        ...stored,
        records: stored.records.slice(0, -1),
      }),
    ).toThrowError(expect.objectContaining({ code: "evaluation_incomplete" }));
  });

  it("rejects a complete evaluation that does not prove superiority", () => {
    expect(() =>
      createAgentSkillActivationFromEvaluation(liveCandidate(), superiorStoredEvaluation(false)),
    ).toThrowError(expect.objectContaining({ code: "evaluation_not_superior" }));
  });

  it("rejects independently substituted live and stored capability identities", () => {
    const live = liveCandidate();
    expect(() =>
      createAgentSkillActivationFromEvaluation(
        { ...live, baselineSkill: live.candidateSkill },
        superiorStoredEvaluation(),
      ),
    ).toThrowError(expect.objectContaining({ code: "identity_mismatch" }));
    expect(() =>
      createAgentSkillActivationFromEvaluation(
        { ...live, candidateSkill: live.baselineSkill },
        superiorStoredEvaluation(),
      ),
    ).toThrowError(expect.objectContaining({ code: "identity_mismatch" }));

    const stored = structuredClone(superiorStoredEvaluation()) as MutableStoredEvaluation;
    const candidateProfile = stored.header.profiles[1];
    if (candidateProfile?.adapter !== "flow-workflow-v1") {
      throw new Error("Agent Skill activation fixture has no candidate profile");
    }
    candidateProfile.capabilitySnapshotDigest = "f".repeat(64);
    expect(() => createAgentSkillActivationFromEvaluation(live, stored)).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
  });

  it.each(storedProfileMutations)("rejects an independently changed $name", ({ mutate }) => {
    const stored = structuredClone(superiorStoredEvaluation()) as MutableStoredEvaluation;
    mutate(stored);

    expect(() => createAgentSkillActivationFromEvaluation(liveCandidate(), stored)).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
  });

  it("keeps private stored values out of admission errors and causes", () => {
    const stored = structuredClone(superiorStoredEvaluation()) as MutableStoredEvaluation;
    const candidateProfile = stored.header.profiles[1];
    if (candidateProfile?.adapter !== "flow-workflow-v1") {
      throw new Error("Agent Skill activation fixture has no candidate profile");
    }
    candidateProfile.workflow.provenance = "PRIVATE_EVALUATION_SOURCE";

    try {
      createAgentSkillActivationFromEvaluation(liveCandidate(), stored);
      throw new Error("private evaluation substitution unexpectedly activated");
    } catch (error) {
      expect(error).toMatchObject({ code: "identity_mismatch" });
      expect((error as Error).message).not.toContain("PRIVATE");
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

type DeepMutable<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
      : Value;

type MutableStoredEvaluation = DeepMutable<StoredEvaluation>;

const storedProfileMutations: readonly {
  readonly name: string;
  readonly mutate: (stored: MutableStoredEvaluation) => void;
}[] = [
  {
    name: "stored candidate identity",
    mutate: (stored) => {
      const candidate = requiredProfile(stored, "candidate");
      if (
        candidate.candidate === undefined ||
        !("projectedSkill" in candidate.candidate.identity)
      ) {
        throw new Error("Agent Skill activation fixture has no candidate identity");
      }
      candidate.candidate.identity.candidateVersion = "2.0.0";
      const { candidateDigest: _candidateDigest, ...identity } = candidate.candidate.identity;
      candidate.candidate.identity.candidateDigest =
        calculateAgentSkillCandidateIdentityDigest(identity);
    },
  },
  {
    name: "candidate selection provenance",
    mutate: (stored) => {
      const candidate = requiredProfile(stored, "candidate");
      if (candidate.candidate === undefined) {
        throw new Error("Agent Skill activation fixture has no candidate identity");
      }
      candidate.candidate.provenance = "other/candidate.yaml";
    },
  },
  {
    name: "candidate workflow source kind",
    mutate: (stored) => {
      delete requiredProfile(stored, "candidate").workflow.sourceKind;
    },
  },
  {
    name: "candidate workflow provenance",
    mutate: (stored) => {
      requiredProfile(stored, "candidate").workflow.provenance = "other/candidate.yaml";
    },
  },
  {
    name: "candidate workflow source digest",
    mutate: (stored) => {
      requiredProfile(stored, "candidate").workflow.sourceSha256 = "a".repeat(64);
    },
  },
  {
    name: "candidate workflow digest",
    mutate: (stored) => {
      requiredProfile(stored, "candidate").workflow.workflowDigest = "a".repeat(64);
    },
  },
  {
    name: "candidate capability digest",
    mutate: (stored) => {
      requiredProfile(stored, "candidate").capabilitySnapshotDigest = "a".repeat(64);
    },
  },
  {
    name: "candidate package digest list",
    mutate: (stored) => {
      const candidate = requiredProfile(stored, "candidate");
      candidate.capabilityPackageDigests = [
        ...(candidate.capabilityPackageDigests ?? []),
        "a".repeat(64),
      ];
    },
  },
  {
    name: "baseline candidate identity",
    mutate: (stored) => {
      requiredProfile(stored, "baseline").candidate = structuredClone(
        requiredProfile(stored, "candidate").candidate,
      );
    },
  },
  {
    name: "baseline workflow source kind",
    mutate: (stored) => {
      requiredProfile(stored, "baseline").workflow.sourceKind = "agent-skill-candidate-projection";
    },
  },
  {
    name: "baseline workflow provenance",
    mutate: (stored) => {
      requiredProfile(stored, "baseline").workflow.provenance = "other.workflow.yaml";
    },
  },
  {
    name: "baseline workflow source digest",
    mutate: (stored) => {
      requiredProfile(stored, "baseline").workflow.sourceSha256 = "a".repeat(64);
    },
  },
  {
    name: "baseline workflow digest",
    mutate: (stored) => {
      requiredProfile(stored, "baseline").workflow.workflowDigest = "a".repeat(64);
    },
  },
  {
    name: "baseline capability digest",
    mutate: (stored) => {
      requiredProfile(stored, "baseline").capabilitySnapshotDigest = "a".repeat(64);
    },
  },
  {
    name: "baseline package digest list",
    mutate: (stored) => {
      const baseline = requiredProfile(stored, "baseline");
      baseline.capabilityPackageDigests = [
        ...(baseline.capabilityPackageDigests ?? []),
        "a".repeat(64),
      ];
    },
  },
];

function requiredProfile(stored: MutableStoredEvaluation, id: "baseline" | "candidate") {
  const profile = stored.header.profiles.find((item) => item.id === id);
  if (profile?.adapter !== "flow-workflow-v1") {
    throw new Error(`Agent Skill activation fixture has no ${id} profile`);
  }
  return profile;
}

function liveCandidate() {
  const baseline = agentSkillActivationInput("baseline");
  const candidate = agentSkillActivationInput("candidate");
  return Object.freeze({
    identity: candidate.candidate,
    workflow: {
      source: agentSkillActivationWorkflowSource,
      sourceSha256: candidate.candidate.baseline.workflow.sourceSha256,
      workflowDigest: candidate.candidate.baseline.workflow.workflowDigest,
    },
    baselineSkill: baseline.skill,
    candidateSkill: candidate.skill,
  });
}

function superiorStoredEvaluation(candidateWins = true): StoredEvaluation {
  const live = liveCandidate();
  const planDigest = "b".repeat(64);
  const schedule = createEvaluationSchedule(
    planDigest,
    ["holdout-task"],
    ["baseline", "candidate"],
    [1, 2],
  );
  let previousDigest: string | null = null;
  const records = schedule.map((item) => {
    const succeeds = (item.profileId === "candidate") === candidateWins;
    const record = createEvaluationTrialRecord({
      schedule: item,
      planDigest,
      previousDigest,
      startedAt: "2026-08-15T00:00:00.000Z",
      completedAt: "2026-08-15T00:00:01.000Z",
      environment: {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v26.7.0",
        flowVersion: "0.0.0-test",
        workspaceBackend: "reflink-copy-v1",
        workspaceSnapshotDigest: "d".repeat(64),
      },
      harness: succeeds
        ? { outcome: "completed", runId: `run-${item.position}`, reason: null }
        : { outcome: "failed", runId: `run-${item.position}`, reason: "profile failed" },
      verification: succeeds
        ? {
            outcome: "accepted",
            verifierDigest: "c".repeat(64),
            assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
          }
        : { outcome: "not_run", verifierDigest: "c".repeat(64), assertions: [] },
      metrics: {
        costUsdMicros: 1,
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        turns: 1,
        toolCalls: 0,
        toolErrors: 0,
        wallTimeMs: 1,
        activeTimeMs: 1,
        interventions: 0,
        policyViolations: 0,
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
      },
    });
    previousDigest = record.recordDigest;
    return record;
  });
  return {
    header: {
      version: 1,
      evaluationId: "evaluation-1",
      createdAt: "2026-08-15T00:00:00.000Z",
      planDigest,
      apiVersion: "flow.synapti.ai/v1alpha1",
      planId: "skill-activation-evaluation",
      suite: {
        id: "activation-suite",
        version: "1.0.0",
        tasks: [
          {
            id: "holdout-task",
            partition: "holdout",
            fixture: {
              provenance: "fixture",
              digest: "e".repeat(64),
              entryCount: 1,
              logicalBytes: 1,
              instructionPath: "TASK.md",
              instructionSha256: "f".repeat(64),
            },
            verifier: { kind: "filesystem-v1", digest: "c".repeat(64), assertionCount: 1 },
          },
        ],
      },
      profiles: [
        {
          id: "baseline",
          adapter: "flow-workflow-v1",
          workflow: {
            provenance: live.identity.baseline.workflow.provenance,
            sourceSha256: live.identity.baseline.workflow.sourceSha256,
            workflowDigest: live.identity.baseline.workflow.workflowDigest,
          },
          capabilitySnapshotDigest: live.identity.baseline.skill.capabilityDigest,
          capabilityPackageDigests: [live.identity.baseline.skill.packageDigest],
        },
        {
          id: "candidate",
          adapter: "flow-workflow-v1",
          workflow: {
            sourceKind: "agent-skill-candidate-projection",
            provenance: live.identity.manifest.provenance,
            sourceSha256: live.identity.baseline.workflow.sourceSha256,
            workflowDigest: live.identity.baseline.workflow.workflowDigest,
          },
          capabilitySnapshotDigest: live.identity.projectedSkill.capabilityDigest,
          capabilityPackageDigests: [live.identity.projectedSkill.packageDigest],
          candidate: {
            provenance: live.identity.manifest.provenance,
            identity: live.identity,
          },
        },
      ],
      controls: {
        model: { provider: "test", id: "deterministic", thinking: "medium" },
        budget: {
          maxNodeStarts: 8,
          maxModelTokens: 10_000,
          maxCostUsdMicros: 1_000_000,
          maxExecutionMs: 300_000,
          maxArtifactBytes: 1_048_576,
        },
        network: "deny",
        retry: { providerRetries: 0, harnessRetries: 0 },
      },
      seeds: [1, 2],
      order: "paired-alternating-v1",
      comparison: {
        baselineProfileId: "baseline",
        candidateProfileId: "candidate",
        minimumPairedTrials: 2,
        confidenceLevel: 0.95,
        minimumEffect: 0,
        maxFalseCompletionRate: 0,
        maxPolicyViolations: 0,
        maxVerifiedSuccessRegression: 0,
      },
      schedule: [...schedule],
    },
    records,
    activeAttempt: null,
  };
}
