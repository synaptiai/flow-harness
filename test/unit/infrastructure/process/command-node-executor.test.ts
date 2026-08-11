import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  CommandSandbox,
  CommandSandboxRequest,
  PreparedCommand,
} from "../../../../src/application/command-sandbox.js";
import type { NodeExecutionContext } from "../../../../src/application/ports.js";
import { normalizeAgentCommandRequest } from "../../../../src/domain/agent-command.js";
import type { SandboxEvidence } from "../../../../src/domain/run/events.js";
import type { CompiledCommandNode } from "../../../../src/domain/workflow/types.js";
import { CommandNodeExecutor } from "../../../../src/infrastructure/process/command-node-executor.js";

const sandboxEvidence: SandboxEvidence = {
  backend: "anthropic-sandbox-runtime",
  backendVersion: "test",
  profile: "workspace-write-network-deny-v1",
  policyDigest: "a".repeat(64),
};

const context: NodeExecutionContext = {
  runId: "sandbox-run",
  workflowId: "sandbox-workflow",
  attempt: 1,
  cwd: process.cwd(),
  protectedPaths: [process.cwd()],
};

describe("CommandNodeExecutor sandbox boundary", () => {
  it("executes a normalized agent command through the same sandbox boundary", async () => {
    const sandbox = new FakeCommandSandbox({
      processContainment: "linux-pid-namespace",
      launch: {
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("agent-sandboxed")'],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      evidence: sandboxEvidence,
    });
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.executeAgentCommand(
      normalizeAgentCommandRequest({ executable: "npm", args: ["test"], timeoutMs: 10_000 }),
      context,
    );

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        executable: "npm",
        args: ["test"],
        stdout: "agent-sandboxed",
        sandbox: sandboxEvidence,
      },
    });
    expect(sandbox.requests[0]).toMatchObject({ executable: "npm", args: ["test"] });
  });

  it("refuses an agent command before spawn when containment is only a process group", async () => {
    const sandbox = new FakeCommandSandbox({
      processContainment: "process-group",
      launch: {
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("must-not-run")'],
        env: {},
      },
      evidence: sandboxEvidence,
    });
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.executeAgentCommand(
      normalizeAgentCommandRequest({ executable: "npm", args: ["test"], timeoutMs: 10_000 }),
      context,
    );

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "command_sandbox_unavailable",
        message: "agent commands require kernel-backed descendant containment",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
    expect(sandbox.releaseCalls).toBe(1);
  });

  it("spawns only the prepared launch and retains requested-command evidence", async () => {
    const sandbox = new FakeCommandSandbox({
      processContainment: "process-group",
      launch: {
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("sandboxed")'],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      evidence: sandboxEvidence,
    });
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(commandNode("does-not-exist", ["literal"]), context);

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        executable: "does-not-exist",
        args: ["literal"],
        stdout: "sandboxed",
        sandbox: sandboxEvidence,
      },
    });
    expect(sandbox.requests).toEqual([
      expect.objectContaining({
        executable: "does-not-exist",
        args: ["literal"],
        cwd: context.cwd,
        protectedPaths: context.protectedPaths,
        signal: expect.any(AbortSignal),
      }),
    ]);
    expect(sandbox.requests[0]?.signal?.aborted).toBe(false);
    expect(sandbox.releaseCalls).toBe(1);
  });

  it("fails with no side effects when sandbox preparation fails", async () => {
    const sandbox = new FakeCommandSandbox(undefined, new Error("bubblewrap unavailable"));
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "process.exit(0)"]),
      context,
    );

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "command_sandbox_unavailable",
        message: "bubblewrap unavailable",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
    expect(sandbox.releaseCalls).toBe(0);
  });

  it("includes sandbox preparation in the declared command deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const sandbox: CommandSandbox = {
      prepare: async (request) => {
        observedSignal = request.signal;
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(request.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    };
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "process.exit(0)"], 10),
      context,
    );

    expect(observedSignal?.aborted).toBe(true);
    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "command_timeout",
        message: "command exceeded timeout of 10ms before process launch",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
  });

  it("returns at the deadline when sandbox preparation ignores cancellation", async () => {
    const sandbox: CommandSandbox = {
      prepare: async () =>
        await new Promise<PreparedCommand>((resolve) => {
          setTimeout(
            () =>
              resolve({
                processContainment: "process-group",
                launch: { executable: process.execPath, args: [], env: {} },
                evidence: sandboxEvidence,
                release: async () => undefined,
              }),
            500,
          );
        }),
    };
    const executor = new CommandNodeExecutor({ sandbox });
    const startedAt = performance.now();

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "process.exit(0)"], 10),
      context,
    );

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_timeout", sideEffectStatus: "none" },
      evidence: null,
    });
  });

  it("does not spawn when synchronous preparation returns after the absolute deadline", async () => {
    const sandbox = new FakeCommandSandbox({
      processContainment: "process-group",
      launch: { executable: process.execPath, args: ["-e", "process.exit(0)"], env: {} },
      evidence: sandboxEvidence,
    });
    const originalPrepare = sandbox.prepare.bind(sandbox);
    sandbox.prepare = async (request) => {
      const blockedUntil = performance.now() + 100;
      while (performance.now() < blockedUntil) {
        // Deliberately block to prove the absolute deadline does not depend on timer delivery.
      }
      return originalPrepare(request);
    };
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "process.exit(0)"], 10),
      context,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_timeout", sideEffectStatus: "none" },
      evidence: null,
    });
    expect(sandbox.releaseCalls).toBe(1);
  });

  it("releases the sandbox after launcher spawn failure", async () => {
    const sandbox = new FakeCommandSandbox({
      processContainment: "process-group",
      launch: { executable: "missing-sandbox-launcher", args: [], env: {} },
      evidence: sandboxEvidence,
    });
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(commandNode("node", []), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_spawn_failed", sideEffectStatus: "none" },
      evidence: null,
    });
    expect(sandbox.releaseCalls).toBe(1);
  });

  it("does not report success when sandbox cleanup fails after execution", async () => {
    const sandbox = new FakeCommandSandbox({
      processContainment: "process-group",
      launch: { executable: process.execPath, args: ["-e", "process.exit(0)"], env: {} },
      evidence: sandboxEvidence,
      releaseError: new Error("sandbox reset failed"),
    });
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(commandNode("node", []), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "command_sandbox_cleanup_failed",
        message: "sandbox reset failed",
        retryable: false,
        sideEffectStatus: "uncertain",
      },
      evidence: { exitCode: 0, sandbox: sandboxEvidence },
    });
    expect(sandbox.releaseCalls).toBe(1);
  });

  it("preserves unconfirmed termination when sandbox cleanup also fails", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "flow-termination-test-"));
    const pidPath = join(temporaryDirectory, "pid");
    const sandbox = new FakeCommandSandbox({
      processContainment: "linux-pid-namespace",
      launch: {
        executable: process.execPath,
        args: [
          "-e",
          'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => process.stdout.write("late output\\n"), 1)',
          pidPath,
        ],
        env: {},
      },
      evidence: sandboxEvidence,
      releaseError: new Error("sandbox reset also failed"),
    });
    const executor = new CommandNodeExecutor({
      sandbox,
      terminationGraceMs: 0,
      terminationConfirmationMs: 10,
    });
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (typeof pid === "number" && pid < 0) {
        return true;
      }
      return originalKill(pid, signal);
    });

    let processGroup: number | undefined;
    try {
      const outcome = await executor.executeAgentCommand(
        normalizeAgentCommandRequest({ executable: "node", timeoutMs: 1_000 }),
        context,
      );
      processGroup = Number(await readFile(pidPath, "utf8"));

      expect(outcome).toMatchObject({
        status: "failed",
        error: { code: "command_termination_failed", sideEffectStatus: "uncertain" },
        evidence: { timedOut: true, terminationStatus: "unconfirmed" },
      });
    } finally {
      killSpy.mockRestore();
      if (processGroup !== undefined && Number.isSafeInteger(processGroup)) {
        try {
          originalKill(-processGroup, "SIGKILL");
        } catch {
          // The process may have exited while the assertion was running.
        }
      }
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

class FakeCommandSandbox implements CommandSandbox {
  readonly requests: CommandSandboxRequest[] = [];
  releaseCalls = 0;

  constructor(
    private readonly prepared:
      | (Omit<PreparedCommand, "release"> & {
          readonly releaseError?: Error;
        })
      | undefined,
    private readonly prepareError?: Error,
  ) {}

  async prepare(request: CommandSandboxRequest): Promise<PreparedCommand> {
    this.requests.push(request);
    if (this.prepareError !== undefined) {
      throw this.prepareError;
    }
    if (this.prepared === undefined) {
      throw new Error("test sandbox has no prepared command");
    }
    return {
      processContainment: this.prepared.processContainment,
      launch: this.prepared.launch,
      evidence: this.prepared.evidence,
      release: async () => {
        this.releaseCalls += 1;
        if (this.prepared?.releaseError !== undefined) {
          throw this.prepared.releaseError;
        }
      },
    };
  }
}

function commandNode(
  executable: string,
  args: readonly string[],
  timeoutMs = 10_000,
): CompiledCommandNode {
  return {
    id: "verify",
    type: "command",
    dependsOn: [],
    command: { executable, args, timeoutMs },
  };
}
