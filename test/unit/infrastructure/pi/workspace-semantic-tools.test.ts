import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PolicyBroker } from "../../../../src/domain/policy/broker.js";
import type { SemanticRequest } from "../../../../src/domain/semantic/semantic-code.js";
import {
  createWorkspaceAgentTools,
  type SemanticToolSession,
} from "../../../../src/infrastructure/pi/workspace-agent-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("workspace semantic tool", () => {
  it("registers one closed tool, authorizes the file, and returns normalized evidence", async () => {
    const root = await temporaryProject();
    const source = join(root, "example.ts");
    await writeFile(source, "const value = 1;\n");
    const observed: SemanticRequest[] = [];
    const toolSignal = new AbortController().signal;
    const semanticSession: SemanticToolSession = {
      evidence: () => [],
      async query(request, signal) {
        observed.push(request);
        expect(signal).toBe(toolSignal);
        return {
          operation: "hover",
          hover: {
            path: "example.ts",
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 11 },
            },
            format: "markdown",
            value: "`const value: number`",
          },
        };
      },
    };
    const policy = policyBroker();
    const tools = await createWorkspaceAgentTools(root, ["semantic"], policy, {
      semanticSession,
    });
    const tool = tools.definitions[0];
    if (tool === undefined) {
      throw new Error("semantic tool was not registered");
    }

    const result = await tool.execute(
      "semantic-call",
      { operation: "hover", path: "example.ts", line: 0, character: 6 },
      toolSignal,
      undefined,
      {} as never,
    );

    expect(tools.names).toEqual(["flow_semantic"]);
    expect(observed).toEqual([
      {
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 6 },
      },
    ]);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          operation: "hover",
          hover: {
            path: "example.ts",
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 11 },
            },
            format: "markdown",
            value: "`const value: number`",
          },
        }),
      },
    ]);
    expect(policy.snapshot()).toEqual([
      expect.objectContaining({
        action: "filesystem.read",
        target: source,
        outcome: "allowed",
      }),
    ]);
  });

  it("rejects a semantic selection when the runtime did not inject a session", async () => {
    const root = await temporaryProject();

    await expect(createWorkspaceAgentTools(root, ["semantic"], policyBroker())).rejects.toThrow(
      "Flow semantic requires a configured semantic service",
    );
  });

  it("rejects an ambiguous diagnostics position before invoking the session", async () => {
    const root = await temporaryProject();
    await writeFile(join(root, "example.ts"), "const value = 1;\n");
    let invoked = false;
    const semanticSession: SemanticToolSession = {
      evidence: () => [],
      async query() {
        invoked = true;
        throw new Error("should not run");
      },
    };
    const tools = await createWorkspaceAgentTools(root, ["semantic"], policyBroker(), {
      semanticSession,
    });
    const tool = tools.definitions[0];
    if (tool === undefined) {
      throw new Error("semantic tool was not registered");
    }

    await expect(
      tool.execute(
        "semantic-call",
        { operation: "diagnostics", path: "example.ts", line: 0, character: 0 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/semantic request is invalid/i);
    expect(invoked).toBe(false);
  });
});

async function temporaryProject(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-semantic-tool-")));
  temporaryDirectories.push(root);
  return root;
}

function policyBroker(): PolicyBroker {
  return new PolicyBroker(
    { runId: "run-semantic", workflowId: "semantic-workflow", nodeId: "analyze", attempt: 1 },
    ["filesystem.read"],
  );
}
