import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
import type { CommandEvidence, RunEvent } from "../../../src/domain/run/events.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("verifier package CLI", () => {
  it("lists, inspects, and validates identity without executing or printing the rubric", async () => {
    const project = await temporaryProject();
    await writePackage(project, "evidence-review", modelManifest("PRIVATE RUBRIC"));
    const listed = captureIo();
    const inspected = captureIo();
    const validated = captureIo();

    expect(await main(["verifiers", "list"], listed.io, dependencies(project))).toBe(0);
    expect(
      await main(["verifiers", "inspect", "evidence-review"], inspected.io, dependencies(project)),
    ).toBe(0);
    expect(await main(["verifiers", "validate"], validated.io, dependencies(project))).toBe(0);

    expect(JSON.parse(listed.stdout[0] ?? "null")).toMatchObject({
      packages: [
        {
          name: "evidence-review",
          version: "1.2.0",
          definition: { kind: "model" },
        },
      ],
    });
    expect(JSON.stringify(JSON.parse(listed.stdout[0] ?? "null"))).not.toContain("PRIVATE RUBRIC");
    expect(JSON.parse(inspected.stdout[0] ?? "null")).toMatchObject({
      name: "evidence-review",
      version: "1.2.0",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifest: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(inspected.stdout.join("\n")).not.toContain("contentBase64");
    expect(inspected.stdout.join("\n")).not.toContain("PRIVATE RUBRIC");
    expect(JSON.parse(validated.stdout[0] ?? "null")).toMatchObject({
      valid: true,
      packages: ["evidence-review@1.2.0"],
    });
  });

  it("validates and runs a workflow with mixed skill and verifier packages from one snapshot", async () => {
    const project = await temporaryProject();
    await writeSkill(project, "review");
    await writePackage(project, "release-tests", commandManifest());
    const workflowPath = join(project, "packaged.workflow.yaml");
    await writeFile(workflowPath, mixedWorkflow(), "utf8");
    const validateOutput = captureIo();
    const runOutput = captureIo();
    const store = new MemoryStore();
    let observed: NodeExecutionContext | undefined;
    const executor: NodeExecutor = {
      async execute(node, context) {
        if (node.type === "agent") {
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
              capabilities: {
                selected: [
                  {
                    name: "review",
                    digest:
                      context.capabilitySnapshot?.packages.find(
                        (item) => item.kind === "agent-skill" && item.name === "review",
                      )?.digest ?? "",
                  },
                ],
                reads: [],
              },
            },
          };
        }
        if (node.type !== "verifier" || node.verifier.kind !== "command") {
          throw new Error(`unexpected packaged CLI node "${node.type}"`);
        }
        observed = context;
        return packagedCommandSuccess(context);
      },
    };

    expect(await main(["validate", workflowPath], validateOutput.io, dependencies(project))).toBe(
      0,
    );
    expect(validateOutput.stdout.join("\n")).toContain("skills: 1, verifier packages: 1");
    expect(
      await main(
        ["run", workflowPath, "--run-id", "cli-verifier-package"],
        runOutput.io,
        dependencies(project, { executor, createStore: () => store }),
      ),
    ).toBe(0);

    expect(observed?.verifierPackage).toMatchObject({
      name: "release-tests",
      version: "1.0.0",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: {
        packages: [
          { kind: "agent-skill", name: "review" },
          { kind: "verifier-package", name: "release-tests", version: "1.0.0" },
        ],
      },
    });
  });

  it("fails workflow validation when the exact selected version is unavailable", async () => {
    const project = await temporaryProject();
    await writePackage(project, "release-tests", commandManifest());
    const workflowPath = join(project, "missing-version.workflow.yaml");
    await writeFile(workflowPath, mixedWorkflow().replace("version: 1.0.0", "version: 2.0.0"));
    await writeSkill(project, "review");
    const output = captureIo();

    expect(await main(["validate", workflowPath], output.io, dependencies(project))).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/version_mismatch.*2\.0\.0.*1\.0\.0/i);
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

function packagedCommandSuccess(context: NodeExecutionContext): NodeExecutionOutcome {
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
  const reason = "command exited with code 0";
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

async function temporaryProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-verifier-cli-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "skills"), { recursive: true });
  await mkdir(join(project, ".flow", "verifiers"), { recursive: true });
  return project;
}

async function writeSkill(project: string, name: string): Promise<void> {
  const directory = join(project, ".flow", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Review code when selected.\n---\n# Review\n`,
  );
}

async function writePackage(project: string, name: string, source: string): Promise<void> {
  const directory = join(project, ".flow", "verifiers", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "VERIFIER.yaml"), source, "utf8");
}

function modelManifest(prompt: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: evidence-review, version: 1.2.0, description: Review evidence. }
spec: { kind: model, prompt: ${prompt} }
`;
}

function commandManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: release-tests, version: 1.0.0, description: Run release tests. }
spec:
  kind: command
  command: { executable: node, args: [--version], timeoutMs: 30000 }
`;
}

function mixedWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: mixed-packages }
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: test, id: deterministic }
      tools: [read]
      skills: [review]
  - id: release
    type: verifier
    dependsOn: [analyze]
    verifier:
      kind: packaged-command
      package: { name: release-tests, version: 1.0.0 }
`;
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
