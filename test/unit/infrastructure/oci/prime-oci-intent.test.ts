import { describe, expect, it } from "vitest";

import { createPrimeOciIntent } from "../../../../src/infrastructure/oci/prime-oci-intent.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("Prime OCI intent", () => {
  it("binds one trial to admitted private engine authority", () => {
    const request = runtimeRequest();
    const endpoint = {
      socketPath: "/var/run/docker.sock" as const,
      device: 11,
      inode: 22,
      uid: 0,
      gid: 999,
      mode: 0o660,
    };
    const randomValues = [Buffer.alloc(32, 0xab), Buffer.alloc(16, 0xcd)];

    const intent = createPrimeOciIntent(request, endpoint, (bytes) => {
      const value = randomValues.shift();
      expect(value).toHaveLength(bytes);
      return value ?? Buffer.alloc(bytes);
    });

    expect(intent).toEqual({
      version: 1,
      adapter: "prime-agent-native-v1",
      state: "intent",
      ownerNonce: "ab".repeat(32),
      containerName: `flow-prime-${"cd".repeat(16)}`,
      labels: {
        evaluationId: `evaluation-${"a".repeat(48)}`,
        trialId: request.evaluation.trial.trialId,
        ownerNonce: "ab".repeat(32),
        imageId: request.identity.image.id,
        policyDigest: request.identity.runtime.policy.digest,
      },
      imageId: request.identity.image.id,
      policyDigest: request.identity.runtime.policy.digest,
      fixtureDigest: request.evaluation.workspace.snapshotDigest,
      engineEndpoint: endpoint,
    });
  });

  it("rejects non-Prime input and malformed random output", () => {
    const request = runtimeRequest();
    const endpoint = {
      socketPath: "/var/run/docker.sock" as const,
      device: 11,
      inode: 22,
      uid: 0,
      gid: 999,
      mode: 0o660,
    };

    expect(() =>
      createPrimeOciIntent(
        {
          ...request,
          identity: {
            ...request.identity,
            adapter: "pi-native-v1",
          } as unknown as typeof request.identity,
        },
        endpoint,
      ),
    ).toThrow(/Prime/i);
    expect(() => createPrimeOciIntent(request, endpoint, () => Buffer.alloc(1))).toThrow(/random/i);
  });
});

function runtimeRequest() {
  const identity = primeExternalHarnessIdentity();
  return {
    identity,
    evaluation: {
      planDigest: "a".repeat(64),
      trial: {
        trialId: `trial-${"b".repeat(48)}`,
        position: 1,
        taskId: "task",
        profileId: "prime",
        seed: 7,
        repetition: 1,
      },
      workspace: {
        workspaceId: `workspace-trial-${"b".repeat(48)}`,
        cwd: "/workspace",
        backend: "reflink-copy-v1" as const,
        snapshotDigest: "c".repeat(64),
      },
      instruction: { path: "TASK.md", sha256: "d".repeat(64) },
      controls: {
        model: { provider: "provider", id: "model", thinking: "off" as const },
        budget: {
          maxNodeStarts: 8,
          maxModelTokens: 4_096,
          maxCostUsdMicros: 100_000,
          maxExecutionMs: 30_000,
          maxArtifactBytes: 1_048_576,
        },
        network: "deny" as const,
        retry: { providerRetries: 0 as const, harnessRetries: 0 as const },
      },
    },
    isolation: { projectRoot: "/project", protectedPaths: ["/project/.flow"] },
  };
}
