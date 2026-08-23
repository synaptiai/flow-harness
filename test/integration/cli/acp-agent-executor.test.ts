import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

describe("ACP agent executor CLI", () => {
  it("admits one exact run-scoped ACP agent for validation and attached execution", async () => {
    const project = await temporaryProject();
    const manifest = await writeAcpAgent(project);
    const workflow = join(project, "agent.workflow.yaml");
    await writeFile(workflow, workflowSource(), "utf8");
    const validated = captureIo();
    const executed = captureIo();
    const store = new MemoryStore();
    let observed: NodeExecutionContext | undefined;
    const executor: NodeExecutor = {
      async execute(_node, context) {
        observed = context;
        return successfulAgentOutcome();
      },
    };
    const dependencies = {
      cwd: project,
      loadConfig: async () => effectiveConfig(project),
      createStore: () => store,
      createNodeExecutor: () => executor,
    };

    expect(
      await main(
        ["validate", workflow, "--acp-agent", ".flow/acp-agents/fake.json"],
        validated.io,
        dependencies,
      ),
      validated.stderr.join("\n"),
    ).toBe(0);
    expect(validated.stdout.join("\n")).toContain("ACP agents: 1");

    expect(
      await main(
        ["run", workflow, "--acp-agent", ".flow/acp-agents/fake.json", "--run-id", "cli-acp-agent"],
        executed.io,
        dependencies,
      ),
      executed.stderr.join("\n"),
    ).toBe(0);

    expect(observed?.capabilitySnapshot?.acpAgent).toMatchObject({
      kind: "acp-agent",
      name: "fake-acp",
      manifest: { provenance: ".flow/acp-agents/fake.json" },
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: {
        packages: [],
        acpAgent: {
          kind: "acp-agent",
          name: "fake-acp",
          manifest: { provenance: ".flow/acp-agents/fake.json" },
        },
      },
    });
    expect(executed.stdout.join("\n")).not.toContain(await readFile(manifest, "utf8"));
    expect(executed.stdout.join("\n")).not.toContain("OPENAI_API_KEY");
  });

  it("rejects duplicate, escaping, and tool-bearing ACP selections before execution", async () => {
    const project = await temporaryProject();
    await writeAcpAgent(project);
    const workflow = join(project, "tool-agent.workflow.yaml");
    await writeFile(workflow, workflowSource("tools: [read]"), "utf8");
    const execute = vi.fn(async (): Promise<NodeExecutionOutcome> => successfulAgentOutcome());
    const store = new MemoryStore();
    const dependencies = {
      cwd: project,
      loadConfig: async () => effectiveConfig(project),
      createStore: () => store,
      createNodeExecutor: () => ({ execute }),
    };

    const cases = [
      {
        args: [
          "run",
          workflow,
          "--acp-agent",
          ".flow/acp-agents/fake.json",
          "--acp-agent",
          ".flow/acp-agents/private.json",
        ],
        message: "--acp-agent may be specified only once",
      },
      {
        args: ["run", workflow, "--acp-agent", "../private.json"],
        message: "project-relative manifest under .flow/acp-agents",
      },
      {
        args: ["run", workflow, "--acp-agent", ".flow/acp-agents/fake.json"],
        message: "unsupported_acp_authority",
      },
    ];
    for (const testCase of cases) {
      const capture = captureIo();
      expect(await main(testCase.args, capture.io, dependencies)).not.toBe(0);
      expect(capture.stderr.join("\n")).toContain(testCase.message);
      expect(capture.stderr.join("\n")).not.toContain("private.json");
    }
    expect(execute).not.toHaveBeenCalled();
    expect(store.events).toEqual([]);
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
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-acp-agent-cli-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "acp-agents"), { recursive: true });
  return project;
}

async function writeAcpAgent(project: string): Promise<string> {
  const executable = join(project, ".flow", "acp-agents", "fake-agent");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o700);
  const manifest = join(project, ".flow", "acp-agents", "fake.json");
  await writeFile(
    manifest,
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "AcpAgent",
      metadata: { name: "fake-acp" },
      spec: {
        protocol: "acp-v1",
        compatibilityProfile: "prompt-only-v1",
        launch: {
          kind: "binary",
          executable,
          executableSha256: sha256(await readFile(executable)),
          args: ["--stdio"],
        },
        modelMappings: [
          { provider: "openai", model: "gpt-5.6-codex", agentModel: "gpt-5.6-codex" },
        ],
        providerAuthorities: [
          { provider: "openai", domain: "api.openai.com", credentialEnv: "OPENAI_API_KEY" },
        ],
        containmentProfile: "acp-prompt-only-v1",
        usage: { modelTokens: "complete", costUsd: "unavailable" },
        configuration: {
          assignments: [
            { configId: "model", source: "model" },
            {
              configId: "thinking",
              source: "thinking",
              mappings: [{ thinking: "medium", value: "medium" }],
            },
          ],
        },
      },
    }),
    "utf8",
  );
  return manifest;
}

function workflowSource(extra = ""): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-acp-agent }
nodes:
  - id: model
    type: agent
    agent:
      prompt: Return one bounded answer.
      model: { provider: openai, id: gpt-5.6-codex, thinking: medium }
      ${extra}
  - id: publish
    type: result
    dependsOn: [model]
    result:
      source: { nodeId: model, field: agent.text }
      schema: { type: string, maxLength: 64 }
`;
}

function successfulAgentOutcome(): NodeExecutionOutcome {
  const text = JSON.stringify("done");
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "openai",
      model: "gpt-5.6-codex",
      text,
      textHash: sha256(text),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [],
      effectReceipts: [],
    },
  };
}

function effectiveConfig(projectRoot: string): EffectiveFlowConfig {
  const supervisor = { ...BUILT_IN_FLOW_CONFIG };
  return {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
    sandbox: { profile: "native" },
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
