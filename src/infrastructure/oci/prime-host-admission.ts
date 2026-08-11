import { z } from "zod";

import type { PrimeExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";

type PrimeRuntimePolicy = PrimeExternalHarnessIdentity["runtime"]["policy"];

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = safeInteger.refine((value) => value > 0, "must be positive");
const finiteNonnegative = z.number().finite().nonnegative();
const memoryAncestorSchema = z
  .object({
    maxBytes: safeInteger.nullable(),
    currentBytes: safeInteger,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maxBytes !== null && value.currentBytes > value.maxBytes) {
      context.addIssue({
        code: "custom",
        path: ["currentBytes"],
        message: "current memory cannot exceed its finite maximum",
      });
    }
  });
const pidAncestorSchema = z
  .object({
    max: safeInteger.nullable(),
    current: safeInteger,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.max !== null && value.current > value.max) {
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "current PID use cannot exceed its finite maximum",
      });
    }
  });
const cpuAncestorSchema = z
  .object({
    quotaMicros: safeInteger.nullable(),
    periodMicros: positiveSafeInteger,
  })
  .strict();
const observationSchema = z
  .object({
    hostMemoryAvailableBytes: safeInteger,
    memoryAncestors: z.array(memoryAncestorSchema).max(64),
    hostPidLimit: safeInteger,
    hostPidCurrent: safeInteger,
    pidAncestors: z.array(pidAncestorSchema).max(64),
    onlineCpuCount: positiveSafeInteger,
    cpusetCpuCount: positiveSafeInteger,
    cpuAncestors: z.array(cpuAncestorSchema).max(64),
    controllers: z.array(z.enum(["cpu", "io", "memory", "pids"])).max(4),
    probeLatenciesMs: z.array(finiteNonnegative).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.hostPidCurrent > value.hostPidLimit) {
      context.addIssue({
        code: "custom",
        path: ["hostPidCurrent"],
        message: "host PID use cannot exceed its limit",
      });
    }
    if (new Set(value.controllers).size !== value.controllers.length) {
      context.addIssue({
        code: "custom",
        path: ["controllers"],
        message: "cgroup controllers must be unique",
      });
    }
  });

export type PrimeHostAdmissionObservation = z.infer<typeof observationSchema>;

export interface PrimeHostAdmissionEvidence {
  readonly effectiveMemoryHeadroomBytes: number;
  readonly effectivePidHeadroom: number;
  readonly effectiveCpuCapacity: number;
  readonly probeP95LatencyMs: number;
}

export function validatePrimeHostAdmission(
  input: unknown,
  policy: PrimeRuntimePolicy,
): PrimeHostAdmissionEvidence {
  const parsed = observationSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Prime host admission observation is invalid", { cause: parsed.error });
  }
  const observation = parsed.data;
  if (
    observation.controllers.length !== 4 ||
    !["cpu", "io", "memory", "pids"].every((item) =>
      observation.controllers.includes(item as (typeof observation.controllers)[number]),
    )
  ) {
    throw new Error("Prime host admission requires every cgroup version two controller");
  }
  if (observation.probeLatenciesMs.length !== policy.preflightDaemonProbeCount) {
    throw new Error("Prime host admission has the wrong Docker latency probe count");
  }

  const effectiveMemoryHeadroomBytes = Math.min(
    observation.hostMemoryAvailableBytes,
    ...observation.memoryAncestors.flatMap((ancestor) =>
      ancestor.maxBytes === null ? [] : [ancestor.maxBytes - ancestor.currentBytes],
    ),
  );
  if (effectiveMemoryHeadroomBytes < policy.minMemoryHeadroomBytes) {
    throw new Error("Prime host memory headroom is below the admitted minimum");
  }

  const effectivePidHeadroom = Math.min(
    observation.hostPidLimit - observation.hostPidCurrent,
    ...observation.pidAncestors.flatMap((ancestor) =>
      ancestor.max === null ? [] : [ancestor.max - ancestor.current],
    ),
  );
  if (effectivePidHeadroom < policy.minPidHeadroom) {
    throw new Error("Prime host PID headroom is below the admitted minimum");
  }

  const effectiveCpuCapacity = Math.min(
    observation.onlineCpuCount,
    observation.cpusetCpuCount,
    ...observation.cpuAncestors.flatMap((ancestor) =>
      ancestor.quotaMicros === null ? [] : [ancestor.quotaMicros / ancestor.periodMicros],
    ),
  );
  if (effectiveCpuCapacity < policy.minCpuCapacity) {
    throw new Error("Prime host CPU capacity is below the admitted minimum");
  }
  const sortedLatencies = [...observation.probeLatenciesMs].sort((left, right) => left - right);
  const p95Index = Math.ceil(sortedLatencies.length * 0.95) - 1;
  const probeP95LatencyMs = sortedLatencies[p95Index];
  if (probeP95LatencyMs === undefined || probeP95LatencyMs > policy.maxDaemonProbeLatencyMs) {
    throw new Error("Prime Docker daemon latency exceeds the admitted maximum");
  }

  return Object.freeze({
    effectiveMemoryHeadroomBytes,
    effectivePidHeadroom,
    effectiveCpuCapacity,
    probeP95LatencyMs,
  });
}
