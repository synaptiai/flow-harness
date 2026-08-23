import {
  client,
  methods,
  PROTOCOL_VERSION,
  type SessionConfigOption,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type Stream,
} from "@agentclientprotocol/sdk";

import type {
  AcpAgentConfigurationAssignment,
  AcpAgentRuntimeSnapshot,
} from "../../domain/capability/acp-agent.js";
import type { ModelUsageObservation } from "../../domain/run/budget.js";
import type { ThinkingLevel } from "../../domain/workflow/types.js";
import {
  type AcpAgentAuthorityViolationCategory,
  AcpAgentProtocolStreamError,
  createAcpAgentProtocolStream,
} from "./acp-agent-protocol-stream.js";

export type AcpAgentSessionErrorCode =
  | "authority_violation"
  | "configuration_drift"
  | "configuration_rejected"
  | "output_limit"
  | "protocol"
  | "stop_reason"
  | "usage_invalid";

export class AcpAgentSessionError extends Error {
  override readonly name = "AcpAgentSessionError";

  constructor(
    readonly code: AcpAgentSessionErrorCode,
    readonly authorityCategory?: AcpAgentAuthorityViolationCategory,
  ) {
    super(sessionErrorMessage(code));
  }
}

export interface AcpAgentSessionRequest {
  readonly snapshot: AcpAgentRuntimeSnapshot;
  readonly provider: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly cwd: string;
  readonly prompt: string;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly onSessionCreated?: (sessionId: string) => void;
  readonly onPromptStarted?: () => void;
  readonly onAuthorityViolation?: (category: AcpAgentAuthorityViolationCategory) => void;
  readonly onUpdateCount?: (count: number) => void;
}

export interface AcpAgentSessionResult {
  readonly sessionId: string;
  readonly text: string;
  readonly stopReason: "end_turn";
  readonly usageObservation: ModelUsageObservation;
  readonly usageProvenance: {
    readonly modelTokens: "prompt-response" | "declared-unavailable";
    readonly costUsd: "session-usage-update" | "declared-unavailable";
  };
  readonly updateCount: number;
}

const MAX_ACP_AGENT_SESSION_UPDATES = 4_096;

export async function runAcpAgentSession(
  baseStream: Stream,
  request: AcpAgentSessionRequest,
): Promise<AcpAgentSessionResult> {
  if (
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes < 1 ||
    request.maxOutputBytes > 65_536
  ) {
    throw new AcpAgentSessionError("output_limit");
  }
  const values = resolveConfigurationValues(request);
  let authorityViolation: AcpAgentAuthorityViolationCategory | undefined;
  let notificationFailure: AcpAgentSessionError | undefined;
  const noteAuthorityViolation = (category: AcpAgentAuthorityViolationCategory): void => {
    authorityViolation ??= category;
    request.onAuthorityViolation?.(category);
  };
  const retainNotificationFailure = (error: unknown): never => {
    const failure =
      error instanceof AcpAgentSessionError ? error : new AcpAgentSessionError("protocol");
    notificationFailure ??= failure;
    throw failure;
  };
  const stream = createAcpAgentProtocolStream(baseStream, {
    onAuthorityViolation: (category) => {
      authorityViolation ??= category;
      if (category !== "permission") {
        request.onAuthorityViolation?.(category);
      }
    },
    onPermissionResponse: () => noteAuthorityViolation("permission"),
  });
  let sessionId: string | undefined;
  let assignedCount = 0;
  let promptActive = false;
  let updateCount = 0;
  let text = "";
  let textBytes = 0;
  let costUsdMicros: number | undefined;

  try {
    const response = await client({ name: "flow-harness" })
      .onRequest(methods.client.session.requestPermission, () => {
        return { outcome: { outcome: "cancelled" as const } };
      })
      .onNotification(methods.client.session.update, ({ params }) => {
        try {
          acceptUpdate(params);
        } catch (error) {
          retainNotificationFailure(error);
        }
      })
      .connectWith(stream, async (agent) => {
        const initialization = await agent.request(
          methods.agent.initialize,
          {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: values.hasBoolean
              ? { session: { configOptions: { boolean: {} } } }
              : {},
            clientInfo: { name: "flow-harness", version: "1" },
          },
          cancellationOptions(request.signal),
        );
        if (initialization.protocolVersion !== PROTOCOL_VERSION) {
          throw new AcpAgentSessionError("protocol");
        }
        const created = await agent.request(
          methods.agent.session.new,
          { cwd: request.cwd, mcpServers: [] },
          cancellationOptions(request.signal),
        );
        if (created.modes != null || created.configOptions == null) {
          throw new AcpAgentSessionError("configuration_rejected");
        }
        sessionId = created.sessionId;
        request.onSessionCreated?.(sessionId);
        assertConfigurationState(created.configOptions, values.assignments, assignedCount, true);

        for (const [index, assignment] of values.assignments.entries()) {
          const configured = await agent.request(
            methods.agent.session.setConfigOption,
            assignmentRequest(sessionId, assignment),
            cancellationOptions(request.signal),
          );
          assertConfigurationState(configured.configOptions, values.assignments, index + 1, true);
          assignedCount = index + 1;
        }

        promptActive = true;
        request.onPromptStarted?.();
        const promptResponse = await agent.request(
          methods.agent.session.prompt,
          {
            sessionId,
            prompt: [{ type: "text", text: request.prompt }],
          },
          cancellationOptions(request.signal),
        );
        promptActive = false;
        if (notificationFailure !== undefined) {
          throw notificationFailure;
        }
        if (authorityViolation !== undefined) {
          throw new AcpAgentSessionError("authority_violation", authorityViolation);
        }
        if (promptResponse.stopReason !== "end_turn") {
          throw new AcpAgentSessionError("stop_reason");
        }
        const usageObservation = usageFromResponse(
          request.snapshot,
          promptResponse.usage?.totalTokens,
          costUsdMicros,
        );
        return {
          sessionId,
          text,
          stopReason: "end_turn" as const,
          usageObservation,
          usageProvenance: {
            modelTokens:
              request.snapshot.usage.modelTokens === "complete"
                ? ("prompt-response" as const)
                : ("declared-unavailable" as const),
            costUsd:
              request.snapshot.usage.costUsd === "complete"
                ? ("session-usage-update" as const)
                : ("declared-unavailable" as const),
          },
          updateCount,
        };
      });
    await stream.settle();
    return Object.freeze(response);
  } catch (error) {
    await stream.settle();
    if (notificationFailure !== undefined) throw notificationFailure;
    if (error instanceof AcpAgentSessionError) throw error;
    if (error instanceof AcpAgentProtocolStreamError) {
      throw error.code === "authority_violation"
        ? new AcpAgentSessionError("authority_violation", error.authorityCategory)
        : new AcpAgentSessionError("protocol");
    }
    if (authorityViolation !== undefined) {
      throw new AcpAgentSessionError("authority_violation", authorityViolation);
    }
    throw new AcpAgentSessionError("protocol");
  }

  function acceptUpdate(notification: SessionNotification): void {
    if (sessionId === undefined || notification.sessionId !== sessionId) {
      throw new AcpAgentSessionError("protocol");
    }
    updateCount += 1;
    request.onUpdateCount?.(updateCount);
    if (updateCount > MAX_ACP_AGENT_SESSION_UPDATES) {
      throw new AcpAgentSessionError("output_limit");
    }
    const update = notification.update;
    if (update.sessionUpdate === "config_option_update") {
      assertConfigurationState(update.configOptions, values.assignments, assignedCount, true);
      return;
    }
    if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update" ||
      update.sessionUpdate === "available_commands_update"
    ) {
      noteAuthorityViolation("tool");
      throw new AcpAgentSessionError("authority_violation", "tool");
    }
    if (update.sessionUpdate === "current_mode_update") {
      throw new AcpAgentSessionError("configuration_drift");
    }
    if (!promptActive) {
      if (update.sessionUpdate === "session_info_update") return;
      throw new AcpAgentSessionError("protocol");
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type !== "text") {
        throw new AcpAgentSessionError("protocol");
      }
      const bytes = Buffer.byteLength(update.content.text, "utf8");
      if (textBytes + bytes > request.maxOutputBytes) {
        throw new AcpAgentSessionError("output_limit");
      }
      text += update.content.text;
      textBytes += bytes;
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      if (
        !Number.isSafeInteger(update.used) ||
        update.used < 0 ||
        !Number.isSafeInteger(update.size) ||
        update.size < 1 ||
        update.used > update.size
      ) {
        throw new AcpAgentSessionError("usage_invalid");
      }
      if (update.cost != null) {
        if (update.cost.currency !== "USD") {
          throw new AcpAgentSessionError("usage_invalid");
        }
        const nextCost = exactUsdMicros(update.cost.amount);
        if (costUsdMicros !== undefined && nextCost < costUsdMicros) {
          throw new AcpAgentSessionError("usage_invalid");
        }
        costUsdMicros = nextCost;
      }
    }
  }
}

interface ResolvedAssignment {
  readonly configId: string;
  readonly value: string | boolean;
}

function resolveConfigurationValues(request: AcpAgentSessionRequest): {
  readonly assignments: readonly ResolvedAssignment[];
  readonly hasBoolean: boolean;
} {
  const mapping = request.snapshot.modelMappings.find(
    (candidate) => candidate.provider === request.provider && candidate.model === request.model,
  );
  if (mapping === undefined) throw new AcpAgentSessionError("configuration_rejected");
  const assignments = request.snapshot.configuration.assignments.map((assignment) => ({
    configId: assignment.configId,
    value: assignmentValue(assignment, mapping.agentModel, request.thinking),
  }));
  return Object.freeze({
    assignments: Object.freeze(assignments),
    hasBoolean: assignments.some((assignment) => typeof assignment.value === "boolean"),
  });
}

function assignmentValue(
  assignment: AcpAgentConfigurationAssignment,
  agentModel: string,
  thinking: ThinkingLevel,
): string | boolean {
  if (assignment.source === "literal") return assignment.value;
  if (assignment.source === "model") return agentModel;
  const mapping = assignment.mappings.find((candidate) => candidate.thinking === thinking);
  if (mapping === undefined) throw new AcpAgentSessionError("configuration_rejected");
  return mapping.value;
}

function assignmentRequest(
  sessionId: string,
  assignment: ResolvedAssignment,
): SetSessionConfigOptionRequest {
  return typeof assignment.value === "boolean"
    ? {
        sessionId,
        configId: assignment.configId,
        type: "boolean",
        value: assignment.value,
      }
    : { sessionId, configId: assignment.configId, value: assignment.value };
}

function assertConfigurationState(
  options: readonly SessionConfigOption[],
  assignments: readonly ResolvedAssignment[],
  assignedCount: number,
  requireAvailability: boolean,
): void {
  if (
    options.length !== assignments.length ||
    new Set(options.map((option) => option.id)).size !== options.length
  ) {
    throw new AcpAgentSessionError("configuration_rejected");
  }
  for (const [index, assignment] of assignments.entries()) {
    const option = options.find((candidate) => candidate.id === assignment.configId);
    if (
      option === undefined ||
      (typeof assignment.value === "boolean") !== (option.type === "boolean")
    ) {
      throw new AcpAgentSessionError("configuration_rejected");
    }
    if (
      requireAvailability &&
      option.type === "select" &&
      !selectValues(option).includes(assignment.value as string)
    ) {
      throw new AcpAgentSessionError("configuration_rejected");
    }
    if (index < assignedCount && option.currentValue !== assignment.value) {
      throw new AcpAgentSessionError("configuration_drift");
    }
  }
}

function selectValues(option: Extract<SessionConfigOption, { readonly type: "select" }>): string[] {
  return option.options.flatMap((item) =>
    "group" in item ? item.options.map((nested) => nested.value) : [item.value],
  );
}

function usageFromResponse(
  snapshot: AcpAgentRuntimeSnapshot,
  totalTokens: number | undefined,
  costUsdMicros: number | undefined,
): ModelUsageObservation {
  if (
    snapshot.usage.modelTokens === "complete" &&
    (!Number.isSafeInteger(totalTokens) || (totalTokens ?? -1) < 0)
  ) {
    throw new AcpAgentSessionError("usage_invalid");
  }
  if (snapshot.usage.costUsd === "complete" && costUsdMicros === undefined) {
    throw new AcpAgentSessionError("usage_invalid");
  }
  return Object.freeze({
    modelTokens:
      snapshot.usage.modelTokens === "complete"
        ? Object.freeze({ status: "complete" as const, totalTokens: totalTokens as number })
        : Object.freeze({ status: "unavailable" as const }),
    costUsd:
      snapshot.usage.costUsd === "complete"
        ? Object.freeze({ status: "complete" as const, costUsdMicros: costUsdMicros as number })
        : Object.freeze({ status: "unavailable" as const }),
  });
}

function exactUsdMicros(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) throw new AcpAgentSessionError("usage_invalid");
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(amount.toString());
  if (match === null) throw new AcpAgentSessionError("usage_invalid");
  const integer = match[1] as string;
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    throw new AcpAgentSessionError("usage_invalid");
  }
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, "");
  const scale = fraction.length - exponent - 6;
  let micros: bigint;
  if (scale <= 0) {
    micros = BigInt(digits) * 10n ** BigInt(-scale);
  } else {
    const divisor = 10n ** BigInt(scale);
    const value = BigInt(digits);
    if (value % divisor !== 0n) throw new AcpAgentSessionError("usage_invalid");
    micros = value / divisor;
  }
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AcpAgentSessionError("usage_invalid");
  }
  return Number(micros);
}

function cancellationOptions(
  signal: AbortSignal | undefined,
): { readonly cancellationSignal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { cancellationSignal: signal };
}

function sessionErrorMessage(code: AcpAgentSessionErrorCode): string {
  switch (code) {
    case "authority_violation":
      return "ACP agent requested authority outside the prompt-only contract";
    case "configuration_drift":
      return "ACP agent configuration drifted from the admitted contract";
    case "configuration_rejected":
      return "ACP agent rejected the admitted configuration contract";
    case "output_limit":
      return "ACP agent output exceeded its fixed limit";
    case "protocol":
      return "ACP agent session protocol failed";
    case "stop_reason":
      return "ACP agent did not complete the prompt turn";
    case "usage_invalid":
      return "ACP agent usage evidence is invalid or incomplete";
  }
}
