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
import { admitLocalLanguageServer } from "../../../src/infrastructure/fs/local-language-server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("semantic code CLI", () => {
  it("admits one exact language server for validation and a durable attached run", async () => {
    const project = await temporaryProject();
    const manifestPath = await writeLanguageServer(project);
    const workflowPath = join(project, "semantic.workflow.yaml");
    await writeFile(workflowPath, semanticWorkflowSource(), "utf8");
    const validated = captureIo();
    const executed = captureIo();
    const resumed = captureIo();
    const store = new MemoryStore();
    let observed: NodeExecutionContext | undefined;
    let executions = 0;
    const executor: NodeExecutor = {
      async execute(_node, context) {
        executions += 1;
        observed = context;
        return successfulAgentOutcome();
      },
    };
    const cliDependencies = dependencies(project, {
      executor,
      createStore: () => store,
    });

    expect(
      await main(
        ["validate", workflowPath, "--language-server", manifestPath],
        validated.io,
        cliDependencies,
      ),
      validated.stderr.join("\n"),
    ).toBe(0);
    expect(validated.stdout.join("\n")).toContain("language servers: 1");

    expect(
      await main(
        ["run", workflowPath, "--language-server", manifestPath, "--run-id", "cli-semantic-run"],
        executed.io,
        cliDependencies,
      ),
      executed.stderr.join("\n"),
    ).toBe(0);

    expect(observed?.capabilitySnapshot?.languageServer).toMatchObject({
      kind: "language-server",
      name: "fake-typescript",
      protocol: "lsp-3.18",
      manifest: { provenance: ".flow/language-servers/fake-typescript.json" },
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: {
        packages: [],
        languageServer: {
          kind: "language-server",
          name: "fake-typescript",
          manifest: { provenance: ".flow/language-servers/fake-typescript.json" },
        },
      },
    });
    const publicOutput = executed.stdout.join("\n");
    expect(publicOutput).not.toContain("contentBase64");
    expect(publicOutput).not.toContain(join(project, ".flow", "language-servers"));

    expect(
      await main(
        ["resume", workflowPath, "--run-id", "cli-semantic-run"],
        resumed.io,
        cliDependencies,
      ),
      resumed.stderr.join("\n"),
    ).toBe(1);
    expect(executions).toBe(1);
    expect(resumed.stderr.join("\n")).toContain("already terminal");
    expect(resumed.stderr.join("\n")).not.toContain("contentBase64");
    expect(resumed.stderr.join("\n")).not.toContain(join(project, ".flow", "language-servers"));
  });

  it("rejects missing, unexpected, and duplicate server authority before mutation", async () => {
    const project = await temporaryProject();
    const manifestPath = await writeLanguageServer(project);
    const semanticWorkflow = join(project, "semantic.workflow.yaml");
    const ordinaryWorkflow = join(project, "ordinary.workflow.yaml");
    await writeFile(semanticWorkflow, semanticWorkflowSource(), "utf8");
    await writeFile(ordinaryWorkflow, ordinaryWorkflowSource(), "utf8");
    const execute = vi.fn(async (): Promise<NodeExecutionOutcome> => successfulAgentOutcome());
    const store = new MemoryStore();
    const cliDependencies = dependencies(project, {
      executor: { execute },
      createStore: () => store,
    });
    const missing = captureIo();
    const unexpected = captureIo();
    const duplicate = captureIo();

    expect(await main(["validate", semanticWorkflow], missing.io, cliDependencies)).toBe(1);
    expect(missing.stderr.join("\n")).toContain("missing_snapshot");
    await expect(admitLocalLanguageServer(project, manifestPath)).resolves.toMatchObject({
      name: "fake-typescript",
    });
    expect(
      await main(
        ["run", ordinaryWorkflow, "--language-server", manifestPath],
        unexpected.io,
        cliDependencies,
      ),
    ).toBe(1);
    expect(unexpected.stderr.join("\n")).toContain("unexpected_language_server");
    expect(
      await main(
        [
          "run",
          semanticWorkflow,
          "--language-server",
          manifestPath,
          "--language-server",
          "PRIVATE_SERVER_MANIFEST",
        ],
        duplicate.io,
        cliDependencies,
      ),
    ).toBe(2);
    expect(duplicate.stderr.join("\n")).toContain("--language-server may be specified only once");
    expect(duplicate.stderr.join("\n")).not.toContain("PRIVATE_SERVER_MANIFEST");
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
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-semantic-cli-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "language-servers"), { recursive: true });
  return project;
}

async function writeLanguageServer(project: string): Promise<string> {
  const executable = join(project, ".flow", "language-servers", "fake-lsp-server");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o700);
  const executableBytes = await readFile(executable);
  const manifestPath = join(project, ".flow", "language-servers", "fake-typescript.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "LanguageServer",
      metadata: { name: "fake-typescript" },
      spec: {
        protocol: "lsp-3.18",
        executable,
        executableSha256: sha256(executableBytes),
        args: [],
        languages: [{ id: "typescript", suffixes: [".ts"] }],
        containmentProfile: "default",
        requestTimeoutMs: 5_000,
      },
    }),
    "utf8",
  );
  return manifestPath;
}

function semanticWorkflowSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-semantic }
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze the selected source.
      model: { provider: test, id: deterministic }
      tools: [semantic]
  - id: publish
    type: result
    dependsOn: [analyze]
    result:
      source: { nodeId: analyze, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}

function ordinaryWorkflowSource(): string {
  return semanticWorkflowSource().replace("tools: [semantic]", "tools: [read]");
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
      textHash: sha256(text),
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
