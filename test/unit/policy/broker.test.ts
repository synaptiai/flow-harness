import { describe, expect, it } from "vitest";

import {
  MAX_POLICY_DECISIONS,
  PolicyAuditClosedError,
  PolicyAuditLimitError,
  PolicyBroker,
  PolicyDeniedError,
  classifyPolicyAction,
} from "../../../src/domain/policy/broker.js";

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
      classifyPolicyAction("filesystem.write"),
      classifyPolicyAction("process.execute"),
      classifyPolicyAction("network.request"),
      classifyPolicyAction("credential.read"),
      classifyPolicyAction("filesystem.delete"),
    ]).toEqual(["read", "read", "write", "execute", "network", "credentials", "destructive"]);
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

  it("fails closed once the bounded audit is full", () => {
    const broker = new PolicyBroker(attribution, ["filesystem.read"]);
    for (let index = 0; index < MAX_POLICY_DECISIONS; index += 1) {
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
    expect(broker.snapshot()).toHaveLength(MAX_POLICY_DECISIONS);
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
