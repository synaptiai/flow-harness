import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { LocalPrimeOciAttestation } from "../../../../src/infrastructure/oci/local-prime-oci-attestation.js";
import { projectContainerCommandRuntimeDescriptor } from "../../../../src/infrastructure/runtime/production-container-command-sandbox.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("production container command sandbox", () => {
  it("projects the prepared OCI attestation and effective user into one immutable policy identity", async () => {
    const assertCurrent = vi.fn(async () => undefined);
    const attestation = preparedAttestation(assertCurrent);

    const descriptor = projectContainerCommandRuntimeDescriptor(attestation, {
      uid: 1000,
      gid: 1001,
    });

    expect(descriptor).toMatchObject({
      engineVersion: attestation.runtime.engine.serverVersion,
      apiVersion: attestation.localRuntime.apiVersion,
      socketPath: "/var/run/docker.sock",
      dockerExecutable: "/usr/bin/docker",
      imageId: attestation.image.id,
      runtimeName: "flow-prime-runc",
      user: { uid: 1000, gid: 1001 },
      policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(seccompNames(descriptor.seccompProfile)).toEqual(["read", "write"]);
    expect(seccompNames(attestation.localRuntime.seccompProfile)).toEqual([
      "accept",
      "accept4",
      "bind",
      "connect",
      "getpeername",
      "getsockname",
      "getsockopt",
      "listen",
      "read",
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
      "socket",
      "socketcall",
      "socketpair",
      "write",
    ]);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.seccompProfile)).toBe(true);
    await descriptor.assertCurrent();
    expect(assertCurrent).toHaveBeenCalledTimes(1);

    const changedUser = projectContainerCommandRuntimeDescriptor(attestation, {
      uid: 1002,
      gid: 1001,
    });
    const changedImage = projectContainerCommandRuntimeDescriptor(
      {
        ...attestation,
        image: { ...attestation.image, id: `sha256:${"e".repeat(64)}` },
      },
      { uid: 1000, gid: 1001 },
    );
    const changedDocker = projectContainerCommandRuntimeDescriptor(
      {
        ...attestation,
        localRuntime: {
          ...attestation.localRuntime,
          executables: {
            ...attestation.localRuntime.executables,
            docker: {
              ...attestation.localRuntime.executables.docker,
              sha256: "f".repeat(64),
            },
          },
        },
      },
      { uid: 1000, gid: 1001 },
    );

    expect(changedUser.policyDigest).not.toBe(descriptor.policyDigest);
    expect(changedImage.policyDigest).not.toBe(descriptor.policyDigest);
    expect(changedDocker.policyDigest).not.toBe(descriptor.policyDigest);
  });

  it("rejects a malformed attested seccomp rule before it can become command policy", () => {
    const attestation = preparedAttestation(async () => undefined);

    expect(() =>
      projectContainerCommandRuntimeDescriptor(
        {
          ...attestation,
          localRuntime: {
            ...attestation.localRuntime,
            seccompProfile: {
              ...attestation.localRuntime.seccompProfile,
              syscalls: [{ names: ["read", 7], action: "SCMP_ACT_ALLOW" }],
            },
          },
        },
        { uid: 1000, gid: 1001 },
      ),
    ).toThrow("Prime seccomp profile has an invalid syscall rule");
  });

  it("rejects a permissive seccomp default before removing socket allow rules", () => {
    const attestation = preparedAttestation(async () => undefined);

    expect(() =>
      projectContainerCommandRuntimeDescriptor(
        {
          ...attestation,
          localRuntime: {
            ...attestation.localRuntime,
            seccompProfile: {
              ...attestation.localRuntime.seccompProfile,
              defaultAction: "SCMP_ACT_ALLOW",
            },
          },
        },
        { uid: 1000, gid: 1001 },
      ),
    ).toThrow("Prime seccomp profile does not deny by default");
  });

  it("removes network syscalls from the packaged Prime profile without mutating it", async () => {
    const source = JSON.parse(
      await readFile(new URL("../../../../prime-container/seccomp.json", import.meta.url), "utf8"),
    ) as Readonly<Record<string, unknown>>;
    const sourceBytes = JSON.stringify(source);
    const sourceArchMap = source.archMap;
    if (!Array.isArray(sourceArchMap) || sourceArchMap[0] === undefined) {
      throw new Error("packaged Prime seccomp profile has no architecture map");
    }
    const sourceSyscalls = source.syscalls;
    if (!Array.isArray(sourceSyscalls)) {
      throw new Error("packaged Prime seccomp profile has no syscall rules");
    }
    const sourceRuleWithArguments = sourceSyscalls.find(
      (rule): rule is Record<string, unknown> & { args: unknown[] } =>
        typeof rule === "object" &&
        rule !== null &&
        "args" in rule &&
        Array.isArray(rule.args) &&
        rule.args.length > 0,
    );
    if (sourceRuleWithArguments === undefined) {
      throw new Error("packaged Prime seccomp profile has no rule arguments");
    }
    const attestation = preparedAttestation(async () => undefined);

    const descriptor = projectContainerCommandRuntimeDescriptor(
      {
        ...attestation,
        localRuntime: { ...attestation.localRuntime, seccompProfile: source },
      },
      { uid: 1000, gid: 1001 },
    );

    expect(seccompNames(descriptor.seccompProfile)).toContain("execve");
    expect(
      seccompNames(descriptor.seccompProfile).filter((name) => NETWORK_SYSCALLS.has(name)),
    ).toEqual([]);
    expect(JSON.stringify(source)).toBe(sourceBytes);
    expect(Object.isFrozen(sourceArchMap)).toBe(false);
    expect(Object.isFrozen(sourceArchMap[0])).toBe(false);
    expect(Object.isFrozen(sourceRuleWithArguments.args)).toBe(false);
    expect(Object.isFrozen(sourceRuleWithArguments.args[0])).toBe(false);
  });
});

const NETWORK_SYSCALLS = new Set([
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

function preparedAttestation(
  assertCurrent: (signal?: AbortSignal) => Promise<void>,
): LocalPrimeOciAttestation {
  const identity = primeExternalHarnessIdentity();
  return {
    runtime: identity.runtime,
    image: identity.image,
    builder: {} as LocalPrimeOciAttestation["builder"],
    artifacts: {} as LocalPrimeOciAttestation["artifacts"],
    harnessPackageContentSha256: "1".repeat(64),
    harnessDependencyClosureSha256: "2".repeat(64),
    localRuntime: {
      daemonId: "daemon-id",
      socketPath: "/var/run/docker.sock",
      socket: { device: 1, inode: 2, uid: 0, gid: 999, mode: 0o660 },
      apiVersion: "1.51",
      cgroupPath: "/system.slice/docker.service",
      corePattern: "core",
      globalLeasePath: "/run/flow/lease",
      imageDevice: { path: "/dev/sda", major: 8, minor: 0 },
      executables: {
        docker: { path: "/usr/bin/docker", sha256: "3".repeat(64) },
        dockerd: { path: "/usr/bin/dockerd", sha256: "4".repeat(64) },
        containerd: { path: "/usr/bin/containerd", sha256: "5".repeat(64) },
        runc: { path: "/usr/bin/runc", sha256: "6".repeat(64) },
      },
      leaseTarget: "flow-prime-global-v1",
      seccompProfile: {
        defaultAction: "SCMP_ACT_ERRNO",
        defaultErrnoRet: 1,
        syscalls: [
          {
            names: [
              "accept",
              "accept4",
              "bind",
              "connect",
              "getpeername",
              "getsockname",
              "getsockopt",
              "listen",
              "read",
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
              "write",
            ],
            action: "SCMP_ACT_ALLOW",
          },
          {
            names: ["socket"],
            action: "SCMP_ACT_ALLOW",
            args: [{ index: 0, value: 1, op: "SCMP_CMP_EQ" }],
          },
        ],
      },
    },
    assertCurrent,
  };
}

function seccompNames(profile: Readonly<Record<string, unknown>>): readonly string[] {
  const rules = profile.syscalls;
  if (!Array.isArray(rules)) {
    throw new Error("test seccomp profile has no syscall rules");
  }
  return rules
    .flatMap((rule) =>
      typeof rule === "object" && rule !== null && Array.isArray(rule.names) ? rule.names : [],
    )
    .filter((name): name is string => typeof name === "string")
    .sort();
}
