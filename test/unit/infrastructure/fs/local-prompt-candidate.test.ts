import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createEvaluationSchedule } from "../../../../src/domain/evaluation/plan.js";
import { createEvaluationTrialRecord } from "../../../../src/domain/evaluation/records.js";
import {
  createTuningEvidencePacket,
  MAX_TUNING_EVIDENCE_BYTES,
} from "../../../../src/domain/evaluation/tuning-evidence.js";
import { compileWorkflowText } from "../../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../../src/domain/workflow/digest.js";
import {
  admitLocalPromptCandidate,
  LocalPromptCandidateError,
} from "../../../../src/infrastructure/fs/local-prompt-candidate.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local prompt candidate admission", () => {
  it("stably admits candidate, baseline, evidence, and projected workflow identities", async () => {
    const fixture = await candidateProject();

    const admitted = await admitLocalPromptCandidate(fixture.candidatePath);

    expect(admitted.identity).toMatchObject({
      id: "better-instructions",
      candidateVersion: "1.0.0",
      manifest: {
        provenance: "candidate.yaml",
        sourceSha256: sha256(fixture.candidateText),
      },
      baseline: {
        provenance: "baseline.workflow.yaml",
        sourceSha256: sha256(fixture.workflowText),
      },
      evidence: [
        {
          provenance: "tuning.json",
          sourceSha256: sha256(fixture.evidenceText),
        },
      ],
      projectedWorkflow: {
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(admitted.sourcePath).toBe(fixture.candidatePath);
    expect(admitted.baseline.sourcePath).toBe(join(fixture.project, "baseline.workflow.yaml"));
    expect(admitted.evidence[0]?.sourcePath).toBe(join(fixture.project, "tuning.json"));
    expect(admitted.workflow.source).toContain("Read TASK.md first");
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it.each(["baseline", "evidence"] as const)("rejects a symbolic-link %s source", async (kind) => {
    const fixture = await candidateProject({
      ...(kind === "baseline" ? { baselinePath: "linked.workflow.yaml" } : {}),
      ...(kind === "evidence" ? { evidencePath: "linked-evidence.json" } : {}),
    });
    await symlink(
      kind === "baseline" ? "baseline.workflow.yaml" : "tuning.json",
      join(fixture.project, kind === "baseline" ? "linked.workflow.yaml" : "linked-evidence.json"),
    );

    await expect(admitLocalPromptCandidate(fixture.candidatePath)).rejects.toThrowError(
      /symbolic link|without following links/i,
    );
  });

  it("rejects source-hash tampering and malformed evidence", async () => {
    const stale = await candidateProject({ declaredBaselineSha256: "f".repeat(64) });
    await expect(admitLocalPromptCandidate(stale.candidatePath)).rejects.toThrowError(
      /baseline identity/i,
    );

    const malformed = await candidateProject();
    await writeFile(join(malformed.project, "tuning.json"), '{"version":1,"unexpected":true}');
    await expect(admitLocalPromptCandidate(malformed.candidatePath)).rejects.toThrowError(
      /tuning evidence|invalid/i,
    );
  });

  it("rejects path escapes and non-file sources before projection", async () => {
    const escaped = await candidateProject({ baselinePath: "../outside.workflow.yaml" });
    await expect(admitLocalPromptCandidate(escaped.candidatePath)).rejects.toThrowError(
      /canonical portable relative path|escape/i,
    );

    const missing = await candidateProject({ evidencePath: "missing.json" });
    await expect(admitLocalPromptCandidate(missing.candidatePath)).rejects.toThrowError(
      LocalPromptCandidateError,
    );
  });

  it("rejects candidate links, invalid UTF-8, and oversized evidence before parsing", async () => {
    const linked = await candidateProject();
    const actualCandidate = join(linked.project, "actual-candidate.yaml");
    await rename(linked.candidatePath, actualCandidate);
    await symlink(actualCandidate, linked.candidatePath);
    await expect(admitLocalPromptCandidate(linked.candidatePath)).rejects.toThrowError(
      /symbolic|without following/i,
    );

    const invalidUtf8 = await candidateProject();
    await writeFile(join(invalidUtf8.project, "baseline.workflow.yaml"), Buffer.from([0xff]));
    await expect(admitLocalPromptCandidate(invalidUtf8.candidatePath)).rejects.toThrowError(
      /utf-?8/i,
    );

    const oversized = await candidateProject();
    await writeFile(
      join(oversized.project, "tuning.json"),
      Buffer.alloc(MAX_TUNING_EVIDENCE_BYTES + 1, 0x20),
    );
    await expect(admitLocalPromptCandidate(oversized.candidatePath)).rejects.toThrowError(
      /limit|exceeds/i,
    );
  });

  it("rejects an intermediate-directory swap between validation and open", async () => {
    const fixture = await candidateProject();
    const nested = join(fixture.project, "nested");
    const saved = join(fixture.project, "nested-saved");
    await mkdir(nested);
    await rename(join(fixture.project, "baseline.workflow.yaml"), join(nested, "baseline.yaml"));
    const candidate = JSON.parse(fixture.candidateText);
    candidate.baseline.workflow = "nested/baseline.yaml";
    await writeFile(fixture.candidatePath, JSON.stringify(candidate));

    const outside = await realpath(await mkdtemp(join(tmpdir(), "flow-prompt-candidate-outside-")));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "baseline.yaml"), fixture.workflowText);
    let swapped = false;

    await expect(
      admitLocalPromptCandidate(fixture.candidatePath, {
        afterPathValidation: async (provenance) => {
          if (provenance !== "nested/baseline.yaml" || swapped) {
            return;
          }
          swapped = true;
          await rename(nested, saved);
          await symlink(outside, nested, "dir");
        },
      }),
    ).rejects.toThrowError(/changed|symbolic|identity|escape/i);
  });

  it("rejects replacement of the canonical candidate root with a symbolic link", async () => {
    const fixture = await candidateProject();
    const savedRoot = `${fixture.project}-saved`;
    temporaryDirectories.push(savedRoot);
    let swapped = false;

    await expect(
      admitLocalPromptCandidate(fixture.candidatePath, {
        afterPathValidation: async (provenance) => {
          if (provenance !== "candidate.yaml" || swapped) {
            return;
          }
          swapped = true;
          await rename(fixture.project, savedRoot);
          await symlink(savedRoot, fixture.project, "dir");
        },
      }),
    ).rejects.toThrowError(/root|changed|symbolic|identity/i);
  });
});

async function candidateProject(
  overrides: {
    readonly baselinePath?: string;
    readonly evidencePath?: string;
    readonly declaredBaselineSha256?: string;
  } = {},
) {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-prompt-candidate-")));
  temporaryDirectories.push(project);
  const workflowText = workflowSource();
  const workflowDigest = calculateWorkflowDigest(compileWorkflowText(workflowText));
  const evidence = tuningEvidence(workflowDigest);
  const evidenceText = JSON.stringify(evidence);
  const baselinePath = overrides.baselinePath ?? "baseline.workflow.yaml";
  const evidencePath = overrides.evidencePath ?? "tuning.json";
  const candidate = {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "PromptCandidate",
    metadata: { id: "better-instructions", version: "1.0.0" },
    scope: { kind: "workflow", workflowId: "adaptive-workflow" },
    baseline: {
      workflow: baselinePath,
      sourceSha256: overrides.declaredBaselineSha256 ?? sha256(workflowText),
      workflowDigest,
    },
    evidence: [
      {
        path: evidencePath,
        sourceSha256: sha256(evidenceText),
        evidenceDigest: evidence.evidenceDigest,
        planDigest: evidence.evaluation.planDigest,
      },
    ],
    changes: {
      prompts: [
        {
          nodeId: "implement",
          expectedSha256: sha256("Implement the task."),
          value: "Read TASK.md first, implement the task, and verify the result.",
        },
      ],
    },
  };
  const candidateText = JSON.stringify(candidate);
  await writeFile(join(project, "baseline.workflow.yaml"), workflowText);
  await writeFile(join(project, "tuning.json"), evidenceText);
  const candidatePath = join(project, "candidate.yaml");
  await writeFile(candidatePath, candidateText);
  return { project, candidatePath, candidateText, workflowText, evidenceText };
}

function workflowSource(): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "adaptive-workflow" },
    budget: {
      maxNodeStarts: 8,
      maxModelTokens: 10_000,
      maxCostUsd: 1,
      maxExecutionMs: 300_000,
      maxArtifactBytes: 1_048_576,
    },
    nodes: [
      {
        id: "implement",
        type: "agent",
        agent: {
          prompt: "Implement the task.",
          model: { provider: "test", id: "deterministic" },
          tools: ["read", "edit"],
        },
      },
      {
        id: "publish",
        type: "result",
        dependsOn: ["implement"],
        result: {
          source: { nodeId: "implement", field: "agent.text" },
          schema: { type: "string", maxLength: 1_024 },
        },
      },
    ],
  });
}

function tuningEvidence(workflowDigest: string) {
  const planDigest = "a".repeat(64);
  const schedule = createEvaluationSchedule(
    planDigest,
    ["tuning-task"],
    ["baseline", "other"],
    [1],
  );
  let previousDigest: string | null = null;
  const records = schedule.map((item) => {
    const record = createEvaluationTrialRecord({
      schedule: item,
      planDigest,
      previousDigest,
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T00:00:01.000Z",
      environment: {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v22.19.0",
        flowVersion: "0.0.0-test",
        workspaceBackend: "reflink-copy-v1",
        workspaceSnapshotDigest: "9".repeat(64),
      },
      harness: { outcome: "completed", runId: "run", reason: null },
      verification: {
        outcome: "accepted",
        verifierDigest: "b".repeat(64),
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      },
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
  return createTuningEvidencePacket({
    evaluationId: "source-evaluation",
    planDigest,
    suite: { id: "adaptive-suite", version: "1.0.0" },
    tasks: [{ id: "tuning-task", partition: "tuning" }],
    profiles: [
      { id: "baseline", adapter: "flow-workflow-v1", workflowDigest },
      { id: "other", adapter: "flow-workflow-v1", workflowDigest: "c".repeat(64) },
    ],
    schedule,
    records,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
