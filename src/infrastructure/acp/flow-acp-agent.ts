import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AgentApp,
  type AgentContext,
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

import type { RunPresentationControl } from "../../application/run-presentation-actions.js";
import { RunPresentationActionController } from "../../application/run-presentation-actions.js";
import { parsePromptActivationLocator } from "../../domain/adaptation/prompt-activation.js";
import { isValidApprovalActor } from "../../domain/approval/command-approval.js";
import { parseWorkflowPackageLocator } from "../../domain/capability/workflow-packages.js";
import type { FlowPresentationDocument } from "../../domain/presentation/flow-presentation.js";
import { parseSafeDisplayText } from "../../domain/presentation/safe-display-text.js";
import type { AcpSessionDescriptor, LocalAcpSessionStore } from "../fs/local-acp-session-store.js";
import {
  flowAcpAvailableCommandsUpdate,
  projectFlowAcpPresentation,
  resolveFlowAcpPermissionSelection,
} from "./flow-acp-presentation.js";

const MAX_WORKFLOW_SOURCE_BYTES = 4_096;
const SESSION_LIST_LIMIT = 256;
const DEFAULT_PERMISSION_TIMEOUT_MS = 30_000;
const MAX_CANCELLATION_CONCURRENCY = 64;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FlowAcpAgentRuntime extends RunPresentationControl {
  readonly submit: (input: {
    readonly sessionId: string;
    readonly workflowSource: string;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly observe: (input: {
    readonly sessionId: string;
    readonly awaitRunStart: boolean;
    readonly render: (document: FlowPresentationDocument) => Promise<void>;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly replay: (input: {
    readonly sessionId: string;
    readonly render: (document: FlowPresentationDocument) => Promise<void>;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
}

export interface FlowAcpAgentOptions {
  readonly sessionStore: LocalAcpSessionStore;
  readonly projectRoot: string;
  readonly policyDigest: string;
  readonly actor: string;
  readonly version: string;
  readonly createSessionId: () => string;
  readonly createCancellationCommandId: (sessionId: string) => string;
  readonly now: () => string;
  readonly runtime: FlowAcpAgentRuntime;
  readonly cancellationConcurrency?: number;
  readonly permissionTimeoutMs?: number;
}

type FlowPrompt =
  | { readonly kind: "continue" }
  | { readonly kind: "run"; readonly workflowSource: string };

interface ActiveTurn {
  readonly abortController: AbortController;
  readonly submissionSettled: Promise<void>;
  readonly settled: Promise<void>;
  readonly settleSubmission: () => void;
  readonly settle: () => void;
  cancellationSettlement?: Promise<void>;
}

class FlowAcpRequestError extends RequestError {}

export function createFlowAcpAgent(options: FlowAcpAgentOptions): AgentApp {
  const identity = parseOptions(options);
  let initialized = false;
  const activeTurns = new Map<string, ActiveTurn>();
  const cancellationCommandIds = new Map<string, string>();
  const cancellationNotifications = new Map<string, Promise<void>>();
  const closedSessions = new Set<string>();
  const closingSessions = new Map<string, Promise<void>>();

  const app = agent({ name: "Flow" });
  app.onRequest(methods.agent.initialize, ({ params }) => {
    if (initialized) {
      throw invalidRequest("Flow ACP connection is already initialized");
    }
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      throw invalidRequest("Flow ACP protocol version is not supported");
    }
    initialized = true;
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      agentInfo: { name: "Flow", version: identity.version },
    };
  });

  app.onRequest(methods.agent.session.new, async ({ params, signal, client }) => {
    requireInitialized(initialized);
    assertSessionAuthority(params, identity.projectRoot);
    const sessionId = createUuid(options.createSessionId, "Flow ACP session identity is invalid");
    const descriptor = await createSession(options, identity, sessionId, signal);
    closedSessions.delete(descriptor.sessionId);
    await notifyCommands(client, descriptor.sessionId);
    return { sessionId: descriptor.sessionId };
  });

  app.onRequest(methods.agent.session.list, async ({ params, signal }) => {
    requireInitialized(initialized);
    if (params.cwd !== undefined && params.cwd !== null && params.cwd !== identity.projectRoot) {
      throw invalidParams("Flow ACP session authority is not supported");
    }
    try {
      const page = await options.sessionStore.list({
        projectRoot: identity.projectRoot,
        policyDigest: identity.policyDigest,
        limit: SESSION_LIST_LIMIT,
        ...(params.cursor === undefined || params.cursor === null ? {} : { after: params.cursor }),
        signal,
      });
      return {
        sessions: page.sessions.map(sessionInfo),
        ...(page.cursor === undefined ? {} : { nextCursor: page.cursor }),
      };
    } catch (error) {
      throw normalizeRequestFailure(error, signal, "Cannot list Flow ACP sessions");
    }
  });

  app.onRequest(methods.agent.session.load, async ({ params, signal, client }) => {
    requireInitialized(initialized);
    assertSessionAuthority(params, identity.projectRoot);
    const descriptor = await readSession(options, identity, params.sessionId, signal);
    await notifyCommands(client, descriptor.sessionId);
    await replaySession(options, descriptor, client, identity.permissionTimeoutMs, signal);
    closedSessions.delete(descriptor.sessionId);
    return {};
  });

  app.onRequest(methods.agent.session.resume, async ({ params, signal, client }) => {
    requireInitialized(initialized);
    assertSessionAuthority(params, identity.projectRoot);
    const descriptor = await readSession(options, identity, params.sessionId, signal);
    await notifyCommands(client, descriptor.sessionId);
    closedSessions.delete(descriptor.sessionId);
    return {};
  });

  app.onRequest(methods.agent.session.prompt, async ({ params, signal, client }) => {
    requireInitialized(initialized);
    const prompt = parsePrompt(params.prompt, identity.projectRoot);
    if (closedSessions.has(params.sessionId) || closingSessions.has(params.sessionId)) {
      throw invalidRequest("Flow ACP session is closed");
    }
    if (activeTurns.has(params.sessionId)) {
      throw invalidRequest("Flow ACP session already has an active turn");
    }
    const turnSettlement = deferred();
    const submissionSettlement = deferred();
    if (prompt.kind === "continue") {
      submissionSettlement.resolve();
    }
    const turn: ActiveTurn = {
      abortController: new AbortController(),
      submissionSettled: submissionSettlement.promise,
      settled: turnSettlement.promise,
      settleSubmission: submissionSettlement.resolve,
      settle: turnSettlement.resolve,
    };
    activeTurns.set(params.sessionId, turn);
    const turnSignal = AbortSignal.any([signal, turn.abortController.signal]);
    try {
      const descriptor = await readSession(options, identity, params.sessionId, turnSignal);
      if (closedSessions.has(descriptor.sessionId) || closingSessions.has(descriptor.sessionId)) {
        throw invalidRequest("Flow ACP session is closed");
      }
      await notifyCommands(client, descriptor.sessionId);
      if (prompt.kind === "run") {
        try {
          await submitSession(options, descriptor, prompt.workflowSource, turnSignal);
        } finally {
          turn.settleSubmission();
        }
      }
      await observeSession(
        options,
        descriptor,
        client,
        cancellationCommandIds,
        prompt.kind === "run",
        identity.permissionTimeoutMs,
        turnSignal,
      );
      return { stopReason: "end_turn" as const };
    } catch (error) {
      if (turnSignal.aborted) {
        const settlement = turn.cancellationSettlement;
        if (settlement !== undefined) {
          try {
            await settlement;
          } catch {
            throw internalError("Cannot cancel Flow ACP session");
          }
        }
        return { stopReason: "cancelled" as const };
      }
      throw normalizeRequestFailure(error, signal, "Cannot process Flow ACP prompt");
    } finally {
      turn.settleSubmission();
      turn.settle();
      if (activeTurns.get(params.sessionId) === turn) {
        activeTurns.delete(params.sessionId);
      }
    }
  });

  app.onNotification(methods.agent.session.cancel, async ({ params, signal }) => {
    if (!initialized) {
      return;
    }
    if (cancellationNotifications.has(params.sessionId)) {
      return;
    }
    if (cancellationNotifications.size >= identity.cancellationConcurrency) {
      return;
    }
    const operation = (async () => {
      try {
        const descriptor = await readSession(options, identity, params.sessionId, signal);
        const activeTurn = activeTurns.get(descriptor.sessionId);
        const settlement = cancelSessionAfterSubmission(
          options,
          descriptor,
          cancellationCommandIds,
          activeTurn,
          signal,
        );
        if (activeTurn !== undefined) {
          activeTurn.cancellationSettlement = settlement;
          activeTurn.abortController.abort();
        }
        await settlement;
      } catch {
        // ACP cancellation is a notification. Its private failure must not be logged or rethrown.
      }
    })();
    cancellationNotifications.set(params.sessionId, operation);
    try {
      await operation;
    } finally {
      if (cancellationNotifications.get(params.sessionId) === operation) {
        cancellationNotifications.delete(params.sessionId);
      }
    }
  });

  app.onRequest(methods.agent.session.close, async ({ params, signal }) => {
    requireInitialized(initialized);
    if (closedSessions.has(params.sessionId)) {
      return {};
    }
    const existing = closingSessions.get(params.sessionId);
    if (existing !== undefined) {
      await existing;
      return {};
    }
    const operation = (async () => {
      const descriptor = await readSession(options, identity, params.sessionId, signal);
      const activeTurn = activeTurns.get(descriptor.sessionId);
      const settlement = cancelSessionAfterSubmission(
        options,
        descriptor,
        cancellationCommandIds,
        activeTurn,
        signal,
      );
      if (activeTurn !== undefined) {
        activeTurn.cancellationSettlement = settlement;
        activeTurn.abortController.abort();
      }
      try {
        await settlement;
      } catch (error) {
        await activeTurn?.settled;
        throw normalizeRequestFailure(error, signal, "Cannot close Flow ACP session");
      }
      await activeTurn?.settled;
    })();
    closingSessions.set(params.sessionId, operation);
    try {
      await operation;
      closedSessions.add(params.sessionId);
      return {};
    } finally {
      if (closingSessions.get(params.sessionId) === operation) {
        closingSessions.delete(params.sessionId);
      }
    }
  });

  return app;
}

async function createSession(
  options: FlowAcpAgentOptions,
  identity: ParsedOptions,
  sessionId: string,
  signal: AbortSignal,
): Promise<AcpSessionDescriptor> {
  let createdAt: string;
  try {
    createdAt = options.now();
  } catch {
    throw internalError("Cannot create Flow ACP session");
  }
  try {
    return await options.sessionStore.create(
      {
        sessionId,
        projectRoot: identity.projectRoot,
        policyDigest: identity.policyDigest,
        actor: identity.actor,
        createdAt,
      },
      { signal },
    );
  } catch (error) {
    throw normalizeRequestFailure(error, signal, "Cannot create Flow ACP session");
  }
}

async function readSession(
  options: FlowAcpAgentOptions,
  identity: ParsedOptions,
  sessionId: string,
  signal: AbortSignal,
): Promise<AcpSessionDescriptor> {
  try {
    return await options.sessionStore.read(
      sessionId,
      { projectRoot: identity.projectRoot, policyDigest: identity.policyDigest },
      { signal },
    );
  } catch (error) {
    throw normalizeRequestFailure(error, signal, "Cannot read Flow ACP session");
  }
}

async function replaySession(
  options: FlowAcpAgentOptions,
  descriptor: AcpSessionDescriptor,
  client: AgentContext,
  permissionTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    await options.runtime.replay({
      sessionId: descriptor.runId,
      render: async (document) => {
        await emitPresentation(
          client,
          descriptor.sessionId,
          document,
          undefined,
          permissionTimeoutMs,
          signal,
        );
      },
      signal,
    });
  } catch (error) {
    throw normalizeRequestFailure(error, signal, "Cannot replay Flow ACP session");
  }
}

async function submitSession(
  options: FlowAcpAgentOptions,
  descriptor: AcpSessionDescriptor,
  workflowSource: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await options.runtime.submit({ sessionId: descriptor.runId, workflowSource, signal });
  } catch (error) {
    throw normalizeRequestFailure(error, signal, "Cannot submit Flow ACP workflow");
  }
}

async function observeSession(
  options: FlowAcpAgentOptions,
  descriptor: AcpSessionDescriptor,
  client: AgentContext,
  cancellationCommandIds: Map<string, string>,
  awaitRunStart: boolean,
  permissionTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const controller = new RunPresentationActionController({
    runId: descriptor.runId,
    actor: descriptor.actor,
    control: options.runtime,
    createCommandId: () =>
      cancellationCommandId(options, descriptor.sessionId, cancellationCommandIds),
    signal,
  });
  const handledPermissions = new Set<string>();
  try {
    await options.runtime.observe({
      sessionId: descriptor.runId,
      awaitRunStart,
      render: async (document) => {
        controller.update(document);
        await emitPresentation(
          client,
          descriptor.sessionId,
          document,
          { controller, handledPermissions },
          permissionTimeoutMs,
          signal,
        );
      },
      signal,
    });
  } catch (error) {
    throw normalizeRequestFailure(error, signal, "Cannot observe Flow ACP session");
  }
}

async function emitPresentation(
  client: AgentContext,
  sessionId: string,
  document: FlowPresentationDocument,
  interaction:
    | {
        readonly controller: RunPresentationActionController;
        readonly handledPermissions: Set<string>;
      }
    | undefined,
  permissionTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const presentation = projectFlowAcpPresentation(document);
  for (const update of presentation.updates) {
    signal.throwIfAborted();
    await notifyUpdate(client, sessionId, update);
  }
  if (interaction === undefined) {
    return;
  }
  for (const permission of presentation.permissions) {
    const key = `${permission.documentSequence}:${permission.requestId}`;
    if (interaction.handledPermissions.has(key)) {
      continue;
    }
    interaction.handledPermissions.add(key);
    signal.throwIfAborted();
    const permissionSignal = AbortSignal.any([signal, AbortSignal.timeout(permissionTimeoutMs)]);
    const response = await waitForSignal(
      client.request(
        methods.client.session.requestPermission,
        {
          sessionId,
          toolCall: permission.toolCall,
          options: [...permission.options],
        },
        { cancellationSignal: permissionSignal },
      ),
      permissionSignal,
    );
    signal.throwIfAborted();
    if (response.outcome.outcome === "cancelled") {
      await notifyUpdate(client, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: permission.toolCall.toolCallId,
        status: "failed",
      });
      continue;
    }
    const selected = resolveFlowAcpPermissionSelection(presentation, {
      requestId: permission.requestId,
      optionId: response.outcome.optionId,
      documentSequence: permission.documentSequence,
    });
    await interaction.controller.executeCurrent(selected.documentSequence, selected.actionId);
    signal.throwIfAborted();
    await notifyUpdate(client, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: permission.toolCall.toolCallId,
      status: "completed",
    });
  }
}

async function notifyCommands(client: AgentContext, sessionId: string): Promise<void> {
  await notifyUpdate(client, sessionId, flowAcpAvailableCommandsUpdate());
}

async function notifyUpdate(
  client: AgentContext,
  sessionId: string,
  update: SessionUpdate,
): Promise<void> {
  try {
    await client.notify(methods.client.session.update, { sessionId, update });
  } catch {
    throw internalError("Cannot publish Flow ACP session update");
  }
}

async function cancelSession(
  options: FlowAcpAgentOptions,
  descriptor: AcpSessionDescriptor,
  commandIds: Map<string, string>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await options.runtime.cancel({
    runId: descriptor.runId,
    commandId: cancellationCommandId(options, descriptor.sessionId, commandIds),
    actor: descriptor.actor,
  });
}

async function cancelSessionAfterSubmission(
  options: FlowAcpAgentOptions,
  descriptor: AcpSessionDescriptor,
  commandIds: Map<string, string>,
  activeTurn: ActiveTurn | undefined,
  signal: AbortSignal,
): Promise<void> {
  await activeTurn?.submissionSettled;
  signal.throwIfAborted();
  await cancelSession(options, descriptor, commandIds, signal);
}

function cancellationCommandId(
  options: FlowAcpAgentOptions,
  sessionId: string,
  commandIds: Map<string, string>,
): string {
  const existing = commandIds.get(sessionId);
  if (existing !== undefined) {
    return existing;
  }
  let commandId: string;
  try {
    commandId = options.createCancellationCommandId(sessionId);
  } catch {
    throw internalError("Cannot create Flow ACP cancellation identity");
  }
  if (!UUID_PATTERN.test(commandId)) {
    throw internalError("Cannot create Flow ACP cancellation identity");
  }
  commandIds.set(sessionId, commandId);
  return commandId;
}

function parsePrompt(prompt: readonly unknown[], projectRoot: string): FlowPrompt {
  if (prompt.length === 1) {
    const block = prompt[0];
    if (isTextBlock(block)) {
      if (block.text === "/flow-continue") {
        return { kind: "continue" };
      }
      const prefix = "/flow-run ";
      if (block.text.startsWith(prefix)) {
        return {
          kind: "run",
          workflowSource: parseWorkflowSource(block.text.slice(prefix.length), projectRoot),
        };
      }
    }
  }
  if (
    prompt.length === 2 &&
    isTextBlock(prompt[0]) &&
    prompt[0].text === "/flow-run" &&
    isResourceLink(prompt[1])
  ) {
    return { kind: "run", workflowSource: parseResourceLink(prompt[1].uri, projectRoot) };
  }
  throw invalidParams("Flow ACP prompt is invalid");
}

function parseWorkflowSource(input: string, projectRoot: string): string {
  if (
    input.length === 0 ||
    input !== input.trim() ||
    input.includes("\n") ||
    input.includes("\r") ||
    input.includes("\0") ||
    Buffer.byteLength(input, "utf8") > MAX_WORKFLOW_SOURCE_BYTES
  ) {
    throw invalidParams("Flow ACP prompt is invalid");
  }
  try {
    if (
      parseWorkflowPackageLocator(input) !== null ||
      parsePromptActivationLocator(input) !== null
    ) {
      return input;
    }
  } catch {
    throw invalidParams("Flow ACP prompt is invalid");
  }
  if (isAbsolute(input)) {
    throw invalidParams("Flow ACP prompt is invalid");
  }
  const resolved = resolve(projectRoot, input);
  const source = relative(projectRoot, resolved);
  if (
    source.length === 0 ||
    isAbsolute(source) ||
    source === ".." ||
    source.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw invalidParams("Flow ACP prompt is invalid");
  }
  return source;
}

function parseResourceLink(uri: string, projectRoot: string): string {
  let path: string;
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== "file:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("unsupported resource link");
    }
    path = fileURLToPath(parsed);
  } catch {
    throw invalidParams("Flow ACP prompt is invalid");
  }
  const source = relative(projectRoot, path);
  if (
    source.length === 0 ||
    isAbsolute(source) ||
    source === ".." ||
    source.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(projectRoot, source) !== path
  ) {
    throw invalidParams("Flow ACP prompt is invalid");
  }
  return parseWorkflowSource(source, projectRoot);
}

function assertSessionAuthority(
  input: {
    readonly cwd: string;
    readonly additionalDirectories?: readonly string[];
    readonly mcpServers?: readonly unknown[];
  },
  projectRoot: string,
): void {
  if (
    input.cwd !== projectRoot ||
    (input.additionalDirectories?.length ?? 0) !== 0 ||
    (input.mcpServers?.length ?? 0) !== 0
  ) {
    throw invalidParams("Flow ACP session authority is not supported");
  }
}

function sessionInfo(descriptor: AcpSessionDescriptor): {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly updatedAt: string;
} {
  return {
    sessionId: descriptor.sessionId,
    cwd: descriptor.projectRoot,
    title: `Flow run ${descriptor.runId}`,
    updatedAt: descriptor.createdAt,
  };
}

interface ParsedOptions {
  readonly projectRoot: string;
  readonly policyDigest: string;
  readonly actor: string;
  readonly version: string;
  readonly cancellationConcurrency: number;
  readonly permissionTimeoutMs: number;
}

function parseOptions(options: FlowAcpAgentOptions): ParsedOptions {
  let actor: string;
  let version: string;
  try {
    actor = parseSafeDisplayText(options.actor).trim();
    version = parseSafeDisplayText(options.version).trim();
  } catch {
    throw new Error("Flow ACP agent options are invalid");
  }
  if (
    !isAbsolute(options.projectRoot) ||
    resolve(options.projectRoot) !== options.projectRoot ||
    !DIGEST_PATTERN.test(options.policyDigest) ||
    !isValidApprovalActor(actor) ||
    version.length === 0 ||
    version.length > 128
  ) {
    throw new Error("Flow ACP agent options are invalid");
  }
  return {
    projectRoot: options.projectRoot,
    policyDigest: options.policyDigest,
    actor,
    version,
    cancellationConcurrency: parsePositiveBoundedOption(
      options.cancellationConcurrency,
      MAX_CANCELLATION_CONCURRENCY,
      MAX_CANCELLATION_CONCURRENCY,
    ),
    permissionTimeoutMs: parsePositiveBoundedOption(
      options.permissionTimeoutMs,
      DEFAULT_PERMISSION_TIMEOUT_MS,
      60_000,
    ),
  };
}

function parsePositiveBoundedOption(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const parsed = value ?? defaultValue;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error("Flow ACP agent options are invalid");
  }
  return parsed;
}

function createUuid(factory: () => string, message: string): string {
  let value: string;
  try {
    value = factory();
  } catch {
    throw internalError(message);
  }
  if (!UUID_PATTERN.test(value)) {
    throw internalError(message);
  }
  return value;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromiseValue) => {
    resolvePromise = resolvePromiseValue;
  });
  if (resolvePromise === undefined) {
    throw new Error("Cannot create Flow ACP settlement");
  }
  return { promise, resolve: resolvePromise };
}

async function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort = (_error: unknown): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function requireInitialized(initialized: boolean): void {
  if (!initialized) {
    throw invalidRequest("Flow ACP connection is not initialized");
  }
}

function isTextBlock(input: unknown): input is { readonly type: "text"; readonly text: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { readonly type?: unknown }).type === "text" &&
    typeof (input as { readonly text?: unknown }).text === "string"
  );
}

function isResourceLink(
  input: unknown,
): input is { readonly type: "resource_link"; readonly uri: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { readonly type?: unknown }).type === "resource_link" &&
    typeof (input as { readonly uri?: unknown }).uri === "string"
  );
}

function normalizeRequestFailure(
  error: unknown,
  signal: AbortSignal,
  message: string,
): RequestError {
  if (error instanceof FlowAcpRequestError) {
    return error;
  }
  if (signal.aborted) {
    return new FlowAcpRequestError(-32_800, "Flow ACP request was cancelled");
  }
  return internalError(message);
}

function invalidRequest(message: string): RequestError {
  return new FlowAcpRequestError(-32_600, message);
}

function invalidParams(message: string): RequestError {
  return new FlowAcpRequestError(-32_602, message);
}

function internalError(message: string): RequestError {
  return new FlowAcpRequestError(-32_603, message);
}
