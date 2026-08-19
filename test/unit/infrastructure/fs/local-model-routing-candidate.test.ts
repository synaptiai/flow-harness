import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileWorkflowText } from "../../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../../src/domain/workflow/digest.js";
import { admitLocalModelRoutingCandidate } from "../../../../src/infrastructure/fs/local-model-routing-candidate.js";

describe("local model-routing candidate admission", () => {
  it("reopens one bounded candidate and baseline into an immutable projection", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-model-route-")));
    const project = join(root, "project");
    await mkdir(project);
    const baselinePath = join(project, "baseline.workflow.yaml");
    const candidatePath = join(project, "route.candidate.yaml");
    await writeFile(baselinePath, baselineText, "utf8");
    await writeFile(candidatePath, candidateText(), "utf8");

    const admitted = await admitLocalModelRoutingCandidate(candidatePath);

    expect(admitted).toMatchObject({
      sourcePath: candidatePath,
      identity: {
        kind: "model-routing-candidate",
        scope: {
          workflowId: "routing-workflow",
          nodeId: "implement",
        },
        route: {
          before: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
          after: { provider: "openai", id: "gpt-5.4", thinking: "high" },
        },
      },
      baseline: {
        sourcePath: baselinePath,
        sourceSha256: sha256(baselineText),
      },
      workflow: {
        compiled: {
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: "implement",
              agent: expect.objectContaining({
                model: { provider: "openai", id: "gpt-5.4", thinking: "high" },
              }),
            }),
          ]),
        },
      },
    });
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it("rejects a symbolic-link ancestor before reading candidate authority", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-model-route-link-")));
    const direct = join(root, "direct");
    const project = join(direct, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "baseline.workflow.yaml"), baselineText, "utf8");
    await writeFile(join(project, "route.candidate.yaml"), candidateText(), "utf8");
    const alias = join(root, "alias");
    await symlink(direct, alias);

    await expect(
      admitLocalModelRoutingCandidate(join(alias, "project", "route.candidate.yaml")),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("preserves cancellation and rejects a baseline changed after its stable read", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-model-route-race-")));
    const baselinePath = join(root, "baseline.workflow.yaml");
    const candidatePath = join(root, "route.candidate.yaml");
    await writeFile(baselinePath, baselineText, "utf8");
    await writeFile(candidatePath, candidateText(), "utf8");

    const controller = new AbortController();
    const reason = new Error("PRIVATE_CANCEL_REASON");
    await expect(
      admitLocalModelRoutingCandidate(candidatePath, {
        signal: controller.signal,
        afterBaselineRead: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);

    await writeFile(baselinePath, baselineText, "utf8");
    await expect(
      admitLocalModelRoutingCandidate(candidatePath, {
        beforeReturn: async () => {
          await writeFile(baselinePath, `${baselineText} `, "utf8");
        },
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });
});

const baselineText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "routing-workflow" },
  budget: {
    maxNodeStarts: 2,
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
        model: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
        tools: ["read", "edit"],
        timeoutMs: 300_000,
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
  const compiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "ModelRoutingCandidate",
    metadata: { id: "sonnet-to-gpt", version: "1.0.0" },
    scope: {
      kind: "workflow-model-route",
      workflowId: "routing-workflow",
      nodeId: "implement",
    },
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineText),
        workflowDigest: calculateWorkflowDigest(compiled),
      },
    },
    route: {
      before: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
      after: { provider: "openai", id: "gpt-5.4", thinking: "high" },
    },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
