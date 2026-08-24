import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  calculateDelegationExecutorIdentityDigest,
  type DelegationExecutorIdentity,
  MAX_DELEGATION_EVALUATION_CANDIDATE_BYTES,
} from "../../../../src/domain/adaptation/delegation-evaluation-candidate.js";
import { calculateCapabilitySnapshotDigest } from "../../../../src/domain/capability/agent-skills.js";
import { compileWorkflowText } from "../../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../../src/domain/workflow/digest.js";
import {
  admitLocalDelegationEvaluationCandidate,
  type DelegationExecutorAdmission,
} from "../../../../src/infrastructure/fs/local-delegation-evaluation-candidate.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local delegation evaluation candidate admission", () => {
  it("admits exact regular files and retains a current executor observation", async () => {
    const root = await candidateProject();
    let revalidations = 0;
    const admitted = await admitLocalDelegationEvaluationCandidate(
      join(root, "delegation.candidate.yaml"),
      {
        packages: [],
        resolveExecutor: async () =>
          executorAdmission(async () => {
            revalidations += 1;
          }),
      },
    );

    expect(admitted).toMatchObject({
      provenance: "delegation.candidate.yaml",
      identity: {
        kind: "delegation-evaluation-candidate",
        scope: { managerNodeId: "manager" },
      },
      baseline: { provenance: "baseline.workflow.yaml" },
      child: { provenance: "review.workflow.yaml" },
      candidateCapabilitySnapshot: {
        packages: [],
        delegation: { kind: "delegation-evaluation-v1", maxCalls: 1, maxDepth: 1 },
      },
    });
    expect(admitted.baselineCapabilitySnapshot).toBeUndefined();
    await admitted.assertExecutorCurrent();
    expect(revalidations).toBe(2);
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it("rejects linked child input without exposing its private path", async () => {
    const root = await candidateProject();
    const privateChild = join(root, "PRIVATE_CHILD_WORKFLOW");
    await rename(join(root, "review.workflow.yaml"), privateChild);
    await symlink(privateChild, join(root, "review.workflow.yaml"));

    const error = await admitLocalDelegationEvaluationCandidate(
      join(root, "delegation.candidate.yaml"),
      { packages: [], resolveExecutor: async () => executorAdmission() },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "invalid_path" });
    expect((error as Error).message).not.toContain("PRIVATE_CHILD_WORKFLOW");
    expect((error as Error).cause).toBeUndefined();
  });

  it("rejects a child or ancestor replacement after stable reads", async () => {
    const root = await candidateProject();
    const childPath = join(root, "review.workflow.yaml");
    await expect(
      admitLocalDelegationEvaluationCandidate(join(root, "delegation.candidate.yaml"), {
        packages: [],
        resolveExecutor: async () => executorAdmission(),
        afterChildRead: () => writeFile(childPath, `${childWorkflowText()} `),
      }),
    ).rejects.toMatchObject({ code: "source_changed" });

    await writeFile(childPath, childWorkflowText());
    const nested = join(root, "candidate-root");
    await mkdir(nested);
    for (const name of [
      "delegation.candidate.yaml",
      "baseline.workflow.yaml",
      "review.workflow.yaml",
    ]) {
      await rename(join(root, name), join(nested, name));
    }
    const moved = join(root, "PRIVATE_MOVED_ROOT");
    const error = await admitLocalDelegationEvaluationCandidate(
      join(nested, "delegation.candidate.yaml"),
      {
        packages: [],
        resolveExecutor: async () => executorAdmission(),
        beforeReturn: async () => {
          await rename(nested, moved);
          await symlink(moved, nested);
        },
      },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "source_changed" });
    expect((error as Error).message).not.toContain("PRIVATE_MOVED_ROOT");
  });

  it("preserves exact cancellation and hides private executor failures", async () => {
    const root = await candidateProject();
    const controller = new AbortController();
    const cancellation = new Error("PRIVATE_CANCELLATION");
    await expect(
      admitLocalDelegationEvaluationCandidate(join(root, "delegation.candidate.yaml"), {
        packages: [],
        signal: controller.signal,
        resolveExecutor: async () => {
          controller.abort(cancellation);
          return executorAdmission();
        },
      }),
    ).rejects.toBe(cancellation);

    const error = await admitLocalDelegationEvaluationCandidate(
      join(root, "delegation.candidate.yaml"),
      {
        packages: [],
        resolveExecutor: async () => {
          throw new Error("PRIVATE_EXECUTOR_PATH");
        },
      },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "invalid_source" });
    expect((error as Error).message).not.toContain("PRIVATE_EXECUTOR_PATH");
    expect((error as Error).cause).toBeUndefined();
  });

  it("accepts the exact candidate limit and rejects one more byte", async () => {
    const root = await candidateProject();
    const candidatePath = join(root, "delegation.candidate.yaml");
    const source = candidateText();
    const exact = `${source}${" ".repeat(
      MAX_DELEGATION_EVALUATION_CANDIDATE_BYTES - Buffer.byteLength(source),
    )}`;
    await writeFile(candidatePath, exact);
    await expect(
      admitLocalDelegationEvaluationCandidate(candidatePath, {
        packages: [],
        resolveExecutor: async () => executorAdmission(),
      }),
    ).resolves.toMatchObject({ sourceText: exact });

    await writeFile(candidatePath, `${exact} `);
    await expect(
      admitLocalDelegationEvaluationCandidate(candidatePath, {
        packages: [],
        resolveExecutor: async () => executorAdmission(),
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});

async function candidateProject(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-delegation-candidate-")));
  roots.push(root);
  await writeFile(join(root, "baseline.workflow.yaml"), baselineWorkflowText());
  await writeFile(join(root, "review.workflow.yaml"), childWorkflowText());
  await writeFile(join(root, "delegation.candidate.yaml"), candidateText());
  return root;
}

function candidateText(): string {
  const baseline = compileWorkflowText(baselineWorkflowText(), "baseline.workflow.yaml");
  const child = compileWorkflowText(childWorkflowText(), "review.workflow.yaml");
  const result = child.nodes.find((node) => node.id === "publish-review");
  if (result?.type !== "result") throw new Error("test child result is missing");
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "DelegationEvaluationCandidate",
    metadata: { id: "review-delegation", version: "1.0.0" },
    scope: {
      kind: "workflow-agent-delegation",
      workflowId: "delegation-harness",
      managerNodeId: "manager",
    },
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineWorkflowText()),
        workflowDigest: calculateWorkflowDigest(baseline),
      },
      packageClosureDigest: calculateCapabilitySnapshotDigest([]),
    },
    delegation: {
      objective: "Review the task independently and return a typed verdict.",
      child: {
        path: "review.workflow.yaml",
        sourceSha256: sha256(childWorkflowText()),
        workflowDigest: calculateWorkflowDigest(child),
        resultNodeId: result.id,
        resultSchemaDigest: result.result.schemaDigest,
        budget: child.budget,
      },
      executor: executorIdentity(),
      maxDepth: 1,
      maxCalls: 1,
    },
  });
}

function baselineWorkflowText(): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "delegation-harness" },
    budget: {
      maxNodeStarts: 6,
      maxModelTokens: 30_000,
      maxCostUsd: 3,
      maxExecutionMs: 900_000,
      maxArtifactBytes: 3_145_728,
    },
    concurrency: { maxNodes: 1 },
    nodes: [agentNode("manager", "Complete the task."), resultNode("publish", "manager")],
  });
}

function childWorkflowText(): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "review-specialist" },
    budget: {
      maxNodeStarts: 2,
      maxModelTokens: 10_000,
      maxCostUsd: 1,
      maxExecutionMs: 300_000,
      maxArtifactBytes: 1_048_576,
    },
    nodes: [agentNode("review", "Review independently."), resultNode("publish-review", "review")],
  });
}

function agentNode(id: string, prompt: string) {
  return {
    id,
    type: "agent",
    dependsOn: [],
    agent: {
      prompt,
      model: { provider: "test", id: "deterministic", thinking: "off" },
      tools: ["read"],
      skills: [],
      toolPackages: [],
      timeoutMs: 300_000,
    },
  };
}

function resultNode(id: string, sourceNodeId: string) {
  return {
    id,
    type: "result",
    dependsOn: [sourceNodeId],
    result: {
      source: { nodeId: sourceNodeId, field: "agent.text" },
      schema: { type: "string", maxLength: 2_048 },
    },
  };
}

function executorAdmission(assertCurrent = async () => undefined): DelegationExecutorAdmission {
  return Object.freeze({ identity: executorIdentity(), assertCurrent });
}

function executorIdentity(): DelegationExecutorIdentity {
  const content = {
    version: 1 as const,
    kind: "embedded-pi-v1" as const,
    adapterContractVersion: "1.0.0",
    node: { version: "27.0.0", executableSha256: "a".repeat(64) },
    harness: {
      package: "@earendil-works/pi-coding-agent" as const,
      version: "0.84.0",
      integrity: "sha512-test-coding-agent",
      packageContentSha256: "b".repeat(64),
    },
    inference: {
      package: "@earendil-works/pi-ai" as const,
      version: "0.84.0",
      integrity: "sha512-test-pi-ai",
      packageContentSha256: "c".repeat(64),
    },
    dependencyClosureSha256: "d".repeat(64),
  };
  return Object.freeze({
    ...content,
    identityDigest: calculateDelegationExecutorIdentityDigest(content),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
