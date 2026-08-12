import { describe, expect, it } from "vitest";

import {
  createExpectedPrimeOciReadiness,
  validatePrimeOciReadiness,
} from "../../../../src/infrastructure/oci/prime-oci-readiness.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("Prime OCI readiness", () => {
  it("accepts the exact effective startup evidence", () => {
    const identity = primeExternalHarnessIdentity();
    const expected = createExpectedPrimeOciReadiness({
      identity,
      identityDigest: "e".repeat(64),
      containerId: "f".repeat(64),
      trialId: `trial-${"b".repeat(48)}`,
      imageDevice: { major: 8, minor: 1 },
    });

    expect(expected).toMatchObject({
      process: { supervisorPid: 1 },
      systemFiles: {
        hostname: "flow-prime",
        hosts: [
          "127.0.0.1 localhost",
          "::1 localhost ip6-localhost ip6-loopback",
          "fe00:: ip6-localnet",
          "ff00:: ip6-mcastprefix",
          "ff02::1 ip6-allnodes",
          "ff02::2 ip6-allrouters",
        ],
        resolver: ["nameserver 127.0.0.1", "options ndots:0"],
      },
    });

    expect(() =>
      validatePrimeOciReadiness(Buffer.from(JSON.stringify(expected)), {
        identity,
        identityDigest: "e".repeat(64),
        containerId: "f".repeat(64),
        trialId: `trial-${"b".repeat(48)}`,
        imageDevice: { major: 8, minor: 1 },
      }),
    ).not.toThrow();
  });

  it.each([
    ["identity", (value: Record<string, unknown>) => (value.identityDigest = "0".repeat(64))],
    ["image", (value: Record<string, unknown>) => (value.imageId = `sha256:${"0".repeat(64)}`)],
    ["policy", (value: Record<string, unknown>) => (value.policyDigest = "0".repeat(64))],
    [
      "user",
      (value: Record<string, unknown>) =>
        (((value.process as Record<string, unknown>).nodeUid as number) = 1),
    ],
    [
      "supervisor PID",
      (value: Record<string, unknown>) =>
        (((value.process as Record<string, unknown>).supervisorPid as number) = 2),
    ],
    [
      "seccomp",
      (value: Record<string, unknown>) =>
        (((value.process as Record<string, unknown>).seccompMode as number) = 0),
    ],
    [
      "memory",
      (value: Record<string, unknown>) =>
        (((value.limits as Record<string, unknown>).memoryMaxBytes as number) = 1),
    ],
    [
      "I/O limit",
      (value: Record<string, unknown>) =>
        (((value.limits as Record<string, unknown>).imageReadBytesPerSecond as number) = 1),
    ],
    [
      "workspace quota",
      (value: Record<string, unknown>) =>
        ((((value.filesystems as Record<string, unknown>).workspace as Record<string, unknown>)
          .bytes as number) = 1),
    ],
    [
      "network",
      (value: Record<string, unknown>) =>
        (((value.network as Record<string, unknown>).interfaces as string[]) = ["eth0"]),
    ],
    [
      "resolver",
      (value: Record<string, unknown>) =>
        (((value.systemFiles as Record<string, unknown>).resolver as string[]) = [
          "search private.example",
        ]),
    ],
    [
      "stream",
      (value: Record<string, unknown>) =>
        (((value.streams as Record<string, unknown>).tty as boolean) = true),
    ],
    ["health", (value: Record<string, unknown>) => (value.healthcheck = "configured")],
  ])("rejects changed %s evidence", (_name, mutate) => {
    const identity = primeExternalHarnessIdentity();
    const input = {
      identity,
      identityDigest: "e".repeat(64),
      containerId: "f".repeat(64),
      trialId: `trial-${"b".repeat(48)}`,
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
    };
    const changed = structuredClone(createExpectedPrimeOciReadiness(input)) as Record<
      string,
      unknown
    >;
    mutate(changed);

    expect(() => validatePrimeOciReadiness(Buffer.from(JSON.stringify(changed)), input)).toThrow(
      /readiness.*(?:contradicts|closed schema)/i,
    );
  });
});
