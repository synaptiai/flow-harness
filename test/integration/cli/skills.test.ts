import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
import type { RunEvent } from "../../../src/domain/run/events.js";
import {
  createAgentCapabilityEvidence,
  type CapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Agent Skills CLI", () => {
  it("lists metadata and inspects exact identity without printing package content", async () => {
    const project = await temporaryProject();
    await writeSkill(project, "review", "PRIVATE INSTRUCTIONS");
    const listed = captureIo();
    const inspected = captureIo();

    expect(await main(["skills", "list"], listed.io, dependencies(project))).toBe(0);
    expect(await main(["skills", "inspect", "review"], inspected.io, dependencies(project))).toBe(
      0,
    );

    const listOutput = JSON.parse(listed.stdout[0] ?? "null");
    const inspectOutput = JSON.parse(inspected.stdout[0] ?? "null");
    expect(listOutput.skills).toEqual([
      expect.objectContaining({ name: "review", provenance: ".flow/skills/review" }),
    ]);
    expect(JSON.stringify(listOutput)).not.toContain("PRIVATE INSTRUCTIONS");
    expect(inspectOutput).toMatchObject({
      name: "review",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      files: [{ path: "SKILL.md", bytes: expect.any(Number), sha256: expect.any(String) }],
    });
    expect(inspectOutput).not.toHaveProperty("files.0.contentBase64");
    expect(JSON.stringify(inspectOutput)).not.toContain("PRIVATE INSTRUCTIONS");
  });

  it("validates all discovered packages and reports unsafe resources", async () => {
    const project = await temporaryProject();
    await writeSkill(project, "review", "Review safely.");
    const outside = join(project, "outside.txt");
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, join(project, ".flow", "skills", "review", "unsafe.md"));
    const output = captureIo();

    expect(await main(["skills", "validate"], output.io, dependencies(project))).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/unsafe_entry:.*symbolic link/i);
  });

  it("validates workflow selections and passes the frozen snapshot into attached execution", async () => {
    const project = await temporaryProject();
    await writeSkill(project, "review", "Review the repository.");
    const workflowPath = join(project, "skilled.workflow.yaml");
    await writeFile(workflowPath, skilledWorkflowSource(), "utf8");
    const validateOutput = captureIo();
    const runOutput = captureIo();
    const store = new MemoryStore();
    let observed: NodeExecutionContext | undefined;
    const executor: NodeExecutor = {
      async execute(_node, context) {
        observed = context;
        return successfulAgentOutcome(context.capabilitySnapshot);
      },
    };

    expect(await main(["validate", workflowPath], validateOutput.io, dependencies(project))).toBe(
      0,
    );
    expect(validateOutput.stdout.join("\n")).toContain("skills: 1");
    expect(
      await main(
        ["run", workflowPath, "--run-id", "cli-skilled-run"],
        runOutput.io,
        dependencies(project, { executor, createStore: () => store }),
      ),
    ).toBe(0);
    expect(observed?.capabilitySnapshot?.packages.map((skill) => skill.name)).toEqual(["review"]);
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: { packages: [{ name: "review" }] },
    });
  });

  it("fails workflow validation when a selected package is missing", async () => {
    const project = await temporaryProject();
    const workflowPath = join(project, "missing.workflow.yaml");
    await writeFile(workflowPath, skilledWorkflowSource(), "utf8");
    const output = captureIo();

    expect(await main(["validate", workflowPath], output.io, dependencies(project))).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/missing_skill:.*review/i);
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
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-skills-cli-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "skills"), { recursive: true });
  return project;
}

async function writeSkill(project: string, name: string, body: string): Promise<void> {
  const directory = join(project, ".flow", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Review code when explicitly selected.\nlicense: Apache-2.0\nmetadata:\n  version: "1"\nallowed-tools: Bash\n---\n${body}\n`,
    "utf8",
  );
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
      project: {
        path: join(projectRoot, ".flow", "config.yaml"),
        values: {},
      },
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

function skilledWorkflowSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-skilled }
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: test, id: deterministic }
      tools: [read]
      skills: [review]
  - id: publish
    type: result
    dependsOn: [analyze]
    result:
      source: { nodeId: analyze, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}

function successfulAgentOutcome(snapshot?: CapabilitySnapshot): NodeExecutionOutcome {
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
      ...(snapshot === undefined
        ? {}
        : { capabilities: createAgentCapabilityEvidence(snapshot, ["review"]) }),
    },
  };
}
