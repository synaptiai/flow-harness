import { createHash } from "node:crypto";

import type { LeanProofDriver, LeanProofDriverContext } from "../../application/ports.js";
import {
  isLeanProofExecutionEvidence,
  type LeanProofExecutionEvidence,
  type LeanProofRequest,
  type LeanProofRuntimeIdentity,
} from "../../domain/proof/lean-proof-verification.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import type { PrimeOciAttachedTransport } from "./attached-prime-oci-operator.js";
import type { DockerUnixApiClient } from "./docker-unix-api-client.js";

const MAX_PROOF_CONTAINER_OUTPUT_BYTES = 1_048_576;
const CLEANUP_TIMEOUT_MS = 10_000;
const LEAN_PROOF_OCI_ENV = Object.freeze([
  "HOME=/workspace/home",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "PATH=/opt/flow/bin:/opt/lean/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "LEAN_ABORT_ON_PANIC=1",
]);
export const LEAN_PROOF_OCI_MASKED_PATHS = Object.freeze([
  "/proc/acpi",
  "/proc/asound",
  "/proc/interrupts",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/timer_list",
  "/proc/timer_stats",
  "/proc/sched_debug",
  "/proc/scsi",
  "/proc/cmdline",
  "/sys/class/dmi/id",
  "/sys/devices/virtual/dmi/id",
  "/sys/firmware",
  "/sys/devices/virtual/powercap",
]);
export const LEAN_PROOF_OCI_READONLY_PATHS = Object.freeze([
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/sys",
  "/proc/sysrq-trigger",
]);

export const LEAN_PROOF_OCI_POLICY = Object.freeze({
  version: 1 as const,
  network: "none" as const,
  rootFilesystem: "read-only" as const,
  memoryMaxBytes: 4_294_967_296,
  memorySwapMaxBytes: 0,
  cpuPeriodMicros: 100_000,
  cpuQuotaMicros: 200_000,
  pidsMax: 128,
  workspaceBytes: 536_870_912,
  workspaceInodes: 65_536,
  workspaceUid: 0,
  workspaceGid: 10_001,
  workspaceMode: "0710",
  openFilesMax: 512,
  userProcessesMax: 128,
  fileSizeMaxBytes: 268_435_456,
  coreSizeMaxBytes: 0,
  stopGraceSeconds: 2,
});

export type LeanProofContainerLease =
  | LeanProofContainerIntentLease
  | (LeanProofContainerLeaseBase & {
      readonly state: "created" | "started";
      readonly containerId: string;
    });

interface LeanProofContainerLeaseBase {
  readonly version: 1;
  readonly leaseKey: string;
  readonly containerName: string;
  readonly requestDigest: string;
  readonly imageDigest: string;
  readonly profileDigest: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly attempt: number;
}

export type LeanProofContainerIntentLease = LeanProofContainerLeaseBase & {
  readonly state: "intent";
  readonly containerId?: never;
};

export interface LeanProofLeaseStore {
  read(leaseKey: string): Promise<LeanProofContainerLease | null>;
  write(leaseKey: string, lease: LeanProofContainerLease): Promise<void>;
  remove(leaseKey: string): Promise<void>;
}

export function parseLeanProofContainerLease(value: unknown): LeanProofContainerLease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Lean proof container lease must be an object");
  }
  const lease = value as Record<string, unknown>;
  const state = lease.state;
  const expectedKeys =
    state === "intent"
      ? [
          "version",
          "state",
          "leaseKey",
          "containerName",
          "requestDigest",
          "imageDigest",
          "profileDigest",
          "runId",
          "workflowId",
          "nodeId",
          "attempt",
        ]
      : [
          "version",
          "state",
          "leaseKey",
          "containerName",
          "containerId",
          "requestDigest",
          "imageDigest",
          "profileDigest",
          "runId",
          "workflowId",
          "nodeId",
          "attempt",
        ];
  if (
    (state !== "intent" && state !== "created" && state !== "started") ||
    Object.keys(lease).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(lease, key)) ||
    lease.version !== 1 ||
    typeof lease.leaseKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(lease.leaseKey) ||
    lease.containerName !== `flow-proof-${lease.leaseKey.slice(0, 32)}` ||
    typeof lease.requestDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(lease.requestDigest) ||
    typeof lease.imageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(lease.imageDigest) ||
    typeof lease.profileDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(lease.profileDigest) ||
    !validLeaseText(lease.runId) ||
    !validLeaseText(lease.workflowId) ||
    !validLeaseText(lease.nodeId) ||
    !Number.isSafeInteger(lease.attempt) ||
    (lease.attempt as number) < 1 ||
    (state !== "intent" &&
      (typeof lease.containerId !== "string" || !/^[a-f0-9]{64}$/.test(lease.containerId)))
  ) {
    throw new Error("Lean proof container lease violates the closed schema");
  }
  return Object.freeze(structuredClone(lease)) as unknown as LeanProofContainerLease;
}

type LeanProofDockerApi = Pick<
  DockerUnixApiClient,
  | "attachContainer"
  | "createContainer"
  | "inspectContainer"
  | "removeContainer"
  | "startContainer"
  | "stopContainer"
  | "waitContainer"
>;

export interface LocalLeanProofDriverOptions {
  readonly api: LeanProofDockerApi;
  readonly leaseStore: LeanProofLeaseStore;
  readonly seccompProfile: Readonly<Record<string, unknown>>;
  readonly admitRuntime: (runtime: LeanProofRuntimeIdentity) => Promise<void>;
}

interface LeanProofContainerResult {
  readonly version: 1;
  readonly requestDigest: string;
  readonly compiler: LeanProofExecutionEvidence["compiler"];
  readonly safeVerify: LeanProofExecutionEvidence["safeVerify"];
  readonly nanoda: LeanProofExecutionEvidence["nanoda"];
}

export class LocalLeanProofDriver implements LeanProofDriver {
  readonly #seccompJson: string;

  constructor(private readonly options: LocalLeanProofDriverOptions) {
    this.#seccompJson = JSON.stringify(options.seccompProfile);
    if (Buffer.byteLength(this.#seccompJson, "utf8") > 1_048_576) {
      throw new Error("Lean proof seccomp profile exceeds 1048576 bytes");
    }
  }

  async execute(
    request: LeanProofRequest,
    context: LeanProofDriverContext,
  ): Promise<LeanProofExecutionEvidence> {
    await this.options.admitRuntime(request.runtime);
    const leaseKey = leanProofLeaseKey(request, context);
    const intent = createIntent(request, context, leaseKey);
    const previous = await this.options.leaseStore.read(leaseKey);
    if (previous !== null) {
      assertSameLease(previous, intent);
      await this.#reconcilePrevious(previous);
      throw new Error("prior Lean proof runtime effect was reconciled; automatic retry is blocked");
    }

    await this.options.leaseStore.write(leaseKey, intent);
    const operation = operationSignal(context);
    let attachment: PrimeOciAttachedTransport | undefined;
    let current: LeanProofContainerLease = intent;
    let containerId: string | undefined;
    let result: LeanProofContainerResult | undefined;
    let operationError: unknown;

    try {
      try {
        containerId = await this.options.api.createContainer(
          intent.containerName,
          this.#configuration(request, intent),
          operation.signal,
        );
      } catch (error) {
        const reconciled = await this.options.api.inspectContainer(
          intent.containerName,
          cleanupSignal(),
        );
        if (reconciled !== null) {
          containerId = requireContainerId(reconciled);
          assertContainerInspection(reconciled, intent, containerId, this.#seccompJson);
        }
        throw new Error("Lean proof container creation outcome required reconciliation", {
          cause: error,
        });
      }
      const inspection = await this.options.api.inspectContainer(containerId, operation.signal);
      if (inspection === null) {
        throw new Error("Lean proof container disappeared after creation");
      }
      assertContainerInspection(inspection, intent, containerId, this.#seccompJson);
      current = Object.freeze({ ...intent, state: "created" as const, containerId });
      await this.options.leaseStore.write(leaseKey, current);

      attachment = await this.options.api.attachContainer(containerId, operation.signal);
      await this.options.api.startContainer(containerId, operation.signal);
      current = Object.freeze({ ...current, state: "started" as const });
      await this.options.leaseStore.write(leaseKey, current);
      await attachment.write(encodeContainerRequest(request), operation.signal);
      await attachment.closeInput(operation.signal);

      const [output, exitCode] = await Promise.all([
        collectOutput(attachment.output, operation.signal),
        this.options.api.waitContainer(containerId, operation.signal),
      ]);
      if (exitCode !== 0) {
        throw new Error("Lean proof container exited without a successful structured settlement");
      }
      result = parseContainerResult(output, request);
    } catch (error) {
      operationError = error;
    } finally {
      operation.dispose();
      await attachment?.release().catch(() => undefined);
    }

    const cleanupConfirmed =
      containerId === undefined
        ? await this.#confirmIntentAbsent(intent)
        : await this.#cleanupContainer(containerId);
    if (cleanupConfirmed) {
      await this.options.leaseStore.remove(leaseKey);
    }
    if (operationError !== undefined) {
      throw operationError;
    }
    if (result === undefined) {
      throw new Error("Lean proof container ended without structured evidence");
    }
    return Object.freeze({
      version: 1,
      requestDigest: request.requestDigest,
      runtimeIdentity: request.runtime,
      compiler: result.compiler,
      safeVerify: result.safeVerify,
      nanoda: result.nanoda,
      cleanup: cleanupConfirmed ? "confirmed" : "unconfirmed",
    });
  }

  async #reconcilePrevious(lease: LeanProofContainerLease): Promise<void> {
    const signal = cleanupSignal();
    const inspection = await this.options.api.inspectContainer(
      lease.containerId ?? lease.containerName,
      signal,
    );
    if (inspection === null) {
      const byName = await this.options.api.inspectContainer(lease.containerName, signal);
      if (byName !== null) {
        throw new Error("durable Lean proof container identity changed during recovery");
      }
      await this.options.leaseStore.remove(lease.leaseKey);
      return;
    }
    const containerId = requireContainerId(inspection);
    assertContainerInspection(inspection, lease, containerId, this.#seccompJson);
    if (!(await this.#cleanupContainer(containerId))) {
      throw new Error("recovered Lean proof container removal is unconfirmed");
    }
    await this.options.leaseStore.remove(lease.leaseKey);
  }

  async #confirmIntentAbsent(intent: LeanProofContainerIntentLease): Promise<boolean> {
    try {
      return (
        (await this.options.api.inspectContainer(intent.containerName, cleanupSignal())) === null
      );
    } catch {
      return false;
    }
  }

  async #cleanupContainer(containerId: string): Promise<boolean> {
    const signal = cleanupSignal();
    await this.options.api
      .stopContainer(containerId, LEAN_PROOF_OCI_POLICY.stopGraceSeconds, signal)
      .catch(() => undefined);
    await this.options.api.removeContainer(containerId, signal).catch(() => undefined);
    try {
      return (await this.options.api.inspectContainer(containerId, signal)) === null;
    } catch {
      return false;
    }
  }

  #configuration(
    request: LeanProofRequest,
    lease: LeanProofContainerIntentLease,
  ): Record<string, unknown> {
    const policy = LEAN_PROOF_OCI_POLICY;
    return {
      Image: request.runtime.imageDigest,
      Hostname: "flow-proof",
      Domainname: "",
      User: "0:10001",
      WorkingDir: "/workspace",
      Entrypoint: ["/opt/flow/bin/flow-proof-supervisor"],
      Cmd: null,
      Env: [...LEAN_PROOF_OCI_ENV],
      Labels: {
        "ai.synapti.flow.proof.lease": lease.leaseKey,
        "ai.synapti.flow.proof.request": lease.requestDigest,
        "ai.synapti.flow.proof.profile": request.runtime.profileDigest,
      },
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Healthcheck: { Test: ["NONE"] },
      StopTimeout: policy.stopGraceSeconds,
      HostConfig: {
        NetworkMode: "none",
        PidMode: "",
        IpcMode: "none",
        CgroupnsMode: "private",
        Dns: ["127.0.0.1"],
        DnsSearch: ["."],
        DnsOptions: ["ndots:0"],
        ReadonlyRootfs: true,
        LogConfig: { Type: "none", Config: {} },
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        AutoRemove: false,
        Privileged: false,
        PidsLimit: policy.pidsMax,
        Memory: policy.memoryMaxBytes,
        MemorySwap: policy.memoryMaxBytes + policy.memorySwapMaxBytes,
        CpuPeriod: policy.cpuPeriodMicros,
        CpuQuota: policy.cpuQuotaMicros,
        CapDrop: ["ALL"],
        CapAdd: ["SETUID"],
        SecurityOpt: ["no-new-privileges", `seccomp=${this.#seccompJson}`],
        Binds: [],
        MaskedPaths: [...LEAN_PROOF_OCI_MASKED_PATHS],
        ReadonlyPaths: [...LEAN_PROOF_OCI_READONLY_PATHS],
        Tmpfs: {
          "/workspace": workspaceTmpfsPolicy(policy),
        },
        Ulimits: [
          { Name: "nofile", Soft: policy.openFilesMax, Hard: policy.openFilesMax },
          { Name: "nproc", Soft: policy.userProcessesMax, Hard: policy.userProcessesMax },
          { Name: "fsize", Soft: policy.fileSizeMaxBytes, Hard: policy.fileSizeMaxBytes },
          { Name: "core", Soft: policy.coreSizeMaxBytes, Hard: policy.coreSizeMaxBytes },
        ],
      },
    };
  }
}

export function leanProofLeaseKey(
  request: Pick<LeanProofRequest, "requestDigest">,
  context: Pick<LeanProofDriverContext, "runId" | "workflowId" | "nodeId" | "attempt">,
): string {
  return sha256(
    JSON.stringify({
      version: 1,
      runId: context.runId,
      workflowId: context.workflowId,
      nodeId: context.nodeId,
      attempt: context.attempt,
      requestDigest: request.requestDigest,
    }),
  );
}

function createIntent(
  request: LeanProofRequest,
  context: LeanProofDriverContext,
  leaseKey: string,
): LeanProofContainerIntentLease {
  return Object.freeze({
    version: 1,
    state: "intent",
    leaseKey,
    containerName: `flow-proof-${leaseKey.slice(0, 32)}`,
    requestDigest: request.requestDigest,
    imageDigest: request.runtime.imageDigest,
    profileDigest: request.runtime.profileDigest,
    runId: context.runId,
    workflowId: context.workflowId,
    nodeId: context.nodeId,
    attempt: context.attempt,
  });
}

function assertSameLease(
  observed: LeanProofContainerLease,
  expected: LeanProofContainerIntentLease,
): void {
  if (
    observed.version !== 1 ||
    observed.leaseKey !== expected.leaseKey ||
    observed.containerName !== expected.containerName ||
    observed.requestDigest !== expected.requestDigest ||
    observed.imageDigest !== expected.imageDigest ||
    observed.profileDigest !== expected.profileDigest ||
    observed.runId !== expected.runId ||
    observed.workflowId !== expected.workflowId ||
    observed.nodeId !== expected.nodeId ||
    observed.attempt !== expected.attempt ||
    (observed.state !== "intent" && observed.state !== "created" && observed.state !== "started")
  ) {
    throw new Error("durable Lean proof lease contradicts the current execution");
  }
}

function assertContainerInspection(
  inspection: Record<string, unknown>,
  lease: LeanProofContainerLease,
  containerId: string,
  seccompJson: string,
): void {
  const configuration = record(inspection.Config);
  const labels = record(configuration?.Labels);
  const host = record(inspection.HostConfig);
  const policy = LEAN_PROOF_OCI_POLICY;
  if (
    inspection.Id !== containerId ||
    inspection.Image !== lease.imageDigest ||
    inspection.Name !== `/${lease.containerName}` ||
    configuration?.User !== "0:10001" ||
    configuration.Hostname !== "flow-proof" ||
    configuration.Domainname !== "" ||
    configuration.WorkingDir !== "/workspace" ||
    !sameStrings(configuration.Entrypoint, ["/opt/flow/bin/flow-proof-supervisor"]) ||
    configuration.Cmd !== null ||
    !sameStrings(configuration.Env, LEAN_PROOF_OCI_ENV) ||
    configuration.OpenStdin !== true ||
    configuration.StdinOnce !== true ||
    configuration.AttachStdin !== true ||
    configuration.AttachStdout !== true ||
    configuration.AttachStderr !== true ||
    configuration.Tty !== false ||
    configuration.StopTimeout !== policy.stopGraceSeconds ||
    !exactHealthcheck(configuration.Healthcheck) ||
    labels?.["ai.synapti.flow.proof.lease"] !== lease.leaseKey ||
    labels["ai.synapti.flow.proof.request"] !== lease.requestDigest ||
    labels["ai.synapti.flow.proof.profile"] !== lease.profileDigest ||
    host?.NetworkMode !== "none" ||
    host.PidMode !== "" ||
    host.IpcMode !== "none" ||
    host.CgroupnsMode !== "private" ||
    !sameStrings(host.Dns, ["127.0.0.1"]) ||
    !sameStrings(host.DnsSearch, ["."]) ||
    !sameStrings(host.DnsOptions, ["ndots:0"]) ||
    host.ReadonlyRootfs !== true ||
    host.AutoRemove !== false ||
    host.Privileged !== false ||
    !exactLogConfiguration(host.LogConfig) ||
    !exactRestartPolicy(host.RestartPolicy) ||
    host.PidsLimit !== policy.pidsMax ||
    host.Memory !== policy.memoryMaxBytes ||
    host.MemorySwap !== policy.memoryMaxBytes + policy.memorySwapMaxBytes ||
    host.CpuPeriod !== policy.cpuPeriodMicros ||
    host.CpuQuota !== policy.cpuQuotaMicros ||
    !sameStrings(host.CapDrop, ["ALL"]) ||
    !sameStrings(host.CapAdd, ["SETUID"]) ||
    !sameStrings(host.SecurityOpt, ["no-new-privileges", `seccomp=${seccompJson}`]) ||
    !sameStrings(host.MaskedPaths, LEAN_PROOF_OCI_MASKED_PATHS) ||
    !sameStrings(host.ReadonlyPaths, LEAN_PROOF_OCI_READONLY_PATHS) ||
    !exactWorkspaceTmpfs(host.Tmpfs, policy) ||
    !exactUlimits(host.Ulimits, policy) ||
    !emptyDockerList(host.Binds)
  ) {
    throw new Error("Lean proof container inspection contradicts its durable identity or policy");
  }
}

function exactHealthcheck(value: unknown): boolean {
  const healthcheck = record(value);
  return (
    healthcheck !== null &&
    Object.keys(healthcheck).length === 1 &&
    sameStrings(healthcheck.Test, ["NONE"])
  );
}

function exactLogConfiguration(value: unknown): boolean {
  const configuration = record(value);
  const options = record(configuration?.Config);
  return (
    configuration !== null &&
    configuration.Type === "none" &&
    options !== null &&
    Object.keys(options).length === 0
  );
}

function exactRestartPolicy(value: unknown): boolean {
  const policy = record(value);
  return policy !== null && policy.Name === "no" && policy.MaximumRetryCount === 0;
}

function exactUlimits(value: unknown, policy: typeof LEAN_PROOF_OCI_POLICY): boolean {
  if (!Array.isArray(value)) return false;
  const expected = [
    ["nofile", policy.openFilesMax],
    ["nproc", policy.userProcessesMax],
    ["fsize", policy.fileSizeMaxBytes],
    ["core", policy.coreSizeMaxBytes],
  ] as const;
  return (
    value.length === expected.length &&
    value.every((item, index) => {
      const entry = record(item);
      const [name, limit] = expected[index] ?? [];
      return entry !== null && entry.Name === name && entry.Soft === limit && entry.Hard === limit;
    })
  );
}

function exactWorkspaceTmpfs(value: unknown, policy: typeof LEAN_PROOF_OCI_POLICY): boolean {
  const tmpfs = record(value);
  return (
    tmpfs !== null &&
    Object.keys(tmpfs).length === 1 &&
    tmpfs["/workspace"] === workspaceTmpfsPolicy(policy)
  );
}

function workspaceTmpfsPolicy(policy: typeof LEAN_PROOF_OCI_POLICY): string {
  return `rw,nosuid,nodev,noexec,size=${policy.workspaceBytes},nr_inodes=${policy.workspaceInodes},uid=${policy.workspaceUid},gid=${policy.workspaceGid},mode=${policy.workspaceMode}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function emptyDockerList(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}

function requireContainerId(inspection: Record<string, unknown>): string {
  if (typeof inspection.Id !== "string" || !/^[a-f0-9]{64}$/.test(inspection.Id)) {
    throw new Error("Lean proof container inspection has an invalid full ID");
  }
  return inspection.Id;
}

function encodeContainerRequest(request: LeanProofRequest): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      version: 1,
      requestDigest: request.requestDigest,
      statement: request.statement,
      statementDigest: request.statementDigest,
      proof: request.proof,
      proofDigest: request.proofDigest,
      targetDeclaration: request.targetDeclaration,
    })}\n`,
    "utf8",
  );
}

async function collectOutput(
  output: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of output) {
    if (signal.aborted) throw abortReason(signal);
    bytes += chunk.byteLength;
    if (bytes > MAX_PROOF_CONTAINER_OUTPUT_BYTES) {
      throw new Error(
        `Lean proof container output exceeds ${MAX_PROOF_CONTAINER_OUTPUT_BYTES} bytes`,
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseContainerResult(output: Buffer, request: LeanProofRequest): LeanProofContainerResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch (error) {
    throw new Error("Lean proof container output is not valid UTF-8", { cause: error });
  }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw new Error("Lean proof container output must be one newline-terminated JSON object");
  }
  const parsed = parseStrictJson(text.slice(0, -1), {
    maxDepth: 32,
    maxNodes: 2_048,
    valueLabel: "Lean proof container output",
  });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Lean proof container output is not an object");
  }
  const candidate = {
    version: 1 as const,
    requestDigest: request.requestDigest,
    runtimeIdentity: request.runtime,
    compiler: (parsed as Record<string, unknown>).compiler,
    safeVerify: (parsed as Record<string, unknown>).safeVerify,
    nanoda: (parsed as Record<string, unknown>).nanoda,
    cleanup: "confirmed" as const,
  };
  if (
    Object.keys(parsed).length !== 5 ||
    (parsed as Record<string, unknown>).version !== 1 ||
    (parsed as Record<string, unknown>).requestDigest !== request.requestDigest ||
    !isLeanProofExecutionEvidence(candidate)
  ) {
    throw new Error("Lean proof container output violates the closed evidence schema");
  }
  return Object.freeze({
    version: 1,
    requestDigest: request.requestDigest,
    compiler: candidate.compiler,
    safeVerify: candidate.safeVerify,
    nanoda: candidate.nanoda,
  });
}

function operationSignal(context: LeanProofDriverContext): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error(`Lean proof execution exceeded ${context.timeoutMs}ms`)),
    context.timeoutMs,
  );
  timer.unref();
  return {
    signal:
      context.signal === undefined
        ? timeout.signal
        : AbortSignal.any([context.signal, timeout.signal]),
    dispose: () => clearTimeout(timer),
  };
}

function cleanupSignal(): AbortSignal {
  return AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Lean proof execution aborted");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validLeaseText(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0")
  );
}
