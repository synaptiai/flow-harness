import { createHash } from "node:crypto";

import { z } from "zod";

export const AGENT_COMMAND_PROTOCOL = "flow.agent-commands/v1" as const;
export const DEFAULT_AGENT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_AGENT_COMMAND_TIMEOUT_MS = 600_000;
export const MAX_AGENT_COMMAND_EXECUTABLE_BYTES = 1_024;
export const MAX_AGENT_COMMAND_ARGS = 64;
export const MAX_AGENT_COMMAND_ARG_BYTES = 8_192;
export const MAX_AGENT_COMMAND_ARGS_BYTES = 32_768;

const boundedCommandString = (label: string, maxBytes: number) =>
  z
    .string()
    .refine((value) => !value.includes("\0"), `${label} must not contain NUL bytes`)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= maxBytes,
      `${label} must not exceed ${maxBytes} UTF-8 bytes`,
    );

const agentCommandInputSchema = z
  .object({
    executable: boundedCommandString(
      "command executable",
      MAX_AGENT_COMMAND_EXECUTABLE_BYTES,
    ).refine(
      (value) => Buffer.byteLength(value, "utf8") > 0,
      "command executable must not be empty",
    ),
    args: z
      .array(boundedCommandString("command argument", MAX_AGENT_COMMAND_ARG_BYTES))
      .max(MAX_AGENT_COMMAND_ARGS)
      .refine(
        (args) =>
          args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <=
          MAX_AGENT_COMMAND_ARGS_BYTES,
        `command arguments must not exceed ${MAX_AGENT_COMMAND_ARGS_BYTES} UTF-8 bytes in total`,
      )
      .default([]),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_AGENT_COMMAND_TIMEOUT_MS)
      .default(DEFAULT_AGENT_COMMAND_TIMEOUT_MS),
  })
  .strict();

export interface AgentCommandRequest {
  readonly version: 1;
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export function normalizeAgentCommandRequest(input: unknown): AgentCommandRequest {
  const parsed = agentCommandInputSchema.parse(input);
  return Object.freeze({
    version: 1,
    executable: parsed.executable,
    args: Object.freeze([...parsed.args]),
    timeoutMs: parsed.timeoutMs,
  });
}

export function calculateAgentCommandDigest(command: AgentCommandRequest): string {
  const normalized = {
    version: 1,
    executable: command.executable,
    args: [...command.args],
    timeoutMs: command.timeoutMs,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
