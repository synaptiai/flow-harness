import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DockerUnixApiClient } from "../oci/docker-unix-api-client.js";
import {
  isLinuxContainerCommandProcessOwnerAlive,
  readLinuxContainerCommandProcessOwner,
} from "../oci/linux-container-command-process-owner.js";
import { LocalContainerCommandIntentStore } from "../oci/local-container-command-intent-store.js";
import { LocalContainerCommandSandbox } from "../oci/local-container-command-sandbox.js";
import {
  LocalDockerContainerCommandEngine,
  type LocalDockerContainerCommandRuntimeDescriptor,
} from "../oci/local-docker-container-command-engine.js";
import {
  type LocalPrimeOciAttestation,
  LocalPrimeOciAttestationStore,
} from "../oci/local-prime-oci-attestation.js";
import { resolvePrimeOciAttestationPath } from "../prime/native-prime-harness-registry.js";

const CONTAINER_COMMAND_LIMITS = Object.freeze({
  stopGraceMs: 5_000,
  pidsMax: 64,
  memoryMaxBytes: 1_073_741_824,
  memorySwapMaxBytes: 0,
  cpuQuotaMicros: 100_000,
  cpuPeriodMicros: 100_000,
  openFilesMax: 1_024,
  fileSizeMaxBytes: 33_554_432,
  coreSizeMaxBytes: 0,
  temporaryBytes: 67_108_864,
  temporaryInodes: 4_096,
});
const CONTAINER_COMMAND_CLEANUP_TIMEOUT_MS = 30_000;
const COMMAND_NETWORK_SYSCALLS = new Set([
  "accept",
  "accept4",
  "bind",
  "connect",
  "getpeername",
  "getsockname",
  "getsockopt",
  "listen",
  "recv",
  "recvfrom",
  "recvmmsg",
  "recvmmsg_time64",
  "recvmsg",
  "send",
  "sendmmsg",
  "sendmmsg_time64",
  "sendmsg",
  "sendto",
  "setsockopt",
  "shutdown",
  "socket",
  "socketcall",
  "socketpair",
]);

export function createProductionContainerCommandSandbox(
  cwd = process.cwd(),
): LocalContainerCommandSandbox {
  const intentStore = new LocalContainerCommandIntentStore({
    directory: join(cwd, ".flow", "container-command-intents"),
  });
  const engine = new LocalDockerContainerCommandEngine({
    resolveDescriptor: async (signal) => {
      const descriptorPath = await resolvePrimeOciAttestationPath(cwd);
      const attestation = await new LocalPrimeOciAttestationStore({ descriptorPath }).read();
      await attestation.assertCurrent(signal);
      return projectContainerCommandRuntimeDescriptor(attestation, currentUserIdentity());
    },
    createApi: (descriptor) =>
      new DockerUnixApiClient({
        socketPath: descriptor.socketPath,
        apiVersion: descriptor.apiVersion,
      }),
    createNonce: () => randomBytes(16).toString("hex"),
    durability: {
      createOwnerNonce: () => randomBytes(32).toString("hex"),
      readProcessOwner: readLinuxContainerCommandProcessOwner,
      isOwnerAlive: isLinuxContainerCommandProcessOwnerAlive,
      store: intentStore,
    },
    createCleanupSignal: () => AbortSignal.timeout(CONTAINER_COMMAND_CLEANUP_TIMEOUT_MS),
    createPrivateDirectory: async () => {
      const directory = await mkdtemp(join(tmpdir(), "flow-container-docker-"));
      await chmod(directory, 0o700);
      return directory;
    },
    removePrivateDirectory: (path) => rm(path, { recursive: true, force: true, maxRetries: 2 }),
  });
  return new LocalContainerCommandSandbox(engine);
}

export function projectContainerCommandRuntimeDescriptor(
  attestation: LocalPrimeOciAttestation,
  user: { readonly uid: number; readonly gid: number },
): LocalDockerContainerCommandRuntimeDescriptor {
  if (
    !Number.isSafeInteger(user.uid) ||
    user.uid <= 0 ||
    !Number.isSafeInteger(user.gid) ||
    user.gid <= 0
  ) {
    throw new Error("container command sandbox requires a non-root host user identity");
  }
  const seccompProfile = projectContainerCommandSeccompProfile(
    attestation.localRuntime.seccompProfile,
  );
  const policyContent = {
    version: 1,
    profile: "flow-container-v1",
    runtime: attestation.runtime,
    image: attestation.image,
    local: {
      daemonId: attestation.localRuntime.daemonId,
      socketPath: attestation.localRuntime.socketPath,
      socket: attestation.localRuntime.socket,
      apiVersion: attestation.localRuntime.apiVersion,
      executables: attestation.localRuntime.executables,
      seccompProfile,
    },
    user,
    controls: {
      command: "exec-vector",
      network: "none",
      ipc: "none",
      cgroupNamespace: "private",
      readOnlyRoot: true,
      noNewPrivileges: true,
      capabilities: [],
      workspace: "one-canonical-read-write-bind",
      runtimeSupport: "explicit-read-only-binds",
      protectedState: "nested-masked-parent-rejected",
      environment: "fixed-plus-node-path",
      logging: "none",
      restart: "never",
      cleanup: "stop-remove-confirm-absence",
      limits: CONTAINER_COMMAND_LIMITS,
    },
  };
  const policyDigest = createHash("sha256").update(canonicalize(policyContent)).digest("hex");
  return deepFreeze({
    engineVersion: attestation.runtime.engine.serverVersion,
    apiVersion: attestation.localRuntime.apiVersion,
    socketPath: attestation.localRuntime.socketPath,
    dockerExecutable: attestation.localRuntime.executables.docker.path,
    imageId: attestation.image.id,
    runtimeName: attestation.runtime.policy.runtimeName,
    policyDigest,
    seccompProfile,
    user: { ...user },
    limits: { ...CONTAINER_COMMAND_LIMITS },
    assertCurrent: (signal?: AbortSignal) => attestation.assertCurrent(signal),
  });
}

function projectContainerCommandSeccompProfile(
  profile: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (profile.defaultAction !== "SCMP_ACT_ERRNO" || profile.defaultErrnoRet !== 1) {
    throw new Error("Prime seccomp profile does not deny by default");
  }
  if (!Array.isArray(profile.syscalls)) {
    throw new Error("Prime seccomp profile has no syscall rules");
  }
  const syscalls = profile.syscalls.flatMap((rule) => {
    if (
      typeof rule !== "object" ||
      rule === null ||
      Array.isArray(rule) ||
      !("names" in rule) ||
      !Array.isArray(rule.names) ||
      rule.names.length === 0 ||
      !rule.names.every((name: unknown) => typeof name === "string")
    ) {
      throw new Error("Prime seccomp profile has an invalid syscall rule");
    }
    const names = rule.names.filter(
      (name: unknown): name is string =>
        typeof name === "string" && !COMMAND_NETWORK_SYSCALLS.has(name),
    );
    return names.length === 0 ? [] : [{ ...structuredClone(rule), names }];
  });
  return deepFreeze({ ...structuredClone(profile), syscalls });
}

function currentUserIdentity(): { readonly uid: number; readonly gid: number } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("container command sandbox requires a POSIX user identity");
  }
  return { uid, gid };
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
    throw new Error("container command policy contains a non-JSON value");
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
