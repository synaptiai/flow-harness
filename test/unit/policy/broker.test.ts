import { describe, expect, it } from "vitest";

import {
  classifyPolicyAction,
  PolicyAuditClosedError,
  PolicyAuditLimitError,
  PolicyBroker,
  PolicyDeniedError,
} from "../../../src/domain/policy/broker.js";
import {
  DEFAULT_POLICY_DECISION_LIMIT,
  MAX_POLICY_DECISION_LIMIT,
} from "../../../src/domain/policy/limits.js";

const attribution = {
  runId: "run-policy",
  workflowId: "policy-workflow",
  nodeId: "analyze",
  attempt: 2,
} as const;

describe("PolicyBroker", () => {
  it("classifies semantic actions independently of adapter tool names", () => {
    expect([
      classifyPolicyAction("filesystem.read"),
      classifyPolicyAction("filesystem.list"),
      classifyPolicyAction("artifact.read"),
      classifyPolicyAction("filesystem.write"),
      classifyPolicyAction("process.execute"),
      classifyPolicyAction("network.request"),
      classifyPolicyAction("credential.read"),
      classifyPolicyAction("filesystem.delete"),
    ]).toEqual([
      "read",
      "read",
      "read",
      "write",
      "execute",
      "network",
      "credentials",
      "destructive",
    ]);
  });

  it("allows a declared in-boundary operation with exact attribution and a stable digest", () => {
    const first = new PolicyBroker(attribution, ["filesystem.read"]);
    const second = new PolicyBroker(attribution, ["filesystem.read"]);

    const decision = first.authorize({
      action: "filesystem.read",
      target: "/workspace/package.json",
      boundary: "inside",
    });
    const repeated = second.authorize({
      action: "filesystem.read",
      target: "/workspace/package.json",
      boundary: "inside",
    });

    expect(decision).toEqual({
      version: 1,
      sequence: 1,
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      ...attribution,
      authority: "read",
      action: "filesystem.read",
      target: "/workspace/package.json",
      outcome: "allowed",
      reason: "operation_declared",
    });
    expect(repeated.requestDigest).toBe(decision.requestDigest);
    expect(Object.isFrozen(first.attribution)).toBe(true);
    expect(
      new PolicyBroker({ ...attribution, attempt: 3 }, ["filesystem.read"]).authorize({
        action: "filesystem.read",
        target: "/workspace/package.json",
        boundary: "inside",
      }).requestDigest,
    ).not.toBe(decision.requestDigest);
  });

  it("records and throws an attributable denial for undeclared operations", () => {
    const broker = new PolicyBroker(attribution, ["filesystem.read"]);

    expect(() =>
      broker.authorize({
        action: "filesystem.write",
        target: "/workspace/package.json",
        boundary: "inside",
        operationDigest: "a".repeat(64),
      }),
    ).toThrowError(PolicyDeniedError);
    expect(broker.snapshot()).toEqual([
      expect.objectContaining({
        sequence: 1,
        authority: "write",
        action: "filesystem.write",
        outcome: "denied",
        reason: "operation_not_declared",
      }),
    ]);
  });

  it("gives a boundary denial precedence over a declaration", () => {
    const broker = new PolicyBroker(attribution, ["filesystem.read"]);

    expect(() =>
      broker.authorize({
        action: "filesystem.read",
        target: "/outside/secret.txt",
        boundary: "outside",
      }),
    ).toThrowError(PolicyDeniedError);
    expect(broker.snapshot()[0]).toMatchObject({
      outcome: "denied",
      reason: "target_outside_workspace",
    });
  });

  it("binds a validated operation digest into a write authorization", () => {
    const operationDigest = "a".repeat(64);
    const broker = new PolicyBroker(attribution, ["filesystem.write"]);

    const decision = broker.authorize({
      action: "filesystem.write",
      target: "/workspace/source.ts",
      boundary: "inside",
      operationDigest,
    });
    const changedRequest = new PolicyBroker(attribution, ["filesystem.write"]).authorize({
      action: "filesystem.write",
      target: "/workspace/source.ts",
      boundary: "inside",
      operationDigest: "b".repeat(64),
    });

    expect(decision).toMatchObject({ operationDigest, outcome: "allowed" });
    expect(changedRequest.requestDigest).not.toBe(decision.requestDigest);
  });

  it("denies protected targets even when write authority is declared", () => {
    const broker = new PolicyBroker(attribution, ["filesystem.write"]);

    expect(() =>
      broker.authorize({
        action: "filesystem.write",
        target: "/workspace/.flow/runs/run-1/events.jsonl",
        boundary: "protected",
        operationDigest: "a".repeat(64),
      }),
    ).toThrowError(PolicyDeniedError);
    expect(broker.snapshot()[0]).toMatchObject({
      outcome: "denied",
      reason: "target_protected",
    });
  });

  it("rejects malformed operation digests before recording a decision", () => {
    const broker = new PolicyBroker(attribution, ["filesystem.write"]);

    expect(() =>
      broker.authorize({
        action: "filesystem.write",
        target: "/workspace/source.ts",
        boundary: "inside",
        operationDigest: "not-a-sha256",
      }),
    ).toThrowError(RangeError);
    expect(broker.snapshot()).toEqual([]);
  });

  it("rejects a write without an exact operation digest before recording a decision", () => {
    const broker = new PolicyBroker(attribution, ["filesystem.write"]);

    expect(() =>
      broker.authorize({
        action: "filesystem.write",
        target: "/workspace/source.ts",
        boundary: "inside",
      } as never),
    ).toThrowError(/write.*operation digest/i);
    expect(broker.snapshot()).toEqual([]);
  });

  it("rejects process execution without an exact operation digest before recording a decision", () => {
    const broker = new PolicyBroker(attribution, ["process.execute"]);

    expect(() =>
      broker.authorize({
        action: "process.execute",
        target: "npm",
        boundary: "inside",
      } as never),
    ).toThrowError(/process\.execute.*operation digest/i);
    expect(broker.snapshot()).toEqual([]);
  });

  it("fails closed once the bounded audit is full", () => {
    const exhausted: PolicyAuditLimitError[] = [];
    const broker = new PolicyBroker(attribution, ["filesystem.read"], (error) => {
      exhausted.push(error);
    });
    for (let index = 0; index < DEFAULT_POLICY_DECISION_LIMIT; index += 1) {
      broker.authorize({
        action: "filesystem.read",
        target: `/workspace/file-${index}`,
        boundary: "inside",
      });
    }

    expect(() =>
      broker.authorize({
        action: "filesystem.read",
        target: "/workspace/overflow",
        boundary: "inside",
      }),
    ).toThrowError(PolicyAuditLimitError);
    expect(() =>
      broker.authorize({
        action: "filesystem.read",
        target: "/workspace/second-overflow",
        boundary: "inside",
      }),
    ).toThrowError(PolicyAuditLimitError);
    expect(broker.snapshot()).toHaveLength(DEFAULT_POLICY_DECISION_LIMIT);
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.limit).toBe(DEFAULT_POLICY_DECISION_LIMIT);
  });

  it("fails closed at an explicit per-attempt audit limit", () => {
    const exhausted: PolicyAuditLimitError[] = [];
    const broker = new PolicyBroker(
      attribution,
      ["filesystem.read"],
      (error) => exhausted.push(error),
      2,
    );

    for (const target of ["/workspace/first", "/workspace/second"]) {
      broker.authorize({ action: "filesystem.read", target, boundary: "inside" });
    }

    expect(() =>
      broker.authorize({
        action: "filesystem.read",
        target: "/workspace/overflow",
        boundary: "inside",
      }),
    ).toThrowError(PolicyAuditLimitError);
    expect(broker.snapshot()).toHaveLength(2);
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.limit).toBe(2);
  });

  it.each([0, 1.5, MAX_POLICY_DECISION_LIMIT + 1])(
    "rejects invalid configured policy decision limit %s",
    (limit) => {
      expect(
        () => new PolicyBroker(attribution, ["filesystem.read"], undefined, limit),
      ).toThrowError(RangeError);
    },
  );

  it("admits the documented hard maximum", () => {
    const broker = new PolicyBroker(
      attribution,
      ["filesystem.read"],
      undefined,
      MAX_POLICY_DECISION_LIMIT,
    );

    expect(broker.decisionLimit).toBe(MAX_POLICY_DECISION_LIMIT);
  });

  it("closes immutably and rejects late authorizations", () => {
    const broker = new PolicyBroker(attribution, ["filesystem.list"]);
    broker.authorize({
      action: "filesystem.list",
      target: "/workspace",
      boundary: "inside",
    });

    const decisions = broker.close();
    expect(Object.isFrozen(decisions)).toBe(true);
    expect(Object.isFrozen(decisions[0])).toBe(true);
    expect(() =>
      broker.authorize({
        action: "filesystem.list",
        target: "/workspace/src",
        boundary: "inside",
      }),
    ).toThrowError(PolicyAuditClosedError);
  });

  it("rejects targets that cannot fit in bounded evidence", () => {
    const broker = new PolicyBroker(attribution, ["filesystem.read"]);

    expect(() =>
      broker.authorize({
        action: "filesystem.read",
        target: `/workspace/${"x".repeat(1024)}`,
        boundary: "inside",
      }),
    ).toThrowError(RangeError);
    expect(broker.snapshot()).toEqual([]);
  });
});
