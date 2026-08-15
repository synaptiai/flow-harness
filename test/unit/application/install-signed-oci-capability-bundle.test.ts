import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createSignedOciCapabilityBundleInstaller } from "../../../src/application/install-signed-oci-capability-bundle.js";
import {
  createCapabilityBundleSource,
  parseCapabilityBundle,
} from "../../../src/domain/capability/capability-bundles.js";
import {
  FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
  SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
} from "../../../src/domain/capability/oci-capability-artifacts.js";
import { SigstoreCapabilityVerificationError } from "../../../src/domain/capability/sigstore-capability-verifier.js";
import type { InstallCapabilityBundleResult } from "../../../src/infrastructure/fs/local-capability-package-store.js";
import type {
  AcquiredOciCapabilityArtifact,
  OciRegistryCredentialProvider,
} from "../../../src/infrastructure/http/strict-oci-capability-registry.js";

const manifestDigest = `sha256:${"1".repeat(64)}` as const;
const reference = `registry.example.test/flow/review-suite@${manifestDigest}`;
const policy = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/v1.0.0",
});

describe("signed OCI capability bundle installer", () => {
  it("validates publisher authority before acquisition", async () => {
    const fixture = installerFixture();

    await expect(
      fixture.installer.install({
        reference,
        certificateIssuer: "http://PRIVATE_ISSUER",
        certificateIdentity: policy.certificateIdentity,
      }),
    ).rejects.toEqual(new SigstoreCapabilityVerificationError("validate publisher policy"));
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("verifies exact acquired bytes before publishing signed provenance", async () => {
    const events: string[] = [];
    const fixture = installerFixture({ events });

    await expect(
      fixture.installer.install({
        reference,
        ...policy,
      }),
    ).resolves.toMatchObject({
      status: "installed",
      bundle: { name: "review-suite", version: "1.0.0" },
      source: reference,
      publisher: {
        kind: "sigstore-keyless-v0.3",
        ...policy,
        signatureBundleDigest: fixture.artifact.manifest.sigstoreBundle.digest,
      },
    });

    expect(events).toEqual(["acquire", "verify", "publish"]);
    expect(fixture.acquire).toHaveBeenCalledWith(reference, undefined, undefined);
    expect(fixture.verify).toHaveBeenCalledWith(
      fixture.artifact.capabilityBundle,
      fixture.artifact.sigstoreBundle,
      policy,
    );
    expect(fixture.publish).toHaveBeenCalledWith({
      source: reference,
      expectedSha256: fixture.artifact.manifest.bundle.digest.slice("sha256:".length),
      content: fixture.artifact.capabilityBundle,
      publisher: {
        kind: "sigstore-keyless-v0.3",
        ...policy,
        signatureBundleDigest: fixture.artifact.manifest.sigstoreBundle.digest,
      },
    });
  });

  it("forwards one per-install credential provider only to registry acquisition", async () => {
    const fixture = installerFixture();
    const credentialProvider: OciRegistryCredentialProvider = vi.fn();

    await fixture.installer.install({
      reference,
      ...policy,
      credentialProvider,
    });

    expect(fixture.acquire).toHaveBeenCalledWith(reference, undefined, credentialProvider);
    expect(fixture.verify).toHaveBeenCalledOnce();
    expect(fixture.publish).toHaveBeenCalledOnce();
  });

  it("does not publish when registry acquisition or publisher verification fails", async () => {
    const registryFailure = installerFixture({ acquireError: new Error("PRIVATE_REGISTRY") });
    await expect(registryFailure.installer.install({ reference, ...policy })).rejects.toThrow(
      "PRIVATE_REGISTRY",
    );
    expect(registryFailure.verify).not.toHaveBeenCalled();
    expect(registryFailure.publish).not.toHaveBeenCalled();

    const verificationFailure = installerFixture({
      verifyError: new SigstoreCapabilityVerificationError("verify publisher signature"),
    });
    await expect(verificationFailure.installer.install({ reference, ...policy })).rejects.toEqual(
      new SigstoreCapabilityVerificationError("verify publisher signature"),
    );
    expect(verificationFailure.publish).not.toHaveBeenCalled();
  });

  it("preserves exact cancellation after verification and before publication", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled signed install");
    const fixture = installerFixture({
      afterVerify: () => controller.abort(reason),
    });

    await expect(
      fixture.installer.install({ reference, ...policy, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(fixture.publish).not.toHaveBeenCalled();
  });
});

function installerFixture(
  options: {
    readonly events?: string[];
    readonly acquireError?: Error;
    readonly verifyError?: Error;
    readonly afterVerify?: () => void;
  } = {},
) {
  const capabilityBundle = capabilityBundleBytes();
  const sigstoreBundle = Buffer.from("exact Sigstore bundle bytes");
  const artifact: AcquiredOciCapabilityArtifact = Object.freeze({
    reference: Object.freeze({
      canonical: reference,
      registryOrigin: "https://registry.example.test",
      repository: "flow/review-suite",
      manifestDigest,
    }),
    manifest: Object.freeze({
      digest: manifestDigest,
      bytes: 512,
      bundle: Object.freeze({
        mediaType: FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
        digest: digest(capabilityBundle),
        size: capabilityBundle.byteLength,
      }),
      sigstoreBundle: Object.freeze({
        mediaType: SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
        digest: digest(sigstoreBundle),
        size: sigstoreBundle.byteLength,
      }),
    }),
    capabilityBundle,
    sigstoreBundle,
  });
  const bundle = parseCapabilityBundle(capabilityBundle);
  const result: InstallCapabilityBundleResult = Object.freeze({ status: "installed", bundle });
  const acquire = vi.fn(async () => {
    options.events?.push("acquire");
    if (options.acquireError !== undefined) {
      throw options.acquireError;
    }
    return artifact;
  });
  const verify = vi.fn(() => {
    options.events?.push("verify");
    if (options.verifyError !== undefined) {
      throw options.verifyError;
    }
    options.afterVerify?.();
    return policy;
  });
  const publish = vi.fn(async () => {
    options.events?.push("publish");
    return result;
  });
  return {
    artifact,
    acquire,
    verify,
    publish,
    installer: createSignedOciCapabilityBundleInstaller(
      { acquire },
      { verify },
      { install: publish },
    ),
  };
}

function capabilityBundleBytes(): Buffer {
  return createCapabilityBundleSource({
    name: "review-suite",
    version: "1.0.0",
    description: "Review capabilities for a Flow project.",
    license: "Apache-2.0",
    packages: [
      {
        kind: "verifier-package",
        manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review
  version: 1.2.0
  description: Review declared evidence.
  license: Apache-2.0
spec:
  kind: model
  prompt: Review evidence.
`),
      },
    ],
  }).content;
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
