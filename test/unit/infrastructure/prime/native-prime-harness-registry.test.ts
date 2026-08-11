import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { externalHarnessIdentityDigest } from "../../../../src/domain/evaluation/external-harness.js";
import { initializeFlowProject } from "../../../../src/infrastructure/fs/flow-config-store.js";
import {
  NativePrimeHarnessRegistry,
  type PrimeOciIdentityAttestation,
  resolvePrimeOciAttestationPath,
} from "../../../../src/infrastructure/prime/native-prime-harness-registry.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("native Prime harness registry", () => {
  it("resolves the project attestation from a nested working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-project-root-"));
    temporaryDirectories.push(root);
    await initializeFlowProject(root);
    const nested = join(root, "plans", "nested");
    await mkdir(nested, { recursive: true });

    await expect(resolvePrimeOciAttestationPath(nested)).resolves.toBe(
      join(await realpath(root), ".flow", "runtime", "prime-agent", "oci-attestation.json"),
    );
  });

  it("binds the OCI attestation and every local adapter artifact", async () => {
    const fixture = await registryFixture();
    const descriptor = await fixture.registry.resolve(profile());

    expect(descriptor.identity).toMatchObject({
      version: 1,
      adapter: "prime-agent-native-v1",
      adapterContractVersion: "1.0.0",
      runtime: fixture.attestation.runtime,
      image: fixture.attestation.image,
      driver: {
        id: "native-prime-agent-evaluation-v1",
        artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        dependencyClosureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        kernelProxySha256: fixture.attestation.artifacts.kernelProxySha256,
        pythonLauncherSha256: fixture.attestation.artifacts.pythonLauncherSha256,
        noIoResourceLoaderSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        configDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      harness: {
        package: "prime-agent",
        version: "0.7.1",
        archiveSha256: "d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb",
        packageContentSha256: fixture.attestation.harnessPackageContentSha256,
        dependencyClosureSha256: fixture.attestation.harnessDependencyClosureSha256,
        config: "prime-agent-rlm-evaluation-v1",
      },
      inference: {
        id: "flow-prime-inference-v1",
        version: 1,
        brokerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(descriptor.identityDigest).toBe(externalHarnessIdentityDigest(descriptor.identity));
    expect(descriptor.localRuntime).toBe(fixture.attestation.localRuntime);
    expect(Object.isFrozen(descriptor.identity)).toBe(true);
  });

  it("uses image-attested executable hashes without host binary copies", async () => {
    const fixture = await registryFixture();
    await Promise.all([
      unlink(fixture.supervisorPath),
      unlink(fixture.kernelProxyPath),
      unlink(fixture.pythonLauncherPath),
    ]);

    const descriptor = await fixture.registry.resolve(profile());

    expect(descriptor.identity.outerProtocol.supervisorSha256).toBe(
      fixture.attestation.artifacts.supervisorSha256,
    );
    expect(descriptor.identity.driver.kernelProxySha256).toBe(
      fixture.attestation.artifacts.kernelProxySha256,
    );
    expect(descriptor.identity.driver.pythonLauncherSha256).toBe(
      fixture.attestation.artifacts.pythonLauncherSha256,
    );
  });

  it("rejects the admitted identity after one local artifact changes", async () => {
    const fixture = await registryFixture();
    const admitted = await fixture.registry.resolveIdentity(profile());
    await writeFile(join(fixture.sourceRoot, "support.js"), "export const support = 2;\n", "utf8");

    await expect(fixture.registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects the admitted identity after host OCI orchestration changes", async () => {
    const fixture = await registryFixture();
    const admitted = await fixture.registry.resolveIdentity(profile());
    await writeFile(join(fixture.hostOciRoot, "lifecycle.js"), "export const lifecycle = 2;\n");

    await expect(fixture.registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects the admitted identity after OCI attestation drift", async () => {
    const fixture = await registryFixture();
    const admitted = await fixture.registry.resolveIdentity(profile());
    fixture.assertCurrent.mockRejectedValueOnce(new Error("OCI image changed"));

    await expect(fixture.registry.resolveAdmitted(admitted)).rejects.toThrow(/OCI image changed/i);
  });

  it("rejects an unsupported profile and a different admitted adapter", async () => {
    const fixture = await registryFixture();

    await expect(
      fixture.registry.resolve({
        id: "prime",
        adapter: "prime-agent-native-v1",
        harness: { config: "wrong" as "prime-agent-rlm-evaluation-v1" },
      }),
    ).rejects.toThrow(/unsupported profile/i);
    await expect(fixture.registry.resolveAdmitted(primeExternalHarnessIdentity())).rejects.toThrow(
      /identity.*changed/i,
    );
  });
});

function profile() {
  return {
    id: "prime",
    adapter: "prime-agent-native-v1" as const,
    harness: { config: "prime-agent-rlm-evaluation-v1" as const },
  };
}

async function registryFixture() {
  const root = await mkdtemp(join(tmpdir(), "flow-prime-registry-"));
  temporaryDirectories.push(root);
  const paths = {
    driverPath: join(root, "native-prime-agent-evaluation-driver.js"),
    protocolPath: join(root, "external-harness-protocol.js"),
    outerProtocolPath: join(root, "prime-container-protocol.js"),
    supervisorPath: join(root, "flow-prime-supervisor"),
    kernelProxyPath: join(root, "flow-prime-kernel-proxy"),
    pythonLauncherPath: join(root, "flow-prime-python"),
    noIoResourceLoaderPath: join(root, "no-io-resource-loader.js"),
    inferenceBrokerPath: join(root, "native-prime-host-inference-broker.js"),
    sourceRoot: join(root, "source"),
    hostOciRoot: join(root, "oci"),
    productionRuntimePath: join(root, "production-external-harness-runtime.js"),
  };
  await Promise.all([mkdir(paths.sourceRoot), mkdir(paths.hostOciRoot)]);
  await Promise.all([
    writeFile(paths.driverPath, "export const primeDriver = 1;\n"),
    writeFile(paths.protocolPath, "export const protocol = 1;\n"),
    writeFile(paths.outerProtocolPath, "export const outerProtocol = 1;\n"),
    writeFile(paths.supervisorPath, "trusted supervisor\n"),
    writeFile(paths.kernelProxyPath, "trusted kernel proxy\n"),
    writeFile(paths.pythonLauncherPath, "trusted Python launcher\n"),
    writeFile(paths.noIoResourceLoaderPath, "export const resources = [];\n"),
    writeFile(paths.inferenceBrokerPath, "export const broker = 1;\n"),
    writeFile(join(paths.sourceRoot, "support.js"), "export const support = 1;\n"),
    writeFile(join(paths.hostOciRoot, "lifecycle.js"), "export const lifecycle = 1;\n"),
    writeFile(paths.productionRuntimePath, "export const productionRuntime = 1;\n"),
  ]);
  const publicIdentity = primeExternalHarnessIdentity();
  const assertCurrent = vi.fn(async () => undefined);
  const attestation = {
    runtime: publicIdentity.runtime,
    image: publicIdentity.image,
    artifacts: {
      driverSha256: "4".repeat(64),
      flowDistSha256: "5".repeat(64),
      supervisorSha256: "1".repeat(64),
      kernelProxySha256: "2".repeat(64),
      noIoResourceLoaderSha256: "6".repeat(64),
      pythonLauncherSha256: "3".repeat(64),
    },
    harnessPackageContentSha256: publicIdentity.harness.packageContentSha256,
    harnessDependencyClosureSha256: publicIdentity.harness.dependencyClosureSha256,
    localRuntime: {
      daemonId: "daemon-test-id",
      socketPath: "/var/run/docker.sock",
      socket: { device: 1, inode: 2, uid: 0, gid: 999, mode: 0o660 },
      apiVersion: "1.51",
      cgroupPath: "/sys/fs/cgroup/flow-prime",
      corePattern: "core",
      globalLeasePath: "/var/lib/flow-prime/global-slot.json",
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
      leaseTarget: "flow-prime-global-v1",
      seccompProfile: { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] },
    },
    assertCurrent,
  } satisfies PrimeOciIdentityAttestation;
  return {
    ...paths,
    assertCurrent,
    attestation,
    registry: new NativePrimeHarnessRegistry({
      ...paths,
      resolveOciIdentity: async () => attestation,
    }),
  };
}
