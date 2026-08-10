import { describe, expect, it } from "vitest";

import {
  externalHarnessIdentityDigest,
  parseExternalHarnessIdentity,
} from "../../../src/domain/evaluation/external-harness.js";

describe("external harness identity", () => {
  it("keeps the version 1 Pi identity and digest stable", () => {
    const identity = piIdentity();

    expect(parseExternalHarnessIdentity(identity)).toEqual(identity);
    expect(externalHarnessIdentityDigest(identity)).toBe(
      "eb4a920122a5874f4887042682d3227cee56e274cd46352f057cb28eed503c06",
    );
  });

  it("parses one closed OMP identity variant", () => {
    const identity = ompIdentity();

    expect(parseExternalHarnessIdentity(identity)).toEqual(identity);
    expect(externalHarnessIdentityDigest(identity)).not.toBe(
      externalHarnessIdentityDigest(piIdentity()),
    );
  });

  it("rejects cross-adapter runtime and configuration fields", () => {
    const wrongRuntime = structuredClone(ompIdentity());
    Object.assign(wrongRuntime.driver, {
      node: {
        version: "22.18.0",
        executableSha256: "a".repeat(64),
      },
    });
    expect(() => parseExternalHarnessIdentity(wrongRuntime)).toThrow(/invalid/i);

    const wrongConfig = structuredClone(ompIdentity());
    (wrongConfig.harness.config as string) = "pi-evaluation-v1";
    expect(() => parseExternalHarnessIdentity(wrongConfig)).toThrow(/invalid/i);
  });

  it("parses one closed Prime Agent OCI identity without private host authority", () => {
    const identity = primeIdentity();

    expect(parseExternalHarnessIdentity(identity)).toEqual(identity);
    expect(externalHarnessIdentityDigest(identity)).not.toBe(
      externalHarnessIdentityDigest(piIdentity()),
    );

    const privateAuthority = structuredClone(identity);
    Object.assign(privateAuthority.runtime, {
      local: {
        dockerSocket: "/var/run/docker.sock",
        daemonId: "host-specific-daemon",
        containerId: "host-specific-container",
      },
    });
    expect(() => parseExternalHarnessIdentity(privateAuthority)).toThrow(/invalid/i);

    const weakenedPolicy = structuredClone(identity);
    weakenedPolicy.runtime.policy.maxActivePrimeContainers = 2 as 1;
    expect(() => parseExternalHarnessIdentity(weakenedPolicy)).toThrow(/invalid/i);
  });
});

function piIdentity() {
  return {
    version: 1 as const,
    adapter: "pi-native-v1" as const,
    adapterContractVersion: "1.0.0",
    protocol: {
      id: "flow-external-harness-jsonl-v1" as const,
      maxFrameBytes: 1_048_576 as const,
      digest: "1".repeat(64),
    },
    runtime: {
      id: "srt-process-v1" as const,
      package: "@anthropic-ai/sandbox-runtime" as const,
      version: "0.0.70",
      packageContentSha256: "2".repeat(64),
      policyDigest: "3".repeat(64),
      platform: "linux" as const,
      containment: "linux-pid-namespace" as const,
    },
    driver: {
      id: "native-pi-evaluation-v1" as const,
      artifactSha256: "4".repeat(64),
      dependencyClosureSha256: "5".repeat(64),
      node: {
        version: "22.18.0",
        executableSha256: "6".repeat(64),
      },
    },
    harness: {
      package: "@earendil-works/pi-coding-agent" as const,
      version: "0.84.0",
      integrity:
        "sha512-oxEU7BT9xuVT6UKNwUNDzNP5dVGb+DZRGfaEyMyAab8dRlqTSxxyhSlMAxmYsu//YOeasj9E8n2+px1BzIai0g==",
      packageContentSha256: "7".repeat(64),
      config: "pi-evaluation-v1" as const,
      configDigest: "8".repeat(64),
    },
    inference: {
      id: "flow-pi-inference-v1" as const,
      version: 1 as const,
      package: "@earendil-works/pi-ai" as const,
      packageVersion: "0.84.0",
      packageIntegrity:
        "sha512-N9RDk8q0eglGiy+NqTZ3Ev2j+6oFNXSAJa8b0CYhvWB9HGiKZjsoCESXkUvMDLybrn0wXp75sdsoBzEtHxk9kA==",
      packageContentSha256: "9".repeat(64),
    },
  };
}

function ompIdentity() {
  return {
    version: 1 as const,
    adapter: "omp-native-v1" as const,
    adapterContractVersion: "1.0.0",
    protocol: {
      id: "flow-external-harness-jsonl-v1" as const,
      maxFrameBytes: 1_048_576 as const,
      digest: "1".repeat(64),
    },
    runtime: {
      id: "srt-process-v1" as const,
      package: "@anthropic-ai/sandbox-runtime" as const,
      version: "0.0.70",
      packageContentSha256: "2".repeat(64),
      policyDigest: "3".repeat(64),
      platform: "linux" as const,
      containment: "linux-pid-namespace" as const,
    },
    driver: {
      id: "native-omp-evaluation-v1" as const,
      artifactSha256: "a".repeat(64),
      dependencyClosureSha256: "b".repeat(64),
      bun: {
        version: "1.3.14",
        executableSha256: "c".repeat(64),
      },
    },
    harness: {
      package: "@oh-my-pi/pi-coding-agent" as const,
      version: "17.2.12",
      integrity:
        "sha512-+q+W4fyNQQ7xAKiN0mmOisWDDtKO0R/ZctTSsKqR4ulN3K1zfQ9HwiTxtg7HJHn5fwCy+X3BmUG72FatNUN8IA==",
      packageContentSha256: "d".repeat(64),
      dependencyClosureSha256: "e".repeat(64),
      config: "omp-evaluation-v1" as const,
      configDigest: "f".repeat(64),
    },
    inference: {
      id: "flow-omp-inference-v1" as const,
      version: 1 as const,
      package: "@oh-my-pi/pi-ai" as const,
      packageVersion: "17.2.12",
      packageContentSha256: "0".repeat(64),
    },
  };
}

function primeIdentity() {
  return {
    version: 1 as const,
    adapter: "prime-agent-native-v1" as const,
    adapterContractVersion: "1.0.0",
    protocol: {
      id: "flow-external-harness-jsonl-v1" as const,
      maxFrameBytes: 1_048_576 as const,
      digest: "1".repeat(64),
    },
    outerProtocol: {
      id: "flow-prime-container-v1" as const,
      version: 1 as const,
      maxPayloadBytes: 1_048_576 as const,
      maxEncodedFrameBytes: 1_048_581 as const,
      maxFileChunkBytes: 65_536 as const,
      maxEntries: 4_096 as const,
      maxPathBytes: 4_095 as const,
      maxPathComponentBytes: 255 as const,
      maxFileBytes: 268_435_456 as const,
      maxLogicalBytes: 268_435_456 as const,
      maxTransferFrames: 16_385 as const,
      maxChunkFrames: 8_191 as const,
      maxEncodedTransferBytes: 318_767_104 as const,
      maxDriverFrames: 512 as const,
      maxDriverBytes: 138_412_032 as const,
      maxStreamBytes: 457_179_136 as const,
      maxModelTurns: 64 as const,
      maxIpythonCalls: 64 as const,
      hostParserSha256: "2".repeat(64),
      supervisorSha256: "3".repeat(64),
    },
    runtime: {
      id: "docker-oci-v1" as const,
      platform: "linux" as const,
      architecture: "x64" as const,
      client: {
        version: "28.3.3",
        executableSha256: "4".repeat(64),
      },
      engine: {
        serverVersion: "28.3.3",
        apiVersion: "1.51",
        kernelRelease: "6.11.0-1018-azure",
        kernelSecurityConfigSha256: "5".repeat(64),
        containerdVersion: "1.7.27",
        containerdSha256: "6".repeat(64),
        runcVersion: "1.2.6",
        runcSha256: "7".repeat(64),
        cgroupVersion: 2 as const,
        cgroupDriver: "systemd" as const,
        storageDriver: "overlay2",
        rootless: false,
        securityOptionsSha256: "8".repeat(64),
      },
      policy: {
        digest: "9".repeat(64),
        maxActivePrimeContainers: 1 as const,
        minMemoryHeadroomBytes: 4_294_967_296 as const,
        minPidHeadroom: 256 as const,
        minCpuCapacity: 4 as const,
        minImageReadBytesPerSecond: 134_217_728 as const,
        minImageReadOperationsPerSecond: 8_192 as const,
        preflightReadCount: 16 as const,
        probeBytes: 4_096 as const,
        maxProbeLatencyMs: 100 as const,
        runtimeProbeIntervalMs: 250 as const,
        maxConsecutiveSlowProbes: 3 as const,
        pidsMax: 64 as const,
        memoryMaxBytes: 2_147_483_648 as const,
        memorySwapMaxBytes: 0 as const,
        cpuQuotaMicros: 200_000 as const,
        cpuPeriodMicros: 100_000 as const,
        imageReadBytesPerSecond: 67_108_864 as const,
        imageReadOperationsPerSecond: 4_096 as const,
        openFilesMax: 256 as const,
        userProcessesMax: 64 as const,
        fileSizeMaxBytes: 268_435_456 as const,
        coreSizeMaxBytes: 0 as const,
        workspaceBytes: 536_870_912 as const,
        workspaceInodes: 8_192 as const,
        nodeRuntimeBytes: 16_777_216 as const,
        nodeRuntimeInodes: 256 as const,
        supervisorRuntimeBytes: 16_777_216 as const,
        supervisorRuntimeInodes: 256 as const,
        diagnosticBytes: 65_536 as const,
        stopGraceMs: 5_000 as const,
        cleanupGraceMs: 30_000 as const,
        network: "none" as const,
        ipc: "none" as const,
        logDriver: "none" as const,
        healthcheck: "none" as const,
        pull: "never" as const,
        readOnlyRoot: true as const,
        noNewPrivileges: true as const,
        rejectPipedCore: true as const,
        supervisorCapabilities: [
          "CHOWN",
          "DAC_READ_SEARCH",
          "FOWNER",
          "KILL",
          "SETGID",
          "SETUID",
        ] as const,
        seccompSha256: "a".repeat(64),
        supervisorUid: 0 as const,
        nodeUid: 10_001 as const,
        pythonUid: 10_002 as const,
        sharedGid: 10_003 as const,
      },
    },
    image: {
      id: `sha256:${"b".repeat(64)}`,
      ociManifestSha256: "c".repeat(64),
      platformConfigSha256: "d".repeat(64),
      buildInputSha256: "e".repeat(64),
      sbomSha256: "f".repeat(64),
      baseImageDigest: `sha256:${"0".repeat(64)}`,
      nodeVersion: "22.18.0",
      nodeClosureSha256: "1".repeat(64),
      pythonVersion: "3.11.13",
      pythonClosureSha256: "2".repeat(64),
    },
    driver: {
      id: "native-prime-agent-evaluation-v1" as const,
      artifactSha256: "3".repeat(64),
      dependencyClosureSha256: "4".repeat(64),
      kernelProxySha256: "5".repeat(64),
      pythonLauncherSha256: "6".repeat(64),
      noIoResourceLoaderSha256: "7".repeat(64),
      configDigest: "8".repeat(64),
    },
    harness: {
      package: "prime-agent" as const,
      version: "0.7.1" as const,
      archiveSha256: "d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb" as const,
      packageContentSha256: "9".repeat(64),
      dependencyClosureSha256: "a".repeat(64),
      config: "prime-agent-rlm-evaluation-v1" as const,
    },
    inference: {
      id: "flow-prime-inference-v1" as const,
      version: 1 as const,
      brokerSha256: "b".repeat(64),
    },
  };
}
