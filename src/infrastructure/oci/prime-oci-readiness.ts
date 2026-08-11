import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import type { ExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import { parseStrictJson } from "../../domain/strict-json.js";

type PrimeIdentity = Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "prime-agent-native-v1" }
>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const imageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const filesystemSchema = z
  .object({
    type: z.literal("tmpfs"),
    bytes: safeInteger,
    inodes: safeInteger,
    mode: z.number().int().min(0).max(0o777),
    nosuid: z.literal(true),
    nodev: z.literal(true),
    noexec: z.literal(true),
  })
  .strict();
const readinessSchema = z
  .object({
    version: z.literal(1),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    trialId: z.string().regex(/^trial-[a-f0-9]{48}$/),
    identityDigest: sha256Schema,
    imageId: imageIdSchema,
    policyDigest: sha256Schema,
    process: z
      .object({
        supervisorPid: z.literal(1),
        supervisorUid: safeInteger,
        nodeUid: safeInteger,
        pythonUid: safeInteger,
        sharedGid: safeInteger,
        supplementaryGroups: z.array(safeInteger).max(8),
        capabilities: z.array(z.string().min(1).max(64)).max(32),
        dumpable: z.literal(false),
        noNewPrivileges: z.literal(true),
        seccompMode: z.literal(2),
        coreSoftBytes: z.literal(0),
        coreHardBytes: z.literal(0),
      })
      .strict(),
    limits: z
      .object({
        cgroupVersion: z.literal(2),
        pidsMax: safeInteger,
        memoryMaxBytes: safeInteger,
        memorySwapMaxBytes: safeInteger,
        cpuQuotaMicros: safeInteger,
        cpuPeriodMicros: safeInteger,
        imageDeviceMajor: safeInteger,
        imageDeviceMinor: safeInteger,
        imageReadBytesPerSecond: safeInteger,
        imageReadOperationsPerSecond: safeInteger,
        openFilesSoft: safeInteger,
        openFilesHard: safeInteger,
        userProcessesSoft: safeInteger,
        userProcessesHard: safeInteger,
        fileSizeSoftBytes: safeInteger,
        fileSizeHardBytes: safeInteger,
      })
      .strict(),
    filesystems: z
      .object({
        rootReadOnly: z.literal(true),
        workspace: filesystemSchema,
        nodeRuntime: filesystemSchema,
        supervisorRuntime: filesystemSchema,
      })
      .strict(),
    network: z
      .object({
        namespace: z.literal("private"),
        interfaces: z.tuple([z.literal("lo")]),
        routes: z.array(z.never()).length(0),
      })
      .strict(),
    systemFiles: z
      .object({
        hostname: z.literal("flow-prime"),
        hosts: z.tuple([
          z.literal("127.0.0.1 localhost flow-prime"),
          z.literal("::1 localhost ip6-localhost ip6-loopback"),
        ]),
        resolver: z.tuple([
          z.literal("nameserver 127.0.0.1"),
          z.literal("search ."),
          z.literal("options ndots:0"),
        ]),
      })
      .strict(),
    streams: z
      .object({
        stdinAttached: z.literal(true),
        stdoutAttached: z.literal(true),
        stderrAttached: z.literal(true),
        tty: z.literal(false),
      })
      .strict(),
    logDriver: z.literal("none"),
    healthcheck: z.literal("none"),
  })
  .strict();

export interface PrimeOciReadinessExpectationInput {
  readonly identity: PrimeIdentity;
  readonly identityDigest: string;
  readonly containerId: string;
  readonly trialId: string;
  readonly imageDevice: {
    readonly major: number;
    readonly minor: number;
  };
}

export type PrimeOciReadiness = z.infer<typeof readinessSchema>;

export function createExpectedPrimeOciReadiness(
  input: PrimeOciReadinessExpectationInput,
): PrimeOciReadiness {
  const policy = input.identity.runtime.policy;
  return readinessSchema.parse({
    version: 1,
    containerId: input.containerId,
    trialId: input.trialId,
    identityDigest: input.identityDigest,
    imageId: input.identity.image.id,
    policyDigest: policy.digest,
    process: {
      supervisorPid: 1,
      supervisorUid: policy.supervisorUid,
      nodeUid: policy.nodeUid,
      pythonUid: policy.pythonUid,
      sharedGid: policy.sharedGid,
      supplementaryGroups: [policy.sharedGid],
      capabilities: [...policy.supervisorCapabilities],
      dumpable: false,
      noNewPrivileges: true,
      seccompMode: 2,
      coreSoftBytes: 0,
      coreHardBytes: 0,
    },
    limits: {
      cgroupVersion: 2,
      pidsMax: policy.pidsMax,
      memoryMaxBytes: policy.memoryMaxBytes,
      memorySwapMaxBytes: policy.memorySwapMaxBytes,
      cpuQuotaMicros: policy.cpuQuotaMicros,
      cpuPeriodMicros: policy.cpuPeriodMicros,
      imageDeviceMajor: input.imageDevice.major,
      imageDeviceMinor: input.imageDevice.minor,
      imageReadBytesPerSecond: policy.imageReadBytesPerSecond,
      imageReadOperationsPerSecond: policy.imageReadOperationsPerSecond,
      openFilesSoft: policy.openFilesMax,
      openFilesHard: policy.openFilesMax,
      userProcessesSoft: policy.userProcessesMax,
      userProcessesHard: policy.userProcessesMax,
      fileSizeSoftBytes: policy.fileSizeMaxBytes,
      fileSizeHardBytes: policy.fileSizeMaxBytes,
    },
    filesystems: {
      rootReadOnly: true,
      workspace: filesystem(policy.workspaceBytes, policy.workspaceInodes, 0o710),
      nodeRuntime: filesystem(policy.nodeRuntimeBytes, policy.nodeRuntimeInodes, 0o700),
      supervisorRuntime: filesystem(
        policy.supervisorRuntimeBytes,
        policy.supervisorRuntimeInodes,
        0o700,
      ),
    },
    network: {
      namespace: "private" as const,
      interfaces: ["lo"],
      routes: [],
    },
    systemFiles: {
      hostname: "flow-prime",
      hosts: ["127.0.0.1 localhost flow-prime", "::1 localhost ip6-localhost ip6-loopback"],
      resolver: ["nameserver 127.0.0.1", "search .", "options ndots:0"],
    },
    streams: {
      stdinAttached: true,
      stdoutAttached: true,
      stderrAttached: true,
      tty: false,
    },
    logDriver: "none",
    healthcheck: "none",
  });
}

export function validatePrimeOciReadiness(
  payload: Uint8Array,
  input: PrimeOciReadinessExpectationInput,
): PrimeOciReadiness {
  let parsedInput: unknown;
  try {
    parsedInput = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(payload), {
      maxDepth: 8,
      maxNodes: 128,
      valueLabel: "Prime OCI readiness",
    });
  } catch (error) {
    throw new Error("Prime OCI readiness is not strict UTF-8 JSON", { cause: error });
  }
  const parsed = readinessSchema.safeParse(parsedInput);
  if (!parsed.success) {
    throw new Error("Prime OCI readiness violates the closed schema", { cause: parsed.error });
  }
  const expected = createExpectedPrimeOciReadiness(input);
  if (!isDeepStrictEqual(parsed.data, expected)) {
    throw new Error("Prime OCI readiness contradicts the admitted effective policy");
  }
  return Object.freeze(parsed.data);
}

function filesystem(bytes: number, inodes: number, mode: number) {
  return Object.freeze({
    type: "tmpfs" as const,
    bytes,
    inodes,
    mode,
    nosuid: true as const,
    nodev: true as const,
    noexec: true as const,
  });
}
