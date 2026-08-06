import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PolicyBroker } from "../../../../src/domain/policy/broker.js";

import { createWorkspaceReadTools } from "../../../../src/infrastructure/pi/workspace-read-tools.js";

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

    const tools = await createWorkspaceReadTools(root, ["read", "ls"], policyBroker());

    expect(tools.names).toEqual(["flow_read", "flow_ls"]);
    expect(tools.definitions.map((tool) => tool.name)).toEqual(["flow_read", "flow_ls"]);
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
    const tools = await createWorkspaceReadTools(root, ["read"], policy);
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
    const tools = await createWorkspaceReadTools(root, ["ls"], policy);
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
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-workspace-tools-"));
  temporaryDirectories.push(directory);
  return directory;
}

function policyBroker(): PolicyBroker {
  return new PolicyBroker(
    {
      runId: "run-tools",
      workflowId: "tools-workflow",
      nodeId: "analyze",
      attempt: 1,
    },
    ["filesystem.read", "filesystem.list"],
  );
}
