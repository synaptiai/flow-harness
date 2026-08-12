import { describe, expect, it, vi } from "vitest";

import {
  createNativePrimeSdkSession,
  type NativePrimeSdkBindings,
} from "../../../src/infrastructure/prime/native-prime-agent-evaluation-driver.js";
import { NATIVE_PRIME_EVALUATION_CONFIG } from "../../../src/infrastructure/prime/native-prime-evaluation-config.js";

describe("native Prime ambient authority", () => {
  it("uses one frozen configuration for every disabled ambient feature", async () => {
    const captured: {
      settings?: Record<string, unknown>;
      session?: Record<string, unknown>;
    } = {};
    const sdkSession = {
      thinkingLevel: "off",
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      disposeAsync: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      getSessionStats: () => ({ sessionId: "ambient-test", assistantMessages: 0, toolCalls: 0 }),
      state: { messages: [] },
    };
    const authStorage = {};
    const bindings: NativePrimeSdkBindings = {
      AuthStorage: { inMemory: vi.fn(() => authStorage) },
      ModelRegistry: {
        inMemory: vi.fn(() => ({
          registerProvider: vi.fn(),
          find: vi.fn(() => ({ id: "flow-host-model", provider: "flow-host-broker" })),
          setOnOAuthProvidersReset: vi.fn(),
        })),
      },
      SettingsManager: {
        inMemory: vi.fn((settings: Record<string, unknown>) => {
          captured.settings = settings;
          return { kind: "settings" };
        }),
      },
      SessionManager: { inMemory: vi.fn(() => ({ kind: "session-manager" })) },
      createExtensionRuntime: vi.fn(() => ({ kind: "extension-runtime" })),
      createIpythonToolDefinition: vi.fn(() => ({ name: "ipython" })),
      createAssistantMessageEventStream: vi.fn(),
      createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
        captured.session = options;
        return { session: sdkSession };
      }),
    };

    const session = await createNativePrimeSdkSession({
      evaluation: evaluationInput(),
      workspace: process.cwd(),
      infer: vi.fn(),
      loadSdk: async () => bindings,
    });

    expect(Object.isFrozen(NATIVE_PRIME_EVALUATION_CONFIG)).toBe(true);
    expect(captured.settings).toEqual(NATIVE_PRIME_EVALUATION_CONFIG.settings);
    expect(captured.session).toMatchObject(NATIVE_PRIME_EVALUATION_CONFIG.sessionOptions);
    expect(captured.session).not.toHaveProperty("autonomous");
    expect(captured.session).not.toHaveProperty("agentMessageController");
    expect(captured.session).not.toHaveProperty("agentObserveController");
    expect(captured.session).not.toHaveProperty("subagentRuntimeHost");

    const resourceLoader = captured.session?.resourceLoader as {
      getExtensions(): { extensions: readonly unknown[] };
      getSkills(): { skills: readonly unknown[] };
      getPrompts(): { prompts: readonly unknown[] };
      getThemes(): { themes: readonly unknown[] };
      getAgentsFiles(): { agentsFiles: readonly unknown[] };
      getAppendSystemPrompt(): readonly unknown[];
    };
    expect(resourceLoader.getExtensions().extensions).toEqual([]);
    expect(resourceLoader.getSkills().skills).toEqual([]);
    expect(resourceLoader.getPrompts().prompts).toEqual([]);
    expect(resourceLoader.getThemes().themes).toEqual([]);
    expect(resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(resourceLoader.getAppendSystemPrompt()).toEqual([]);

    await session.dispose();
  });
});

function evaluationInput() {
  return {
    planDigest: "a".repeat(64),
    trial: {
      trialId: `trial-${"b".repeat(48)}`,
      position: 1,
      taskId: "ambient",
      profileId: "prime",
      seed: 1,
      repetition: 1,
    },
    workspace: {
      workspaceId: "workspace-ambient",
      cwd: process.cwd(),
      backend: "reflink-copy-v1" as const,
      snapshotDigest: "c".repeat(64),
    },
    instruction: { path: "TASK.md", sha256: "d".repeat(64) },
    controls: {
      model: { provider: "test", id: "test", thinking: "off" as const },
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
