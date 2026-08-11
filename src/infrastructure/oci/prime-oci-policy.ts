import { createHash } from "node:crypto";

import type { PrimeExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";

type PrimeRuntimePolicy = PrimeExternalHarnessIdentity["runtime"]["policy"];
type PrimeRuntimePolicyContent = Omit<PrimeRuntimePolicy, "digest" | "seccompSha256">;

const sha256Pattern = /^[a-f0-9]{64}$/;

export const PRIME_OCI_RUNTIME_NAME = "flow-prime-runc" as const;

const VERSION_ONE_POLICY = Object.freeze({
  runtimeName: PRIME_OCI_RUNTIME_NAME,
  maxActivePrimeContainers: 1,
  minMemoryHeadroomBytes: 4_294_967_296,
  minPidHeadroom: 256,
  minCpuCapacity: 4,
  preflightDaemonProbeCount: 16,
  maxDaemonProbeLatencyMs: 100,
  daemonProbeIntervalMs: 250,
  maxConsecutiveSlowDaemonProbes: 3,
  pidsMax: 64,
  memoryMaxBytes: 2_147_483_648,
  memorySwapMaxBytes: 0,
  cpuQuotaMicros: 200_000,
  cpuPeriodMicros: 100_000,
  imageReadBytesPerSecond: 67_108_864,
  imageReadOperationsPerSecond: 4_096,
  openFilesMax: 256,
  userProcessesMax: 64,
  fileSizeMaxBytes: 268_435_456,
  coreSizeMaxBytes: 0,
  workspaceBytes: 536_870_912,
  workspaceInodes: 8_192,
  nodeRuntimeBytes: 16_777_216,
  nodeRuntimeInodes: 256,
  supervisorRuntimeBytes: 16_777_216,
  supervisorRuntimeInodes: 256,
  diagnosticBytes: 65_536,
  stopGraceMs: 5_000,
  cleanupGraceMs: 30_000,
  network: "none",
  ipc: "none",
  logDriver: "none",
  healthcheck: "none",
  pull: "never",
  readOnlyRoot: true,
  noNewPrivileges: true,
  rejectPipedCore: true,
  supervisorCapabilities: ["CHOWN", "DAC_READ_SEARCH", "FOWNER", "KILL", "SETGID", "SETUID"],
  supervisorUid: 0,
  nodeUid: 10_001,
  pythonUid: 10_002,
  sharedGid: 10_003,
} as const satisfies PrimeRuntimePolicyContent);

export function createPrimeOciRuntimePolicy(seccompSha256: string): PrimeRuntimePolicy {
  if (!sha256Pattern.test(seccompSha256)) {
    throw new Error("Prime OCI seccomp digest is invalid");
  }
  const content = Object.freeze({ ...VERSION_ONE_POLICY, seccompSha256 });
  const digest = createHash("sha256").update(canonicalize(content)).digest("hex");
  return deepFreeze({ digest, ...content });
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("Prime OCI policy contains a non-JSON value");
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
