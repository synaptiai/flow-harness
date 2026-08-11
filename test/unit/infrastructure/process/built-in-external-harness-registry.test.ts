import { describe, expect, it, vi } from "vitest";

import type { ExternalHarnessIdentity } from "../../../../src/domain/evaluation/external-harness.js";
import type { NativePrimeHarnessDescriptor } from "../../../../src/infrastructure/prime/native-prime-harness-registry.js";
import { BuiltInExternalHarnessRegistry } from "../../../../src/infrastructure/process/built-in-external-harness-registry.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("built-in external harness registry", () => {
  it("routes fixed Pi, OMP, and Prime profiles without eager construction", async () => {
    const piIdentity = piIdentityFixture();
    const ompIdentity = ompIdentityFixture();
    const primeIdentity = primeExternalHarnessIdentity();
    const pi = {
      resolveIdentity: vi.fn(async () => piIdentity),
      resolveAdmitted: vi.fn(),
    };
    const omp = {
      resolveIdentity: vi.fn(async () => ompIdentity),
      resolveAdmitted: vi.fn(),
    };
    const createOmp = vi.fn(() => omp);
    const primeDescriptor = { identity: primeIdentity } as NativePrimeHarnessDescriptor;
    const prime = {
      resolveIdentity: vi.fn(async () => primeIdentity),
      resolveAdmitted: vi.fn(async () => primeDescriptor),
    };
    const createPrime = vi.fn(() => prime);
    const registry = new BuiltInExternalHarnessRegistry({
      cwd: "/project/plans",
      pi,
      createOmp,
      createPrime,
    });

    await expect(
      registry.resolveIdentity({
        id: "pi",
        adapter: "pi-native-v1",
        harness: { config: "pi-evaluation-v1" },
      }),
    ).resolves.toBe(piIdentity);
    expect(createOmp).not.toHaveBeenCalled();

    await expect(
      registry.resolveIdentity({
        id: "omp",
        adapter: "omp-native-v1",
        harness: { config: "omp-evaluation-v1" },
      }),
    ).resolves.toBe(ompIdentity);
    expect(createOmp).toHaveBeenCalledOnce();
    expect(createPrime).not.toHaveBeenCalled();

    await expect(
      registry.resolveIdentity({
        id: "prime",
        adapter: "prime-agent-native-v1",
        harness: { config: "prime-agent-rlm-evaluation-v1" },
      }),
    ).resolves.toBe(primeIdentity);
    await expect(registry.resolvePrimeAdmitted(primeIdentity)).resolves.toBe(primeDescriptor);
    expect(createPrime).toHaveBeenCalledOnce();
    expect(createPrime).toHaveBeenCalledWith("/project/plans");
  });
});

function piIdentityFixture(): Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "pi-native-v1" }
> {
  return {
    version: 1,
    adapter: "pi-native-v1",
    adapterContractVersion: "1.0.0",
    protocol: {
      id: "flow-external-harness-jsonl-v1",
      maxFrameBytes: 1_048_576,
      digest: "1".repeat(64),
    },
    runtime: {
      id: "srt-process-v1",
      package: "@anthropic-ai/sandbox-runtime",
      version: "0.0.70",
      packageContentSha256: "2".repeat(64),
      policyDigest: "3".repeat(64),
      platform: "linux",
      containment: "linux-pid-namespace",
    },
    driver: {
      id: "native-pi-evaluation-v1",
      artifactSha256: "4".repeat(64),
      dependencyClosureSha256: "5".repeat(64),
      node: { version: "22.19.0", executableSha256: "6".repeat(64) },
    },
    harness: {
      package: "@earendil-works/pi-coding-agent",
      version: "0.84.0",
      integrity: `sha512-${"A".repeat(86)}==`,
      packageContentSha256: "7".repeat(64),
      config: "pi-evaluation-v1",
      configDigest: "8".repeat(64),
    },
    inference: {
      id: "flow-pi-inference-v1",
      version: 1,
      package: "@earendil-works/pi-ai",
      packageVersion: "0.84.0",
      packageIntegrity: `sha512-${"B".repeat(86)}==`,
      packageContentSha256: "9".repeat(64),
    },
  };
}

function ompIdentityFixture(): Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "omp-native-v1" }
> {
  return {
    version: 1,
    adapter: "omp-native-v1",
    adapterContractVersion: "1.0.0",
    protocol: {
      id: "flow-external-harness-jsonl-v1",
      maxFrameBytes: 1_048_576,
      digest: "1".repeat(64),
    },
    runtime: {
      id: "srt-process-v1",
      package: "@anthropic-ai/sandbox-runtime",
      version: "0.0.70",
      packageContentSha256: "2".repeat(64),
      policyDigest: "3".repeat(64),
      platform: "linux",
      containment: "linux-pid-namespace",
    },
    driver: {
      id: "native-omp-evaluation-v1",
      artifactSha256: "4".repeat(64),
      dependencyClosureSha256: "5".repeat(64),
      bun: { version: "1.3.14", executableSha256: "6".repeat(64) },
    },
    harness: {
      package: "@oh-my-pi/pi-coding-agent",
      version: "17.2.12",
      integrity:
        "sha512-+q+W4fyNQQ7xAKiN0mmOisWDDtKO0R/ZctTSsKqR4ulN3K1zfQ9HwiTxtg7HJHn5fwCy+X3BmUG72FatNUN8IA==",
      packageContentSha256: "7".repeat(64),
      dependencyClosureSha256: "8".repeat(64),
      config: "omp-evaluation-v1",
      configDigest: "9".repeat(64),
    },
    inference: {
      id: "flow-omp-inference-v1",
      version: 1,
      package: "@oh-my-pi/pi-ai",
      packageVersion: "17.2.12",
      packageContentSha256: "0".repeat(64),
    },
  };
}
