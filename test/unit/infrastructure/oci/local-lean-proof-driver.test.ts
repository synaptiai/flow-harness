import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { createLeanProofRequest } from "../../../../src/domain/proof/lean-proof-verification.js";
import {
  LEAN_PROOF_OCI_POLICY,
  LEAN_PROOF_OCI_MASKED_PATHS,
  type LeanProofContainerLease,
  LocalLeanProofDriver,
  leanProofLeaseKey,
} from "../../../../src/infrastructure/oci/local-lean-proof-driver.js";

describe("local Lean proof driver", () => {
  it("keeps the public proof profile synchronized with the enforced OCI policy", async () => {
    const profile = JSON.parse(await readFile("proof-container/profile.json", "utf8"));

    expect(profile.policy).toMatchObject({
      network: LEAN_PROOF_OCI_POLICY.network,
      rootFilesystem: LEAN_PROOF_OCI_POLICY.rootFilesystem,
      memoryMaxBytes: LEAN_PROOF_OCI_POLICY.memoryMaxBytes,
      memorySwapMaxBytes: LEAN_PROOF_OCI_POLICY.memorySwapMaxBytes,
      cpuPeriodMicros: LEAN_PROOF_OCI_POLICY.cpuPeriodMicros,
      cpuQuotaMicros: LEAN_PROOF_OCI_POLICY.cpuQuotaMicros,
      pidsMax: LEAN_PROOF_OCI_POLICY.pidsMax,
      workspaceBytes: LEAN_PROOF_OCI_POLICY.workspaceBytes,
      workspaceInodes: LEAN_PROOF_OCI_POLICY.workspaceInodes,
      workspaceUid: LEAN_PROOF_OCI_POLICY.workspaceUid,
      workspaceGid: LEAN_PROOF_OCI_POLICY.workspaceGid,
      workspaceMode: LEAN_PROOF_OCI_POLICY.workspaceMode,
      openFilesMax: LEAN_PROOF_OCI_POLICY.openFilesMax,
      userProcessesMax: LEAN_PROOF_OCI_POLICY.userProcessesMax,
      fileSizeMaxBytes: LEAN_PROOF_OCI_POLICY.fileSizeMaxBytes,
      coreSizeMaxBytes: LEAN_PROOF_OCI_POLICY.coreSizeMaxBytes,
      stopGraceSeconds: LEAN_PROOF_OCI_POLICY.stopGraceSeconds,
      maskedPaths: LEAN_PROOF_OCI_MASKED_PATHS,
      supervisorCapabilities: ["SETUID"],
    });
  });

  it("durably records intent before a fixed, isolated container and confirms cleanup", async () => {
    const order: string[] = [];
    const leases = new Map<string, LeanProofContainerLease>();
    const request = proofRequest();
    const api = dockerApi(order, acceptedContainerResult(request));
    const driver = new LocalLeanProofDriver({
      api,
      seccompProfile: { defaultAction: "SCMP_ACT_ERRNO" },
      admitRuntime: vi.fn(async () => {
        order.push("admit");
      }),
      leaseStore: {
        read: async (key) => leases.get(key) ?? null,
        write: async (key, lease) => {
          order.push(`lease:${lease.state}`);
          leases.set(key, lease);
        },
        remove: async (key) => {
          order.push("lease:remove");
          leases.delete(key);
        },
      },
    });

    const evidence = await driver.execute(request, executionContext());

    expect(evidence).toMatchObject({
      requestDigest: request.requestDigest,
      runtimeIdentity: request.runtime,
      compiler: { status: "accepted" },
      safeVerify: { status: "accepted" },
      nanoda: { status: "accepted" },
      cleanup: "confirmed",
    });
    expect(order.indexOf("lease:intent")).toBeLessThan(order.indexOf("create"));
    expect(order).toEqual([
      "admit",
      "lease:intent",
      "create",
      "inspect-created",
      "lease:created",
      "attach",
      "start",
      "lease:started",
      "wait",
      "stop",
      "remove",
      "inspect-removed",
      "lease:remove",
    ]);
    expect(api.createContainer).toHaveBeenCalledWith(
      expect.stringMatching(/^flow-proof-[a-f0-9]{32}$/),
      expect.objectContaining({
        Image: request.runtime.imageDigest,
        User: "0:10001",
        OpenStdin: true,
        HostConfig: expect.objectContaining({
          NetworkMode: "none",
          ReadonlyRootfs: true,
          Binds: [],
          Memory: LEAN_PROOF_OCI_POLICY.memoryMaxBytes,
          MemorySwap: LEAN_PROOF_OCI_POLICY.memoryMaxBytes,
          PidsLimit: LEAN_PROOF_OCI_POLICY.pidsMax,
          CapDrop: ["ALL"],
          CapAdd: ["SETUID"],
          MaskedPaths: LEAN_PROOF_OCI_MASKED_PATHS,
          SecurityOpt: expect.arrayContaining(["no-new-privileges"]),
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(leases.size).toBe(0);
  });

  it("reconciles a durable prior lease and blocks automatic proof retry", async () => {
    const order: string[] = [];
    const request = proofRequest();
    const context = executionContext();
    const leaseKey = leanProofLeaseKey(request, context);
    const prior: LeanProofContainerLease = {
      version: 1,
      state: "created",
      leaseKey,
      containerName: `flow-proof-${leaseKey.slice(0, 32)}`,
      containerId: "b".repeat(64),
      requestDigest: request.requestDigest,
      imageDigest: request.runtime.imageDigest,
      profileDigest: request.runtime.profileDigest,
      runId: "run-1",
      workflowId: "proof-workflow",
      nodeId: "verify-proof",
      attempt: 1,
    };
    const api = dockerApi(order, acceptedContainerResult(request));
    api.inspectContainer.mockResolvedValueOnce(containerInspection(prior.containerId, prior));
    const driver = new LocalLeanProofDriver({
      api,
      seccompProfile: { defaultAction: "SCMP_ACT_ERRNO" },
      admitRuntime: async () => undefined,
      leaseStore: {
        read: async () => prior,
        write: async () => undefined,
        remove: async () => {
          order.push("lease:remove");
        },
      },
    });

    await expect(driver.execute(request, context)).rejects.toThrow(/reconciled.*retry.*blocked/i);
    expect(api.createContainer).not.toHaveBeenCalled();
    expect(api.removeContainer).toHaveBeenCalledWith(prior.containerId, expect.any(AbortSignal));
  });

  it("rejects effective container-policy drift before untrusted proof work starts", async () => {
    const order: string[] = [];
    const request = proofRequest();
    const api = dockerApi(order, acceptedContainerResult(request));
    const inspect = api.inspectContainer.getMockImplementation();
    api.inspectContainer.mockImplementation(async (reference: string, signal?: AbortSignal) => {
      const inspection = await inspect?.(reference, signal);
      if (inspection === null || inspection === undefined || order.includes("remove")) {
        return inspection ?? null;
      }
      return {
        ...inspection,
        HostConfig: {
          ...inspection.HostConfig,
          MaskedPaths: LEAN_PROOF_OCI_MASKED_PATHS.slice(1),
        },
      };
    });
    const driver = new LocalLeanProofDriver({
      api,
      seccompProfile: { defaultAction: "SCMP_ACT_ERRNO" },
      admitRuntime: async () => undefined,
      leaseStore: memoryLeaseStore(),
    });

    await expect(driver.execute(request, executionContext())).rejects.toThrow(/policy/i);
    expect(api.startContainer).not.toHaveBeenCalled();
    expect(api.removeContainer).toHaveBeenCalled();
  });

  it("rejects executable or environment drift before untrusted proof work starts", async () => {
    const order: string[] = [];
    const request = proofRequest();
    const api = dockerApi(order, acceptedContainerResult(request));
    const inspect = api.inspectContainer.getMockImplementation();
    api.inspectContainer.mockImplementation(async (reference: string, signal?: AbortSignal) => {
      const inspection = await inspect?.(reference, signal);
      if (inspection === null || inspection === undefined || order.includes("remove")) {
        return inspection ?? null;
      }
      return {
        ...inspection,
        Config: {
          ...inspection.Config,
          Entrypoint: ["/bin/sh"],
          Env: ["HOME=/workspace/home", "UNEXPECTED=1"],
        },
      };
    });
    const driver = new LocalLeanProofDriver({
      api,
      seccompProfile: { defaultAction: "SCMP_ACT_ERRNO" },
      admitRuntime: async () => undefined,
      leaseStore: memoryLeaseStore(),
    });

    await expect(driver.execute(request, executionContext())).rejects.toThrow(/policy/i);
    expect(api.startContainer).not.toHaveBeenCalled();
    expect(api.removeContainer).toHaveBeenCalled();
  });

  it("returns unconfirmed cleanup when removal cannot be proved", async () => {
    const order: string[] = [];
    const request = proofRequest();
    const context = executionContext();
    const leaseKey = leanProofLeaseKey(request, context);
    const api = dockerApi(order, acceptedContainerResult(request));
    const inspectBeforeRemoval = api.inspectContainer.getMockImplementation();
    api.inspectContainer.mockImplementation(async (reference: string, signal?: AbortSignal) =>
      order.includes("remove")
        ? containerInspection("c".repeat(64), {
            version: 1,
            state: "started",
            leaseKey,
            containerName: `flow-proof-${leaseKey.slice(0, 32)}`,
            containerId: "c".repeat(64),
            requestDigest: request.requestDigest,
            imageDigest: request.runtime.imageDigest,
            profileDigest: request.runtime.profileDigest,
            runId: context.runId,
            workflowId: context.workflowId,
            nodeId: context.nodeId,
            attempt: context.attempt,
          })
        : inspectBeforeRemoval === undefined
          ? null
          : inspectBeforeRemoval(reference, signal),
    );
    const driver = new LocalLeanProofDriver({
      api,
      seccompProfile: { defaultAction: "SCMP_ACT_ERRNO" },
      admitRuntime: async () => undefined,
      leaseStore: memoryLeaseStore(),
    });

    await expect(driver.execute(request, context)).resolves.toMatchObject({
      cleanup: "unconfirmed",
    });
  });
});

function dockerApi(order: string[], result: object) {
  const containerId = "c".repeat(64);
  const output = Buffer.from(`${JSON.stringify(result)}\n`);
  let createdName = "flow-proof-placeholder";
  let createdImage = `sha256:${"a".repeat(64)}`;
  let createdConfiguration: Record<string, unknown> | undefined;
  return {
    createContainer: vi.fn(async (name: string, configuration: Record<string, unknown>) => {
      order.push("create");
      createdName = name;
      createdImage = String(configuration.Image);
      createdConfiguration = configuration;
      return containerId;
    }),
    inspectContainer: vi.fn(async (reference: string, _signal?: AbortSignal) => {
      if (reference === containerId) {
        const phase = order.includes("remove") ? "removed" : "created";
        order.push(`inspect-${phase}`);
        return phase === "removed"
          ? null
          : containerInspection(
              containerId,
              undefined,
              createdName,
              createdImage,
              createdConfiguration,
            );
      }
      return null;
    }),
    attachContainer: vi.fn(async (_reference: string, _signal?: AbortSignal) => {
      order.push("attach");
      return {
        output: (async function* () {
          yield output;
        })(),
        write: async () => undefined,
        closeInput: async () => undefined,
        release: async () => undefined,
      };
    }),
    startContainer: vi.fn(async (_reference: string, _signal?: AbortSignal) => {
      order.push("start");
    }),
    waitContainer: vi.fn(async (_reference: string, _signal?: AbortSignal) => {
      order.push("wait");
      return 0;
    }),
    stopContainer: vi.fn(
      async (_reference: string, _graceSeconds: number, _signal?: AbortSignal) => {
        order.push("stop");
      },
    ),
    removeContainer: vi.fn(async (_reference: string, _signal?: AbortSignal) => {
      order.push("remove");
    }),
  };
}

function containerInspection(
  containerId: string,
  lease?: LeanProofContainerLease,
  containerName = lease?.containerName ?? "flow-proof-placeholder",
  imageDigest = lease?.imageDigest ?? `sha256:${"a".repeat(64)}`,
  configuration?: Record<string, unknown>,
) {
  const defaultConfiguration = lease === undefined ? undefined : expectedConfiguration(lease);
  const effectiveConfiguration = configuration ?? defaultConfiguration;
  return {
    Id: containerId,
    Image: imageDigest,
    Name: `/${containerName}`,
    Config: effectiveConfiguration,
    HostConfig: (effectiveConfiguration?.HostConfig as Record<string, unknown>) ?? null,
  };
}

function expectedConfiguration(lease: LeanProofContainerLease) {
  return {
    Hostname: "flow-proof",
    Domainname: "",
    User: "0:10001",
    WorkingDir: "/workspace",
    Entrypoint: ["/opt/flow/bin/flow-proof-supervisor"],
    Cmd: null,
    Env: [
      "HOME=/workspace/home",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "PATH=/opt/flow/bin:/opt/lean/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "LEAN_ABORT_ON_PANIC=1",
    ],
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    StopTimeout: LEAN_PROOF_OCI_POLICY.stopGraceSeconds,
    Healthcheck: { Test: ["NONE"] },
    Labels: {
      "ai.synapti.flow.proof.lease": lease.leaseKey,
      "ai.synapti.flow.proof.request": lease.requestDigest,
      "ai.synapti.flow.proof.profile": lease.profileDigest,
    },
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
      PidsLimit: LEAN_PROOF_OCI_POLICY.pidsMax,
      Memory: LEAN_PROOF_OCI_POLICY.memoryMaxBytes,
      MemorySwap: LEAN_PROOF_OCI_POLICY.memoryMaxBytes + LEAN_PROOF_OCI_POLICY.memorySwapMaxBytes,
      CpuPeriod: LEAN_PROOF_OCI_POLICY.cpuPeriodMicros,
      CpuQuota: LEAN_PROOF_OCI_POLICY.cpuQuotaMicros,
      CapDrop: ["ALL"],
      CapAdd: ["SETUID"],
      SecurityOpt: ["no-new-privileges", 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'],
      MaskedPaths: LEAN_PROOF_OCI_MASKED_PATHS,
      Tmpfs: {
        "/workspace": `rw,nosuid,nodev,noexec,size=${LEAN_PROOF_OCI_POLICY.workspaceBytes},nr_inodes=${LEAN_PROOF_OCI_POLICY.workspaceInodes},uid=${LEAN_PROOF_OCI_POLICY.workspaceUid},gid=${LEAN_PROOF_OCI_POLICY.workspaceGid},mode=${LEAN_PROOF_OCI_POLICY.workspaceMode}`,
      },
      Binds: [],
      Ulimits: [
        {
          Name: "nofile",
          Soft: LEAN_PROOF_OCI_POLICY.openFilesMax,
          Hard: LEAN_PROOF_OCI_POLICY.openFilesMax,
        },
        {
          Name: "nproc",
          Soft: LEAN_PROOF_OCI_POLICY.userProcessesMax,
          Hard: LEAN_PROOF_OCI_POLICY.userProcessesMax,
        },
        {
          Name: "fsize",
          Soft: LEAN_PROOF_OCI_POLICY.fileSizeMaxBytes,
          Hard: LEAN_PROOF_OCI_POLICY.fileSizeMaxBytes,
        },
        {
          Name: "core",
          Soft: LEAN_PROOF_OCI_POLICY.coreSizeMaxBytes,
          Hard: LEAN_PROOF_OCI_POLICY.coreSizeMaxBytes,
        },
      ],
    },
  };
}

function memoryLeaseStore() {
  const records = new Map<string, LeanProofContainerLease>();
  return {
    read: async (key: string) => records.get(key) ?? null,
    write: async (key: string, lease: LeanProofContainerLease) => {
      records.set(key, lease);
    },
    remove: async (key: string) => {
      records.delete(key);
    },
  };
}

function executionContext() {
  return {
    runId: "run-1",
    workflowId: "proof-workflow",
    nodeId: "verify-proof",
    attempt: 1,
    cwd: "/private/project",
    timeoutMs: 30_000,
  };
}

function proofRequest() {
  const specification = "For every natural number n, n plus zero is n.";
  const statement = "theorem Flow.Proof.add_zero (n : Nat) : n + 0 = n";
  return createLeanProofRequest({
    specification,
    statement,
    proof: "by\n  omega\n",
    targetDeclaration: "Flow.Proof.add_zero",
    runtime: {
      version: 1,
      platform: "linux",
      architecture: "x64",
      imageDigest: `sha256:${"a".repeat(64)}`,
      buildAttestationDigest: "b".repeat(64),
      dependencyManifestDigest: "c".repeat(64),
      leanVersion: "4.33.1",
      mathlibRevision: "d".repeat(40),
      safeVerifyRevision: "e".repeat(40),
      nanodaRevision: "1".repeat(40),
      profileDigest: "2".repeat(64),
    },
    faithfulness: {
      version: 1,
      authority: "human",
      approverIdentityHash: "3".repeat(64),
      approvedAt: "2026-08-24T10:00:00.000Z",
      specificationDigest: sha256(specification),
      statementDigest: sha256(statement),
    },
  });
}

function acceptedContainerResult(request: ReturnType<typeof proofRequest>) {
  const environmentDigest = "4".repeat(64);
  return {
    version: 1,
    requestDigest: request.requestDigest,
    compiler: {
      status: "accepted",
      targetDeclaration: request.targetDeclaration,
      statementDigest: request.statementDigest,
      environmentDigest,
      durationMs: 10,
    },
    safeVerify: {
      status: "accepted",
      targetDeclaration: request.targetDeclaration,
      statementDigest: request.statementDigest,
      environmentDigest,
      observedAxioms: ["propext", "Quot.sound", "Classical.choice"],
      reasonCode: "accepted",
      durationMs: 5,
    },
    nanoda: {
      status: "accepted",
      environmentDigest,
      reasonCode: "accepted",
      durationMs: 3,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
