import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { RefreshCapabilityMetadataResult } from "../../../src/application/capability-package-store.js";
import { createCapabilityMetadataImporter } from "../../../src/application/import-capability-metadata.js";
import { CapabilityMetadataError } from "../../../src/domain/capability/capability-metadata.js";
import {
  SigstoreCapabilityVerificationError,
  type SigstoreCapabilityVerifier,
} from "../../../src/domain/capability/sigstore-capability-verifier.js";

const policy = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/metadata-v1",
});
const now = new Date("2026-08-14T00:00:00.000Z");

describe("capability metadata importer", () => {
  it("preserves a pre-existing cancellation before metadata validation", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled before metadata validation");
    controller.abort(reason);
    const verify = vi.fn();
    const refreshMetadata = vi.fn();
    const importer = createCapabilityMetadataImporter(
      { verify } satisfies SigstoreCapabilityVerifier,
      { refreshMetadata },
    );

    await expect(
      importer.import({
        metadata: Buffer.from("not canonical metadata"),
        sigstoreBundle: Buffer.from("PRIVATE_SIGSTORE_PROOF"),
        ...policy,
        now,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(verify).not.toHaveBeenCalled();
    expect(refreshMetadata).not.toHaveBeenCalled();
  });

  it("verifies exact canonical metadata bytes before publishing derived authority", async () => {
    const events: string[] = [];
    const metadata = metadataBytes();
    const sigstoreBundle = Buffer.from("PRIVATE_SIGSTORE_PROOF");
    const verify = vi.fn(() => {
      events.push("verify");
      return policy;
    });
    const refreshMetadata = vi.fn(async (input): Promise<RefreshCapabilityMetadataResult> => {
      events.push("refresh");
      return {
        status: "established",
        state: {
          apiVersion: "flow.synapti.ai/v1alpha1",
          kind: "CapabilityMetadataState",
          name: input.metadata.name,
          version: input.metadata.version,
          expiresAt: input.metadata.expiresAt,
          metadataBytes: input.metadata.bytes,
          metadataDigest: input.metadata.digest,
          authority: input.authority,
          targets: input.metadata.targets,
        },
      };
    });
    const importer = createCapabilityMetadataImporter(
      { verify } satisfies SigstoreCapabilityVerifier,
      { refreshMetadata },
    );

    await expect(
      importer.import({ metadata, sigstoreBundle, ...policy, now }),
    ).resolves.toMatchObject({
      status: "established",
      state: { name: "project-capabilities", version: 1 },
    });

    expect(events).toEqual(["verify", "refresh"]);
    expect(verify).toHaveBeenCalledWith(metadata, sigstoreBundle, policy);
    expect(refreshMetadata).toHaveBeenCalledWith({
      metadata: expect.objectContaining({
        name: "project-capabilities",
        version: 1,
        digest: `sha256:${createHash("sha256").update(metadata).digest("hex")}`,
      }),
      authority: {
        kind: "sigstore-keyless-v0.3",
        ...policy,
        signatureBundleDigest: `sha256:${createHash("sha256")
          .update(sigstoreBundle)
          .digest("hex")}`,
      },
    });
  });

  it("preserves exact cancellation after verification and before metadata mutation", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled metadata refresh");
    const verify = vi.fn(() => {
      controller.abort(reason);
      return policy;
    });
    const refreshMetadata = vi.fn();
    const importer = createCapabilityMetadataImporter(
      { verify } satisfies SigstoreCapabilityVerifier,
      { refreshMetadata },
    );

    await expect(
      importer.import({
        metadata: metadataBytes(),
        sigstoreBundle: Buffer.from("PRIVATE_SIGSTORE_PROOF"),
        ...policy,
        now,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(refreshMetadata).not.toHaveBeenCalled();
  });

  it("rejects non-canonical metadata before signature verification or state mutation", async () => {
    const verify = vi.fn();
    const refreshMetadata = vi.fn();
    const importer = createCapabilityMetadataImporter(
      { verify } satisfies SigstoreCapabilityVerifier,
      { refreshMetadata },
    );

    await expect(
      importer.import({
        metadata: Buffer.from(`${metadataBytes().toString("utf8")}\n`),
        sigstoreBundle: Buffer.from("PRIVATE_SIGSTORE_PROOF"),
        ...policy,
        now,
      }),
    ).rejects.toEqual(new CapabilityMetadataError("validate metadata"));
    expect(verify).not.toHaveBeenCalled();
    expect(refreshMetadata).not.toHaveBeenCalled();
  });

  it("preserves signature failure and performs no state mutation", async () => {
    const failure = new SigstoreCapabilityVerificationError("verify publisher signature");
    const verify = vi.fn(() => {
      throw failure;
    });
    const refreshMetadata = vi.fn();
    const importer = createCapabilityMetadataImporter(
      { verify } satisfies SigstoreCapabilityVerifier,
      { refreshMetadata },
    );

    await expect(
      importer.import({
        metadata: metadataBytes(),
        sigstoreBundle: Buffer.from("PRIVATE_SIGSTORE_PROOF"),
        ...policy,
        now,
      }),
    ).rejects.toBe(failure);
    expect(refreshMetadata).not.toHaveBeenCalled();
  });
});

function metadataBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityMetadata",
      metadata: {
        name: "project-capabilities",
        version: 1,
        expiresAt: "2026-08-15T00:00:00.000Z",
      },
      spec: {
        targets: [
          {
            name: "review-suite",
            version: "1.0.0",
            digest: `sha256:${"a".repeat(64)}`,
            bytes: 4096,
            source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
            status: "active",
          },
        ],
      },
    }),
  );
}
