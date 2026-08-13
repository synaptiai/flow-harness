import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type CliIo, main } from "../../../src/cli/main.js";
import {
  createCapabilityBundleSource,
  parseCapabilityBundle,
} from "../../../src/domain/capability/capability-bundles.js";
import {
  FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
  SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
} from "../../../src/domain/capability/oci-capability-artifacts.js";
import type { SigstoreCapabilityVerifier } from "../../../src/domain/capability/sigstore-capability-verifier.js";
import { MAX_VERIFIER_PACKAGE_MANIFEST_BYTES } from "../../../src/domain/capability/verifier-packages.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import { packCapabilityBundleDirectory } from "../../../src/infrastructure/fs/capability-bundle-packer.js";
import type { CapabilityBundleFetcher } from "../../../src/infrastructure/http/strict-capability-bundle-fetcher.js";
import type {
  AcquiredOciCapabilityArtifact,
  StrictOciCapabilityRegistry,
} from "../../../src/infrastructure/http/strict-oci-capability-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("capability package CLI", () => {
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
      packages: [{ kind: "verifier-package", name: "evidence-review", version: "1.2.0" }],
    });
    expect(JSON.parse(listed.stdout[0] ?? "null")).toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0", digest: `sha256:${sha256}` }],
    });
    expect(JSON.parse(inspected.stdout[0] ?? "null")).toMatchObject({
      valid: true,
      name: "review-suite",
      version: "1.0.0",
      packages: [{ kind: "verifier-package", name: "evidence-review", version: "1.2.0" }],
    });
    expect(inspected.stdout.join("\n")).not.toContain("manifestBase64");
    expect(inspected.stdout.join("\n")).not.toContain("Reject unsupported claims");
    expect(JSON.parse(verified.stdout[0] ?? "null")).toEqual({
      valid: true,
      bundles: 1,
      packages: 1,
    });
    expect(JSON.parse(removed.stdout[0] ?? "null")).toMatchObject({
      status: "removed",
      cleanup: "deleted",
      name: "review-suite",
      version: "1.0.0",
    });
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
    const verifyPublisher = vi.fn().mockReturnValue(publisher);
    const networkTrap = vi.fn().mockRejectedValue(new Error("network must remain offline"));
    const cliDependencies = {
      ...dependencies(project, { fetch: networkTrap }),
      ociCapabilityRegistry: { acquire } satisfies StrictOciCapabilityRegistry,
      sigstoreCapabilityVerifier: {
        verify: verifyPublisher,
      } satisfies SigstoreCapabilityVerifier,
    };
    const installed = captureIo();
    const listed = captureIo();
    const verified = captureIo();

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

    expect(acquire).toHaveBeenCalledOnce();
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
      packages: 1,
    });
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

function bundle() {
  return createCapabilityBundleSource({
    name: "review-suite",
    version: "1.0.0",
    description: "Review capabilities.",
    packages: [{ kind: "verifier-package", manifest: Buffer.from(verifierManifest()) }],
  });
}

function sha256Digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
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
  await writeFile(
    join(policyRoot, "POLICY.yaml"),
    `apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: restricted-review
  version: 1.0.0
  description: Restrict review workflows.
spec:
  tools:
    allowed: [read]
`,
  );
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
