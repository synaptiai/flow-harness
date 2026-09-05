import { createHash } from "node:crypto";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type {
  AgentCommandExecutor,
  ModelSessionJournal,
  NodeAgentCommandJournal,
  NodeEffectJournal,
  NodeExecutionContext,
} from "../../../../src/application/ports.js";
import { AgentCommandApprovalDeniedError } from "../../../../src/application/run-workflow.js";
import {
  createPhaseRoutingDecision,
  createPhaseRoutingProfile,
} from "../../../../src/domain/adaptation/phase-routing-candidate.js";
import { createPromptActivationSnapshot } from "../../../../src/domain/adaptation/prompt-activation.js";
import {
  calculateAgentCommandDigest,
  normalizeAgentCommandRequest,
} from "../../../../src/domain/agent-command.js";
import {
  calculateCapabilitySnapshotDigest,
  createCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../../../../src/domain/capability/agent-skills.js";
import { PolicyAuditLimitError, PolicyBroker } from "../../../../src/domain/policy/broker.js";
import type { AgentCommandSettlementOutcome } from "../../../../src/domain/run/events.js";
import { MAX_MODEL_WORK_PROFILE_PROMPT_BYTES } from "../../../../src/domain/run/work-profile.js";
import type { CompiledAgentNode } from "../../../../src/domain/workflow/types.js";
import { AgentCommandRecorder } from "../../../../src/infrastructure/pi/agent-command-recorder.js";
import { AgentEffectRecorder } from "../../../../src/infrastructure/pi/agent-effect-recorder.js";
import {
  EmbeddedPiAgentRunner,
  PiAgentExecutor,
  type PiAgentRunner,
  type PiAgentRunRequest,
} from "../../../../src/infrastructure/pi/pi-agent-executor.js";
import { promptActivationInput } from "../../../fixtures/prompt-activation.js";

const context: NodeExecutionContext = {
  runId: "run-agent",
  workflowId: "agent-workflow",
  attempt: 1,
  cwd: process.cwd(),
  protectedPaths: [],
};

describe("PiAgentExecutor", () => {
  it("fails an attempt when policy audit exhaustion is followed by a normal model stop", async () => {
    let observedAbort = false;
    let observedSystemPrompt: string | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        observedSystemPrompt = input.systemPrompt;
        for (let index = 0; index < 2; index += 1) {
          input.policyBroker.authorize({
            action: "filesystem.read",
            target: `${input.cwd}/file-${index}.txt`,
            boundary: "inside",
          });
        }
        expect(() =>
          input.policyBroker.authorize({
            action: "filesystem.read",
            target: `${input.cwd}/overflow.txt`,
            boundary: "inside",
          }),
        ).toThrowError(PolicyAuditLimitError);
        observedAbort = input.signal?.aborted === true;
        return { text: "Unable to continue after the tool limit.", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(
      agentNode(300_000, ["read", "ls"], 2),
      context,
    );

    expect(observedAbort).toBe(true);
    expect(observedSystemPrompt).toContain("2 recorded policy decisions");
    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_policy_audit_exhausted",
        message: "agent reached policy audit limit of 2 decisions",
        sideEffectStatus: "none",
      },
      evidence: {
        text: "",
        policyDecisions: expect.arrayContaining([expect.objectContaining({ sequence: 2 })]),
      },
    });
  });

  it("overrides a terminal model result after durable command output exhausts the artifact budget", async () => {
    const runner: PiAgentRunner = {
      async run(input) {
        const request = normalizeAgentCommandRequest({ executable: "npm", args: ["test"] });
        const operationDigest = calculateAgentCommandDigest(request);
        const decision = input.policyBroker.authorize({
          action: "process.execute",
          target: request.executable,
          boundary: "inside",
          operationDigest,
        });
        await input.commandRecorder?.execute(request, decision);
        return { text: "continued after exhausted output", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(
      agentNode(300_000, ["exec"]),
      contextWithAgentCommand(true),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_artifact_budget_exhausted",
        sideEffectStatus: "committed",
      },
      evidence: {
        policyDecisions: [{ action: "process.execute", outcome: "allowed" }],
      },
    });
  });

  it("aborts the agent attempt after durable unconfirmed command termination", async () => {
    let observedAbort = false;
    const runner: PiAgentRunner = {
      async run(input) {
        const request = normalizeAgentCommandRequest({ executable: "npm", args: ["test"] });
        const operationDigest = calculateAgentCommandDigest(request);
        const decision = input.policyBroker.authorize({
          action: "process.execute",
          target: request.executable,
          boundary: "inside",
          operationDigest,
        });
        await input.commandRecorder?.execute(request, decision);
        observedAbort = input.signal?.aborted === true;
        return { text: "must not become success", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(
      agentNode(300_000, ["exec"]),
      contextWithAgentCommand(false, "unconfirmed"),
    );

    expect(observedAbort).toBe(true);
    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_command_termination_unconfirmed",
        sideEffectStatus: "uncertain",
      },
      evidence: {
        policyDecisions: [{ action: "process.execute", outcome: "allowed" }],
      },
    });
  });

  it("rejects command execution without the shared executor and durable journal before starting Pi", async () => {
    let runnerCalls = 0;
    const runner: PiAgentRunner = {
      async run() {
        runnerCalls += 1;
        return { text: "should not run", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(
      agentNode(300_000, ["exec"]),
      context,
    );

    expect(runnerCalls).toBe(0);
    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "pi_command_journal_unavailable",
        message:
          "agent command execution requires the shared sandbox executor and a durable command journal",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
  });

  it.each(["edit", "replace", "create", "mkdir"] as const)(
    "rejects a %s attempt without a durable effect journal before starting Pi",
    async (tool) => {
      let runnerCalls = 0;
      const runner: PiAgentRunner = {
        async run() {
          runnerCalls += 1;
          return { text: "should not run", stopReason: "stop" };
        },
      };

      const outcome = await new PiAgentExecutor(runner).execute(
        agentNode(300_000, [tool]),
        context,
      );

      expect(runnerCalls).toBe(0);
      expect(outcome).toEqual({
        status: "failed",
        error: {
          code: "pi_effect_journal_unavailable",
          message: "writable agent execution requires a durable effect journal",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: null,
      });
    },
  );

  it("passes the exact model and tool allowlist to the embedded runner", async () => {
    let request: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        request = input;
        input.policyBroker.authorize({
          action: "filesystem.read",
          target: `${input.cwd}/package.json`,
          boundary: "inside",
        });
        return {
          text: "Analyzed the repository.",
          stopReason: "stop",
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 20,
            cacheWriteTokens: 2,
            costUsdMicros: 17,
          },
        };
      },
    };
    const executor = new PiAgentExecutor(runner, () => 100);

    const outcome = await executor.execute(agentNode(), context);

    expect(request).toMatchObject({
      cwd: process.cwd(),
      prompt: "Analyze the repository.",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinking: "medium",
      tools: ["read", "ls"],
      protectedPaths: [],
    });
    expect(request?.policyBroker.attribution).toEqual({
      runId: "run-agent",
      workflowId: "agent-workflow",
      nodeId: "analyze",
      attempt: 1,
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.effectRecorder.attribution).toEqual({
      runId: "run-agent",
      workflowId: "agent-workflow",
      nodeId: "analyze",
      attempt: 1,
    });
    expect(outcome).toEqual({
      status: "succeeded",
      evidence: {
        kind: "agent",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        text: "Analyzed the repository.",
        textHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        textTruncated: false,
        durationMs: 0,
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 20,
          cacheWriteTokens: 2,
          costUsdMicros: 17,
        },
        policyDecisions: [
          expect.objectContaining({
            sequence: 1,
            runId: "run-agent",
            workflowId: "agent-workflow",
            nodeId: "analyze",
            attempt: 1,
            action: "filesystem.read",
            outcome: "allowed",
          }),
        ],
        effectReceipts: [],
      },
    });
  });

  it("passes and authority-binds the optional workspace write prefixes", async () => {
    const requests: PiAgentRunRequest[] = [];
    const runner: PiAgentRunner = {
      async run(input) {
        requests.push(input);
        return { text: "Authority observed.", stopReason: "stop" };
      },
    };
    const executor = new PiAgentExecutor(runner, () => 100);

    await executor.execute(agentNode(), { ...context, allowedWritePrefixes: ["src"] });
    await executor.execute(agentNode(), { ...context, allowedWritePrefixes: ["test"] });

    expect(requests[0]?.allowedWritePrefixes).toEqual(["src"]);
    expect(requests[1]?.allowedWritePrefixes).toEqual(["test"]);
    expect(requests[0]?.authorityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(requests[0]?.authorityDigest).not.toBe(requests[1]?.authorityDigest);
  });

  it.each([
    ["stop" as const, "succeeded" as const],
    ["error" as const, "failed" as const],
  ])(
    "preserves a settled delegation receipt for a %s provider result",
    async (stopReason, status) => {
      const receipt = {
        version: 1 as const,
        sequence: 1 as const,
        candidateDigest: "a".repeat(64),
        snapshotDigest: "b".repeat(64),
        childRunId: "child-delegation",
        terminalSequence: 7,
        outcome: "succeeded" as const,
        resultValueHash: "c".repeat(64),
      };
      const delegationSession = {
        async delegate() {
          throw new Error("runner fixture does not invoke tools");
        },
        receipts: () => [receipt],
      };
      let request: PiAgentRunRequest | undefined;
      const runner: PiAgentRunner = {
        async run(input) {
          request = input;
          return { text: "Delegation observed.", stopReason };
        },
      };

      const outcome = await new PiAgentExecutor(runner, () => 100).execute(agentNode(), {
        ...context,
        delegationSession,
      });

      expect(request?.delegationSession).toBe(delegationSession);
      expect(outcome).toMatchObject({
        status,
        evidence: { kind: "agent", delegationReceipts: [receipt] },
      });
    },
  );

  it("translates the provider-neutral compaction policy into one Pi request", async () => {
    let request: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        request = input;
        return { text: "Compaction configured.", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(agentNode(), {
      ...context,
      contextCompaction: {
        mode: "references-and-summary",
        protectedConstraints: ["Never change release policy."],
        minimumReductionBytes: 1_024,
        outputTokenLimits: [512, 256],
      },
    });

    expect(outcome.status).toBe("succeeded");
    expect(request).toMatchObject({
      contextCompactionMode: "references-and-summary",
      contextSummary: {
        protectedConstraints: ["Never change release policy."],
        minimumReductionBytes: 1_024,
        outputTokenLimits: [512, 256],
      },
    });
  });

  it("passes rolling-context settings to the runner", async () => {
    let request: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        request = input;
        return { text: "Rolling context configured.", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(agentNode(), {
      ...context,
      contextCompaction: {
        mode: "rolling",
        pressureThresholdPercent: 85,
        protectedConstraints: ["Keep the acceptance criteria exact."],
      },
    });

    expect(outcome.status).toBe("succeeded");
    expect(request).toMatchObject({
      contextCompactionMode: "rolling",
      rollingContext: {
        pressureThresholdPercent: 85,
        protectedConstraints: ["Keep the acceptance criteria exact."],
      },
    });
  });

  it("preserves a stable rolling-context failure code from the runner", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return {
          text: "",
          stopReason: "error",
          failureCode: "pi_model_context_measurement_unavailable",
        };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(agentNode(), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_model_context_measurement_unavailable",
        retryable: false,
      },
    });
  });

  it("preserves optional agent activity telemetry from the runner", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return {
          text: "Completed with tools.",
          stopReason: "stop",
          activity: { turns: 3, toolCalls: 4, toolErrors: 1 },
        };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(agentNode(), context);

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "agent",
        activity: { turns: 3, toolCalls: 4, toolErrors: 1 },
      },
    });
  });

  it("passes selected immutable skills and records exact observed resource reads", async () => {
    const snapshot = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: "review",
        description: "Review code when selected.",
        metadata: { version: "1" },
        requestedTools: ["Bash"],
        trust: "project-explicit",
        provenance: ".flow/skills/review",
        files: [{ path: "SKILL.md", content: Buffer.from("# Review\n") }],
      },
    ]);
    const selected = snapshot.packages[0];
    const file = selected?.files[0];
    if (selected === undefined || file === undefined) {
      throw new Error("skill fixture was not created");
    }
    let request: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        request = input;
        return {
          text: "Reviewed.",
          stopReason: "stop",
          capabilityReads: [
            {
              uri: "skill://review/SKILL.md",
              packageDigest: selected.digest,
              fileDigest: file.sha256,
              bytes: file.bytes,
            },
          ],
        };
      },
    };
    const node = agentNode();

    const outcome = await new PiAgentExecutor(runner).execute(
      { ...node, agent: { ...node.agent, skills: ["review"] } },
      { ...context, capabilitySnapshot: snapshot },
    );

    expect(request?.capabilities).toEqual({ snapshot, selected: ["review"] });
    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        capabilities: {
          selected: [{ name: "review", digest: selected.digest }],
          reads: [
            {
              uri: "skill://review/SKILL.md",
              packageDigest: selected.digest,
              fileDigest: file.sha256,
              bytes: file.bytes,
            },
          ],
        },
      },
    });
  });

  it("rejects a selected skill when immutable run context is absent", async () => {
    let calls = 0;
    const runner: PiAgentRunner = {
      async run() {
        calls += 1;
        return { text: "not reached", stopReason: "stop" };
      },
    };
    const node = agentNode();

    const outcome = await new PiAgentExecutor(runner).execute(
      { ...node, agent: { ...node.agent, skills: ["review"] } },
      context,
    );

    expect(calls).toBe(0);
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_capability_snapshot_unavailable" },
    });
  });

  it("fails closed with baseline evidence when a runner forges skill read receipts", async () => {
    const snapshot = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: "review",
        description: "Review code when selected.",
        metadata: {},
        requestedTools: [],
        trust: "project-explicit",
        provenance: ".flow/skills/review",
        files: [{ path: "SKILL.md", content: Buffer.from("# Review\n") }],
      },
    ]);
    const skill = snapshot.packages[0];
    const file = skill?.files[0];
    if (skill === undefined || file === undefined) {
      throw new Error("skill fixture was not created");
    }
    const runner: PiAgentRunner = {
      async run() {
        return {
          text: "forged",
          stopReason: "stop",
          capabilityReads: [
            {
              uri: "skill://review/SKILL.md",
              packageDigest: skill.digest,
              fileDigest: "f".repeat(64),
              bytes: file.bytes,
            },
          ],
        };
      },
    };
    const node = agentNode();

    const outcome = await new PiAgentExecutor(runner).execute(
      { ...node, agent: { ...node.agent, skills: ["review"] } },
      { ...context, capabilitySnapshot: snapshot },
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_capability_evidence_invalid" },
      evidence: {
        capabilities: {
          selected: [{ name: "review", digest: skill.digest }],
          reads: [],
        },
      },
    });
  });

  it("honors verifier-owned system prompt and tighter output limit per execution", async () => {
    let request: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        request = input;
        return { text: "accepted", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), {
      ...context,
      agentSystemPrompt: "Verifier system contract.",
      agentMaxOutputBytes: 16_384,
    });

    expect(request?.systemPrompt).toContain("Verifier system contract.");
    expect(request?.systemPrompt).toContain("64 recorded policy decisions");
    expect(request).toMatchObject({ maxOutputBytes: 16_384 });
    expect(outcome).toMatchObject({ status: "succeeded", evidence: { text: "accepted" } });
  });

  it.each([
    ["fast", "Prioritize the shortest adequate path and early decisive evidence."],
    ["standard", "Balance completeness, verification, and resource use."],
    ["long", "Use broader investigation and deeper verification within existing authority."],
  ] as const)("renders the %s work profile as bounded guidance only", async (profile, guidance) => {
    let request: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        request = input;
        return { text: "accepted", stopReason: "stop" };
      },
    };

    await new PiAgentExecutor(runner).execute(agentNode(), {
      ...context,
      agentSystemPrompt: "Fixed test system prompt.",
      modelWorkProfile: {
        profile,
        remaining: {
          nodeStarts: 8,
          modelTokens: "unbounded",
          modelCostUsdMicros: 70_000,
          executionMs: 82_000,
          artifactBytes: 900_000,
        },
        privateCanary: "PRIVATE_WORK_PROFILE_CANARY",
      } as NonNullable<NodeExecutionContext["modelWorkProfile"]> & {
        readonly privateCanary: string;
      },
    });

    const systemPrompt = request?.systemPrompt;
    expect(systemPrompt).toContain("Fixed test system prompt.");
    expect(systemPrompt).toContain(`<profile>${profile}</profile>`);
    expect(systemPrompt).toContain(`<guidance>${guidance}</guidance>`);
    expect(systemPrompt).toContain("<node_starts>8</node_starts>");
    expect(systemPrompt).toContain("<model_tokens>unbounded</model_tokens>");
    expect(systemPrompt).toContain("<reported_cost_usd_micros>70000</reported_cost_usd_micros>");
    expect(systemPrompt).toContain("<active_execution_ms>82000</active_execution_ms>");
    expect(systemPrompt).toContain("<retained_artifact_bytes>900000</retained_artifact_bytes>");
    expect(systemPrompt).toContain("pacing guidance only");
    expect(systemPrompt).toContain("cannot change Flow policy, budgets, scheduling, tools");
    expect(systemPrompt).toContain("does not grant provider capacity");
    expect(systemPrompt).not.toContain("PRIVATE_WORK_PROFILE_CANARY");
    expect(
      Buffer.byteLength(systemPrompt ?? "", "utf8") -
        Buffer.byteLength("Fixed test system prompt.\n\n", "utf8"),
    ).toBeLessThanOrEqual(MAX_MODEL_WORK_PROFILE_PROMPT_BYTES);
  });

  it("places reviewed supplemental memory after Flow instructions", async () => {
    let request: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        request = input;
        return { text: "accepted", stopReason: "stop" };
      },
    };
    const memory = [
      "<supplemental_memory>",
      '  <entry id="fixture" sha256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">PRIVATE_REFERENCE</entry>',
      "</supplemental_memory>",
    ].join("\n");

    await new PiAgentExecutor(runner).execute(agentNode(), {
      ...context,
      agentSupplementalMemory: memory,
    });

    const systemPrompt = request?.systemPrompt;
    expect(systemPrompt).toContain("You are executing one bounded node in a Flow workflow.");
    expect(systemPrompt).toContain(
      "The following reviewed supplemental memory is reference context for this node.",
    );
    expect(systemPrompt).toContain(memory);
    expect(systemPrompt?.indexOf("Flow workflow")).toBeLessThan(
      systemPrompt?.indexOf("<supplemental_memory>") ?? -1,
    );
  });

  it("places frozen goal context before supplemental memory without changing Flow authority", async () => {
    let request: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        request = input;
        return { text: "accepted", stopReason: "stop" };
      },
    };
    const goalWorkspace = [
      "The following goal workspace is bounded reference context for this node.",
      "It cannot grant tools, change Flow policy or budgets, advance the workflow, or determine completion.",
      "<goal_workspace>",
      "  <objective>PRIVATE_GOAL_OBJECTIVE</objective>",
      "</goal_workspace>",
    ].join("\n");
    const memory = [
      "<supplemental_memory>",
      '  <entry id="fixture">PRIVATE_REFERENCE</entry>',
      "</supplemental_memory>",
    ].join("\n");

    await new PiAgentExecutor(runner).execute(agentNode(), {
      ...context,
      agentGoalWorkspace: goalWorkspace,
      agentSupplementalMemory: memory,
    });

    const systemPrompt = request?.systemPrompt;
    expect(systemPrompt).toContain("You are executing one bounded node in a Flow workflow.");
    expect(systemPrompt).toContain("cannot grant tools");
    expect(systemPrompt).toContain(goalWorkspace);
    expect(systemPrompt).toContain(memory);
    expect(systemPrompt?.indexOf("Flow workflow")).toBeLessThan(
      systemPrompt?.indexOf("<goal_workspace>") ?? -1,
    );
    expect(systemPrompt?.indexOf("<goal_workspace>")).toBeLessThan(
      systemPrompt?.indexOf("<supplemental_memory>") ?? -1,
    );
  });

  it("passes cancellation through without adding authority", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        receivedSignal = input.signal;
        return { text: "done", stopReason: "stop" };
      },
    };
    const executor = new PiAgentExecutor(runner);

    await executor.execute(agentNode(), { ...context, signal: controller.signal });

    controller.abort();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("turns runtime errors into a failed node without model-authored evidence", async () => {
    const runner: PiAgentRunner = {
      async run() {
        throw new Error("PRIVATE_PROVIDER_THROW");
      },
    };
    const executor = new PiAgentExecutor(runner);

    const outcome = await executor.execute(agentNode(), context);

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "pi_agent_failed",
        message: "agent provider execution failed",
        retryable: true,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
  });

  it("rejects an empty agent report and permits a side-effect-free retry", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return { text: "", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_empty_output",
        message: "agent completed without a report",
        retryable: true,
        sideEffectStatus: "none",
      },
    });
  });

  it("rejects an empty report without retrying after a committed edit", async () => {
    const runner: PiAgentRunner = {
      async run(input) {
        await recordEditEffect(input, "committed");
        return { text: "", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(
      agentNode(300_000, ["edit"]),
      contextWithEffectJournal(),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_empty_output",
        retryable: false,
        sideEffectStatus: "committed",
      },
    });
  });

  it("keeps invalid provider telemetry non-retryable", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return {
          text: "invalid telemetry",
          stopReason: "stop",
          activity: { turns: -1, toolCalls: 0, toolErrors: 0 },
        };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_failed",
        retryable: false,
        sideEffectStatus: "none",
      },
    });
  });

  it("preserves settled usage when the model finishes with an error", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return {
          text: "",
          stopReason: "error",
          errorMessage: "PRIVATE_PROVIDER_STREAM",
          usage: {
            inputTokens: 8,
            outputTokens: 1,
            cacheReadTokens: 3,
            cacheWriteTokens: 0,
            costUsdMicros: 9,
          },
        };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(agentNode(), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_error", message: "agent provider execution failed" },
      evidence: {
        kind: "agent",
        usage: {
          inputTokens: 8,
          outputTokens: 1,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
          costUsdMicros: 9,
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_PROVIDER_STREAM");
  });

  it("fails closed without retrying when the provider credit balance is exhausted", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return {
          text: "",
          stopReason: "error",
          errorMessage: "PRIVATE_PROVIDER_BILLING_DETAIL",
          failureCode: "pi_provider_quota_exhausted",
        };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), context);

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "pi_provider_quota_exhausted",
        message: "agent provider quota or credit balance is exhausted",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_PROVIDER_BILLING_DETAIL");
  });

  it.each([
    ["pi_provider_authentication_failed", "agent provider authentication failed", false],
    ["pi_provider_request_rejected", "agent provider rejected the request", false],
    [
      "pi_provider_rate_limited",
      "agent provider rate limit remained unavailable after bounded transport retries",
      true,
    ],
    [
      "pi_provider_unavailable",
      "agent provider remained unavailable after bounded transport retries",
      true,
    ],
  ] as const)(
    "maps %s to fixed public evidence and retryability",
    async (failureCode, message, retryable) => {
      const runner: PiAgentRunner = {
        async run() {
          return {
            text: "",
            stopReason: "error",
            errorMessage: "PRIVATE_PROVIDER_DETAIL",
            failureCode,
          };
        },
      };

      const outcome = await new PiAgentExecutor(runner).execute(agentNode(), context);

      expect(outcome).toEqual({
        status: "failed",
        error: {
          code: failureCode,
          message,
          retryable,
          sideEffectStatus: "none",
        },
        evidence: null,
      });
      expect(JSON.stringify(outcome)).not.toContain("PRIVATE_PROVIDER_DETAIL");
    },
  );

  it("preserves policy decisions when the runtime fails after a tool operation", async () => {
    const runner: PiAgentRunner = {
      async run(input) {
        input.policyBroker.authorize({
          action: "filesystem.list",
          target: input.cwd,
          boundary: "inside",
        });
        throw new Error("PRIVATE_PROVIDER_AFTER_TOOL");
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(agentNode(), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_failed", message: "agent provider execution failed" },
      evidence: {
        kind: "agent",
        text: "",
        textTruncated: false,
        policyDecisions: [
          {
            sequence: 1,
            action: "filesystem.list",
            outcome: "allowed",
          },
        ],
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_PROVIDER_AFTER_TOOL");
  });

  it("preserves a committed edit receipt and side-effect status after provider failure", async () => {
    const runner: PiAgentRunner = {
      async run(input) {
        await recordEditEffect(input, "committed");
        throw new Error("PRIVATE_PROVIDER_AFTER_EDIT");
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(
      agentNode(300_000, ["edit"]),
      contextWithEffectJournal(),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_failed",
        message: "agent provider execution failed",
        retryable: false,
        sideEffectStatus: "committed",
      },
      evidence: {
        kind: "agent",
        effectReceipts: [
          {
            sequence: 1,
            kind: "filesystem.edit",
            outcome: "committed",
          },
        ],
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_PROVIDER_AFTER_EDIT");
  });

  it.each([
    "pi_command_authority_rejections_exhausted",
    "pi_command_authority_journal_unavailable",
  ] as const)("does not retry %s or discard settled effects", async (failureCode) => {
    const runner: PiAgentRunner = {
      async run(input) {
        await recordEditEffect(input, "committed");
        return { text: "", stopReason: "error", failureCode };
      },
    };
    const outcome = await new PiAgentExecutor(runner, () => 100).execute(
      agentNode(300_000, ["edit"]),
      { ...contextWithEffectJournal(), modelSession: {} as ModelSessionJournal },
    );
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: failureCode, retryable: false, sideEffectStatus: "committed" },
      evidence: { kind: "agent", effectReceipts: [{ outcome: "committed" }] },
    });
  });

  it("marks a committed provider failure retryable when a durable model session can continue it", async () => {
    const runner: PiAgentRunner = {
      async run(input) {
        await recordEditEffect(input, "committed");
        throw new Error("PRIVATE_PROVIDER_AFTER_EDIT");
      },
    };
    const durableContext: NodeExecutionContext = {
      ...contextWithEffectJournal(),
      modelSession: {} as ModelSessionJournal,
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(
      agentNode(300_000, ["edit"]),
      durableContext,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_failed",
        message: "agent provider execution failed",
        retryable: true,
        sideEffectStatus: "committed",
      },
      evidence: { kind: "agent", effectReceipts: [{ outcome: "committed" }] },
    });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_PROVIDER_AFTER_EDIT");
  });

  it("marks a committed terminal provider error retryable for durable continuation", async () => {
    const runner: PiAgentRunner = {
      async run(input) {
        await recordEditEffect(input, "committed");
        return {
          text: "",
          stopReason: "error",
          errorMessage: "PRIVATE_PROVIDER_TERMINAL_AFTER_EDIT",
          usage: {
            inputTokens: 8,
            outputTokens: 1,
            cacheReadTokens: 3,
            cacheWriteTokens: 0,
            costUsdMicros: 9,
          },
        };
      },
    };
    const durableContext: NodeExecutionContext = {
      ...contextWithEffectJournal(),
      modelSession: {} as ModelSessionJournal,
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(
      agentNode(300_000, ["edit"]),
      durableContext,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_error",
        message: "agent provider execution failed",
        retryable: true,
        sideEffectStatus: "committed",
      },
      evidence: {
        kind: "agent",
        usage: { inputTokens: 8, outputTokens: 1, costUsdMicros: 9 },
        effectReceipts: [{ outcome: "committed" }],
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_PROVIDER_TERMINAL_AFTER_EDIT");
  });

  it("marks an output-limited terminal result retryable only with durable continuation", async () => {
    const runner: PiAgentRunner = {
      async run(input) {
        await recordEditEffect(input, "committed");
        return {
          text: "partial report",
          stopReason: "length",
          usage: {
            inputTokens: 8,
            outputTokens: 24_576,
            cacheReadTokens: 3,
            cacheWriteTokens: 0,
            costUsdMicros: 9,
          },
        };
      },
    };
    const durableContext: NodeExecutionContext = {
      ...contextWithEffectJournal(),
      modelSession: {} as ModelSessionJournal,
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(
      agentNode(300_000, ["edit"]),
      durableContext,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_incomplete",
        retryable: true,
        sideEffectStatus: "committed",
      },
      evidence: {
        kind: "agent",
        usage: { outputTokens: 24_576 },
        effectReceipts: [{ outcome: "committed" }],
      },
    });
  });

  it("fails a terminal agent result when an edit receipt is uncertain", async () => {
    const runner: PiAgentRunner = {
      async run(input) {
        await recordEditEffect(input, "uncertain");
        return { text: "The edit may have committed.", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(
      agentNode(300_000, ["edit"]),
      contextWithEffectJournal(),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_effect_uncertain", sideEffectStatus: "uncertain" },
      evidence: {
        kind: "agent",
        text: "The edit may have committed.",
        effectReceipts: [{ outcome: "uncertain" }],
      },
    });
  });

  it("rejects Pi terminal error messages even when the session promise resolves", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return {
          text: "partial output",
          stopReason: "error",
          errorMessage: "PRIVATE_PROVIDER_TERMINAL",
        };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), context);

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "pi_agent_error",
        message: "agent provider execution failed",
        retryable: true,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
  });

  it("rejects Pi terminal aborted messages", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return {
          text: "partial output",
          stopReason: "aborted",
          errorMessage: "PRIVATE_PROVIDER_ABORT",
        };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_aborted", message: "agent provider execution was aborted" },
      evidence: null,
    });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_PROVIDER_ABORT");
  });

  it("does not persist provider text for an incomplete terminal result", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return {
          text: "partial output",
          stopReason: "length",
          errorMessage: "PRIVATE_PROVIDER_INCOMPLETE",
        };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), context);

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "pi_agent_incomplete",
        message: "agent provider execution did not complete",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
  });

  it("enforces the Flow-owned agent timeout", async () => {
    let cleanupFinished = false;
    const runner: PiAgentRunner = {
      run(input) {
        return new Promise((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                cleanupFinished = true;
                resolve({
                  text: "",
                  stopReason: "aborted",
                  errorMessage: "aborted",
                  usage: {
                    inputTokens: 2,
                    outputTokens: 1,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    costUsdMicros: 4,
                  },
                });
              }, 10);
            },
            { once: true },
          );
        });
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(10), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_timeout" },
      evidence: {
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 4,
        },
      },
    });
    expect(cleanupFinished).toBe(true);
  });

  it("waits for an active edit reservation when timeout abort rejection wins the race", async () => {
    const runner: PiAgentRunner = {
      run(input) {
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              const operationDigest = "d".repeat(64);
              const target = "/workspace/source.ts";
              input.policyBroker.authorize({
                action: "filesystem.write",
                target,
                boundary: "inside",
                operationDigest,
              });
              const reservation = input.effectRecorder.reserve({
                kind: "filesystem.edit",
                target,
                operationDigest,
              });
              reject(new Error("session rejected during abort"));
              setTimeout(() => {
                void (async () => {
                  await reservation.prepare({
                    beforeSha256: "a".repeat(64),
                    afterSha256: "b".repeat(64),
                    mode: 0o640,
                  });
                  await reservation.settle({
                    outcome: "committed",
                    reason: "directory_synced",
                  });
                })();
              }, 20);
            },
            { once: true },
          );
        });
      },
    };

    const outcome = await new PiAgentExecutor(
      runner,
      performance.now.bind(performance),
      100,
    ).execute(agentNode(5, ["edit"]), contextWithEffectJournal());

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_timeout", sideEffectStatus: "committed" },
      evidence: { effectReceipts: [{ outcome: "committed" }] },
    });
  });

  it("bounds cleanup when a runner does not cooperate with abort", async () => {
    const runner: PiAgentRunner = {
      run() {
        return new Promise(() => undefined);
      },
    };
    const startedAt = performance.now();
    const { protectedPaths: omittedProtectedPaths, ...legacyContext } = context;
    void omittedProtectedPaths;

    const outcome = await new PiAgentExecutor(
      runner,
      performance.now.bind(performance),
      10,
    ).execute(agentNode(10), legacyContext as NodeExecutionContext);

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_timeout",
        sideEffectStatus: "uncertain",
        message: expect.stringContaining("abort cleanup did not settle"),
      },
      evidence: null,
    });
  });

  it("bounds non-cooperative cleanup after external cancellation", async () => {
    const controller = new AbortController();
    const runner: PiAgentRunner = {
      run() {
        return new Promise(() => undefined);
      },
    };
    const startedAt = performance.now();
    const execution = new PiAgentExecutor(runner, performance.now.bind(performance), 10).execute(
      agentNode(1_000),
      { ...context, signal: controller.signal },
    );

    setTimeout(() => controller.abort(new Error("operator cancelled")), 10);
    const outcome = await execution;

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_aborted",
        sideEffectStatus: "uncertain",
        message: expect.stringContaining("operator cancelled"),
      },
      evidence: null,
    });
  });

  it("rejects an invalid abort cleanup grace period", () => {
    expect(() => new PiAgentExecutor(undefined, undefined, -1)).toThrowError(/abortGraceMs/i);
  });

  it("bounds oversized provider output and preserves its complete hash", async () => {
    const completeText = "x".repeat(8 * 1_048_576);
    const runner: PiAgentRunner = {
      async run() {
        return { text: completeText, stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100, 5_000, 1_024).execute(
      agentNode(),
      context,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_output_limit", retryable: false },
      evidence: {
        kind: "agent",
        text: "x".repeat(1_024),
        textHash: createHash("sha256").update(completeText).digest("hex"),
        textTruncated: true,
      },
    });
  });

  it("marks oversized output retryable only with durable committed-edit continuation", async () => {
    const completeText = "x".repeat(2_048);
    const runner: PiAgentRunner = {
      async run(input) {
        await recordEditEffect(input, "committed");
        return { text: completeText, stopReason: "stop" };
      },
    };
    const durableContext: NodeExecutionContext = {
      ...contextWithEffectJournal(),
      modelSession: {} as ModelSessionJournal,
    };

    const outcome = await new PiAgentExecutor(runner, () => 100, 5_000, 1_024).execute(
      agentNode(300_000, ["edit"]),
      durableContext,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_output_limit",
        retryable: true,
        sideEffectStatus: "committed",
      },
      evidence: {
        kind: "agent",
        text: "x".repeat(1_024),
        textHash: createHash("sha256").update(completeText).digest("hex"),
        textTruncated: true,
        effectReceipts: [{ outcome: "committed" }],
      },
    });
  });

  it("does not persist oversized provider-authored error messages", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return { text: "", stopReason: "error", errorMessage: "e".repeat(100_000) };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), context);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.message).toBe("agent provider execution failed");
      expect(JSON.stringify(outcome)).not.toContain("eeee");
    }
  });

  it("does not split a UTF-8 code point at the evidence boundary", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return { text: "é", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100, 5_000, 1).execute(
      agentNode(),
      context,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_output_limit" },
      evidence: { kind: "agent", text: "", textTruncated: true },
    });
  });

  it("rejects success returned after external cancellation", async () => {
    const controller = new AbortController();
    const runner: PiAgentRunner = {
      async run() {
        controller.abort(new Error("operator cancelled"));
        return { text: "late success", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), {
      ...context,
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_aborted", message: "operator cancelled" },
      evidence: null,
    });
  });
});

describe("EmbeddedPiAgentRunner", () => {
  it("rejects a phase-route mismatch before initializing the model runtime", async () => {
    let runtimeInitializations = 0;
    const runner = new EmbeddedPiAgentRunner(async () => {
      runtimeInitializations += 1;
      return { getModel: () => ({}) } as never;
    });
    const profile = createPhaseRoutingProfile({
      selectionRule: "exact-target-v1",
      fallback: "deny",
      assignments: [
        {
          phase: "executor",
          target: { workflowId: "agent-workflow", childPath: [], nodeId: "analyze" },
          route: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
        },
      ],
    });
    const phaseRouting = createPhaseRoutingDecision({
      profile,
      target: { workflowId: "agent-workflow", childPath: [], nodeId: "analyze" },
      route: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
    });

    await expect(
      runner.run({ ...agentRequest(), model: "claude-opus-4-1", phaseRouting }),
    ).rejects.toThrow(/phase-routing decision does not match/i);
    expect(runtimeInitializations).toBe(0);
  });

  it.each(["nitro", "floor", "exacto"])(
    "runs OpenRouter's %s route with base-model capabilities",
    async (variant) => {
      let sessionModel: { readonly id?: string } | undefined;
      const modelLookups: Array<readonly [string, string]> = [];
      const getModel = (provider: string, modelId: string) => {
        modelLookups.push([provider, modelId]);
        return modelId === "z-ai/glm-5.3-flash"
          ? {
              provider: "openrouter",
              id: modelId,
              maxTokens: 131_072,
              reasoning: true,
            }
          : undefined;
      };
      const fakeSession = {
        state: { messages: [{ role: "assistant", stopReason: "stop" }] },
        subscribe: () => () => undefined,
        prompt: async () => undefined,
        abort: async () => undefined,
        getSessionStats: () => sessionStats(),
        dispose: () => undefined,
      };
      const createSession = (async (options: Parameters<typeof createAgentSession>[0]) => {
        if (options === undefined) throw new Error("expected session options");
        sessionModel = options.model;
        return { session: fakeSession };
      }) as unknown as typeof createAgentSession;
      const runner = new EmbeddedPiAgentRunner(async () => ({ getModel }) as never, createSession);

      await runner.run({
        ...agentRequest(),
        provider: "openrouter",
        model: `z-ai/glm-5.3-flash:${variant}`,
        thinking: "low",
      });

      expect(modelLookups).toEqual([
        ["openrouter", `z-ai/glm-5.3-flash:${variant}`],
        ["openrouter", "z-ai/glm-5.3-flash"],
      ]);
      expect(sessionModel?.id).toBe(`z-ai/glm-5.3-flash:${variant}`);
    },
  );

  it("counts turns, tool calls, and tool errors from one settled session", async () => {
    const messages: Array<Record<string, unknown>> = [];
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const fakeSession = {
      state: { messages },
      subscribe: (input: (event: Record<string, unknown>) => void) => {
        listener = input;
        return () => undefined;
      },
      prompt: async () => {
        listener?.({ type: "turn_start" });
        listener?.({ type: "tool_execution_end", isError: false });
        listener?.({ type: "tool_execution_end", isError: true });
        messages.push({ role: "assistant", stopReason: "stop" });
      },
      abort: async () => undefined,
      getSessionStats: () => ({
        ...sessionStats(),
        assistantMessages: 1,
        toolCalls: 2,
        toolResults: 2,
      }),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const result = await runner.run(agentRequest());

    expect(result.activity).toEqual({ turns: 1, toolCalls: 2, toolErrors: 1 });
  });

  it("returns a Flow approval denial to the production Pi loop as a model-visible tool error", async () => {
    const faux = createFauxCore({
      provider: "flow-test",
      models: [{ id: "denial-model", reasoning: false }],
    });
    const model = faux.getModel();
    if (model === undefined) {
      throw new Error("faux model fixture was not created");
    }
    let observedToolResult: unknown;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "flow_exec",
          { executable: process.execPath, args: ["--version"], timeoutMs: 5_000 },
          { id: "tool-call-denied" },
        ),
        { stopReason: "toolUse" },
      ),
      (piContext) => {
        observedToolResult = piContext.messages.at(-1);
        return fauxAssistantMessage("denial observed; no command executed");
      },
    ]);
    let prepareCalls = 0;
    let executorCalls = 0;
    const commandRecorder = new AgentCommandRecorder(
      {
        async executeAgentCommand() {
          executorCalls += 1;
          throw new Error("denied command must not reach the sandbox executor");
        },
      },
      {
        async prepare() {
          prepareCalls += 1;
          throw new Error("denied command must not reach command preparation");
        },
      },
      {
        ...context,
        agentCommandApprovalGate: {
          async authorize() {
            throw new AgentCommandApprovalDeniedError("operator:test", "not authorized");
          },
        },
      },
    );
    const modelRuntime = {
      getModel: (provider: string, modelId: string) =>
        provider === model.provider && modelId === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
      checkAuth: async () => undefined,
      isUsingOAuth: () => false,
      streamSimple: faux.streamSimple,
    };
    const runner = new EmbeddedPiAgentRunner(async () => modelRuntime as never, createAgentSession);

    const result = await runner.run({
      ...agentRequest(),
      provider: model.provider,
      model: model.id,
      tools: ["exec"],
      policyBroker: new PolicyBroker(
        {
          runId: "run-agent",
          workflowId: "agent-workflow",
          nodeId: "analyze",
          attempt: 1,
        },
        ["process.execute"],
      ),
      commandRecorder,
    });

    expect(result).toMatchObject({
      text: "denial observed; no command executed",
      stopReason: "stop",
    });
    expect(observedToolResult).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-call-denied",
      toolName: "flow_exec",
      isError: true,
      content: [
        {
          type: "text",
          text: "agent command approval denied by operator:test: not authorized",
        },
      ],
    });
    expect({ prepareCalls, executorCalls }).toEqual({ prepareCalls: 0, executorCalls: 0 });
  });

  it("adds only selected skill metadata to the locked prompt while Pi resources stay empty", async () => {
    const skillSnapshot = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: "review",
        description: "Review code when selected & needed.",
        metadata: {},
        requestedTools: ["Bash"],
        trust: "project-explicit",
        provenance: ".flow/skills/review",
        files: [
          {
            path: "SKILL.md",
            content: Buffer.from("PRIVATE FULL SKILL INSTRUCTIONS\n"),
          },
        ],
      },
    ]);
    const activation = createPromptActivationSnapshot(promptActivationInput());
    const snapshot = validateCapabilitySnapshot({
      version: 1,
      packages: skillSnapshot.packages,
      activations: [activation],
      digest: calculateCapabilitySnapshotDigest(skillSnapshot.packages, [activation]),
    });
    let sessionOptions: Parameters<typeof createAgentSession>[0] | undefined;
    const fakeSession = {
      state: { messages: [{ role: "assistant", stopReason: "stop" }] },
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => undefined,
    };
    const createSession = (async (options: Parameters<typeof createAgentSession>[0]) => {
      sessionOptions = options;
      return { session: fakeSession };
    }) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    await runner.run({
      ...agentRequest(),
      systemPrompt: [
        "Flow fixed instructions.",
        "The following reviewed supplemental memory is reference context for this node.",
        "<supplemental_memory>PRIVATE_REVIEWED_CONTEXT</supplemental_memory>",
      ].join("\n\n"),
      capabilities: { snapshot, selected: ["review"] },
    });

    const prompt = sessionOptions?.resourceLoader?.getSystemPrompt();
    expect(prompt?.indexOf("Flow fixed instructions.")).toBeLessThan(
      prompt?.indexOf("<supplemental_memory>") ?? -1,
    );
    expect(prompt?.indexOf("<supplemental_memory>")).toBeLessThan(
      prompt?.indexOf("<available_skills>") ?? -1,
    );
    expect(prompt).toContain("<name>review</name>");
    expect(prompt).toContain("Review code when selected &amp; needed.");
    expect(prompt).toContain("skill://review/SKILL.md");
    expect(prompt).toContain(snapshot.packages[0]?.digest);
    expect(prompt).not.toContain("PRIVATE FULL SKILL INSTRUCTIONS");
    expect(prompt).not.toContain(activation.activationDigest);
    expect(prompt).not.toContain(activation.candidate.candidateDigest);
    expect(prompt).not.toContain(activation.evaluation.evaluationId);
    expect(prompt).not.toContain(activation.evaluation.planDigest);
    expect(prompt).not.toContain("Read TASK.md and verify the result.");
    expect(sessionOptions?.resourceLoader?.getSkills().skills).toEqual([]);
    expect(sessionOptions?.resourceLoader?.getExtensions().extensions).toEqual([]);
  });

  it("keeps agent retry ownership in Flow and bounds provider transport retries", async () => {
    let sessionOptions: Parameters<typeof createAgentSession>[0];
    const fakeSession = {
      state: { messages: [{ role: "assistant", stopReason: "stop" }] },
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => undefined,
    };
    const createSession = (async (options: Parameters<typeof createAgentSession>[0]) => {
      sessionOptions = options;
      return { session: fakeSession };
    }) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    await runner.run(agentRequest());

    expect(sessionOptions?.settingsManager?.getRetrySettings()).toEqual({
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 2000,
    });
    expect(sessionOptions?.settingsManager?.getProviderRetrySettings()).toMatchObject({
      maxRetries: 2,
      maxRetryDelayMs: 60_000,
    });
    expect(sessionOptions?.settingsManager?.getCompactionEnabled()).toBe(false);
  });

  it("rejects model settings that Pi cannot apply exactly before session creation", async () => {
    let createSessionCalls = 0;
    const createSession = (async () => {
      createSessionCalls += 1;
      throw new Error("session must not be created");
    }) as unknown as typeof createAgentSession;
    const smallModelRunner = new EmbeddedPiAgentRunner(
      async () =>
        ({
          getModel: () => ({ maxTokens: 16, reasoning: true }),
        }) as never,
      createSession,
    );

    await expect(
      smallModelRunner.run({
        ...agentRequest(),
        thinking: "off",
        maxOutputTokens: 17,
        exactModelSettings: true,
      }),
    ).rejects.toThrowError(/17.*model.*16|model.*16.*17/i);

    const nonReasoningRunner = new EmbeddedPiAgentRunner(
      async () =>
        ({
          getModel: () => ({ maxTokens: 32, reasoning: false }),
        }) as never,
      createSession,
    );
    await expect(
      nonReasoningRunner.run({
        ...agentRequest(),
        thinking: "medium",
        maxOutputTokens: 17,
        exactModelSettings: true,
      }),
    ).rejects.toThrowError(/thinking.*medium.*not supported/i);
    expect(createSessionCalls).toBe(0);
  });

  it("applies supported exact model settings without compaction", async () => {
    let sessionOptions: Parameters<typeof createAgentSession>[0];
    const messages: Array<Record<string, unknown>> = [];
    const fakeSession = {
      thinkingLevel: "medium",
      state: { messages },
      subscribe: () => () => undefined,
      prompt: async () => {
        messages.push({ role: "assistant", stopReason: "stop" });
      },
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => undefined,
    };
    const createSession = (async (options: Parameters<typeof createAgentSession>[0]) => {
      sessionOptions = options;
      return { session: fakeSession };
    }) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () =>
        ({
          getModel: () => ({ maxTokens: 32, reasoning: true }),
        }) as never,
      createSession,
    );

    await runner.run({
      ...agentRequest(),
      maxOutputTokens: 17,
      exactModelSettings: true,
    });

    expect(sessionOptions?.model?.maxTokens).toBe(17);
    expect(sessionOptions?.thinkingLevel).toBe("medium");
    expect(sessionOptions?.settingsManager?.getCompactionEnabled()).toBe(false);
  });

  it("reads the SDK terminal message and disables ambient Pi resources", async () => {
    let sessionOptions: Parameters<typeof createAgentSession>[0];
    let disposed = false;
    const fakeSession = {
      state: {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "provider stream failed",
          },
        ],
      },
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => {
        disposed = true;
      },
    };
    const createSession = (async (options: Parameters<typeof createAgentSession>[0]) => {
      sessionOptions = options;
      return { session: fakeSession };
    }) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () =>
        ({
          getModel: () => ({ provider: "anthropic", id: "claude-sonnet-4-5" }),
        }) as never,
      createSession,
    );

    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "Analyze the repository.",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinking: "medium",
      tools: ["read", "ls", "edit"],
      maxOutputBytes: 65_536,
      policyBroker: testPolicyBroker(),
      protectedPaths: [],
      effectRecorder: testEffectRecorder(),
    });

    expect(result).toEqual({
      text: "",
      textHash: createHash("sha256").update("").digest("hex"),
      textTruncated: false,
      activity: { turns: 1, toolCalls: 0, toolErrors: 0 },
      stopReason: "error",
      errorMessage: "provider stream failed",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        cacheReadTokens: 30,
        cacheWriteTokens: 2,
        costUsdMicros: 1234567,
      },
    });
    expect(sessionOptions?.noTools).toBe("all");
    expect(sessionOptions?.tools).toEqual(["flow_read", "flow_ls", "flow_edit"]);
    expect(sessionOptions?.customTools?.map((tool) => tool.name)).toEqual([
      "flow_read",
      "flow_ls",
      "flow_edit",
    ]);
    expect(sessionOptions?.resourceLoader?.getExtensions().extensions).toEqual([]);
    expect(sessionOptions?.resourceLoader?.getSkills().skills).toEqual([]);
    expect(sessionOptions?.resourceLoader?.getAgentsFiles().agentsFiles).toEqual([]);
    expect(disposed).toBe(true);
  });

  it("returns settled session usage when prompting throws", async () => {
    let disposed = false;
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        throw new Error("provider request failed after billing");
      },
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => {
        disposed = true;
      },
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const result = await runner.run(agentRequest());

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "provider request failed after billing",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        cacheReadTokens: 30,
        cacheWriteTokens: 2,
        costUsdMicros: 1234567,
      },
    });
    expect(disposed).toBe(true);
  });

  it("classifies a structured provider credit-exhaustion error", async () => {
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        throw new Error(
          'OpenAI API error (429): {"type":"insufficient_quota","code":"credit_balance_exhausted","message":"PRIVATE_PROVIDER_BILLING_DETAIL"}',
        );
      },
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const result = await runner.run(agentRequest());

    expect(result.failureCode).toBe("pi_provider_quota_exhausted");
    expect(result.errorMessage).toContain("PRIVATE_PROVIDER_BILLING_DETAIL");
  });

  it.each([
    [401, "pi_provider_authentication_failed"],
    [402, "pi_provider_quota_exhausted"],
    [400, "pi_provider_request_rejected"],
    [429, "pi_provider_rate_limited"],
    [503, "pi_provider_unavailable"],
    [524, "pi_provider_unavailable"],
    [529, "pi_provider_unavailable"],
  ] as const)("classifies an OpenRouter HTTP %i failure as %s", async (status, failureCode) => {
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        throw new Error(
          `OpenRouter API error (${status}): {"error":{"code":${status},"message":"PRIVATE_OPENROUTER_DETAIL"}}`,
        );
      },
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const result = await runner.run(agentRequest());

    expect(result.failureCode).toBe(failureCode);
    expect(result.errorMessage).toContain("PRIVATE_OPENROUTER_DETAIL");
  });

  it.each([
    "TypeError: fetch failed",
    "Provider returned error",
    "Stream ended without finish_reason",
  ])("classifies a retryable provider transport failure: %s", async (message) => {
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        throw new Error(message);
      },
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const result = await runner.run(agentRequest());

    expect(result.failureCode).toBe("pi_provider_unavailable");
    expect(result.errorMessage).toBe(message);
  });

  it("classifies a statusless provider rate limit separately from transport failures", async () => {
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        throw new Error("Provider rate limit exceeded");
      },
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const result = await runner.run(agentRequest());

    expect(result.failureCode).toBe("pi_provider_rate_limited");
  });

  it("does not classify a textual number outside the HTTP status range", async () => {
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        throw new Error("OpenRouter API error (700): PRIVATE_NON_HTTP_DETAIL");
      },
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const result = await runner.run(agentRequest());

    expect(result.failureCode).toBeUndefined();
    expect(result.stopReason).toBe("error");
  });

  it("classifies Pi's friendly exhausted-credit message", async () => {
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        throw new Error(
          "You have no credits. Add credits at https://platform.openai.com/settings/organization/billing.",
        );
      },
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const result = await runner.run(agentRequest());

    expect(result.failureCode).toBe("pi_provider_quota_exhausted");
  });

  it("does not misclassify an ordinary rate limit as exhausted credit", async () => {
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        throw new Error(
          'OpenAI API error (429): {"type":"rate_limit_error","code":"rate_limit_exceeded"}',
        );
      },
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const result = await runner.run(agentRequest());

    expect(result.failureCode).toBe("pi_provider_rate_limited");
    expect(result.stopReason).toBe("error");
  });

  it("ignores quota words outside structured provider code fields", async () => {
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        throw new Error(
          'OpenAI API error (429): {"type":"rate_limit_error","code":"rate_limit_exceeded","message":"insufficient_quota: no credits; add credits"}',
        );
      },
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const result = await runner.run(agentRequest());

    expect(result.failureCode).toBe("pi_provider_rate_limited");
    expect(result.stopReason).toBe("error");
  });

  it("rejects invalid provider usage instead of persisting it", async () => {
    const fakeSession = {
      state: { messages: [{ role: "assistant", stopReason: "stop" }] },
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      getSessionStats: () => ({ ...sessionStats(), cost: Number.NaN }),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    await expect(runner.run(agentRequest())).rejects.toThrowError(/cost.*finite/i);
  });

  it("rounds every positive provider charge up to at least one micro-dollar", async () => {
    const fakeSession = {
      state: { messages: [{ role: "assistant", stopReason: "stop" }] },
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      getSessionStats: () => ({ ...sessionStats(), cost: 1e-22 }),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    await expect(runner.run(agentRequest())).resolves.toMatchObject({
      usage: { costUsdMicros: 1 },
    });
  });

  it("does not create a session when cancellation arrives during runtime setup", async () => {
    const controller = new AbortController();
    let releaseRuntime: () => void = () => undefined;
    const runtimeReady = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    let createSessionCalls = 0;
    const createSession = (async () => {
      createSessionCalls += 1;
      throw new Error("session must not be created");
    }) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(async () => {
      await runtimeReady;
      return { getModel: () => ({}) } as never;
    }, createSession);

    const run = runner.run(agentRequest(controller.signal));
    controller.abort(new Error("cancelled during runtime setup"));
    releaseRuntime();

    await expect(run).rejects.toThrowError(/cancelled during runtime setup/i);
    expect(createSessionCalls).toBe(0);
  });

  it("aborts and disposes without prompting when cancellation arrives during session setup", async () => {
    const controller = new AbortController();
    let releaseSession: () => void = () => undefined;
    const sessionReady = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    let prompted = false;
    let aborted = false;
    let disposed = false;
    let sessionSetupStarted = false;
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        prompted = true;
      },
      abort: async () => {
        aborted = true;
      },
      getSessionStats: () => sessionStats(),
      dispose: () => {
        disposed = true;
      },
    };
    const createSession = (async () => {
      sessionSetupStarted = true;
      await sessionReady;
      return { session: fakeSession };
    }) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const run = runner.run(agentRequest(controller.signal));
    while (!sessionSetupStarted) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    controller.abort(new Error("cancelled during session setup"));
    releaseSession();

    await expect(run).rejects.toThrowError(/cancelled during session setup/i);
    expect({ prompted, aborted, disposed }).toEqual({
      prompted: false,
      aborted: true,
      disposed: true,
    });
  });

  it("awaits active-session abort cleanup before disposal", async () => {
    const controller = new AbortController();
    let finishPrompt: () => void = () => undefined;
    const promptFinished = new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
    let promptStarted = false;
    let abortFinished = false;
    let disposedAfterAbort = false;
    const messages: Array<Record<string, unknown>> = [];
    const fakeSession = {
      state: { messages },
      subscribe: () => () => undefined,
      prompt: async () => {
        promptStarted = true;
        await promptFinished;
      },
      abort: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        abortFinished = true;
        messages.push({ role: "assistant", stopReason: "aborted" });
        finishPrompt();
      },
      getSessionStats: () => sessionStats(),
      dispose: () => {
        disposedAfterAbort = abortFinished;
      },
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const run = runner.run(agentRequest(controller.signal));
    while (!promptStarted) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    controller.abort(new Error("operator cancelled"));
    const result = await run;

    expect(result.stopReason).toBe("aborted");
    expect(disposedAfterAbort).toBe(true);
  });
});

function agentNode(
  timeoutMs = 300_000,
  tools: CompiledAgentNode["agent"]["tools"] = ["read", "ls"],
  policyDecisionLimit?: number,
): CompiledAgentNode {
  return {
    id: "analyze",
    type: "agent",
    dependsOn: [],
    agent: {
      prompt: "Analyze the repository.",
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        thinking: "medium",
      },
      tools,
      skills: [],
      toolPackages: [],
      ...(policyDecisionLimit === undefined ? {} : { policyDecisionLimit }),
      timeoutMs,
    },
  };
}

function agentRequest(signal?: AbortSignal): PiAgentRunRequest {
  return {
    cwd: process.cwd(),
    prompt: "Analyze the repository.",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    thinking: "medium",
    tools: ["read", "ls"],
    maxOutputBytes: 65_536,
    policyBroker: testPolicyBroker(),
    protectedPaths: [],
    effectRecorder: testEffectRecorder(),
    ...(signal === undefined ? {} : { signal }),
  };
}

function sessionStats() {
  return {
    sessionFile: undefined,
    sessionId: "session-test",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: {
      input: 12,
      output: 5,
      cacheRead: 30,
      cacheWrite: 2,
      total: 49,
    },
    cost: 1.234567,
  };
}

function testEffectRecorder() {
  return new AgentEffectRecorder(
    {
      runId: "run-agent",
      workflowId: "agent-workflow",
      nodeId: "analyze",
      attempt: 1,
    },
    testNodeEffectJournal(),
  );
}

function contextWithEffectJournal(): NodeExecutionContext {
  return { ...context, effectJournal: testNodeEffectJournal() };
}

function contextWithAgentCommand(
  artifactBudgetExhausted: boolean,
  terminationStatus: "not-required" | "unconfirmed" = "not-required",
): NodeExecutionContext {
  const evidence = {
    kind: "command" as const,
    executable: "npm",
    args: ["test"],
    exitCode: terminationStatus === "unconfirmed" ? null : 0,
    signal: null,
    stdout: "output",
    stderr: "",
    stdoutHash: createHash("sha256").update("output").digest("hex"),
    stderrHash: createHash("sha256").update("").digest("hex"),
    stdoutRetainedHash: createHash("sha256").update("output").digest("hex"),
    stderrRetainedHash: createHash("sha256").update("").digest("hex"),
    stdoutRetainedBytes: 6,
    stderrRetainedBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: terminationStatus === "unconfirmed",
    aborted: false,
    durationMs: 1,
    processContainment: "linux-pid-namespace" as const,
    terminationStatus,
    sandbox: {
      backend: "test-sandbox",
      backendVersion: "1",
      profile: "workspace-write-network-deny-v1",
      policyDigest: "a".repeat(64),
    },
  };
  const executor: AgentCommandExecutor = {
    executeAgentCommand: async (request): Promise<AgentCommandSettlementOutcome> => {
      const requestEvidence = { ...evidence, executable: request.executable, args: request.args };
      return terminationStatus === "unconfirmed"
        ? {
            status: "failed",
            error: {
              code: "command_termination_failed",
              message: "command process tree termination could not be confirmed",
              retryable: false,
              sideEffectStatus: "uncertain",
            },
            evidence: requestEvidence,
          }
        : { status: "succeeded", evidence: requestEvidence };
    },
  };
  const journal: NodeAgentCommandJournal = {
    prepare: async () => ({
      commandId: "command-3",
      commandSequence: 1,
      settle: async () => ({ artifactBudgetExhausted }),
    }),
  };
  return { ...context, agentCommandExecutor: executor, agentCommandJournal: journal };
}

function testNodeEffectJournal(): NodeEffectJournal {
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
                runId: "run-agent",
                workflowId: "agent-workflow",
                nodeId: "analyze",
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

async function recordEditEffect(
  request: PiAgentRunRequest,
  outcome: "committed" | "uncertain",
): Promise<void> {
  const target = `${request.cwd}/source.ts`;
  const operationDigest = "d".repeat(64);
  request.policyBroker.authorize({
    action: "filesystem.write",
    target,
    boundary: "inside",
    operationDigest,
  });
  const reservation = request.effectRecorder.reserve({
    kind: "filesystem.edit",
    target,
    operationDigest,
  });
  await reservation.prepare({
    beforeSha256: "a".repeat(64),
    afterSha256: "b".repeat(64),
    mode: 0o640,
  });
  await reservation.settle(
    outcome === "committed"
      ? { outcome: "committed", reason: "directory_synced" }
      : { outcome: "unknown", reason: "post_commit_failure" },
  );
}

function testPolicyBroker(): PolicyBroker {
  return new PolicyBroker(
    {
      runId: "run-agent",
      workflowId: "agent-workflow",
      nodeId: "analyze",
      attempt: 1,
    },
    ["filesystem.read", "filesystem.list"],
  );
}
