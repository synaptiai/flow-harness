import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createAgentCapabilityEvidence,
  createCapabilitySnapshot,
  type CapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  parseRunEvent,
  reduceRunEvents,
  type RunStartedEvent,
} from "../../../src/domain/run/events.js";

describe("capability run history", () => {
  it("replays an immutable provider-neutral capability snapshot", () => {
    const event = runStarted();

    const state = reduceRunEvents([structuredClone(event)]);

    expect(state.capabilitySnapshot).toEqual(event.capabilitySnapshot);
    expect(Object.isFrozen(state.capabilitySnapshot)).toBe(true);
    expect(state.capabilityRequirements).toEqual({ analyze: ["review"] });
    expect(Object.isFrozen(state.capabilityRequirements.analyze)).toBe(true);
  });

  it("rejects forged capability file content during event parsing", () => {
    const event = runStarted();
    const { snapshot, skill, file } = capabilityFixture(event);
    const forged = {
      ...event,
      capabilitySnapshot: {
        ...snapshot,
        packages: [
          {
            ...skill,
            files: [{ ...file, contentBase64: "Zm9yZ2Vk" }, ...skill.files.slice(1)],
          },
          ...snapshot.packages.slice(1),
        ],
      },
    };

    expect(() => parseRunEvent(forged)).toThrow();
  });

  it("rejects a forged capability package digest during event parsing", () => {
    const event = runStarted();
    const { snapshot, skill } = capabilityFixture(event);
    const forged = {
      ...event,
      capabilitySnapshot: {
        ...snapshot,
        packages: [{ ...skill, digest: "f".repeat(64) }, ...snapshot.packages.slice(1)],
      },
    };

    expect(() => parseRunEvent(forged)).toThrow();
  });

  it("rejects a forged capability snapshot digest during event parsing", () => {
    const event = runStarted();
    const snapshot = requireCapabilitySnapshot(event);

    expect(() =>
      parseRunEvent({
        ...event,
        capabilitySnapshot: { ...snapshot, digest: "e".repeat(64) },
      }),
    ).toThrow();
  });

  it("binds agent selection evidence to the durable package digest during replay", () => {
    const started = runStarted();
    const snapshot = requireCapabilitySnapshot(started);
    const evidence = agentEvidence(createAgentCapabilityEvidence(snapshot, ["review"]));
    const nodeStarted = {
      ...base(2),
      type: "node_started",
      nodeId: "analyze",
      attempt: 1,
    } as const;
    const nodeSucceeded = {
      ...base(3),
      type: "node_succeeded",
      nodeId: "analyze",
      attempt: 1,
      evidence,
    } as const;
    const valid = [started, nodeStarted, nodeSucceeded];

    expect(reduceRunEvents(valid).nodes.analyze?.status).toBe("succeeded");

    const forged = [
      started,
      nodeStarted,
      {
        ...nodeSucceeded,
        evidence: {
          ...evidence,
          capabilities: {
            ...evidence.capabilities,
            selected: [{ name: "review", digest: "f".repeat(64) }],
          },
        },
      },
    ];
    expect(() => reduceRunEvents(forged)).toThrow(/not bound to durable content/i);
  });

  it("rejects claimed skill reads that do not identify frozen package content", () => {
    const started = runStarted();
    const { skill, file } = capabilityFixture(started);
    const capabilities = {
      selected: [{ name: skill.name, digest: skill.digest }],
      reads: [
        {
          uri: "skill://review/SKILL.md",
          packageDigest: skill.digest,
          fileDigest: "f".repeat(64),
          bytes: file.bytes,
        },
      ],
    };

    expect(() =>
      reduceRunEvents([
        started,
        { ...base(2), type: "node_started", nodeId: "analyze", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "analyze",
          attempt: 1,
          evidence: agentEvidence(capabilities),
        },
      ]),
    ).toThrow(/not bound to durable content/i);
  });

  it("rejects valid snapshot evidence attributed outside the node's durable declaration", () => {
    const started = runStarted();
    const snapshot = requireCapabilitySnapshot(started);

    expect(() =>
      reduceRunEvents([
        started,
        { ...base(2), type: "node_started", nodeId: "analyze", attempt: 1 },
        {
          ...base(3),
          type: "node_succeeded",
          nodeId: "analyze",
          attempt: 1,
          evidence: agentEvidence(createAgentCapabilityEvidence(snapshot, ["unused"])),
        },
      ]),
    ).toThrow(/durable node declaration/i);
  });

  it("rejects capability requirements without a matching durable snapshot", () => {
    const started = runStarted();
    const { capabilitySnapshot: _capabilitySnapshot, ...withoutSnapshot } = started;

    expect(() => reduceRunEvents([withoutSnapshot])).toThrow(
      /require a durable run capability snapshot/i,
    );
  });

  it("rejects duplicate and unknown capability requirement nodes", () => {
    const started = runStarted();
    const requirement = started.capabilityRequirements?.[0];
    if (requirement === undefined) {
      throw new Error("capability requirement fixture was not created");
    }

    expect(() =>
      reduceRunEvents([
        {
          ...started,
          capabilityRequirements: [requirement, requirement],
        },
      ]),
    ).toThrow(/unique node ids/i);

    expect(() =>
      reduceRunEvents([
        {
          ...started,
          capabilityRequirements: [{ ...requirement, nodeId: "other" }],
        },
      ]),
    ).toThrow(/outside the run node set/i);
  });
});

function requireCapabilitySnapshot(event: RunStartedEvent): CapabilitySnapshot {
  if (event.capabilitySnapshot === undefined) {
    throw new Error("capability snapshot fixture was not created");
  }
  return event.capabilitySnapshot;
}

function capabilityFixture(event: RunStartedEvent) {
  const snapshot = requireCapabilitySnapshot(event);
  const skill = snapshot.packages[0];
  const file = skill?.files[0];
  if (skill === undefined || file === undefined) {
    throw new Error("skill fixture was not created");
  }
  return { snapshot, skill, file };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: "2026-08-08T12:00:00.000Z",
    runId: "capability-run",
    workflowId: "capability-workflow",
  };
}

function agentEvidence(capabilities: ReturnType<typeof createAgentCapabilityEvidence>) {
  const text = "done";
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
    capabilities,
  };
}

function runStarted(): RunStartedEvent {
  return {
    version: 1,
    sequence: 1,
    at: "2026-08-08T12:00:00.000Z",
    runId: "capability-run",
    workflowId: "capability-workflow",
    type: "run_started",
    nodeIds: ["analyze"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "a".repeat(64),
    capabilityRequirements: [{ nodeId: "analyze", skills: ["review"] }],
    capabilitySnapshot: createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: "review",
        description: "Review code when selected.",
        metadata: { version: "1" },
        requestedTools: [],
        trust: "project-explicit",
        provenance: ".flow/skills/review",
        files: [{ path: "SKILL.md", content: Buffer.from("# Review\n") }],
      },
      {
        kind: "agent-skill",
        name: "unused",
        description: "Unused package for attribution tests.",
        metadata: { version: "1" },
        requestedTools: [],
        trust: "project-explicit",
        provenance: ".flow/skills/unused",
        files: [{ path: "SKILL.md", content: Buffer.from("# Unused\n") }],
      },
    ]),
  };
}
