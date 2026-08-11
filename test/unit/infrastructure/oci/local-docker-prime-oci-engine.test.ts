import { describe, expect, it, vi } from "vitest";

import type { ExternalHarnessIdentity } from "../../../../src/domain/evaluation/external-harness.js";
import type { DockerUnixApiClient } from "../../../../src/infrastructure/oci/docker-unix-api-client.js";
import { LocalDockerPrimeOciEngine } from "../../../../src/infrastructure/oci/local-docker-prime-oci-engine.js";
import type { PrimeOciIntentLease } from "../../../../src/infrastructure/oci/prime-container-lifecycle.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

type PrimeIdentity = Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "prime-agent-native-v1" }
>;

describe("local Docker Prime OCI engine", () => {
  it("creates one closed container and reconciles it before start", async () => {
    const fixture = engineFixture();
    const engine = new LocalDockerPrimeOciEngine(fixture.options);

    await expect(engine.create(fixture.intent)).resolves.toEqual({
      containerId: fixture.containerId,
      inspectedPolicyDigest: fixture.identity.runtime.policy.digest,
    });
    expect(fixture.api.createContainer).toHaveBeenCalledWith(
      fixture.intent.containerName,
      expect.objectContaining({
        Image: fixture.intent.imageId,
        Hostname: "flow-prime",
        Domainname: "",
        User: "0:10003",
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Healthcheck: { Test: ["NONE"] },
        HostConfig: expect.objectContaining({
          NetworkMode: "none",
          PidMode: "",
          Dns: ["127.0.0.1"],
          DnsSearch: ["."],
          DnsOptions: ["ndots:0"],
          IpcMode: "none",
          CgroupnsMode: "private",
          Runtime: "flow-prime-runc",
          ReadonlyRootfs: true,
          LogConfig: { Type: "none", Config: {} },
          RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
          PidsLimit: 64,
          Memory: 2_147_483_648,
          MemorySwap: 2_147_483_648,
          CpuQuota: 200_000,
          CpuPeriod: 100_000,
          CapDrop: ["ALL"],
          CapAdd: ["CHOWN", "DAC_READ_SEARCH", "FOWNER", "KILL", "SETGID", "SETUID"],
          SecurityOpt: ["no-new-privileges", expect.stringMatching(/^seccomp=/)],
          Binds: [],
          MaskedPaths: expect.arrayContaining([
            "/proc/cmdline",
            "/proc/sys",
            "/sys/block",
            "/sys/class",
            "/sys/class/dmi/id",
            "/sys/devices",
            "/sys/devices/virtual/dmi/id",
          ]),
        }),
      }),
      undefined,
    );

    await expect(engine.attach(fixture.containerId)).resolves.toBe(fixture.attached);
    await engine.start(fixture.containerId);
    expect(fixture.api.inspectContainer).toHaveBeenCalledTimes(2);
    expect(fixture.api.startContainer).toHaveBeenCalledWith(fixture.containerId, undefined);
    expect(fixture.api.attachContainer).toHaveBeenCalledWith(fixture.containerId, undefined);
  });

  it.each([
    ["image", (value: Record<string, unknown>) => (value.Image = `sha256:${"0".repeat(64)}`)],
    [
      "network",
      (value: Record<string, unknown>) =>
        ((value.HostConfig as Record<string, unknown>).NetworkMode = "bridge"),
    ],
    [
      "PID namespace",
      (value: Record<string, unknown>) =>
        ((value.HostConfig as Record<string, unknown>).PidMode = "host"),
    ],
    [
      "hostname",
      (value: Record<string, unknown>) =>
        ((value.Config as Record<string, unknown>).Hostname = "private-host"),
    ],
    [
      "resolver",
      (value: Record<string, unknown>) =>
        ((value.HostConfig as Record<string, unknown>).DnsSearch = ["private.example"]),
    ],
    [
      "cgroup namespace",
      (value: Record<string, unknown>) =>
        ((value.HostConfig as Record<string, unknown>).CgroupnsMode = "host"),
    ],
    [
      "runtime",
      (value: Record<string, unknown>) =>
        ((value.HostConfig as Record<string, unknown>).Runtime = "alternate"),
    ],
    [
      "masked path",
      (value: Record<string, unknown>) =>
        ((value.HostConfig as Record<string, unknown>).MaskedPaths = []),
    ],
    [
      "log",
      (value: Record<string, unknown>) =>
        ((value.HostConfig as Record<string, unknown>).LogConfig = { Type: "json-file" }),
    ],
    [
      "stream",
      (value: Record<string, unknown>) =>
        ((value.Config as Record<string, unknown>).OpenStdin = false),
    ],
    [
      "health",
      (value: Record<string, unknown>) =>
        ((value.Config as Record<string, unknown>).Healthcheck = null),
    ],
  ])("rejects a changed %s control before start", async (_name, mutate) => {
    const fixture = engineFixture();
    const engine = new LocalDockerPrimeOciEngine(fixture.options);
    await engine.create(fixture.intent);
    const changed = structuredClone(fixture.inspection);
    mutate(changed);
    vi.mocked(fixture.api.inspectContainer).mockResolvedValueOnce(changed);

    await expect(engine.start(fixture.containerId)).rejects.toThrow(/policy|control/i);
    expect(fixture.api.startContainer).not.toHaveBeenCalled();
  });

  it("recovers only the exact intent name and durable labels", async () => {
    const fixture = engineFixture();
    const engine = new LocalDockerPrimeOciEngine(fixture.options);

    await expect(engine.recoverIntent(fixture.intent)).resolves.toEqual({
      containerId: fixture.containerId,
      inspectedPolicyDigest: fixture.identity.runtime.policy.digest,
    });

    vi.mocked(fixture.api.inspectContainer).mockResolvedValueOnce(null);
    await expect(engine.recoverIntent(fixture.intent)).resolves.toBeNull();

    const changed = structuredClone(fixture.inspection);
    (changed.Config as Record<string, unknown>).Labels = {
      ...fixture.intent.labels,
      "flow.owner-nonce": "f".repeat(64),
    };
    vi.mocked(fixture.api.inspectContainer).mockResolvedValueOnce(changed);
    await expect(engine.recoverIntent(fixture.intent)).rejects.toThrow(/label|policy/i);
  });

  it("reconciles the complete durable identity before recovery cleanup", async () => {
    const fixture = engineFixture();
    const engine = new LocalDockerPrimeOciEngine(fixture.options);
    const lease = {
      ...fixture.intent,
      state: "started" as const,
      containerId: fixture.containerId,
      inspectedPolicyDigest: fixture.identity.runtime.policy.digest,
    };

    await expect(engine.recoverCreated(lease)).resolves.toEqual({
      containerId: fixture.containerId,
      inspectedPolicyDigest: fixture.identity.runtime.policy.digest,
    });

    const changed = structuredClone(fixture.inspection);
    (changed.Config as Record<string, unknown>).Labels = {
      ...((changed.Config as Record<string, unknown>).Labels as Record<string, string>),
      "flow.owner-nonce": "0".repeat(64),
    };
    vi.mocked(fixture.api.inspectContainer).mockResolvedValueOnce(changed);

    await expect(engine.recoverCreated(lease)).rejects.toThrow(/policy|control/i);
    expect(fixture.api.stopContainer).not.toHaveBeenCalled();
    expect(fixture.api.removeContainer).not.toHaveBeenCalled();
  });

  it("stops, removes, and confirms absence through the full ID", async () => {
    const fixture = engineFixture();
    const engine = new LocalDockerPrimeOciEngine(fixture.options);

    await engine.create(fixture.intent);
    await engine.attach(fixture.containerId);
    await engine.stop(fixture.containerId);
    await engine.remove(fixture.containerId);
    await expect(engine.confirmRemoved(fixture.containerId)).resolves.toBe(false);
    vi.mocked(fixture.api.inspectContainer).mockResolvedValueOnce(null);
    await expect(engine.confirmRemoved(fixture.containerId)).resolves.toBe(true);

    expect(fixture.api.stopContainer).toHaveBeenCalledWith(fixture.containerId, 5, undefined);
    expect(fixture.attached.release).toHaveBeenCalledOnce();
    expect(fixture.api.removeContainer).toHaveBeenCalledWith(fixture.containerId, undefined);
  });
});

function engineFixture() {
  const identity = primeExternalHarnessIdentity();
  const intent = intentLease(identity);
  const containerId = "e".repeat(64);
  const inspection = inspectionFor(identity, intent, containerId);
  const attached = {
    output: (async function* () {})(),
    write: vi.fn(async () => undefined),
    closeInput: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  const api = {
    createContainer: vi.fn(async () => containerId),
    inspectContainer: vi.fn(async () => inspection),
    attachContainer: vi.fn(async () => attached),
    startContainer: vi.fn(async () => undefined),
    stopContainer: vi.fn(async () => undefined),
    removeContainer: vi.fn(async () => undefined),
  } as unknown as DockerUnixApiClient;
  return {
    api,
    attached,
    containerId,
    identity,
    inspection,
    intent,
    options: {
      api,
      identity,
      seccompProfile: { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] },
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
    },
  };
}

function intentLease(identity: PrimeIdentity): PrimeOciIntentLease {
  const ownerNonce = "a".repeat(64);
  return {
    version: 1,
    adapter: "prime-agent-native-v1",
    state: "intent",
    ownerNonce,
    containerName: `flow-prime-${"d".repeat(32)}`,
    labels: {
      evaluationId: "evaluation-run",
      trialId: `trial-${"c".repeat(48)}`,
      ownerNonce,
      imageId: identity.image.id,
      policyDigest: identity.runtime.policy.digest,
    },
    imageId: identity.image.id,
    policyDigest: identity.runtime.policy.digest,
    fixtureDigest: "b".repeat(64),
    engineEndpoint: {
      socketPath: "/var/run/docker.sock",
      device: 1,
      inode: 2,
      uid: 0,
      gid: 999,
      mode: 0o660,
    },
  };
}

function inspectionFor(
  identity: PrimeIdentity,
  intent: PrimeOciIntentLease,
  containerId: string,
): Record<string, unknown> {
  const policy = identity.runtime.policy;
  return {
    Id: containerId,
    Name: `/${intent.containerName}`,
    Image: intent.imageId,
    Config: {
      Image: intent.imageId,
      Hostname: "flow-prime",
      Domainname: "",
      User: `${policy.supervisorUid}:${policy.sharedGid}`,
      WorkingDir: "/workspace",
      Env: ["PRIME_AGENT_KERNEL_FORKSERVER=0"],
      Labels: {
        "flow.evaluation-id": intent.labels.evaluationId,
        "flow.trial-id": intent.labels.trialId,
        "flow.owner-nonce": intent.labels.ownerNonce,
        "flow.image-id": intent.labels.imageId,
        "flow.policy-digest": intent.labels.policyDigest,
      },
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Healthcheck: { Test: ["NONE"] },
      StopTimeout: 5,
    },
    HostConfig: {
      NetworkMode: "none",
      PidMode: "",
      Dns: ["127.0.0.1"],
      DnsSearch: ["."],
      DnsOptions: ["ndots:0"],
      IpcMode: "none",
      CgroupnsMode: "private",
      Runtime: "flow-prime-runc",
      ReadonlyRootfs: true,
      LogConfig: { Type: "none", Config: {} },
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false,
      PidsLimit: policy.pidsMax,
      Memory: policy.memoryMaxBytes,
      MemorySwap: policy.memoryMaxBytes + policy.memorySwapMaxBytes,
      CpuQuota: policy.cpuQuotaMicros,
      CpuPeriod: policy.cpuPeriodMicros,
      CapDrop: ["ALL"],
      CapAdd: [...policy.supervisorCapabilities],
      SecurityOpt: [
        "no-new-privileges",
        'seccomp={"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}',
      ],
      Binds: [],
      MaskedPaths: [
        "/proc/acpi",
        "/proc/asound",
        "/proc/kcore",
        "/proc/keys",
        "/proc/latency_stats",
        "/proc/timer_list",
        "/proc/timer_stats",
        "/proc/sched_debug",
        "/proc/scsi",
        "/proc/cmdline",
        "/proc/sys",
        "/sys/block",
        "/sys/bus",
        "/sys/class",
        "/sys/class/dmi/id",
        "/sys/dev",
        "/sys/devices",
        "/sys/devices/virtual/dmi/id",
        "/sys/firmware",
        "/sys/hypervisor",
        "/sys/kernel",
        "/sys/module",
        "/sys/power",
        "/sys/devices/virtual/powercap",
      ],
      Tmpfs: {
        "/workspace": `rw,nosuid,nodev,noexec,size=${policy.workspaceBytes},nr_inodes=${policy.workspaceInodes},mode=0710`,
        "/run/flow-node": `rw,nosuid,nodev,noexec,size=${policy.nodeRuntimeBytes},nr_inodes=${policy.nodeRuntimeInodes},mode=0700`,
        "/run/flow-supervisor": `rw,nosuid,nodev,noexec,size=${policy.supervisorRuntimeBytes},nr_inodes=${policy.supervisorRuntimeInodes},mode=0700`,
      },
      Ulimits: [
        { Name: "nofile", Soft: policy.openFilesMax, Hard: policy.openFilesMax },
        { Name: "nproc", Soft: policy.userProcessesMax, Hard: policy.userProcessesMax },
        { Name: "fsize", Soft: policy.fileSizeMaxBytes, Hard: policy.fileSizeMaxBytes },
        { Name: "core", Soft: policy.coreSizeMaxBytes, Hard: policy.coreSizeMaxBytes },
      ],
      BlkioDeviceReadBps: [{ Path: "/dev/test-image", Rate: policy.imageReadBytesPerSecond }],
      BlkioDeviceReadIOps: [{ Path: "/dev/test-image", Rate: policy.imageReadOperationsPerSecond }],
    },
  };
}
