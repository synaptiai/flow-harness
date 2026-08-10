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
    });

    expect(() =>
      validatePrimeOciReadiness(Buffer.from(JSON.stringify(expected)), {
        identity,
        identityDigest: "e".repeat(64),
        containerId: "f".repeat(64),
        trialId: `trial-${"b".repeat(48)}`,
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
