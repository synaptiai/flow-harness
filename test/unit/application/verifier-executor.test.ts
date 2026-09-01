import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { serializeBoundedIssueReviewContext } from "../../../src/application/issue-independent-review-projection.js";
import {
  admitIssueWorkflow,
  MAX_ISSUE_REVIEW_CONTEXT_BYTES,
} from "../../../src/application/issue-workflow-admission.js";
import type {
  AgentExecutor,
  CommandExecutor,
  NodeExecutionContext,
  NodeExecutionOutcome,
} from "../../../src/application/ports.js";
import {
  MAX_VERIFIER_INPUT_BYTES,
  VERIFIER_SYSTEM_PROMPT,
  VerifierNodeExecutor,
} from "../../../src/application/verifier-executor.js";
import {
  type AgentEvidence,
  type CommandEvidence,
  calculateAcpAgentSessionBindingDigest,
} from "../../../src/domain/run/events.js";
import { MAX_MODEL_WORK_PROFILE_PROMPT_BYTES } from "../../../src/domain/run/work-profile.js";
import {
  type CompiledVerifierNode,
  MAX_ISSUE_REVIEW_MODEL_VERIFIER_INPUT_BYTES,
} from "../../../src/domain/workflow/types.js";

describe("verifier node executor", () => {
  it("maps exit-zero command execution to accepted verifier evidence", async () => {
    const command = fakeCommandExecutor({ status: "succeeded", evidence: commandEvidence(0) });
    const agent = fakeAgentExecutor();
    const executor = new VerifierNodeExecutor(command, agent);

    const outcome = await executor.execute(commandVerifier(), context());

    expect(command.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "review",
        type: "command",
        command: { executable: "npm", args: ["test"], timeoutMs: 60_000 },
      }),
      expect.objectContaining({ runId: "run-1" }),
    );
    expect(agent.execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "verifier",
        driver: "command",
        result: "completed",
        verdict: "accepted",
        reason: "command exited with code 0",
        command: { exitCode: 0 },
      },
    });
  });

  it("maps normal non-zero command execution to rejection and preserves uncertainty", async () => {
    const evidence = commandEvidence(2);
    const command = fakeCommandExecutor({
      status: "failed",
      error: {
        code: "command_failed",
        message: "command exited with code 2",
        retryable: false,
        sideEffectStatus: "uncertain",
      },
      evidence,
    });
    const executor = new VerifierNodeExecutor(command, fakeAgentExecutor());

    const outcome = await executor.execute(commandVerifier(), context());

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "verifier_rejected",
        message: "command exited with code 2",
        retryable: false,
        sideEffectStatus: "uncertain",
      },
      evidence: { verdict: "rejected", command: evidence },
    });
  });

  it("does not trust a nominal command success that carries non-zero evidence", async () => {
    const executor = new VerifierNodeExecutor(
      fakeCommandExecutor({ status: "succeeded", evidence: commandEvidence(2) }),
      fakeAgentExecutor(),
    );

    const outcome = await executor.execute(commandVerifier(), context());

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "verifier_rejected", sideEffectStatus: "uncertain" },
      evidence: { verdict: "rejected", command: { exitCode: 2 } },
    });
  });

  it("preserves a committed command side-effect lower bound", async () => {
    const executor = new VerifierNodeExecutor(
      fakeCommandExecutor({
        status: "failed",
        error: {
          code: "command_failed",
          message: "command exited with code 2",
          retryable: false,
          sideEffectStatus: "committed",
        },
        evidence: commandEvidence(2),
      }),
      fakeAgentExecutor(),
    );

    const outcome = await executor.execute(commandVerifier(), context());

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "verifier_rejected", sideEffectStatus: "committed" },
    });
  });

  it("does not accept exit-zero evidence from a failed command outcome", async () => {
    const executor = new VerifierNodeExecutor(
      fakeCommandExecutor({
        status: "failed",
        error: {
          code: "command_cleanup_failed",
          message: "sandbox cleanup did not settle",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: commandEvidence(0),
      }),
      fakeAgentExecutor(),
    );

    const outcome = await executor.execute(commandVerifier(), context());

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "verifier_inconclusive",
        message: "sandbox cleanup did not settle",
        sideEffectStatus: "uncertain",
      },
      evidence: { result: "execution_failed", verdict: "inconclusive", command: { exitCode: 0 } },
    });
  });

  it("fails closed when command evidence does not match the declared operation", async () => {
    const evidence = { ...commandEvidence(0), executable: "different" };
    const executor = new VerifierNodeExecutor(
      fakeCommandExecutor({ status: "succeeded", evidence }),
      fakeAgentExecutor(),
    );

    const outcome = await executor.execute(commandVerifier(), context());

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "verifier_inconclusive",
        message: "command verifier evidence does not match its declaration",
        retryable: false,
        sideEffectStatus: "uncertain",
      },
      evidence: null,
    });
  });

  it("maps command infrastructure failure without evidence to inconclusive", async () => {
    const command = fakeCommandExecutor({
      status: "failed",
      error: {
        code: "command_sandbox_unavailable",
        message: "sandbox unavailable",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
    const executor = new VerifierNodeExecutor(command, fakeAgentExecutor());

    const outcome = await executor.execute(commandVerifier(), context());

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "verifier_inconclusive",
        message: "sandbox unavailable",
        sideEffectStatus: "none",
      },
      evidence: {
        driver: "command",
        result: "execution_failed",
        verdict: "inconclusive",
        durationMs: 0,
        command: null,
      },
    });
  });

  it("renders exact evidence into a dedicated zero-tool model session and parses strict JSON", async () => {
    const reason = "The deterministic evidence proves the claim.";
    const raw = JSON.stringify({ verdict: "accepted", reason });
    const agent = fakeAgentExecutor({ status: "succeeded", evidence: agentEvidence(raw) });
    const executor = new VerifierNodeExecutor(fakeCommandExecutor(), agent);

    const outcome = await executor.execute(modelVerifier(), contextWithSources());

    expect(agent.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "review",
        type: "agent",
        agent: expect.objectContaining({
          tools: [],
          model: { provider: "test", id: "deterministic", thinking: "medium" },
          prompt: expect.stringContaining('"value":"verified input"'),
        }),
      }),
      expect.objectContaining({ agentSystemPrompt: VERIFIER_SYSTEM_PROMPT }),
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "verifier",
        driver: "model",
        result: "parsed",
        verdict: "accepted",
        reason,
        raw,
        rawHash: sha256(raw),
        rawTruncated: false,
        provider: "test",
        model: "deterministic",
        sources: [
          {
            sourceNodeId: "source",
            sourceAttempt: 1,
            sourceField: "command.stdout",
            sourceHash: sha256("verified input"),
          },
        ],
      },
    });
  });

  it("passes a model verifier's frozen output-token limit to the agent executor", async () => {
    const raw = verdictJson("accepted", "The bounded response verifies the evidence.");
    const agent = fakeAgentExecutor({ status: "succeeded", evidence: agentEvidence(raw) });
    const executor = new VerifierNodeExecutor(fakeCommandExecutor(), agent);
    const baseNode = modelVerifier();
    if (baseNode.verifier.kind !== "model") throw new Error("fixture must use a model verifier");
    const node: CompiledVerifierNode = {
      ...baseNode,
      verifier: { ...baseNode.verifier, maxOutputTokens: 8_192 },
    };

    await executor.execute(node, contextWithSources());

    expect(agent.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentMaxOutputTokens: 8_192 }),
    );
  });

  it("turns an explicit rejected model verdict into a side-effect-free verifier failure", async () => {
    const reason = "The evidence does not prove the claim.";
    const raw = JSON.stringify({ verdict: "rejected", reason });
    const executor = new VerifierNodeExecutor(
      fakeCommandExecutor(),
      fakeAgentExecutor({ status: "succeeded", evidence: agentEvidence(raw) }),
    );

    const outcome = await executor.execute(modelVerifier(), contextWithSources());

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "verifier_rejected",
        message: reason,
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: { result: "parsed", verdict: "rejected" },
    });
  });

  it("preserves ACP process and observed-usage provenance in model verifier evidence", async () => {
    const raw = verdictJson("accepted", "ACP verified the declared evidence.");
    const agent = fakeAgentExecutor({
      status: "succeeded",
      evidence: acpAgentEvidence(raw),
    });
    const executor = new VerifierNodeExecutor(fakeCommandExecutor(), agent);

    const outcome = await executor.execute(modelVerifier(), contextWithSources());

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        driver: "model",
        usageObservation: {
          modelTokens: { status: "complete", totalTokens: 21 },
          costUsd: { status: "unavailable" },
        },
        acp: {
          executor: "local-acp-process-v1",
          terminationStatus: "confirmed",
          sessionBindingDigest: calculateAcpAgentSessionBindingDigest({
            runId: "run-1",
            workflowId: "workflow-1",
            nodeId: "review",
            attempt: 1,
            agentDigest: "a".repeat(64),
            sessionIdHash: "b".repeat(64),
          }),
        },
      },
    });
  });

  it.each([
    ["extra prose", 'Result: {"verdict":"accepted","reason":"looks good"}'],
    ["a code fence", '```json\n{"verdict":"accepted","reason":"looks good"}\n```'],
    ["an unknown key", '{"verdict":"accepted","reason":"looks good","score":1}'],
    ["an invalid verdict", '{"verdict":"pass","reason":"looks good"}'],
    ["an empty reason", '{"verdict":"accepted","reason":""}'],
    ["duplicate keys", '{"verdict":"rejected","verdict":"accepted","reason":"looks good"}'],
  ])("fails closed on %s", async (_name, raw) => {
    const executor = new VerifierNodeExecutor(
      fakeCommandExecutor(),
      fakeAgentExecutor({ status: "succeeded", evidence: agentEvidence(raw) }),
    );

    const outcome = await executor.execute(modelVerifier(), contextWithSources());

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "verifier_inconclusive", sideEffectStatus: "none" },
      evidence: { result: "invalid_output", verdict: "inconclusive", raw },
    });
  });

  it("preserves bounded raw output and usage when model execution fails", async () => {
    const raw = "partial response";
    const evidence = agentEvidence(raw);
    const executor = new VerifierNodeExecutor(
      fakeCommandExecutor(),
      fakeAgentExecutor({
        status: "failed",
        error: {
          code: "pi_agent_timeout",
          message: "agent exceeded timeout",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence,
      }),
    );

    const outcome = await executor.execute(modelVerifier(), contextWithSources());

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "verifier_inconclusive", message: "agent exceeded timeout" },
      evidence: {
        result: "execution_failed",
        verdict: "inconclusive",
        raw,
        usage: evidence.usage,
        durationMs: evidence.durationMs,
      },
    });
  });

  it("normalizes generic Pi uncertainty when the model verifier had zero tools", async () => {
    const executor = new VerifierNodeExecutor(
      fakeCommandExecutor(),
      fakeAgentExecutor({
        status: "failed",
        error: {
          code: "pi_agent_timeout",
          message: "cleanup did not settle",
          retryable: false,
          sideEffectStatus: "uncertain",
        },
        evidence: agentEvidence("partial response"),
      }),
    );

    const outcome = await executor.execute(modelVerifier(), contextWithSources());

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "verifier_inconclusive", sideEffectStatus: "none" },
      evidence: { result: "execution_failed", verdict: "inconclusive" },
    });
  });

  it("fails closed when the adapter reports different model provenance", async () => {
    const evidence = {
      ...agentEvidence(verdictJson("accepted", "wrong model")),
      model: "different-model",
    };
    const executor = new VerifierNodeExecutor(
      fakeCommandExecutor(),
      fakeAgentExecutor({ status: "succeeded", evidence }),
    );

    const outcome = await executor.execute(modelVerifier(), contextWithSources());

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "verifier_inconclusive",
        message: "model verifier evidence provenance does not match its declaration",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
  });

  it("fails with uncertain authority if a zero-tool adapter reports tool activity", async () => {
    const raw = JSON.stringify({ verdict: "accepted", reason: "must not be trusted" });
    const evidence = {
      ...agentEvidence(raw),
      policyDecisions: [{} as never],
    };
    const executor = new VerifierNodeExecutor(
      fakeCommandExecutor(),
      fakeAgentExecutor({ status: "succeeded", evidence }),
    );

    const outcome = await executor.execute(modelVerifier(), contextWithSources());

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "verifier_inconclusive",
        message: "zero-tool model verifier reported unexpected tool activity",
        retryable: false,
        sideEffectStatus: "uncertain",
      },
      evidence: null,
    });
  });

  it("refuses truncated source evidence before invoking the model", async () => {
    const agent = fakeAgentExecutor();
    const executor = new VerifierNodeExecutor(fakeCommandExecutor(), agent);
    const source = contextWithSources().verifierSources?.[0];

    const outcome = await executor.execute(modelVerifier(), {
      ...contextWithSources(),
      verifierSources: source === undefined ? [] : [{ ...source, truncated: true }],
    });

    expect(agent.execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "verifier_inconclusive", message: expect.stringMatching(/truncated/i) },
      evidence: { result: "execution_failed", verdict: "inconclusive", raw: "" },
    });
  });

  it("enforces the aggregate rendered input ceiling before invoking the model", async () => {
    const agent = fakeAgentExecutor();
    const executor = new VerifierNodeExecutor(fakeCommandExecutor(), agent);
    const source = contextWithSources().verifierSources?.[0];
    const oversizedValue = "x".repeat(MAX_VERIFIER_INPUT_BYTES);

    const outcome = await executor.execute(modelVerifier(), {
      ...contextWithSources(),
      verifierSources:
        source === undefined
          ? []
          : [{ ...source, value: oversizedValue, sourceHash: sha256(oversizedValue) }],
    });

    expect(agent.execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "verifier_inconclusive", message: expect.stringMatching(/262144/) },
    });
  });

  it("reserves the bounded work-profile prompt inside the verifier input ceiling", async () => {
    const agent = fakeAgentExecutor();
    const executor = new VerifierNodeExecutor(fakeCommandExecutor(), agent);
    const source = contextWithSources().verifierSources?.[0];
    const nearLimitValue = "x".repeat(
      MAX_VERIFIER_INPUT_BYTES - MAX_MODEL_WORK_PROFILE_PROMPT_BYTES / 2,
    );

    const outcome = await executor.execute(modelVerifier(), {
      ...contextWithSources(),
      modelWorkProfile: {
        profile: "standard",
        remaining: {
          nodeStarts: "unbounded",
          modelTokens: "unbounded",
          modelCostUsdMicros: "unbounded",
          executionMs: "unbounded",
          artifactBytes: "unbounded",
        },
      },
      verifierSources:
        source === undefined
          ? []
          : [{ ...source, value: nearLimitValue, sourceHash: sha256(nearLimitValue) }],
    });

    expect(agent.execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "verifier_inconclusive", message: expect.stringMatching(/262144/) },
    });
  });

  it("grants expanded verifier input only to a frozen issue-review policy", async () => {
    const prompt = "r".repeat(MAX_VERIFIER_INPUT_BYTES);
    const raw = verdictJson("accepted", "The bounded review evidence is sufficient.");
    const genericAgent = fakeAgentExecutor({ status: "succeeded", evidence: agentEvidence(raw) });
    const reviewAgent = fakeAgentExecutor({ status: "succeeded", evidence: agentEvidence(raw) });
    const genericExecutor = new VerifierNodeExecutor(fakeCommandExecutor(), genericAgent);
    const reviewExecutor = new VerifierNodeExecutor(fakeCommandExecutor(), reviewAgent);
    const baseNode = modelVerifier();
    if (baseNode.verifier.kind !== "model") throw new Error("fixture must use a model verifier");
    const genericNode: CompiledVerifierNode = {
      ...baseNode,
      verifier: { ...baseNode.verifier, prompt },
    };
    const reviewNode: CompiledVerifierNode = {
      ...baseNode,
      verifier: {
        ...baseNode.verifier,
        prompt,
        inputPolicy: {
          kind: "issue-workflow",
          role: "review",
          maxBytes: MAX_ISSUE_REVIEW_MODEL_VERIFIER_INPUT_BYTES,
        },
      },
    };

    const generic = await genericExecutor.execute(genericNode, contextWithSources());
    const review = await reviewExecutor.execute(reviewNode, contextWithSources());

    expect(generic).toMatchObject({
      status: "failed",
      error: { code: "verifier_inconclusive", message: expect.stringContaining("262144") },
    });
    expect(genericAgent.execute).not.toHaveBeenCalled();
    expect(review).toMatchObject({ status: "succeeded" });
    expect(reviewAgent.execute).toHaveBeenCalledOnce();
  });

  it("executes a quote-heavy exact-limit review projection without another JSON escape layer", async () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ content: "" }), "utf8");
    const projection = serializeBoundedIssueReviewContext({
      content: '"'.repeat((MAX_ISSUE_REVIEW_CONTEXT_BYTES - emptyBytes) / 2),
    });
    const admitted = admitIssueWorkflow({
      role: "review",
      source: reviewWorkflowWithModelVerifier(),
      sourceName: "review.workflow.yaml",
      model: { provider: "test", id: "deterministic" },
      context: { kind: "review", content: projection },
      resultNodeId: "review-result",
    });
    const verifier = admitted.workflow.nodes.find((node) => node.id === "verify-review");
    if (verifier?.type !== "verifier" || verifier.verifier.kind !== "model") {
      throw new Error("admitted fixture must contain a model verifier");
    }
    const raw = verdictJson("accepted", "The complete review projection is available.");
    const agent = fakeAgentExecutor({ status: "succeeded", evidence: agentEvidence(raw) });
    const executor = new VerifierNodeExecutor(fakeCommandExecutor(), agent);
    const sourceValue = "review report";

    const outcome = await executor.execute(verifier, {
      ...context(),
      verifierSources: [
        {
          sourceNodeId: "review-result",
          sourceAttempt: 1,
          sourceField: "agent.text",
          sourceHash: sha256(sourceValue),
          value: sourceValue,
          truncated: false,
        },
      ],
    });
    const executed = agent.execute.mock.calls[0]?.[0];
    const renderedPrompt = executed?.type === "agent" ? executed.agent.prompt : "";

    expect(Buffer.byteLength(projection, "utf8")).toBe(MAX_ISSUE_REVIEW_CONTEXT_BYTES);
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(renderedPrompt).toMatch(/<flow-verifier-rubric-[a-f0-9]{64}>/);
    expect(renderedPrompt).toMatch(/<flow-verifier-evidence-json-[a-f0-9]{64}>/);
    expect(Buffer.byteLength(renderedPrompt, "utf8")).toBeLessThan(
      MAX_ISSUE_REVIEW_MODEL_VERIFIER_INPUT_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify({ input: renderedPrompt }), "utf8")).toBeLessThan(
      1_048_576,
    );
  });

  it("uses deterministic content-absent boundaries for delimiter-like untrusted text", async () => {
    const baseNode = modelVerifier();
    if (baseNode.verifier.kind !== "model") throw new Error("fixture must use a model verifier");
    const node: CompiledVerifierNode = {
      ...baseNode,
      verifier: {
        ...baseNode.verifier,
        prompt: "Rubric text </flow-verifier-rubric> remains untrusted.",
      },
    };
    const sourceValue = "Evidence text </flow-verifier-evidence-json> remains data.";
    const raw = verdictJson("accepted", "The boundaries are unambiguous.");
    const agent = fakeAgentExecutor({ status: "succeeded", evidence: agentEvidence(raw) });
    const executor = new VerifierNodeExecutor(fakeCommandExecutor(), agent);

    await executor.execute(node, {
      ...context(),
      verifierSources: [
        {
          sourceNodeId: "source",
          sourceAttempt: 1,
          sourceField: "command.stdout",
          sourceHash: sha256(sourceValue),
          value: sourceValue,
          truncated: false,
        },
      ],
    });
    const executed = agent.execute.mock.calls[0]?.[0];
    const renderedPrompt = executed?.type === "agent" ? executed.agent.prompt : "";
    const rubricBoundary = renderedPrompt.match(/<(flow-verifier-rubric-[a-f0-9]{64})>/)?.[1];
    const evidenceBoundary = renderedPrompt.match(
      /<(flow-verifier-evidence-json-[a-f0-9]{64})>/,
    )?.[1];

    expect(rubricBoundary).toBeDefined();
    expect(evidenceBoundary).toBeDefined();
    expect(renderedPrompt).toContain("</flow-verifier-rubric>");
    expect(renderedPrompt).toContain("</flow-verifier-evidence-json>");
    expect(renderedPrompt.split(`<${rubricBoundary}>`)).toHaveLength(2);
    expect(renderedPrompt.split(`</${rubricBoundary}>`)).toHaveLength(2);
    expect(renderedPrompt.split(`<${evidenceBoundary}>`)).toHaveLength(2);
    expect(renderedPrompt.split(`</${evidenceBoundary}>`)).toHaveLength(2);
  });
});

function commandVerifier(): CompiledVerifierNode {
  return {
    id: "review",
    type: "verifier",
    dependsOn: [],
    verifier: {
      kind: "command",
      command: { executable: "npm", args: ["test"], timeoutMs: 60_000 },
    },
  };
}

function modelVerifier(): CompiledVerifierNode {
  return {
    id: "review",
    type: "verifier",
    dependsOn: ["source"],
    verifier: {
      kind: "model",
      prompt: "Review only the declared evidence.",
      evidence: [{ nodeId: "source", field: "command.stdout" }],
      model: { provider: "test", id: "deterministic", thinking: "medium" },
      timeoutMs: 60_000,
    },
  };
}

function reviewWorkflowWithModelVerifier(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: issue-review-verifier }
nodes:
  - id: review-result
    type: agent
    agent:
      prompt: Review the exact candidate.
      model: { provider: placeholder, id: placeholder }
      tools: [read]
  - id: verify-review
    type: verifier
    dependsOn: [review-result]
    verifier:
      kind: model
      prompt: Verify the review report.
      evidence: [{ nodeId: review-result, field: agent.text }]
      model: { provider: placeholder, id: placeholder }
`;
}

function context(): NodeExecutionContext {
  return {
    runId: "run-1",
    workflowId: "workflow-1",
    attempt: 1,
    cwd: "/workspace",
    protectedPaths: ["/runs"],
  };
}

function contextWithSources(): NodeExecutionContext {
  return {
    ...context(),
    verifierSources: [
      {
        sourceNodeId: "source",
        sourceAttempt: 1,
        sourceField: "command.stdout",
        sourceHash: sha256("verified input"),
        value: "verified input",
        truncated: false,
      },
    ],
  };
}

function fakeCommandExecutor(outcome?: NodeExecutionOutcome): CommandExecutor & {
  execute: ReturnType<typeof vi.fn<CommandExecutor["execute"]>>;
} {
  return {
    execute: vi.fn<CommandExecutor["execute"]>(
      async () => outcome ?? { status: "succeeded", evidence: commandEvidence(0) },
    ),
  };
}

function fakeAgentExecutor(outcome?: NodeExecutionOutcome): AgentExecutor & {
  execute: ReturnType<typeof vi.fn<AgentExecutor["execute"]>>;
} {
  return {
    execute: vi.fn<AgentExecutor["execute"]>(
      async () => outcome ?? { status: "succeeded", evidence: agentEvidence("unused") },
    ),
  };
}

function commandEvidence(exitCode: number): CommandEvidence {
  const stdout = exitCode === 0 ? "ok" : "not ok";
  return {
    kind: "command",
    executable: "npm",
    args: ["test"],
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: sha256(stdout),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 7,
  };
}

function agentEvidence(text: string): AgentEvidence {
  return {
    kind: "agent",
    provider: "test",
    model: "deterministic",
    text,
    textHash: sha256(text),
    textTruncated: false,
    durationMs: 5,
    usage: {
      inputTokens: 4,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsdMicros: 23,
    },
    policyDecisions: [],
    effectReceipts: [],
  };
}

function acpAgentEvidence(text: string): AgentEvidence {
  const agentDigest = "a".repeat(64);
  const sessionIdHash = "b".repeat(64);
  const { usage: _legacyUsage, ...base } = agentEvidence(text);
  return {
    ...base,
    usageObservation: {
      modelTokens: { status: "complete", totalTokens: 21 },
      costUsd: { status: "unavailable" },
    },
    acp: {
      version: 1,
      executor: "local-acp-process-v1",
      agentName: "fixture",
      agentDigest,
      protocol: "acp-v1",
      compatibilityProfile: "prompt-only-v1",
      containmentProfile: "acp-prompt-only-v1",
      runtimeIdentity: "revalidated",
      credentialLease: "srt-host-scoped-sentinel",
      sessionIdHash,
      sessionBindingDigest: calculateAcpAgentSessionBindingDigest({
        runId: "run-1",
        workflowId: "workflow-1",
        nodeId: "review",
        attempt: 1,
        agentDigest,
        sessionIdHash,
      }),
      processContainment: "process-group",
      terminationStatus: "confirmed",
      sandbox: {
        backend: "anthropic-sandbox-runtime",
        backendVersion: "0.0.70",
        profile: "acp-prompt-only-v1",
        policyDigest: "c".repeat(64),
      },
      usageProvenance: {
        modelTokens: "prompt-response",
        costUsd: "declared-unavailable",
      },
      updateCount: 1,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function verdictJson(verdict: "accepted" | "rejected" | "inconclusive", reason: string): string {
  return JSON.stringify({ verdict, reason });
}
