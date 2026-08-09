import { createHash } from "node:crypto";

import { z } from "zod";
import {
  packagedToolNameSchema,
  toolPackageNameSchema,
  toolPackageVersionSchema,
} from "./capability/tool-packages.js";
import {
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  MAX_AGENT_COMMAND_ARG_BYTES,
  MAX_AGENT_COMMAND_ARGS,
  MAX_AGENT_COMMAND_ARGS_BYTES,
  MAX_AGENT_COMMAND_EXECUTABLE_BYTES,
  MAX_AGENT_COMMAND_TIMEOUT_MS,
} from "./command-envelope.js";

export {
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  MAX_AGENT_COMMAND_ARG_BYTES,
  MAX_AGENT_COMMAND_ARGS,
  MAX_AGENT_COMMAND_ARGS_BYTES,
  MAX_AGENT_COMMAND_EXECUTABLE_BYTES,
  MAX_AGENT_COMMAND_TIMEOUT_MS,
} from "./command-envelope.js";

export const AGENT_COMMAND_PROTOCOL = "flow.agent-commands/v1" as const;

const boundedCommandString = (label: string, maxBytes: number) =>
  z
    .string()
    .refine((value) => !value.includes("\0"), `${label} must not contain NUL bytes`)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= maxBytes,
      `${label} must not exceed ${maxBytes} UTF-8 bytes`,
    );

const commandFields = {
  executable: boundedCommandString("command executable", MAX_AGENT_COMMAND_EXECUTABLE_BYTES).refine(
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
    ),
  timeoutMs: z.number().int().positive().max(MAX_AGENT_COMMAND_TIMEOUT_MS),
};

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const toolPackageInputValueSchema = z.union([
  z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= 4_096,
      "tool package string input must not exceed 4096 UTF-8 bytes",
    ),
  z.number().int().safe(),
  z.boolean(),
]);
const toolPackageSourceSchema = z
  .object({
    kind: z.literal("tool-package"),
    name: toolPackageNameSchema,
    version: toolPackageVersionSchema,
    digest: sha256Schema,
    toolName: packagedToolNameSchema,
    input: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), toolPackageInputValueSchema)
      .refine((value) => Object.keys(value).length <= 32, "tool package input is too large")
      .refine(
        (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 32_768,
        "serialized tool package input must not exceed 32768 UTF-8 bytes",
      ),
    inputDigest: sha256Schema,
  })
  .strict();

const agentCommandInputSchema = z
  .object({
    version: z.literal(1).optional(),
    ...commandFields,
    args: commandFields.args.default([]),
    timeoutMs: commandFields.timeoutMs.default(DEFAULT_AGENT_COMMAND_TIMEOUT_MS),
    source: toolPackageSourceSchema.optional(),
  })
  .strict();

export const agentCommandRequestSchema = z
  .object({ version: z.literal(1), ...commandFields, source: toolPackageSourceSchema.optional() })
  .strict();

export interface ToolPackageCommandSource {
  readonly kind: "tool-package";
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, string | number | boolean>>;
  readonly inputDigest: string;
}

export interface AgentCommandRequest {
  readonly version: 1;
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly source?: ToolPackageCommandSource;
}

export function normalizeAgentCommandRequest(input: unknown): AgentCommandRequest {
  const parsed = agentCommandInputSchema.parse(input);
  const source =
    parsed.source === undefined
      ? undefined
      : Object.freeze({
          kind: parsed.source.kind,
          name: parsed.source.name,
          version: parsed.source.version,
          digest: parsed.source.digest,
          toolName: parsed.source.toolName,
          input: Object.freeze(
            Object.fromEntries(
              Object.entries(parsed.source.input).sort(([left], [right]) =>
                compareStrings(left, right),
              ),
            ),
          ),
          inputDigest: parsed.source.inputDigest,
        });
  return Object.freeze({
    version: 1,
    executable: parsed.executable,
    args: Object.freeze([...parsed.args]),
    timeoutMs: parsed.timeoutMs,
    ...(source === undefined ? {} : { source }),
  });
}

export function calculateAgentCommandDigest(command: AgentCommandRequest): string {
  const normalized = {
    version: 1,
    executable: command.executable,
    args: [...command.args],
    timeoutMs: command.timeoutMs,
    ...(command.source === undefined
      ? {}
      : {
          source: {
            kind: command.source.kind,
            name: command.source.name,
            version: command.source.version,
            digest: command.source.digest,
            toolName: command.source.toolName,
            input: Object.fromEntries(
              Object.entries(command.source.input).sort(([left], [right]) =>
                compareStrings(left, right),
              ),
            ),
            inputDigest: command.source.inputDigest,
          },
        }),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
