import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCapabilityMetadataCandidate,
  encodeCapabilityMetadataCandidate,
} from "../../../src/application/capability-metadata-candidate.js";
import type {
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import {
  type CapabilitySnapshot,
  createAgentCapabilityEvidence,
} from "../../../src/domain/capability/agent-skills.js";
import { createCapabilityBundleSource } from "../../../src/domain/capability/capability-bundles.js";
import { parseCapabilityMetadata } from "../../../src/domain/capability/capability-metadata.js";
import {
  FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
  SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
} from "../../../src/domain/capability/oci-capability-artifacts.js";
import type { SigstoreCapabilityVerifier } from "../../../src/domain/capability/sigstore-capability-verifier.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import {
  type CommandEvidence,
  type RunEvent,
  reduceRunEvents,
} from "../../../src/domain/run/events.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { LocalCapabilityPackageStore } from "../../../src/infrastructure/fs/local-capability-package-store.js";
import { LocalSupervisorStore } from "../../../src/infrastructure/fs/local-supervisor-store.js";
import type { CapabilityBundleFetcher } from "../../../src/infrastructure/http/strict-capability-bundle-fetcher.js";
import type {
  AcquiredOciCapabilityArtifact,
  StrictOciCapabilityRegistry,
} from "../../../src/infrastructure/http/strict-oci-capability-registry.js";
import { createProductionNodeEffectReconciler } from "../../../src/infrastructure/runtime/production-effect-reconciler.js";
import { createProductionWorkspaceIsolator } from "../../../src/infrastructure/runtime/production-workspace-isolator.js";
import { createActiveRunClaim, createJobRecord } from "../../../src/supervisor/records.js";
import { executeWorkerJob, requestWorker } from "../../../src/supervisor/worker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("installed capability workflow", () => {
  it("uses every installed ABI through existing CLI, execution, and offline replay paths", async () => {
    const project = await temporaryProject();
    const created = mixedBundle();
    const bundleDigest = created.bundle.digest.slice("sha256:".length);
    const packageStore = new LocalCapabilityPackageStore(project);
    const acquisition = await installPrivateBundle(project, created.content, bundleDigest);
    const metadataAuthority = {
      kind: "sigstore-keyless-v0.3" as const,
      certificateIssuer: "https://token.actions.githubusercontent.com/",
      certificateIdentity:
        "https://github.com/synaptiai/flow-harness/.github/workflows/metadata.yml@refs/heads/main",
      signatureBundleDigest: `sha256:${"e".repeat(64)}`,
    };
    await packageStore.refreshMetadata({
      metadata: packageMetadata(created.bundle, acquisition, 1, "active"),
      authority: metadataAuthority,
    });
    const inertCandidateMetadataBytes = Buffer.from(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityMetadata",
        metadata: {
          name: "flow-capabilities",
          version: 999,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        spec: {
          targets: [
            {
              name: created.bundle.name,
              version: created.bundle.version,
              digest: created.bundle.digest,
              bytes: created.bundle.bytes,
              source: acquisition.source,
              status: "revoked",
              publisher: acquisition.publisher,
            },
          ],
        },
      }),
    );
    const inertCandidateMetadata = parseCapabilityMetadata(
      inertCandidateMetadataBytes,
      new Date("2026-08-15T00:00:00.000Z"),
    );
    const inertCandidateCanary = Buffer.from("PRIVATE_INERT_METADATA_CANDIDATE");
    const inertCandidate = createCapabilityMetadataCandidate({
      metadata: inertCandidateMetadata,
      metadataBytes: inertCandidateMetadataBytes,
      sigstoreBundle: inertCandidateCanary,
      authority: {
        ...metadataAuthority,
        signatureBundleDigest: sha256Digest(inertCandidateCanary),
      },
    });
    const inertCandidateDirectory = join(
      project,
      ".flow",
      "packages.metadata.candidates",
      "sha256",
      inertCandidate.candidateDigest.slice("sha256:".length),
    );
    await mkdir(inertCandidateDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        join(inertCandidateDirectory, "candidate.json"),
        encodeCapabilityMetadataCandidate(inertCandidate),
      ),
      writeFile(join(inertCandidateDirectory, "metadata.json"), inertCandidateMetadataBytes),
      writeFile(join(inertCandidateDirectory, "sigstore.bundle.json"), inertCandidateCanary),
    ]);
    const repositoryRuntimeCanary = Buffer.from("PRIVATE_REPOSITORY_RUNTIME_TRAP");
    const repositoryRuntimePath = join(project, ".flow", "capability.repository");
    await writeFile(repositoryRuntimePath, repositoryRuntimeCanary);
    const provenanceRoot = `.flow/packages/sha256/${bundleDigest}`;
    const fetch = vi.fn(async () => {
      throw new Error("workflow and replay must not fetch capability bundles");
    });
    const acquire = vi.fn(async () => {
      throw new Error("PRIVATE_OFFLINE_REGISTRY");
    });
    const readRegistrySecret = vi.fn(async () => {
      throw new Error("PRIVATE_OFFLINE_CREDENTIAL");
    });
    const metadataDependencies = dependencies(project, {
      capabilityBundleFetcher: { fetch } satisfies CapabilityBundleFetcher,
      ociCapabilityRegistry: { acquire } satisfies StrictOciCapabilityRegistry,
      readRegistrySecret,
    });

    const skills = await invoke(["skills", "list"], metadataDependencies);
    const skill = await invoke(["skills", "inspect", "review"], metadataDependencies);
    const skillValidation = await invoke(["skills", "validate"], metadataDependencies);
    const verifiers = await invoke(["verifiers", "list"], metadataDependencies);
    const verifier = await invoke(["verifiers", "inspect", "release-tests"], metadataDependencies);
    const verifierValidation = await invoke(["verifiers", "validate"], metadataDependencies);
    const tools = await invoke(["tools", "list"], metadataDependencies);
    const tool = await invoke(
      ["tools", "inspect", "project-status", "--version", "1.0.0"],
      metadataDependencies,
    );
    const toolValidation = await invoke(["tools", "validate"], metadataDependencies);

    expect(skills.json).toMatchObject({
      skills: [{ name: "review", provenance: `${provenanceRoot}/agent-skill/review` }],
    });
    expect(skill.json).toMatchObject({
      name: "review",
      provenance: `${provenanceRoot}/agent-skill/review`,
    });
    expect(skillValidation.json).toMatchObject({ valid: true, skills: ["review"] });
    expect(verifiers.json).toMatchObject({
      packages: [
        {
          name: "release-tests",
          version: "1.0.0",
          provenance: `${provenanceRoot}/verifier-package/release-tests`,
        },
      ],
    });
    expect(verifier.json).toMatchObject({
      name: "release-tests",
      version: "1.0.0",
      provenance: `${provenanceRoot}/verifier-package/release-tests`,
    });
    expect(verifierValidation.json).toMatchObject({
      valid: true,
      packages: ["release-tests@1.0.0"],
    });
    expect(tools.json).toMatchObject({
      packages: [
        {
          name: "project-status",
          version: "1.0.0",
          provenance: `${provenanceRoot}/tool-package/project-status`,
        },
      ],
    });
    expect(tool.json).toMatchObject({
      name: "project-status",
      version: "1.0.0",
      provenance: `${provenanceRoot}/tool-package/project-status`,
    });
    expect(toolValidation.json).toMatchObject({
      valid: true,
      packages: ["project-status@1.0.0"],
    });

    const workflowPath = join(project, "installed.workflow.yaml");
    await writeFile(workflowPath, workflowSource());
    const validation = await invoke(["validate", workflowPath], metadataDependencies);
    expect(validation.stdout).toContain("skills: 1, verifier packages: 1, tool packages: 1");

    const runStore = new MemoryStore();
    const observed: NodeExecutionContext[] = [];
    let authorityRevoked = false;
    const executor: NodeExecutor = {
      async execute(node, context) {
        observed.push(context);
        if (node.type === "agent") {
          if (!authorityRevoked) {
            authorityRevoked = true;
            await packageStore.refreshMetadata({
              metadata: packageMetadata(created.bundle, acquisition, 2, "revoked"),
              authority: metadataAuthority,
            });
          }
          return successfulAgentOutcome(context.capabilitySnapshot);
        }
        if (node.type === "verifier") {
          return successfulVerifierOutcome(context);
        }
        if (node.type === "command") {
          return successfulCommandOutcome();
        }
        throw new Error(`unexpected installed capability node "${node.type}"`);
      },
    };
    const run = await invoke(
      ["run", workflowPath, "--run-id", "installed-capability-run"],
      dependencies(project, {
        capabilityBundleFetcher: { fetch } satisfies CapabilityBundleFetcher,
        executor,
        createStore: () => runStore,
      }),
    );
    expect(run.code).toBe(0);
    expect(authorityRevoked).toBe(true);
    expect(fetch).not.toHaveBeenCalled();

    const started = runStore.events.find((event) => event.type === "run_started");
    expect(started?.type).toBe("run_started");
    if (started?.type !== "run_started") {
      throw new Error("run did not record run_started");
    }
    expect(started.capabilitySnapshot?.packages).toHaveLength(3);
    expect(started.capabilitySnapshot?.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent-skill",
          name: "review",
          provenance: `${provenanceRoot}/agent-skill/review`,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          kind: "verifier-package",
          name: "release-tests",
          version: "1.0.0",
          provenance: `${provenanceRoot}/verifier-package/release-tests`,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          kind: "tool-package",
          name: "project-status",
          version: "1.0.0",
          provenance: `${provenanceRoot}/tool-package/project-status`,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );
    expect(JSON.stringify(started)).not.toContain("https://");
    const verifierSnapshot = started.capabilitySnapshot?.packages.find(
      (item) => item.kind === "verifier-package" && item.name === "release-tests",
    );
    expect(
      observed.find((context) => context.verifierPackage !== undefined)?.verifierPackage,
    ).toMatchObject({
      name: "release-tests",
      version: "1.0.0",
      digest: verifierSnapshot?.digest,
    });
    const rejectedAdmission = captureIo();
    expect(await main(["validate", workflowPath], rejectedAdmission.io, metadataDependencies)).toBe(
      1,
    );
    expect(rejectedAdmission.stderr).toEqual([
      "metadata_target: capability bundle does not match one active trusted metadata target",
    ]);

    const replacement = mixedBundle("2.0.0", "Review updated evidence.");
    const replacementSource = "https://packages.example.test/targets/review-suite-2.0.0.flowpkg";
    await packageStore.refreshMetadata({
      metadata: packageMetadata(
        replacement.bundle,
        { source: replacementSource, publisher: acquisition.publisher },
        3,
        "active",
        [{ bundle: created.bundle, acquisition }],
      ),
      authority: metadataAuthority,
    });
    await expect(
      packageStore.replace({
        expectedCurrentVersion: "1.0.0",
        source: replacementSource,
        expectedSha256: sha256Digest(replacement.content).slice("sha256:".length),
        content: replacement.content,
        publisher: {
          kind: "sigstore-keyless-v0.3",
          ...acquisition.publisher,
          signatureBundleDigest: `sha256:${"d".repeat(64)}`,
        },
      }),
    ).resolves.toMatchObject({ status: "replaced", cleanup: "retained" });
    const replacementDigest = replacement.bundle.digest.slice("sha256:".length);
    const replacementProvenanceRoot = `.flow/packages/sha256/${replacementDigest}`;
    const replacementRunStore = new MemoryStore();
    const replacementRun = await invoke(
      ["run", workflowPath, "--run-id", "replacement-capability-run"],
      dependencies(project, {
        capabilityBundleFetcher: { fetch } satisfies CapabilityBundleFetcher,
        executor,
        createStore: () => replacementRunStore,
      }),
    );
    expect(replacementRun.code).toBe(0);
    const replacementStarted = replacementRunStore.events.find(
      (event) => event.type === "run_started",
    );
    expect(replacementStarted?.type).toBe("run_started");
    if (replacementStarted?.type !== "run_started") {
      throw new Error("replacement run did not record run_started");
    }
    expect(replacementStarted.capabilitySnapshot?.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent-skill",
          name: "review",
          provenance: `${replacementProvenanceRoot}/agent-skill/review`,
        }),
      ]),
    );
    expect(started.capabilitySnapshot?.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent-skill",
          name: "review",
          provenance: `${provenanceRoot}/agent-skill/review`,
        }),
      ]),
    );
    const prunePreview = await packageStore.previewPrune();
    expect(prunePreview).toMatchObject({
      retiredBlobCount: 1,
      retiredBlobBytes: created.content.length,
    });
    await expect(
      packageStore.applyPrune({ expectedPlanDigest: prunePreview.planDigest }),
    ).resolves.toMatchObject({ status: "applied", unlinkedBlobCount: 1 });
    await expect(
      stat(join(project, ".flow", "packages", "sha256", `${bundleDigest}.flowpkg`)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const detachedRunsDirectory = join(project, "detached-runs");
    const supervisorStore = new LocalSupervisorStore(detachedRunsDirectory);
    await supervisorStore.initialize();
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "installed-capability-detached",
      mode: "run",
      sourceName: workflowPath,
      workflowSource: workflowSource(),
      cwd: project,
      projectRoot: project,
      token: "9".repeat(64),
      createdAt: "2026-08-15T12:00:00.000Z",
      capabilitySnapshot: started.capabilitySnapshot ?? undefined,
    });
    await supervisorStore.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const metadataPath = join(project, ".flow", "packages.metadata.json");
    const heldMetadataPath = join(project, ".flow", "packages.metadata.held.json");
    await rename(metadataPath, heldMetadataPath);
    await mkdir(metadataPath);
    try {
      const detachedWorker = executeWorkerJob(job.jobId, {
        store: supervisorStore,
        executor,
        effectReconciler: createProductionNodeEffectReconciler(),
        createRunStore: (root) => new JsonlRunStore(root),
        createWorkspaceIsolator: (root, paths, executionRoot, selectedProjectRoot) =>
          createProductionWorkspaceIsolator(root, paths, executionRoot, selectedProjectRoot),
        pid: 4383,
      });
      let descriptor: Awaited<ReturnType<LocalSupervisorStore["readWorkerDescriptor"]>> | undefined;
      await vi.waitFor(async () => {
        descriptor = await supervisorStore.readWorkerDescriptor(job.workerId);
        expect(descriptor.workerId).toBe(job.workerId);
      });
      if (descriptor === undefined) {
        throw new Error("detached worker did not publish its descriptor");
      }
      await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
        ok: true,
        result: { runId: job.runId, status: "running" },
      });
      await expect(detachedWorker).resolves.toBe(0);
    } finally {
      await rm(metadataPath, { recursive: true });
      await rename(heldMetadataPath, metadataPath);
    }
    expect(
      reduceRunEvents(
        await new JsonlRunStore(detachedRunsDirectory).read("installed-capability-detached"),
      ).status,
    ).toBe("succeeded");

    await packageStore.remove("review-suite", "2.0.0");
    const inspectedRun = await invoke(
      ["inspect", "installed-capability-run"],
      dependencies(project, {
        capabilityBundleFetcher: { fetch } satisfies CapabilityBundleFetcher,
        createStore: () => runStore,
      }),
    );
    expect(inspectedRun.code).toBe(0);
    expect(inspectedRun.stdout).toContain(`${provenanceRoot}/agent-skill/review`);
    const resumeOutput = captureIo();
    expect(
      await main(
        ["resume", workflowPath, "--run-id", "installed-capability-run"],
        resumeOutput.io,
        dependencies(project, {
          capabilityBundleFetcher: { fetch } satisfies CapabilityBundleFetcher,
          ociCapabilityRegistry: { acquire } satisfies StrictOciCapabilityRegistry,
          readRegistrySecret,
          executor,
          createStore: () => runStore,
        }),
      ),
    ).toBe(1);
    expect(resumeOutput.stderr.join("\n")).toMatch(/terminal_run.*already terminal.*succeeded/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(readRegistrySecret).not.toHaveBeenCalled();
    expect(JSON.stringify(runStore.events)).not.toContain("PRIVATE_");
    expect(
      JSON.stringify(
        await new JsonlRunStore(detachedRunsDirectory).read("installed-capability-detached"),
      ),
    ).not.toContain("PRIVATE_");
    await expect(readFile(join(inertCandidateDirectory, "sigstore.bundle.json"))).resolves.toEqual(
      inertCandidateCanary,
    );
    await expect(readFile(repositoryRuntimePath)).resolves.toEqual(repositoryRuntimeCanary);
  });
});

async function installPrivateBundle(
  project: string,
  content: Buffer,
  bundleDigest: string,
): Promise<{
  readonly source: string;
  readonly publisher: {
    readonly certificateIssuer: string;
    readonly certificateIdentity: string;
  };
}> {
  const manifestDigest = `sha256:${"1".repeat(64)}` as const;
  const reference = `registry.example.test/flow/review-suite@${manifestDigest}`;
  const signatureBundle = Buffer.from("PRIVATE_SIGNATURE_BUNDLE");
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
        digest: `sha256:${bundleDigest}`,
        size: content.byteLength,
      }),
      sigstoreBundle: Object.freeze({
        mediaType: SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
        digest: sha256Digest(signatureBundle),
        size: signatureBundle.byteLength,
      }),
    }),
    capabilityBundle: content,
    sigstoreBundle: signatureBundle,
  });
  const password = Buffer.from("PRIVATE_REGISTRY_PASSWORD");
  const controller = new AbortController();
  const readRegistrySecret = vi.fn(async () => password);
  const acquire = vi.fn(async (_reference, signal, credentialProvider) => {
    if (signal === undefined || credentialProvider === undefined) {
      throw new Error("private installation requires explicit credentials");
    }
    const credentials = await credentialProvider(
      Object.freeze({
        realm: "https://auth.example.test/token",
        service: "registry.example.test",
        scope: "repository:flow/review-suite:pull",
      }),
      signal,
    );
    expect(credentials).toMatchObject({ username: "private-user" });
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
      dependencies(project, {
        ociCapabilityRegistry: { acquire } satisfies StrictOciCapabilityRegistry,
        sigstoreCapabilityVerifier: {
          verify: vi.fn().mockReturnValue(publisher),
        } satisfies SigstoreCapabilityVerifier,
        readRegistrySecret,
        signal: controller.signal,
      }),
    ),
    output.stderr.join("\n"),
  ).toBe(0);
  expect(acquire).toHaveBeenCalledOnce();
  expect(readRegistrySecret).toHaveBeenCalledOnce();
  expect(password.every((value) => value === 0)).toBe(true);
  expect(`${output.stdout.join("\n")}\n${output.stderr.join("\n")}`).not.toContain("PRIVATE_");
  return Object.freeze({ source: reference, publisher });
}

class MemoryStore implements RecoverableRunEventStore {
  readonly events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(runId: string): Promise<readonly RunEvent[]> {
    return structuredClone(this.events.filter((event) => event.runId === runId));
  }

  async claim(runId: string): Promise<readonly RunEvent[]> {
    return await this.read(runId);
  }

  async release(): Promise<void> {}

  async exists(runId: string): Promise<boolean> {
    return this.events.some((event) => event.runId === runId);
  }
}

async function temporaryProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-installed-workflow-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow"));
  return project;
}

function mixedBundle(version = "1.0.0", skillInstruction = "Review the evidence.") {
  return createCapabilityBundleSource({
    name: "review-suite",
    version,
    description: "Review capabilities.",
    packages: [
      {
        kind: "agent-skill",
        files: [
          {
            path: "SKILL.md",
            content: Buffer.from(`---
name: review
description: Review code when selected.
allowed-tools: read
---
${skillInstruction}
`),
          },
        ],
      },
      { kind: "verifier-package", manifest: Buffer.from(verifierManifest()) },
      { kind: "tool-package", manifest: Buffer.from(toolManifest()) },
    ],
  });
}

function verifierManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: release-tests, version: 1.0.0, description: Run release tests. }
spec:
  kind: command
  command: { executable: node, args: [--version], timeoutMs: 30000 }
`;
}

function toolManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: project-status
  version: 1.0.0
  description: Show a bounded project status.
spec:
  tool:
    name: status_report
    description: Return a bounded project status.
    inputs: []
  driver:
    kind: command
    version: v1
    profile: git-status-v1
    executable: /usr/bin/git
    args: [--no-optional-locks, -c, core.fsmonitor=false, -c, core.untrackedCache=false, status, --short, --untracked-files=normal, --ignore-submodules=all]
    timeoutMs: 10000
  permissions: [process.execute]
`;
}

function packageMetadata(
  bundle: ReturnType<typeof mixedBundle>["bundle"],
  acquisition: {
    readonly source: string;
    readonly publisher: {
      readonly certificateIssuer: string;
      readonly certificateIdentity: string;
    };
  },
  version: number,
  status: "active" | "revoked",
  priorTargets: readonly {
    readonly bundle: ReturnType<typeof mixedBundle>["bundle"];
    readonly acquisition: {
      readonly source: string;
      readonly publisher: {
        readonly certificateIssuer: string;
        readonly certificateIdentity: string;
      };
    };
  }[] = [],
) {
  return parseCapabilityMetadata(
    Buffer.from(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityMetadata",
        metadata: {
          name: "flow-capabilities",
          version,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        spec: {
          targets: [
            ...priorTargets.map((target) => ({
              name: target.bundle.name,
              version: target.bundle.version,
              digest: target.bundle.digest,
              bytes: target.bundle.bytes,
              source: target.acquisition.source,
              status: "active",
              publisher: target.acquisition.publisher,
            })),
            {
              name: bundle.name,
              version: bundle.version,
              digest: bundle.digest,
              bytes: bundle.bytes,
              source: acquisition.source,
              status,
              publisher: acquisition.publisher,
            },
          ],
        },
      }),
    ),
    new Date("2026-08-15T00:00:00.000Z"),
  );
}

function workflowSource(): string {
  const child = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: installed-capabilities-child }
budget:
  maxNodeStarts: 4
  maxModelTokens: 100
  maxCostUsd: 0.01
  maxExecutionMs: 10000
  maxArtifactBytes: 100000
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: string, maxLength: 1024 }
`.trim();
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: installed-capabilities }
budget:
  maxNodeStarts: 16
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 1000000
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze.
      model: { provider: test, id: deterministic }
      tools: [read]
      skills: [review]
      toolPackages:
        - { name: project-status, version: 1.0.0 }
  - id: release
    type: verifier
    dependsOn: [analyze]
    verifier:
      kind: packaged-command
      package: { name: release-tests, version: 1.0.0 }
  - id: delegate
    type: child
    dependsOn: [release]
    child:
      resultNodeId: publish
      workflow: |
${child
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
`;
}

function successfulAgentOutcome(snapshot?: CapabilitySnapshot): NodeExecutionOutcome {
  const text = "analyzed";
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text,
      textHash: sha256(text),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [],
      effectReceipts: [],
      ...(snapshot === undefined
        ? {}
        : { capabilities: createAgentCapabilityEvidence(snapshot, ["review"]) }),
    },
  };
}

function successfulVerifierOutcome(context: NodeExecutionContext): NodeExecutionOutcome {
  const reason = "command exited with code 0";
  const command: CommandEvidence = {
    kind: "command",
    executable: "node",
    args: ["--version"],
    exitCode: 0,
    signal: null,
    stdout: "v22.0.0",
    stderr: "",
    stdoutHash: sha256("v22.0.0"),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
  return {
    status: "succeeded",
    evidence: {
      kind: "verifier",
      driver: "command",
      result: "completed",
      verdict: "accepted",
      reason,
      reasonHash: sha256(reason),
      durationMs: 1,
      sources: [],
      command,
      ...(context.verifierPackage === undefined ? {} : { package: context.verifierPackage }),
    },
  };
}

function successfulCommandOutcome(): NodeExecutionOutcome {
  const stdout = '"child-ok"';
  return {
    status: "succeeded",
    evidence: {
      kind: "command",
      executable: "node",
      args: [],
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      stdoutHash: sha256(stdout),
      stderrHash: sha256(""),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
    },
  };
}

async function invoke(
  args: readonly string[],
  cliDependencies: Record<string, unknown>,
): Promise<{ readonly code: number; readonly json: unknown; readonly stdout: string }> {
  const output = captureIo();
  const code = await main(args, output.io, cliDependencies);
  expect(code, [...output.stderr, ...output.stdout].join("\n")).toBe(0);
  const stdout = output.stdout.join("\n");
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { code, json, stdout };
}

function dependencies(project: string, extra: Record<string, unknown> = {}) {
  return {
    cwd: project,
    loadConfig: async () => effectiveConfig(project),
    ...extra,
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
