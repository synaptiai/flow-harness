import { createHash } from "node:crypto";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const semanticVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );

const externalHarnessIdentitySchema = z
  .object({
    version: z.literal(1),
    adapter: z.literal("pi-native-v1"),
    adapterContractVersion: semanticVersionSchema,
    protocol: z
      .object({
        id: z.literal("flow-external-harness-jsonl-v1"),
        maxFrameBytes: z.literal(1_048_576),
        digest: sha256Schema,
      })
      .strict(),
    runtime: z
      .object({
        id: z.literal("srt-process-v1"),
        package: z.literal("@anthropic-ai/sandbox-runtime"),
        version: semanticVersionSchema,
        packageContentSha256: sha256Schema,
        policyDigest: sha256Schema,
        platform: z.literal("linux"),
        containment: z.literal("linux-pid-namespace"),
      })
      .strict(),
    driver: z
      .object({
        id: z.literal("native-pi-evaluation-v1"),
        artifactSha256: sha256Schema,
        dependencyClosureSha256: sha256Schema,
        node: z
          .object({
            version: semanticVersionSchema,
            executableSha256: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    harness: z
      .object({
        package: z.literal("@earendil-works/pi-coding-agent"),
        version: semanticVersionSchema,
        integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
        packageContentSha256: sha256Schema,
        config: z.literal("pi-evaluation-v1"),
        configDigest: sha256Schema,
      })
      .strict(),
    inference: z
      .object({
        id: z.literal("flow-pi-inference-v1"),
        version: z.literal(1),
        package: z.literal("@earendil-works/pi-ai"),
        packageVersion: semanticVersionSchema,
        packageIntegrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
        packageContentSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

export type ExternalHarnessIdentity = z.infer<typeof externalHarnessIdentitySchema>;

export function parseExternalHarnessIdentity(input: unknown): ExternalHarnessIdentity {
  const parsed = externalHarnessIdentitySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("external harness identity is invalid", { cause: parsed.error });
  }
  return deepFreeze(parsed.data);
}

export function externalHarnessIdentityDigest(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(parseExternalHarnessIdentity(input)))
    .digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
