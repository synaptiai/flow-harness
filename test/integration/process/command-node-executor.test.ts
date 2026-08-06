import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import type { NodeExecutionContext } from "../../../src/application/ports.js";
import type { CompiledCommandNode } from "../../../src/domain/workflow/types.js";
import { CommandNodeExecutor } from "../../../src/infrastructure/process/command-node-executor.js";

const context: NodeExecutionContext = {
  runId: "run-command",
  workflowId: "command-workflow",
  attempt: 1,
  cwd: process.cwd(),
};

describe("CommandNodeExecutor", () => {
  it("returns success only for exit code zero", async () => {
    const executor = new CommandNodeExecutor();

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
    const executor = new CommandNodeExecutor();

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
    const executor = new CommandNodeExecutor();

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
    const executor = new CommandNodeExecutor();
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
    const executor = new CommandNodeExecutor({ maxOutputBytes: 16 });

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

  it("terminates a command that exceeds its declared timeout", async () => {
    const executor = new CommandNodeExecutor({ terminationGraceMs: 25 });

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

  it("terminates immediately when execution starts with an aborted signal", async () => {
    const executor = new CommandNodeExecutor({ terminationGraceMs: 25 });
    const controller = new AbortController();
    controller.abort();

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
      { ...context, signal: controller.signal },
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_aborted" },
      evidence: { timedOut: false },
    });
  });

  it("terminates a running command when cancellation arrives", async () => {
    const executor = new CommandNodeExecutor({ terminationGraceMs: 25 });
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
