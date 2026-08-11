import { describe, expect, it } from "vitest";

import {
  createExpectedPrimeOciReadiness,
  validatePrimeOciReadiness,
} from "../../src/infrastructure/oci/prime-oci-readiness.js";
import { primeExternalHarnessIdentity } from "../fixtures/evaluation/prime-external-harness-identity.js";
import {
  primeAssistantText,
  runVerifiedPrimeSession,
} from "../fixtures/prime/verified-prime-session.js";

const linux = process.platform === "linux" && process.arch === "x64";

describe("Prime OCI readiness mutation boundary", () => {
  it("rejects every changed readiness leaf", () => {
    const input = {
      identity: primeExternalHarnessIdentity(),
      identityDigest: "e".repeat(64),
      containerId: "f".repeat(64),
      trialId: `trial-${"b".repeat(48)}`,
    };
    const expected = createExpectedPrimeOciReadiness(input);
    const leaves = leafPaths(expected);

    expect(leaves.length).toBeGreaterThan(40);
    for (const path of leaves) {
      const changed = structuredClone(expected) as unknown as Record<string, unknown>;
      mutateLeaf(changed, path);
      expect(
        () => validatePrimeOciReadiness(Buffer.from(JSON.stringify(changed)), input),
        path.join("."),
      ).toThrow(/readiness.*(?:contradicts|closed schema)/i);
    }
  });
});

describe.skipIf(!linux)("Prime OCI native startup boundary", () => {
  it("reconciles the complete effective startup policy", async () => {
    const session = await runVerifiedPrimeSession({
      instruction: "Finish without changing the workspace.",
      responses: [primeAssistantText("The startup test is complete.", 1)],
    });
    try {
      expect(session.evidence.harness.outcome).toBe("completed");
      expect(session.evidence.settlement).toEqual({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        kernelRequests: 0,
      });
    } finally {
      await session.dispose();
    }
  }, 120_000);

  it("keeps health checks disabled and core output unavailable", async () => {
    const session = await runVerifiedPrimeSession({
      instruction: "Finish without changing the workspace.",
      responses: [primeAssistantText("Health and core controls are ready.", 1)],
    });
    try {
      expect(session.evidence.harness.outcome).toBe("completed");
    } finally {
      await session.dispose();
    }
  }, 120_000);
});

type ReadinessPath = readonly (string | number)[];

function leafPaths(value: unknown, prefix: ReadinessPath = []): ReadinessPath[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [prefix];
    }
    return value.flatMap((child, index) => leafPaths(child, [...prefix, index]));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...prefix, key]));
  }
  return [prefix];
}

function mutateLeaf(root: Record<string, unknown>, path: readonly (string | number)[]): void {
  const parent = path.slice(0, -1).reduce<unknown>((value, key) => {
    return (value as Record<string | number, unknown>)[key];
  }, root);
  const key = path.at(-1);
  if (key === undefined) {
    throw new Error("readiness mutation path is empty");
  }
  const record = parent as Record<string | number, unknown>;
  const current = record[key];
  if (typeof current === "boolean") {
    record[key] = !current;
  } else if (typeof current === "number") {
    record[key] = current + 1;
  } else if (typeof current === "string") {
    record[key] = `${current}-changed`;
  } else if (Array.isArray(current)) {
    record[key] = ["changed"];
  } else {
    throw new Error(`readiness leaf ${path.join(".")} has an unsupported value`);
  }
}
