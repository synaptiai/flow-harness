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
