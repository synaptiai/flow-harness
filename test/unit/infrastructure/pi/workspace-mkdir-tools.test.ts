import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeEffectJournal } from "../../../../src/application/ports.js";
import { PolicyBroker } from "../../../../src/domain/policy/broker.js";
import { EMPTY_DIRECTORY_STATE_SHA256 } from "../../../../src/domain/run/events.js";
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

describe("flow_mkdir", () => {
  it("registers one strict path-only public tool", async () => {
    const root = await createTemporaryDirectory();
    const tools = await createWorkspaceAgentTools(root, ["mkdir"], policyBroker(), {
      effectRecorder: effectRecorder(),
    });

    expect(tools.names).toEqual(["flow_mkdir"]);
    expect(tools.definitions).toHaveLength(1);
    expect(tools.definitions[0]).toMatchObject({
      name: "flow_mkdir",
      label: "mkdir",
      executionMode: "sequential",
      parameters: {
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    });
    expect(JSON.stringify(tools.definitions[0]?.parameters)).not.toContain("recursive");
    expect(JSON.stringify(tools.definitions[0]?.parameters)).not.toContain("mode");
  });

  it("creates a directory through exact policy and durable effect evidence", async () => {
    const root = await createTemporaryDirectory();
    const target = join(root, "synthesize");
    const events: unknown[] = [];
    const policy = policyBroker();
    const effects = effectRecorder(recordingJournal(events));
    const tools = await createWorkspaceAgentTools(root, ["mkdir"], policy, {
      effectRecorder: effects,
    });
    const mkdirTool = tools.definitions[0];
    if (mkdirTool === undefined) {
      throw new Error("mkdir tool was not registered");
    }

    const result = await mkdirTool.execute(
      "mkdir-call",
      { path: "synthesize" },
      undefined,
      undefined,
      {} as never,
    );

    expect((await stat(target)).isDirectory()).toBe(true);
    expect((await stat(target)).mode & 0o777).toBe(0o755);
    expect(await readdir(target)).toEqual([]);
    expect(result.content).toEqual([
      { type: "text", text: "Directory created for synthesize with mode 0755" },
    ]);
    expect(events).toEqual([
      {
        type: "prepared",
        descriptor: {
          kind: "filesystem.mkdir",
          target: await realpath(target),
          operationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          beforeSha256: null,
          afterSha256: EMPTY_DIRECTORY_STATE_SHA256,
          mode: 0o755,
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
        operationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        outcome: "allowed",
      }),
    ]);
    expect(effects.snapshot()).toEqual([
      expect.objectContaining({
        kind: "filesystem.mkdir",
        target: await realpath(target),
        beforeSha256: null,
        afterSha256: EMPTY_DIRECTORY_STATE_SHA256,
        outcome: "committed",
      }),
    ]);
  });

  it("requires an attempt-scoped effect recorder", async () => {
    const root = await createTemporaryDirectory();

    await expect(createWorkspaceAgentTools(root, ["mkdir"], policyBroker())).rejects.toThrow(
      "Flow mkdir requires an attempt-scoped effect recorder",
    );
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-workspace-mkdir-"));
  temporaryDirectories.push(directory);
  return directory;
}

function policyBroker(): PolicyBroker {
  return new PolicyBroker(
    {
      runId: "run-mkdir",
      workflowId: "mkdir-workflow",
      nodeId: "implement",
      attempt: 1,
    },
    ["filesystem.write"],
  );
}

function effectRecorder(journal: NodeEffectJournal = recordingJournal([])): AgentEffectRecorder {
  return new AgentEffectRecorder(
    {
      runId: "run-mkdir",
      workflowId: "mkdir-workflow",
      nodeId: "implement",
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
        effectId: "effect-3",
        effectSequence: 1,
        settle: async (settlement) => {
          events.push({ type: "settled", settlement: structuredClone(settlement) });
          if (settlement.outcome === "not_applied") {
            return null;
          }
          return {
            version: 1,
            sequence: 1,
            runId: "run-mkdir",
            workflowId: "mkdir-workflow",
            nodeId: "implement",
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
