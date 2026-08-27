import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeEffectJournal } from "../../../../src/application/ports.js";
import { PolicyBroker } from "../../../../src/domain/policy/broker.js";
import { AgentEffectRecorder } from "../../../../src/infrastructure/pi/agent-effect-recorder.js";
import { createWorkspaceAgentTools } from "../../../../src/infrastructure/pi/workspace-agent-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("flow_replace", () => {
  it("registers one strict versioned whole-file replacement tool", async () => {
    const root = await createTemporaryDirectory();
    const tools = await createWorkspaceAgentTools(root, ["replace"], policyBroker(), {
      effectRecorder: effectRecorder(),
    });

    expect(tools.names).toEqual(["flow_replace"]);
    expect(tools.definitions).toHaveLength(1);
    expect(tools.definitions[0]).toMatchObject({
      name: "flow_replace",
      label: "replace",
      executionMode: "sequential",
      parameters: {
        additionalProperties: false,
        required: ["path", "expectedSha256", "content"],
        properties: {
          path: { type: "string" },
          expectedSha256: { type: "string" },
          content: { type: "string" },
        },
      },
    });
    expect(JSON.stringify(tools.definitions[0]?.parameters)).not.toContain("oldText");
  });

  it("replaces a file through policy and durable effect evidence", async () => {
    const root = await createTemporaryDirectory();
    const target = join(root, "legacy.py");
    const before = "legacy\n";
    const after = "from synthesize.cli import main\n";
    const operationDigest = replaceOperationDigest("legacy.py", sha256(before), after);
    const events: unknown[] = [];
    await writeFile(target, before, "utf8");
    const policy = policyBroker();
    const effects = effectRecorder(recordingJournal(events));
    const tools = await createWorkspaceAgentTools(root, ["replace"], policy, {
      effectRecorder: effects,
    });
    const replaceTool = tools.definitions[0];
    if (replaceTool === undefined) {
      throw new Error("replace tool was not registered");
    }

    const result = await replaceTool.execute(
      "replace-call",
      { path: "legacy.py", expectedSha256: sha256(before), content: after },
      undefined,
      undefined,
      {} as never,
    );

    expect(await readFile(target, "utf8")).toBe(after);
    expect(result.content).toEqual([
      {
        type: "text",
        text: `Replacement committed for legacy.py; new version sha256:${sha256(after)}`,
      },
    ]);
    expect(events).toEqual([
      {
        type: "prepared",
        descriptor: {
          kind: "filesystem.edit",
          target: await realpath(target),
          operationDigest,
          beforeSha256: sha256(before),
          afterSha256: sha256(after),
          mode: 0o644,
        },
      },
      {
        type: "settled",
        settlement: { outcome: "committed", reason: "directory_synced" },
      },
    ]);
    expect(policy.snapshot()).toEqual([
      expect.objectContaining({
        action: "filesystem.write",
        target: await realpath(target),
        operationDigest,
        outcome: "allowed",
      }),
    ]);
  });

  it("requires an attempt-scoped effect recorder", async () => {
    const root = await createTemporaryDirectory();

    await expect(createWorkspaceAgentTools(root, ["replace"], policyBroker())).rejects.toThrow(
      "Flow replace requires an attempt-scoped effect recorder",
    );
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-workspace-replace-"));
  temporaryDirectories.push(directory);
  return directory;
}

function policyBroker(): PolicyBroker {
  return new PolicyBroker(
    {
      runId: "run-replace",
      workflowId: "replace-workflow",
      nodeId: "cutover",
      attempt: 1,
    },
    ["filesystem.write"],
  );
}

function effectRecorder(journal: NodeEffectJournal = recordingJournal([])): AgentEffectRecorder {
  return new AgentEffectRecorder(
    {
      runId: "run-replace",
      workflowId: "replace-workflow",
      nodeId: "cutover",
      attempt: 1,
    },
    journal,
  );
}

function recordingJournal(events: unknown[]): NodeEffectJournal {
  return {
    prepare: async (descriptor) => {
      events.push({ type: "prepared", descriptor: structuredClone(descriptor) });
      return {
        effectId: "effect-replace",
        effectSequence: 1,
        settle: async (settlement) => {
          events.push({ type: "settled", settlement: structuredClone(settlement) });
          if (settlement.outcome === "not_applied") {
            return null;
          }
          return {
            version: 1,
            sequence: 1,
            runId: "run-replace",
            workflowId: "replace-workflow",
            nodeId: "cutover",
            attempt: 1,
            kind: descriptor.kind,
            target: descriptor.target,
            operationDigest: descriptor.operationDigest,
            beforeSha256: descriptor.beforeSha256,
            afterSha256: descriptor.afterSha256,
            outcome: settlement.outcome === "committed" ? "committed" : "uncertain",
          };
        },
      };
    },
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function replaceOperationDigest(path: string, expectedSha256: string, content: string): string {
  return sha256(
    JSON.stringify({ version: 1, operation: "replace", path, expectedSha256, content }),
  );
}
