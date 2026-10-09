import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { createFrozenVerificationAgentCommandAuthority } from "../../../src/application/frozen-issue-command.js";

import {
  calculateAgentCommandDigest,
  normalizeAgentCommandRequest,
} from "../../../src/domain/agent-command.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import {
  calculateWorkspaceAuthorityDigest,
  parseRunEvent,
  type RunEvent,
  reduceRunEvents,
} from "../../../src/domain/run/events.js";

describe("durable agent command replay", () => {
  it("replays a complete immutable catalog and binds its refusal limit into recovery identity", () => {
    const authority = createFrozenVerificationAgentCommandAuthority([commandRequest], {
      rejectionLimit: 3,
    });
    const events = preparedEvents();
    const state = reduceRunEvents([
      parseRunEvent({ ...events[0], agentCommandAuthority: authority }),
      events[1],
      events[2],
    ]);
    expect(state.agentCommandAuthority).toEqual(authority);
    expect(Object.isFrozen(state.agentCommandAuthority?.requests)).toBe(true);
    const differentLimit = createFrozenVerificationAgentCommandAuthority([commandRequest], {
      rejectionLimit: 5,
    });
    expect(
      calculateWorkspaceAuthorityDigest({ protectedPaths: [], agentCommandAuthority: authority }),
    ).not.toBe(
      calculateWorkspaceAuthorityDigest({
        protectedPaths: [],
        agentCommandAuthority: differentLimit,
      }),
    );
    expect(() =>
      parseRunEvent({
        ...events[0],
        agentCommandAuthority: {
          ...authority,
          requests: [{ ...commandRequest, timeoutMs: commandRequest.timeoutMs + 1 }],
        },
      }),
    ).toThrow(/catalog/i);
  });
  it("replays exact preparation and settlement and charges retained output once", () => {
    const state = reduceRunEvents([
      ...preparedEvents(),
      parseRunEvent({
        ...base(4),
        type: "node_agent_command_settled",
        nodeId: "implement",
        attempt: 1,
        commandId: "command-3",
        outcome: { status: "succeeded", evidence: commandEvidence("é", "🙂") },
      }),
    ]);

    expect(state.nodes.implement).toMatchObject({
      commandProtocol: "flow.agent-commands/v1",
      commands: [
        {
          commandId: "command-3",
          commandSequence: 1,
          request: commandRequest,
          operationDigest: commandDigest,
          settlement: {
            outcome: { status: "succeeded", evidence: commandEvidence("é", "🙂") },
            settledAt: "2026-08-08T10:00:04.000Z",
          },
        },
      ],
    });
    expect(state.resources.artifactBytes).toBe(6);
    expect(Object.isFrozen(state.nodes.implement?.commands)).toBe(true);
    expect(Object.isFrozen(state.nodes.implement?.commands[0]?.settlement)).toBe(true);
  });

  it("replays process-group evidence only for an exact frozen verification command", () => {
    const events = preparedEvents();
    const state = reduceRunEvents([
      parseRunEvent({
        ...events[0],
        agentCommandAuthority: {
          version: 1,
          kind: "frozen-verification",
          requestDigests: [commandDigest],
        },
      }),
      events[1],
      events[2],
      parseRunEvent({
        ...base(4),
        type: "node_agent_command_settled",
        nodeId: "implement",
        attempt: 1,
        commandId: "command-3",
        outcome: {
          status: "succeeded",
          evidence: {
            ...commandEvidence("ok", ""),
            processContainment: "process-group",
            selectionAuthority: "frozen-verification",
          },
        },
      }),
    ]);

    expect(state.agentCommandAuthority).toEqual({
      version: 1,
      kind: "frozen-verification",
      requestDigests: [commandDigest],
    });
  });

  it("rejects a prepared command outside durable frozen verification authority", () => {
    const events = preparedEvents();

    expect(() =>
      reduceRunEvents([
        parseRunEvent({
          ...events[0],
          agentCommandAuthority: {
            version: 1,
            kind: "frozen-verification",
            requestDigests: ["f".repeat(64)],
          },
        }),
        events[1],
        events[2],
      ]),
    ).toThrow(/frozen verification authority/i);
  });

  it("rejects process-group evidence without durable frozen verification authority", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "succeeded",
            evidence: {
              ...commandEvidence("ok", ""),
              processContainment: "process-group",
              selectionAuthority: "frozen-verification",
            },
          },
        }),
      ]),
    ).toThrow(/containment.*authority|authority.*containment/i);
  });

  it("rejects a prepared request whose operation digest was changed", () => {
    const events = preparedEvents();
    const prepared = events[2];

    expect(() =>
      reduceRunEvents([
        events[0],
        events[1],
        parseRunEvent({ ...prepared, operationDigest: "f".repeat(64) }),
      ]),
    ).toThrow(/command.*digest/i);
  });

  it.each([
    ["equality", "test", 4],
    ["bounded overshoot", "tests", 5],
  ])("derives artifact exhaustion at %s from command settlement", (_label, stdout, consumed) => {
    const events = preparedEvents();
    const state = reduceRunEvents([
      parseRunEvent({ ...events[0], budget: { maxArtifactBytes: 4 } }),
      events[1],
      events[2],
      parseRunEvent({
        ...base(4),
        type: "node_agent_command_settled",
        nodeId: "implement",
        attempt: 1,
        commandId: "command-3",
        outcome: { status: "succeeded", evidence: commandEvidence(stdout, "") },
      }),
    ]);

    expect(state.resources.artifactBytes).toBe(consumed);
    expect(state.budget).toMatchObject({
      remaining: { artifactBytes: 0 },
      exhausted: [{ dimension: "artifactBytes", limit: 4, consumed }],
    });
  });

  it("rejects settlement evidence for a different command", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "succeeded",
            evidence: { ...commandEvidence("ok", ""), executable: "pnpm" },
          },
        }),
      ]),
    ).toThrow(/settlement.*request|evidence.*command/i);
  });

  it("rejects preparing another command while the preceding command remains unresolved", () => {
    expect(() => reduceRunEvents(twoPreparedEvents())).toThrow(
      /unresolved|settle.*before.*prepar/i,
    );
  });

  it.each([
    [
      "nonzero-exit failure with a zero exit",
      { code: "command_failed", sideEffectStatus: "uncertain" },
      commandEvidence("ok", ""),
    ],
    [
      "timeout failure without timeout evidence",
      { code: "command_timeout", sideEffectStatus: "uncertain" },
      commandEvidence("ok", ""),
    ],
    [
      "signal failure without a signal",
      { code: "command_signaled", sideEffectStatus: "uncertain" },
      commandEvidence("ok", ""),
    ],
    [
      "post-spawn evidence classified as side-effect free",
      { code: "command_failed", sideEffectStatus: "none" },
      { ...commandEvidence("", "failed"), exitCode: 1 },
    ],
    [
      "committed pre-spawn failure without evidence",
      { code: "command_sandbox_unavailable", sideEffectStatus: "committed" },
      null,
    ],
    [
      "uncertain spawn failure without evidence",
      { code: "command_spawn_failed", sideEffectStatus: "uncertain" },
      null,
    ],
    [
      "uncertain generic sandbox failure without evidence",
      { code: "command_sandbox_unavailable", sideEffectStatus: "uncertain" },
      null,
    ],
  ] as const)("rejects %s", (_label, failure, evidence) => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "failed",
            error: {
              code: failure.code,
              message: "contradictory command result",
              retryable: false,
              sideEffectStatus: failure.sideEffectStatus,
            },
            evidence,
          },
        }),
      ]),
    ).toThrow(/command.*failure|settlement.*evidence|side-effect/i);
  });

  it("accepts a side-effect-free timeout before process evidence exists", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "failed",
            error: {
              code: "command_timeout",
              message: "command exceeded timeout before process launch",
              retryable: false,
              sideEffectStatus: "none",
            },
            evidence: null,
          },
        }),
      ]),
    ).not.toThrow();
  });

  it.each([
    {
      code: "command_timeout",
      message: "command preparation did not settle before its cleanup bound",
    },
    {
      code: "command_aborted",
      message: "cancelled command preparation did not settle before its cleanup bound",
    },
    {
      code: "command_sandbox_cleanup_failed",
      message: "container absence is not proved",
    },
  ])("accepts evidence-free pre-spawn uncertainty for $code", ({ code, message }) => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "failed",
            error: {
              code,
              message,
              retryable: false,
              sideEffectStatus: "uncertain",
            },
            evidence: null,
          },
        }),
      ]),
    ).not.toThrow();
  });

  it("binds termination failure to an unconfirmed durable observation", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "failed",
            error: {
              code: "command_termination_failed",
              message: "containment could not be confirmed",
              retryable: false,
              sideEffectStatus: "uncertain",
            },
            evidence: {
              ...commandEvidence("", ""),
              timedOut: true,
              terminationStatus: "unconfirmed",
            },
          },
        }),
      ]),
    ).not.toThrow();

    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "failed",
            error: {
              code: "command_termination_failed",
              message: "forged containment result",
              retryable: false,
              sideEffectStatus: "uncertain",
            },
            evidence: {
              ...commandEvidence("", ""),
              terminationStatus: "confirmed",
            },
          },
        }),
      ]),
    ).toThrow(/termination|failure code|evidence/i);
  });

  it.each([
    {
      name: "timeout marked not required",
      timedOut: true,
      aborted: false,
      terminationStatus: "not-required" as const,
    },
    {
      name: "abort marked not required",
      timedOut: false,
      aborted: true,
      terminationStatus: "not-required" as const,
    },
    {
      name: "termination marked confirmed without timeout or abort",
      timedOut: false,
      aborted: false,
      terminationStatus: "confirmed" as const,
    },
    {
      name: "simultaneous timeout and abort",
      timedOut: true,
      aborted: true,
      terminationStatus: "confirmed" as const,
    },
  ])("rejects cleanup evidence with contradictory termination fact: $name", (contradiction) => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "failed",
            error: {
              code: "command_sandbox_cleanup_failed",
              message: "cleanup failed",
              retryable: false,
              sideEffectStatus: "uncertain",
            },
            evidence: {
              ...commandEvidence("", ""),
              timedOut: contradiction.timedOut,
              aborted: contradiction.aborted,
              terminationStatus: contradiction.terminationStatus,
            },
          },
        }),
      ]),
    ).toThrow(/termination|timeout|abort|settlement evidence/i);
  });

  it("rejects command evidence without sandbox provenance", () => {
    const evidence = commandEvidence("ok", "");
    const { sandbox: _sandbox, ...withoutSandbox } = evidence;

    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: { status: "succeeded", evidence: withoutSandbox },
        }),
      ]),
    ).toThrow(/expected object|sandbox.*provenance/i);
  });

  it("rejects agent command evidence with an unbound stdin digest", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "succeeded",
            evidence: { ...commandEvidence("ok", ""), stdinHash: "a".repeat(64) },
          },
        }),
      ]),
    ).toThrow(/standard input|stdin/i);
  });

  it("rejects tampered retained output when the full stream was truncated", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "succeeded",
            evidence: {
              ...commandEvidence("original retained prefix", ""),
              stdout: "tampered retained prefix",
              stdoutHash: "f".repeat(64),
              stdoutTruncated: true,
            },
          },
        }),
      ]),
    ).toThrow(/retained.*hash|integrity/i);
  });

  it("rejects a forged truncation flag when the retained stream is complete", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "succeeded",
            evidence: { ...commandEvidence("complete", ""), stdoutTruncated: true },
          },
        }),
      ]),
    ).toThrow(/truncation|full.*retained|integrity/i);
  });

  it("rejects a terminal outcome while a prepared command remains unresolved", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_failed",
          nodeId: "implement",
          attempt: 1,
          error: {
            code: "pi_agent_failed",
            message: "agent stopped",
            retryable: false,
            sideEffectStatus: "uncertain",
          },
          evidence: null,
        }),
      ]),
    ).toThrow(/unresolved.*command/i);
  });

  it("rejects terminal failure without authorization evidence after a settled command", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: { status: "succeeded", evidence: commandEvidence("ok", "") },
        }),
        parseRunEvent({
          ...base(5),
          type: "node_failed",
          nodeId: "implement",
          attempt: 1,
          error: {
            code: "pi_agent_failed",
            message: "agent stopped",
            retryable: false,
            sideEffectStatus: "committed",
          },
          evidence: null,
        }),
      ]),
    ).toThrow(/authorization evidence|agent evidence/i);
  });

  it("rejects terminal success after unconfirmed command termination", () => {
    const events = preparedEvents();
    const prepared = events[2];
    if (prepared?.type !== "node_agent_command_prepared") {
      throw new Error("expected prepared command fixture");
    }

    expect(() =>
      reduceRunEvents([
        ...events,
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "failed",
            error: {
              code: "command_termination_failed",
              message: "termination could not be confirmed",
              retryable: false,
              sideEffectStatus: "uncertain",
            },
            evidence: {
              ...commandEvidence("", ""),
              timedOut: true,
              terminationStatus: "unconfirmed",
            },
          },
        }),
        parseRunEvent({
          ...base(5),
          type: "node_succeeded",
          nodeId: "implement",
          attempt: 1,
          evidence: agentEvidence([prepared.decision]),
        }),
      ]),
    ).toThrow(/unconfirmed.*termination|cannot succeed/i);
  });

  it("rejects later command preparation after unconfirmed termination", () => {
    const events = preparedEvents();
    const secondPreparation = twoPreparedEvents()[3];
    if (secondPreparation.type !== "node_agent_command_prepared") {
      throw new Error("expected second prepared command fixture");
    }

    expect(() =>
      reduceRunEvents([
        ...events,
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: {
            status: "failed",
            error: {
              code: "command_termination_failed",
              message: "termination could not be confirmed",
              retryable: false,
              sideEffectStatus: "uncertain",
            },
            evidence: {
              ...commandEvidence("", ""),
              timedOut: true,
              terminationStatus: "unconfirmed",
            },
          },
        }),
        parseRunEvent({
          ...secondPreparation,
          ...base(5),
          commandId: "command-5",
        }),
      ]),
    ).toThrow(/unconfirmed termination|later command.*forbidden/i);
  });

  it("requires a distinct terminal authorization for each identical command", () => {
    const events = preparedEvents();
    const firstPrepared = events[2];
    if (firstPrepared?.type !== "node_agent_command_prepared") {
      throw new Error("expected prepared command fixture");
    }
    const terminalEvidence = agentEvidence([firstPrepared.decision]);

    expect(() =>
      reduceRunEvents([
        ...events,
        parseRunEvent({
          ...base(4),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-3",
          outcome: { status: "succeeded", evidence: commandEvidence("one", "") },
        }),
        parseRunEvent({
          ...base(5),
          type: "node_agent_command_prepared",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-5",
          commandSequence: 2,
          request: commandRequest,
          operationDigest: commandDigest,
          decision: firstPrepared.decision,
        }),
        parseRunEvent({
          ...base(6),
          type: "node_agent_command_settled",
          nodeId: "implement",
          attempt: 1,
          commandId: "command-5",
          outcome: { status: "succeeded", evidence: commandEvidence("two", "") },
        }),
        parseRunEvent({
          ...base(7),
          type: "node_succeeded",
          nodeId: "implement",
          attempt: 1,
          evidence: terminalEvidence,
        }),
      ]),
    ).toThrow(/distinct|unused|authorization/i);
  });

  it("rejects command events without the declared command protocol", () => {
    const events = preparedEvents();
    const started = events[1];

    expect(() =>
      reduceRunEvents([
        events[0],
        parseRunEvent({ ...started, commandProtocol: undefined }),
        events[2],
      ]),
    ).toThrow(/command protocol/i);
  });
});

const commandRequest = normalizeAgentCommandRequest({
  executable: "npm",
  args: ["test"],
  timeoutMs: 10_000,
});
const commandDigest = calculateAgentCommandDigest(commandRequest);

function preparedEvents(): readonly [RunEvent, RunEvent, RunEvent] {
  const decision = new PolicyBroker(
    { runId: "run-1", workflowId: "agent-exec", nodeId: "implement", attempt: 1 },
    ["process.execute"],
  ).authorize({
    action: "process.execute",
    target: commandRequest.executable,
    boundary: "inside",
    operationDigest: commandDigest,
  });
  return [
    parseRunEvent({
      ...base(1),
      type: "run_started",
      nodeIds: ["implement"],
      workflowApiVersion: "flow.synapti.ai/v1alpha1",
      workflowDigest: "a".repeat(64),
    }),
    parseRunEvent({
      ...base(2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      commandProtocol: "flow.agent-commands/v1",
    }),
    parseRunEvent({
      ...base(3),
      type: "node_agent_command_prepared",
      nodeId: "implement",
      attempt: 1,
      commandId: "command-3",
      commandSequence: 1,
      request: commandRequest,
      operationDigest: commandDigest,
      decision,
    }),
  ];
}

function twoPreparedEvents(): readonly [RunEvent, RunEvent, RunEvent, RunEvent] {
  const broker = new PolicyBroker(
    { runId: "run-1", workflowId: "agent-exec", nodeId: "implement", attempt: 1 },
    ["process.execute"],
  );
  const firstDecision = broker.authorize({
    action: "process.execute",
    target: commandRequest.executable,
    boundary: "inside",
    operationDigest: commandDigest,
  });
  const secondDecision = broker.authorize({
    action: "process.execute",
    target: commandRequest.executable,
    boundary: "inside",
    operationDigest: commandDigest,
  });
  const [started, nodeStarted] = preparedEvents();
  return [
    started,
    nodeStarted,
    parseRunEvent({
      ...base(3),
      type: "node_agent_command_prepared",
      nodeId: "implement",
      attempt: 1,
      commandId: "command-3",
      commandSequence: 1,
      request: commandRequest,
      operationDigest: commandDigest,
      decision: firstDecision,
    }),
    parseRunEvent({
      ...base(4),
      type: "node_agent_command_prepared",
      nodeId: "implement",
      attempt: 1,
      commandId: "command-4",
      commandSequence: 2,
      request: commandRequest,
      operationDigest: commandDigest,
      decision: secondDecision,
    }),
  ];
}

function commandEvidence(stdout: string, stderr: string) {
  return {
    kind: "command" as const,
    executable: commandRequest.executable,
    args: commandRequest.args,
    exitCode: 0,
    signal: null,
    stdout,
    stderr,
    stdoutHash: sha256(stdout),
    stderrHash: sha256(stderr),
    stdoutRetainedHash: sha256(stdout),
    stderrRetainedHash: sha256(stderr),
    stdoutRetainedBytes: Buffer.byteLength(stdout, "utf8"),
    stderrRetainedBytes: Buffer.byteLength(stderr, "utf8"),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    durationMs: 5,
    processContainment: "linux-pid-namespace" as const,
    terminationStatus: "not-required" as const,
    sandbox: {
      backend: "anthropic-sandbox-runtime",
      backendVersion: "test",
      profile: "workspace-write-network-deny-v1",
      policyDigest: "b".repeat(64),
    },
  };
}

function agentEvidence(policyDecisions: readonly unknown[]) {
  return {
    kind: "agent" as const,
    provider: "test-provider",
    model: "test-model",
    text: "done",
    textHash: sha256("done"),
    textTruncated: false,
    durationMs: 10,
    policyDecisions,
    effectReceipts: [],
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-08T10:00:0${sequence}.000Z`,
    runId: "run-1",
    workflowId: "agent-exec",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
