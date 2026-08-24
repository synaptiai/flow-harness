import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { admitLocalEvaluationPlan } from "../../../../src/infrastructure/fs/local-evaluation-plan.js";
import {
  createPublicEvaluationHeader,
  LocalEvaluationStore,
} from "../../../../src/infrastructure/fs/local-evaluation-store.js";
import { delegationEvaluationCandidateFixture } from "../../../fixtures/delegation-evaluation-candidate.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local delegation evaluation plan", () => {
  it("admits one exact baseline and delegation-only candidate pair", async () => {
    const project = await evaluationProject();
    const resolvedCandidates: string[] = [];

    const admitted = await admitLocalEvaluationPlan(project.planPath, {
      resolveDelegationPackages: async () => [],
      resolveDelegationExecutor: async (source) => {
        resolvedCandidates.push(source.metadata.id);
        return Object.freeze({
          identity: project.fixture.executor,
          assertCurrent: async () => undefined,
        });
      },
    });

    expect(admitted).toMatchObject({
      purpose: "delegation-v1",
      suite: {
        tasks: [
          { id: "delegate-review", delegationClass: "delegation-fit" },
          { id: "edit-directly", delegationClass: "sequential-control" },
        ],
      },
      profiles: [
        {
          id: "baseline",
          workflow: { sourceKind: "delegation-evaluation-baseline" },
        },
        {
          id: "candidate",
          workflow: { sourceKind: "delegation-evaluation-candidate" },
          candidate: project.fixture.projected.identity,
          capabilitySnapshot: {
            delegation: {
              snapshotDigest: project.fixture.projected.snapshot.snapshotDigest,
            },
          },
        },
      ],
    });
    const [baseline, candidate] = admitted.profiles;
    if (baseline.adapter !== "flow-workflow-v1" || candidate.adapter !== "flow-workflow-v1") {
      throw new Error("delegation fixture profiles are not Flow workflows");
    }
    expect(candidate.workflow.sourceSha256).toBe(baseline.workflow.sourceSha256);
    expect(candidate.workflow.workflowDigest).toBe(baseline.workflow.workflowDigest);
    expect(baseline.capabilitySnapshot?.delegation).toBeUndefined();
    expect(resolvedCandidates).toEqual([project.fixture.source.metadata.id]);

    const store = new LocalEvaluationStore(join(project.root, "evaluations"));
    await store.create(
      createPublicEvaluationHeader(admitted, "bounded-delegation", "2026-08-24T12:00:00.000Z"),
    );
    await expect(store.read("bounded-delegation")).resolves.toMatchObject({
      header: {
        purpose: "delegation-v1",
        suite: {
          tasks: [{ delegationClass: "delegation-fit" }, { delegationClass: "sequential-control" }],
        },
        profiles: [
          { workflow: { sourceKind: "delegation-evaluation-baseline" } },
          { workflow: { sourceKind: "delegation-evaluation-candidate" } },
        ],
      },
    });
  });

  it("rejects a baseline profile that does not match the candidate root workflow", async () => {
    const project = await evaluationProject();
    await Promise.all([
      writeFile(
        project.planPath,
        evaluationPlanText().replace(
          "workflow: baseline.workflow.yaml",
          "workflow: other.workflow.yaml",
        ),
      ),
      writeFile(
        join(project.root, "other.workflow.yaml"),
        project.fixture.baselineText.replace("Complete the task.", "Complete a different task."),
      ),
    ]);

    await expect(
      admitLocalEvaluationPlan(project.planPath, {
        resolveDelegationPackages: async () => [],
        resolveDelegationExecutor: async () => ({
          identity: project.fixture.executor,
          assertCurrent: async () => undefined,
        }),
      }),
    ).rejects.toThrow(/delegation.*baseline|exact.*root|candidate.*workflow/i);
  });
});

async function evaluationProject() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-delegation-plan-")));
  temporaryDirectories.push(root);
  const fixture = delegationEvaluationCandidateFixture();
  const planPath = join(root, "evaluation.yaml");
  await Promise.all([
    writeFile(planPath, evaluationPlanText()),
    writeFile(join(root, "delegation.candidate.yaml"), fixture.sourceText),
    writeFile(join(root, "baseline.workflow.yaml"), fixture.baselineText),
    writeFile(join(root, "review.workflow.yaml"), fixture.childText),
    writeTaskFixture(join(root, "fixtures", "delegate-review")),
    writeTaskFixture(join(root, "fixtures", "edit-directly")),
  ]);
  return { root, planPath, fixture };
}

async function writeTaskFixture(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "TASK.md"), "Create RESULT.md.\n");
}

function evaluationPlanText(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
purpose: delegation-v1
metadata: { id: bounded-delegation }
suite:
  id: delegation-suite
  version: 1.0.0
  tasks:
    - id: delegate-review
      partition: holdout
      delegationClass: delegation-fit
      fixture: fixtures/delegate-review
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions: [{ kind: exists, path: RESULT.md }]
    - id: edit-directly
      partition: holdout
      delegationClass: sequential-control
      fixture: fixtures/edit-directly
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions: [{ kind: exists, path: RESULT.md }]
profiles:
  - id: baseline
    adapter: flow-workflow-v1
    workflow: baseline.workflow.yaml
  - id: candidate
    adapter: flow-workflow-v1
    candidate: delegation.candidate.yaml
controls:
  model: { provider: test, id: deterministic, thinking: off }
  budget:
    maxNodeStarts: 6
    maxModelTokens: 30000
    maxCostUsdMicros: 3000000
    maxExecutionMs: 900000
    maxArtifactBytes: 3145728
  network: deny
  retry: { providerRetries: 0, harnessRetries: 0 }
seeds: [11]
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
