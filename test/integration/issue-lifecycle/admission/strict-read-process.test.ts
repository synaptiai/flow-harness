import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  runStrictReadProcess,
  type StrictReadProcessRequest,
} from "../../../../src/infrastructure/git/strict-read-process.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const { spawn: realSpawn } =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

describe("runStrictReadProcess", () => {
  it.each([
    { name: "absent", input: {} },
    { name: "explicitly empty", input: { stdin: "" } },
  ])("accepts a successful child that closes $name input before delivery", async ({ input }) => {
    await withClosedInputChild(async (request) => {
      await expect(runStrictReadProcess({ ...request, ...input })).resolves.toBe("complete");
    });
  });

  it("delivers nonempty input without changing its bytes", async () => {
    const stdin = "first line\nsecond line: \u00e9\n";

    await expect(
      runStrictReadProcess({
        ...nodeRequest("process.stdin.pipe(process.stdout);"),
        stdin,
      }),
    ).resolves.toBe(stdin);
  });

  it("rejects a real broken pipe when nonempty input was required", async () => {
    await withClosedInputChild(async (request, stdinErrors) => {
      await expect(
        runStrictReadProcess({ ...request, stdin: "required input" }),
      ).rejects.toMatchObject({
        code: "command_failed",
      });
      expect(stdinErrors).toContain("EPIPE");
    });
  });

  it("rejects a nonzero child exit", async () => {
    await expect(runStrictReadProcess(nodeRequest("process.exitCode = 23;"))).rejects.toMatchObject(
      {
        code: "command_failed",
      },
    );
  });

  it("preserves timeout classification", async () => {
    await expect(
      runStrictReadProcess({
        ...nodeRequest("setInterval(() => {}, 1000);"),
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: "command_timed_out" });
  });

  it("preserves in-flight abort classification", async () => {
    const controller = new AbortController();
    const pending = runStrictReadProcess({
      ...nodeRequest("setInterval(() => {}, 1000);"),
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 50);

    try {
      await expect(pending).rejects.toMatchObject({ code: "operation_aborted" });
    } finally {
      clearTimeout(timer);
    }
  });
});

function nodeRequest(script: string): StrictReadProcessRequest {
  return {
    executable: process.execPath,
    arguments: ["--input-type=module", "-e", script],
    cwd: process.cwd(),
    environment: { LANG: "C" },
    timeoutMs: 10_000,
    maxStdoutBytes: 65_536,
    maxStderrBytes: 65_536,
  };
}

async function withClosedInputChild(
  verify: (request: StrictReadProcessRequest, stdinErrors: string[]) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "flow-strict-read-process-"));
  const ready = join(root, "input-closed");
  const stdinErrors: string[] = [];
  const request = nodeRequest(`
    import { closeSync, writeFileSync } from "node:fs";
    closeSync(0);
    process.stdout.write("complete");
    writeFileSync(${JSON.stringify(ready)}, "ready");
  `);

  vi.mocked(spawn).mockImplementationOnce((...args: Parameters<typeof spawn>) => {
    const child = realSpawn(...args);
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== undefined) stdinErrors.push(error.code);
    });

    // Only delay the parent: the real child closes its own input and records readiness.
    // No subprocess output, exit status, or stream error is fabricated.
    const deadline = Date.now() + 10_000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) {
        child.kill("SIGKILL");
        throw new Error("The real child did not close its input before the test deadline.");
      }
      Atomics.wait(pause, 0, 0, 5);
    }
    return child;
  });

  try {
    await verify(request, stdinErrors);
  } finally {
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(realSpawn);
    await rm(root, { recursive: true, force: true });
  }
}
