import type { BigIntStats, StatOptions, Stats } from "node:fs";
import {
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES } from "../../../src/domain/capability/workflow-packages.js";

import {
  discoverProjectWorkflowPackages,
  snapshotSelectedWorkflowPackages,
} from "../../../src/infrastructure/fs/local-workflow-package-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local workflow package catalog", () => {
  it("discovers exact manifests and snapshots byte-identical selected packages", async () => {
    const project = await temporaryProject();
    await writeManifest(project, "release-check", workflowManifest("release-check", "1.0.0"));
    await writeManifest(
      project,
      "groups/evidence-flow",
      workflowManifest("evidence-flow", "1.2.0"),
    );

    const catalog = await discoverProjectWorkflowPackages(project);

    expect(catalog.packages.map((item) => item.name)).toEqual(["evidence-flow", "release-check"]);
    expect(catalog.packages[0]).toMatchObject({
      name: "evidence-flow",
      version: "1.2.0",
      workflowSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      provenance: ".flow/workflows/groups/evidence-flow",
      trust: "project-explicit",
    });

    const snapshot = await snapshotSelectedWorkflowPackages(catalog, [
      { name: "release-check", version: "1.0.0" },
      { name: "evidence-flow", version: "1.2.0" },
    ]);

    expect(snapshot.packages.map((item) => `${item.kind}:${item.name}@${item.version}`)).toEqual([
      "workflow-package:evidence-flow@1.2.0",
      "workflow-package:release-check@1.0.0",
    ]);
    expect(snapshot.packages[0]).toMatchObject({
      manifest: {
        contentBase64: Buffer.from(workflowManifest("evidence-flow", "1.2.0")).toString("base64"),
      },
    });
  });

  it.each([
    { label: "unknown field", source: `${workflowManifest("review", "1.0.0")}hooks: [run]\n` },
    { label: "non-exact version", source: workflowManifest("review", "latest") },
    { label: "name mismatch", source: workflowManifest("different", "1.0.0") },
  ])("rejects an invalid manifest: $label", async ({ source }) => {
    const project = await temporaryProject();
    await writeManifest(project, "review", source);

    await expect(discoverProjectWorkflowPackages(project)).rejects.toMatchObject({
      code: "invalid_package",
    });
  });

  it("rejects executable or symlinked package entries", async () => {
    const project = await temporaryProject();
    await writeManifest(project, "review", workflowManifest("review", "1.0.0"));
    await writeFile(join(project, ".flow", "workflows", "review", "run.js"), "process.exit(0)\n");

    await expect(discoverProjectWorkflowPackages(project)).rejects.toMatchObject({
      code: "unsafe_entry",
    });

    await rm(join(project, ".flow", "workflows", "review", "run.js"));
    const outside = join(project, "outside.yaml");
    await writeFile(outside, workflowManifest("review", "1.0.0"));
    await rm(join(project, ".flow", "workflows", "review", "WORKFLOW.yaml"));
    await symlink(outside, join(project, ".flow", "workflows", "review", "WORKFLOW.yaml"));

    await expect(discoverProjectWorkflowPackages(project)).rejects.toMatchObject({
      code: "unsafe_entry",
    });
  });

  it("rejects missing versions and manifests changed after discovery", async () => {
    const project = await temporaryProject();
    await writeManifest(project, "review", workflowManifest("review", "1.0.0"));
    const catalog = await discoverProjectWorkflowPackages(project);

    await expect(
      snapshotSelectedWorkflowPackages(catalog, [{ name: "review", version: "2.0.0" }]),
    ).rejects.toMatchObject({ code: "version_mismatch" });

    await writeManifest(project, "review", workflowManifest("review", "1.0.1"));
    await expect(
      snapshotSelectedWorkflowPackages(catalog, [{ name: "review", version: "1.0.0" }]),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("bounds capture when a manifest grows after the opened-handle size check", async () => {
    const project = await temporaryProject();
    await writeManifest(project, "review", workflowManifest("review", "1.0.0"));
    const catalog = await discoverProjectWorkflowPackages(project);
    const manifestPath = join(project, ".flow", "workflows", "review", "WORKFLOW.yaml");
    const statSpy = await mutateAfterFirstHandleStat(manifestPath, async () => {
      await writeFile(manifestPath, Buffer.alloc(MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES + 1, 0x61));
    });

    try {
      await expect(
        snapshotSelectedWorkflowPackages(catalog, [{ name: "review", version: "1.0.0" }]),
      ).rejects.toMatchObject({ code: "limit_exceeded" });
    } finally {
      statSpy.mockRestore();
    }
  });

  it("rejects an in-place same-size manifest rewrite during initial discovery", async () => {
    const project = await temporaryProject();
    const original = workflowManifest("review", "1.0.0");
    const replacement = workflowManifest("review", "1.0.1");
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    await writeManifest(project, "review", original);
    const manifestPath = join(project, ".flow", "workflows", "review", "WORKFLOW.yaml");
    const statSpy = await mutateAfterFirstHandleStat(manifestPath, async () => {
      await writeFile(manifestPath, replacement);
    });

    try {
      await expect(discoverProjectWorkflowPackages(project)).rejects.toMatchObject({
        code: "source_changed",
      });
    } finally {
      statSpy.mockRestore();
    }
  });
});

async function mutateAfterFirstHandleStat(
  path: string,
  mutate: () => Promise<void>,
): Promise<{ mockRestore(): void }> {
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as { stat: FileHandle["stat"] };
  await probe.close();
  const originalStat = prototype.stat as (
    this: FileHandle,
    options?: StatOptions,
  ) => Promise<Stats | BigIntStats>;
  let mutated = false;
  return vi.spyOn(prototype, "stat").mockImplementation(async function (
    this: FileHandle,
    options?: StatOptions,
  ) {
    const result = await originalStat.call(this, options);
    if (!mutated) {
      mutated = true;
      await mutate();
    }
    return result;
  } as FileHandle["stat"]);
}

async function temporaryProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-workflow-packages-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "workflows"), { recursive: true });
  return project;
}

async function writeManifest(project: string, path: string, source: string): Promise<void> {
  const directory = join(project, ".flow", "workflows", path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "WORKFLOW.yaml"), source, "utf8");
}

function workflowManifest(name: string, version: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata:
  name: ${name}
  version: ${version}
  description: Run a bounded reusable flow.
  license: Apache-2.0
  compatibility: flow.synapti.ai/v1alpha1
spec:
  workflow: |-
    apiVersion: flow.synapti.ai/v1alpha1
    kind: Workflow
    metadata: { id: ${name} }
    budget:
      maxNodeStarts: 1
      maxModelTokens: 0
      maxCostUsdMicros: 0
      maxExecutionMs: 1000
      maxArtifactBytes: 1024
    nodes:
      - id: done
        type: command
        command:
          executable: /usr/bin/true
          args: []
`;
}
