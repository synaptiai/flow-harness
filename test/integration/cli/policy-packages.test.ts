import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type CliIo, main } from "../../../src/cli/main.js";
import { createPolicyPackageSnapshot } from "../../../src/domain/capability/policy-packages.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("policy package CLI", () => {
  it("lists, inspects an exact version, and validates inert manifests without execution", async () => {
    const project = await projectFixture();
    const execute = vi.fn(async () => {
      throw new Error("policy metadata commands must not execute a node");
    });
    const listed = captureIo();
    const inspected = captureIo();
    const validated = captureIo();

    expect(
      await main(["policies", "list"], listed.io, { cwd: project, executor: { execute } }),
      listed.stderr.join("\n"),
    ).toBe(0);
    expect(
      await main(["policies", "inspect", "restricted-review", "--version", "1.2.3"], inspected.io, {
        cwd: project,
        executor: { execute },
      }),
    ).toBe(0);
    expect(
      await main(["policies", "validate"], validated.io, {
        cwd: project,
        executor: { execute },
      }),
    ).toBe(0);

    expect(JSON.parse(listed.stdout[0] ?? "null")).toMatchObject({
      packages: [
        {
          name: "restricted-review",
          version: "1.2.3",
          trust: "project-explicit",
          provenance: ".flow/policies/restricted-review",
          definition: { tools: { allowed: ["read"] } },
        },
      ],
    });
    expect(JSON.parse(inspected.stdout[0] ?? "null")).toMatchObject({
      kind: "policy-package",
      name: "restricted-review",
      version: "1.2.3",
      definition: {
        models: { allowed: [{ provider: "test", model: "allowed" }] },
        tools: { allowed: ["read"], allowedPermissions: ["filesystem.read"] },
      },
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifest: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(inspected.stdout.join("\n")).not.toContain("contentBase64");
    expect(JSON.parse(validated.stdout[0] ?? "null")).toMatchObject({
      valid: true,
      packages: ["restricted-review@1.2.3"],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("applies the configured package during workflow validation", async () => {
    const project = await projectFixture();
    const allowed = join(project, "allowed.workflow.yaml");
    const rejected = join(project, "rejected.workflow.yaml");
    await writeFile(allowed, workflowSource("read"), "utf8");
    await writeFile(rejected, workflowSource("edit"), "utf8");
    const acceptedOutput = captureIo();
    const rejectedOutput = captureIo();

    expect(
      await main(["validate", allowed], acceptedOutput.io, { cwd: project }),
      acceptedOutput.stderr.join("\n"),
    ).toBe(0);
    expect(acceptedOutput.stdout.join("\n")).toContain("policy packages: 1");
    expect(await main(["validate", rejected], rejectedOutput.io, { cwd: project })).toBe(1);
    expect(rejectedOutput.stderr.join("\n")).toMatch(
      /policy_violation.*nodes\.agent\.agent\.tools.*edit.*not allowed/i,
    );
  });

  it("requires an exact version when inspecting", async () => {
    const project = await projectFixture();
    const output = captureIo();

    expect(
      await main(["policies", "inspect", "restricted-review"], output.io, { cwd: project }),
    ).toBe(2);
    expect(output.stderr.join("\n")).toMatch(/--version <exact>/i);
  });
});

async function projectFixture(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-policy-cli-")));
  temporaryDirectories.push(project);
  const directory = join(project, ".flow", "policies", "restricted-review");
  const source = policyManifest();
  const snapshot = createPolicyPackageSnapshot({
    kind: "policy-package",
    trust: "project-explicit",
    provenance: ".flow/policies/restricted-review",
    manifest: { content: Buffer.from(source) },
  });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "POLICY.yaml"), source, "utf8");
  await writeFile(
    join(project, ".flow", "config.yaml"),
    `apiVersion: flow.synapti.ai/v1alpha1
kind: FlowProjectConfig
policies:
  additional:
    - name: restricted-review
      version: 1.2.3
      digest: ${snapshot.digest}
`,
    "utf8",
  );
  return project;
}

function policyManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: restricted-review
  version: 1.2.3
  description: Restrict reviews to read-only work.
spec:
  models:
    allowed:
      - { provider: test, model: allowed }
  tools:
    allowed: [read]
    allowedPermissions: [filesystem.read]
  budget:
    maxNodeStarts: 2
`;
}

function workflowSource(tool: "read" | "edit"): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: policy-cli }
budget: { maxNodeStarts: 2 }
nodes:
  - id: agent
    type: agent
    agent:
      prompt: Review the project.
      model: { provider: test, id: allowed }
      tools: [${tool}]
  - id: finish
    type: command
    dependsOn: [agent]
    command: { executable: node, args: [--version] }
`;
}

function captureIo(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}
