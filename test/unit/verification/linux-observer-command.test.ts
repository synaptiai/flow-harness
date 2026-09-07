import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executeLinuxObserverCommand,
  type LinuxObserverCommandRequest,
} from "../../../src/infrastructure/verification/linux-observer-command.js";

describe("Linux observer command admission", () => {
  it.each([
    { maxOutputBytes: 0 },
    { maxOutputBytes: 32_769 },
    { preparationSettlementMs: 0 },
    { preparationSettlementMs: 65_001 },
    { cwd: "relative" },
    { protectedPaths: ["relative"] },
    { runtimeSupportPaths: ["relative"] },
    { identity: { runId: "test", workflowId: "test", nodeId: "test", attempt: 0 } },
    { command: { executable: process.execPath, args: [], timeoutMs: 0 } },
  ])("rejects invalid host bounds/identity/paths without launching: %j", async (change) => {
    await withRequest(async (request, marker) => {
      const result = await executeLinuxObserverCommand({
        ...request,
        ...change,
        command:
          "command" in change
            ? { ...request.command, timeoutMs: change.command.timeoutMs }
            : request.command,
      });
      expect(result).toEqual({ kind: "unsupported", reason: "invalid_request", outcome: null });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects a noncanonical existing cwd without launching", async () => {
    await withRequest(async (request, marker) => {
      const alias = join(request.cwd, "alias");
      await symlink(request.cwd, alias);
      const result = await executeLinuxObserverCommand({ ...request, cwd: alias });
      expect(result).toEqual({ kind: "unsupported", reason: "invalid_request", outcome: null });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects an already cancelled request without launching", async () => {
    await withRequest(async (request, marker) => {
      const cancellation = new AbortController();
      cancellation.abort();
      const result = await executeLinuxObserverCommand({ ...request, signal: cancellation.signal });
      expect(result).toEqual({ kind: "unsupported", reason: "cancelled", outcome: null });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.skipIf(process.platform === "linux" && process.arch === "x64")(
    "rejects this actual unsupported host without launching (no platform override)",
    async () => {
      await withRequest(async (request, marker) => {
        const result = await executeLinuxObserverCommand(request);
        expect(result).toEqual({
          kind: "unsupported",
          reason: "unsupported_platform",
          outcome: null,
        });
        await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});

async function withRequest(
  run: (request: LinuxObserverCommandRequest, marker: string) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-observer-admission-")));
  const marker = join(root, "unexpected-launch.txt");
  try {
    await run(
      {
        command: {
          executable: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "launched")`],
          timeoutMs: 5000,
        },
        cwd: root,
        protectedPaths: [],
        runtimeSupportPaths: [],
        maxOutputBytes: 1024,
        preparationSettlementMs: 5000,
        identity: {
          runId: `admission-${randomUUID()}`,
          workflowId: "observer",
          nodeId: "probe",
          attempt: 1,
        },
      },
      marker,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
