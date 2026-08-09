import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import {
  calculateChildRunId,
  parseRunEvent,
  type RunEvent,
  RunReplayError,
  type RunStartedEvent,
  reduceRunEvents,
} from "../../../src/domain/run/events.js";

describe("reduceRunEvents", () => {
  it("reconstructs a successful run from authoritative events", () => {
    const state = reduceRunEvents(successfulEvents());

    expect(state).toMatchObject({
      runId: "run-1",
      workflowId: "verify-foundation",
      status: "succeeded",
      lastSequence: 6,
    });
    expect(state.nodes["node-version"]).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(state.nodes.typecheck).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.nodes)).toBe(true);
  });

  it("preserves ordered policy decisions in replayed agent evidence", () => {
    const policy = new PolicyBroker(
      {
        runId: "run-1",
        workflowId: "verify-foundation",
        nodeId: "node-version",
        attempt: 1,
      },
      ["filesystem.read"],
    );
    policy.authorize({
      action: "filesystem.read",
      target: "/workspace/package.json",
      boundary: "inside",
    });
    const events: RunEvent[] = [
      runStarted(),
      { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "node-version",
        attempt: 1,
        evidence: { ...agentEvidence("inspected"), policyDecisions: policy.close() },
      },
      { ...base(4), type: "node_started", nodeId: "typecheck", attempt: 1 },
      {
        ...base(5),
        type: "node_succeeded",
        nodeId: "typecheck",
        attempt: 1,
        evidence: commandEvidence(0),
      },
      { ...base(6), type: "run_succeeded" },
    ];

    const state = reduceRunEvents(structuredClone(events));

    expect(state.nodes["node-version"]?.evidence).toMatchObject({
      kind: "agent",
      policyDecisions: [
        {
          sequence: 1,
          action: "filesystem.read",
          outcome: "allowed",
          requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
  });

  it("defaults old agent evidence to an empty policy decision list", () => {
    const parsed = parseRunEvent({
      ...base(3),
      type: "node_succeeded",
      nodeId: "node-version",
      attempt: 1,
      evidence: {
        kind: "agent",
        provider: "test",
        model: "deterministic",
        text: "legacy",
        textHash: createHash("sha256").update("legacy").digest("hex"),
        textTruncated: false,
        durationMs: 1,
      },
    });

    expect(
      parsed.type === "node_succeeded" && parsed.evidence.kind === "agent"
        ? {
            policyDecisions: parsed.evidence.policyDecisions,
            effectReceipts: parsed.evidence.effectReceipts,
          }
        : undefined,
    ).toEqual({ policyDecisions: [], effectReceipts: [] });
  });

  it("preserves a committed edit receipt bound to its allowed policy decision", () => {
    const operationDigest = "a".repeat(64);
    const policy = editPolicy(operationDigest);
    const events: RunEvent[] = [
      runStarted(),
      { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "node-version",
        attempt: 1,
        evidence: {
          ...agentEvidence("edited"),
          policyDecisions: policy.close(),
          effectReceipts: [editReceipt(operationDigest)],
        },
      },
    ];

    const state = reduceRunEvents(structuredClone(events));

    expect(state.nodes["node-version"]?.evidence).toMatchObject({
      kind: "agent",
      effectReceipts: [
        {
          kind: "filesystem.edit",
          operationDigest,
          outcome: "committed",
          beforeSha256: "b".repeat(64),
          afterSha256: "c".repeat(64),
        },
      ],
    });
  });

  it("rejects an edit receipt that is not bound to an allowed policy request", () => {
    const operationDigest = "a".repeat(64);
    const policy = editPolicy(operationDigest);

    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "node-version",
          attempt: 1,
          evidence: {
            ...agentEvidence("edited"),
            policyDecisions: policy.close(),
            effectReceipts: [editReceipt("d".repeat(64))],
          },
        },
      ]),
    ).toThrowError(/effect receipt.*allowed policy decision/i);
  });

  it("rejects multiple edit receipts that reuse one allowed policy decision", () => {
    const operationDigest = "a".repeat(64);
    const policy = editPolicy(operationDigest);

    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "node-version",
          attempt: 1,
          evidence: {
            ...agentEvidence("edited"),
            policyDecisions: policy.close(),
            effectReceipts: [
              editReceipt(operationDigest),
              { ...editReceipt(operationDigest), sequence: 2 },
            ],
          },
        },
      ]),
    ).toThrowError(/effect receipt.*unused allowed policy decision/i);
  });

  it("rejects an uncertain edit receipt on a successful node", () => {
    const operationDigest = "a".repeat(64);
    const policy = editPolicy(operationDigest);

    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "node-version",
          attempt: 1,
          evidence: {
            ...agentEvidence("edited"),
            policyDecisions: policy.close(),
            effectReceipts: [{ ...editReceipt(operationDigest), outcome: "uncertain" }],
          },
        },
      ]),
    ).toThrowError(/successful agent evidence.*uncertain/i);
  });

  it.each([
    ["committed", "none", /committed effect receipt.*side-effect-free/i],
    ["uncertain", "committed", /uncertain effect receipt requires uncertain/i],
  ] as const)(
    "rejects %s edit evidence with incompatible %s failure status",
    (receiptOutcome, sideEffectStatus, expectedError) => {
      const operationDigest = "a".repeat(64);
      const policy = editPolicy(operationDigest);

      expect(() =>
        reduceRunEvents([
          runStarted(),
          { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
          {
            ...base(3),
            type: "node_failed",
            nodeId: "node-version",
            attempt: 1,
            error: {
              code: "pi_agent_failed",
              message: "provider failed",
              retryable: false,
              sideEffectStatus,
            },
            evidence: {
              ...agentEvidence(""),
              policyDecisions: policy.close(),
              effectReceipts: [{ ...editReceipt(operationDigest), outcome: receiptOutcome }],
            },
          },
        ]),
      ).toThrowError(expectedError);
    },
  );

  it("rejects a committed failure status without an effect receipt", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        {
          ...base(3),
          type: "node_failed",
          nodeId: "node-version",
          attempt: 1,
          error: {
            code: "pi_agent_failed",
            message: "provider failed",
            retryable: false,
            sideEffectStatus: "committed",
          },
          evidence: agentEvidence(""),
        },
      ]),
    ).toThrowError(/committed side-effect status requires an effect receipt/i);
  });

  it("preserves backend-neutral sandbox evidence for future adapters", () => {
    const parsed = parseRunEvent({
      ...base(3),
      type: "node_succeeded",
      nodeId: "node-version",
      attempt: 1,
      evidence: {
        ...commandEvidence(0),
        sandbox: {
          backend: "gondolin",
          backendVersion: "1.2.3",
          profile: "workspace-write-network-deny-v1",
          policyDigest: "d".repeat(64),
        },
      },
    });

    expect(parsed.type === "node_succeeded" ? parsed.evidence : undefined).toMatchObject({
      sandbox: { backend: "gondolin", backendVersion: "1.2.3" },
    });
  });

  it("rejects a tampered policy request digest during replay", () => {
    const policy = new PolicyBroker(
      {
        runId: "run-1",
        workflowId: "verify-foundation",
        nodeId: "node-version",
        attempt: 1,
      },
      ["filesystem.read"],
    );
    policy.authorize({
      action: "filesystem.read",
      target: "/workspace/package.json",
      boundary: "inside",
    });
    const decision = policy.close()[0];
    if (decision === undefined) {
      throw new Error("policy decision was not recorded");
    }

    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "node-version",
          attempt: 1,
          evidence: {
            ...agentEvidence("inspected"),
            policyDecisions: [{ ...decision, requestDigest: "f".repeat(64) }],
          },
        },
      ]),
    ).toThrowError(/policy decision request digest is invalid/i);
  });

  it("reconstructs accepted criterion decisions from deterministic verifier evidence", () => {
    const state = reduceRunEvents(successfulEvents(runStartedWithGoal("typecheck")));

    expect(state.goal).toMatchObject({
      id: "verified-change",
      status: "accepted",
      criteria: {
        "verification-passes": {
          status: "accepted",
          decision: {
            runId: "run-1",
            nodeId: "typecheck",
            attempt: 1,
            evidenceAvailable: true,
          },
        },
      },
    });
    expect(Object.isFrozen(state.goal)).toBe(true);
    expect(Object.isFrozen(state.goal?.criteria)).toBe(true);
  });

  it("classifies normal verifier failure as rejected and unexecuted criteria as missing", () => {
    const state = reduceRunEvents([
      runStartedWithGoal("node-version", {
        id: "later-check",
        description: "The later check passes.",
        verifierNodeId: "typecheck",
      }),
      { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
      {
        ...base(3),
        type: "node_failed",
        nodeId: "node-version",
        attempt: 1,
        error: {
          code: "command_failed",
          message: "exit 1",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: commandEvidence(1),
      },
      { ...base(4), type: "run_failed", failedNodeId: "node-version", reason: "exit 1" },
    ]);

    expect(state.goal).toMatchObject({
      status: "not_accepted",
      criteria: {
        "verification-passes": { status: "rejected", decision: { evidenceAvailable: true } },
        "later-check": { status: "missing", decision: null },
      },
    });
  });

  it("classifies a timed-out verifier as inconclusive", () => {
    const timedOutEvidence = {
      ...commandEvidence(1),
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
    };
    const state = reduceRunEvents([
      runStartedWithGoal("node-version"),
      { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
      {
        ...base(3),
        type: "node_failed",
        nodeId: "node-version",
        attempt: 1,
        error: {
          code: "command_timeout",
          message: "timed out",
          retryable: false,
          sideEffectStatus: "uncertain",
        },
        evidence: timedOutEvidence,
      },
      {
        ...base(4),
        type: "run_failed",
        failedNodeId: "node-version",
        reason: "timed out",
      },
    ]);

    expect(state.goal?.criteria["verification-passes"]).toMatchObject({
      status: "inconclusive",
      decision: { evidenceAvailable: true },
    });
  });

  it("does not allow successful agent prose to satisfy a deterministic criterion", () => {
    const events: RunEvent[] = [
      runStartedWithGoal("node-version"),
      { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "node-version",
        attempt: 1,
        evidence: agentEvidence("Everything is complete."),
      },
      { ...base(4), type: "node_started", nodeId: "typecheck", attempt: 1 },
      {
        ...base(5),
        type: "node_succeeded",
        nodeId: "typecheck",
        attempt: 1,
        evidence: commandEvidence(0),
      },
      { ...base(6), type: "run_succeeded" },
    ];

    expect(() => reduceRunEvents(events)).toThrowError(/criteria are not accepted/i);
  });

  it("replays goal completion to the same immutable decision", () => {
    const events = successfulEvents(runStartedWithGoal("typecheck"));

    expect(reduceRunEvents(events)).toEqual(reduceRunEvents(events));
  });

  it("marks an unexecuted verifier missing when the run is cancelled", () => {
    const state = reduceRunEvents([
      runStartedWithGoal("typecheck"),
      { ...base(2), type: "run_cancelled", reason: "operator cancelled" },
    ]);

    expect(state.goal).toMatchObject({
      status: "not_accepted",
      criteria: { "verification-passes": { status: "missing", decision: null } },
    });
  });

  it("rejects sequence gaps", () => {
    const events = successfulEvents().map((event) => ({ ...event })) as RunEvent[];
    const third = events[2];
    if (third !== undefined) {
      events[2] = { ...third, sequence: 4 };
    }

    expect(() => reduceRunEvents(events)).toThrowError(RunReplayError);
    expect(() => reduceRunEvents(events)).toThrowError(/expected sequence 3/i);
  });

  it("rejects node completion without a matching start", () => {
    const events: RunEvent[] = [
      runStarted(),
      {
        ...base(2),
        type: "node_succeeded",
        nodeId: "node-version",
        attempt: 1,
        evidence: commandEvidence(0),
      },
    ];

    expect(() => reduceRunEvents(events)).toThrowError(/must be running/i);
  });

  it("rejects run success while nodes remain incomplete", () => {
    const events: RunEvent[] = [
      runStarted(),
      { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "node-version",
        attempt: 1,
        evidence: commandEvidence(0),
      },
      { ...base(4), type: "run_succeeded" },
    ];

    expect(() => reduceRunEvents(events)).toThrowError(/not every node succeeded/i);
  });

  it("reconstructs cancellation between node attempts", () => {
    const state = reduceRunEvents([
      runStarted(),
      { ...base(2), type: "run_cancelled", reason: "operator cancelled" },
    ]);

    expect(state).toMatchObject({
      status: "cancelled",
      failureReason: "operator cancelled",
      failedNodeId: null,
      finishedAt: base(2).at,
    });
  });

  it("records a recovery boundary without changing committed node outcomes", () => {
    const state = reduceRunEvents([
      runStarted(),
      { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "node-version",
        attempt: 1,
        evidence: commandEvidence(0),
      },
      { ...base(4), type: "run_resumed" },
    ]);

    expect(state).toMatchObject({ status: "running", lastSequence: 4 });
    expect(state.nodes["node-version"]).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(state.nodes.typecheck).toMatchObject({ status: "pending", attempt: 0 });
  });

  it("records a verified child workspace relocation at a recovery boundary", () => {
    const parentRunId = "parent-relocation";
    const childRunId = calculateChildRunId(parentRunId, "delegate", 1);
    const started = {
      ...runStarted(),
      runId: childRunId,
      executionCwd: "/old/workspace",
      executionWorkspace: {
        backend: "reflink-copy-v1" as const,
        snapshotDigest: "a".repeat(64),
        parentRunId,
        parentNodeId: "delegate",
        parentAttempt: 1,
      },
    };
    const resumed = {
      ...base(2),
      runId: childRunId,
      type: "run_resumed" as const,
      workspaceRelocation: {
        fromCwd: "/old/workspace",
        toCwd: "/private/workspace",
      },
    };

    expect(reduceRunEvents([started, resumed])).toMatchObject({
      executionCwd: "/private/workspace",
      executionWorkspace: { parentRunId },
    });
  });

  it("rejects a workspace relocation for a root run", () => {
    expect(() =>
      reduceRunEvents([
        { ...runStarted(), executionCwd: "/old/workspace" },
        {
          ...base(2),
          type: "run_resumed",
          workspaceRelocation: {
            fromCwd: "/old/workspace",
            toCwd: "/private/workspace",
          },
        },
      ]),
    ).toThrow(/durable child execution context/i);
  });

  it("rejects recovery while a node attempt remains open", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        { ...base(3), type: "run_resumed" },
      ]),
    ).toThrowError(/node "node-version" attempt 1 remains running/i);
  });

  it("rejects cancellation while a node remains running", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        { ...base(3), type: "run_cancelled", reason: "operator cancelled" },
      ]),
    ).toThrowError(/node remains running/i);
  });

  it("reconstructs an attributable cancellation after the active node settles", () => {
    const state = reduceRunEvents([
      runStarted(),
      { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
      {
        ...base(3),
        type: "node_failed",
        nodeId: "node-version",
        attempt: 1,
        error: {
          code: "command_aborted",
          message: "operator cancelled",
          retryable: false,
          sideEffectStatus: "uncertain",
        },
        evidence: commandEvidence(1),
      },
      {
        ...base(4),
        type: "run_cancelled",
        reason: "operator cancelled",
        cancelledNodeId: "node-version",
        actor: "operator:test",
        requestId: "a4f43869-0aca-4db0-851a-c1e6bca34c7e",
      },
    ]);

    expect(state).toMatchObject({
      status: "cancelled",
      failedNodeId: "node-version",
      failureReason: "operator cancelled",
    });
  });

  it("rejects cancellation that does not identify its settled failed node", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        {
          ...base(3),
          type: "node_failed",
          nodeId: "node-version",
          attempt: 1,
          error: {
            code: "command_aborted",
            message: "operator cancelled",
            retryable: false,
            sideEffectStatus: "uncertain",
          },
          evidence: commandEvidence(1),
        },
        { ...base(4), type: "run_cancelled", reason: "operator cancelled" },
      ]),
    ).toThrowError(/cancelled node/i);
  });

  it("rejects overlapping node attempts in a sequential run", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        { ...base(3), type: "node_started", nodeId: "typecheck", attempt: 1 },
      ]),
    ).toThrowError(/one node may be running/i);
  });

  it("rejects semantically impossible successful command evidence", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "node-version",
          attempt: 1,
          evidence: commandEvidence(1),
        },
      ]),
    ).toThrowError(/successful command evidence/i);
  });

  it("rejects successful evidence whose untruncated hash is false", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "node-version",
          attempt: 1,
          evidence: { ...commandEvidence(0), stdoutHash: "f".repeat(64) },
        },
      ]),
    ).toThrowError(/stdout hash is invalid/i);
  });

  it("rejects truncated agent evidence as success", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "node-version",
          attempt: 1,
          evidence: {
            kind: "agent",
            provider: "test",
            model: "deterministic",
            text: "partial",
            textHash: createHash("sha256").update("complete output").digest("hex"),
            textTruncated: true,
            durationMs: 1,
            policyDecisions: [],
            effectReceipts: [],
          },
        },
      ]),
    ).toThrowError(/agent evidence must not be truncated/i);
  });

  it("rejects false untruncated hashes on failed-node evidence", () => {
    expect(() =>
      reduceRunEvents([
        runStarted(),
        { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
        {
          ...base(3),
          type: "node_failed",
          nodeId: "node-version",
          attempt: 1,
          error: {
            code: "command_failed",
            message: "exit 1",
            retryable: false,
            sideEffectStatus: "uncertain",
          },
          evidence: { ...commandEvidence(1), stderrHash: "e".repeat(64) },
        },
      ]),
    ).toThrowError(/stderr hash is invalid/i);
  });
});

function successfulEvents(started: RunEvent = runStarted()): RunEvent[] {
  return [
    started,
    { ...base(2), type: "node_started", nodeId: "node-version", attempt: 1 },
    {
      ...base(3),
      type: "node_succeeded",
      nodeId: "node-version",
      attempt: 1,
      evidence: commandEvidence(0),
    },
    { ...base(4), type: "node_started", nodeId: "typecheck", attempt: 1 },
    {
      ...base(5),
      type: "node_succeeded",
      nodeId: "typecheck",
      attempt: 1,
      evidence: commandEvidence(0),
    },
    { ...base(6), type: "run_succeeded" },
  ];
}

function runStartedWithGoal(
  verifierNodeId: string,
  additionalCriterion?: {
    readonly id: string;
    readonly description: string;
    readonly verifierNodeId: string;
  },
): RunStartedEvent {
  return {
    ...runStarted(),
    goal: {
      apiVersion: "flow.synapti.ai/v1alpha1",
      id: "verified-change",
      outcome: "The change is accepted.",
      criteria: [
        {
          id: "verification-passes",
          description: "Verification passes.",
          verifierNodeId,
        },
        ...(additionalCriterion === undefined ? [] : [additionalCriterion]),
      ],
    },
  };
}

function runStarted(): RunStartedEvent {
  return {
    ...base(1),
    type: "run_started",
    nodeIds: ["node-version", "typecheck"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "c".repeat(64),
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-06T15:00:0${sequence}.000Z`,
    runId: "run-1",
    workflowId: "verify-foundation",
  };
}

function commandEvidence(exitCode: number) {
  return {
    kind: "command" as const,
    executable: "node",
    args: ["--version"],
    exitCode,
    signal: null,
    stdout: "v22.19.0\n",
    stderr: "",
    stdoutHash: createHash("sha256").update("v22.19.0\n").digest("hex"),
    stderrHash: createHash("sha256").update("").digest("hex"),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 20,
  };
}

function agentEvidence(text: string) {
  return {
    kind: "agent" as const,
    provider: "test",
    model: "deterministic",
    text,
    textHash: createHash("sha256").update(text).digest("hex"),
    textTruncated: false,
    durationMs: 1,
    policyDecisions: [],
    effectReceipts: [],
  };
}

function editPolicy(operationDigest: string): PolicyBroker {
  const policy = new PolicyBroker(
    {
      runId: "run-1",
      workflowId: "verify-foundation",
      nodeId: "node-version",
      attempt: 1,
    },
    ["filesystem.write"],
  );
  policy.authorize({
    action: "filesystem.write",
    target: "/workspace/source.ts",
    boundary: "inside",
    operationDigest,
  });
  return policy;
}

function editReceipt(operationDigest: string) {
  return {
    version: 1 as const,
    sequence: 1,
    runId: "run-1",
    workflowId: "verify-foundation",
    nodeId: "node-version",
    attempt: 1,
    kind: "filesystem.edit" as const,
    target: "/workspace/source.ts",
    operationDigest,
    beforeSha256: "b".repeat(64),
    afterSha256: "c".repeat(64),
    outcome: "committed" as const,
  };
}
