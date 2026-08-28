import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProductionGitHubIssueCliService } from "../../../src/cli/production-github-issue-service.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe("production GitHub issue CLI service", () => {
  it("validates the plan and both workflow roles without GitHub or durable mutation", async () => {
    const projectRoot = await createProject();
    const service = createProductionGitHubIssueCliService({
      projectRoot,
      sandboxProfile: "native",
      resolveExecutables: async () => {
        throw new Error("validate must not resolve Git or GitHub executables");
      },
    });

    await expect(
      service.execute({ kind: "validate", planPath: ".flow/github-issue.plan.yaml" }),
    ).resolves.toMatchObject({
      status: "valid",
      repositoryIdentity: "example/project",
      acceptanceCriterionCount: 1,
      verificationCommandCount: 1,
      hostedCheckCount: 1,
    });

    await expect(
      import("node:fs/promises").then(
        async ({ access }) => await access(join(projectRoot, ".flow", "issue-runs")),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an issue workflow that omits a frozen budget limit", async () => {
    const projectRoot = await createProject(
      implementationWorkflow().replace("  maxCostUsd: 1\n", ""),
    );
    const service = createProductionGitHubIssueCliService({
      projectRoot,
      sandboxProfile: "native",
    });

    await expect(
      service.execute({ kind: "validate", planPath: ".flow/github-issue.plan.yaml" }),
    ).rejects.toMatchObject({ code: "incomplete_budget" });
  });

  it("defers only model allow-list policy checks during model-agnostic validation", async () => {
    const projectRoot = await createProject();
    const capabilitySnapshot = createCapabilitySnapshot(
      [],
      [],
      [],
      [],
      [
        {
          kind: "policy-package",
          trust: "project-explicit",
          provenance: ".flow/policies/openai-only",
          manifest: {
            content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata: { name: openai-only, version: 1.0.0, description: OpenAI-only fixture. }
spec:
  models:
    allowed:
      - { provider: openai, model: gpt-5.6-terra }
`),
          },
        },
      ],
    );
    const service = createProductionGitHubIssueCliService({
      projectRoot,
      sandboxProfile: "native",
      capabilitySnapshot,
    });

    await expect(
      service.execute({ kind: "validate", planPath: ".flow/github-issue.plan.yaml" }),
    ).resolves.toMatchObject({ status: "valid" });
  });

  it("preflights the exact provider and sandbox before resolving mutating runtime adapters", async () => {
    const projectRoot = await createProject();
    const calls: string[] = [];
    const service = createProductionGitHubIssueCliService({
      projectRoot,
      sandboxProfile: "native",
      inspectProviderConfiguration: async (requirements) => {
        calls.push(`provider:${requirements[0]?.provider}/${requirements[0]?.model}`);
      },
      inspectSandbox: async (profile) => {
        calls.push(`sandbox:${profile}`);
        throw new Error("sandbox-unavailable");
      },
      resolveExecutables: async () => {
        calls.push("resolve-executables");
        throw new Error("must not resolve after failed preflight");
      },
    });

    await expect(
      service.execute({
        kind: "run",
        issueUrl: "https://github.com/example/project/issues/42",
        planPath: ".flow/github-issue.plan.yaml",
        provider: "openai",
        model: "gpt-5.6-terra",
        commandId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).rejects.toThrow("sandbox-unavailable");
    expect(calls).toEqual(["provider:openai/gpt-5.6-terra", "sandbox:native"]);
    await expect(
      import("node:fs/promises").then(
        async ({ access }) => await access(join(projectRoot, ".flow", "issue-runs")),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries runtime construction after a transient resolver failure", async () => {
    const projectRoot = await createProject();
    let attempts = 0;
    const service = createProductionGitHubIssueCliService({
      projectRoot,
      sandboxProfile: "native",
      inspectProviderConfiguration: async () => undefined,
      inspectSandbox: async () => undefined,
      resolveExecutables: async () => {
        attempts += 1;
        throw new Error(`resolver-attempt-${attempts}`);
      },
    });
    const request = {
      kind: "run" as const,
      issueUrl: "https://github.com/example/project/issues/42",
      planPath: ".flow/github-issue.plan.yaml",
      provider: "openai",
      model: "gpt-5.6-terra",
      commandId: "123e4567-e89b-42d3-a456-426614174000",
    };

    await expect(service.execute(request)).rejects.toThrow("resolver-attempt-1");
    await expect(service.execute(request)).rejects.toThrow("resolver-attempt-2");
    expect(attempts).toBe(2);
  });
});

async function createProject(implementationSource = implementationWorkflow()): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "flow-issue-cli-"));
  temporaryRoots.push(projectRoot);
  await mkdir(join(projectRoot, ".flow", "workflows"), { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, ".flow", "github-issue.plan.yaml"), planSource()),
    writeFile(
      join(projectRoot, ".flow", "workflows", "implementation.workflow.yaml"),
      implementationSource,
    ),
    writeFile(join(projectRoot, ".flow", "workflows", "review.workflow.yaml"), reviewWorkflow()),
  ]);
  return projectRoot;
}

function planSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: GitHubIssuePlan
repository: { expected: example/project, baseBranch: main }
branch: { prefix: flow/issue- }
candidate: { allowedPathPrefixes: [src/] }
implementation: { workflow: .flow/workflows/implementation.workflow.yaml }
holdout:
  command: { executable: node, args: [holdout.mjs], timeoutMs: 1000 }
verification:
  - id: test
    command: { executable: npm, args: [test], timeoutMs: 2000 }
hostedChecks:
  required:
    - name: CI / test
      sourceApp: { id: 15368, slug: github-actions }
review:
  workflow: .flow/workflows/review.workflow.yaml
  resultNode: review-result
  blockingSeverities: [P1, P2, P3]
merge: { method: squash, deleteBranch: true }
`;
}

function implementationWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: implementation }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: implement-issue }
  outcome: Implement the frozen issue.
  criteria:
    - id: implementation-reviewed
      description: The implementation is complete.
      verifier: { nodeId: verify-implementation }
budget:
  maxNodeStarts: 10
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 1000000
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Implement the issue.
      model: { provider: placeholder, id: placeholder }
      tools: [read, edit]
  - id: verify-implementation
    type: verifier
    dependsOn: [implement]
    verifier:
      kind: model
      prompt: Verify the implementation.
      evidence: [{ nodeId: implement, field: agent.text }]
      model: { provider: placeholder, id: placeholder }
`;
}

function reviewWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: review }
budget:
  maxNodeStarts: 10
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 1000000
nodes:
  - id: review-result
    type: agent
    agent:
      prompt: Review the exact candidate and return JSON.
      model: { provider: placeholder, id: placeholder }
      tools: [read]
  - id: publish
    type: verifier
    dependsOn: [review-result]
    verifier:
      kind: model
      prompt: Verify the review report.
      evidence: [{ nodeId: review-result, field: agent.text }]
      model: { provider: placeholder, id: placeholder }
`;
}
