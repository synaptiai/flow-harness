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
  createAgentCapabilityEvidence,
  type CapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import { createCapabilityBundleSource } from "../../../src/domain/capability/capability-bundles.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import type { CommandEvidence, RunEvent } from "../../../src/domain/run/events.js";
import { LocalCapabilityPackageStore } from "../../../src/infrastructure/fs/local-capability-package-store.js";
import type { CapabilityBundleFetcher } from "../../../src/infrastructure/http/strict-capability-bundle-fetcher.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("installed capability workflow", () => {
  it("uses every installed ABI through existing CLI, execution, and offline replay paths", async () => {
    const project = await temporaryProject();
    const created = mixedBundle();
    const bundleDigest = created.bundle.digest.slice("sha256:".length);
    const packageStore = new LocalCapabilityPackageStore(project);
    await packageStore.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: bundleDigest,
      content: created.content,
    });
    const provenanceRoot = `.flow/packages/sha256/${bundleDigest}`;
    const fetch = vi.fn(async () => {
      throw new Error("workflow and replay must not fetch capability bundles");
    });
    const metadataDependencies = dependencies(project, {
      capabilityBundleFetcher: { fetch } satisfies CapabilityBundleFetcher,
    });

    const skills = await invoke(["skills", "list"], metadataDependencies);
    const skill = await invoke(["skills", "inspect", "review"], metadataDependencies);
    const skillValidation = await invoke(["skills", "validate"], metadataDependencies);
    const verifiers = await invoke(["verifiers", "list"], metadataDependencies);
    const verifier = await invoke(["verifiers", "inspect", "release-tests"], metadataDependencies);
    const verifierValidation = await invoke(["verifiers", "validate"], metadataDependencies);
    const tools = await invoke(["tools", "list"], metadataDependencies);
    const tool = await invoke(
      ["tools", "inspect", "project-status", "--version", "1.0.0"],
      metadataDependencies,
    );
    const toolValidation = await invoke(["tools", "validate"], metadataDependencies);

    expect(skills.json).toMatchObject({
      skills: [{ name: "review", provenance: `${provenanceRoot}/agent-skill/review` }],
    });
    expect(skill.json).toMatchObject({
      name: "review",
      provenance: `${provenanceRoot}/agent-skill/review`,
    });
    expect(skillValidation.json).toMatchObject({ valid: true, skills: ["review"] });
    expect(verifiers.json).toMatchObject({
      packages: [
        {
          name: "release-tests",
          version: "1.0.0",
          provenance: `${provenanceRoot}/verifier-package/release-tests`,
        },
      ],
    });
    expect(verifier.json).toMatchObject({
      name: "release-tests",
      version: "1.0.0",
      provenance: `${provenanceRoot}/verifier-package/release-tests`,
    });
    expect(verifierValidation.json).toMatchObject({
      valid: true,
      packages: ["release-tests@1.0.0"],
    });
    expect(tools.json).toMatchObject({
      packages: [
        {
          name: "project-status",
          version: "1.0.0",
          provenance: `${provenanceRoot}/tool-package/project-status`,
        },
      ],
    });
    expect(tool.json).toMatchObject({
      name: "project-status",
      version: "1.0.0",
      provenance: `${provenanceRoot}/tool-package/project-status`,
    });
    expect(toolValidation.json).toMatchObject({
      valid: true,
      packages: ["project-status@1.0.0"],
    });

    const workflowPath = join(project, "installed.workflow.yaml");
    await writeFile(workflowPath, workflowSource());
    const validation = await invoke(["validate", workflowPath], metadataDependencies);
    expect(validation.stdout).toContain("skills: 1, verifier packages: 1, tool packages: 1");

    const runStore = new MemoryStore();
    const observed: NodeExecutionContext[] = [];
    const executor: NodeExecutor = {
      async execute(node, context) {
        observed.push(context);
        return node.type === "agent"
          ? successfulAgentOutcome(context.capabilitySnapshot)
          : successfulVerifierOutcome(context);
      },
    };
    const run = await invoke(
      ["run", workflowPath, "--run-id", "installed-capability-run"],
      dependencies(project, {
        capabilityBundleFetcher: { fetch } satisfies CapabilityBundleFetcher,
        executor,
        createStore: () => runStore,
      }),
    );
    expect(run.code).toBe(0);
    expect(fetch).not.toHaveBeenCalled();

    const started = runStore.events.find((event) => event.type === "run_started");
    expect(started?.type).toBe("run_started");
    if (started?.type !== "run_started") {
      throw new Error("run did not record run_started");
    }
    expect(started.capabilitySnapshot?.packages).toHaveLength(3);
    expect(started.capabilitySnapshot?.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent-skill",
          name: "review",
          provenance: `${provenanceRoot}/agent-skill/review`,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          kind: "verifier-package",
          name: "release-tests",
          version: "1.0.0",
          provenance: `${provenanceRoot}/verifier-package/release-tests`,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          kind: "tool-package",
          name: "project-status",
          version: "1.0.0",
          provenance: `${provenanceRoot}/tool-package/project-status`,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );
    expect(JSON.stringify(started)).not.toContain("https://");
    const verifierSnapshot = started.capabilitySnapshot?.packages.find(
      (item) => item.kind === "verifier-package" && item.name === "release-tests",
    );
    expect(
      observed.find((context) => context.verifierPackage !== undefined)?.verifierPackage,
    ).toMatchObject({
      name: "release-tests",
      version: "1.0.0",
      digest: verifierSnapshot?.digest,
    });

    await packageStore.remove("review-suite", "1.0.0");
    const inspectedRun = await invoke(
      ["inspect", "installed-capability-run"],
      dependencies(project, {
        capabilityBundleFetcher: { fetch } satisfies CapabilityBundleFetcher,
        createStore: () => runStore,
      }),
    );
    expect(inspectedRun.code).toBe(0);
    expect(inspectedRun.stdout).toContain(`${provenanceRoot}/agent-skill/review`);
    expect(fetch).not.toHaveBeenCalled();
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
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-installed-workflow-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow"));
  return project;
}

function mixedBundle() {
  return createCapabilityBundleSource({
    name: "review-suite",
    version: "1.0.0",
    description: "Review capabilities.",
    packages: [
      {
        kind: "agent-skill",
        files: [
          {
            path: "SKILL.md",
            content: Buffer.from(`---
name: review
description: Review code when selected.
allowed-tools: read
---
Review the evidence.
`),
          },
        ],
      },
      { kind: "verifier-package", manifest: Buffer.from(verifierManifest()) },
      { kind: "tool-package", manifest: Buffer.from(toolManifest()) },
    ],
  });
}

function verifierManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: release-tests, version: 1.0.0, description: Run release tests. }
spec:
  kind: command
  command: { executable: node, args: [--version], timeoutMs: 30000 }
`;
}

function toolManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: project-status
  version: 1.0.0
  description: Show a bounded project status.
spec:
  tool:
    name: status_report
    description: Return a bounded project status.
    inputs: []
  driver:
    kind: command
    version: v1
    profile: git-status-v1
    executable: /usr/bin/git
    args: [--no-optional-locks, -c, core.fsmonitor=false, -c, core.untrackedCache=false, status, --short, --untracked-files=normal, --ignore-submodules=all]
    timeoutMs: 10000
  permissions: [process.execute]
`;
}

function workflowSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: installed-capabilities }
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: test, id: deterministic }
      tools: [read]
      skills: [review]
      toolPackages:
        - { name: project-status, version: 1.0.0 }
  - id: release
    type: verifier
    dependsOn: [analyze]
    verifier:
      kind: packaged-command
      package: { name: release-tests, version: 1.0.0 }
`;
}

function successfulAgentOutcome(snapshot?: CapabilitySnapshot): NodeExecutionOutcome {
  const text = "analyzed";
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text,
      textHash: sha256(text),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [],
      effectReceipts: [],
      ...(snapshot === undefined
        ? {}
        : { capabilities: createAgentCapabilityEvidence(snapshot, ["review"]) }),
    },
  };
}

function successfulVerifierOutcome(context: NodeExecutionContext): NodeExecutionOutcome {
  const reason = "command exited with code 0";
  const command: CommandEvidence = {
    kind: "command",
    executable: "node",
    args: ["--version"],
    exitCode: 0,
    signal: null,
    stdout: "v22.0.0",
    stderr: "",
    stdoutHash: sha256("v22.0.0"),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
  return {
    status: "succeeded",
    evidence: {
      kind: "verifier",
      driver: "command",
      result: "completed",
      verdict: "accepted",
      reason,
      reasonHash: sha256(reason),
      durationMs: 1,
      sources: [],
      command,
      ...(context.verifierPackage === undefined ? {} : { package: context.verifierPackage }),
    },
  };
}

async function invoke(
  args: readonly string[],
  cliDependencies: Record<string, unknown>,
): Promise<{ readonly code: number; readonly json: unknown; readonly stdout: string }> {
  const output = captureIo();
  const code = await main(args, output.io, cliDependencies);
  expect(code, output.stderr.join("\n")).toBe(0);
  const stdout = output.stdout.join("\n");
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { code, json, stdout };
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
