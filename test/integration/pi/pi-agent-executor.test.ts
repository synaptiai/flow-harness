import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { NodeExecutorRouter } from "../../../src/application/node-executor-router.js";
import type {
  AgentCommandApprovalDecisionSource,
  AgentCommandApprovalWait,
  CommandExecutor,
  NodeEffectJournal,
  RunEventStore,
} from "../../../src/application/ports.js";
import { runWorkflow } from "../../../src/application/run-workflow.js";
import type { AgentCommandRequest } from "../../../src/domain/agent-command.js";
import type { AgentCommandSettlementOutcome, RunEvent } from "../../../src/domain/run/events.js";
import { reduceRunEvents } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import type { CompiledAgentNode } from "../../../src/domain/workflow/types.js";
import {
  discoverProjectToolPackages,
  snapshotSelectedToolPackages,
} from "../../../src/infrastructure/fs/local-tool-package-catalog.js";
import {
  EmbeddedPiAgentRunner,
  PiAgentExecutor,
} from "../../../src/infrastructure/pi/pi-agent-executor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("embedded Pi SDK integration", () => {
  it("executes through the real ModelRuntime and createAgentSession with an in-process provider", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "flow-pi-sdk-"));
    temporaryDirectories.push(cwd);
    const target = join(cwd, "source.ts");
    const before = "const value = 1;\n";
    const afterEdit = "const value = 2;\n";
    const afterReplace = "export const value = 3;\n";
    await writeFile(target, before, "utf8");
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    runtime.registerProvider("flow-test", {
      name: "Flow deterministic test provider",
      api: "openai-completions",
      baseUrl: "https://flow.test.invalid/v1",
      apiKey: "test-only-key",
      models: [
        {
          id: "deterministic",
          name: "Deterministic",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4_096,
          maxTokens: 256,
        },
      ],
      streamSimple: (model, context) => {
        const stream = createAssistantMessageEventStream();
        const invocation = context.messages.filter(
          (message) => message.role === "assistant",
        ).length;
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "pending",
          timestamp: Date.now(),
        };

        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          if (invocation < 4) {
            const version =
              invocation === 0 || invocation === 2
                ? undefined
                : extractReadVersionFromContext(context.messages);
            const name = ["flow_read", "flow_edit", "flow_read", "flow_replace"][invocation];
            const toolCall = {
              type: "toolCall" as const,
              id: `flow-sdk-call-${invocation + 1}`,
              name: name ?? "flow_read",
              arguments:
                invocation === 0 || invocation === 2
                  ? { path: "source.ts" }
                  : invocation === 1
                    ? {
                        path: "source.ts",
                        expectedSha256: version,
                        edits: [{ oldText: "value = 1", newText: "value = 2" }],
                      }
                    : {
                        path: "source.ts",
                        expectedSha256: version,
                        content: afterReplace,
                      },
            };
            message.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({
              type: "toolcall_end",
              contentIndex: 0,
              toolCall,
              partial: message,
            });
            message.stopReason = "toolUse";
            stream.push({ type: "done", reason: "toolUse", message });
          } else {
            const block = { type: "text" as const, text: "FLOW_SDK_EDIT_REPLACE_OK" };
            message.content.push(block);
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: block.text,
              partial: message,
            });
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: block.text,
              partial: message,
            });
            message.stopReason = "stop";
            stream.push({ type: "done", reason: "stop", message });
          }
          stream.end();
        });
        return stream;
      },
    });
    const executor = new PiAgentExecutor(new EmbeddedPiAgentRunner(async () => runtime));

    const outcome = await executor.execute(agentNode(["read", "edit", "replace"]), {
      runId: "sdk-run",
      workflowId: "sdk-workflow",
      attempt: 1,
      cwd,
      protectedPaths: [],
      effectJournal: testEffectJournal(),
    });

    expect(outcome.status, JSON.stringify(outcome)).toBe("succeeded");
    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "agent",
        provider: "flow-test",
        model: "deterministic",
        text: "FLOW_SDK_EDIT_REPLACE_OK",
        textHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        textTruncated: false,
        policyDecisions: [
          expect.objectContaining({ action: "filesystem.read", outcome: "allowed" }),
          expect.objectContaining({ action: "filesystem.write", outcome: "allowed" }),
          expect.objectContaining({ action: "filesystem.read", outcome: "allowed" }),
          expect.objectContaining({ action: "filesystem.write", outcome: "allowed" }),
        ],
        effectReceipts: [
          expect.objectContaining({
            kind: "filesystem.edit",
            beforeSha256: sha256(before),
            afterSha256: sha256(afterEdit),
            outcome: "committed",
          }),
          expect.objectContaining({
            kind: "filesystem.edit",
            beforeSha256: sha256(afterEdit),
            afterSha256: sha256(afterReplace),
            outcome: "committed",
          }),
        ],
      },
    });
    expect(await readFile(target, "utf8")).toBe(afterReplace);
  });

  it("applies the requested output-token limit to the selected Pi model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "flow-pi-token-limit-"));
    temporaryDirectories.push(cwd);
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    let observedMaxTokens: number | undefined;
    runtime.registerProvider("flow-test", {
      name: "Flow token limit test provider",
      api: "openai-completions",
      baseUrl: "https://flow.test.invalid/v1",
      apiKey: "test-only-key",
      models: [
        {
          id: "deterministic",
          name: "Deterministic",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4_096,
          maxTokens: 256,
        },
      ],
      streamSimple: (model) => {
        observedMaxTokens = model.maxTokens;
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "pending",
          timestamp: Date.now(),
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          const block = { type: "text" as const, text: "LIMIT_OK" };
          message.content.push(block);
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: block.text,
            partial: message,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: block.text,
            partial: message,
          });
          message.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        });
        return stream;
      },
    });
    const executor = new PiAgentExecutor(new EmbeddedPiAgentRunner(async () => runtime));

    const outcome = await executor.execute(agentNode(), {
      runId: "sdk-token-limit",
      workflowId: "sdk-token-limit",
      attempt: 1,
      cwd,
      protectedPaths: [],
      effectJournal: testEffectJournal(),
      agentMaxOutputTokens: 17,
    });

    expect(outcome.status, JSON.stringify(outcome)).toBe("succeeded");
    expect(observedMaxTokens).toBe(17);
  });

  it("discovers, approves, executes, and replays a package-only tool through real Pi", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "flow-pi-package-sdk-"));
    temporaryDirectories.push(cwd);
    const packageDirectory = join(cwd, ".flow", "tools", "project-report");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "TOOL.yaml"), toolPackageManifest(), "utf8");
    const catalog = await discoverProjectToolPackages(cwd);
    const snapshot = await snapshotSelectedToolPackages(catalog, [
      { name: "project-report", version: "1.2.3" },
    ]);
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    runtime.registerProvider("flow-package-test", {
      name: "Flow package deterministic test provider",
      api: "openai-completions",
      baseUrl: "https://flow.test.invalid/v1",
      apiKey: "test-only-key",
      models: [
        {
          id: "deterministic",
          name: "Deterministic",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4_096,
          maxTokens: 256,
        },
      ],
      streamSimple: (model, context) => {
        const stream = createAssistantMessageEventStream();
        const invocation = context.messages.filter(
          (message) => message.role === "assistant",
        ).length;
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "pending",
          timestamp: Date.now(),
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          if (invocation === 0) {
            const toolCall = {
              type: "toolCall" as const,
              id: "flow-package-call-1",
              name: "create_project_report",
              arguments: { subject: "literal; not shell" },
            };
            message.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({
              type: "toolcall_end",
              contentIndex: 0,
              toolCall,
              partial: message,
            });
            message.stopReason = "toolUse";
            stream.push({ type: "done", reason: "toolUse", message });
          } else {
            const block = { type: "text" as const, text: JSON.stringify("FLOW_PACKAGE_OK") };
            message.content.push(block);
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: block.text,
              partial: message,
            });
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: block.text,
              partial: message,
            });
            message.stopReason = "stop";
            stream.push({ type: "done", reason: "stop", message });
          }
          stream.end();
        });
        return stream;
      },
    });
    const store = new MemoryRunStore();
    const commandExecutor = new CapturingAgentCommandExecutor();
    const state = await runWorkflow(packageWorkflow(), {
      runId: "pi-package-integration",
      cwd,
      protectedPaths: [],
      store,
      executor: new NodeExecutorRouter(
        commandExecutor,
        new PiAgentExecutor(new EmbeddedPiAgentRunner(async () => runtime)),
      ),
      capabilitySnapshot: snapshot,
      agentCommandApprovalDecisions: new ApprovingDecisionSource(),
      now: monotonicNow(),
    });

    expect(state.status, JSON.stringify(state)).toBe("succeeded");
    expect(commandExecutor.requests).toEqual([
      expect.objectContaining({
        executable: "/usr/bin/printf",
        args: ["%s", "literal; not shell"],
        source: expect.objectContaining({
          kind: "tool-package",
          name: "project-report",
          version: "1.2.3",
          toolName: "create_project_report",
        }),
      }),
    ]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "agent_command_approval_requested",
      "agent_command_approval_granted",
      "node_agent_command_prepared",
      "node_agent_command_settled",
      "node_succeeded",
      "node_result_published",
      "run_succeeded",
    ]);
    expect(reduceRunEvents(structuredClone(store.events))).toMatchObject({
      status: "succeeded",
      toolPackageRequirements: {
        agent: {
          rawExec: false,
          packages: [{ name: "project-report", version: "1.2.3" }],
        },
      },
    });
  });
});

function agentNode(tools: CompiledAgentNode["agent"]["tools"] = []): CompiledAgentNode {
  return {
    id: "sdk-agent",
    type: "agent",
    dependsOn: [],
    agent: {
      prompt: "Read source.ts, change value 1 to 2, then report the deterministic marker.",
      model: { provider: "flow-test", id: "deterministic", thinking: "off" },
      tools,
      skills: [],
      toolPackages: [],
      timeoutMs: 5_000,
    },
  };
}

function testEffectJournal(): NodeEffectJournal {
  let effectSequence = 0;
  return {
    prepare: async (descriptor) => {
      effectSequence += 1;
      const sequence = effectSequence;
      return {
        effectId: `effect-${sequence + 2}`,
        effectSequence: sequence,
        settle: async (settlement) =>
          settlement.outcome === "not_applied"
            ? null
            : {
                version: 1,
                sequence,
                runId: "sdk-run",
                workflowId: "sdk-workflow",
                nodeId: "sdk-agent",
                attempt: 1,
                kind: descriptor.kind,
                target: descriptor.target,
                operationDigest: descriptor.operationDigest,
                beforeSha256: descriptor.beforeSha256,
                afterSha256: descriptor.afterSha256,
                outcome: settlement.outcome === "committed" ? "committed" : "uncertain",
              },
      };
    },
  };
}

function extractReadVersionFromContext(
  messages: readonly { readonly role: string; readonly content?: unknown }[],
): string {
  const readResult = [...messages]
    .reverse()
    .find(
      (message): message is { readonly role: "toolResult"; readonly content: unknown } =>
        message.role === "toolResult",
    );
  const match = JSON.stringify(readResult?.content).match(/sha256:([a-f0-9]{64})/);
  if (match?.[1] === undefined) {
    throw new Error("real Pi session did not return the Flow read version marker");
  }
  return match[1];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function packageWorkflow() {
  return compileWorkflowText(`apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: pi-package-integration }
nodes:
  - id: agent
    type: agent
    agent:
      prompt: Call the selected report tool once, then return the marker.
      model: { provider: flow-package-test, id: deterministic }
      toolPackages: [{ name: project-report, version: 1.2.3 }]
      toolApproval:
        exec: { mode: required, grantTtlMs: 300000 }
  - id: publish
    type: result
    dependsOn: [agent]
    result:
      source: { nodeId: agent, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`);
}

function toolPackageManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: project-report
  version: 1.2.3
  description: Print a bounded report subject.
spec:
  tool:
    name: create_project_report
    description: Print a selected report subject.
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

class MemoryRunStore implements RunEventStore {
  readonly events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }
}

class CapturingAgentCommandExecutor implements CommandExecutor {
  readonly requests: AgentCommandRequest[] = [];

  async execute(): Promise<never> {
    throw new Error("package integration workflow has no command node");
  }

  async executeAgentCommand(request: AgentCommandRequest): Promise<AgentCommandSettlementOutcome> {
    this.requests.push(structuredClone(request));
    const stdout = request.args.at(-1) ?? "";
    return {
      status: "succeeded",
      evidence: {
        kind: "command",
        executable: request.executable,
        args: request.args,
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        stdoutHash: sha256(stdout),
        stderrHash: sha256(""),
        stdoutRetainedHash: sha256(stdout),
        stderrRetainedHash: sha256(""),
        stdoutRetainedBytes: Buffer.byteLength(stdout),
        stderrRetainedBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        aborted: false,
        durationMs: 1,
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
}

class ApprovingDecisionSource implements AgentCommandApprovalDecisionSource {
  async waitForDecision(wait: AgentCommandApprovalWait) {
    return {
      version: 1 as const,
      runId: wait.request.runId,
      requestId: wait.requestId,
      requestDigest: wait.requestDigest,
      operationDigest: wait.request.operationDigest,
      decision: "approve" as const,
      actor: "operator:integration",
      submittedAt: "2026-08-08T10:00:03.500Z",
    };
  }
}

function monotonicNow(): () => Date {
  let milliseconds = Date.parse("2026-08-08T10:00:00.000Z");
  return () => {
    milliseconds += 1_000;
    return new Date(milliseconds);
  };
}
