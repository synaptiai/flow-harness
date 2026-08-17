import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { client, methods, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { FlowPresentationDocument } from "../../../../src/domain/presentation/flow-presentation.js";
import {
  createFlowAcpAgent,
  type FlowAcpAgentRuntime,
} from "../../../../src/infrastructure/acp/flow-acp-agent.js";
import { LocalAcpSessionStore } from "../../../../src/infrastructure/fs/local-acp-session-store.js";

const POLICY_DIGEST = "a".repeat(64);
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const CANCEL_ID = "20000000-0000-4000-8000-000000000002";

describe("Flow ACP agent", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("negotiates ACP v1 and binds new, list, load, and resume to one durable session", async () => {
    const harness = await createHarness(roots);
    const updates: unknown[] = [];
    const peer = client({ name: "test-editor" }).onNotification(
      methods.client.session.update,
      ({ params }) => {
        updates.push(params);
      },
    );

    await peer.connectWith(harness.agent, async (connection) => {
      await expect(
        connection.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true }, terminal: true },
          clientInfo: { name: "PRIVATE_EDITOR", version: "PRIVATE_VERSION" },
        }),
      ).resolves.toEqual({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {},
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        agentInfo: { name: "Flow", version: "0.0.0" },
      });

      await expect(
        connection.request(methods.agent.session.new, {
          cwd: harness.projectRoot,
          mcpServers: [],
        }),
      ).resolves.toEqual({ sessionId: SESSION_ID });

      await expect(
        connection.request(methods.agent.session.list, { cwd: harness.projectRoot }),
      ).resolves.toEqual({
        sessions: [
          {
            sessionId: SESSION_ID,
            cwd: harness.projectRoot,
            title: `Flow run ${SESSION_ID}`,
            updatedAt: "2026-08-17T10:00:00.000Z",
          },
        ],
      });

      await expect(
        connection.request(methods.agent.session.load, {
          sessionId: SESSION_ID,
          cwd: harness.projectRoot,
          mcpServers: [],
        }),
      ).resolves.toEqual({});
      await expect(
        connection.request(methods.agent.session.resume, {
          sessionId: SESSION_ID,
          cwd: harness.projectRoot,
          mcpServers: [],
        }),
      ).resolves.toEqual({});
    });

    expect(harness.runtime.replays).toEqual([SESSION_ID]);
    expect(updates).toContainEqual({
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "flow-run",
            description: "Start one admitted Flow workflow in this session",
            input: { hint: "<workflow source>" },
          },
          {
            name: "flow-continue",
            description: "Observe and steer the Flow run bound to this session",
          },
        ],
      },
    });
    expect(JSON.stringify(updates)).not.toContain("PRIVATE_EDITOR");
    expect(JSON.stringify(updates)).not.toContain("PRIVATE_VERSION");
  });

  it("submits one explicit workflow and maps presentation approval through the current action", async () => {
    const harness = await createHarness(roots);
    const updates: unknown[] = [];
    const permissions: unknown[] = [];
    const peer = client({ name: "test-editor" })
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params);
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        permissions.push(params);
        return {
          outcome: { outcome: "selected", optionId: "approve:approval-7" },
        };
      });

    await peer.connectWith(harness.agent, async (connection) => {
      await initialize(connection);
      await connection.request(methods.agent.session.new, {
        cwd: harness.projectRoot,
        mcpServers: [],
      });

      await expect(
        connection.request(methods.agent.session.prompt, {
          sessionId: SESSION_ID,
          prompt: [{ type: "text", text: "/flow-run workflows/release.yaml" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
    });

    expect(harness.runtime.submissions).toEqual([
      { sessionId: SESSION_ID, workflowSource: "workflows/release.yaml" },
    ]);
    expect(harness.runtime.observations).toEqual([SESSION_ID]);
    expect(harness.runtime.decisions).toEqual([
      {
        runId: SESSION_ID,
        requestId: "approval-7",
        actor: "editor-user",
        decision: "approve",
      },
    ]);
    expect(permissions).toEqual([
      {
        sessionId: SESSION_ID,
        toolCall: {
          toolCallId: "flow-approval:approval-7",
          title: "Flow approval approval-7",
          kind: "execute",
          status: "pending",
        },
        options: [
          { optionId: "approve:approval-7", name: "Approve once", kind: "allow_once" },
          { optionId: "deny:approval-7", name: "Deny once", kind: "reject_once" },
        ],
      },
    ]);
    expect(updates).toContainEqual({
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "flow-approval:approval-7",
        status: "completed",
      },
    });
    const encoded = JSON.stringify({ permissions, updates });
    expect(encoded).not.toContain("PRIVATE_RESOURCE_BASE64");
    expect(encoded).not.toContain("PRIVATE_PROVIDER_OUTPUT");
    expect(encoded).not.toContain("rawInput");
    expect(encoded).not.toContain("rawOutput");
  });

  it("accepts a project-local resource link and continues without resubmitting", async () => {
    const harness = await createHarness(roots);
    const peer = cancellingPermissionClient();

    await peer.connectWith(harness.agent, async (connection) => {
      await initialize(connection);
      await connection.request(methods.agent.session.new, {
        cwd: harness.projectRoot,
        mcpServers: [],
      });
      await connection.request(methods.agent.session.prompt, {
        sessionId: SESSION_ID,
        prompt: [
          { type: "text", text: "/flow-run" },
          {
            type: "resource_link",
            name: "release",
            uri: new URL("workflows/release.yaml", `file://${harness.projectRoot}/`).href,
          },
        ],
      });
      await connection.request(methods.agent.session.prompt, {
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "/flow-continue" }],
      });
    });

    expect(harness.runtime.submissions).toEqual([
      { sessionId: SESSION_ID, workflowSource: "workflows/release.yaml" },
    ]);
    expect(harness.runtime.observations).toEqual([SESSION_ID, SESSION_ID]);
  });

  it("rejects client authority, invalid ordering, traversal, and concurrent turns before mutation", async () => {
    const harness = await createHarness(roots, { holdObservation: true });
    const peer = cancellingPermissionClient();

    await peer.connectWith(harness.agent, async (connection) => {
      await expect(
        connection.request(methods.agent.session.new, {
          cwd: harness.projectRoot,
          mcpServers: [],
        }),
      ).rejects.toBeInstanceOf(RequestError);
      await initialize(connection);
      await expect(
        connection.request(methods.agent.session.new, {
          cwd: harness.projectRoot,
          additionalDirectories: [join(harness.projectRoot, "PRIVATE_EXTRA_ROOT")],
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ message: "Flow ACP session authority is not supported" });
      await expect(
        connection.request(methods.agent.session.new, {
          cwd: harness.projectRoot,
          mcpServers: [
            {
              name: "PRIVATE_MCP",
              command: "/PRIVATE_COMMAND",
              args: [],
              env: [],
            },
          ],
        }),
      ).rejects.toMatchObject({ message: "Flow ACP session authority is not supported" });

      await connection.request(methods.agent.session.new, {
        cwd: harness.projectRoot,
        mcpServers: [],
      });
      await expect(
        connection.request(methods.agent.session.prompt, {
          sessionId: SESSION_ID,
          prompt: [
            { type: "text", text: "/flow-run" },
            {
              type: "resource_link",
              name: "PRIVATE_LINK",
              uri: new URL("../PRIVATE_OUTSIDE.yaml", `file://${harness.projectRoot}/`).href,
            },
          ],
        }),
      ).rejects.toMatchObject({ message: "Flow ACP prompt is invalid" });

      const first = connection.request(methods.agent.session.prompt, {
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "/flow-continue" }],
      });
      await harness.runtime.observationStarted;
      await expect(
        connection.request(methods.agent.session.prompt, {
          sessionId: SESSION_ID,
          prompt: [{ type: "text", text: "/flow-continue" }],
        }),
      ).rejects.toMatchObject({ message: "Flow ACP session already has an active turn" });
      harness.runtime.releaseObservation();
      await first;
    });

    expect(JSON.stringify(harness.runtime)).not.toContain("PRIVATE_");
    expect(harness.runtime.submissions).toEqual([]);
  });

  it("maps cancel and close to one stable durable cancellation identity", async () => {
    const harness = await createHarness(roots);
    const peer = client({ name: "test-editor" });

    await peer.connectWith(harness.agent, async (connection) => {
      await initialize(connection);
      await connection.request(methods.agent.session.new, {
        cwd: harness.projectRoot,
        mcpServers: [],
      });
      await connection.notify(methods.agent.session.cancel, { sessionId: SESSION_ID });
      await connection.request(methods.agent.session.close, { sessionId: SESSION_ID });
    });

    expect(harness.runtime.cancellations).toEqual([
      { runId: SESSION_ID, commandId: CANCEL_ID, actor: "editor-user" },
      { runId: SESSION_ID, commandId: CANCEL_ID, actor: "editor-user" },
    ]);
  });

  it("settles durable cancellation before returning a cancelled active turn", async () => {
    const harness = await createHarness(roots, { holdObservation: true });
    const peer = cancellingPermissionClient();

    await peer.connectWith(harness.agent, async (connection) => {
      await initialize(connection);
      await connection.request(methods.agent.session.new, {
        cwd: harness.projectRoot,
        mcpServers: [],
      });
      const prompt = connection.request(methods.agent.session.prompt, {
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "/flow-continue" }],
      });
      await harness.runtime.observationStarted;

      await connection.notify(methods.agent.session.cancel, { sessionId: SESSION_ID });
      await harness.runtime.cancellationStarted;
      harness.runtime.releaseObservation();

      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    });

    expect(harness.runtime.cancellations).toEqual([
      { runId: SESSION_ID, commandId: CANCEL_ID, actor: "editor-user" },
    ]);
  });

  it("does not expose a private peer permission failure", async () => {
    const harness = await createHarness(roots);
    const peer = client({ name: "test-editor" }).onRequest(
      methods.client.session.requestPermission,
      () => {
        throw new RequestError(-32_000, "PRIVATE_PERMISSION_FAILURE");
      },
    );

    await peer.connectWith(harness.agent, async (connection) => {
      await initialize(connection);
      await connection.request(methods.agent.session.new, {
        cwd: harness.projectRoot,
        mcpServers: [],
      });
      const error = await connection
        .request(methods.agent.session.prompt, {
          sessionId: SESSION_ID,
          prompt: [{ type: "text", text: "/flow-continue" }],
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RequestError);
      expect(error).toMatchObject({ message: "Cannot process Flow ACP prompt" });
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain("PRIVATE_PERMISSION_FAILURE");
    });
  });
});

async function initialize(connection: {
  request: (method: "initialize", params: { protocolVersion: number }) => Promise<unknown>;
}): Promise<void> {
  await connection.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
}

async function createHarness(
  roots: string[],
  options: { readonly holdObservation?: boolean } = {},
): Promise<{
  readonly agent: ReturnType<typeof createFlowAcpAgent>;
  readonly projectRoot: string;
  readonly runtime: RuntimeHarness;
}> {
  const root = await mkdtemp(join(tmpdir(), "flow-acp-agent-"));
  roots.push(root);
  const projectRoot = await realpath(root);
  const runtime = new RuntimeHarness(options.holdObservation ?? false);
  const agent = createFlowAcpAgent({
    sessionStore: new LocalAcpSessionStore(root),
    projectRoot,
    policyDigest: POLICY_DIGEST,
    actor: "editor-user",
    version: "0.0.0",
    createSessionId: () => SESSION_ID,
    createCancellationCommandId: () => CANCEL_ID,
    now: () => "2026-08-17T10:00:00.000Z",
    runtime,
  });
  return { agent, projectRoot, runtime };
}

class RuntimeHarness implements FlowAcpAgentRuntime {
  readonly submissions: Array<{ sessionId: string; workflowSource: string }> = [];
  readonly observations: string[] = [];
  readonly replays: string[] = [];
  readonly decisions: unknown[] = [];
  readonly cancellations: unknown[] = [];
  readonly observationStarted: Promise<void>;
  readonly cancellationStarted: Promise<void>;
  readonly #holdObservation: boolean;
  readonly #markObservationStarted: () => void;
  readonly #observationRelease: Promise<void>;
  readonly #releaseObservation: () => void;
  readonly #markCancellationStarted: () => void;

  constructor(holdObservation: boolean) {
    this.#holdObservation = holdObservation;
    const started = deferred();
    this.observationStarted = started.promise;
    this.#markObservationStarted = started.resolve;
    const release = deferred();
    this.#observationRelease = release.promise;
    this.#releaseObservation = release.resolve;
    const cancellation = deferred();
    this.cancellationStarted = cancellation.promise;
    this.#markCancellationStarted = cancellation.resolve;
  }

  async submit(input: {
    readonly sessionId: string;
    readonly workflowSource: string;
  }): Promise<void> {
    this.submissions.push({ sessionId: input.sessionId, workflowSource: input.workflowSource });
  }

  async observe(input: {
    readonly sessionId: string;
    readonly render: (document: FlowPresentationDocument) => Promise<void>;
  }): Promise<void> {
    this.observations.push(input.sessionId);
    this.#markObservationStarted();
    if (this.#holdObservation) {
      await this.#observationRelease;
    }
    await input.render(document(input.sessionId));
  }

  async replay(input: {
    readonly sessionId: string;
    readonly render: (document: FlowPresentationDocument) => Promise<void>;
  }): Promise<void> {
    this.replays.push(input.sessionId);
    await input.render(document(input.sessionId));
  }

  async decide(input: unknown): Promise<void> {
    this.decisions.push(input);
  }

  async cancel(input: unknown): Promise<void> {
    this.cancellations.push(input);
    this.#markCancellationStarted();
  }

  releaseObservation(): void {
    this.#releaseObservation();
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error("Cannot create test deferred");
  }
  return { promise, resolve: resolvePromise };
}

function cancellingPermissionClient(): ReturnType<typeof client> {
  return client({ name: "test-editor" }).onRequest(
    methods.client.session.requestPermission,
    () => ({ outcome: { outcome: "cancelled" } }),
  );
}

function document(runId: string): FlowPresentationDocument {
  return {
    apiVersion: "flow.synapti.ai/presentation/v1",
    run: { runId, workflowId: "workflow-1", status: "waiting_for_approval", sequence: 12 },
    sections: [
      {
        id: "overview",
        components: [
          {
            kind: "facts",
            items: [
              { label: "Private package", value: "PRIVATE_RESOURCE_BASE64" },
              { label: "Provider", value: "PRIVATE_PROVIDER_OUTPUT" },
            ],
          },
        ],
      },
      {
        id: "nodes",
        components: [
          {
            kind: "table",
            columns: [
              { key: "node", label: "Node" },
              { key: "status", label: "Status" },
            ],
            rows: [{ id: "build", cells: ["build", "running"] }],
            truncated: false,
          },
        ],
      },
    ],
    actions: [
      {
        kind: "approve",
        actionId: "approve:approval-7",
        requestId: "approval-7",
        label: "Approve command request for build",
      },
      {
        kind: "deny",
        actionId: "deny:approval-7",
        requestId: "approval-7",
        label: "Deny command request for build",
      },
      { kind: "cancel", actionId: `cancel:${runId}`, runId, label: "Cancel run" },
    ],
    truncated: false,
  };
}
