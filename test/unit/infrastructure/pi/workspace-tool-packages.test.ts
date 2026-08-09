import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentCommandExecutor,
  NodeAgentCommandJournal,
  NodeExecutionContext,
} from "../../../../src/application/ports.js";
import type { AgentCommandRequest } from "../../../../src/domain/agent-command.js";
import {
  createToolPackageSnapshot,
  parseToolPackageManifest,
  type ToolPackageSnapshot,
} from "../../../../src/domain/capability/tool-packages.js";
import { PolicyBroker } from "../../../../src/domain/policy/broker.js";
import type { AgentCommandSettlementOutcome } from "../../../../src/domain/run/events.js";
import { AgentCommandRecorder } from "../../../../src/infrastructure/pi/agent-command-recorder.js";
import { createWorkspaceAgentTools } from "../../../../src/infrastructure/pi/workspace-agent-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("workspace packaged command tools", () => {
  it("renders and executes a selected package through the existing governed recorder", async () => {
    const root = await temporaryDirectory();
    const snapshot = packageSnapshot();
    const policy = policyBroker();
    const events: string[] = [];
    let preparedRequest: AgentCommandRequest | undefined;
    let executedRequest: AgentCommandRequest | undefined;
    const journal: NodeAgentCommandJournal = {
      prepare: async (prepared) => {
        events.push("prepare");
        preparedRequest = prepared.request;
        return {
          commandId: "command-1",
          commandSequence: 1,
          settle: async () => {
            events.push("settle");
            return { artifactBudgetExhausted: false };
          },
        };
      },
    };
    const executor: AgentCommandExecutor = {
      executeAgentCommand: async (request) => {
        events.push("execute");
        executedRequest = request;
        return failedOutcome(request);
      },
    };
    const recorder = new AgentCommandRecorder(executor, journal, executionContext(root));

    const tools = await createWorkspaceAgentTools(root, [], policy, {
      commandRecorder: recorder,
      toolPackages: [snapshot],
    });
    const tool = tools.definitions[0];
    if (tool === undefined) {
      throw new Error("selected package tool was not registered");
    }
    const result = await tool.execute(
      "package-call",
      { path: "src; echo literal", limit: 12, verbose: false },
      undefined,
      undefined,
      {} as never,
    );

    expect(tools.names).toEqual(["project_report"]);
    expect(tool.description).toBe("Produce a project report.");
    expect(events).toEqual(["prepare", "execute", "settle"]);
    expect(executedRequest).toEqual({
      version: 1,
      executable: "/usr/bin/printf",
      args: ["%s\n%s\n%s\n", "src; echo literal", "12", "false"],
      timeoutMs: 10_000,
      source: {
        kind: "tool-package",
        name: "project-report",
        version: "1.2.3",
        digest: snapshot.digest,
        toolName: "project_report",
        input: { limit: 12, path: "src; echo literal", verbose: false },
        inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(preparedRequest).toEqual(executedRequest);
    expect(policy.snapshot()).toEqual([
      expect.objectContaining({
        action: "process.execute",
        target: "/usr/bin/printf",
        operationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        outcome: "allowed",
      }),
    ]);
    expect(result.content).toContainEqual({
      type: "text",
      text: expect.stringMatching(/status: failed[\s\S]*literal output/i),
    });
  });

  it("requires the shared command recorder before registering a package tool", async () => {
    const root = await temporaryDirectory();

    await expect(
      createWorkspaceAgentTools(root, [], policyBroker(), { toolPackages: [packageSnapshot()] }),
    ).rejects.toThrow(/command recorder/i);
  });

  it("fails malformed input before policy, journal, or execution", async () => {
    const root = await temporaryDirectory();
    const policy = policyBroker();
    let journalCalls = 0;
    let executorCalls = 0;
    const recorder = new AgentCommandRecorder(
      {
        executeAgentCommand: async (request) => {
          executorCalls += 1;
          return failedOutcome(request);
        },
      },
      {
        prepare: async () => {
          journalCalls += 1;
          throw new Error("must not prepare");
        },
      },
      executionContext(root),
    );
    const tools = await createWorkspaceAgentTools(root, [], policy, {
      commandRecorder: recorder,
      toolPackages: [packageSnapshot()],
    });
    const tool = tools.definitions[0];
    if (tool === undefined) {
      throw new Error("selected package tool was not registered");
    }

    await expect(
      tool.execute(
        "bad-call",
        { path: "src", limit: 1, verbose: "false" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/boolean/i);
    expect(policy.snapshot()).toEqual([]);
    expect(journalCalls).toBe(0);
    expect(executorCalls).toBe(0);
  });

  it("registers no package definitions when none are selected", async () => {
    const root = await temporaryDirectory();
    const tools = await createWorkspaceAgentTools(root, [], policyBroker(), {});

    expect(tools).toEqual({ names: [], definitions: [] });
  });
});

function packageSnapshot(): ToolPackageSnapshot {
  const source = `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: project-report
  version: 1.2.3
  description: Produce a bounded project report.
spec:
  tool:
    name: project_report
    description: Produce a project report.
    inputs:
      - { name: path, description: Relative path., type: string }
      - { name: limit, description: Maximum entries., type: integer }
      - { name: verbose, description: Include details., type: boolean }
  driver:
    kind: command
    version: v1
    profile: posix-printf-v1
    executable: /usr/bin/printf
    args: ["%s\\n%s\\n%s\\n", "{input:path}", "{input:limit}", "{input:verbose}"]
    timeoutMs: 10000
  permissions: [process.execute]
`;
  const parsed = parseToolPackageManifest(Buffer.from(source));
  return createToolPackageSnapshot({
    kind: "tool-package",
    apiVersion: parsed.apiVersion,
    name: parsed.metadata.name,
    version: parsed.metadata.version,
    description: parsed.metadata.description,
    trust: "project-explicit",
    provenance: ".flow/tools/project-report",
    definition: parsed.spec,
    manifest: { content: Buffer.from(source) },
  });
}

function failedOutcome(request: AgentCommandRequest): AgentCommandSettlementOutcome {
  return {
    status: "failed",
    error: {
      code: "command_failed",
      message: "command exited with code 1",
      retryable: false,
      sideEffectStatus: "uncertain",
    },
    evidence: {
      kind: "command",
      executable: request.executable,
      args: request.args,
      exitCode: 1,
      signal: null,
      stdout: "literal output",
      stderr: "failed",
      stdoutHash: sha256("literal output"),
      stderrHash: sha256("failed"),
      stdoutRetainedHash: sha256("literal output"),
      stderrRetainedHash: sha256("failed"),
      stdoutRetainedBytes: 14,
      stderrRetainedBytes: 6,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
      durationMs: 5,
      processContainment: "linux-pid-namespace",
      terminationStatus: "not-required",
      sandbox: {
        backend: "test-sandbox",
        backendVersion: "1",
        profile: "workspace-write-network-deny-v1",
        policyDigest: "a".repeat(64),
      },
    },
  };
}

function policyBroker(): PolicyBroker {
  return new PolicyBroker(
    { runId: "run-1", workflowId: "workflow-1", nodeId: "agent", attempt: 1 },
    ["process.execute"],
  );
}

function executionContext(cwd: string): NodeExecutionContext {
  return {
    runId: "run-1",
    workflowId: "workflow-1",
    attempt: 1,
    cwd,
    protectedPaths: [],
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-workspace-tool-package-")));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
