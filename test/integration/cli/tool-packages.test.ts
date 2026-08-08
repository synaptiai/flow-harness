import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
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

describe("tool package CLI", () => {
  it("lists, inspects an exact version, and validates inert manifests without execution", async () => {
    const project = await temporaryProject();
    await writeToolPackage(project, "project-report", toolManifest());
    const execute = vi.fn(async () => {
      throw new Error("metadata commands must not execute a node");
    });
    const listed = captureIo();
    const inspected = captureIo();
    const validated = captureIo();
    const cliDependencies = dependencies(project, { executor: { execute } });

    expect(await main(["tools", "list"], listed.io, cliDependencies)).toBe(0);
    expect(
      await main(
        ["tools", "inspect", "project-report", "--version", "1.2.3"],
        inspected.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(await main(["tools", "validate"], validated.io, cliDependencies)).toBe(0);

    expect(JSON.parse(listed.stdout[0] ?? "null")).toMatchObject({
      packages: [
        {
          name: "project-report",
          version: "1.2.3",
          trust: "project-explicit",
          provenance: ".flow/tools/project-report",
          toolName: "create_project_report",
          permissions: ["process.execute"],
          driver: { kind: "command", version: "v1", profile: "posix-printf-v1" },
        },
      ],
    });
    expect(JSON.parse(inspected.stdout[0] ?? "null")).toMatchObject({
      kind: "tool-package",
      name: "project-report",
      version: "1.2.3",
      trust: "project-explicit",
      provenance: ".flow/tools/project-report",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      definition: {
        tool: { name: "create_project_report" },
        driver: {
          kind: "command",
          executable: "/usr/bin/printf",
          args: ["%s", "{input:subject}"],
        },
      },
      manifest: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(inspected.stdout.join("\n")).not.toContain("contentBase64");
    expect(JSON.parse(validated.stdout[0] ?? "null")).toMatchObject({
      valid: true,
      packages: ["project-report@1.2.3"],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires an exact version when inspecting a package", async () => {
    const project = await temporaryProject();
    await writeToolPackage(project, "project-report", toolManifest());
    const missing = captureIo();
    const mismatched = captureIo();

    expect(
      await main(["tools", "inspect", "project-report"], missing.io, dependencies(project)),
    ).toBe(2);
    expect(missing.stderr.join("\n")).toMatch(/--version <exact>/i);
    expect(
      await main(
        ["tools", "inspect", "project-report", "--version", "2.0.0"],
        mismatched.io,
        dependencies(project),
      ),
    ).toBe(1);
    expect(mismatched.stderr.join("\n")).toMatch(/version_mismatch.*2\.0\.0.*1\.2\.3/i);
  });

  it("validates and passes an exact tool package snapshot into attached execution", async () => {
    const project = await temporaryProject();
    await writeToolPackage(project, "project-report", toolManifest());
    const workflowPath = join(project, "tool-package.workflow.yaml");
    await writeFile(workflowPath, workflowSource(), "utf8");
    const validateOutput = captureIo();
    const runOutput = captureIo();
    const store = new MemoryStore();
    let observed: NodeExecutionContext | undefined;
    const executor: NodeExecutor = {
      async execute(_node, context) {
        observed = context;
        return successfulAgentOutcome();
      },
    };

    expect(await main(["validate", workflowPath], validateOutput.io, dependencies(project))).toBe(
      0,
    );
    expect(validateOutput.stdout.join("\n")).toContain("tool packages: 1");
    expect(
      await main(
        ["run", workflowPath, "--run-id", "cli-tool-package"],
        runOutput.io,
        dependencies(project, { executor, createStore: () => store }),
      ),
    ).toBe(0);

    expect(observed?.capabilitySnapshot?.packages).toEqual([
      expect.objectContaining({
        kind: "tool-package",
        name: "project-report",
        version: "1.2.3",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      toolPackageRequirements: [
        {
          nodeId: "analyze",
          packages: [{ name: "project-report", version: "1.2.3" }],
        },
      ],
      capabilitySnapshot: {
        packages: [{ kind: "tool-package", name: "project-report", version: "1.2.3" }],
      },
    });
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
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-tools-cli-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "tools"), { recursive: true });
  return project;
}

async function writeToolPackage(project: string, name: string, source: string): Promise<void> {
  const directory = join(project, ".flow", "tools", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "TOOL.yaml"), source, "utf8");
}

function toolManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: project-report
  version: 1.2.3
  description: Create a bounded project report.
  license: Apache-2.0
  compatibility: Requires printf in the execution environment.
spec:
  tool:
    name: create_project_report
    description: Print the selected report subject.
    inputs:
      - { name: subject, description: Report subject., type: string }
  driver:
    kind: command
    version: v1
    profile: posix-printf-v1
    executable: /usr/bin/printf
    args: ["%s", "{input:subject}"]
    timeoutMs: 10000
  permissions: [process.execute]
`;
}

function workflowSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-tool-package }
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: test, id: deterministic }
      tools: [read]
      toolPackages:
        - { name: project-report, version: 1.2.3 }
  - id: publish
    type: result
    dependsOn: [analyze]
    result:
      source: { nodeId: analyze, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}

function successfulAgentOutcome(): NodeExecutionOutcome {
  const text = JSON.stringify("done");
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text,
      textHash: createHash("sha256").update(text).digest("hex"),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [],
      effectReceipts: [],
    },
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

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  return { io, stdout, stderr };
}
