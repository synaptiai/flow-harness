import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, relative, resolve } from "node:path";

import type { PrimeExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import {
  type PrimeHostAdmissionObservation,
  validatePrimeHostAdmission,
} from "./prime-host-admission.js";

const CGROUP_ROOT = "/sys/fs/cgroup";
type PrimeRuntimePolicy = PrimeExternalHarnessIdentity["runtime"]["policy"];

export interface PrimeHostAdmissionLocalInput {
  readonly cgroupPath: string;
}

export interface LocalPrimeHostAdmissionProbeOptions {
  readonly readText?: (path: string) => Promise<string>;
  readonly onlineCpuCount?: () => number;
  readonly measureDaemonLatency?: (signal?: AbortSignal) => Promise<number>;
  readonly waitForRuntimeProbe?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class PrimeHostPolicyTerminationError extends Error {
  override readonly name = "PrimeHostPolicyTerminationError";
}

export class LocalPrimeHostAdmissionProbe {
  readonly #measureDaemonLatency: NonNullable<
    LocalPrimeHostAdmissionProbeOptions["measureDaemonLatency"]
  >;
  readonly #onlineCpuCount: () => number;
  readonly #readText: (path: string) => Promise<string>;
  readonly #waitForRuntimeProbe: NonNullable<
    LocalPrimeHostAdmissionProbeOptions["waitForRuntimeProbe"]
  >;

  constructor(options: LocalPrimeHostAdmissionProbeOptions = {}) {
    this.#readText = options.readText ?? ((path) => readFile(path, "utf8"));
    this.#onlineCpuCount = options.onlineCpuCount ?? (() => cpus().length);
    this.#measureDaemonLatency =
      options.measureDaemonLatency ??
      (() => Promise.reject(new Error("Prime Docker daemon probe is not configured")));
    this.#waitForRuntimeProbe = options.waitForRuntimeProbe ?? waitForRuntimeProbe;
  }

  async observe(
    input: PrimeHostAdmissionLocalInput,
    policy: PrimeRuntimePolicy,
    signal?: AbortSignal,
  ): Promise<PrimeHostAdmissionObservation> {
    throwIfAborted(signal);
    const cgroupPath = resolve(input.cgroupPath);
    const fromRoot = relative(CGROUP_ROOT, cgroupPath);
    if (fromRoot.startsWith("..") || (fromRoot === "" && cgroupPath !== CGROUP_ROOT)) {
      throw new Error("Prime host cgroup path is outside the cgroup version two root");
    }
    const ancestors = cgroupAncestors(cgroupPath);
    const [meminfo, pidLimitText, controllerText, cpusetText, probeLatenciesMs, ...ancestorValues] =
      await Promise.all([
        this.#readText("/proc/meminfo"),
        this.#readText("/proc/sys/kernel/pid_max"),
        this.#readText(`${CGROUP_ROOT}/cgroup.controllers`),
        this.#readText(`${cgroupPath}/cpuset.cpus.effective`),
        Promise.all(
          Array.from({ length: policy.preflightDaemonProbeCount }, () =>
            this.#measureDaemonLatency(signal),
          ),
        ),
        ...ancestors.flatMap((path) => [
          this.#readText(`${path}/memory.max`),
          this.#readText(`${path}/memory.current`),
          this.#readText(`${path}/pids.max`),
          this.#readText(`${path}/pids.current`),
          this.#readText(`${path}/cpu.max`),
        ]),
      ]);
    const memoryAncestors: { maxBytes: number | null; currentBytes: number }[] = [];
    const pidAncestors: { max: number | null; current: number }[] = [];
    const cpuAncestors: { quotaMicros: number | null; periodMicros: number }[] = [];
    for (let index = 0; index < ancestors.length; index += 1) {
      const offset = index * 5;
      memoryAncestors.push({
        maxBytes: parseLimit(ancestorValues[offset], "memory.max"),
        currentBytes: parseInteger(ancestorValues[offset + 1], "memory.current"),
      });
      pidAncestors.push({
        max: parseLimit(ancestorValues[offset + 2], "pids.max"),
        current: parseInteger(ancestorValues[offset + 3], "pids.current"),
      });
      cpuAncestors.push(parseCpuMax(ancestorValues[offset + 4]));
    }
    const observation = {
      hostMemoryAvailableBytes: parseMemAvailable(meminfo),
      memoryAncestors,
      hostPidLimit: parseInteger(pidLimitText, "host PID limit"),
      hostPidCurrent: requiredRootPidCurrent(pidAncestors),
      pidAncestors,
      onlineCpuCount: this.#onlineCpuCount(),
      cpusetCpuCount: parseCpuSet(cpusetText),
      cpuAncestors,
      controllers: parseControllers(controllerText),
      probeLatenciesMs: [...probeLatenciesMs],
    };
    validatePrimeHostAdmission(observation, policy);
    return Object.freeze(observation);
  }

  async monitorRuntime(
    _input: PrimeHostAdmissionLocalInput,
    policy: PrimeRuntimePolicy,
    signal?: AbortSignal,
  ): Promise<void> {
    let consecutiveSlowProbes = 0;
    while (true) {
      await this.#waitForRuntimeProbe(policy.daemonProbeIntervalMs, signal);
      const latencyMs = await this.#measureDaemonLatency(signal);
      if (!Number.isFinite(latencyMs) || latencyMs < 0) {
        throw new PrimeHostPolicyTerminationError(
          "Prime runtime image latency probe returned an invalid duration",
        );
      }
      consecutiveSlowProbes =
        latencyMs > policy.maxDaemonProbeLatencyMs ? consecutiveSlowProbes + 1 : 0;
      if (consecutiveSlowProbes >= policy.maxConsecutiveSlowDaemonProbes) {
        throw new PrimeHostPolicyTerminationError(
          "Prime Docker daemon latency exceeded the admitted policy three times",
        );
      }
    }
  }
}

function cgroupAncestors(path: string): readonly string[] {
  const values: string[] = [];
  let current = path;
  while (true) {
    values.push(current);
    if (current === CGROUP_ROOT) {
      return Object.freeze(values);
    }
    const parent = dirname(current);
    if (parent === current || relative(CGROUP_ROOT, parent).startsWith("..")) {
      throw new Error("Prime host cgroup path does not reach the cgroup version two root");
    }
    current = parent;
  }
}

function parseMemAvailable(value: string): number {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(value);
  if (match?.[1] === undefined) {
    throw new Error("Prime host MemAvailable is missing or malformed");
  }
  const kilobytes = parseInteger(match[1], "MemAvailable");
  return checkedMultiply(kilobytes, 1_024, "MemAvailable bytes");
}

function parseLimit(value: string | undefined, label: string): number | null {
  const normalized = requiredText(value, label).trim();
  return normalized === "max" ? null : parseInteger(normalized, label);
}

function parseInteger(value: string | undefined, label: string): number {
  const normalized = requiredText(value, label).trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    throw new Error(`Prime host ${label} is not a nonnegative decimal integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Prime host ${label} exceeds the safe-integer range`);
  }
  return parsed;
}

function parseCpuMax(value: string | undefined) {
  const parts = requiredText(value, "cpu.max").trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new Error("Prime host cpu.max must contain quota and period");
  }
  const periodMicros = parseInteger(parts[1], "cpu.max period");
  if (periodMicros < 1) {
    throw new Error("Prime host cpu.max period must be positive");
  }
  return {
    quotaMicros: parts[0] === "max" ? null : parseInteger(parts[0], "cpu.max quota"),
    periodMicros,
  };
}

function parseCpuSet(value: string): number {
  const normalized = value.trim();
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(normalized)) {
    throw new Error("Prime host effective CPU set is malformed");
  }
  const selected = new Set<number>();
  for (const range of normalized.split(",")) {
    const [firstText, lastText = firstText] = range.split("-");
    const first = parseInteger(firstText, "CPU set start");
    const last = parseInteger(lastText, "CPU set end");
    if (last < first || last - first > 4_096) {
      throw new Error("Prime host effective CPU set range is invalid");
    }
    for (let cpu = first; cpu <= last; cpu += 1) {
      selected.add(cpu);
    }
    if (selected.size > 4_096) {
      throw new Error("Prime host effective CPU set exceeds 4096 CPUs");
    }
  }
  return selected.size;
}

function parseControllers(value: string) {
  const controllers = value.trim().split(/\s+/).filter(Boolean);
  const required = ["cpu", "io", "memory", "pids"] as const;
  if (!required.every((controller) => controllers.includes(controller))) {
    throw new Error("Prime host cgroup controllers are incomplete");
  }
  return [...required];
}

async function waitForRuntimeProbe(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolveWait, rejectWait) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolveWait();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectWait(signal?.reason ?? new Error("Prime host probe aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function requiredRootPidCurrent(
  ancestors: readonly { readonly max: number | null; readonly current: number }[],
): number {
  const root = ancestors.at(-1);
  if (root === undefined) {
    throw new Error("Prime host PID ancestors omit the cgroup root");
  }
  return root.current;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Prime host ${label} exceeds the safe-integer range`);
  }
  return value;
}

function requiredText(value: string | undefined, label: string): string {
  if (value === undefined) {
    throw new Error(`Prime host ${label} is missing`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Prime host probe aborted");
  }
}
