import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  type CapabilityMetadataCandidateStore,
  CapabilityMetadataCandidateStoreError,
} from "../../../src/application/capability-metadata-candidate-store.js";
import type { CapabilityMetadataState } from "../../../src/application/capability-package-store.js";
import {
  CapabilityMetadataCheckError,
  createCapabilityMetadataChannelChecker,
} from "../../../src/application/check-capability-metadata-channel.js";
import { createSignedCapabilityMetadataVerifier } from "../../../src/application/verify-signed-capability-metadata.js";
import { encodeSignedCapabilityMetadataEnvelope } from "../../../src/domain/capability/signed-capability-metadata-envelope.js";

const policy = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/metadata-v1",
});
const checkedAt = new Date("2026-08-14T00:00:00.000Z");
const channel = "https://metadata.example.test/flow/capability-metadata.json";

describe("capability metadata channel checker", () => {
  it("checks, verifies, compares active authority, and stages in exact order", async () => {
    const events: string[] = [];
    const envelope = signedEnvelope(2);
    const read = vi.fn(async () => {
      events.push("read");
      return envelope;
    });
    const signatureVerify = vi.fn(() => {
      events.push("verify");
      return policy;
    });
    const inspectMetadata = vi.fn(async () => {
      events.push("inspect-active");
      return activeState({ version: 1 });
    });
    const stage = vi.fn(async (input) => {
      events.push("stage");
      return {
        status: "staged" as const,
        candidate: input.candidate,
        observation: { ...input.observation, candidateDigest: input.candidate.candidateDigest },
      };
    });
    const checker = createCapabilityMetadataChannelChecker({
      channel: { read },
      verifier: createSignedCapabilityMetadataVerifier({ verify: signatureVerify }),
      activeMetadata: { inspectMetadata },
      candidates: candidateStore({ stage }),
      now: () => new Date(checkedAt),
    });

    const result = await checker.check({ channel, ...policy });

    expect(events).toEqual(["read", "verify", "inspect-active", "stage"]);
    expect(result).toMatchObject({
      status: "staged",
      candidate: { metadata: { version: 2 } },
      observation: {
        checkedAt: checkedAt.toISOString(),
        channel,
        envelopeBytes: envelope.byteLength,
        candidateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(read).toHaveBeenCalledWith(channel, expect.any(AbortSignal));
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: metadataBytes(2),
        sigstoreBundle: Buffer.from("PRIVATE_SIGSTORE_PROOF_2"),
        observation: expect.objectContaining({ checkedAt: checkedAt.toISOString(), channel }),
      }),
    );
  });

  it.each([
    ["lower version", activeState({ version: 3 }), signedEnvelope(2)],
    [
      "equal-version substitution",
      activeState({ version: 2, metadataDigest: `sha256:${"0".repeat(64)}` }),
      signedEnvelope(2),
    ],
    [
      "authority substitution",
      activeState({ version: 1, certificateIdentity: "https://publisher.example.test/other" }),
      signedEnvelope(2),
    ],
  ])("rejects %s before candidate mutation", async (_label, active, envelope) => {
    const stage = vi.fn();
    const checker = createCapabilityMetadataChannelChecker({
      channel: { read: vi.fn(async () => envelope) },
      verifier: createSignedCapabilityMetadataVerifier({ verify: vi.fn(() => policy) }),
      activeMetadata: { inspectMetadata: vi.fn(async () => active) },
      candidates: candidateStore({ stage }),
      now: () => new Date(checkedAt),
    });

    await expect(checker.check({ channel, ...policy })).rejects.toEqual(
      new CapabilityMetadataCheckError("compare active metadata"),
    );
    expect(stage).not.toHaveBeenCalled();
  });

  it("does not let a channel failure reach signature or storage authority", async () => {
    const failure = new Error("fixed channel failure");
    const verify = vi.fn();
    const inspectMetadata = vi.fn();
    const stage = vi.fn();
    const checker = createCapabilityMetadataChannelChecker({
      channel: {
        read: vi.fn(async () => {
          throw failure;
        }),
      },
      verifier: createSignedCapabilityMetadataVerifier({ verify }),
      activeMetadata: { inspectMetadata },
      candidates: candidateStore({ stage }),
      now: () => new Date(checkedAt),
    });

    await expect(checker.check({ channel, ...policy })).rejects.toBe(failure);
    expect(verify).not.toHaveBeenCalled();
    expect(inspectMetadata).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it("applies one total deadline through candidate publication", async () => {
    const signals: AbortSignal[] = [];
    const stage = vi.fn(
      async (input: Parameters<CapabilityMetadataCandidateStore["stage"]>[0]) =>
        await new Promise<never>((_resolve, reject) => {
          if (input.signal === undefined) {
            reject(new Error("missing total check signal"));
            return;
          }
          signals.push(input.signal);
          input.signal.addEventListener("abort", () => reject(input.signal?.reason), {
            once: true,
          });
        }),
    );
    const checker = createCapabilityMetadataChannelChecker({
      channel: {
        read: vi.fn(async (_source, signal) => {
          if (signal === undefined) {
            throw new Error("missing total check signal");
          }
          signals.push(signal);
          return signedEnvelope(2);
        }),
      },
      verifier: createSignedCapabilityMetadataVerifier({ verify: vi.fn(() => policy) }),
      activeMetadata: { inspectMetadata: vi.fn(async () => activeState({ version: 1 })) },
      candidates: candidateStore({ stage }),
      now: () => new Date(checkedAt),
      timeoutMs: 1,
    });

    await expect(checker.check({ channel, ...policy })).rejects.toEqual(
      new CapabilityMetadataCheckError("complete metadata check"),
    );
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(stage).toHaveBeenCalledOnce();
  });

  it("waits for timed-out candidate publication to finish abort settlement", async () => {
    let stageSettled = false;
    let finishSettlement: (() => void) | undefined;
    const settlementFinished = new Promise<void>((resolve) => {
      finishSettlement = resolve;
    });
    const stage = vi.fn(
      async (input: Parameters<CapabilityMetadataCandidateStore["stage"]>[0]) =>
        await new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                stageSettled = true;
                finishSettlement?.();
                reject(input.signal?.reason);
              }, 5);
            },
            { once: true },
          );
        }),
    );
    const checker = createCapabilityMetadataChannelChecker({
      channel: { read: vi.fn(async () => signedEnvelope(2)) },
      verifier: createSignedCapabilityMetadataVerifier({ verify: vi.fn(() => policy) }),
      activeMetadata: { inspectMetadata: vi.fn(async () => activeState({ version: 1 })) },
      candidates: candidateStore({ stage }),
      now: () => new Date(checkedAt),
      timeoutMs: 1,
    });

    try {
      await expect(checker.check({ channel, ...policy })).rejects.toEqual(
        new CapabilityMetadataCheckError("complete metadata check"),
      );
      expect(stageSettled).toBe(true);
    } finally {
      await settlementFinished;
    }
  });

  it("preserves post-rename candidate settlement uncertainty over cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled after candidate rename");
    const settlement = new CapabilityMetadataCandidateStoreError("settle candidate commit");
    const checker = createCapabilityMetadataChannelChecker({
      channel: { read: vi.fn(async () => signedEnvelope(2)) },
      verifier: createSignedCapabilityMetadataVerifier({ verify: vi.fn(() => policy) }),
      activeMetadata: { inspectMetadata: vi.fn(async () => activeState({ version: 1 })) },
      candidates: candidateStore({
        stage: vi.fn(async () => {
          controller.abort(reason);
          throw settlement;
        }),
      }),
      now: () => new Date(checkedAt),
    });

    await expect(checker.check({ channel, ...policy, signal: controller.signal })).rejects.toBe(
      settlement,
    );
  });
});

function candidateStore(
  overrides: Partial<CapabilityMetadataCandidateStore>,
): CapabilityMetadataCandidateStore {
  return {
    stage: vi.fn(),
    list: vi.fn(),
    read: vi.fn(),
    remove: vi.fn(),
    latestCheck: vi.fn(),
    ...overrides,
  } as CapabilityMetadataCandidateStore;
}

function signedEnvelope(version: number): Buffer {
  return encodeSignedCapabilityMetadataEnvelope({
    metadata: metadataBytes(version),
    sigstoreBundle: Buffer.from(`PRIVATE_SIGSTORE_PROOF_${version}`),
  });
}

function metadataBytes(version: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityMetadata",
      metadata: { name: "project-capabilities", version, expiresAt: "2026-08-15T00:00:00.000Z" },
      spec: { targets: [] },
    }),
  );
}

function activeState(options: {
  version: number;
  metadataDigest?: string;
  certificateIdentity?: string;
}): CapabilityMetadataState {
  const metadata = metadataBytes(options.version);
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "CapabilityMetadataState",
    name: "project-capabilities",
    version: options.version,
    expiresAt: "2026-08-15T00:00:00.000Z",
    metadataBytes: metadata.byteLength,
    metadataDigest: options.metadataDigest ?? `sha256:${createDigest(metadata)}`,
    authority: {
      kind: "sigstore-keyless-v0.3",
      certificateIssuer: policy.certificateIssuer,
      certificateIdentity: options.certificateIdentity ?? policy.certificateIdentity,
      signatureBundleDigest: `sha256:${"f".repeat(64)}`,
    },
    targets: [],
  };
}

function createDigest(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}
