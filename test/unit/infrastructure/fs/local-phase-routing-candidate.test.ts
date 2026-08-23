import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compileWorkflowText } from "../../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../../src/domain/workflow/digest.js";
import { admitLocalPhaseRoutingCandidate } from "../../../../src/infrastructure/fs/local-phase-routing-candidate.js";
import { phaseRoutingCandidateFixture } from "../../../fixtures/phase-routing-candidate.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local phase-routing candidate admission", () => {
  it("reopens one candidate and baseline into an immutable dual projection", async () => {
    const root = await temporaryDirectory("flow-phase-route-");
    const candidatePath = join(root, "phase.candidate.yaml");
    await writeFile(join(root, "baseline.workflow.yaml"), baselineText);
    await writeFile(candidatePath, candidateText());

    const admitted = await admitLocalPhaseRoutingCandidate(candidatePath);

    expect(admitted).toMatchObject({
      sourcePath: candidatePath,
      identity: {
        kind: "phase-routing-candidate",
        scope: { workflowId: "phase-admission-workflow" },
        profiles: {
          before: { assignments: [{ phase: "executor" }] },
          after: { assignments: [{ phase: "executor" }] },
        },
      },
      baseline: {
        sourcePath: join(root, "baseline.workflow.yaml"),
        sourceSha256: sha256(baselineText),
      },
      workflows: {
        baseline: { workflowDigest: calculateWorkflowDigest(compileWorkflowText(baselineText)) },
        candidate: { workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    });
    expect(admitted.workflows.candidate.workflowDigest).not.toBe(
      admitted.workflows.baseline.workflowDigest,
    );
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it("rejects a symbolic-link ancestor before reading candidate authority", async () => {
    const root = await temporaryDirectory("flow-phase-route-link-");
    const direct = join(root, "direct");
    const project = join(direct, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "baseline.workflow.yaml"), baselineText);
    await writeFile(join(project, "phase.candidate.yaml"), candidateText());
    await symlink(direct, join(root, "alias"));

    await expect(
      admitLocalPhaseRoutingCandidate(join(root, "alias", "project", "phase.candidate.yaml")),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("preserves cancellation and rejects baseline drift after projection", async () => {
    const root = await temporaryDirectory("flow-phase-route-race-");
    const baselinePath = join(root, "baseline.workflow.yaml");
    const candidatePath = join(root, "phase.candidate.yaml");
    await writeFile(baselinePath, baselineText);
    await writeFile(candidatePath, candidateText());
    const controller = new AbortController();
    const reason = new Error("PRIVATE_CANCEL_REASON");

    await expect(
      admitLocalPhaseRoutingCandidate(candidatePath, {
        signal: controller.signal,
        afterBaselineRead: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
    await expect(
      admitLocalPhaseRoutingCandidate(candidatePath, {
        beforeReturn: async () => {
          await writeFile(baselinePath, `${baselineText} `);
        },
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });
});

const baselineText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "phase-admission-workflow" },
  nodes: [
    {
      id: "implement",
      type: "agent",
      agent: {
        prompt: "Implement the task.",
        model: { provider: "test", id: "deterministic", thinking: "medium" },
        tools: [],
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

function candidateText(): string {
  const projected = phaseRoutingCandidateFixture(baselineText);
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "PhaseRoutingCandidate",
    metadata: { id: projected.identity.id, version: projected.identity.candidateVersion },
    scope: projected.identity.scope,
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: projected.identity.baseline.workflow.sourceSha256,
        workflowDigest: projected.identity.baseline.workflow.workflowDigest,
      },
    },
    profiles: {
      before: profileSource(projected.identity.profiles.before),
      after: profileSource(projected.identity.profiles.after),
    },
  });
}

function profileSource(profile: {
  readonly selectionRule: "exact-target-v1";
  readonly fallback: "deny";
  readonly assignments: readonly unknown[];
}) {
  return {
    selectionRule: profile.selectionRule,
    fallback: profile.fallback,
    assignments: profile.assignments,
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
