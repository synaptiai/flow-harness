import { describe, expect, it, vi } from "vitest";

import {
  ExternalHarnessProtocolSession,
  signExternalHarnessParentFrame,
} from "../../../../src/domain/evaluation/external-harness-protocol.js";
import {
  createNativePrimeSdkSession,
  loadNativePrimeSdk,
  type NativePrimeSdkBindings,
  type NativePrimeSession,
  nativePrimeDriverFailureDiagnostic,
  runNativePrimeDriverProtocol,
  runNativePrimeEvaluationSession,
} from "../../../../src/infrastructure/prime/native-prime-agent-evaluation-driver.js";

const driverSessionId = "018f4ee8-9d67-7ca1-a31f-4f3f2388e934";
const driverSecret = "1".repeat(64);

describe("native Prime evaluation driver", () => {
  it("disposes one closed SDK session without an invented auth-storage cleanup", async () => {
    const sdkSession = {
      thinkingLevel: "off",
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      disposeAsync: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      getSessionStats: () => ({
        sessionId: "sdk-session",
        assistantMessages: 1,
        toolCalls: 1,
      }),
      state: { messages: [{ role: "assistant", stopReason: "stop" as const }] },
    };
    const calls: {
      provider?: Record<string, unknown>;
      settings?: Record<string, unknown>;
      provisioner?: {
        readonly cwd: string;
        readonly options: Record<string, unknown>;
        readonly instance: unknown;
      };
      ipython?: { readonly cwd: string; readonly options: Record<string, unknown> };
      session?: Record<string, unknown>;
    } = {};
    const disposeProvisioner = vi.fn(async () => undefined);
    class FakeIpythonKernelProvisioner {
      constructor(cwd: string, options: Record<string, unknown>) {
        calls.provisioner = { cwd, options, instance: this };
      }

      dispose = disposeProvisioner;
    }
    const model = { id: "flow-host-model", provider: "flow-host-broker" };
    const authStorage = {};
    const modelRegistry = {
      registerProvider: vi.fn((_name: string, provider: Record<string, unknown>) => {
        calls.provider = provider;
      }),
      find: vi.fn(() => model),
      setOnOAuthProvidersReset: vi.fn(),
    };
    const bindings = {
      AuthStorage: { inMemory: vi.fn(() => authStorage) },
      ModelRegistry: { inMemory: vi.fn(() => modelRegistry) },
      SettingsManager: {
        inMemory: vi.fn((settings: Record<string, unknown>) => {
          calls.settings = settings;
          return { kind: "settings" };
        }),
      },
      SessionManager: { inMemory: vi.fn(() => ({ kind: "session-manager" })) },
      IpythonKernelProvisioner: FakeIpythonKernelProvisioner,
      createExtensionRuntime: vi.fn(() => ({ kind: "extension-runtime" })),
      createIpythonToolDefinition: vi.fn((cwd: string, options: Record<string, unknown>) => {
        calls.ipython = { cwd, options };
        return { name: "ipython" };
      }),
      createAssistantMessageEventStream: vi.fn(),
      createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
        calls.session = options;
        return { session: sdkSession };
      }),
    };

    const session = await createNativePrimeSdkSession({
      evaluation: evaluationInput(),
      workspace: process.cwd(),
      infer: vi.fn(),
      loadSdk: async () => bindings,
    });

    expect(calls.settings).toEqual({
      compaction: { enabled: false, agentCallable: false },
      autoRefine: { enabled: false },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      enableSkillCommands: false,
      enableBuiltinSkills: false,
      mcpServers: {},
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    });
    expect(calls.ipython).toEqual({
      cwd: process.cwd(),
      options: { provisioner: calls.provisioner?.instance },
    });
    expect(calls.provisioner).toMatchObject({
      cwd: process.cwd(),
      options: { python: "/opt/flow/bin/flow-prime-kernel-proxy" },
    });
    expect(calls.session).toMatchObject({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      model,
      thinkingLevel: "off",
      noTools: "all",
      tools: [],
      customTools: [{ name: "ipython" }],
      initialActiveToolNames: ["ipython"],
      allowedToolNames: ["ipython"],
      includeGoals: false,
      includeCompactSkill: false,
      rlmDepth: 0,
      rlmMaxDepth: 0,
      prewarmIpythonKernel: false,
      serializedRefine: false,
    });
    expect(calls.session?.autonomous).toBeUndefined();
    expect(calls.session?.agentMessageController).toBeUndefined();
    expect(calls.session?.agentObserveController).toBeUndefined();
    expect(calls.session?.subagentRuntimeHost).toBeUndefined();
    expect(calls.provider).toMatchObject({
      api: "flow-host-inference-v1",
      baseUrl: "flow://host-inference",
      apiKey: "flow-internal-broker",
    });

    await session.prompt("Complete the task.");
    expect(sdkSession.prompt).toHaveBeenCalledWith("Complete the task.", {
      expandPromptTemplates: false,
      internalPrompt: true,
      suppressAutonomousContinuation: true,
    });
    await session.dispose();
    expect(sdkSession.disposeAsync).toHaveBeenCalledOnce();
    expect(disposeProvisioner).toHaveBeenCalledOnce();
  });

  it("rejects a Prime thinking-level clamp before the task starts", async () => {
    const fixture = sdkFixture({ thinkingLevel: "off" });
    const evaluation = evaluationInput("medium");

    await expect(
      createNativePrimeSdkSession({
        evaluation,
        workspace: process.cwd(),
        infer: vi.fn(),
        loadSdk: async () => fixture.bindings,
      }),
    ).rejects.toThrow(/thinking level.*off.*medium/i);

    expect(fixture.session.prompt).not.toHaveBeenCalled();
    expect(fixture.session.disposeAsync).toHaveBeenCalledOnce();
    expect(fixture.disposeProvisioner).toHaveBeenCalledOnce();
  });

  it("settles the custom IPython provisioner when SDK session disposal rejects", async () => {
    const disposalError = new Error("PRIVATE_SDK_DISPOSAL_CANARY");
    const fixture = sdkFixture({ thinkingLevel: "off", sessionDisposeError: disposalError });
    const session = await createNativePrimeSdkSession({
      evaluation: evaluationInput(),
      workspace: process.cwd(),
      infer: vi.fn(),
      loadSdk: async () => fixture.bindings,
    });

    await expect(session.dispose()).rejects.toBe(disposalError);

    expect(fixture.session.disposeAsync).toHaveBeenCalledOnce();
    expect(fixture.disposeProvisioner).toHaveBeenCalledOnce();
  });

  it("settles the custom IPython provisioner when SDK session creation rejects", async () => {
    const fixture = sdkFixture({ thinkingLevel: "off" });

    await expect(
      createNativePrimeSdkSession({
        evaluation: evaluationInput(),
        workspace: process.cwd(),
        infer: vi.fn(),
        loadSdk: async () => ({
          ...fixture.bindings,
          createAgentSession: (): never => {
            throw new Error("PRIVATE_SESSION_CREATION_CANARY");
          },
        }),
      }),
    ).rejects.toThrow("PRIVATE_SESSION_CREATION_CANARY");

    expect(fixture.disposeProvisioner).toHaveBeenCalledOnce();
  });

  it("runs one in-memory IPython-only session and records proven activity", async () => {
    const session = fakeSession();
    const createSession = vi.fn(async () => session);

    const result = await runNativePrimeEvaluationSession({
      evaluation: evaluationInput(),
      instructionText: "Create RESULT.md with DONE.",
      infer: vi.fn(),
      createSession,
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("Create RESULT.md with DONE."),
    );
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      harness: { outcome: "completed", runId: "prime-session", reason: null },
      metrics: {
        costUsdMicros: null,
        inputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
        turns: 2,
        toolCalls: 1,
        toolErrors: 0,
        wallTimeMs: expect.any(Number),
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
      },
    });
  });

  it("counts tool failures and keeps provider errors as harness failures", async () => {
    const session = fakeSession({ promptError: new Error("provider failed"), toolError: true });

    const result = await runNativePrimeEvaluationSession({
      evaluation: evaluationInput(),
      instructionText: "Complete the task.",
      infer: vi.fn(),
      createSession: async () => session,
    });

    expect(result).toMatchObject({
      harness: { outcome: "failed", runId: "prime-session", reason: "provider failed" },
      metrics: { toolErrors: 1 },
    });
  });

  it("aborts the session and returns cancelled evidence", async () => {
    const controller = new AbortController();
    const session = fakeSession({ onPrompt: () => controller.abort(new Error("operator stop")) });

    const result = await runNativePrimeEvaluationSession({
      evaluation: evaluationInput(),
      instructionText: "Complete the task.",
      infer: vi.fn(),
      signal: controller.signal,
      createSession: async () => session,
    });

    expect(session.abort).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      harness: { outcome: "cancelled", runId: "prime-session", reason: "operator stop" },
    });
  });

  it("uses one signed private channel for host inference", async () => {
    const evaluation = evaluationInput();
    const hello = signExternalHarnessParentFrame(
      {
        version: 1,
        sequence: 1,
        sessionId: driverSessionId,
        type: "hello",
        payload: {
          secretHex: driverSecret,
          trialId: `trial-${"b".repeat(48)}`,
          identityDigest: "e".repeat(64),
          evaluation,
          instructionText: "Create RESULT.md.",
        },
      },
      driverSecret,
    );
    const written: string[] = [];
    const writtenTypes: string[] = [];
    const verifier = new ExternalHarnessProtocolSession({
      sessionId: driverSessionId,
      secretHex: driverSecret,
      trialId: `trial-${"b".repeat(48)}`,
      identityDigest: "e".repeat(64),
    });
    let response: string | undefined;
    const lines: AsyncIterator<string> = {
      next: vi.fn(async () => {
        if (written.length === 0) {
          return { done: false as const, value: JSON.stringify(hello) };
        }
        if (response !== undefined) {
          const value = response;
          response = undefined;
          return { done: false as const, value };
        }
        return { done: true as const, value: undefined };
      }),
    };
    const createSession = vi.fn(async (input) => {
      const session = fakeSession({
        onPrompt: async () => {
          await input.infer('{"version":1,"context":{"messages":[]}}');
        },
      });
      return session;
    });

    await runNativePrimeDriverProtocol({
      lines,
      writeLine: async (line) => {
        written.push(line);
        const frame = verifier.acceptDriverLine(line);
        writtenTypes.push(frame.type);
        if (frame.type === "inference_request") {
          response = JSON.stringify(
            signExternalHarnessParentFrame(
              {
                version: 1,
                sequence: 2,
                sessionId: driverSessionId,
                type: "inference_response",
                payload: {
                  requestId: frame.requestId,
                  body: '{"message":"done"}',
                  bodySha256: "2a3a04956a267fc530b0f7d2fa341408676db3eaeacbfccd2f1d1bf84971f21d",
                },
              },
              driverSecret,
            ),
          );
          verifier.completeInference(frame.requestId);
        }
      },
      createSession,
    });

    expect(written).toHaveLength(3);
    expect(writtenTypes).toEqual(["ready", "inference_request", "terminal"]);
    expect(createSession).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "supervisor input",
      expected: "Prime driver stage failure: read-supervisor-input",
      run: () =>
        runNativePrimeDriverProtocol({
          lines: {
            next: async () => {
              throw new Error("PRIVATE_INPUT_CANARY");
            },
          },
          writeLine: vi.fn(),
        }),
    },
    {
      name: "supervisor output",
      expected: "Prime driver stage failure: write-supervisor-output",
      run: () =>
        runNativePrimeDriverProtocol({
          lines: oneLine(driverHello()),
          writeLine: async () => {
            throw new Error("PRIVATE_OUTPUT_CANARY");
          },
        }),
    },
    {
      name: "SDK session creation",
      expected: "Prime driver stage failure: create-sdk-session",
      run: () =>
        runNativePrimeDriverProtocol({
          lines: oneLine(driverHello()),
          writeLine: async () => undefined,
          createSession: async () => {
            throw new Error("PRIVATE_SESSION_CANARY");
          },
        }),
    },
    {
      name: "SDK session disposal",
      expected: "Prime driver stage failure: dispose-sdk-session",
      run: () =>
        runNativePrimeDriverProtocol({
          lines: oneLine(driverHello()),
          writeLine: async () => undefined,
          createSession: async () =>
            fakeSession({ disposeError: new Error("PRIVATE_DISPOSAL_CANARY") }),
        }),
    },
    {
      name: "SDK loading",
      expected: "Prime driver stage failure: load-sdk",
      run: () =>
        createNativePrimeSdkSession({
          evaluation: evaluationInput(),
          workspace: process.cwd(),
          infer: vi.fn(),
          loadSdk: async () => {
            throw new Error("PRIVATE_SDK_CANARY");
          },
        }),
    },
    {
      name: "workspace resolution",
      expected: "Prime driver stage failure: resolve-workspace",
      run: () => {
        const evaluation = evaluationInput();
        return runNativePrimeEvaluationSession({
          evaluation: {
            ...evaluation,
            workspace: {
              ...evaluation.workspace,
              cwd: `${process.cwd()}/PRIVATE_MISSING_WORKSPACE_CANARY`,
            },
          },
          instructionText: "Complete the task.",
          infer: vi.fn(),
          createSession: async () => fakeSession(),
        });
      },
    },
    {
      name: "SDK authority initialization",
      expected: "Prime driver stage failure: initialize-sdk",
      run: () => {
        const fixture = sdkFixture({ thinkingLevel: "off" });
        return createNativePrimeSdkSession({
          evaluation: evaluationInput(),
          workspace: process.cwd(),
          infer: vi.fn(),
          loadSdk: async () => ({
            ...fixture.bindings,
            AuthStorage: {
              inMemory: () => {
                throw new Error("PRIVATE_AUTHORITY_CANARY");
              },
            },
          }),
        });
      },
    },
    {
      name: "IPython tool creation",
      expected: "Prime driver stage failure: create-ipython-tool",
      run: () => {
        const fixture = sdkFixture({ thinkingLevel: "off" });
        return createNativePrimeSdkSession({
          evaluation: evaluationInput(),
          workspace: process.cwd(),
          infer: vi.fn(),
          loadSdk: async () => ({
            ...fixture.bindings,
            createIpythonToolDefinition: () => {
              throw new Error("PRIVATE_IPYTHON_CANARY");
            },
          }),
        });
      },
    },
    {
      name: "SDK session validation",
      expected: "Prime driver stage failure: validate-sdk-session",
      run: () => {
        const fixture = sdkFixture({ thinkingLevel: "off" });
        return createNativePrimeSdkSession({
          evaluation: evaluationInput("medium"),
          workspace: process.cwd(),
          infer: vi.fn(),
          loadSdk: async () => fixture.bindings,
        });
      },
    },
    {
      name: "SDK session observation",
      expected: "Prime driver stage failure: observe-sdk-session",
      run: () =>
        runNativePrimeEvaluationSession({
          evaluation: evaluationInput(),
          instructionText: "Complete the task.",
          infer: vi.fn(),
          createSession: async () =>
            fakeSession({ statsError: new Error("PRIVATE_OBSERVATION_CANARY") }),
        }),
    },
  ])("publishes one closed diagnostic for $name failure", async ({ expected, run }) => {
    const error = await run().catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(nativePrimeDriverFailureDiagnostic(error)).toBe(expected);
    expect(nativePrimeDriverFailureDiagnostic(error)).not.toContain("PRIVATE");
  });

  it.each([
    {
      name: "agent SDK",
      expected: "Prime driver stage failure: load-agent-sdk",
      loaders: {
        loadAgentSdk: vi.fn(async (): Promise<never> => {
          throw new Error("PRIVATE_AGENT_SDK_CANARY");
        }),
        loadAiSdk: vi.fn(async (): Promise<never> => {
          throw new Error("later loader must not run");
        }),
      },
      expectedAiLoads: 0,
    },
    {
      name: "AI SDK",
      expected: "Prime driver stage failure: load-ai-sdk",
      loaders: {
        loadAgentSdk: vi.fn(async () => sdkFixture({ thinkingLevel: "off" }).bindings),
        loadAiSdk: vi.fn(async (): Promise<never> => {
          throw new Error("PRIVATE_AI_SDK_CANARY");
        }),
      },
      expectedAiLoads: 1,
    },
  ])("publishes one closed diagnostic for $name import failure", async (testCase) => {
    const error = await loadNativePrimeSdk(testCase.loaders).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(nativePrimeDriverFailureDiagnostic(error)).toBe(testCase.expected);
    expect(nativePrimeDriverFailureDiagnostic(error)).not.toContain("PRIVATE");
    expect(testCase.loaders.loadAiSdk).toHaveBeenCalledTimes(testCase.expectedAiLoads);
  });

  it("uses one fixed diagnostic for an unclassified driver rejection", () => {
    expect(nativePrimeDriverFailureDiagnostic("PRIVATE_UNKNOWN_CANARY")).toBe(
      "Prime driver stage failure: unexpected",
    );
  });
});

function fakeSession(
  options: {
    readonly promptError?: Error;
    readonly toolError?: boolean;
    readonly onPrompt?: () => void | Promise<void>;
    readonly disposeError?: Error;
    readonly statsError?: Error;
  } = {},
): NativePrimeSession & {
  readonly prompt: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
} {
  let listener:
    | ((event: { readonly type: string; readonly isError?: boolean }) => void)
    | undefined;
  return {
    prompt: vi.fn(async () => {
      await options.onPrompt?.();
      if (options.toolError === true) {
        listener?.({ type: "tool_execution_end", isError: true });
      }
      if (options.promptError !== undefined) {
        throw options.promptError;
      }
    }),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(async () => {
      if (options.disposeError !== undefined) {
        throw options.disposeError;
      }
    }),
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    getSessionStats: () => {
      if (options.statsError !== undefined) {
        throw options.statsError;
      }
      return {
        sessionId: "prime-session",
        assistantMessages: 2,
        toolCalls: 1,
      };
    },
    lastAssistantMessage: () => ({ stopReason: "stop" }),
  };
}

function driverHello(): string {
  return JSON.stringify(
    signExternalHarnessParentFrame(
      {
        version: 1,
        sequence: 1,
        sessionId: driverSessionId,
        type: "hello",
        payload: {
          secretHex: driverSecret,
          trialId: `trial-${"b".repeat(48)}`,
          identityDigest: "e".repeat(64),
          evaluation: evaluationInput(),
          instructionText: "Complete the task.",
        },
      },
      driverSecret,
    ),
  );
}

function oneLine(value: string): AsyncIterator<string> {
  let available = true;
  return {
    next: async () => {
      if (available) {
        available = false;
        return { done: false as const, value };
      }
      return { done: true as const, value: undefined };
    },
  };
}

function sdkFixture(options: {
  readonly thinkingLevel: string;
  readonly sessionDisposeError?: Error;
}) {
  const authStorage = {};
  const disposeProvisioner = vi.fn(async () => undefined);
  const session = {
    thinkingLevel: options.thinkingLevel,
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    disposeAsync: vi.fn(async () => {
      if (options.sessionDisposeError !== undefined) {
        throw options.sessionDisposeError;
      }
    }),
    subscribe: vi.fn(() => () => undefined),
    getSessionStats: () => ({
      sessionId: "sdk-session",
      assistantMessages: 0,
      toolCalls: 0,
    }),
    state: { messages: [] },
  };
  const modelRegistry = {
    registerProvider: vi.fn(),
    find: vi.fn(() => ({ id: "flow-host-model", provider: "flow-host-broker" })),
    setOnOAuthProvidersReset: vi.fn(),
  };
  const bindings: NativePrimeSdkBindings = {
    AuthStorage: { inMemory: vi.fn(() => authStorage) },
    ModelRegistry: { inMemory: vi.fn(() => modelRegistry) },
    SettingsManager: { inMemory: vi.fn(() => ({})) },
    SessionManager: { inMemory: vi.fn(() => ({})) },
    IpythonKernelProvisioner: class {
      dispose = disposeProvisioner;
    },
    createExtensionRuntime: vi.fn(() => ({})),
    createIpythonToolDefinition: vi.fn(() => ({ name: "ipython" })),
    createAssistantMessageEventStream: vi.fn(),
    createAgentSession: vi.fn(async () => ({ session })),
  };
  return { bindings, session, disposeProvisioner };
}

function evaluationInput(
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" = "off",
) {
  return {
    planDigest: "a".repeat(64),
    trial: {
      trialId: `trial-${"b".repeat(48)}`,
      position: 1,
      taskId: "task",
      profileId: "prime",
      seed: 7,
      repetition: 1,
    },
    workspace: {
      workspaceId: `workspace-trial-${"b".repeat(48)}`,
      cwd: process.cwd(),
      backend: "reflink-copy-v1" as const,
      snapshotDigest: "c".repeat(64),
    },
    instruction: { path: "TASK.md", sha256: "d".repeat(64) },
    controls: {
      model: { provider: "test-provider", id: "test-model", thinking },
      budget: {
        maxNodeStarts: 8,
        maxModelTokens: 4_096,
        maxCostUsdMicros: 100_000,
        maxExecutionMs: 30_000,
        maxArtifactBytes: 1_048_576,
      },
      network: "deny" as const,
      retry: { providerRetries: 0 as const, harnessRetries: 0 as const },
    },
  };
}
