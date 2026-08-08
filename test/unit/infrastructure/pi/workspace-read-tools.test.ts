import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeEffectJournal } from "../../../../src/application/ports.js";
import { createAgentSkillSession } from "../../../../src/domain/capability/agent-skill-session.js";
import { createCapabilitySnapshot } from "../../../../src/domain/capability/agent-skills.js";
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

describe("workspace-confined Pi tools", () => {
  it("registers only Flow-owned tool names", async () => {
    const root = await createTemporaryDirectory();

    const tools = await createWorkspaceAgentTools(root, ["read", "ls", "edit"], policyBroker(), {
      effectRecorder: effectRecorder(),
    });

    expect(tools.names).toEqual(["flow_read", "flow_ls", "flow_edit"]);
    expect(tools.definitions.map((tool) => tool.name)).toEqual([
      "flow_read",
      "flow_ls",
      "flow_edit",
    ]);
    expect(tools.definitions[0]?.description).toContain("UTF-8 text");
    expect(tools.definitions[0]?.description).toContain("image decoding is not supported");
    expect(tools.definitions[0]?.description).not.toMatch(/bash/i);
  });

  it("enforces confinement through the registered read tool", async () => {
    const root = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    const insideFile = join(root, "inside.txt");
    const outsideFile = join(outside, "secret.txt");
    await writeFile(insideFile, "inside", "utf8");
    await writeFile(outsideFile, "secret", "utf8");
    const policy = policyBroker();
    const tools = await createWorkspaceAgentTools(root, ["read"], policy);
    const readTool = tools.definitions[0];
    if (readTool === undefined) {
      throw new Error("read tool was not registered");
    }

    const result = await readTool.execute(
      "inside-call",
      { path: insideFile },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content).toContainEqual({ type: "text", text: "inside" });
    expect(result.content).toContainEqual({
      type: "text",
      text: `[Flow file version: sha256:${sha256("inside")}]`,
    });
    await expect(
      readTool.execute("outside-call", { path: outsideFile }, undefined, undefined, {} as never),
    ).rejects.toThrowError(/outside/i);
    expect(policy.snapshot().map((decision) => decision.sequence)).toEqual(
      policy.snapshot().map((_, index) => index + 1),
    );
    expect(policy.snapshot().slice(0, -1)).toHaveLength(2);
    expect(
      policy
        .snapshot()
        .slice(0, -1)
        .every(
          (decision) => decision.action === "filesystem.read" && decision.outcome === "allowed",
        ),
    ).toBe(true);
    expect(policy.snapshot().at(-1)).toMatchObject({
      action: "filesystem.read",
      outcome: "denied",
      reason: "target_outside_workspace",
    });
  });

  it("routes directory listing operations through the policy broker", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "visible.txt"), "visible", "utf8");
    const policy = policyBroker();
    const tools = await createWorkspaceAgentTools(root, ["ls"], policy);
    const lsTool = tools.definitions[0];
    if (lsTool === undefined) {
      throw new Error("ls tool was not registered");
    }

    const result = await lsTool.execute(
      "ls-call",
      { path: root },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content).toContainEqual({ type: "text", text: "visible.txt" });
    expect(policy.snapshot().length).toBeGreaterThan(0);
    expect(
      policy
        .snapshot()
        .every(
          (decision) => decision.action === "filesystem.list" && decision.outcome === "allowed",
        ),
    ).toBe(true);
  });

  it("lists a populated directory through one logical policy authorization", async () => {
    const root = await createTemporaryDirectory();
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(join(root, `file-${index.toString().padStart(3, "0")}.txt`), "visible", "utf8"),
      ),
    );
    const policy = policyBroker();
    const tools = await createWorkspaceAgentTools(root, ["ls"], policy);
    const lsTool = tools.definitions[0];
    if (lsTool === undefined) {
      throw new Error("ls tool was not registered");
    }

    const result = await lsTool.execute(
      "ls-call",
      { path: root },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("file-099.txt"),
    });
    expect(policy.snapshot()).toHaveLength(1);
    expect(policy.snapshot()[0]).toMatchObject({
      action: "filesystem.list",
      outcome: "allowed",
    });
  });

  it("versions the full exact file even when read output is paged", async () => {
    const root = await createTemporaryDirectory();
    const content = "first\nsecond\nthird\n";
    const target = join(root, "paged.txt");
    await writeFile(target, content, "utf8");
    const tools = await createWorkspaceAgentTools(root, ["read"], policyBroker());
    const readTool = tools.definitions[0];
    if (readTool === undefined) {
      throw new Error("read tool was not registered");
    }

    const result = await readTool.execute(
      "paged-call",
      { path: target, offset: 2, limit: 1 },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content).toContainEqual({
      type: "text",
      text: `[Flow file version: sha256:${sha256(content)}]`,
    });
  });

  it("loads selected immutable skill resources without workspace policy widening", async () => {
    const root = await createTemporaryDirectory();
    const policy = policyBroker();
    const session = createAgentSkillSession(
      createCapabilitySnapshot([
        {
          kind: "agent-skill",
          name: "review",
          description: "Review code when selected.",
          metadata: {},
          requestedTools: ["Bash"],
          trust: "project-explicit",
          provenance: ".flow/skills/review",
          files: [{ path: "SKILL.md", content: Buffer.from("# Review\n") }],
        },
      ]),
      ["review"],
    );
    const tools = await createWorkspaceAgentTools(root, ["read"], policy, {
      capabilitySession: session,
    });
    const readTool = tools.definitions[0];
    if (readTool === undefined) {
      throw new Error("read tool was not registered");
    }

    const result = await readTool.execute(
      "skill-call",
      { path: "skill://review/SKILL.md" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "# Review\n" }]);
    expect(result.details).toMatchObject({
      flowCapabilityUri: "skill://review/SKILL.md",
      fileDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(policy.snapshot()).toEqual([]);
    expect(session.evidence().reads).toHaveLength(1);
  });

  it("uses the read version token to commit an attributable edit receipt", async () => {
    const root = await createTemporaryDirectory();
    const target = join(root, "source.ts");
    await writeFile(target, "const value = 1;\n", "utf8");
    const policy = policyBroker(["filesystem.read", "filesystem.write"]);
    const effects = effectRecorder();
    const tools = await createWorkspaceAgentTools(root, ["read", "edit"], policy, {
      effectRecorder: effects,
    });
    const readTool = tools.definitions.find((tool) => tool.name === "flow_read");
    const editTool = tools.definitions.find((tool) => tool.name === "flow_edit");
    if (readTool === undefined || editTool === undefined) {
      throw new Error("read and edit tools were not registered");
    }
    const readResult = await readTool.execute(
      "read-call",
      { path: target },
      undefined,
      undefined,
      {} as never,
    );
    const version = extractVersion(readResult.content);

    const editResult = await editTool.execute(
      "edit-call",
      {
        path: target,
        expectedSha256: version,
        edits: [{ oldText: "value = 1", newText: "value = 2" }],
      },
      undefined,
      undefined,
      {} as never,
    );

    expect(await readFile(target, "utf8")).toBe("const value = 2;\n");
    expect(editResult.content).toContainEqual({
      type: "text",
      text: expect.stringMatching(/Edit committed.*sha256:[a-f0-9]{64}/),
    });
    const writeDecision = policy
      .snapshot()
      .find((decision) => decision.action === "filesystem.write");
    expect(writeDecision).toMatchObject({
      outcome: "allowed",
      operationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(effects.snapshot()).toEqual([
      expect.objectContaining({
        target: await realpath(target),
        operationDigest: writeDecision?.operationDigest,
        beforeSha256: version,
        afterSha256: sha256("const value = 2;\n"),
        outcome: "committed",
      }),
    ]);
  });

  it("durably prepares and settles the real edit boundary", async () => {
    const root = await createTemporaryDirectory();
    const target = join(root, "source.ts");
    const before = "const value = 1;\n";
    const after = "const value = 2;\n";
    await writeFile(target, before, "utf8");
    const policy = policyBroker(["filesystem.write"]);
    const journalEvents: unknown[] = [];
    const journal = recordingJournal(journalEvents, async () => await readFile(target, "utf8"));
    const effects = effectRecorder(journal);
    const tools = await createWorkspaceAgentTools(root, ["edit"], policy, {
      effectRecorder: effects,
    });
    const editTool = tools.definitions[0];
    if (editTool === undefined) {
      throw new Error("edit tool was not registered");
    }

    await editTool.execute(
      "edit-call",
      {
        path: target,
        expectedSha256: sha256(before),
        edits: [{ oldText: "value = 1", newText: "value = 2" }],
      },
      undefined,
      undefined,
      {} as never,
    );

    expect(journalEvents).toEqual([
      expect.objectContaining({
        type: "prepared",
        targetContent: before,
        descriptor: expect.objectContaining({
          target: await realpath(target),
          beforeSha256: sha256(before),
          afterSha256: sha256(after),
        }),
      }),
      {
        type: "settled",
        settlement: { outcome: "committed", reason: "directory_synced" },
      },
    ]);
    expect(await readFile(target, "utf8")).toBe(after);
    expect(effects.snapshot()).toEqual([
      expect.objectContaining({
        target: await realpath(target),
        beforeSha256: sha256(before),
        afterSha256: sha256(after),
        outcome: "committed",
      }),
    ]);
  });

  it("rejects a stale edit without recording an effect", async () => {
    const root = await createTemporaryDirectory();
    const target = join(root, "source.ts");
    await writeFile(target, "before\n", "utf8");
    const policy = policyBroker(["filesystem.write"]);
    const effects = effectRecorder();
    const tools = await createWorkspaceAgentTools(root, ["edit"], policy, {
      effectRecorder: effects,
    });
    const editTool = tools.definitions[0];
    if (editTool === undefined) {
      throw new Error("edit tool was not registered");
    }

    await expect(
      editTool.execute(
        "edit-call",
        {
          path: target,
          expectedSha256: sha256("older\n"),
          edits: [{ oldText: "before", newText: "after" }],
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "stale_version" });
    expect(await readFile(target, "utf8")).toBe("before\n");
    expect(effects.snapshot()).toEqual([]);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-workspace-tools-"));
  temporaryDirectories.push(directory);
  return directory;
}

function policyBroker(
  actions: readonly ("filesystem.read" | "filesystem.list" | "filesystem.write")[] = [
    "filesystem.read",
    "filesystem.list",
  ],
): PolicyBroker {
  return new PolicyBroker(
    {
      runId: "run-tools",
      workflowId: "tools-workflow",
      nodeId: "analyze",
      attempt: 1,
    },
    actions,
  );
}

function effectRecorder(
  journal: NodeEffectJournal = recordingJournal([], async () => ""),
): AgentEffectRecorder {
  return new AgentEffectRecorder(
    {
      runId: "run-tools",
      workflowId: "tools-workflow",
      nodeId: "analyze",
      attempt: 1,
    },
    journal,
  );
}

function recordingJournal(
  events: unknown[],
  targetContent: () => Promise<string>,
): NodeEffectJournal {
  return {
    prepare: async (descriptor) => {
      events.push({
        type: "prepared",
        descriptor: structuredClone(descriptor),
        targetContent: await targetContent(),
      });
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
            runId: "run-tools",
            workflowId: "tools-workflow",
            nodeId: "analyze",
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

function extractVersion(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  const marker = content.find(
    (item) => item.type === "text" && item.text?.startsWith("[Flow file version:"),
  )?.text;
  const match = marker?.match(/sha256:([a-f0-9]{64})/);
  if (match?.[1] === undefined) {
    throw new Error("read result did not contain a Flow file version");
  }
  return match[1];
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
