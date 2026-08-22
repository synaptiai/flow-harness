import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parseEvaluationTrialAttempt } from "../../../../src/domain/evaluation/attempt.js";
import {
  calculateContextCompactionEvaluationPlanDigest,
  CONTEXT_COMPACTION_EVALUATION_API_VERSION,
  createContextCompactionEvaluationSchedule,
} from "../../../../src/domain/evaluation/context-compaction-evaluation.js";
import { createEvaluationTrialRecord } from "../../../../src/domain/evaluation/records.js";
import {
  LocalContextCompactionEvaluationStore,
  type PublicContextCompactionEvaluationHeader,
} from "../../../../src/infrastructure/fs/local-context-compaction-evaluation-store.js";

const temporaryDirectories: string[] = [];
const planDigest = calculateContextCompactionEvaluationPlanDigest(planIdentityFixture());

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local context compaction evaluation store", () => {
  it("publishes a complete evaluation atomically", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-compaction-store-")));
    temporaryDirectories.push(root);
    const header = headerFixture();
    const store = new LocalContextCompactionEvaluationStore(root);

    await expect(
      store.create(header, {
        afterStagingPrepared: () => {
          throw new Error("simulated interruption");
        },
      }),
    ).rejects.toThrow("simulated interruption");
    await expect(store.read(header.evaluationId)).rejects.toThrow(/not_found/);
    await expect(store.create(header)).resolves.toBeUndefined();
    await expect(store.read(header.evaluationId)).resolves.toMatchObject({ records: [] });
  });

  it("rejects an evaluation directory reached through a symlink", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-compaction-store-")));
    const externalRoot = await realpath(await mkdtemp(join(tmpdir(), "flow-compaction-external-")));
    temporaryDirectories.push(root, externalRoot);
    const header = headerFixture();
    await new LocalContextCompactionEvaluationStore(externalRoot).create(header);
    await symlink(join(externalRoot, header.evaluationId), join(root, header.evaluationId), "dir");

    await expect(
      new LocalContextCompactionEvaluationStore(root).read(header.evaluationId),
    ).rejects.toThrow(/direct regular directory/);
  });

  it("rejects a public header whose identity no longer matches its plan digest", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-compaction-store-")));
    temporaryDirectories.push(root);
    const header = headerFixture();
    const store = new LocalContextCompactionEvaluationStore(root);
    await store.create(header);
    const headerPath = join(root, header.evaluationId, "plan.json");
    const persisted = JSON.parse(await readFile(headerPath, "utf8")) as {
      comparison: { maxTotalTokenIncreaseRate: number };
    };
    persisted.comparison.maxTotalTokenIncreaseRate = 0.2;
    await writeFile(headerPath, `${JSON.stringify(persisted)}\n`);

    await expect(store.read(header.evaluationId)).rejects.toThrow(/plan digest/);
  });

  it("rejects invalid UTF-8 before parsing stored evidence", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-compaction-store-")));
    temporaryDirectories.push(root);
    const header = headerFixture("Never change release policy. \uFFFD");
    const store = new LocalContextCompactionEvaluationStore(root);
    await store.create(header);
    const headerPath = join(root, header.evaluationId, "plan.json");
    const source = await readFile(headerPath);
    const replacement = Buffer.from("\uFFFD", "utf8");
    const index = source.indexOf(replacement);
    if (index < 0) throw new Error("UTF-8 fixture replacement character is absent");
    await writeFile(
      headerPath,
      Buffer.concat([source.subarray(0, index), Buffer.from([0xff]), source.subarray(index + 3)]),
    );

    await expect(store.read(header.evaluationId)).rejects.toThrow(/UTF-8/i);
  });

  it("rejects an active attempt that contradicts the public schedule", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-compaction-store-")));
    temporaryDirectories.push(root);
    const header = headerFixture();
    const store = new LocalContextCompactionEvaluationStore(root);
    await store.create(header);
    const scheduled = header.schedule[0];
    if (scheduled === undefined) throw new Error("store fixture schedule is empty");
    await writeFile(
      join(root, header.evaluationId, "active-attempt.json"),
      `${JSON.stringify({
        version: 1,
        planDigest,
        position: scheduled.position,
        trialId: scheduled.trialId,
        taskId: "different-task",
        profileId: scheduled.profileId,
        adapter: "flow-workflow-v1",
        startedAt: "2026-08-22T00:00:00.000Z",
        workspace: { backend: "reflink-copy-v1", snapshotDigest: "b".repeat(64) },
      })}\n`,
    );

    await expect(store.read(header.evaluationId)).rejects.toThrow(/active attempt.*schedule/i);
  });

  it("persists one owned record prefix and active-attempt lifecycle", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-compaction-store-")));
    temporaryDirectories.push(root);
    const header = headerFixture();
    const store = new LocalContextCompactionEvaluationStore(root);
    await store.create(header);
    const claimed = await store.claim(header.evaluationId, planDigest);
    const scheduled = header.schedule[0];
    if (scheduled === undefined) throw new Error("store fixture schedule is empty");
    const attempt = parseEvaluationTrialAttempt({
      version: 1,
      planDigest,
      position: scheduled.position,
      trialId: scheduled.trialId,
      taskId: scheduled.taskId,
      profileId: scheduled.profileId,
      adapter: "flow-workflow-v1",
      startedAt: "2026-08-22T00:00:00.000Z",
      workspace: { backend: "reflink-copy-v1", snapshotDigest: "b".repeat(64) },
    });
    const record = createEvaluationTrialRecord({
      schedule: scheduled,
      planDigest,
      previousDigest: null,
      startedAt: attempt.startedAt,
      completedAt: "2026-08-22T00:00:01.000Z",
      environment: {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v27.0.0",
        flowVersion: "0.1.0-alpha.1",
        workspaceBackend: "reflink-copy-v1",
        workspaceSnapshotDigest: "b".repeat(64),
      },
      harness: { outcome: "completed", runId: "eval-run", reason: null },
      verification: {
        outcome: "accepted",
        verifierDigest: "c".repeat(64),
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      },
      metrics: {
        costUsdMicros: 1,
        inputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        turns: 1,
        toolCalls: 0,
        toolErrors: 0,
        wallTimeMs: 10,
        activeTimeMs: 9,
        interventions: 0,
        policyViolations: 0,
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
        contextCompaction: {
          mode: "none",
          providerRequestBytes: 100,
          providerRequestEstimatedTokens: 25,
          attempts: 0,
          accepted: 0,
          rejected: 0,
          interrupted: 0,
          summaryInputTokens: 0,
          summaryOutputTokens: 0,
          summaryCostUsdMicros: 0,
          artifactReopenAttempts: 0,
          artifactReopenSuccesses: 0,
        },
      },
    });
    await expect(store.append(header.evaluationId, record)).rejects.toThrow(/active attempt/);
    await store.beginAttempt(header.evaluationId, attempt);
    await expect(store.completeAttempt(header.evaluationId, attempt)).rejects.toThrow(
      /no durable terminal record/,
    );
    await expect(
      new LocalContextCompactionEvaluationStore(root).read(header.evaluationId),
    ).resolves.toMatchObject({ activeAttempt: { trialId: scheduled.trialId }, records: [] });
    await store.append(header.evaluationId, record);
    await store.completeAttempt(header.evaluationId, attempt);
    await expect(
      new LocalContextCompactionEvaluationStore(root).read(header.evaluationId),
    ).resolves.toMatchObject({ activeAttempt: null });
    await store.release(header.evaluationId);
    const recovered = new LocalContextCompactionEvaluationStore(root);
    await expect(recovered.claim(header.evaluationId, planDigest)).resolves.toMatchObject({
      activeAttempt: null,
      records: [{ recordDigest: record.recordDigest }],
    });
    await recovered.release(header.evaluationId);

    expect(claimed.records).toEqual([]);
    await expect(
      new LocalContextCompactionEvaluationStore(root).read(header.evaluationId),
    ).resolves.toMatchObject({
      records: [{ recordDigest: record.recordDigest }],
      activeAttempt: null,
    });
  });

  it("reclaims an owner record only after its process is absent", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-compaction-store-")));
    temporaryDirectories.push(root);
    const header = headerFixture();
    const store = new LocalContextCompactionEvaluationStore(root);
    await store.create(header);
    await writeFile(
      join(root, header.evaluationId, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000000",
        acquiredAt: "2026-08-22T00:00:00.000Z",
      })}\n`,
    );

    await expect(store.claim(header.evaluationId, planDigest)).resolves.toMatchObject({
      records: [],
    });
    await store.release(header.evaluationId);
  });
});

function headerFixture(
  protectedConstraint = "Never change release policy.",
): PublicContextCompactionEvaluationHeader {
  const headerPlanDigest = calculateContextCompactionEvaluationPlanDigest(
    planIdentityFixture(protectedConstraint),
  );
  const schedule = createContextCompactionEvaluationSchedule(
    headerPlanDigest,
    ["preserve-policy"],
    [11, 12, 13, 14, 15, 16],
  );
  return {
    version: 1,
    kind: "ContextCompactionEvaluation",
    evaluationId: "compaction-evaluation",
    createdAt: "2026-08-22T00:00:00.000Z",
    planDigest: headerPlanDigest,
    apiVersion: CONTEXT_COMPACTION_EVALUATION_API_VERSION,
    planId: "reference-first-compaction",
    suite: {
      id: "context-compaction-holdout",
      version: "1.0.0",
      tasks: [
        {
          id: "preserve-policy",
          fixture: {
            provenance: "fixtures/policy",
            digest: "d".repeat(64),
            entryCount: 2,
            logicalBytes: 100,
            instructionPath: "TASK.md",
            instructionSha256: "e".repeat(64),
          },
          verifier: { kind: "filesystem-v1", digest: "c".repeat(64), assertionCount: 1 },
          protectedConstraints: [protectedConstraint],
          constraintAssertionIndexes: [0],
        },
      ],
    },
    profile: {
      adapter: "flow-workflow-v1",
      workflow: {
        provenance: "agent.workflow.yaml",
        sourceSha256: "f".repeat(64),
        workflowDigest: "1".repeat(64),
      },
    },
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
      compaction: { minimumReductionBytes: 1_024, summaryOutputTokenLimits: [512, 256] },
    },
    seeds: [11, 12, 13, 14, 15, 16],
    modes: ["none", "references", "references-and-summary"],
    order: "six-order-balanced-v1",
    comparison: {
      minimumPairedTrials: 6,
      maxVerifiedSuccessRegression: 0,
      maxTotalTokenIncreaseRate: 0.1,
      maxConstraintLosses: 0,
    },
    schedule,
  };
}

function planIdentityFixture(protectedConstraint = "Never change release policy."): unknown {
  return {
    version: 1,
    apiVersion: CONTEXT_COMPACTION_EVALUATION_API_VERSION,
    id: "reference-first-compaction",
    suite: {
      id: "context-compaction-holdout",
      version: "1.0.0",
      tasks: [
        {
          id: "preserve-policy",
          partition: "holdout",
          fixture: {
            provenance: "fixtures/policy",
            digest: "d".repeat(64),
            entryCount: 2,
            logicalBytes: 100,
            instructionPath: "TASK.md",
            instructionSha256: "e".repeat(64),
          },
          verifier: { kind: "filesystem-v1", digest: "c".repeat(64), assertionCount: 1 },
          protectedConstraints: [protectedConstraint],
          constraintAssertionIndexes: [0],
        },
      ],
    },
    profile: {
      adapter: "flow-workflow-v1",
      workflow: {
        provenance: "agent.workflow.yaml",
        sourceSha256: "f".repeat(64),
        workflowDigest: "1".repeat(64),
      },
    },
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
      compaction: { minimumReductionBytes: 1_024, summaryOutputTokenLimits: [512, 256] },
    },
    seeds: [11, 12, 13, 14, 15, 16],
    modes: ["none", "references", "references-and-summary"],
    order: "six-order-balanced-v1",
    comparison: {
      minimumPairedTrials: 6,
      maxVerifiedSuccessRegression: 0,
      maxTotalTokenIncreaseRate: 0.1,
      maxConstraintLosses: 0,
    },
  };
}
