import { describe, expect, it, vi } from "vitest";

import { LocalPrimeHostAdmissionProbe } from "../../../../src/infrastructure/oci/local-prime-host-admission-probe.js";
import { validatePrimeHostAdmission } from "../../../../src/infrastructure/oci/prime-host-admission.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("local Prime host admission probe", () => {
  it("observes host and every cgroup ancestor without treating max as finite", async () => {
    const files = linuxFiles();
    const probe = new LocalPrimeHostAdmissionProbe({
      readText: vi.fn(async (path) => files.get(path) ?? missing(path)),
      countHostPids: vi.fn(async () => 1_000),
      onlineCpuCount: () => 8,
      measureImageLatency: vi.fn(async () => Array.from({ length: 16 }, () => 50)),
    });
    const identity = primeExternalHarnessIdentity();

    const observation = await probe.observe(
      {
        cgroupPath: "/sys/fs/cgroup/user.slice/flow.scope",
        imageProbe: {
          executablePath: "/usr/bin/dd",
          executableSha256: "a".repeat(64),
          readBytesPerSecond: 134_217_728,
          readOperationsPerSecond: 8_192,
        },
        imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
      },
      identity.runtime.policy,
    );

    expect(observation.memoryAncestors).toEqual([
      { maxBytes: 5_000_000_000, currentBytes: 705_032_704 },
      { maxBytes: null, currentBytes: 1_000_000_000 },
      { maxBytes: null, currentBytes: 1_000_000_000 },
    ]);
    expect(observation.cpuAncestors).toEqual([
      { quotaMicros: 400_000, periodMicros: 100_000 },
      { quotaMicros: null, periodMicros: 100_000 },
      { quotaMicros: null, periodMicros: 100_000 },
    ]);
    expect(observation.cpusetCpuCount).toBe(4);
    expect(() => validatePrimeHostAdmission(observation, identity.runtime.policy)).not.toThrow();
  });

  it("rejects malformed Linux values before it returns evidence", async () => {
    const files = linuxFiles();
    files.set("/sys/fs/cgroup/user.slice/flow.scope/cpu.max", "broken\n");
    const probe = new LocalPrimeHostAdmissionProbe({
      readText: vi.fn(async (path) => files.get(path) ?? missing(path)),
      countHostPids: vi.fn(async () => 1_000),
      onlineCpuCount: () => 8,
      measureImageLatency: vi.fn(async () => Array.from({ length: 16 }, () => 50)),
    });

    await expect(
      probe.observe(
        {
          cgroupPath: "/sys/fs/cgroup/user.slice/flow.scope",
          imageProbe: {
            executablePath: "/usr/bin/dd",
            executableSha256: "a".repeat(64),
            readBytesPerSecond: 134_217_728,
            readOperationsPerSecond: 8_192,
          },
          imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
        },
        primeExternalHarnessIdentity().runtime.policy,
      ),
    ).rejects.toThrow(/cpu.max/i);
  });
});

function linuxFiles() {
  const map = new Map<string, string>([
    ["/proc/meminfo", "MemTotal:       16000000 kB\nMemAvailable:    4194304 kB\n"],
    ["/proc/sys/kernel/pid_max", "1256\n"],
    ["/sys/fs/cgroup/cgroup.controllers", "cpu io memory pids\n"],
  ]);
  for (const [path, values] of [
    [
      "/sys/fs/cgroup/user.slice/flow.scope",
      {
        memoryMax: "5000000000",
        memoryCurrent: "705032704",
        pidsMax: "512",
        pidsCurrent: "256",
        cpuMax: "400000 100000",
        cpuset: "0-3",
      },
    ],
    [
      "/sys/fs/cgroup/user.slice",
      {
        memoryMax: "max",
        memoryCurrent: "1000000000",
        pidsMax: "max",
        pidsCurrent: "100",
        cpuMax: "max 100000",
        cpuset: "0-7",
      },
    ],
    [
      "/sys/fs/cgroup",
      {
        memoryMax: "max",
        memoryCurrent: "1000000000",
        pidsMax: "max",
        pidsCurrent: "100",
        cpuMax: "max 100000",
        cpuset: "0-7",
      },
    ],
  ] as const) {
    map.set(`${path}/memory.max`, `${values.memoryMax}\n`);
    map.set(`${path}/memory.current`, `${values.memoryCurrent}\n`);
    map.set(`${path}/pids.max`, `${values.pidsMax}\n`);
    map.set(`${path}/pids.current`, `${values.pidsCurrent}\n`);
    map.set(`${path}/cpu.max`, `${values.cpuMax}\n`);
    map.set(`${path}/cpuset.cpus.effective`, `${values.cpuset}\n`);
  }
  return map;
}

function missing(path: string): never {
  throw new Error(`unexpected read ${path}`);
}
