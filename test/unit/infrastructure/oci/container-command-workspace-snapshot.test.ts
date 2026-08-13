import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { observeContainerCommandWorkspaceSnapshot } from "../../../../src/infrastructure/oci/container-command-workspace-snapshot.js";

describe("container command workspace snapshot", () => {
  it("binds regular content, modes, directories, symlinks, and exclusion identities", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flow-container-command-snapshot-"));
    try {
      await mkdir(join(workspace, "source"));
      await writeFile(join(workspace, "source", "index.js"), "export const value = 1;\n", "utf8");
      await symlink("source/index.js", join(workspace, "entry.js"));
      await writeFile(join(workspace, ".env"), "PRIVATE_LOW_ENTROPY=one\n", "utf8");

      const baseline = await observeContainerCommandWorkspaceSnapshot({
        workspace,
        excludedPaths: [join(workspace, ".env")],
      });
      await writeFile(join(workspace, ".env"), "PRIVATE_LOW_ENTROPY=two\n", "utf8");
      const changedSecret = await observeContainerCommandWorkspaceSnapshot({
        workspace,
        excludedPaths: [join(workspace, ".env")],
      });
      expect(changedSecret).toBe(baseline);

      await writeFile(join(workspace, "source", "index.js"), "export const value = 2;\n", "utf8");
      const changedContent = await observeContainerCommandWorkspaceSnapshot({
        workspace,
        excludedPaths: [join(workspace, ".env")],
      });
      expect(changedContent).not.toBe(baseline);

      await writeFile(join(workspace, "source", "index.js"), "export const value = 1;\n", "utf8");
      await chmod(join(workspace, "source", "index.js"), 0o755);
      const changedMode = await observeContainerCommandWorkspaceSnapshot({
        workspace,
        excludedPaths: [join(workspace, ".env")],
      });
      expect(changedMode).not.toBe(baseline);

      expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed on content, entry, and cancellation boundaries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flow-container-command-snapshot-bound-"));
    const controller = new AbortController();
    const cancellation = new Error("PRIVATE_SNAPSHOT_CANCELLED");
    try {
      await writeFile(join(workspace, "one.txt"), "1234", "utf8");
      await writeFile(join(workspace, "two.txt"), "5678", "utf8");

      await expect(
        observeContainerCommandWorkspaceSnapshot({ workspace, maxBytes: 7 }),
      ).rejects.toThrow("container command workspace snapshot exceeds its content limit");
      await expect(
        observeContainerCommandWorkspaceSnapshot({ workspace, maxEntries: 1 }),
      ).rejects.toThrow("container command workspace snapshot exceeds its entry limit");

      controller.abort(cancellation);
      await expect(
        observeContainerCommandWorkspaceSnapshot({
          workspace,
          signal: controller.signal,
        }),
      ).rejects.toBe(cancellation);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a special file before it can enter the workspace digest", async () => {
    const workspace = await mkdtemp("/tmp/flow-ccs-special-");
    const socketPath = join(workspace, "private.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(observeContainerCommandWorkspaceSnapshot({ workspace })).rejects.toThrow(
        "container command workspace snapshot contains an unsupported entry",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an excluded path outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flow-container-command-snapshot-exclusion-"));
    try {
      await expect(
        observeContainerCommandWorkspaceSnapshot({
          workspace,
          excludedPaths: [join(workspace, "..", "private.txt")],
        }),
      ).rejects.toThrow("container command workspace snapshot exclusion is outside the workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
