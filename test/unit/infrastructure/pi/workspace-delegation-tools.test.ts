import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeDelegationSession } from "../../../../src/application/ports.js";
import { PolicyBroker } from "../../../../src/domain/policy/broker.js";
import { createWorkspaceAgentTools } from "../../../../src/infrastructure/pi/workspace-agent-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("workspace delegation tool", () => {
  it("registers one sequential no-argument tool only for a sealed session", async () => {
    const root = await temporaryProject();
    const signals: Array<AbortSignal | undefined> = [];
    const session: NodeDelegationSession = {
      receipts: () => [],
      async delegate(signal) {
        signals.push(signal);
        return {
          nodeId: "publish-review",
          schemaDigest: "a".repeat(64),
          canonicalValue: JSON.stringify("approved"),
          valueHash: "b".repeat(64),
        };
      },
    };
    const signal = new AbortController().signal;
    const tools = await createWorkspaceAgentTools(root, ["read"], policyBroker(), {
      delegationSession: session,
    });
    const delegation = tools.definitions.find((tool) => tool.name === "flow_delegate");
    if (delegation === undefined) throw new Error("delegation tool was not registered");

    const result = await delegation.execute("delegation-call", {}, signal, undefined, {} as never);

    expect(tools.names).toEqual(["flow_read", "flow_delegate"]);
    expect(delegation.executionMode).toBe("sequential");
    expect(delegation.parameters).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(signals).toEqual([signal]);
    expect(result).toMatchObject({
      content: [{ type: "text", text: JSON.stringify("approved") }],
      details: {
        nodeId: "publish-review",
        canonicalValue: JSON.stringify("approved"),
      },
    });

    const ordinary = await createWorkspaceAgentTools(root, ["read"], policyBroker());
    expect(ordinary.names).toEqual(["flow_read"]);
  });
});

async function temporaryProject(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-delegation-tool-")));
  temporaryDirectories.push(root);
  return root;
}

function policyBroker(): PolicyBroker {
  return new PolicyBroker(
    { runId: "run-delegation", workflowId: "delegation-harness", nodeId: "manager", attempt: 1 },
    ["filesystem.read"],
  );
}
