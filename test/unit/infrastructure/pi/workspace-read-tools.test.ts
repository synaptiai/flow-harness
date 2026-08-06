import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkspacePathGuard,
  createWorkspaceReadTools,
} from "../../../../src/infrastructure/pi/workspace-read-tools.js";

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

    const tools = await createWorkspaceReadTools(root, ["read", "ls"]);

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
    const tools = await createWorkspaceReadTools(root, ["read"]);
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
  });

  it("rejects absolute paths and traversal outside the execution workspace", async () => {
    const root = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    const guard = createWorkspacePathGuard(await realpath(root));
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");

    await expect(guard(outsideFile)).rejects.toThrowError(/outside/i);
    await expect(guard("../secret.txt")).rejects.toThrowError(/outside/i);
  });

  it("rejects symlinks that resolve outside the execution workspace", async () => {
    const root = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");
    await symlink(outsideFile, join(root, "linked-secret"));
    const guard = createWorkspacePathGuard(await realpath(root));

    await expect(guard(join(root, "linked-secret"))).rejects.toThrowError(/outside/i);
  });

  it("allows canonical files and directories within the workspace", async () => {
    const root = await createTemporaryDirectory();
    const nested = join(root, "nested");
    await mkdir(nested);
    const file = join(nested, "file.txt");
    await writeFile(file, "ok", "utf8");
    const guard = createWorkspacePathGuard(await realpath(root));

    await expect(guard(file)).resolves.toBe(await realpath(file));
  });

  it("allows dotted names that merely begin with two periods", async () => {
    const root = await createTemporaryDirectory();
    const dottedFile = join(root, "..config");
    await writeFile(dottedFile, "ok", "utf8");
    const guard = createWorkspacePathGuard(await realpath(root));

    await expect(guard("..config")).resolves.toBe(await realpath(dottedFile));
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-workspace-tools-"));
  temporaryDirectories.push(directory);
  return directory;
}
