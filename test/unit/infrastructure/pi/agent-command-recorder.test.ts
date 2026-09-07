import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../../../../src/application/artifact-store.js";
import type {
  AgentCommandExecutor,
  NodeAgentCommandJournal,
  NodeExecutionContext,
} from "../../../../src/application/ports.js";
import {
  calculateAgentCommandDigest,
  normalizeAgentCommandRequest,
} from "../../../../src/domain/agent-command.js";
import { PolicyBroker } from "../../../../src/domain/policy/broker.js";
import type { AgentCommandSettlementOutcome } from "../../../../src/domain/run/events.js";
import {
  AgentCommandAuditLimitError,
  AgentCommandRecorder,
} from "../../../../src/infrastructure/pi/agent-command-recorder.js";

const context: NodeExecutionContext = {
  runId: "run-1",
  workflowId: "agent-exec",
  attempt: 1,
  cwd: process.cwd(),
  protectedPaths: [],
};
const request = normalizeAgentCommandRequest({ executable: "npm", args: ["test"] });
const outcome: AgentCommandSettlementOutcome = {
  status: "failed",
  error: {
    code: "command_failed",
    message: "command exited with code 1",
    retryable: false,
    sideEffectStatus: "uncertain",
  },
  evidence: {
    kind: "command",
    executable: "npm",
    args: ["test"],
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "failed",
    stdoutHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    stderrHash: "f".repeat(64),
    stdoutRetainedHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    stderrRetainedHash: createHash("sha256").update("failed").digest("hex"),
    stdoutRetainedBytes: 0,
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

describe("AgentCommandRecorder", () => {
  it("persists preparation before execution and settlement afterward", async () => {
    const calls: string[] = [];
    const journal: NodeAgentCommandJournal = {
      prepare: async () => {
        calls.push("prepare");
        return {
          commandId: "command-3",
          commandSequence: 1,
          settle: async (settled) => {
            calls.push(`settle:${settled.status}`);
            return { artifactBudgetExhausted: false };
          },
        };
      },
    };
    const executor: AgentCommandExecutor = {
      executeAgentCommand: async () => {
        calls.push("execute");
        return outcome;
      },
    };
    const recorder = new AgentCommandRecorder(executor, journal, context);

    const result = await recorder.execute(request, commandDecision());

    expect(result).toEqual(outcome);
    if (result.status !== "failed") {
      throw new Error("expected failed command outcome");
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.error)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence?.args)).toBe(true);
    expect(Object.isFrozen(result.evidence?.sandbox)).toBe(true);
    expect(calls).toEqual(["prepare", "execute", "settle:failed"]);
    expect(recorder.sideEffectStatus()).toBe("uncertain");
    expect(recorder.snapshot()).toEqual([outcome]);
  });

  it("forwards the active tool cancellation signal to the shared executor", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const journal: NodeAgentCommandJournal = {
      prepare: async () => ({
        commandId: "command-3",
        commandSequence: 1,
        settle: async () => ({ artifactBudgetExhausted: false }),
      }),
    };
    const executor: AgentCommandExecutor = {
      executeAgentCommand: async (_request, executionContext) => {
        observedSignal = executionContext.signal;
        return outcome;
      },
    };
    const recorder = new AgentCommandRecorder(executor, journal, context);

    await recorder.execute(request, commandDecision(), controller.signal);

    expect(observedSignal).toBe(controller.signal);
  });

  it("binds the durable command identity into the artifact producer before execution", async () => {
    const artifactStore = Object.freeze({}) as ArtifactStore;
    let observedContext: NodeExecutionContext | undefined;
    const journal: NodeAgentCommandJournal = {
      prepare: async () => ({
        commandId: "command-3",
        commandSequence: 7,
        settle: async () => ({ artifactBudgetExhausted: false }),
      }),
    };
    const executor: AgentCommandExecutor = {
      executeAgentCommand: async (_request, executionContext) => {
        observedContext = executionContext;
        return outcome;
      },
    };
    const recorder = new AgentCommandRecorder(executor, journal, {
      ...context,
      nodeId: "implement",
      artifactStore,
    });

    await recorder.execute(request, commandDecision());

    expect(observedContext?.artifactStore).toBe(artifactStore);
    expect(observedContext?.agentCommandArtifactProducer).toEqual({
      kind: "agent-command",
      runId: "run-1",
      workflowId: "agent-exec",
      nodeId: "implement",
      attempt: 1,
      commandId: "command-3",
      commandSequence: 7,
    });
    expect(Object.isFrozen(observedContext?.agentCommandArtifactProducer)).toBe(true);
  });

  it("fails closed before execution without a durable journal", async () => {
    let executions = 0;
    const executor: AgentCommandExecutor = {
      executeAgentCommand: async () => {
        executions += 1;
        return outcome;
      },
    };
    const recorder = new AgentCommandRecorder(executor, undefined, context);

    await expect(recorder.execute(request, commandDecision())).rejects.toThrow(/journal/i);
    expect(executions).toBe(0);
  });

  it("keeps an unsettled execution uncertain when settlement publication fails", async () => {
    const journal: NodeAgentCommandJournal = {
      prepare: async () => ({
        commandId: "command-3",
        commandSequence: 1,
        settle: async () => {
          throw new Error("ledger unavailable");
        },
      }),
    };
    const executor: AgentCommandExecutor = { executeAgentCommand: async () => outcome };
    const recorder = new AgentCommandRecorder(executor, journal, context);

    await expect(recorder.execute(request, commandDecision())).rejects.toThrow(
      "ledger unavailable",
    );
    expect(recorder.sideEffectStatus()).toBe("uncertain");
  });

  it("signals artifact exhaustion only after the outcome is durably settled", async () => {
    const calls: string[] = [];
    const journal: NodeAgentCommandJournal = {
      prepare: async () => ({
        commandId: "command-3",
        commandSequence: 1,
        settle: async () => {
          calls.push("settled");
          return { artifactBudgetExhausted: true };
        },
      }),
    };
    const executor: AgentCommandExecutor = {
      executeAgentCommand: async () => {
        calls.push("executed");
        return outcome;
      },
    };
    const recorder = new AgentCommandRecorder(executor, journal, context, () => {
      calls.push("exhausted");
    });

    await recorder.execute(request, commandDecision());

    expect(calls).toEqual(["executed", "settled", "exhausted"]);
  });

  it("uses the node policy budget as its command audit limit", async () => {
    const commandLimit = 33;
    let commandSequence = 0;
    const journal: NodeAgentCommandJournal = {
      prepare: async () => ({
        commandId: `command-${++commandSequence}`,
        commandSequence,
        settle: async () => ({ artifactBudgetExhausted: false }),
      }),
    };
    const executor: AgentCommandExecutor = { executeAgentCommand: async () => outcome };
    const recorder = new AgentCommandRecorder(
      executor,
      journal,
      context,
      undefined,
      undefined,
      commandLimit,
    );
    const broker = new PolicyBroker(
      { runId: "run-1", workflowId: "agent-exec", nodeId: "implement", attempt: 1 },
      ["process.execute"],
    );

    for (let index = 0; index < commandLimit; index += 1) {
      await expect(recorder.execute(request, commandDecisionFrom(broker))).resolves.toEqual(
        outcome,
      );
    }
    await expect(recorder.execute(request, commandDecisionFrom(broker))).rejects.toEqual(
      new AgentCommandAuditLimitError(commandLimit),
    );
  });
});

function commandDecision() {
  return commandDecisionFrom(
    new PolicyBroker(
      { runId: "run-1", workflowId: "agent-exec", nodeId: "implement", attempt: 1 },
      ["process.execute"],
    ),
  );
}

function commandDecisionFrom(broker: PolicyBroker) {
  return broker.authorize({
    action: "process.execute",
    target: "npm",
    boundary: "inside",
    operationDigest: calculateAgentCommandDigest(request),
  });
}
