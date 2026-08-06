import { describe, expect, it } from "vitest";

import type {
  CommandSandbox,
  CommandSandboxRequest,
  PreparedCommand,
} from "../../../../src/application/command-sandbox.js";
import type { NodeExecutionContext } from "../../../../src/application/ports.js";
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
  it("spawns only the prepared launch and retains requested-command evidence", async () => {
    const sandbox = new FakeCommandSandbox({
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
      {
        executable: "does-not-exist",
        args: ["literal"],
        cwd: context.cwd,
        protectedPaths: context.protectedPaths,
        signal: undefined,
      },
    ]);
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

  it("releases the sandbox after launcher spawn failure", async () => {
    const sandbox = new FakeCommandSandbox({
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

function commandNode(executable: string, args: readonly string[]): CompiledCommandNode {
  return {
    id: "verify",
    type: "command",
    dependsOn: [],
    command: { executable, args, timeoutMs: 10_000 },
  };
}
