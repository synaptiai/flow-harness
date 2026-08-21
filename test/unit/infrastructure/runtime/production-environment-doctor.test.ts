import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  inspectProductionNativeSandbox,
  inspectProjectFilesystem,
} from "../../../../src/infrastructure/runtime/production-environment-doctor.js";

describe("production environment doctor", () => {
  it("checks project access without changing project bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-doctor-filesystem-"));
    try {
      await mkdir(join(root, ".flow"));
      await writeFile(join(root, "fixture.txt"), "UNCHANGED\n", "utf8");

      await inspectProjectFilesystem(root, new AbortController().signal);

      expect(await readFile(join(root, "fixture.txt"), "utf8")).toBe("UNCHANGED\n");
      await access(join(root, ".flow"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs one bounded no-op through the production native executor contract", async () => {
    const execute = vi.fn(async () => ({ status: "succeeded" as const }));
    const signal = new AbortController().signal;

    await inspectProductionNativeSandbox("/workspace/project", signal, {
      createExecutor: () => ({ execute }),
      nodeExecutable: "/trusted/node",
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      {
        id: "flow-doctor-native-sandbox",
        type: "command",
        dependsOn: [],
        command: {
          executable: "/trusted/node",
          args: ["-e", ""],
          timeoutMs: 2_000,
        },
      },
      {
        runId: "flow-doctor",
        workflowId: "flow-doctor",
        attempt: 1,
        cwd: "/workspace/project",
        protectedPaths: [],
        signal,
      },
    );
  });

  it("maps a private native sandbox failure to one fixed internal boundary", async () => {
    await expect(
      inspectProductionNativeSandbox("/workspace/project", new AbortController().signal, {
        createExecutor: () => ({
          execute: async () => ({
            status: "failed" as const,
            error: { code: "PRIVATE_SANDBOX_PATH" },
          }),
        }),
      }),
    ).rejects.toThrow("configured native sandbox is unavailable");
  });
});
