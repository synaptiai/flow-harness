import { describe, expect, it } from "vitest";

import { parseEvaluationTrialAttempt } from "../../../src/domain/evaluation/attempt.js";

describe("evaluation trial attempt", () => {
  it("parses one strict Prime OCI lease", () => {
    const attempt = parseEvaluationTrialAttempt(primeAttempt("created"));

    expect(attempt.ociLease).toMatchObject({
      adapter: "prime-agent-native-v1",
      state: "created",
      containerId: "8".repeat(64),
      inspectedPolicyDigest: "9".repeat(64),
    });
    expect(Object.isFrozen(attempt.ociLease)).toBe(true);
  });

  it("rejects missing state fields, foreign adapters, and private-field changes", () => {
    const missingId = primeAttempt("created");
    delete (missingId.ociLease as { containerId?: string }).containerId;
    expect(() => parseEvaluationTrialAttempt(missingId)).toThrow(/invalid/i);

    const processAttempt = { ...primeAttempt("intent"), adapter: "pi-native-v1" };
    expect(() => parseEvaluationTrialAttempt(processAttempt)).toThrow(/invalid/i);

    const extra = primeAttempt("created");
    Object.assign(extra.ociLease, { daemonId: "private-daemon" });
    expect(() => parseEvaluationTrialAttempt(extra)).toThrow(/invalid/i);
  });
});

function primeAttempt(state: "intent" | "created") {
  return {
    version: 1 as const,
    planDigest: "1".repeat(64),
    position: 1,
    trialId: `trial-${"2".repeat(48)}`,
    taskId: "task",
    profileId: "prime",
    adapter: "prime-agent-native-v1",
    startedAt: "2026-08-10T10:00:00.000Z",
    workspace: {
      backend: "reflink-copy-v1" as const,
      snapshotDigest: "3".repeat(64),
    },
    ociLease: {
      version: 1 as const,
      adapter: "prime-agent-native-v1" as const,
      state,
      ownerNonce: "4".repeat(64),
      containerName: `flow-prime-${"5".repeat(32)}`,
      labels: {
        evaluationId: "evaluation",
        trialId: `trial-${"2".repeat(48)}`,
        ownerNonce: "4".repeat(64),
        imageId: `sha256:${"6".repeat(64)}`,
        policyDigest: "7".repeat(64),
      },
      imageId: `sha256:${"6".repeat(64)}`,
      policyDigest: "7".repeat(64),
      fixtureDigest: "a".repeat(64),
      engineEndpoint: {
        socketPath: "/var/run/docker.sock" as const,
        device: 1,
        inode: 2,
        uid: 0,
        gid: 999,
        mode: 0o660,
      },
      ...(state === "intent"
        ? {}
        : {
            containerId: "8".repeat(64),
            inspectedPolicyDigest: "9".repeat(64),
          }),
    },
  };
}
