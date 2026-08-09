import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NodeExecutor, RecoverableRunEventStore } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import type { RunEvent } from "../../../src/domain/run/events.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("workflow package CLI", () => {
  it("advertises exact package locators for validate, run, and resume", async () => {
    const output = captureIo();

    expect(await main(["--help"], output.io)).toBe(0);
    expect(output.stdout.join("\n")).toContain(
      "flow validate <workflow.yaml|workflow:name@version>",
    );
    expect(output.stdout.join("\n")).toContain("flow run <workflow.yaml|workflow:name@version>");
    expect(output.stdout.join("\n")).toContain("flow resume <workflow.yaml|workflow:name@version>");
  });

  it("lists, inspects an exact version, and validates inert manifests without execution", async () => {
    const project = await temporaryProject();
    await writeWorkflowPackage(project);
    const execute = vi.fn(async () => {
      throw new Error("workflow metadata commands must not execute a node");
    });
    const cliDependencies = dependencies(project, { executor: { execute } });
    const listed = captureIo();
    const inspected = captureIo();
    const validated = captureIo();

    expect(await main(["workflows", "list"], listed.io, cliDependencies)).toBe(0);
    expect(
      await main(
        ["workflows", "inspect", "release-check", "--version", "1.0.0"],
        inspected.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(await main(["workflows", "validate"], validated.io, cliDependencies)).toBe(0);

    expect(JSON.parse(listed.stdout[0] ?? "null")).toMatchObject({
      packages: [
        {
          name: "release-check",
          version: "1.0.0",
          workflowBytes: expect.any(Number),
          workflowSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          provenance: ".flow/workflows/release-check",
        },
      ],
    });
    expect(JSON.parse(inspected.stdout[0] ?? "null")).toMatchObject({
      kind: "workflow-package",
      name: "release-check",
      version: "1.0.0",
      workflow: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      manifest: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(inspected.stdout.join("\n")).not.toContain("contentBase64");
    expect(inspected.stdout.join("\n")).not.toContain("apiVersion: flow.synapti.ai/v1alpha1");
    expect(JSON.parse(validated.stdout[0] ?? "null")).toMatchObject({
      valid: true,
      packages: ["release-check@1.0.0"],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates a packaged child and runs a packaged root from exact snapshot bytes", async () => {
    const project = await temporaryProject();
    await writeWorkflowPackage(project);
    const parentPath = join(project, "parent.workflow.yaml");
    await writeFile(parentPath, parentWorkflow(), "utf8");
    const childValidation = captureIo();
    const rootValidation = captureIo();
    const runOutput = captureIo();
    const resumeOutput = captureIo();
    const store = new MemoryStore();
    const executionDependencies = dependencies(project, {
      executor: successfulExecutor(),
      createStore: () => store,
    });

    expect(await main(["validate", parentPath], childValidation.io, dependencies(project))).toBe(0);
    expect(childValidation.stdout.join("\n")).toContain("workflow packages: 1");
    expect(
      await main(
        ["validate", "workflow:release-check@1.0.0"],
        rootValidation.io,
        dependencies(project),
      ),
    ).toBe(0);
    expect(
      await main(
        ["run", "workflow:release-check@1.0.0", "--run-id", "packaged-root"],
        runOutput.io,
        executionDependencies,
      ),
    ).toBe(0);

    expect(store.events[0]).toMatchObject({
      type: "run_started",
      workflowPackageRequirements: [
        {
          name: "release-check",
          version: "1.0.0",
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
      capabilitySnapshot: {
        packages: [{ kind: "workflow-package", name: "release-check", version: "1.0.0" }],
      },
    });
    expect(JSON.parse(runOutput.stdout[0] ?? "null")).toMatchObject({ status: "succeeded" });

    await rm(join(project, ".flow", "workflows"), { recursive: true });
    expect(
      await main(
        ["resume", "workflow:release-check@1.0.0", "--run-id", "packaged-root"],
        resumeOutput.io,
        executionDependencies,
      ),
    ).toBe(1);
    expect(resumeOutput.stderr.join("\n")).toMatch(/already terminal.*succeeded/i);
    expect(resumeOutput.stderr.join("\n")).not.toMatch(/ENOENT|no such file/i);
  });

  it("rejects ranges and unavailable exact root versions before execution", async () => {
    const project = await temporaryProject();
    await writeWorkflowPackage(project);
    const execute = vi.fn(async () => {
      throw new Error("invalid package selection must not execute a node");
    });
    const cliDependencies = dependencies(project, { executor: { execute } });
    const rangeOutput = captureIo();
    const missingOutput = captureIo();

    expect(
      await main(
        ["run", "workflow:release-check@^1.0.0", "--run-id", "invalid-range"],
        rangeOutput.io,
        cliDependencies,
      ),
    ).toBe(2);
    expect(rangeOutput.stderr.join("\n")).toMatch(/exact-semantic-version/i);
    expect(
      await main(
        ["run", "workflow:release-check@2.0.0", "--run-id", "missing-version"],
        missingOutput.io,
        cliDependencies,
      ),
    ).toBe(1);
    expect(missingOutput.stderr.join("\n")).toMatch(/version_mismatch.*2\.0\.0.*1\.0\.0/i);
    expect(execute).not.toHaveBeenCalled();
  });
});

class MemoryStore implements RecoverableRunEventStore {
  readonly events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async claim(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async release(): Promise<void> {}
}

async function temporaryProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-workflows-cli-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "workflows"), { recursive: true });
  return project;
}

async function writeWorkflowPackage(project: string): Promise<void> {
  const directory = join(project, ".flow", "workflows", "release-check");
  await mkdir(directory, { recursive: true });
  const indented = reusableWorkflow()
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  await writeFile(
    join(directory, "WORKFLOW.yaml"),
    `apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata:
  name: release-check
  version: 1.0.0
  description: Run a reusable release check.
spec:
  workflow: |-
${indented}
`,
  );
}

function reusableWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: release-check }
budget:
  maxNodeStarts: 2
  maxModelTokens: 1
  maxCostUsd: 1
  maxExecutionMs: 1000
  maxArtifactBytes: 1024
nodes:
  - id: produce
    type: command
    command: { executable: /usr/bin/true }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
`;
}

function parentWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: parent }
budget:
  maxNodeStarts: 4
  maxModelTokens: 10
  maxCostUsd: 1
  maxExecutionMs: 5000
nodes:
  - id: delegate
    type: child
    child:
      resultNodeId: publish
      package: { name: release-check, version: 1.0.0 }
`;
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
        stdout: "true",
        stderr: "",
        stdoutHash: sha256("true"),
        stderrHash: sha256(""),
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        durationMs: 1,
      },
    })),
  };
}

function dependencies(project: string, extra: Record<string, unknown> = {}) {
  return {
    cwd: project,
    loadConfig: async () => effectiveConfig(project),
    ...extra,
  };
}

function effectiveConfig(projectRoot: string): EffectiveFlowConfig {
  const supervisor = { ...BUILT_IN_FLOW_CONFIG };
  return {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
    policyDigest: calculateFlowPolicyDigest(supervisor),
    projectRoot,
    sources: {
      builtIn: BUILT_IN_FLOW_CONFIG,
      operator: null,
      project: { path: join(projectRoot, ".flow", "config.yaml"), values: {} },
    },
  };
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
