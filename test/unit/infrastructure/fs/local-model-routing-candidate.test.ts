import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compileWorkflowText } from "../../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../../src/domain/workflow/digest.js";
import { admitLocalModelRoutingCandidate } from "../../../../src/infrastructure/fs/local-model-routing-candidate.js";

const MAX_LOCAL_WORKFLOW_BYTES = 1_048_576;
const MAX_MODEL_ROUTING_CANDIDATE_BYTES = 65_536;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local model-routing candidate admission", () => {
  it("reopens one bounded candidate and baseline into an immutable projection", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-model-route-")));
    temporaryDirectories.push(root);
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
    temporaryDirectories.push(root);
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
    temporaryDirectories.push(root);
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

  it("accepts both exact file bounds and rejects one additional byte", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-model-route-bound-")));
    temporaryDirectories.push(root);
    const baselinePath = join(root, "baseline.workflow.yaml");
    const candidatePath = join(root, "route.candidate.yaml");
    const exactBaseline =
      baselineText + " ".repeat(MAX_LOCAL_WORKFLOW_BYTES - Buffer.byteLength(baselineText, "utf8"));
    const candidate = candidateText(exactBaseline);
    const exactCandidate =
      candidate +
      " ".repeat(MAX_MODEL_ROUTING_CANDIDATE_BYTES - Buffer.byteLength(candidate, "utf8"));
    await writeFile(baselinePath, exactBaseline);
    await writeFile(candidatePath, exactCandidate);

    await expect(admitLocalModelRoutingCandidate(candidatePath)).resolves.toMatchObject({
      baseline: { sourceSha256: sha256(exactBaseline) },
    });
    await writeFile(candidatePath, `${exactCandidate} `);
    await expect(admitLocalModelRoutingCandidate(candidatePath)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    await writeFile(candidatePath, candidateText(`${exactBaseline} `));
    await writeFile(baselinePath, `${exactBaseline} `);
    await expect(admitLocalModelRoutingCandidate(candidatePath)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  });

  it("rejects linked files and fatal UTF-8 without disclosing their paths", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-model-route-files-")));
    temporaryDirectories.push(root);
    const privateCandidatePath = join(root, "PRIVATE_ROUTE.candidate.yaml");
    const candidatePath = join(root, "route.candidate.yaml");
    const privateBaselinePath = join(root, "PRIVATE_BASELINE.workflow.yaml");
    const baselinePath = join(root, "baseline.workflow.yaml");
    await writeFile(privateCandidatePath, candidateText());
    await writeFile(privateBaselinePath, baselineText);
    await symlink(privateCandidatePath, candidatePath);
    const candidateLinkError = await caughtAdmission(candidatePath);
    expectSafeAdmissionError(candidateLinkError, "invalid_path", "PRIVATE_ROUTE");

    await rm(candidatePath);
    await writeFile(candidatePath, candidateText());
    await symlink(privateBaselinePath, baselinePath);
    const baselineLinkError = await caughtAdmission(candidatePath);
    expectSafeAdmissionError(baselineLinkError, "invalid_path", "PRIVATE_BASELINE");

    await rm(baselinePath);
    await writeFile(baselinePath, Buffer.from([0xff]));
    const baselineUtf8Error = await caughtAdmission(candidatePath);
    expectSafeAdmissionError(baselineUtf8Error, "invalid_source", "PRIVATE_BASELINE");

    await writeFile(candidatePath, Buffer.from([0xff]));
    const candidateUtf8Error = await caughtAdmission(candidatePath);
    expectSafeAdmissionError(candidateUtf8Error, "invalid_source", "PRIVATE_ROUTE");
  });

  it("rejects a same-size candidate replacement after its stable read", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-model-route-candidate-race-")));
    temporaryDirectories.push(root);
    const baselinePath = join(root, "baseline.workflow.yaml");
    const candidatePath = join(root, "route.candidate.yaml");
    const original = candidateText();
    const replacement = original.replace("gpt-5.4", "gpt-5.5");
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    await writeFile(baselinePath, baselineText);
    await writeFile(candidatePath, original);

    await expect(
      admitLocalModelRoutingCandidate(candidatePath, {
        afterCandidateRead: () => writeFile(candidatePath, replacement),
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

function candidateText(baseline = baselineText): string {
  const compiled = compileWorkflowText(baseline, "baseline.workflow.yaml");
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
        sourceSha256: sha256(baseline),
        workflowDigest: calculateWorkflowDigest(compiled),
      },
    },
    route: {
      before: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
      after: { provider: "openai", id: "gpt-5.4", thinking: "high" },
    },
  });
}

async function caughtAdmission(path: string): Promise<Error | undefined> {
  try {
    await admitLocalModelRoutingCandidate(path);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : undefined;
  }
}

function expectSafeAdmissionError(
  error: Error | undefined,
  code: "invalid_path" | "invalid_source",
  canary: string,
): void {
  expect(error).toMatchObject({ code });
  expect(error?.cause).toBeUndefined();
  expect(error?.message).not.toContain(canary);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
