import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { CommandSandbox } from "../../../src/application/command-sandbox.js";
import type { NodeExecutionContext } from "../../../src/application/ports.js";
import type { CompiledCommandNode } from "../../../src/domain/workflow/types.js";
import {
  CommandNodeExecutor,
  type CommandNodeExecutorOptions,
} from "../../../src/infrastructure/process/command-node-executor.js";

const context: NodeExecutionContext = {
  runId: "run-command",
  workflowId: "command-workflow",
  attempt: 1,
  cwd: process.cwd(),
  protectedPaths: [],
};

describe("CommandNodeExecutor", () => {
  it("returns success only for exit code zero", async () => {
    const executor = commandExecutor();

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", 'process.stdout.write("verified")']),
      context,
    );

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "command",
        exitCode: 0,
        stdout: "verified",
        timedOut: false,
      },
    });
  });

  it("records nonzero exit evidence as failure", async () => {
    const executor = commandExecutor();

    const outcome = await executor.execute(
      commandNode(process.execPath, [
        "-e",
        'process.stderr.write("verification failed"); process.exit(7)',
      ]),
      context,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_failed", retryable: false },
      evidence: { exitCode: 7, stderr: "verification failed" },
    });
  });

  it("reports a missing executable without evidence or side effects", async () => {
    const executor = commandExecutor();

    const outcome = await executor.execute(
      commandNode("flow-command-that-does-not-exist", []),
      context,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_spawn_failed", sideEffectStatus: "none" },
      evidence: null,
    });
  });

  it("passes shell metacharacters as literal argv values", async () => {
    const executor = commandExecutor();
    const literal = "$(touch should-never-exist); echo unsafe";

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "process.stdout.write(process.argv[1])", literal]),
      context,
    );

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: { stdout: literal },
    });
  });

  it("bounds captured output while hashing the complete stream", async () => {
    const executor = commandExecutor({ maxOutputBytes: 16 });

    const outcome = await executor.execute(
      commandNode(process.execPath, [
        "-e",
        'process.stdout.write("x".repeat(100)); process.stderr.write("y".repeat(100))',
      ]),
      context,
    );

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        stdout: "x".repeat(16),
        stderr: "y".repeat(16),
        stdoutTruncated: true,
        stderrTruncated: true,
      },
    });
    if (outcome.evidence?.kind === "command") {
      expect(outcome.evidence.stdoutHash).toBe(sha256("x".repeat(100)));
      expect(outcome.evidence.stderrHash).toBe(sha256("y".repeat(100)));
      expect(outcome.evidence.stdoutHash).not.toBe(sha256("x".repeat(16)));
      expect(outcome.evidence.stderrHash).not.toBe(sha256("y".repeat(16)));
    }
  });

  it("does not split a UTF-8 code point at the command evidence boundary", async () => {
    const executor = commandExecutor({ maxOutputBytes: 1 });

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", 'process.stdout.write("é")']),
      context,
    );

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: { stdout: "", stdoutTruncated: true },
    });
  });

  it("terminates a command that exceeds its declared timeout", async () => {
    const executor = commandExecutor({ terminationGraceMs: 25 });

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 50),
      context,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_timeout", sideEffectStatus: "uncertain" },
      evidence: { timedOut: true },
    });
  });

  it("does not settle until a SIGTERM-resistant descendant is terminated", async () => {
    const executor = commandExecutor({ terminationGraceMs: 25 });
    let descendantPid: number | undefined;

    try {
      const outcome = await executor.execute(
        commandNode(
          process.execPath,
          [
            "-e",
            [
              'const { spawn } = require("node:child_process")',
              'const descendant = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })',
              "process.stdout.write(String(descendant.pid))",
              "setInterval(() => {}, 1000)",
            ].join(";"),
          ],
          100,
        ),
        context,
      );

      if (outcome.evidence?.kind !== "command") {
        throw new Error("expected command evidence");
      }
      descendantPid = Number(outcome.evidence.stdout);
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(outcome).toMatchObject({
        status: "failed",
        error: { code: "command_timeout" },
        evidence: { timedOut: true },
      });
      expect(processIsAlive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  it("terminates immediately when execution starts with an aborted signal", async () => {
    const executor = commandExecutor({ terminationGraceMs: 25 });
    const controller = new AbortController();
    controller.abort();

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
      { ...context, signal: controller.signal },
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_aborted", sideEffectStatus: "none" },
      evidence: null,
    });
  });

  it("terminates a running command when cancellation arrives", async () => {
    const executor = commandExecutor({ terminationGraceMs: 25 });
    const controller = new AbortController();
    const execution = executor.execute(
      commandNode(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
      { ...context, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 25).unref();

    const outcome = await execution;

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_aborted", sideEffectStatus: "uncertain" },
      evidence: { timedOut: false },
    });
  });

  it("latches cancellation when the timeout expires during termination grace", async () => {
    const executor = commandExecutor({ terminationGraceMs: 150 });
    const controller = new AbortController();
    const execution = executor.execute(
      commandNode(
        process.execPath,
        ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
        150,
      ),
      { ...context, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100).unref();

    const outcome = await execution;

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_aborted" },
      evidence: { timedOut: false },
    });
  });

  it("fails closed on Windows until descendant containment is implemented", async () => {
    const executor = commandExecutor({ platform: "win32" });

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "process.exit(0)"]),
      context,
    );

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "command_platform_unsupported",
        message:
          "command nodes are not supported on Windows until descendant process containment is available",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
  });
});

function commandNode(
  executable: string,
  args: readonly string[],
  timeoutMs = 10_000,
): CompiledCommandNode {
  return {
    id: "verify",
    type: "command",
    dependsOn: [],
    command: {
      executable,
      args,
      timeoutMs,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

const directTestSandbox: CommandSandbox = {
  async prepare(request) {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    return {
      processContainment: "process-group",
      launch: {
        executable: request.executable,
        args: request.args,
        env: environment,
      },
      evidence: {
        backend: "anthropic-sandbox-runtime",
        backendVersion: "test-double",
        profile: "workspace-write-network-deny-v1",
        policyDigest: "f".repeat(64),
      },
      release: async () => undefined,
    };
  },
};

function commandExecutor(
  options: Omit<CommandNodeExecutorOptions, "sandbox"> = {},
): CommandNodeExecutor {
  return new CommandNodeExecutor({ ...options, sandbox: directTestSandbox });
}
