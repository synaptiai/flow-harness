import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import { createPolicyPackageSnapshot } from "../../../src/domain/capability/policy-packages.js";
import { calculateFlowPolicyDigest } from "../../../src/domain/config/resolver.js";
import { loadEffectiveFlowConfig } from "../../../src/infrastructure/fs/flow-config-store.js";
import {
  PolicyPackageCatalogError,
  type PolicyPackageCatalogErrorCode,
} from "../../../src/infrastructure/fs/local-policy-package-catalog.js";

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

  it("uses the admitted policy snapshot while resolving a supplemental skill", async () => {
    const project = await projectFixture();
    const skillDirectory = join(project, ".flow", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: review\ndescription: Review the project.\n---\nReview safely.\n",
      "utf8",
    );
    const config = await loadEffectiveFlowConfig({ cwd: project });
    await writeFile(
      join(project, ".flow", "policies", "restricted-review", "POLICY.yaml"),
      "kind: Invalid\n",
      "utf8",
    );
    const workflowPath = join(project, "supplemental-skill.workflow.yaml");
    await writeFile(workflowPath, workflowWithSkillSource(), "utf8");
    const output = captureIo();

    expect(
      await main(["validate", workflowPath], output.io, {
        cwd: project,
        loadConfig: async () => config,
      }),
      output.stderr.join("\n"),
    ).toBe(0);
    expect(output.stdout.join("\n")).toContain("policy packages: 1");
    expect(output.stdout.join("\n")).toContain("skills: 1");
  });

  it("loads a selected policy without parsing an unrelated invalid skill", async () => {
    const project = await projectFixture();
    const skillDirectory = join(project, ".flow", "skills", "unselected");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "kind: Invalid\n", "utf8");

    await expect(loadEffectiveFlowConfig({ cwd: project })).resolves.toMatchObject({
      policyPackages: { snapshot: { packages: [{ name: "restricted-review" }] } },
    });
  });

  it("passes the parsed policy package identity into the internal supervisor daemon", async () => {
    const project = await projectFixture();
    const policyPackageDigest = "b".repeat(64);
    const supervisor = { maxActiveWorkers: 2, maxQueuedJobs: 7 };
    const policyDigest = calculateFlowPolicyDigest(supervisor, "native", policyPackageDigest);
    let observedPolicy: unknown;
    const output = captureIo();

    expect(
      await main(
        [
          "__supervisor",
          "--runs-dir",
          join(project, "internal-runs"),
          "--startup-token",
          "source-token",
          "--startup-owner-token",
          "owner-token",
          "--policy-digest",
          policyDigest,
          "--policy-package-digest",
          policyPackageDigest,
          "--sandbox-profile",
          "native",
          "--max-active-workers",
          String(supervisor.maxActiveWorkers),
          "--max-queued-jobs",
          String(supervisor.maxQueuedJobs),
        ],
        output.io,
        {
          cwd: project,
          runSupervisorDaemon: async (options) => {
            observedPolicy = options.policy;
          },
        },
      ),
      output.stderr.join("\n"),
    ).toBe(0);
    expect(observedPolicy).toEqual({
      policyDigest,
      policyPackageDigest,
      sandbox: { profile: "native" },
      supervisor,
    });
  });

  it("rejects a policy-incompatible detached workflow before supervisor mutation", async () => {
    const project = await projectFixture();
    const rejected = join(project, "rejected-detached.workflow.yaml");
    const runsDirectory = join(project, "detached-runs");
    await writeFile(rejected, workflowSource("edit"), "utf8");
    const output = captureIo();

    expect(
      await main(
        ["run", rejected, "--detach", "--runs-dir", runsDirectory, "--run-id", "rejected"],
        output.io,
        { cwd: project },
      ),
    ).toBe(1);
    expect(output.stderr.join("\n")).toMatch(
      /policy_violation.*nodes\.agent\.agent\.tools.*edit.*not allowed/i,
    );
    await expect(stat(runsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires an exact version when inspecting", async () => {
    const project = await projectFixture();
    const output = captureIo();

    expect(
      await main(["policies", "inspect", "restricted-review"], output.io, { cwd: project }),
    ).toBe(2);
    expect(output.stderr.join("\n")).toMatch(/--version <exact>/i);
  });

  it("resumes from durable policy bytes after the live catalog disappears", async () => {
    const project = await projectFixture();
    const workflowPath = join(project, "offline-policy.workflow.yaml");
    await writeFile(workflowPath, workflowSource("read"), "utf8");
    const executor = successfulExecutor();
    const runOutput = captureIo();
    const resumeOutput = captureIo();

    expect(
      await main(["run", workflowPath, "--run-id", "offline-policy"], runOutput.io, {
        cwd: project,
        executor,
      }),
      runOutput.stderr.join("\n"),
    ).toBe(0);
    await rm(join(project, ".flow", "policies"), { recursive: true });

    expect(
      await main(["resume", workflowPath, "--run-id", "offline-policy"], resumeOutput.io, {
        cwd: project,
        executor,
      }),
    ).toBe(1);
    expect(resumeOutput.stderr.join("\n")).toMatch(/terminal_run.*already terminal.*succeeded/i);
    expect(resumeOutput.stderr.join("\n")).not.toMatch(/missing_package|ENOENT|no such file/i);
  });

  it("rejects a current policy selection that contradicts durable policy bytes", async () => {
    const project = await projectFixture();
    const workflowPath = join(project, "changed-policy.workflow.yaml");
    await writeFile(workflowPath, workflowSource("read"), "utf8");
    const executor = successfulExecutor();
    const runOutput = captureIo();
    const resumeOutput = captureIo();

    expect(
      await main(["run", workflowPath, "--run-id", "changed-policy"], runOutput.io, {
        cwd: project,
        executor,
      }),
      runOutput.stderr.join("\n"),
    ).toBe(0);
    await writeFile(
      join(project, ".flow", "config.yaml"),
      `apiVersion: flow.synapti.ai/v1alpha1
kind: FlowProjectConfig
policies:
  additional:
    - name: restricted-review
      version: 1.2.3
      digest: "${"0".repeat(64)}"
`,
      "utf8",
    );
    await rm(join(project, ".flow", "policies"), { recursive: true });

    expect(
      await main(["resume", workflowPath, "--run-id", "changed-policy"], resumeOutput.io, {
        cwd: project,
        executor,
      }),
    ).toBe(2);
    expect(resumeOutput.stderr.join("\n")).toMatch(
      /invalid_config.*policies\.additional\.0\.digest.*does not match/i,
    );
  });

  it("rejects a policy-incompatible detached resume before supervisor mutation", async () => {
    const project = await projectFixture();
    const workflowPath = join(project, "detached-resume.workflow.yaml");
    const runsDirectory = join(project, "detached-resume-runs");
    await writeFile(workflowPath, workflowSource("read"), "utf8");
    const runOutput = captureIo();

    expect(
      await main(
        ["run", workflowPath, "--run-id", "detached-resume", "--runs-dir", runsDirectory],
        runOutput.io,
        { cwd: project, executor: successfulExecutor() },
      ),
      runOutput.stderr.join("\n"),
    ).toBe(0);
    const before = (await readdir(runsDirectory, { recursive: true })).sort();
    await writeFile(workflowPath, workflowSource("edit"), "utf8");
    const resumeOutput = captureIo();

    expect(
      await main(
        [
          "resume",
          workflowPath,
          "--run-id",
          "detached-resume",
          "--runs-dir",
          runsDirectory,
          "--detach",
        ],
        resumeOutput.io,
        { cwd: project },
      ),
    ).toBe(1);
    expect(resumeOutput.stderr.join("\n")).toMatch(
      /policy_violation.*nodes\.agent\.agent\.tools.*edit.*not allowed/i,
    );
    await expect(readdir(runsDirectory, { recursive: true })).resolves.toEqual(before);
  });

  it("keeps private catalog paths out of public diagnostics", async () => {
    const project = await projectFixture();
    const privateCanary = "PRIVATE_POLICY_CATALOG_CANARY";
    await writeFile(
      join(project, ".flow", "policies", "restricted-review", privateCanary),
      "private\n",
      "utf8",
    );
    const output = captureIo();

    expect(await main(["policies", "validate"], output.io, { cwd: project })).toBe(1);
    expect(output.stderr).toEqual([
      "unsafe_entry: policy package catalog contains an unsafe entry",
    ]);
    expect(output.stderr.join("\n")).not.toContain(privateCanary);
    expect(output.stderr.join("\n")).not.toContain(project);
  });

  it("propagates exact cancellation through config and policy catalog discovery", async () => {
    const project = await projectFixture();
    const config = await loadEffectiveFlowConfig({ cwd: project });
    const controller = new AbortController();
    const reason = new Error("operator cancelled policy inspection");
    controller.abort(reason);
    const loadConfig = vi.fn(async (options) => {
      expect(options?.signal).toBe(controller.signal);
      return config;
    });
    const output = captureIo();

    expect(
      await main(["policies", "validate"], output.io, {
        cwd: project,
        loadConfig,
        signal: controller.signal,
      }),
    ).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([reason.message]);
    expect(loadConfig).toHaveBeenCalledOnce();
  });

  it.each([
    ["duplicate_package", "policy package catalog contains a duplicate package"],
    ["invalid_package", "policy package catalog contains an invalid package"],
    ["io", "policy package catalog inspection failed"],
    ["limit_exceeded", "policy package catalog exceeds its limits"],
    ["missing_package", "required policy package is unavailable"],
    ["source_changed", "policy package source changed during capture"],
    ["unsafe_entry", "policy package catalog contains an unsafe entry"],
    ["version_mismatch", "policy package version does not match"],
  ] satisfies readonly (readonly [PolicyPackageCatalogErrorCode, string])[])(
    "keeps %s catalog diagnostics value-free",
    async (code, publicMessage) => {
      const privateCanary = `PRIVATE_${code.toUpperCase()}_CANARY`;
      const output = captureIo();

      expect(
        await main(["policies", "list"], output.io, {
          cwd: "/unused",
          loadConfig: async () => {
            throw new PolicyPackageCatalogError(code, privateCanary, {
              cause: new Error(privateCanary),
            });
          },
        }),
      ).toBe(1);
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual([`${code}: ${publicMessage}`]);
      expect(output.stderr.join("\n")).not.toContain(privateCanary);
    },
  );
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

function workflowWithSkillSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: policy-skill-snapshot }
budget: { maxNodeStarts: 2 }
nodes:
  - id: agent
    type: agent
    agent:
      prompt: Review the project.
      model: { provider: test, id: allowed }
      tools: [read]
      skills: [review]
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

function successfulExecutor(): NodeExecutor {
  return {
    execute: vi.fn(async (node) => ({
      status: "succeeded" as const,
      evidence: {
        kind: "command" as const,
        executable: node.type === "command" ? node.command.executable : "/usr/bin/true",
        args: node.type === "command" ? node.command.args : [],
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutHash: createHash("sha256").update("").digest("hex"),
        stderrHash: createHash("sha256").update("").digest("hex"),
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        durationMs: 1,
      },
    })),
  };
}
