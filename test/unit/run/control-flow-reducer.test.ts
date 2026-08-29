import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseRunEvent, type RunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";

describe("durable control-flow replay", () => {
  it("reconstructs condition, omission, join, and resource-neutral control state", () => {
    const state = reduceRunEvents(successfulConditionalEvents());

    expect(state).toMatchObject({ status: "succeeded", lastSequence: 13 });
    expect(state.nodes.route).toMatchObject({
      status: "succeeded",
      attempt: 1,
      evidence: null,
      control: {
        kind: "condition",
        sourceNodeId: "classify",
        sourceAttempt: 1,
        sourceField: "command.stdout",
        sourceHash: sha256("needs-work\n"),
        selectedCase: "needs-work",
      },
    });
    expect(state.nodes["inspect-clean"]).toMatchObject({
      status: "omitted",
      attempt: 0,
      evidence: null,
      omission: {
        reason: "condition_not_selected",
        conditionId: "route",
        selectedCase: "needs-work",
        expectedCase: "already-clean",
      },
    });
    expect(state.nodes.converge).toMatchObject({
      status: "succeeded",
      attempt: 1,
      control: {
        kind: "join",
        conditionId: "route",
        selectedCase: "needs-work",
        completedNodeId: "verify-change",
        omittedNodeIds: ["inspect-clean"],
      },
    });
    expect(state.resources).toMatchObject({ nodeStarts: 4, modelTokens: 0 });
    expect(Object.isFrozen(state.controlGraph)).toBe(true);
    expect(Object.isFrozen(state.nodes.route?.control)).toBe(true);
    expect(Object.isFrozen(state.nodes["inspect-clean"]?.omission)).toBe(true);
  });

  it("preserves and parses a strict bounded control graph at run start", () => {
    const parsed = parseRunEvent(controlRunStarted());

    expect(parsed.type === "run_started" ? parsed.controlGraph : undefined).toEqual(controlGraph());
    expect(() =>
      parseRunEvent({
        ...controlRunStarted(),
        controlGraph: { ...controlGraph(), bypass: true },
      }),
    ).toThrow();
  });

  it("rejects an oversized serialized control graph through the public event parser", () => {
    const { controlGraph, nodeIds } = oversizedControlGraph();

    expect(() =>
      parseRunEvent({
        ...base(1),
        type: "run_started",
        nodeIds,
        workflowApiVersion: "flow.synapti.ai/v1alpha1",
        workflowDigest: "d".repeat(64),
        controlGraph,
      }),
    ).toThrow(/serialized control graph.*524288/i);
  });

  it("reports the review-policy control graph limit through the public event parser", () => {
    const { controlGraph, nodeIds } = oversizedReviewControlGraph();

    expect(() =>
      parseRunEvent({
        ...base(1),
        type: "run_started",
        nodeIds,
        workflowApiVersion: "flow.synapti.ai/v1alpha1",
        workflowDigest: "d".repeat(64),
        controlGraph,
      }),
    ).toThrow(/serialized control graph.*1048576/i);
  });

  it("rejects a control graph whose ordered node projection differs from node ids", () => {
    const started = controlRunStarted();

    expect(() =>
      reduceRunEvents([
        {
          ...started,
          controlGraph: {
            nodes: started.controlGraph.nodes.slice(1),
          },
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/control graph.*node ids/i);
  });

  it("rejects a persisted join terminal that belongs to a different condition case", () => {
    const started = controlRunStarted();
    const graph = structuredClone(started.controlGraph);
    const join = graph.nodes.find((node) => node.nodeId === "converge");
    if (join?.type !== "join") {
      throw new Error("expected join graph node");
    }
    join.join.branches = [
      { case: "needs-work", nodeId: "inspect-clean" },
      { case: "already-clean", nodeId: "verify-change" },
    ];
    join.dependsOn = ["inspect-clean", "verify-change"];

    expect(() =>
      reduceRunEvents([{ ...started, controlGraph: graph }] as unknown as RunEvent[]),
    ).toThrowError(/branch.*case|membership/i);
  });

  it("rejects a persisted graph with a cross-case dependency", () => {
    const started = controlRunStarted();
    const graph = structuredClone(started.controlGraph);
    const terminal = graph.nodes.find((node) => node.nodeId === "verify-change");
    if (terminal?.type !== "command") {
      throw new Error("expected command graph node");
    }
    terminal.dependsOn = ["implement", "inspect-clean"];

    expect(() =>
      reduceRunEvents([{ ...started, controlGraph: graph }] as unknown as RunEvent[]),
    ).toThrowError(/cross.*case/i);
  });

  it("rejects a persisted join terminal that can bypass work in its case", () => {
    const started = controlRunStarted();
    const graph = structuredClone(started.controlGraph);
    graph.nodes.splice(5, 0, {
      nodeId: "audit-change",
      type: "command",
      dependsOn: ["route"],
      when: { conditionId: "route", case: "needs-work" },
    });

    expect(() =>
      reduceRunEvents([
        {
          ...started,
          nodeIds: [
            "classify",
            "route",
            "implement",
            "verify-change",
            "inspect-clean",
            "audit-change",
            "converge",
            "verify-final",
          ],
          controlGraph: graph,
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/does not wait|incomplete/i);
  });

  it("rejects a condition decision that does not match durable source evidence", () => {
    const events = throughClassifier();

    expect(() =>
      reduceRunEvents([
        ...events,
        { ...conditionEvaluated(4), selectedCase: "already-clean" },
      ] as unknown as RunEvent[]),
    ).toThrowError(/selected case.*durable source/i);
  });

  it.each([
    ["source attempt", { sourceAttempt: 2 }, /source attempt/i],
    ["source hash", { sourceHash: "f".repeat(64) }, /source hash/i],
    ["source field", { sourceField: "command.stderr" }, /source field/i],
  ])("rejects a condition decision with a forged %s", (_name, change, error) => {
    expect(() =>
      reduceRunEvents([
        ...throughClassifier(),
        { ...conditionEvaluated(4), ...change },
      ] as unknown as RunEvent[]),
    ).toThrowError(error);
  });

  it("rejects control events when the run did not persist a control graph", () => {
    const started = { ...controlRunStarted(), controlGraph: undefined };

    expect(() =>
      reduceRunEvents([started, conditionEvaluated(2)] as unknown as RunEvent[]),
    ).toThrowError(/control graph/i);
  });

  it("rejects omission when the guarded case was selected", () => {
    expect(() =>
      reduceRunEvents([
        ...throughCondition(),
        {
          ...base(5),
          type: "node_omitted",
          nodeId: "implement",
          reason: "condition_not_selected",
          conditionId: "route",
          selectedCase: "needs-work",
          expectedCase: "needs-work",
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/guard.*selected/i);
  });

  it("rejects dependency omission without an omitted declared dependency", () => {
    expect(() =>
      reduceRunEvents([
        ...throughCondition(),
        { ...base(5), type: "node_started", nodeId: "implement", attempt: 1 },
        {
          ...base(6),
          type: "node_succeeded",
          nodeId: "implement",
          attempt: 1,
          evidence: agentEvidence("implemented"),
        },
        {
          ...base(7),
          type: "node_omitted",
          nodeId: "verify-change",
          reason: "dependency_omitted",
          omittedDependencies: ["implement"],
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/omitted declared dependencies/i);
  });

  it("replays omission propagation only from the exact ordered dependency set", () => {
    const started = propagatedRunStarted();
    const events = [
      started,
      { ...base(2), type: "node_started", nodeId: "classify", attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "classify",
        attempt: 1,
        evidence: commandEvidence("needs-work\n"),
      },
      conditionEvaluated(4),
      {
        ...base(5),
        type: "node_omitted",
        nodeId: "inspect-clean",
        reason: "condition_not_selected",
        conditionId: "route",
        selectedCase: "needs-work",
        expectedCase: "already-clean",
      },
      {
        ...base(6),
        type: "node_omitted",
        nodeId: "inspect-clean-child",
        reason: "dependency_omitted",
        omittedDependencies: ["inspect-clean"],
      },
    ] as unknown as RunEvent[];

    const state = reduceRunEvents(events);
    expect(state.nodes["inspect-clean-child"]).toMatchObject({
      status: "omitted",
      omission: { reason: "dependency_omitted", omittedDependencies: ["inspect-clean"] },
    });

    const forged = structuredClone(events) as unknown as Array<Record<string, unknown>>;
    const last = forged.at(-1);
    if (last !== undefined) {
      last.omittedDependencies = ["route"];
    }
    expect(() => reduceRunEvents(forged as unknown as RunEvent[])).toThrowError(
      /exact omitted dependencies/i,
    );
  });

  it.each(["route", "converge"])("rejects executor start for control node %s", (nodeId) => {
    expect(() =>
      reduceRunEvents([
        controlRunStarted(),
        { ...base(2), type: "node_started", nodeId, attempt: 1 },
      ] as unknown as RunEvent[]),
    ).toThrowError(/control node.*cannot start/i);
  });

  it("rejects a join before its selected branch terminal succeeds", () => {
    expect(() =>
      reduceRunEvents([
        ...throughCondition(),
        {
          ...base(5),
          type: "node_omitted",
          nodeId: "inspect-clean",
          reason: "condition_not_selected",
          conditionId: "route",
          selectedCase: "needs-work",
          expectedCase: "already-clean",
        },
        joinEvent(6),
      ] as unknown as RunEvent[]),
    ).toThrowError(/dependency.*not terminal/i);
  });

  it.each([
    ["selected case", { selectedCase: "already-clean" }, /selected case/i],
    ["completed terminal", { completedNodeId: "inspect-clean" }, /completed terminal/i],
    ["omitted terminals", { omittedNodeIds: ["verify-change"] }, /omitted terminals/i],
  ])("rejects a join with a forged %s", (_name, change, error) => {
    const settled = successfulConditionalEvents().slice(0, 9);

    expect(() =>
      reduceRunEvents([...settled, { ...joinEvent(10), ...change }] as unknown as RunEvent[]),
    ).toThrowError(error);
  });

  it("records a typed side-effect-free condition failure only for truncated source evidence", () => {
    const started = controlRunStarted();
    const truncated = [
      started,
      { ...base(2), type: "node_started", nodeId: "classify", attempt: 1 },
      {
        ...base(3),
        type: "node_succeeded",
        nodeId: "classify",
        attempt: 1,
        evidence: { ...commandEvidence("needs-work"), stdoutTruncated: true },
      },
      controlFailure(4),
    ] as unknown as RunEvent[];

    const state = reduceRunEvents(truncated);
    expect(state.nodes.route).toMatchObject({
      status: "failed",
      attempt: 1,
      error: { code: "condition_source_truncated", sideEffectStatus: "none" },
    });

    expect(() =>
      reduceRunEvents([...throughClassifier(), controlFailure(4)] as unknown as RunEvent[]),
    ).toThrowError(/source evidence is complete/i);
  });

  it("rejects run success while a control node remains pending", () => {
    expect(() =>
      reduceRunEvents([
        ...throughClassifier(),
        { ...base(4), type: "run_succeeded" },
      ] as unknown as RunEvent[]),
    ).toThrowError(/not every node.*succeeded or was omitted/i);
  });

  it("rejects malformed control events through the public event parser", () => {
    expect(() =>
      parseRunEvent({
        ...conditionEvaluated(4),
        sourceHash: "not-a-sha",
      }),
    ).toThrow();
  });
});

function successfulConditionalEvents(): RunEvent[] {
  return [
    controlRunStarted(),
    { ...base(2), type: "node_started", nodeId: "classify", attempt: 1 },
    {
      ...base(3),
      type: "node_succeeded",
      nodeId: "classify",
      attempt: 1,
      evidence: commandEvidence("needs-work\n"),
    },
    conditionEvaluated(4),
    {
      ...base(5),
      type: "node_omitted",
      nodeId: "inspect-clean",
      reason: "condition_not_selected",
      conditionId: "route",
      selectedCase: "needs-work",
      expectedCase: "already-clean",
    },
    { ...base(6), type: "node_started", nodeId: "implement", attempt: 1 },
    {
      ...base(7),
      type: "node_succeeded",
      nodeId: "implement",
      attempt: 1,
      evidence: agentEvidence("implemented"),
    },
    { ...base(8), type: "node_started", nodeId: "verify-change", attempt: 1 },
    {
      ...base(9),
      type: "node_succeeded",
      nodeId: "verify-change",
      attempt: 1,
      evidence: commandEvidence("passed\n"),
    },
    joinEvent(10),
    { ...base(11), type: "node_started", nodeId: "verify-final", attempt: 1 },
    {
      ...base(12),
      type: "node_succeeded",
      nodeId: "verify-final",
      attempt: 1,
      evidence: commandEvidence("final\n"),
    },
    { ...base(13), type: "run_succeeded" },
  ] as unknown as RunEvent[];
}

function throughClassifier(): RunEvent[] {
  return [
    controlRunStarted(),
    { ...base(2), type: "node_started", nodeId: "classify", attempt: 1 },
    {
      ...base(3),
      type: "node_succeeded",
      nodeId: "classify",
      attempt: 1,
      evidence: commandEvidence("needs-work\n"),
    },
  ] as unknown as RunEvent[];
}

function throughCondition(): RunEvent[] {
  return [...throughClassifier(), conditionEvaluated(4)] as unknown as RunEvent[];
}

function conditionEvaluated(sequence: number) {
  return {
    ...base(sequence),
    type: "node_condition_evaluated" as const,
    nodeId: "route",
    attempt: 1,
    sourceNodeId: "classify",
    sourceAttempt: 1,
    sourceField: "command.stdout" as const,
    sourceHash: sha256("needs-work\n"),
    selectedCase: "needs-work",
  };
}

function joinEvent(sequence: number) {
  return {
    ...base(sequence),
    type: "node_joined" as const,
    nodeId: "converge",
    attempt: 1,
    conditionId: "route",
    selectedCase: "needs-work",
    completedNodeId: "verify-change",
    omittedNodeIds: ["inspect-clean"],
  };
}

function controlFailure(sequence: number) {
  return {
    ...base(sequence),
    type: "node_control_failed" as const,
    nodeId: "route",
    attempt: 1,
    error: {
      code: "condition_source_truncated",
      message: "condition source command.stdout is truncated",
      retryable: false,
      sideEffectStatus: "none" as const,
    },
  };
}

function controlRunStarted() {
  return {
    ...base(1),
    type: "run_started" as const,
    nodeIds: [
      "classify",
      "route",
      "implement",
      "verify-change",
      "inspect-clean",
      "converge",
      "verify-final",
    ],
    workflowApiVersion: "flow.synapti.ai/v1alpha1" as const,
    workflowDigest: "c".repeat(64),
    controlGraph: controlGraph(),
  };
}

function propagatedRunStarted() {
  const started = controlRunStarted();
  const graph = structuredClone(started.controlGraph);
  graph.nodes.splice(5, 0, {
    nodeId: "inspect-clean-child",
    type: "command" as const,
    dependsOn: ["inspect-clean"],
  });
  const join = graph.nodes.find((node) => node.nodeId === "converge");
  if (join?.type === "join") {
    join.dependsOn = ["verify-change", "inspect-clean-child"];
    join.join.branches[1] = { case: "already-clean", nodeId: "inspect-clean-child" };
  }
  return {
    ...started,
    nodeIds: [
      "classify",
      "route",
      "implement",
      "verify-change",
      "inspect-clean",
      "inspect-clean-child",
      "converge",
      "verify-final",
    ],
    controlGraph: graph,
  };
}

function controlGraph() {
  return {
    nodes: [
      { nodeId: "classify", type: "command" as const, dependsOn: [] },
      {
        nodeId: "route",
        type: "condition" as const,
        dependsOn: ["classify"],
        condition: {
          source: { nodeId: "classify", field: "command.stdout" as const },
          cases: [{ id: "needs-work", equals: "needs-work\n" }],
          default: "already-clean",
        },
      },
      {
        nodeId: "implement",
        type: "agent" as const,
        dependsOn: ["route"],
        when: { conditionId: "route", case: "needs-work" },
      },
      { nodeId: "verify-change", type: "command" as const, dependsOn: ["implement"] },
      {
        nodeId: "inspect-clean",
        type: "command" as const,
        dependsOn: ["route"],
        when: { conditionId: "route", case: "already-clean" },
      },
      {
        nodeId: "converge",
        type: "join" as const,
        dependsOn: ["verify-change", "inspect-clean"],
        join: {
          conditionId: "route",
          branches: [
            { case: "needs-work", nodeId: "verify-change" },
            { case: "already-clean", nodeId: "inspect-clean" },
          ],
        },
      },
      { nodeId: "verify-final", type: "command" as const, dependsOn: ["converge"] },
    ],
  };
}

function oversizedControlGraph() {
  const nodes: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 8; index += 1) {
    nodes.push(
      {
        nodeId: `source-${index}`,
        type: "command",
        dependsOn: index === 0 ? [] : [`join-${index - 1}`],
      },
      {
        nodeId: `route-${index}`,
        type: "condition",
        dependsOn: [`source-${index}`],
        condition: {
          source: { nodeId: `source-${index}`, field: "command.stdout" },
          cases: [{ id: "matched", equals: "x".repeat(65_536) }],
          default: "fallback",
        },
      },
      {
        nodeId: `selected-${index}`,
        type: "command",
        dependsOn: [`route-${index}`],
        when: { conditionId: `route-${index}`, case: "matched" },
      },
      {
        nodeId: `fallback-${index}`,
        type: "command",
        dependsOn: [`route-${index}`],
        when: { conditionId: `route-${index}`, case: "fallback" },
      },
      {
        nodeId: `join-${index}`,
        type: "join",
        dependsOn: [`selected-${index}`, `fallback-${index}`],
        join: {
          conditionId: `route-${index}`,
          branches: [
            { case: "matched", nodeId: `selected-${index}` },
            { case: "fallback", nodeId: `fallback-${index}` },
          ],
        },
      },
    );
  }
  nodes.push({
    nodeId: "verify-final",
    type: "command",
    dependsOn: ["join-7"],
  });
  return { controlGraph: { nodes }, nodeIds: nodes.map((node) => node.nodeId) };
}

function oversizedReviewControlGraph() {
  const verifier = (nodeId: string) => ({
    nodeId,
    type: "verifier" as const,
    dependsOn: ["source"],
    verifier: {
      kind: "model" as const,
      prompt: "r".repeat(600_000),
      evidence: [{ nodeId: "source", field: "command.stdout" }],
      model: { provider: "test", id: "deterministic", thinking: "medium" },
      timeoutMs: 60_000,
      inputPolicy: {
        kind: "issue-workflow" as const,
        role: "review" as const,
        maxBytes: 786_432,
      },
    },
  });
  const nodes = [
    { nodeId: "source", type: "command" as const, dependsOn: [] },
    verifier("review-one"),
    verifier("review-two"),
  ];
  return { controlGraph: { nodes }, nodeIds: nodes.map((node) => node.nodeId) };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-07T18:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId: "run-control",
    workflowId: "conditional-control",
  };
}

function commandEvidence(stdout: string) {
  return {
    kind: "command" as const,
    executable: "node",
    args: [],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: sha256(stdout),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function agentEvidence(text: string) {
  return {
    kind: "agent" as const,
    provider: "test",
    model: "deterministic",
    text,
    textHash: sha256(text),
    textTruncated: false,
    durationMs: 1,
    policyDecisions: [],
    effectReceipts: [],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
