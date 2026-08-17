import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  activateCapabilityRepositoryCandidate,
  CapabilityRepositoryActivationError,
} from "../../../src/application/activate-capability-repository-candidate.js";
import { createCapabilityRepositoryCandidate } from "../../../src/application/capability-repository-candidate.js";
import { createCapabilityBundleSource } from "../../../src/domain/capability/capability-bundles.js";
import {
  encodeCapabilityRepositoryIndex,
  parseCapabilityRepositoryIndex,
} from "../../../src/domain/capability/capability-repository.js";
import { encodeSignedCapabilityBundleEnvelope } from "../../../src/domain/capability/signed-capability-bundle-envelope.js";

const policy = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/publish.yml@refs/tags/v1.0.0",
});

describe("activate capability repository candidate", () => {
  it("reopens, reverifies, and installs one exact reviewed candidate offline", async () => {
    const fixture = candidateFixture();
    const verify = vi.fn(() => ({ ...policy }));
    const install = vi.fn(async () => ({
      status: "installed" as const,
      bundle: fixture.candidate.bundle,
    }));
    const signal = new AbortController().signal;

    const result = await activateCapabilityRepositoryCandidate(
      {
        candidates: {
          readCandidate: vi.fn(async () => ({
            identity: fixture.candidate.identity,
            envelopeBytes: () => fixture.candidate.envelopeBytes(),
          })),
        },
        verifier: { verify },
        packages: { install },
      },
      {
        candidateDigest: fixture.candidate.identity.candidateDigest,
        ...policy,
        signal,
      },
    );

    expect(result.status).toBe("installed");
    expect(verify).toHaveBeenCalledWith(
      fixture.candidate.capabilityBundleBytes(),
      fixture.candidate.sigstoreBundleBytes(),
      policy,
    );
    expect(install).toHaveBeenCalledWith({
      source: fixture.candidate.identity.target.source,
      expectedSha256: fixture.candidate.identity.bundle.digest.slice("sha256:".length),
      content: fixture.candidate.capabilityBundleBytes(),
      publisher: fixture.candidate.identity.publisher,
      signal,
    });
  });

  it("rejects a substituted publisher before verification or package mutation", async () => {
    const fixture = candidateFixture();
    const verify = vi.fn();
    const install = vi.fn();

    await expect(
      activateCapabilityRepositoryCandidate(
        {
          candidates: {
            readCandidate: vi.fn(async () => ({
              identity: fixture.candidate.identity,
              envelopeBytes: () => fixture.candidate.envelopeBytes(),
            })),
          },
          verifier: { verify },
          packages: { install },
        },
        {
          candidateDigest: fixture.candidate.identity.candidateDigest,
          certificateIssuer: policy.certificateIssuer,
          certificateIdentity: "PRIVATE_SUBSTITUTED_IDENTITY",
        },
      ),
    ).rejects.toEqual(new CapabilityRepositoryActivationError("validate candidate authority"));
    expect(verify).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("rejects changed reopened envelope bytes after repository authentication", async () => {
    const fixture = candidateFixture();
    const verify = vi.fn(() => ({ ...policy }));
    const install = vi.fn();

    await expect(
      activateCapabilityRepositoryCandidate(
        {
          candidates: {
            readCandidate: vi.fn(async () => ({
              identity: fixture.candidate.identity,
              envelopeBytes: () => Buffer.from("PRIVATE_CHANGED_ENVELOPE"),
            })),
          },
          verifier: { verify },
          packages: { install },
        },
        { candidateDigest: fixture.candidate.identity.candidateDigest, ...policy },
      ),
    ).rejects.toEqual(new CapabilityRepositoryActivationError("verify candidate package"));
    expect(install).not.toHaveBeenCalled();
  });
});

function candidateFixture() {
  const bundle = createCapabilityBundleSource({
    name: "review-suite",
    version: "1.0.0",
    description: "Review capabilities.",
    packages: [
      {
        kind: "verifier-package",
        manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review
  version: 1.0.0
  description: Review declared evidence.
spec:
  kind: model
  prompt: Review evidence.
`),
      },
    ],
  });
  const sigstoreBundle = Buffer.from("PRIVATE_SIGSTORE_BUNDLE");
  const envelope = encodeSignedCapabilityBundleEnvelope({
    capabilityBundle: bundle.content,
    sigstoreBundle,
  });
  const targetPath = "flow/packages/review-suite/1.0.0.flowpkg.json";
  const index = parseCapabilityRepositoryIndex(
    encodeCapabilityRepositoryIndex({
      packages: [{ name: bundle.bundle.name, version: bundle.bundle.version, targetPath }],
    }),
  );
  const entry = index.packages[0];
  if (entry === undefined) {
    throw new Error("fixture requires one repository entry");
  }
  const candidate = createCapabilityRepositoryCandidate({
    repositoryMetadata: [
      { name: "root.json", length: 100, digest: digest(Buffer.from("root")) },
      { name: "timestamp.json", length: 100, digest: digest(Buffer.from("timestamp")) },
    ],
    index,
    entry,
    target: {
      path: targetPath,
      source: "https://packages.example.test/targets/7f/7fd4c3.review-suite-1.0.0.flowpkg.json",
      length: envelope.byteLength,
      hashes: { sha256: sha256Hex(envelope) },
      custom: {
        flow: {
          apiVersion: "flow.synapti.ai/v1alpha1",
          kind: "CapabilityPackageTarget",
          name: bundle.bundle.name,
          version: bundle.bundle.version,
          publisher: policy,
        },
      },
      content: envelope,
    },
    authority: {
      kind: "sigstore-keyless-v0.3",
      ...policy,
      signatureBundleDigest: digest(sigstoreBundle),
    },
  });
  return { candidate };
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(content)}`;
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
