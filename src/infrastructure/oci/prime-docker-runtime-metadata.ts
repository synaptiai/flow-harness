import { z } from "zod";

import { PRIME_OCI_RUNTIME_NAME } from "./prime-oci-policy.js";

const MAX_DOCKER_RESPONSE_BYTES = 1_048_576;
const dockerRuntimeMetadataSchema = z.object({}).passthrough();
const selectedPrimeRuntimeSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4_095)
      .refine((value) => value.startsWith("/"), {
        message: "must be an absolute path",
      }),
    runtimeArgs: z.array(z.string().max(1_024)).max(0).optional(),
  })
  .passthrough();

export const primeDockerRuntimeMapSchema = z
  .record(z.string().min(1).max(128), dockerRuntimeMetadataSchema)
  .refine(
    (value) => selectedPrimeRuntimeSchema.safeParse(value[PRIME_OCI_RUNTIME_NAME]).success,
    `must contain ${PRIME_OCI_RUNTIME_NAME} with one absolute executable path and no arguments`,
  );

export function selectedPrimeDockerRuntime(
  runtimes: z.output<typeof primeDockerRuntimeMapSchema>,
): z.output<typeof selectedPrimeRuntimeSchema> {
  const selected = selectedPrimeRuntimeSchema.safeParse(runtimes[PRIME_OCI_RUNTIME_NAME]);
  if (!selected.success) {
    throw new Error("Prime OCI selected Docker runtime violates the closed schema");
  }
  return selected.data;
}

export function boundPrimeDockerResponse(source: string, label: string): string {
  if (Buffer.byteLength(source, "utf8") > MAX_DOCKER_RESPONSE_BYTES) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  return source;
}

export function parsePrimeDockerJsonResponse(source: string, label: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not JSON`, { cause: error });
  }
}

export function validatePrimeDockerResponse<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  label: string,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`${label} violates the closed schema`, { cause: parsed.error });
  }
  return parsed.data;
}
