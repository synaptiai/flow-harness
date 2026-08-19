import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityMetadataChannel } from "../../../src/application/capability-metadata-channel.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import {
  createCapabilityBundleSource,
  parseCapabilityBundle,
} from "../../../src/domain/capability/capability-bundles.js";
import {
  MAX_CAPABILITY_METADATA_BYTES,
  parseCapabilityMetadata,
} from "../../../src/domain/capability/capability-metadata.js";
import {
  FLOW_CAPABILITY_ARTIFACT_TYPE,
  FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
  OCI_EMPTY_CONFIG_DIGEST,
  OCI_EMPTY_CONFIG_MEDIA_TYPE,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
} from "../../../src/domain/capability/oci-capability-artifacts.js";
import { encodeSignedCapabilityMetadataEnvelope } from "../../../src/domain/capability/signed-capability-metadata-envelope.js";
import type { SigstoreCapabilityVerifier } from "../../../src/domain/capability/sigstore-capability-verifier.js";
import { MAX_VERIFIER_PACKAGE_MANIFEST_BYTES } from "../../../src/domain/capability/verifier-packages.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import { packCapabilityBundleDirectory } from "../../../src/infrastructure/fs/capability-bundle-packer.js";
import { LocalCapabilityPackageStore } from "../../../src/infrastructure/fs/local-capability-package-store.js";
import type {
  CapabilityBundleFetcher,
  PinnedHttpsRequest,
  PinnedHttpsResponse,
} from "../../../src/infrastructure/http/strict-capability-bundle-fetcher.js";
import {
  type AcquiredOciCapabilityArtifact,
  createStrictOciCapabilityRegistry,
  type StrictOciCapabilityRegistry,
} from "../../../src/infrastructure/http/strict-oci-capability-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("capability package CLI", () => {
  it("checks, reviews, activates, and removes one durable metadata candidate explicitly", async () => {
    const project = await projectDirectory();
    const metadata = Buffer.from(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityMetadata",
        metadata: {
          name: "flow-capabilities",
          version: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        spec: { targets: [] },
      }),
    );
    const sigstoreBundle = Buffer.from("PRIVATE_DISCOVERY_SIGSTORE_PROOF");
    const envelope = encodeSignedCapabilityMetadataEnvelope({ metadata, sigstoreBundle });
    const publisher = Object.freeze({
      certificateIssuer: "https://token.actions.githubusercontent.com/",
      certificateIdentity:
        "https://github.com/synaptiai/flow-harness/.github/workflows/metadata.yml@refs/heads/main",
    });
    const channelUrl = "https://metadata.example.test/flow/capability-metadata.json";
    const read = vi.fn(async () => envelope);
    const verify = vi.fn().mockReturnValue(publisher);
    const cliDependencies = {
      ...dependencies(project, { fetch: vi.fn() }),
      capabilityMetadataChannel: { read } satisfies CapabilityMetadataChannel,
      sigstoreCapabilityVerifier: { verify } satisfies SigstoreCapabilityVerifier,
    };
    const checked = captureIo();
    const listed = captureIo();
    const inspected = captureIo();
    const activeBefore = captureIo();
    const activated = captureIo();
    const removed = captureIo();
    const listedAfter = captureIo();
    const activeAfter = captureIo();

    expect(
      await main(
        [
          "packages",
          "metadata",
          "check",
          channelUrl,
          "--certificate-issuer",
          publisher.certificateIssuer,
          "--certificate-identity",
          publisher.certificateIdentity,
        ],
        checked.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(
      await main(["packages", "metadata", "candidates", "list"], listed.io, cliDependencies),
    ).toBe(0);
    const listedResult = JSON.parse(listed.stdout[0] ?? "null") as {
      candidates: readonly { candidateDigest: string }[];
    };
    const candidateDigest = listedResult.candidates[0]?.candidateDigest;
    expect(candidateDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    if (candidateDigest === undefined) {
      throw new Error("candidate list did not contain the checked candidate");
    }
    expect(
      await main(
        ["packages", "metadata", "candidate", "inspect", candidateDigest],
        inspected.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(await main(["packages", "metadata", "inspect"], activeBefore.io, cliDependencies)).toBe(
      0,
    );
    expect(
      await main(
        [
          "packages",
          "metadata",
          "activate",
          candidateDigest,
          "--certificate-issuer",
          publisher.certificateIssuer,
          "--certificate-identity",
          publisher.certificateIdentity,
        ],
        activated.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(
      await main(
        ["packages", "metadata", "candidate", "remove", candidateDigest],
        removed.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(
      await main(["packages", "metadata", "candidates", "list"], listedAfter.io, cliDependencies),
    ).toBe(0);
    expect(await main(["packages", "metadata", "inspect"], activeAfter.io, cliDependencies)).toBe(
      0,
    );

    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(channelUrl, expect.any(AbortSignal));
    expect(verify).toHaveBeenCalledTimes(6);
    expect(JSON.parse(checked.stdout[0] ?? "null")).toEqual({ status: "staged" });
    expect(JSON.parse(listed.stdout[0] ?? "null")).toMatchObject({
      candidates: [{ candidateDigest, authority: publisher }],
    });
    expect(JSON.parse(inspected.stdout[0] ?? "null")).toMatchObject({
      candidate: {
        candidateDigest,
        authority: publisher,
        metadata: { version: 1, targets: [] },
        sigstoreBundle: { digest: sha256Digest(sigstoreBundle) },
      },
    });
    expect(JSON.parse(activeBefore.stdout[0] ?? "null")).toEqual({ metadata: null });
    expect(JSON.parse(activated.stdout[0] ?? "null")).toMatchObject({
      status: "established",
      candidateDigest,
      metadata: { name: "flow-capabilities", version: 1 },
    });
    expect(JSON.parse(removed.stdout[0] ?? "null")).toEqual({
      status: "removed",
      candidateDigest,
    });
    expect(JSON.parse(listedAfter.stdout[0] ?? "null")).toEqual({ candidates: [] });
    expect(JSON.parse(activeAfter.stdout[0] ?? "null")).toMatchObject({
      metadata: { name: "flow-capabilities", version: 1 },
    });
    const visible = [checked, listed, inspected, activated, removed]
      .flatMap((capture) => [...capture.stdout, ...capture.stderr])
      .join("\n");
    expect(visible).not.toContain("PRIVATE_DISCOVERY_SIGSTORE_PROOF");
    await expect(stat(join(project, ".flow", "packages.lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    [
      "check without signer policy",
      ["packages", "metadata", "check", "https://metadata.example.test/channel"],
    ],
    [
      "candidate listing with signer authority",
      [
        "packages",
        "metadata",
        "candidates",
        "list",
        "--certificate-issuer",
        "https://PRIVATE.example.test/",
      ],
    ],
    [
      "activation without signer policy",
      ["packages", "metadata", "activate", `sha256:${"a".repeat(64)}`],
    ],
    [
      "check with repeated issuer authority",
      [
        "packages",
        "metadata",
        "check",
        "https://metadata.example.test/channel",
        "--certificate-issuer",
        "https://issuer.example.test/",
        "--certificate-issuer",
        "https://PRIVATE.example.test/",
        "--certificate-identity",
        "publisher",
      ],
    ],
    [
      "activation with repeated identity authority",
      [
        "packages",
        "metadata",
        "activate",
        `sha256:${"a".repeat(64)}`,
        "--certificate-issuer",
        "https://issuer.example.test/",
        "--certificate-identity",
        "publisher",
        "--certificate-identity",
        "PRIVATE_SUBSTITUTE",
      ],
    ],
  ])("rejects %s as usage before channel or store work", async (_label, args) => {
    const project = await projectDirectory();
    const read = vi.fn();
    const output = captureIo();

    expect(
      await main(args, output.io, {
        ...dependencies(project, { fetch: vi.fn() }),
        capabilityMetadataChannel: { read } satisfies CapabilityMetadataChannel,
      }),
    ).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect([...output.stdout, ...output.stderr].join("\n")).not.toContain("PRIVATE");
  });

  it("refreshes and inspects signed capability metadata from local files", async () => {
    const project = await projectDirectory();
    const created = bundle();
    const metadataPath = join(project, "capability-metadata.json");
    const sigstoreBundlePath = join(project, "capability-metadata.sigstore.json");
    const sigstoreBundle = Buffer.from("PRIVATE_METADATA_SIGSTORE_PROOF");
    const publisher = Object.freeze({
      certificateIssuer: "https://token.actions.githubusercontent.com/",
      certificateIdentity:
        "https://github.com/synaptiai/flow-harness/.github/workflows/metadata.yml@refs/heads/main",
    });
    const metadata = Buffer.from(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityMetadata",
        metadata: {
          name: "flow-capabilities",
          version: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        spec: {
          targets: [
            {
              name: created.bundle.name,
              version: created.bundle.version,
              digest: created.bundle.digest,
              bytes: created.bundle.bytes,
              source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
              status: "active",
            },
          ],
        },
      }),
    );
    await writeFile(metadataPath, metadata);
    await writeFile(sigstoreBundlePath, sigstoreBundle);
    const verifyPublisher = vi.fn().mockReturnValue(publisher);
    const cliDependencies = {
      ...dependencies(project, { fetch: vi.fn() }),
      sigstoreCapabilityVerifier: {
        verify: verifyPublisher,
      } satisfies SigstoreCapabilityVerifier,
    };
    const refreshed = captureIo();
    const inspected = captureIo();

    expect(
      await main(
        [
          "packages",
          "metadata",
          "refresh",
          metadataPath,
          "--sigstore-bundle",
          sigstoreBundlePath,
          "--certificate-issuer",
          publisher.certificateIssuer,
          "--certificate-identity",
          publisher.certificateIdentity,
        ],
        refreshed.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(await main(["packages", "metadata", "inspect"], inspected.io, cliDependencies)).toBe(0);

    expect(verifyPublisher).toHaveBeenCalledWith(metadata, sigstoreBundle, publisher);
    expect(JSON.parse(refreshed.stdout[0] ?? "null")).toMatchObject({
      status: "established",
      metadata: {
        name: "flow-capabilities",
        version: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        authority: {
          kind: "sigstore-keyless-v0.3",
          ...publisher,
          signatureBundleDigest: sha256Digest(sigstoreBundle),
        },
      },
    });
    expect(JSON.parse(inspected.stdout[0] ?? "null")).toMatchObject({
      metadata: {
        name: "flow-capabilities",
        version: 1,
        targets: [{ name: "review-suite", version: "1.0.0", status: "active" }],
      },
    });
    const visible = `${refreshed.stdout.join("\n")}\n${inspected.stdout.join("\n")}`;
    expect(visible).not.toContain("PRIVATE_METADATA_SIGSTORE_PROOF");
    expect(await readFile(join(project, ".flow", "packages.metadata.json"), "utf8")).not.toContain(
      "PRIVATE_METADATA_SIGSTORE_PROOF",
    );
  });

  it("rejects an oversized local metadata file before verification or publication", async () => {
    const project = await projectDirectory();
    const metadataPath = join(project, "PRIVATE_OVERSIZED_METADATA.json");
    const sigstoreBundlePath = join(project, "metadata.sigstore.json");
    await writeFile(metadataPath, Buffer.alloc(MAX_CAPABILITY_METADATA_BYTES + 1, 0x61));
    await writeFile(sigstoreBundlePath, "PRIVATE_METADATA_SIGSTORE_PROOF");
    const verify = vi.fn();
    const output = captureIo();

    expect(
      await main(
        [
          "packages",
          "metadata",
          "refresh",
          metadataPath,
          "--sigstore-bundle",
          sigstoreBundlePath,
          "--certificate-issuer",
          "https://token.actions.githubusercontent.com/",
          "--certificate-identity",
          "https://publisher.example.test/metadata",
        ],
        output.io,
        {
          ...dependencies(project, { fetch: vi.fn() }),
          sigstoreCapabilityVerifier: { verify } satisfies SigstoreCapabilityVerifier,
        },
      ),
    ).toBe(1);

    expect(verify).not.toHaveBeenCalled();
    expect(output.stderr).toEqual(["io: could not read signed capability metadata inputs"]);
    expect(output.stderr.join("\n")).not.toContain("PRIVATE_OVERSIZED_METADATA");
    expect(output.stderr.join("\n")).not.toContain("PRIVATE_METADATA_SIGSTORE_PROOF");
    await expect(stat(join(project, ".flow", "packages.metadata.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["expired", "revoked"] as const)(
    "keeps exact installed-package inspection available after metadata is %s",
    async (state) => {
      const project = await projectDirectory();
      const created = bundle();
      const source = "https://packages.example.test/review-suite-1.0.0.flowpkg";
      const store = new LocalCapabilityPackageStore(project);
      await store.install({
        source,
        expectedSha256: created.bundle.digest.slice("sha256:".length),
        content: created.content,
      });
      await store.refreshMetadata({
        metadata: parseCapabilityMetadata(
          Buffer.from(
            JSON.stringify({
              apiVersion: "flow.synapti.ai/v1alpha1",
              kind: "CapabilityMetadata",
              metadata: {
                name: "flow-capabilities",
                version: 1,
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
              spec: {
                targets: [
                  {
                    name: created.bundle.name,
                    version: created.bundle.version,
                    digest: created.bundle.digest,
                    bytes: created.bundle.bytes,
                    source,
                    status: state === "revoked" ? "revoked" : "active",
                  },
                ],
              },
            }),
          ),
          new Date("2026-08-15T00:00:00.000Z"),
        ),
        authority: {
          kind: "sigstore-keyless-v0.3",
          certificateIssuer: "https://token.actions.githubusercontent.com/",
          certificateIdentity:
            "https://github.com/synaptiai/flow-harness/.github/workflows/metadata.yml@refs/heads/main",
          signatureBundleDigest: `sha256:${"b".repeat(64)}`,
        },
      });
      if (state === "expired") {
        const metadataPath = join(project, ".flow", "packages.metadata.json");
        const trusted = JSON.parse(await readFile(metadataPath, "utf8")) as {
          expiresAt: string;
        };
        trusted.expiresAt = "2000-01-01T00:00:00.000Z";
        await writeFile(metadataPath, `${JSON.stringify(trusted)}\n`);
      }
      await expect(store.verify()).rejects.toMatchObject({
        code: state === "expired" ? "metadata_expired" : "metadata_target",
      });
      const output = captureIo();

      expect(
        await main(
          ["packages", "inspect", created.bundle.name, "--version", created.bundle.version],
          output.io,
          dependencies(project, { fetch: vi.fn() }),
        ),
      ).toBe(0);
      expect(JSON.parse(output.stdout[0] ?? "null")).toMatchObject({
        valid: true,
        name: created.bundle.name,
        version: created.bundle.version,
        digest: created.bundle.digest,
      });
    },
  );

  it("installs once and keeps list, inspect, verify, and remove offline", async () => {
    const project = await projectDirectory();
    const created = bundle();
    const sha256 = created.bundle.digest.slice("sha256:".length);
    const fetch = vi.fn().mockResolvedValue(created.content);
    const capabilityBundleFetcher: CapabilityBundleFetcher = { fetch };
    const cliDependencies = dependencies(project, capabilityBundleFetcher);
    const installed = captureIo();
    const listed = captureIo();
    const inspected = captureIo();
    const policyInspected = captureIo();
    const verified = captureIo();
    const removed = captureIo();

    expect(
      await main(
        [
          "packages",
          "install",
          "https://packages.example.test/review-suite-1.0.0.flowpkg",
          "--sha256",
          sha256,
        ],
        installed.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(await main(["packages", "list"], listed.io, cliDependencies)).toBe(0);
    expect(
      await main(
        ["packages", "inspect", "review-suite", "--version", "1.0.0"],
        inspected.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(await main(["packages", "verify"], verified.io, cliDependencies)).toBe(0);
    expect(
      await main(
        ["policies", "inspect", "restricted-review", "--version", "1.0.0"],
        policyInspected.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(
      await main(
        ["packages", "remove", "review-suite", "--version", "1.0.0"],
        removed.io,
        cliDependencies,
      ),
    ).toBe(0);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://packages.example.test/review-suite-1.0.0.flowpkg",
      undefined,
    );
    expect(JSON.parse(installed.stdout[0] ?? "null")).toMatchObject({
      status: "installed",
      name: "review-suite",
      version: "1.0.0",
      digest: `sha256:${sha256}`,
      packages: expect.arrayContaining([
        { kind: "verifier-package", name: "evidence-review", version: "1.2.0" },
        { kind: "policy-package", name: "restricted-review", version: "1.0.0" },
      ]),
    });
    expect(JSON.parse(listed.stdout[0] ?? "null")).toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0", digest: `sha256:${sha256}` }],
    });
    expect(JSON.parse(inspected.stdout[0] ?? "null")).toMatchObject({
      valid: true,
      name: "review-suite",
      version: "1.0.0",
      packages: expect.arrayContaining([
        { kind: "verifier-package", name: "evidence-review", version: "1.2.0" },
        { kind: "policy-package", name: "restricted-review", version: "1.0.0" },
      ]),
    });
    expect(inspected.stdout.join("\n")).not.toContain("manifestBase64");
    expect(inspected.stdout.join("\n")).not.toContain("Reject unsupported claims");
    expect(JSON.parse(policyInspected.stdout[0] ?? "null")).toMatchObject({
      name: "restricted-review",
      version: "1.0.0",
      definition: { tools: { allowed: ["read"] } },
    });
    expect(JSON.parse(verified.stdout[0] ?? "null")).toEqual({
      valid: true,
      bundles: 1,
      packages: 2,
    });
    expect(JSON.parse(removed.stdout[0] ?? "null")).toMatchObject({
      status: "removed",
      cleanup: "deleted",
      name: "review-suite",
      version: "1.0.0",
    });
  });

  it("previews and explicitly applies retired capability package maintenance", async () => {
    const project = await projectDirectory();
    const active = bundle();
    const retired = bundle("retired-suite", "PRIVATE_RETIRED_PACKAGE_CONTENT");
    const store = new LocalCapabilityPackageStore(project);
    await store.install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: active.bundle.digest.slice("sha256:".length),
      content: active.content,
    });
    const blobDirectory = join(project, ".flow", "packages", "sha256");
    const retiredPath = join(
      blobDirectory,
      `${retired.bundle.digest.slice("sha256:".length)}.flowpkg`,
    );
    await writeFile(retiredPath, retired.content);
    const cliDependencies = dependencies(project, { fetch: vi.fn() });
    const previewed = captureIo();
    const applied = captureIo();

    expect(await main(["packages", "prune"], previewed.io, cliDependencies)).toBe(0);
    const preview = JSON.parse(previewed.stdout[0] ?? "null") as {
      planDigest: string;
      retiredBlobCount: number;
      retiredBlobBytes: number;
    };
    expect(preview).toEqual({
      status: "preview",
      planDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      retiredBlobCount: 1,
      retiredBlobBytes: retired.content.byteLength,
    });
    expect(
      await main(
        ["packages", "prune", "--apply", "--expected-plan-digest", preview.planDigest],
        applied.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(applied.stdout[0] ?? "null")).toEqual({
      status: "applied",
      planDigest: preview.planDigest,
      unlinkedBlobCount: 1,
      unlinkedBlobBytes: retired.content.byteLength,
    });
    await expect(stat(retiredPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.verify()).resolves.toMatchObject([
      { bundle: { name: "review-suite", version: "1.0.0" } },
    ]);
    const visible = [
      ...previewed.stdout,
      ...previewed.stderr,
      ...applied.stdout,
      ...applied.stderr,
    ].join("\n");
    expect(visible).not.toContain("PRIVATE_RETIRED_PACKAGE_CONTENT");
    expect(visible).not.toContain(retired.bundle.digest);
    expect(visible).not.toContain(retiredPath);
  });

  it.each([
    ["apply without a plan", ["packages", "prune", "--apply"]],
    [
      "plan without apply",
      ["packages", "prune", "--expected-plan-digest", `sha256:${"a".repeat(64)}`],
    ],
    [
      "malformed plan",
      ["packages", "prune", "--apply", "--expected-plan-digest", "PRIVATE_PLAN_DIGEST"],
    ],
    ["repeated apply", ["packages", "prune", "--apply", "--apply"]],
    [
      "repeated plan",
      [
        "packages",
        "prune",
        "--apply",
        "--expected-plan-digest",
        `sha256:${"a".repeat(64)}`,
        "--expected-plan-digest",
        `sha256:${"b".repeat(64)}`,
      ],
    ],
  ] as const)("rejects prune %s before configuration or store work", async (_label, args) => {
    const project = await projectDirectory();
    const loadConfig = vi.fn(async () => effectiveConfig(project));
    const output = captureIo();

    expect(
      await main(args, output.io, {
        ...dependencies(project, { fetch: vi.fn() }),
        loadConfig,
      }),
    ).toBe(2);

    expect(loadConfig).not.toHaveBeenCalled();
    expect([...output.stdout, ...output.stderr].join("\n")).not.toContain("PRIVATE_PLAN_DIGEST");
    await expect(readdir(join(project, ".flow"))).resolves.toEqual([]);
  });

  it("installs a publisher-verified OCI bundle and keeps its audit identity offline", async () => {
    const project = await projectDirectory();
    const created = bundle();
    const signatureBundle = Buffer.from("exact signed verification bundle");
    const manifestDigest = `sha256:${"1".repeat(64)}` as const;
    const reference = `registry.example.test/flow/review-suite@${manifestDigest}`;
    const publisher = Object.freeze({
      certificateIssuer: "https://token.actions.githubusercontent.com/",
      certificateIdentity:
        "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/v1.0.0",
    });
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
          digest: sha256Digest(created.content),
          size: created.content.byteLength,
        }),
        sigstoreBundle: Object.freeze({
          mediaType: SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
          digest: sha256Digest(signatureBundle),
          size: signatureBundle.byteLength,
        }),
      }),
      capabilityBundle: created.content,
      sigstoreBundle: signatureBundle,
    });
    const acquire = vi.fn().mockResolvedValue(artifact);
    const readRegistrySecret = vi.fn();
    const verifyPublisher = vi.fn().mockReturnValue(publisher);
    const networkTrap = vi.fn().mockRejectedValue(new Error("network must remain offline"));
    const cliDependencies = {
      ...dependencies(project, { fetch: networkTrap }),
      ociCapabilityRegistry: { acquire } satisfies StrictOciCapabilityRegistry,
      sigstoreCapabilityVerifier: {
        verify: verifyPublisher,
      } satisfies SigstoreCapabilityVerifier,
      readRegistrySecret,
    };
    const installed = captureIo();
    const listed = captureIo();
    const verified = captureIo();
    const policyInspected = captureIo();

    expect(
      await main(
        [
          "packages",
          "install-oci",
          reference,
          "--certificate-issuer",
          publisher.certificateIssuer,
          "--certificate-identity",
          publisher.certificateIdentity,
        ],
        installed.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(await main(["packages", "list"], listed.io, cliDependencies)).toBe(0);
    expect(await main(["packages", "verify"], verified.io, cliDependencies)).toBe(0);
    expect(
      await main(
        ["policies", "inspect", "restricted-review", "--version", "1.0.0"],
        policyInspected.io,
        cliDependencies,
      ),
    ).toBe(0);

    expect(acquire).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledWith(reference, undefined, undefined);
    expect(readRegistrySecret).not.toHaveBeenCalled();
    expect(verifyPublisher).toHaveBeenCalledWith(created.content, signatureBundle, publisher);
    expect(networkTrap).not.toHaveBeenCalled();
    expect(JSON.parse(installed.stdout[0] ?? "null")).toMatchObject({
      status: "installed",
      name: "review-suite",
      version: "1.0.0",
      source: reference,
      publisher: {
        kind: "sigstore-keyless-v0.3",
        ...publisher,
        signatureBundleDigest: sha256Digest(signatureBundle),
      },
    });
    expect(JSON.parse(listed.stdout[0] ?? "null")).toMatchObject({
      bundles: [
        {
          source: reference,
          publisher: {
            kind: "sigstore-keyless-v0.3",
            ...publisher,
            signatureBundleDigest: sha256Digest(signatureBundle),
          },
        },
      ],
    });
    expect(JSON.parse(verified.stdout[0] ?? "null")).toEqual({
      valid: true,
      bundles: 1,
      packages: 2,
    });
    expect(JSON.parse(policyInspected.stdout[0] ?? "null")).toMatchObject({
      name: "restricted-review",
      version: "1.0.0",
      definition: { tools: { allowed: ["read"] } },
    });
  });

  it("reads one private registry secret only after an exact challenge", async () => {
    const project = await projectDirectory();
    const created = bundle();
    const signatureBundle = Buffer.from("exact private verification bundle");
    const manifestDigest = `sha256:${"2".repeat(64)}` as const;
    const reference = `registry.example.test/flow/private-suite@${manifestDigest}`;
    const publisher = Object.freeze({
      certificateIssuer: "https://token.actions.githubusercontent.com/",
      certificateIdentity:
        "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/v1.0.0",
    });
    const artifact: AcquiredOciCapabilityArtifact = Object.freeze({
      reference: Object.freeze({
        canonical: reference,
        registryOrigin: "https://registry.example.test",
        repository: "flow/private-suite",
        manifestDigest,
      }),
      manifest: Object.freeze({
        digest: manifestDigest,
        bytes: 512,
        bundle: Object.freeze({
          mediaType: FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
          digest: sha256Digest(created.content),
          size: created.content.byteLength,
        }),
        sigstoreBundle: Object.freeze({
          mediaType: SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
          digest: sha256Digest(signatureBundle),
          size: signatureBundle.byteLength,
        }),
      }),
      capabilityBundle: created.content,
      sigstoreBundle: signatureBundle,
    });
    const controller = new AbortController();
    const password = Buffer.from("PRIVATE_REGISTRY_PASSWORD");
    const readRegistrySecret = vi.fn(async (signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return password;
    });
    const challenge = Object.freeze({
      realm: "https://auth.example.test/token",
      service: "registry.example.test",
      scope: "repository:flow/private-suite:pull",
    });
    const acquire = vi.fn(async (_reference, signal, credentialProvider) => {
      if (credentialProvider === undefined || signal === undefined) {
        throw new Error("expected private credential provider and signal");
      }
      const credentials = await credentialProvider(challenge, signal);
      expect(credentials.username).toBe("private-user");
      expect(credentials.password.toString("utf8")).toBe("PRIVATE_REGISTRY_PASSWORD");
      credentials.password.fill(0);
      return artifact;
    });
    const output = captureIo();

    expect(
      await main(
        [
          "packages",
          "install-oci",
          reference,
          "--certificate-issuer",
          publisher.certificateIssuer,
          "--certificate-identity",
          publisher.certificateIdentity,
          "--username",
          "private-user",
          "--password-stdin",
        ],
        output.io,
        {
          ...dependencies(project, { fetch: vi.fn() }),
          ociCapabilityRegistry: { acquire } satisfies StrictOciCapabilityRegistry,
          sigstoreCapabilityVerifier: {
            verify: vi.fn().mockReturnValue(publisher),
          } satisfies SigstoreCapabilityVerifier,
          readRegistrySecret,
          signal: controller.signal,
        },
      ),
    ).toBe(0);

    expect(acquire).toHaveBeenCalledWith(reference, controller.signal, expect.any(Function));
    expect(readRegistrySecret).toHaveBeenCalledOnce();
    expect(password.equals(Buffer.alloc(password.byteLength))).toBe(true);
    expect(output.stdout.join("\n")).not.toContain("private-user");
    expect(output.stdout.join("\n")).not.toContain("PRIVATE_REGISTRY_PASSWORD");
    expect(output.stderr).toEqual([]);

    const lock = await readFile(join(project, ".flow", "packages.lock.json"), "utf8");
    expect(lock).not.toContain("private-user");
    expect(lock).not.toContain("PRIVATE_REGISTRY_PASSWORD");

    const offlineAcquire = vi.fn().mockRejectedValue(new Error("PRIVATE_OFFLINE_NETWORK"));
    const offlineSecret = vi.fn().mockRejectedValue(new Error("PRIVATE_OFFLINE_SECRET"));
    const offlineDependencies = {
      ...dependencies(project, { fetch: offlineAcquire }),
      ociCapabilityRegistry: { acquire: offlineAcquire } satisfies StrictOciCapabilityRegistry,
      readRegistrySecret: offlineSecret,
    };
    expect(await main(["packages", "list"], captureIo().io, offlineDependencies)).toBe(0);
    expect(await main(["packages", "verify"], captureIo().io, offlineDependencies)).toBe(0);
    expect(offlineAcquire).not.toHaveBeenCalled();
    expect(offlineSecret).not.toHaveBeenCalled();
  });

  it("installs through the real private-registry and atomic-store composition", async () => {
    const project = await projectDirectory();
    const created = bundle();
    const signatureBundle = Buffer.from("PRIVATE_SIGNATURE_BUNDLE");
    const manifest = ociManifestBytes(created.content, signatureBundle);
    const manifestDigest = sha256Digest(manifest);
    const reference = `registry.example.test/flow/private-suite@${manifestDigest}`;
    const publisher = Object.freeze({
      certificateIssuer: "https://token.actions.githubusercontent.com/",
      certificateIdentity:
        "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/v1.0.0",
    });
    const closes: ReturnType<typeof vi.fn>[] = [];
    const requests: Array<{
      readonly url: string;
      readonly authorization: string | undefined;
    }> = [];
    let manifestReads = 0;
    const openPinnedResponse = vi.fn(async (request: PinnedHttpsRequest) => {
      const url = new URL(request.url);
      requests.push({
        url: request.url,
        authorization:
          request.sensitiveAuthorization?.toString("ascii") ?? request.headers.authorization,
      });
      if (url.hostname === "auth.example.test") {
        return pinnedResponse(Buffer.from('{"token":"PRIVATE_BEARER_TOKEN"}'), closes);
      }
      if (url.pathname.includes("/manifests/")) {
        manifestReads += 1;
        if (manifestReads === 1) {
          return pinnedResponse(Buffer.alloc(0), closes, 401, {
            "www-authenticate":
              'Bearer realm="https://auth.example.test/token",service="registry.example.test",scope="repository:flow/private-suite:pull"',
          });
        }
        return pinnedResponse(manifest, closes, 200, {
          "content-type": OCI_IMAGE_MANIFEST_MEDIA_TYPE,
          "docker-content-digest": manifestDigest,
        });
      }
      if (url.pathname.endsWith(sha256Digest(created.content))) {
        return pinnedResponse(created.content, closes);
      }
      if (url.pathname.endsWith(sha256Digest(signatureBundle))) {
        return pinnedResponse(signatureBundle, closes);
      }
      throw new Error(`unexpected private-registry URL ${request.url}`);
    });
    const registry = createStrictOciCapabilityRegistry({
      resolveHostname: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
      openPinnedResponse,
    });
    const password = Buffer.from("PRIVATE_REGISTRY_PASSWORD");
    const readRegistrySecret = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return password;
    });
    const output = captureIo();

    expect(
      await main(
        [
          "packages",
          "install-oci",
          reference,
          "--certificate-issuer",
          publisher.certificateIssuer,
          "--certificate-identity",
          publisher.certificateIdentity,
          "--username",
          "PRIVATE_USER",
          "--password-stdin",
        ],
        output.io,
        {
          ...dependencies(project, { fetch: vi.fn() }),
          ociCapabilityRegistry: registry,
          sigstoreCapabilityVerifier: {
            verify: vi.fn().mockReturnValue(publisher),
          } satisfies SigstoreCapabilityVerifier,
          readRegistrySecret,
        },
      ),
    ).toBe(0);

    const basic = `Basic ${Buffer.from("PRIVATE_USER:PRIVATE_REGISTRY_PASSWORD").toString("base64")}`;
    expect(requests.map(({ authorization }) => authorization)).toEqual([
      undefined,
      basic,
      "Bearer PRIVATE_BEARER_TOKEN",
      "Bearer PRIVATE_BEARER_TOKEN",
      "Bearer PRIVATE_BEARER_TOKEN",
    ]);
    expect(password.every((value) => value === 0)).toBe(true);
    expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
    const visible = `${output.stdout.join("\n")}\n${output.stderr.join("\n")}`;
    expect(visible).not.toContain("PRIVATE_USER");
    expect(visible).not.toContain("PRIVATE_REGISTRY_PASSWORD");
    expect(visible).not.toContain("PRIVATE_BEARER_TOKEN");
    const lock = await readFile(join(project, ".flow", "packages.lock.json"), "utf8");
    expect(lock).toContain(reference);
    expect(lock).toContain(publisher.certificateIdentity);
    expect(lock).not.toContain("auth.example.test");
    expect(lock).not.toContain("PRIVATE_USER");
    expect(lock).not.toContain("PRIVATE_REGISTRY_PASSWORD");
    expect(lock).not.toContain("PRIVATE_BEARER_TOKEN");
  });

  it.each([
    ["username without password input", ["--username", "PRIVATE_USER"]],
    ["password input without username", ["--password-stdin"]],
    [
      "duplicate password input",
      ["--username", "PRIVATE_USER", "--password-stdin", "--password-stdin"],
    ],
    [
      "password value on the command line",
      ["--username", "PRIVATE_USER", "--password-stdin=PRIVATE_PASSWORD"],
    ],
  ] as const)("rejects %s before registry or secret access", async (_name, credentialArgs) => {
    const project = await projectDirectory();
    const acquire = vi.fn();
    const readRegistrySecret = vi.fn();
    const output = captureIo();

    expect(
      await main(
        [
          "packages",
          "install-oci",
          `registry.example.test/flow/review-suite@sha256:${"3".repeat(64)}`,
          "--certificate-issuer",
          "https://token.actions.githubusercontent.com/",
          "--certificate-identity",
          "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/v1.0.0",
          ...credentialArgs,
        ],
        output.io,
        {
          ...dependencies(project, { fetch: vi.fn() }),
          ociCapabilityRegistry: { acquire } satisfies StrictOciCapabilityRegistry,
          readRegistrySecret,
        },
      ),
    ).toBe(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(readRegistrySecret).not.toHaveBeenCalled();
    expect(output.stderr.join("\n")).not.toContain("PRIVATE_PASSWORD");
  });

  it.each([
    [
      "install",
      ["install", "https://packages.example.test/review.flowpkg", "--sha256", "a".repeat(64)],
    ],
    ["pack", ["pack", "source", "--output", "bundle.flowpkg"]],
    ["list", ["list"]],
    ["verify", ["verify"]],
    ["inspect", ["inspect", "review-suite", "--version", "1.0.0"]],
    ["remove", ["remove", "review-suite", "--version", "1.0.0"]],
  ] as const)("rejects private credential flags on packages %s", async (_name, commandArgs) => {
    const project = await projectDirectory();
    const acquire = vi.fn();
    const readRegistrySecret = vi.fn();
    const output = captureIo();

    expect(
      await main(
        ["packages", ...commandArgs, "--username", "PRIVATE_USER", "--password-stdin"],
        output.io,
        {
          ...dependencies(project, { fetch: vi.fn() }),
          ociCapabilityRegistry: { acquire } satisfies StrictOciCapabilityRegistry,
          readRegistrySecret,
        },
      ),
    ).toBe(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(readRegistrySecret).not.toHaveBeenCalled();
    expect(output.stderr.join("\n")).not.toContain("PRIVATE_USER");
  });

  it.each([
    ["space", ["--username", "PRIVATE USER", "--password-stdin"]],
    ["colon", ["--username", "PRIVATE:USER", "--password-stdin"]],
    ["newline", ["--username", "PRIVATE\nUSER", "--password-stdin"]],
    ["non-ASCII", ["--username", "privaté", "--password-stdin"]],
    ["excess length", ["--username", "P".repeat(257), "--password-stdin"]],
    [
      "duplicate username",
      ["--username", "PRIVATE_ONE", "--username", "PRIVATE_TWO", "--password-stdin"],
    ],
  ] as const)("rejects an invalid private registry %s before acquisition", async (_name, args) => {
    const project = await projectDirectory();
    const acquire = vi.fn();
    const readRegistrySecret = vi.fn();
    const output = captureIo();

    expect(
      await main(
        [
          "packages",
          "install-oci",
          `registry.example.test/flow/review-suite@sha256:${"4".repeat(64)}`,
          "--certificate-issuer",
          "https://token.actions.githubusercontent.com/",
          "--certificate-identity",
          "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/v1.0.0",
          ...args,
        ],
        output.io,
        {
          ...dependencies(project, { fetch: vi.fn() }),
          ociCapabilityRegistry: { acquire } satisfies StrictOciCapabilityRegistry,
          readRegistrySecret,
        },
      ),
    ).toBe(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(readRegistrySecret).not.toHaveBeenCalled();
    expect(output.stderr.join("\n")).not.toContain("PRIVATE");
    expect(output.stderr.join("\n")).not.toContain("privaté");
  });

  it("reports a typed digest rejection without publishing state", async () => {
    const project = await projectDirectory();
    const created = bundle();
    const output = captureIo();

    expect(
      await main(
        [
          "packages",
          "install",
          "https://packages.example.test/review-suite-1.0.0.flowpkg",
          "--sha256",
          "0".repeat(64),
        ],
        output.io,
        dependencies(project, { fetch: vi.fn().mockResolvedValue(created.content) }),
      ),
    ).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/^invalid_bundle:.*digest mismatch/i);
    const listed = captureIo();
    expect(
      await main(["packages", "list"], listed.io, dependencies(project, { fetch: vi.fn() })),
    ).toBe(0);
    expect(JSON.parse(listed.stdout[0] ?? "null")).toMatchObject({ bundles: [] });
  });

  it.each(["abc", "A".repeat(64), `${"0".repeat(64)}00`])(
    "rejects malformed digest pin %s without making a network request",
    async (sha256) => {
      const project = await projectDirectory();
      const fetch = vi.fn();
      const output = captureIo();

      expect(
        await main(
          [
            "packages",
            "install",
            "https://packages.example.test/review-suite-1.0.0.flowpkg",
            "--sha256",
            sha256,
          ],
          output.io,
          dependencies(project, { fetch }),
        ),
      ).toBe(1);
      expect(output.stderr.join("\n")).toMatch(/^invalid_bundle:.*64 lowercase hexadecimal/i);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("packs the same strict source tree into deterministic bundle bytes", async () => {
    const project = await projectDirectory();
    const source = join(project, "review-source");
    await writeBundleSource(source);
    await writeWorkflowBundlePackage(source);
    await writePolicyBundlePackage(source);
    await writePresentationBundlePackage(source);
    const first = join(project, "review-a.flowpkg");
    const second = join(project, "review-b.flowpkg");
    const firstOutput = captureIo();
    const secondOutput = captureIo();
    const capabilityBundleFetcher = { fetch: vi.fn() } as CapabilityBundleFetcher;

    expect(
      await main(
        ["packages", "pack", source, "--output", first],
        firstOutput.io,
        dependencies(project, capabilityBundleFetcher),
      ),
    ).toBe(0);
    expect(
      await main(
        ["packages", "pack", source, "--output", second],
        secondOutput.io,
        dependencies(project, capabilityBundleFetcher),
      ),
    ).toBe(0);

    const firstBytes = await readFile(first);
    await expect(readFile(second)).resolves.toEqual(firstBytes);
    expect(parseCapabilityBundle(firstBytes)).toMatchObject({
      name: "review-suite",
      version: "1.0.0",
      packages: [
        { kind: "policy-package", name: "restricted-review", version: "1.0.0" },
        { kind: "presentation-package", name: "operations", version: "1.0.0" },
        { kind: "verifier-package", name: "evidence-review", version: "1.2.0" },
        { kind: "workflow-package", name: "release-check", version: "1.0.0" },
      ],
    });
    expect(JSON.parse(firstOutput.stdout[0] ?? "null")).toMatchObject({
      status: "packed",
      name: "review-suite",
      version: "1.0.0",
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      bytes: firstBytes.byteLength,
    });
    expect(capabilityBundleFetcher.fetch).not.toHaveBeenCalled();
  });

  it("rejects a symlinked pack source without creating output", async () => {
    const project = await projectDirectory();
    const source = join(project, "unsafe-source");
    await writeBundleSource(source);
    const outside = join(project, "outside.yaml");
    await writeFile(outside, verifierManifest());
    const manifest = join(source, "verifiers", "evidence-review", "VERIFIER.yaml");
    await rm(manifest);
    await symlink(outside, manifest);
    const outputPath = join(project, "unsafe.flowpkg");
    const output = captureIo();

    expect(
      await main(
        ["packages", "pack", source, "--output", outputPath],
        output.io,
        dependencies(project, { fetch: vi.fn() }),
      ),
    ).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/unsafe|symbolic link/i);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an in-place same-size source rewrite during capture", async () => {
    const project = await projectDirectory();
    const source = join(project, "racing-source");
    await writeBundleSource(source);
    const replacement = verifierManifest().replace("Reject", "Review");

    await expect(
      packCapabilityBundleDirectory(source, join(project, "racing.flowpkg"), {
        afterSourceFileOpened: async (path) => {
          if (path.endsWith("/verifiers/evidence-review/VERIFIER.yaml")) {
            await writeFile(path, replacement);
          }
        },
      }),
    ).rejects.toMatchObject({ code: "unsafe_source" });
  });

  it("stops at the capability package count limit", async () => {
    const project = await projectDirectory();
    const source = join(project, "oversized-source");
    await writeBundleSource(source);
    await rm(join(source, "verifiers"), { recursive: true });
    for (let index = 0; index < 33; index += 1) {
      const name = `review-${index.toString().padStart(2, "0")}`;
      const directory = join(source, "verifiers", name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "VERIFIER.yaml"), verifierManifest(name));
    }
    const output = captureIo();

    expect(
      await main(
        ["packages", "pack", source, "--output", join(project, "oversized.flowpkg")],
        output.io,
        dependencies(project, { fetch: vi.fn() }),
      ),
    ).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/^limit_exceeded:/);
  });

  it.each(["beforeOutputTemporaryUnlink", "beforeOutputDirectorySync"] as const)(
    "reports commit-uncertain when output is visible at %s failure",
    async (failurePoint) => {
      const project = await projectDirectory();
      const source = join(project, "uncertain-source");
      const outputPath = join(project, `${failurePoint}.flowpkg`);
      await writeBundleSource(source);

      await expect(
        packCapabilityBundleDirectory(source, outputPath, {
          [failurePoint]: async () => {
            throw new Error(`injected ${failurePoint} failure`);
          },
        }),
      ).rejects.toMatchObject({ code: "commit_uncertain" });
      await expect(readFile(outputPath)).resolves.toSatisfy(
        (content: Buffer) => parseCapabilityBundle(content).name === "review-suite",
      );
    },
  );

  it("bounds a source file that grows after it is opened", async () => {
    const project = await projectDirectory();
    const source = join(project, "growing-source");
    const outputPath = join(project, "growing.flowpkg");
    await writeBundleSource(source);

    await expect(
      packCapabilityBundleDirectory(source, outputPath, {
        afterSourceFileOpened: async (path) => {
          if (path.endsWith("/VERIFIER.yaml")) {
            await writeFile(path, Buffer.alloc(MAX_VERIFIER_PACKAGE_MANIFEST_BYTES + 1, 0x61));
          }
        },
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains only exact captured bytes for tiny source files", async () => {
    const project = await projectDirectory();
    const source = join(project, "exact-buffer-source");
    await writeBundleSource(source);
    const retained: Array<{ readonly bytes: number; readonly backingBytes: number }> = [];

    await packCapabilityBundleDirectory(source, join(project, "exact-buffer.flowpkg"), {
      afterSourceFileCaptured: async (_path, content) => {
        retained.push({ bytes: content.byteLength, backingBytes: content.buffer.byteLength });
      },
    });

    expect(retained.length).toBeGreaterThan(0);
    expect(retained.every((item) => item.bytes === item.backingBytes)).toBe(true);
  });

  it("accepts exactly 4,096 source entries and rejects entry 4,097", async () => {
    const project = await projectDirectory();
    const source = join(project, "entry-boundary-source");
    await writeSkillBundleSource(source);
    const skillRoot = join(source, "skills", "review-skill");
    await createEmptyDirectories(skillRoot, 4_092);

    await expect(
      packCapabilityBundleDirectory(source, join(project, "entry-boundary.flowpkg")),
    ).resolves.toMatchObject({ bundle: { packages: [{ kind: "agent-skill" }] } });

    await mkdir(join(skillRoot, "empty-4092"));
    await expect(
      packCapabilityBundleDirectory(source, join(project, "entry-overflow.flowpkg")),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  }, 15_000);
});

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-packages-cli-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, ".flow"));
  return directory;
}

function bundle(name = "review-suite", description = "Review capabilities.") {
  return createCapabilityBundleSource({
    name,
    version: "1.0.0",
    description,
    packages: [
      { kind: "verifier-package", manifest: Buffer.from(verifierManifest()) },
      { kind: "policy-package", manifest: Buffer.from(policyManifest()) },
    ],
  });
}

function sha256Digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function ociManifestBytes(bundleBytes: Buffer, sigstoreBytes: Buffer): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      artifactType: FLOW_CAPABILITY_ARTIFACT_TYPE,
      config: {
        mediaType: OCI_EMPTY_CONFIG_MEDIA_TYPE,
        digest: OCI_EMPTY_CONFIG_DIGEST,
        size: 2,
      },
      layers: [
        {
          mediaType: FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
          digest: sha256Digest(bundleBytes),
          size: bundleBytes.byteLength,
        },
        {
          mediaType: SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
          digest: sha256Digest(sigstoreBytes),
          size: sigstoreBytes.byteLength,
        },
      ],
    }),
  );
}

function pinnedResponse(
  content: Buffer,
  closes: ReturnType<typeof vi.fn>[],
  statusCode = 200,
  headers: Readonly<Record<string, string>> = {},
): PinnedHttpsResponse {
  const close = vi.fn();
  closes.push(close);
  return {
    statusCode,
    headers: { "content-length": String(content.byteLength), ...headers },
    body: responseChunks(content),
    close,
  };
}

async function* responseChunks(content: Buffer): AsyncIterable<Uint8Array> {
  yield content;
}

function verifierManifest(name = "evidence-review"): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: ${name}
  version: 1.2.0
  description: Review declared evidence.
spec:
  kind: model
  prompt: Reject unsupported claims.
`;
}

function policyManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: restricted-review
  version: 1.0.0
  description: Restrict review workflows.
spec:
  tools:
    allowed: [read]
`;
}

async function writeBundleSource(source: string): Promise<void> {
  await mkdir(join(source, "verifiers", "evidence-review"), { recursive: true });
  await writeFile(
    join(source, "BUNDLE.json"),
    `${JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityBundleSource",
      metadata: {
        name: "review-suite",
        version: "1.0.0",
        description: "Review capabilities.",
        license: "Apache-2.0",
      },
    })}\n`,
  );
  await writeFile(
    join(source, "verifiers", "evidence-review", "VERIFIER.yaml"),
    verifierManifest(),
  );
}

async function writeSkillBundleSource(source: string): Promise<void> {
  const skillRoot = join(source, "skills", "review-skill");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(source, "BUNDLE.json"),
    `${JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityBundleSource",
      metadata: {
        name: "review-suite",
        version: "1.0.0",
        description: "Review capabilities.",
      },
    })}\n`,
  );
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: review-skill\ndescription: Review evidence.\n---\n\n# Review\n",
  );
}

async function writeWorkflowBundlePackage(source: string): Promise<void> {
  const workflowRoot = join(source, "workflows", "release-check");
  await mkdir(workflowRoot, { recursive: true });
  await writeFile(
    join(workflowRoot, "WORKFLOW.yaml"),
    `apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata:
  name: release-check
  version: 1.0.0
  description: Run the release gate.
spec:
  workflow: |-
    apiVersion: flow.synapti.ai/v1alpha1
    kind: Workflow
    metadata: { id: release-check }
    nodes:
      - id: check
        type: command
        command: { executable: /usr/bin/true }
`,
  );
}

async function writePolicyBundlePackage(source: string): Promise<void> {
  const policyRoot = join(source, "policies", "restricted-review");
  await mkdir(policyRoot, { recursive: true });
  await writeFile(join(policyRoot, "POLICY.yaml"), policyManifest());
}

async function writePresentationBundlePackage(source: string): Promise<void> {
  const presentationRoot = join(source, "presentations", "operations");
  await mkdir(presentationRoot, { recursive: true });
  await writeFile(join(presentationRoot, "PRESENTATION.yaml"), presentationManifest());
}

function presentationManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PresentationPackage
metadata: { name: operations, version: 1.0.0, description: Operator layout }
spec:
  messages:
    - version: v0.9
      createSurface: { surfaceId: flow-run, catalogId: https://flow.synapti.ai/a2ui/catalogs/run-presentation/v1 }
    - version: v0.9
      updateComponents:
        surfaceId: flow-run
        components:
          - { id: root, component: FlowLayout, density: compact, children: [group-1] }
          - { id: group-1, component: FlowGroup, variant: stack, children: [run-summary, graph-progress, node-table, resource-facts, pending-approvals, outcome-notice] }
          - { id: run-summary, component: FlowRunSummary }
          - { id: graph-progress, component: FlowGraphProgress }
          - { id: node-table, component: FlowNodeTable }
          - { id: resource-facts, component: FlowResourceFacts }
          - { id: pending-approvals, component: FlowPendingApprovals }
          - { id: outcome-notice, component: FlowOutcomeNotice }
`;
}

async function createEmptyDirectories(root: string, count: number): Promise<void> {
  const batchSize = 256;
  for (let start = 0; start < count; start += batchSize) {
    await Promise.all(
      Array.from({ length: Math.min(batchSize, count - start) }, async (_, offset) =>
        mkdir(join(root, `empty-${(start + offset).toString().padStart(4, "0")}`)),
      ),
    );
  }
}

function dependencies(project: string, capabilityBundleFetcher: CapabilityBundleFetcher) {
  return {
    cwd: project,
    loadConfig: async () => effectiveConfig(project),
    capabilityBundleFetcher,
  };
}

function effectiveConfig(projectRoot: string): EffectiveFlowConfig {
  const supervisor = { ...BUILT_IN_FLOW_CONFIG };
  return {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
    sandbox: { profile: "native" },
    policyDigest: calculateFlowPolicyDigest(supervisor),
    projectRoot,
    sources: {
      builtIn: BUILT_IN_FLOW_CONFIG,
      operator: null,
      project: { path: join(projectRoot, ".flow", "config.yaml"), values: {} },
    },
  };
}

function captureIo(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}
