import { createHash } from "node:crypto";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const semanticVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
const dockerImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const protocolSchema = z
  .object({
    id: z.literal("flow-external-harness-jsonl-v1"),
    maxFrameBytes: z.literal(1_048_576),
    digest: sha256Schema,
  })
  .strict();

const runtimeSchema = z
  .object({
    id: z.literal("srt-process-v1"),
    package: z.literal("@anthropic-ai/sandbox-runtime"),
    version: semanticVersionSchema,
    packageContentSha256: sha256Schema,
    policyDigest: sha256Schema,
    platform: z.literal("linux"),
    containment: z.literal("linux-pid-namespace"),
  })
  .strict();

const piExternalHarnessIdentitySchema = z
  .object({
    version: z.literal(1),
    adapter: z.literal("pi-native-v1"),
    adapterContractVersion: semanticVersionSchema,
    protocol: protocolSchema,
    runtime: runtimeSchema,
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

const ompExternalHarnessIdentitySchema = z
  .object({
    version: z.literal(1),
    adapter: z.literal("omp-native-v1"),
    adapterContractVersion: semanticVersionSchema,
    protocol: protocolSchema,
    runtime: runtimeSchema,
    driver: z
      .object({
        id: z.literal("native-omp-evaluation-v1"),
        artifactSha256: sha256Schema,
        dependencyClosureSha256: sha256Schema,
        bun: z
          .object({
            version: semanticVersionSchema,
            executableSha256: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    harness: z
      .object({
        package: z.literal("@oh-my-pi/pi-coding-agent"),
        version: semanticVersionSchema,
        integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
        packageContentSha256: sha256Schema,
        dependencyClosureSha256: sha256Schema,
        config: z.literal("omp-evaluation-v1"),
        configDigest: sha256Schema,
      })
      .strict(),
    inference: z
      .object({
        id: z.literal("flow-omp-inference-v1"),
        version: z.literal(1),
        package: z.literal("@oh-my-pi/pi-ai"),
        packageVersion: semanticVersionSchema,
        packageContentSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

const primeOuterProtocolSchema = z
  .object({
    id: z.literal("flow-prime-container-v1"),
    version: z.literal(1),
    maxPayloadBytes: z.literal(1_048_576),
    maxEncodedFrameBytes: z.literal(1_048_581),
    maxFileChunkBytes: z.literal(65_536),
    maxEntries: z.literal(4_096),
    maxPathBytes: z.literal(4_095),
    maxPathComponentBytes: z.literal(255),
    maxFileBytes: z.literal(268_435_456),
    maxLogicalBytes: z.literal(268_435_456),
    maxTransferFrames: z.literal(16_385),
    maxChunkFrames: z.literal(8_191),
    maxEncodedTransferBytes: z.literal(318_767_104),
    maxDriverFrames: z.literal(512),
    maxDriverBytes: z.literal(138_412_032),
    maxStreamBytes: z.literal(457_179_136),
    maxModelTurns: z.literal(64),
    maxIpythonCalls: z.literal(64),
    hostParserSha256: sha256Schema,
    supervisorSha256: sha256Schema,
  })
  .strict();

const primeRuntimePolicySchema = z
  .object({
    digest: sha256Schema,
    runtimeName: z.literal("flow-prime-runc"),
    maxActivePrimeContainers: z.literal(1),
    minMemoryHeadroomBytes: z.literal(4_294_967_296),
    minPidHeadroom: z.literal(256),
    minCpuCapacity: z.literal(4),
    preflightDaemonProbeCount: z.literal(16),
    maxDaemonProbeLatencyMs: z.literal(100),
    daemonProbeIntervalMs: z.literal(250),
    maxConsecutiveSlowDaemonProbes: z.literal(3),
    pidsMax: z.literal(64),
    memoryMaxBytes: z.literal(2_147_483_648),
    memorySwapMaxBytes: z.literal(0),
    cpuQuotaMicros: z.literal(200_000),
    cpuPeriodMicros: z.literal(100_000),
    imageReadBytesPerSecond: z.literal(67_108_864),
    imageReadOperationsPerSecond: z.literal(4_096),
    openFilesMax: z.literal(256),
    userProcessesMax: z.literal(64),
    fileSizeMaxBytes: z.literal(268_435_456),
    coreSizeMaxBytes: z.literal(0),
    workspaceBytes: z.literal(536_870_912),
    workspaceInodes: z.literal(8_192),
    nodeRuntimeBytes: z.literal(16_777_216),
    nodeRuntimeInodes: z.literal(256),
    supervisorRuntimeBytes: z.literal(16_777_216),
    supervisorRuntimeInodes: z.literal(256),
    diagnosticBytes: z.literal(65_536),
    stopGraceMs: z.literal(5_000),
    cleanupGraceMs: z.literal(30_000),
    network: z.literal("none"),
    ipc: z.literal("none"),
    logDriver: z.literal("none"),
    healthcheck: z.literal("none"),
    pull: z.literal("never"),
    readOnlyRoot: z.literal(true),
    noNewPrivileges: z.literal(true),
    rejectPipedCore: z.literal(true),
    supervisorCapabilities: z.tuple([
      z.literal("CHOWN"),
      z.literal("DAC_READ_SEARCH"),
      z.literal("FOWNER"),
      z.literal("KILL"),
      z.literal("SETGID"),
      z.literal("SETUID"),
    ]),
    seccompSha256: sha256Schema,
    supervisorUid: z.literal(0),
    nodeUid: z.literal(10_001),
    pythonUid: z.literal(10_002),
    sharedGid: z.literal(10_003),
  })
  .strict();

const primeExternalHarnessIdentitySchema = z
  .object({
    version: z.literal(1),
    adapter: z.literal("prime-agent-native-v1"),
    adapterContractVersion: semanticVersionSchema,
    protocol: protocolSchema,
    outerProtocol: primeOuterProtocolSchema,
    runtime: z
      .object({
        id: z.literal("docker-oci-v1"),
        platform: z.literal("linux"),
        architecture: z.enum(["x64", "arm64"]),
        client: z
          .object({
            version: semanticVersionSchema,
            executableSha256: sha256Schema,
          })
          .strict(),
        engine: z
          .object({
            serverVersion: semanticVersionSchema,
            serverCommit: z.string().min(1).max(128),
            dockerdSha256: sha256Schema,
            apiVersion: z.string().regex(/^\d+\.\d+$/),
            kernelRelease: z.string().min(1).max(128),
            kernelSecurityConfigSha256: sha256Schema,
            containerdVersion: semanticVersionSchema,
            containerdSha256: sha256Schema,
            runcVersion: semanticVersionSchema,
            runcSha256: sha256Schema,
            cgroupVersion: z.literal(2),
            cgroupDriver: z.literal("systemd"),
            storageDriver: z.string().min(1).max(64),
            rootless: z.boolean(),
            securityOptionsSha256: sha256Schema,
          })
          .strict(),
        policy: primeRuntimePolicySchema,
      })
      .strict(),
    image: z
      .object({
        id: dockerImageDigestSchema,
        ociManifestSha256: sha256Schema,
        platformConfigSha256: sha256Schema,
        buildInputSha256: sha256Schema,
        sbomSha256: sha256Schema,
        baseImageDigest: dockerImageDigestSchema,
        nodeVersion: semanticVersionSchema,
        nodeClosureSha256: sha256Schema,
        pythonVersion: semanticVersionSchema,
        pythonClosureSha256: sha256Schema,
      })
      .strict(),
    driver: z
      .object({
        id: z.literal("native-prime-agent-evaluation-v1"),
        artifactSha256: sha256Schema,
        dependencyClosureSha256: sha256Schema,
        kernelProxySha256: sha256Schema,
        pythonLauncherSha256: sha256Schema,
        noIoResourceLoaderSha256: sha256Schema,
        configDigest: sha256Schema,
      })
      .strict(),
    harness: z
      .object({
        package: z.literal("prime-agent"),
        version: z.literal("0.7.1"),
        archiveSha256: z.literal(
          "d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb",
        ),
        packageContentSha256: sha256Schema,
        dependencyClosureSha256: sha256Schema,
        config: z.literal("prime-agent-rlm-evaluation-v1"),
      })
      .strict(),
    inference: z
      .object({
        id: z.literal("flow-prime-inference-v1"),
        version: z.literal(1),
        brokerSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

const externalHarnessIdentitySchema = z.discriminatedUnion("adapter", [
  piExternalHarnessIdentitySchema,
  ompExternalHarnessIdentitySchema,
  primeExternalHarnessIdentitySchema,
]);

export type ExternalHarnessIdentity = z.infer<typeof externalHarnessIdentitySchema>;
export type PrimeExternalHarnessIdentity = Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "prime-agent-native-v1" }
>;

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

export function parsePrimeOciRuntimeIdentity(
  input: unknown,
): PrimeExternalHarnessIdentity["runtime"] {
  const parsed = primeExternalHarnessIdentitySchema.shape.runtime.safeParse(input);
  if (!parsed.success) {
    throw new Error("Prime OCI runtime identity is invalid", { cause: parsed.error });
  }
  return deepFreeze(parsed.data);
}

export function parsePrimeOciImageIdentity(input: unknown): PrimeExternalHarnessIdentity["image"] {
  const parsed = primeExternalHarnessIdentitySchema.shape.image.safeParse(input);
  if (!parsed.success) {
    throw new Error("Prime OCI image identity is invalid", { cause: parsed.error });
  }
  return deepFreeze(parsed.data);
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
