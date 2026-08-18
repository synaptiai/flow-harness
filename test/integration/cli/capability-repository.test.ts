import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type CliIo, main } from "../../../src/cli/main.js";
import { createCapabilityBundleSource } from "../../../src/domain/capability/capability-bundles.js";
import { parseCapabilityMetadata } from "../../../src/domain/capability/capability-metadata.js";
import { encodeCapabilityRepositoryIndex } from "../../../src/domain/capability/capability-repository.js";
import { encodeSignedCapabilityBundleEnvelope } from "../../../src/domain/capability/signed-capability-bundle-envelope.js";
import type { SigstoreCapabilityVerifier } from "../../../src/domain/capability/sigstore-capability-verifier.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import { LocalCapabilityPackageStore } from "../../../src/infrastructure/fs/local-capability-package-store.js";
import type { StrictCapabilityRepositoryFetcher } from "../../../src/infrastructure/http/strict-capability-repository-fetcher.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("capability repository CLI", () => {
  it("initializes one explicit trusted root offline and reports content-free status", async () => {
    const project = await projectDirectory();
    const rootPath = join(project, "PRIVATE_TRUSTED_ROOT.json");
    const root = trustedRoot();
    await writeFile(rootPath, root, { mode: 0o600 });
    const dependencies = {
      cwd: project,
      loadConfig: async () => effectiveConfig(project),
      sigstoreCapabilityVerifier: {
        verify: vi.fn(),
      } satisfies SigstoreCapabilityVerifier,
    };
    const before = captureIo();
    const initialized = captureIo();
    const after = captureIo();

    expect(await main(["packages", "repository", "status"], before.io, dependencies)).toBe(0);
    expect(JSON.parse(before.stdout[0] ?? "null")).toEqual({ repository: null });

    expect(
      await main(
        [
          "packages",
          "repository",
          "init",
          "https://updates.example.test/repository/",
          "--trusted-root",
          rootPath,
        ],
        initialized.io,
        dependencies,
      ),
    ).toBe(0);
    const initializedOutput = initialized.stdout[0] ?? "";
    expect(JSON.parse(initializedOutput)).toMatchObject({
      status: "initialized",
      repository: {
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityRepositoryState",
        status: "initialized",
        candidates: [],
      },
    });

    expect(await main(["packages", "repository", "status"], after.io, dependencies)).toBe(0);
    expect(JSON.parse(after.stdout[0] ?? "null")).toMatchObject({
      repository: { status: "initialized", candidates: [] },
    });
    const publicOutput = `${initializedOutput}\n${after.stdout.join("\n")}\n${initialized.stderr.join("\n")}`;
    expect(publicOutput).not.toContain("updates.example.test");
    expect(publicOutput).not.toContain("PRIVATE_TRUSTED_ROOT");
    expect(publicOutput).not.toContain(root.toString("base64"));
  });

  it("checks, reviews, activates offline, and removes one repository candidate", async () => {
    const project = await projectDirectory();
    const fixture = repositoryFixture();
    const rootPath = join(project, "trusted-root.json");
    await writeFile(rootPath, fixture.root, { mode: 0o600 });
    const read = vi.fn<StrictCapabilityRepositoryFetcher["read"]>(
      async (url, maximumBytes, signal) => {
        signal.throwIfAborted();
        const content = fixture.remote.get(url);
        return content === undefined
          ? { statusCode: 404, bytes: Buffer.alloc(0) }
          : {
              statusCode: 200,
              bytes:
                content.byteLength <= maximumBytes
                  ? Buffer.from(content)
                  : Buffer.alloc(maximumBytes + 1),
            };
      },
    );
    const dependencies = {
      cwd: project,
      loadConfig: async () => effectiveConfig(project),
      capabilityRepositoryFetcher: { read } satisfies StrictCapabilityRepositoryFetcher,
      sigstoreCapabilityVerifier: {
        verify: vi.fn(() => ({ ...fixture.publisher })),
      } satisfies SigstoreCapabilityVerifier,
    };
    const initialized = captureIo();
    const checked = captureIo();
    const listed = captureIo();
    const inspected = captureIo();
    const activated = captureIo();
    const removed = captureIo();

    expect(
      await main(
        ["packages", "repository", "init", fixture.repositoryBaseUrl, "--trusted-root", rootPath],
        initialized.io,
        dependencies,
      ),
    ).toBe(0);
    expect(await main(["packages", "repository", "check"], checked.io, dependencies)).toBe(0);
    expect(
      await main(["packages", "repository", "candidates", "list"], listed.io, dependencies),
    ).toBe(0);
    const candidates = JSON.parse(listed.stdout[0] ?? "null") as {
      candidates: readonly { candidateDigest: string }[];
    };
    const candidateDigest = candidates.candidates[0]?.candidateDigest;
    expect(candidateDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    if (candidateDigest === undefined) {
      throw new Error("repository check did not stage one candidate");
    }
    expect(
      await main(
        ["packages", "repository", "candidate", "inspect", candidateDigest],
        inspected.io,
        dependencies,
      ),
    ).toBe(0);
    const privateInspection = inspected.stdout.join("\n");
    expect(privateInspection).not.toContain(fixture.targetSource);
    expect(privateInspection).not.toContain(fixture.envelope.toString("base64"));
    expect(privateInspection).not.toContain("contentBase64");

    await new LocalCapabilityPackageStore(project, {
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    }).refreshMetadata({
      metadata: fixture.activeMetadata,
      authority: {
        kind: "sigstore-keyless-v0.3",
        ...fixture.publisher,
        signatureBundleDigest: `sha256:${"f".repeat(64)}`,
      },
    });
    const networkCallsAfterCheck = read.mock.calls.length;
    expect(
      await main(
        [
          "packages",
          "repository",
          "candidate",
          "activate",
          candidateDigest,
          "--certificate-issuer",
          fixture.publisher.certificateIssuer,
          "--certificate-identity",
          fixture.publisher.certificateIdentity,
        ],
        activated.io,
        dependencies,
      ),
    ).toBe(0);
    expect(read).toHaveBeenCalledTimes(networkCallsAfterCheck);
    await expect(new LocalCapabilityPackageStore(project).list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0", source: fixture.targetSource }],
    });

    expect(
      await main(
        ["packages", "repository", "candidate", "remove", candidateDigest],
        removed.io,
        dependencies,
      ),
    ).toBe(0);
    await expect(new LocalCapabilityPackageStore(project).list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0" }],
    });
  });

  it("replaces an established bundle from one reviewed candidate and repeats offline", async () => {
    const project = await projectDirectory();
    const fixture = repositoryFixture();
    const rootPath = join(project, "trusted-root.json");
    await writeFile(rootPath, fixture.root, { mode: 0o600 });
    const read = vi.fn<StrictCapabilityRepositoryFetcher["read"]>(
      async (url, maximumBytes, signal) => {
        signal.throwIfAborted();
        const content = fixture.remote.get(url);
        return content === undefined
          ? { statusCode: 404, bytes: Buffer.alloc(0) }
          : {
              statusCode: 200,
              bytes:
                content.byteLength <= maximumBytes
                  ? Buffer.from(content)
                  : Buffer.alloc(maximumBytes + 1),
            };
      },
    );
    const dependencies = {
      cwd: project,
      loadConfig: async () => effectiveConfig(project),
      capabilityRepositoryFetcher: { read } satisfies StrictCapabilityRepositoryFetcher,
      sigstoreCapabilityVerifier: {
        verify: vi.fn(() => ({ ...fixture.publisher })),
      } satisfies SigstoreCapabilityVerifier,
    };
    const current = createCapabilityBundleSource({
      name: "review-suite",
      version: "0.9.0",
      description: "Review capabilities.",
      packages: [
        {
          kind: "verifier-package",
          manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review
  version: 1.0.0
  description: Review evidence.
spec:
  kind: model
  prompt: Review original evidence.
`),
        },
      ],
    });
    const currentSource = "https://packages.example.test/review-suite-0.9.0.flowpkg";
    const packageStore = new LocalCapabilityPackageStore(project, {
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });
    await packageStore.refreshMetadata({
      metadata: activeMetadata({
        content: current.content,
        version: "0.9.0",
        source: currentSource,
        publisher: fixture.publisher,
        metadataVersion: 1,
      }),
      authority: {
        kind: "sigstore-keyless-v0.3",
        ...fixture.publisher,
        signatureBundleDigest: `sha256:${"e".repeat(64)}`,
      },
    });
    await packageStore.install({
      source: currentSource,
      expectedSha256: sha256(current.content),
      content: current.content,
      publisher: {
        kind: "sigstore-keyless-v0.3",
        ...fixture.publisher,
        signatureBundleDigest: `sha256:${"d".repeat(64)}`,
      },
    });
    expect(
      await main(
        ["packages", "repository", "init", fixture.repositoryBaseUrl, "--trusted-root", rootPath],
        captureIo().io,
        dependencies,
      ),
    ).toBe(0);
    expect(await main(["packages", "repository", "check"], captureIo().io, dependencies)).toBe(0);
    const candidatesIo = captureIo();
    expect(
      await main(["packages", "repository", "candidates", "list"], candidatesIo.io, dependencies),
    ).toBe(0);
    const candidateDigest = (
      JSON.parse(candidatesIo.stdout[0] ?? "null") as {
        candidates: readonly { candidateDigest: string }[];
      }
    ).candidates[0]?.candidateDigest;
    if (candidateDigest === undefined) {
      throw new Error("repository check did not stage one replacement candidate");
    }
    await packageStore.refreshMetadata({
      metadata: activeMetadata({
        content: fixture.envelopeCapabilityBundle,
        version: "1.0.0",
        source: fixture.targetSource,
        publisher: fixture.publisher,
        metadataVersion: 2,
        prior: {
          content: current.content,
          version: "0.9.0",
          source: currentSource,
        },
      }),
      authority: {
        kind: "sigstore-keyless-v0.3",
        ...fixture.publisher,
        signatureBundleDigest: `sha256:${"f".repeat(64)}`,
      },
    });
    const networkCallsAfterCheck = read.mock.calls.length;
    const replacement = captureIo();
    const command = [
      "packages",
      "repository",
      "candidate",
      "replace",
      candidateDigest,
      "--from-version",
      "0.9.0",
      "--certificate-issuer",
      fixture.publisher.certificateIssuer,
      "--certificate-identity",
      fixture.publisher.certificateIdentity,
    ];

    expect(await main(command, replacement.io, dependencies)).toBe(0);
    expect(JSON.parse(replacement.stdout[0] ?? "null")).toMatchObject({
      status: "replaced",
      candidateDigest,
      cleanup: "retained",
      bundle: { name: "review-suite", version: "1.0.0" },
      publisher: fixture.publisher,
      previous: { name: "review-suite", version: "0.9.0" },
    });
    const repeated = captureIo();
    expect(await main(command, repeated.io, dependencies)).toBe(0);
    expect(JSON.parse(repeated.stdout[0] ?? "null")).toMatchObject({
      status: "already_current",
      candidateDigest,
      bundle: { name: "review-suite", version: "1.0.0" },
      publisher: fixture.publisher,
    });
    expect(read).toHaveBeenCalledTimes(networkCallsAfterCheck);
    await expect(packageStore.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.0" }],
    });
    const publicOutput = `${replacement.stdout.join("\n")}\n${repeated.stdout.join("\n")}`;
    expect(publicOutput).not.toContain(fixture.targetSource);
    expect(publicOutput).not.toContain(fixture.envelope.toString("base64"));
    expect(publicOutput).not.toContain("signatureBundleDigest");
    expect(publicOutput).not.toContain("PRIVATE_SIGSTORE_BUNDLE");
  });

  it("watches one established bundle with the default interval and patch policy", async () => {
    const project = await projectDirectory();
    const fixture = repositoryFixture({ version: "1.0.1" });
    const rootPath = join(project, "trusted-root.json");
    await writeFile(rootPath, fixture.root, { mode: 0o600 });
    const read = vi.fn<StrictCapabilityRepositoryFetcher["read"]>(
      async (url, maximumBytes, signal) => {
        signal.throwIfAborted();
        const content = fixture.remote.get(url);
        return content === undefined
          ? { statusCode: 404, bytes: Buffer.alloc(0) }
          : {
              statusCode: 200,
              bytes:
                content.byteLength <= maximumBytes
                  ? Buffer.from(content)
                  : Buffer.alloc(maximumBytes + 1),
            };
      },
    );
    const controller = new AbortController();
    const stopReason = new Error("stop watcher after one settled cycle");
    const clock = sequenceClock([
      "2027-01-01T00:00:00.000Z",
      "2027-01-01T00:01:00.000Z",
      "2027-01-01T00:01:01.000Z",
    ]);
    const dependencies = {
      cwd: project,
      loadConfig: async () => effectiveConfig(project),
      capabilityRepositoryFetcher: { read } satisfies StrictCapabilityRepositoryFetcher,
      sigstoreCapabilityVerifier: {
        verify: vi.fn(() => ({ ...fixture.publisher })),
      } satisfies SigstoreCapabilityVerifier,
      capabilityRepositoryWatcherNow: clock,
      capabilityRepositoryWatcherWait: vi.fn().mockResolvedValue(undefined),
      signal: controller.signal,
    };
    const current = createCapabilityBundleSource({
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
  description: Review evidence.
spec:
  kind: model
  prompt: Review evidence.
`),
        },
      ],
    });
    const currentSource = "https://packages.example.test/review-suite-1.0.0.flowpkg";
    const packageStore = new LocalCapabilityPackageStore(project, {
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });
    await packageStore.refreshMetadata({
      metadata: activeMetadata({
        content: fixture.envelopeCapabilityBundle,
        version: "1.0.1",
        source: fixture.targetSource,
        publisher: fixture.publisher,
        metadataVersion: 1,
        prior: { content: current.content, version: "1.0.0", source: currentSource },
      }),
      authority: {
        kind: "sigstore-keyless-v0.3",
        ...fixture.publisher,
        signatureBundleDigest: `sha256:${"f".repeat(64)}`,
      },
    });
    await packageStore.install({
      source: currentSource,
      expectedSha256: sha256(current.content),
      content: current.content,
      publisher: {
        kind: "sigstore-keyless-v0.3",
        ...fixture.publisher,
        signatureBundleDigest: `sha256:${"d".repeat(64)}`,
      },
    });
    expect(
      await main(
        ["packages", "repository", "init", fixture.repositoryBaseUrl, "--trusted-root", rootPath],
        captureIo().io,
        dependencies,
      ),
    ).toBe(0);
    const output = captureIo();
    const watcherIo: CliIo = {
      stdout: (text) => {
        output.stdout.push(text);
        const status = JSON.parse(text) as { kind?: string; outcome?: string };
        if (status.kind === "scheduler" && status.outcome === "checked") {
          controller.abort(stopReason);
        }
      },
      stderr: output.io.stderr,
    };

    expect(
      await main(
        [
          "packages",
          "repository",
          "watch",
          "review-suite",
          "--certificate-issuer",
          fixture.publisher.certificateIssuer,
          "--certificate-identity",
          fixture.publisher.certificateIdentity,
        ],
        watcherIo,
        dependencies,
      ),
    ).toBe(1);

    expect(dependencies.capabilityRepositoryWatcherWait).toHaveBeenCalledWith(
      60 * 60 * 1_000,
      controller.signal,
    );
    expect(output.stdout.map((entry) => JSON.parse(entry))).toMatchObject([
      { kind: "scheduler", outcome: "scheduler_started" },
      {
        kind: "reconciliation",
        outcome: "replaced",
        package: { name: "review-suite", previousVersion: "1.0.0", version: "1.0.1" },
        cleanup: "retained",
      },
      { kind: "scheduler", outcome: "checked" },
    ]);
    expect(output.stderr).toEqual([stopReason.message]);
    await expect(packageStore.list()).resolves.toMatchObject({
      bundles: [{ name: "review-suite", version: "1.0.1" }],
    });
    await expect(
      readFile(join(project, ".flow", "capability.repository", "watcher.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const publicOutput = `${output.stdout.join("\n")}\n${output.stderr.join("\n")}`;
    expect(publicOutput).not.toContain(fixture.targetSource);
    expect(publicOutput).not.toContain("PRIVATE_SIGSTORE_BUNDLE");
  });

  it.each([
    {
      label: "a missing current version",
      args: ["replace", `sha256:${"1".repeat(64)}`],
    },
    {
      label: "a repeated current version",
      args: [
        "replace",
        `sha256:${"1".repeat(64)}`,
        "--from-version",
        "1.0.0",
        "--from-version",
        "PRIVATE_DUPLICATE",
      ],
    },
    {
      label: "a non-semantic current version",
      args: ["replace", `sha256:${"1".repeat(64)}`, "--from-version", "PRIVATE_LATEST"],
    },
    {
      label: "a replacement version on activation",
      args: ["activate", `sha256:${"1".repeat(64)}`, "--from-version", "PRIVATE_MISPLACED"],
    },
  ])("rejects $label before repository access", async ({ args }) => {
    const project = await projectDirectory();
    const loadConfig = vi.fn(async () => effectiveConfig(project));
    const output = captureIo();

    expect(
      await main(
        [
          "packages",
          "repository",
          "candidate",
          ...args,
          "--certificate-issuer",
          "https://token.actions.githubusercontent.com/",
          "--certificate-identity",
          "PRIVATE_IDENTITY",
        ],
        output.io,
        { cwd: project, loadConfig },
      ),
    ).toBe(2);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(`${output.stdout.join("\n")}\n${output.stderr.join("\n")}`).not.toContain("PRIVATE_");
  });

  it.each([
    {
      label: "a missing publisher",
      args: ["repository", "watch", "review-suite", "--interval-ms", "60000"],
    },
    {
      label: "an interval below the bound",
      args: [
        "repository",
        "watch",
        "review-suite",
        "--interval-ms",
        "59999",
        "--certificate-issuer",
        "https://issuer.example.test/",
        "--certificate-identity",
        "PRIVATE_IDENTITY",
      ],
    },
    {
      label: "an interval above the bound",
      args: [
        "repository",
        "watch",
        "review-suite",
        "--interval-ms",
        "86400001",
        "--certificate-issuer",
        "https://issuer.example.test/",
        "--certificate-identity",
        "PRIVATE_IDENTITY",
      ],
    },
    {
      label: "a noncanonical interval",
      args: [
        "repository",
        "watch",
        "review-suite",
        "--interval-ms",
        "060000",
        "--certificate-issuer",
        "https://issuer.example.test/",
        "--certificate-identity",
        "PRIVATE_IDENTITY",
      ],
    },
    {
      label: "an unknown update policy",
      args: [
        "repository",
        "watch",
        "review-suite",
        "--update-policy",
        "PRIVATE_POLICY",
        "--certificate-issuer",
        "https://issuer.example.test/",
        "--certificate-identity",
        "PRIVATE_IDENTITY",
      ],
    },
    {
      label: "a malformed publisher authority",
      args: [
        "repository",
        "watch",
        "review-suite",
        "--certificate-issuer",
        "PRIVATE_NONCANONICAL_ISSUER",
        "--certificate-identity",
        "PRIVATE_IDENTITY",
      ],
    },
    {
      label: "a repeated update policy",
      args: [
        "repository",
        "watch",
        "review-suite",
        "--update-policy",
        "patch",
        "--update-policy",
        "PRIVATE_POLICY",
        "--certificate-issuer",
        "https://issuer.example.test/",
        "--certificate-identity",
        "PRIVATE_IDENTITY",
      ],
    },
    {
      label: "watcher options on package listing",
      args: ["list", "--interval-ms", "60000", "--update-policy", "patch"],
    },
  ])("rejects $label before loading project state", async ({ args }) => {
    const project = await projectDirectory();
    const loadConfig = vi.fn(async () => effectiveConfig(project));
    const output = captureIo();

    expect(await main(["packages", ...args], output.io, { cwd: project, loadConfig })).toBe(2);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(`${output.stdout.join("\n")}\n${output.stderr.join("\n")}`).not.toContain("PRIVATE_");
  });
});

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-repository-cli-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, ".flow"));
  return directory;
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

function trustedRoot(): Buffer {
  const key = createSigningKey();
  const signed = {
    _type: "root",
    spec_version: "1.0.31",
    version: 1,
    expires: "2030-01-01T00:00:00.000Z",
    keys: { [key.id]: key.publicMetadata },
    roles: {
      root: role(key.id),
      timestamp: role(key.id),
      snapshot: role(key.id),
      targets: role(key.id),
    },
    consistent_snapshot: true,
  };
  const signature = sign(null, Buffer.from(canonicalJson(signed)), key.privateKey).toString("hex");
  return Buffer.from(JSON.stringify({ signatures: [{ keyid: key.id, sig: signature }], signed }));
}

function repositoryFixture(options: { readonly version?: string } = {}) {
  const key = createSigningKey();
  const repositoryBaseUrl = "https://updates.example.test/repository/";
  const metadataBaseUrl = `${repositoryBaseUrl}metadata/`;
  const targetBaseUrl = `${repositoryBaseUrl}targets/`;
  const publisher = Object.freeze({
    certificateIssuer: "https://token.actions.githubusercontent.com/",
    certificateIdentity:
      "https://github.com/synaptiai/flow-harness/.github/workflows/publish.yml@refs/tags/v1.0.0",
  });
  const version = options.version ?? "1.0.0";
  const bundle = createCapabilityBundleSource({
    name: "review-suite",
    version,
    description: "Review capabilities.",
    packages: [
      {
        kind: "verifier-package",
        manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review
  version: 1.0.0
  description: Review evidence.
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
  const packagePath = `flow/packages/review-suite/${version}.flowpkg.json`;
  const indexBytes = encodeCapabilityRepositoryIndex({
    packages: [{ name: "review-suite", version, targetPath: packagePath }],
  });
  const root = signedMetadata(
    {
      _type: "root",
      spec_version: "1.0.31",
      version: 1,
      expires: "2030-01-01T00:00:00.000Z",
      keys: { [key.id]: key.publicMetadata },
      roles: {
        root: role(key.id),
        timestamp: role(key.id),
        snapshot: role(key.id),
        targets: role(key.id),
      },
      consistent_snapshot: true,
    },
    key,
  );
  const targets = signedMetadata(
    {
      _type: "targets",
      spec_version: "1.0.31",
      version: 1,
      expires: "2030-01-01T00:00:00.000Z",
      targets: {
        "flow/capability-index.json": targetDescriptor(indexBytes, {}),
        [packagePath]: targetDescriptor(envelope, {
          flow: {
            apiVersion: "flow.synapti.ai/v1alpha1",
            kind: "CapabilityPackageTarget",
            name: "review-suite",
            version,
            publisher,
          },
        }),
      },
    },
    key,
  );
  const snapshot = signedMetadata(
    {
      _type: "snapshot",
      spec_version: "1.0.31",
      version: 1,
      expires: "2030-01-01T00:00:00.000Z",
      meta: { "targets.json": metadataDescriptor(1, targets) },
    },
    key,
  );
  const timestamp = signedMetadata(
    {
      _type: "timestamp",
      spec_version: "1.0.31",
      version: 1,
      expires: "2030-01-01T00:00:00.000Z",
      meta: { "snapshot.json": metadataDescriptor(1, snapshot) },
    },
    key,
  );
  const targetSource = consistentTargetUrl(targetBaseUrl, packagePath, envelope);
  const activeMetadata = JSON.parse(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityMetadata",
      metadata: {
        name: "project-capabilities",
        version: 2,
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      spec: {
        targets: [
          {
            name: bundle.bundle.name,
            version: bundle.bundle.version,
            digest: bundle.bundle.digest,
            bytes: bundle.content.byteLength,
            source: targetSource,
            status: "active",
            publisher,
          },
        ],
      },
    }),
  );
  return {
    repositoryBaseUrl,
    root,
    envelope,
    publisher,
    targetSource,
    activeMetadata: parseActiveMetadata(Buffer.from(JSON.stringify(activeMetadata))),
    envelopeCapabilityBundle: bundle.content,
    remote: new Map<string, Buffer>([
      [`${metadataBaseUrl}timestamp.json`, timestamp],
      [`${metadataBaseUrl}1.snapshot.json`, snapshot],
      [`${metadataBaseUrl}1.targets.json`, targets],
      [consistentTargetUrl(targetBaseUrl, "flow/capability-index.json", indexBytes), indexBytes],
      [targetSource, envelope],
    ]),
  };
}

function sequenceClock(values: readonly string[]): () => Date {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error("clock fixture exhausted");
    }
    return new Date(value);
  };
}

function activeMetadata(input: {
  readonly content: Uint8Array;
  readonly version: string;
  readonly source: string;
  readonly publisher: {
    readonly certificateIssuer: string;
    readonly certificateIdentity: string;
  };
  readonly metadataVersion: number;
  readonly prior?: {
    readonly content: Uint8Array;
    readonly version: string;
    readonly source: string;
  };
}) {
  return parseActiveMetadata(
    Buffer.from(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityMetadata",
        metadata: {
          name: "project-capabilities",
          version: input.metadataVersion,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        spec: {
          targets: [
            ...(input.prior === undefined
              ? []
              : [
                  {
                    name: "review-suite",
                    version: input.prior.version,
                    digest: `sha256:${sha256(input.prior.content)}`,
                    bytes: input.prior.content.byteLength,
                    source: input.prior.source,
                    status: "active",
                    publisher: input.publisher,
                  },
                ]),
            {
              name: "review-suite",
              version: input.version,
              digest: `sha256:${sha256(input.content)}`,
              bytes: input.content.byteLength,
              source: input.source,
              status: "active",
              publisher: input.publisher,
            },
          ],
        },
      }),
    ),
  );
}

function parseActiveMetadata(content: Buffer) {
  return parseCapabilityMetadata(content, new Date("2026-08-17T00:00:00.000Z"));
}

function targetDescriptor(content: Buffer, custom: Record<string, unknown>) {
  return { length: content.byteLength, hashes: { sha256: sha256(content) }, custom };
}

function metadataDescriptor(version: number, content: Buffer) {
  return { version, length: content.byteLength, hashes: { sha256: sha256(content) } };
}

function consistentTargetUrl(base: string, path: string, content: Buffer): string {
  const slash = path.lastIndexOf("/");
  const directory = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  return `${base}${directory}${sha256(content)}.${name}`;
}

function signedMetadata(
  signed: Record<string, unknown>,
  key: ReturnType<typeof createSigningKey>,
): Buffer {
  const signature = sign(null, Buffer.from(canonicalJson(signed)), key.privateKey).toString("hex");
  return Buffer.from(JSON.stringify({ signatures: [{ keyid: key.id, sig: signature }], signed }));
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function role(keyID: string): Record<string, unknown> {
  return { keyids: [keyID], threshold: 1 };
}

function createSigningKey(): {
  readonly id: string;
  readonly privateKey: KeyObject;
  readonly publicMetadata: Record<string, unknown>;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const publicMetadata = {
    keytype: "ed25519",
    scheme: "ed25519",
    keyval: { public: publicDer.subarray(publicDer.byteLength - 32).toString("hex") },
  };
  return {
    id: createHash("sha256").update(canonicalJson(publicMetadata)).digest("hex"),
    privateKey,
    publicMetadata,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
