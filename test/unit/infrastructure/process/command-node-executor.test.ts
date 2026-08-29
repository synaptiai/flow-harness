import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { ArtifactStore } from "../../../../src/application/artifact-store.js";
import {
  type CommandSandbox,
  CommandSandboxExecutionError,
  type CommandSandboxExecutionStage,
  type CommandSandboxRequest,
  type ManagedCommandExecutionInput,
  type PreparedCommand,
} from "../../../../src/application/command-sandbox.js";
import type {
  AgentCommandExecutionContext,
  NodeExecutionContext,
} from "../../../../src/application/ports.js";
import { normalizeAgentCommandRequest } from "../../../../src/domain/agent-command.js";
import {
  createArtifactReference,
  MAX_COMMAND_ARTIFACT_BYTES,
} from "../../../../src/domain/artifact/reference.js";
import type { SandboxEvidence } from "../../../../src/domain/run/events.js";
import type { CompiledCommandNode } from "../../../../src/domain/workflow/types.js";
import { LocalArtifactStore } from "../../../../src/infrastructure/fs/local-artifact-store.js";
import { CommandNodeExecutor } from "../../../../src/infrastructure/process/command-node-executor.js";

const sandboxEvidence: SandboxEvidence = {
  backend: "anthropic-sandbox-runtime",
  backendVersion: "test",
  profile: "workspace-write-network-deny-v1",
  policyDigest: "a".repeat(64),
};

const context = {
  runId: "sandbox-run",
  workflowId: "sandbox-workflow",
  attempt: 1,
  cwd: process.cwd(),
  protectedPaths: [process.cwd()],
} satisfies NodeExecutionContext;

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

  it("does not pass holdout stdin through the agent-command boundary", async () => {
    const run = vi.fn(async (input: ManagedCommandExecutionInput) => {
      input.stdout(Buffer.from(input.stdin === undefined ? "no-stdin" : "stdin-present"));
      return { exitCode: 0 };
    });
    const executor = new CommandNodeExecutor({
      sandbox: { prepare: async () => managedPrepared(run, async () => undefined) },
    });

    const outcome = await executor.executeAgentCommand(
      normalizeAgentCommandRequest({ executable: "npm", args: ["test"], timeoutMs: 10_000 }),
      {
        ...context,
        commandStdin: Buffer.from("unbound private input", "utf8"),
      } as unknown as Parameters<CommandNodeExecutor["executeAgentCommand"]>[1],
    );

    expect(outcome).toMatchObject({ status: "succeeded", evidence: { stdout: "no-stdin" } });
    expect(outcome.evidence).not.toHaveProperty("stdinHash");
  });

  it("streams one frozen private input to stdin and records only its digest", async () => {
    const privateInput = Buffer.from("private holdout program\n", "utf8");
    const expectedHash = createHash("sha256").update(privateInput).digest("hex");
    const sandbox = new FakeCommandSandbox({
      processContainment: "process-group",
      launch: {
        executable: process.execPath,
        args: [
          "-e",
          'let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>process.stdout.write(input==="private holdout program\\n"?"accepted":"rejected"));',
        ],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      evidence: sandboxEvidence,
    });
    const executor = new CommandNodeExecutor({ sandbox });

    const execution = executor.execute(commandNode("python3", ["-"]), {
      ...context,
      commandStdin: privateInput,
    });
    privateInput.fill(0);
    const outcome = await execution;

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        executable: "python3",
        args: ["-"],
        stdinHash: expectedHash,
        stdout: "accepted",
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("private holdout program");
  });

  it("fails when a native child exits before a large private input settles", async () => {
    const privateInput = Buffer.alloc(1_048_576, 0x61);
    const sandbox = new FakeCommandSandbox({
      processContainment: "process-group",
      launch: {
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      evidence: sandboxEvidence,
    });
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(commandNode("python3", ["-"]), {
      ...context,
      commandStdin: privateInput,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "command_stdin_failed",
        sideEffectStatus: "uncertain",
      },
    });
    expect(outcome.evidence).not.toHaveProperty("stdinHash");
  });

  it("passes one copied private input through a managed sandbox boundary", async () => {
    const privateInput = Buffer.from("managed private input\n", "utf8");
    const run = vi.fn(async (input: ManagedCommandExecutionInput) => {
      input.stdout(Buffer.from(input.stdin ?? []));
      return { exitCode: 0 };
    });
    const sandbox: CommandSandbox = {
      prepare: async () => managedPrepared(run, async () => undefined),
    };
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(commandNode("python3", ["-"]), {
      ...context,
      commandStdin: privateInput,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        stdinHash: createHash("sha256").update(privateInput).digest("hex"),
        stdout: "managed private input\n",
      },
    });
  });

  it("retains exact oversized agent-command output while preserving its bounded preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-command-artifact-"));
    try {
      const store = new LocalArtifactStore(root);
      const sandbox = new FakeCommandSandbox({
        processContainment: "linux-pid-namespace",
        launch: {
          executable: process.execPath,
          args: [
            "-e",
            'process.stdout.write("oversized exact output"); process.stderr.write("stderr exact output")',
          ],
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        },
        evidence: sandboxEvidence,
      });
      const executor = new CommandNodeExecutor({ sandbox, maxOutputBytes: 4 });
      const artifactContext: AgentCommandExecutionContext = {
        ...context,
        nodeId: "agent",
        artifactStore: store,
        agentCommandArtifactProducer: {
          kind: "agent-command",
          runId: context.runId,
          workflowId: context.workflowId,
          nodeId: "agent",
          attempt: context.attempt,
          commandId: "command-7",
          commandSequence: 1,
        },
      };

      const outcome = await executor.executeAgentCommand(
        normalizeAgentCommandRequest({ executable: "npm", args: ["test"], timeoutMs: 10_000 }),
        artifactContext,
      );

      expect(outcome).toMatchObject({
        status: "succeeded",
        evidence: {
          stdout: "over",
          stdoutTruncated: true,
          stdoutArtifact: {
            reference: expect.stringMatching(/^artifact:[a-f0-9]{64}$/),
            descriptor: {
              size: 22,
              mediaType: "application/octet-stream",
            },
            producer: {
              runId: context.runId,
              nodeId: "agent",
              commandId: "command-7",
              stream: "stdout",
            },
          },
          stderr: "stde",
          stderrTruncated: true,
          stderrArtifact: {
            reference: expect.stringMatching(/^artifact:[a-f0-9]{64}$/),
            descriptor: {
              size: 19,
              mediaType: "application/octet-stream",
            },
            producer: {
              runId: context.runId,
              nodeId: "agent",
              commandId: "command-7",
              stream: "stderr",
            },
          },
        },
      });
      if (
        outcome.evidence === null ||
        outcome.evidence.stdoutArtifact === undefined ||
        outcome.evidence.stderrArtifact === undefined
      ) {
        throw new Error("test command did not retain both output streams");
      }
      expect(outcome.evidence.stderrArtifact.reference).not.toBe(
        outcome.evidence.stdoutArtifact.reference,
      );
      await expect(
        store.read({
          reference: outcome.evidence.stdoutArtifact.reference,
          runId: context.runId,
          offset: 0,
          maxBytes: 32,
        }),
      ).resolves.toMatchObject({ bytes: Buffer.from("oversized exact output", "utf8") });
      await expect(
        store.read({
          reference: outcome.evidence.stderrArtifact.reference,
          runId: context.runId,
          offset: 0,
          maxBytes: 32,
        }),
      ).resolves.toMatchObject({ bytes: Buffer.from("stderr exact output", "utf8") });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "exact bound",
      chunks: [MAX_COMMAND_ARTIFACT_BYTES / 2, MAX_COMMAND_ARTIFACT_BYTES / 2],
      retained: true,
    },
    {
      name: "plus one",
      chunks: [MAX_COMMAND_ARTIFACT_BYTES / 2, MAX_COMMAND_ARTIFACT_BYTES / 2 + 1],
      retained: false,
    },
  ])("keeps artifact capture complete at the $name", async ({ chunks, retained }) => {
    const root = await mkdtemp(join(tmpdir(), "flow-command-artifact-bound-"));
    try {
      const store = new LocalArtifactStore(root);
      const run = async (input: ManagedCommandExecutionInput) => {
        for (const bytes of chunks) input.stdout(Buffer.alloc(bytes, 0x61));
        return { exitCode: 0 };
      };
      const sandbox: CommandSandbox = {
        prepare: async () => managedPrepared(run, async () => undefined),
      };
      const executor = new CommandNodeExecutor({ sandbox, maxOutputBytes: 4 });
      const artifactContext: AgentCommandExecutionContext = {
        ...context,
        nodeId: "agent",
        artifactStore: store,
        agentCommandArtifactProducer: {
          kind: "agent-command",
          runId: context.runId,
          workflowId: context.workflowId,
          nodeId: "agent",
          attempt: context.attempt,
          commandId: `command-${retained ? "exact" : "over"}`,
          commandSequence: 1,
        },
      };

      const outcome = await executor.executeAgentCommand(
        normalizeAgentCommandRequest({ executable: "npm", args: ["test"], timeoutMs: 10_000 }),
        artifactContext,
      );

      expect(outcome).toMatchObject({
        status: "succeeded",
        evidence: {
          stdout: "aaaa",
          stdoutTruncated: true,
          ...(retained
            ? { stdoutArtifact: { descriptor: { size: MAX_COMMAND_ARTIFACT_BYTES } } }
            : {}),
        },
      });
      expect(outcome.evidence?.stdoutArtifact === undefined).toBe(!retained);
      expect(await store.list()).toHaveLength(retained ? 1 : 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("uses managed sandbox execution without treating launcher control output as task evidence", async () => {
    const release = vi.fn(async () => undefined);
    const run = vi.fn(
      async (input: {
        readonly signal: AbortSignal;
        stdout(chunk: Uint8Array): void;
        stderr(chunk: Uint8Array): void;
      }) => {
        input.stdout(Buffer.from("TASK_STDOUT"));
        input.stderr(Buffer.from("TASK_STDERR"));
        return { exitCode: 125 };
      },
    );
    const prepared = {
      processContainment: "linux-pid-namespace",
      launch: {
        executable: "/PRIVATE_DOCKER_CONTROL_LAUNCHER",
        args: ["start", "PRIVATE_CONTAINER_ID"],
        env: {},
      },
      evidence: sandboxEvidence,
      run,
      release,
    } as unknown as PreparedCommand;
    const sandbox: CommandSandbox = { prepare: async () => prepared };
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(commandNode("node", ["task.js"]), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_failed", message: "command exited with code 125" },
      evidence: {
        executable: "node",
        args: ["task.js"],
        exitCode: 125,
        stdout: "TASK_STDOUT",
        stderr: "TASK_STDERR",
      },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 1.5, 256])(
    "rejects invalid managed exit code %s with retained task evidence",
    async (exitCode) => {
      const release = vi.fn(async () => undefined);
      const run = vi.fn(async (input: ManagedCommandExecutionInput) => {
        input.stderr(Buffer.from("PARTIAL_TASK_STDERR"));
        return { exitCode };
      });
      const sandbox: CommandSandbox = {
        prepare: async () => managedPrepared(run, release),
      };
      const executor = new CommandNodeExecutor({ sandbox });

      const outcome = await executor.execute(commandNode("node", ["task.js"]), context);

      expect(outcome).toMatchObject({
        status: "failed",
        error: {
          code: "command_sandbox_unavailable",
          message: "Command sandbox execution failed during run managed execution",
          sideEffectStatus: "uncertain",
        },
        evidence: {
          exitCode: null,
          stderr: "PARTIAL_TASK_STDERR",
          terminationStatus: "confirmed",
        },
      });
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("uses the command deadline to cancel managed execution and retains partial task output", async () => {
    let observedSignal: AbortSignal | undefined;
    const release = vi.fn(async () => undefined);
    const run = vi.fn<NonNullable<PreparedCommand["run"]>>(async (input) => {
      observedSignal = input.signal;
      input.stdout(Buffer.from("PARTIAL_TASK_STDOUT"));
      return await new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(input.signal.reason ?? new Error("managed execution aborted")),
          { once: true },
        );
      });
    });
    const sandbox: CommandSandbox = {
      prepare: async () => managedPrepared(run, release),
    };
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(commandNode("node", ["task.js"], 10), context);

    expect(observedSignal?.aborted).toBe(true);
    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "command_timeout",
        message: "command exceeded timeout of 10ms",
        sideEffectStatus: "uncertain",
      },
      evidence: {
        exitCode: null,
        timedOut: true,
        aborted: false,
        stdout: "PARTIAL_TASK_STDOUT",
      },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves operator cancellation across managed execution and releases its container", async () => {
    const controller = new AbortController();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = vi.fn(async () => undefined);
    const run = vi.fn<NonNullable<PreparedCommand["run"]>>(async (input) => {
      input.stderr(Buffer.from("PARTIAL_TASK_STDERR"));
      markStarted();
      return await new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(input.signal.reason ?? new Error("managed execution aborted")),
          { once: true },
        );
      });
    });
    const sandbox: CommandSandbox = {
      prepare: async () => managedPrepared(run, release),
    };
    const executor = new CommandNodeExecutor({ sandbox });
    const execution = executor.execute(commandNode("node", ["task.js"], 10_000), {
      ...context,
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error("PRIVATE_OPERATOR_CANCELLATION"));

    const outcome = await execution;

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "command_aborted",
        message: "command was cancelled",
        sideEffectStatus: "uncertain",
      },
      evidence: {
        exitCode: null,
        timedOut: false,
        aborted: true,
        stderr: "PARTIAL_TASK_STDERR",
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_OPERATOR_CANCELLATION");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("settles a cancelled agent command without publishing artifacts before the first commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-command-artifact-cancellation-"));
    try {
      const controller = new AbortController();
      const reason = new Error("PRIVATE_ARTIFACT_CANCELLATION");
      let markStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const run = vi.fn<NonNullable<PreparedCommand["run"]>>(async (input) => {
        input.stdout(Buffer.from("oversized output before cancellation"));
        markStarted();
        return await new Promise((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => reject(input.signal.reason ?? new Error("managed execution aborted")),
            { once: true },
          );
        });
      });
      const sandbox: CommandSandbox = {
        prepare: async () => managedPrepared(run, async () => undefined),
      };
      const store = new LocalArtifactStore(root);
      const executor = new CommandNodeExecutor({ sandbox, maxOutputBytes: 4 });
      const execution = executor.executeAgentCommand(
        normalizeAgentCommandRequest({ executable: "node", args: ["task.js"], timeoutMs: 10_000 }),
        {
          ...context,
          nodeId: "agent",
          signal: controller.signal,
          artifactStore: store,
          agentCommandArtifactProducer: {
            kind: "agent-command",
            runId: context.runId,
            workflowId: context.workflowId,
            nodeId: "agent",
            attempt: context.attempt,
            commandId: "command-cancelled",
            commandSequence: 1,
          },
        },
      );
      await started;
      controller.abort(reason);

      await expect(execution).resolves.toMatchObject({
        status: "failed",
        error: { code: "command_aborted" },
        evidence: {
          stdout: "over",
          stdoutTruncated: true,
        },
      });
      expect((await execution).evidence?.stdoutArtifact).toBeUndefined();
      expect(await store.list()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("settles all command artifacts independently after the first reference commits", async () => {
    const controller = new AbortController();
    const reason = new Error("PRIVATE_LATE_ARTIFACT_CANCELLATION");
    const observedSignals: Array<AbortSignal | undefined> = [];
    let retainCalls = 0;
    const artifactStore = {
      async retain(input) {
        input.signal?.throwIfAborted();
        observedSignals.push(input.signal);
        retainCalls += 1;
        if (retainCalls === 1) controller.abort(reason);
        const bytes = Buffer.from(input.bytes);
        return createArtifactReference({
          descriptor: {
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            size: bytes.length,
            mediaType: input.mediaType,
          },
          producer: input.producer,
        });
      },
    } as ArtifactStore;
    const run = vi.fn<NonNullable<PreparedCommand["run"]>>(async (input) => {
      input.stdout(Buffer.from("oversized stdout"));
      input.stderr(Buffer.from("oversized stderr"));
      return { exitCode: 0 };
    });
    const executor = new CommandNodeExecutor({
      sandbox: { prepare: async () => managedPrepared(run, async () => undefined) },
      maxOutputBytes: 4,
    });

    const outcome = await executor.executeAgentCommand(
      normalizeAgentCommandRequest({ executable: "node", args: ["task.js"], timeoutMs: 10_000 }),
      {
        ...context,
        nodeId: "agent",
        signal: controller.signal,
        artifactStore,
        agentCommandArtifactProducer: {
          kind: "agent-command",
          runId: context.runId,
          workflowId: context.workflowId,
          nodeId: "agent",
          attempt: context.attempt,
          commandId: "command-settlement",
          commandSequence: 1,
        },
      },
    );

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        stdoutArtifact: { producer: { stream: "stdout" } },
        stderrArtifact: { producer: { stream: "stderr" } },
      },
    });
    expect(observedSignals).toEqual([controller.signal, undefined]);
    expect(controller.signal.reason).toBe(reason);
  });

  it("reports managed cleanup uncertainty before a timeout outcome", async () => {
    const release = vi.fn(async () => {
      throw new Error("Container command cleanup is not proved");
    });
    const run = vi.fn<NonNullable<PreparedCommand["run"]>>(async (input) => {
      return await new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(input.signal.reason ?? new Error("managed execution aborted")),
          { once: true },
        );
      });
    });
    const sandbox: CommandSandbox = {
      prepare: async () => managedPrepared(run, release),
    };
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(commandNode("node", ["task.js"], 10), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "command_sandbox_cleanup_failed",
        message: "Container command cleanup is not proved",
        sideEffectStatus: "uncertain",
      },
      evidence: {
        exitCode: null,
        timedOut: true,
        terminationStatus: "unconfirmed",
      },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      stage: "attach execution output" as CommandSandboxExecutionStage,
      expectedSideEffectStatus: "none",
      expectedEvidence: null,
    },
    {
      stage: "wait for execution" as CommandSandboxExecutionStage,
      expectedSideEffectStatus: "uncertain",
      expectedEvidence: {
        exitCode: null,
        stdout: "PARTIAL_TASK_STDOUT",
        terminationStatus: "confirmed",
      },
    },
  ] as const)(
    "distinguishes a $stage failure from control failure after possible task start",
    async ({ stage, expectedSideEffectStatus, expectedEvidence }) => {
      const release = vi.fn(async () => undefined);
      const run = vi.fn(async (input: ManagedCommandExecutionInput) => {
        if (stage !== "attach execution output") {
          input.stdout(Buffer.from("PARTIAL_TASK_STDOUT"));
        }
        throw new CommandSandboxExecutionError(stage, new Error("PRIVATE_DOCKER_CONTROL_FAILURE"));
      });
      const sandbox: CommandSandbox = {
        prepare: async () => managedPrepared(run, release),
      };
      const executor = new CommandNodeExecutor({ sandbox });

      const outcome = await executor.execute(commandNode("node", ["task.js"]), context);

      expect(outcome).toMatchObject({
        status: "failed",
        error: {
          code: "command_sandbox_unavailable",
          message: `Command sandbox execution failed during ${stage}`,
          sideEffectStatus: expectedSideEffectStatus,
        },
        evidence: expectedEvidence,
      });
      expect(JSON.stringify(outcome)).not.toContain("PRIVATE_DOCKER_CONTROL_FAILURE");
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("retains task evidence when a managed control failure also loses cleanup certainty", async () => {
    const release = vi.fn(async () => {
      throw new Error("Container command cleanup is not proved");
    });
    const run = vi.fn(async (input: ManagedCommandExecutionInput) => {
      input.stderr(Buffer.from("PARTIAL_TASK_STDERR"));
      throw new CommandSandboxExecutionError("wait for execution");
    });
    const sandbox: CommandSandbox = {
      prepare: async () => managedPrepared(run, release),
    };
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(commandNode("node", ["task.js"]), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "command_sandbox_cleanup_failed",
        message: "Container command cleanup is not proved",
        sideEffectStatus: "uncertain",
      },
      evidence: {
        exitCode: null,
        stderr: "PARTIAL_TASK_STDERR",
        terminationStatus: "unconfirmed",
      },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, "PRIVATE_MANAGED_REJECTION", { private: "PRIVATE_OBJECT" }])(
    "closes a non-Error managed execution rejection: %j",
    async (rejection) => {
      const release = vi.fn(async () => undefined);
      const run = vi.fn<NonNullable<PreparedCommand["run"]>>(async () => {
        throw rejection;
      });
      const sandbox: CommandSandbox = {
        prepare: async () => managedPrepared(run, release),
      };
      const executor = new CommandNodeExecutor({ sandbox });

      const outcome = await executor.execute(commandNode("node", ["task.js"]), context);

      expect(outcome).toMatchObject({
        status: "failed",
        error: {
          code: "command_sandbox_unavailable",
          message: "Command sandbox execution failed during run managed execution",
          retryable: false,
          sideEffectStatus: "uncertain",
        },
        evidence: {
          exitCode: null,
          terminationStatus: "confirmed",
        },
      });
      expect(JSON.stringify(outcome)).not.toContain("PRIVATE_");
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

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

  it("preserves preparation cleanup uncertainty before process evidence exists", async () => {
    const cleanupFailure = new AggregateError(
      [new Error("PRIVATE_PREPARATION"), new Error("PRIVATE_CLEANUP")],
      "Container command preparation cleanup is not proved",
    );
    const sandbox = new FakeCommandSandbox(undefined, cleanupFailure);
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "process.exit(0)"]),
      context,
    );

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "command_sandbox_cleanup_failed",
        message: cleanupFailure.message,
        retryable: false,
        sideEffectStatus: "uncertain",
      },
      evidence: null,
    });
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
    const executor = new CommandNodeExecutor({ sandbox, preparationSettlementMs: 20 });
    const startedAt = performance.now();

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "process.exit(0)"], 10),
      context,
    );

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_timeout", sideEffectStatus: "uncertain" },
      evidence: null,
    });
  });

  it("reports a late preparation cleanup failure before returning the timeout", async () => {
    const releaseError = new Error("PRIVATE_LATE_CONTAINER_CLEANUP");
    const release = vi.fn(async () => {
      throw releaseError;
    });
    const sandbox: CommandSandbox = {
      prepare: async () =>
        await new Promise<PreparedCommand>((resolve) => {
          setTimeout(
            () =>
              resolve({
                processContainment: "linux-pid-namespace",
                launch: { executable: process.execPath, args: [], env: {} },
                evidence: sandboxEvidence,
                release,
              }),
            20,
          );
        }),
    };
    const executor = new CommandNodeExecutor({ sandbox, preparationSettlementMs: 100 });

    const outcome = await executor.execute(
      commandNode(process.execPath, ["-e", "process.exit(0)"], 5),
      context,
    );

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "command_sandbox_cleanup_failed",
        message: releaseError.message,
        retryable: false,
        sideEffectStatus: "uncertain",
      },
      evidence: null,
    });
    expect(release).toHaveBeenCalledTimes(1);
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

  it("rechecks prepared sandbox authority immediately before launcher spawn", async () => {
    const authorityError = new Error("container command runtime identity changed before launch");
    const beforeLaunch = vi.fn(async () => {
      throw authorityError;
    });
    const release = vi.fn(async () => undefined);
    const sandbox: CommandSandbox = {
      prepare: async () =>
        ({
          processContainment: "linux-pid-namespace",
          launch: {
            executable: process.execPath,
            args: ["-e", 'process.stdout.write("MUST_NOT_RUN")'],
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          },
          evidence: sandboxEvidence,
          beforeLaunch,
          release,
        }) as PreparedCommand,
    };
    const executor = new CommandNodeExecutor({ sandbox });

    const outcome = await executor.execute(commandNode("node", []), context);

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "command_sandbox_unavailable",
        message: authorityError.message,
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
    expect(beforeLaunch).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
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

function managedPrepared(
  run: NonNullable<PreparedCommand["run"]>,
  release: () => Promise<void>,
): PreparedCommand {
  return {
    processContainment: "linux-pid-namespace",
    launch: {
      executable: "/PRIVATE_DOCKER_CONTROL_LAUNCHER",
      args: ["start", "PRIVATE_CONTAINER_ID"],
      env: {},
    },
    evidence: sandboxEvidence,
    run,
    release,
  };
}
