import { createHash } from "node:crypto";

import { z } from "zod";

const MAX_CONFIGURATION_BYTES = 4_194_304;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const imageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const containerIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const processOwnerSchema = z
  .object({
    bootId: z.uuid(),
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startTicks: z.string().regex(/^[1-9][0-9]{0,31}$/),
  })
  .strict();

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const recordSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["intent", "owned"]),
    ownerNonce: sha256Schema,
    containerName: z.string().regex(/^flow-command-[a-f0-9]{32}$/),
    owner: processOwnerSchema,
    runtime: z
      .object({
        engineVersion: z.string().min(1).max(128),
        apiVersion: z.string().regex(/^\d+\.\d+$/),
        socketPath: z.literal("/var/run/docker.sock"),
        imageId: imageIdSchema,
        runtimeName: z.literal("flow-prime-runc"),
        policyDigest: sha256Schema,
      })
      .strict(),
    privateDirectory: z.string().min(1).max(4_096).startsWith("/"),
    configuration: z.record(z.string(), jsonValueSchema),
    configurationDigest: sha256Schema,
    containerId: containerIdSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if ((record.state === "owned") !== (record.containerId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "container state contradicts its full identity",
      });
    }
    if (record.configuration.Image !== record.runtime.imageId) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "Image"],
        message: "container configuration contradicts runtime image identity",
      });
    }
    const serialized = JSON.stringify(record.configuration);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIGURATION_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["configuration"],
        message: "container configuration exceeds its byte limit",
      });
    }
    if (
      calculateContainerCommandConfigurationDigest(record.configuration) !==
      record.configurationDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["configurationDigest"],
        message: "container configuration digest does not match",
      });
    }
  });

export type ContainerCommandIntent = z.infer<typeof recordSchema>;
export type ContainerCommandProcessOwner = z.infer<typeof processOwnerSchema>;

export function parseContainerCommandProcessOwner(input: unknown): ContainerCommandProcessOwner {
  return deepFreeze(processOwnerSchema.parse(input));
}

export function parseContainerCommandIntent(input: unknown): ContainerCommandIntent {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("container command durable intent is invalid", { cause: parsed.error });
  }
  return deepFreeze(parsed.data);
}

export function calculateContainerCommandConfigurationDigest(
  configuration: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256").update(canonicalize(configuration)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("container command configuration contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error("container command configuration contains a non-JSON value");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
