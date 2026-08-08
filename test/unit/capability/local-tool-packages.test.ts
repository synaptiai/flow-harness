import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverProjectToolPackages,
  snapshotSelectedToolPackages,
} from "../../../src/infrastructure/fs/local-tool-package-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local tool package catalog", () => {
  it("discovers strict manifests and snapshots selected exact versions and bytes", async () => {
    const project = await temporaryProject();
    await writeManifest(project, "project-report", manifest("project-report", "1.2.3"));
    await writeManifest(project, "groups/git-summary", manifest("git-summary", "2.0.0"));

    const catalog = await discoverProjectToolPackages(project);

    expect(catalog.packages.map((item) => item.name)).toEqual(["git-summary", "project-report"]);
    expect(catalog.packages[0]).toMatchObject({
      name: "git-summary",
      version: "2.0.0",
      trust: "project-explicit",
      provenance: ".flow/tools/groups/git-summary",
      permissions: ["process.execute"],
      toolName: "project_report",
    });

    const snapshot = await snapshotSelectedToolPackages(catalog, [
      { name: "project-report", version: "1.2.3" },
    ]);

    expect(snapshot.packages).toHaveLength(1);
    expect(snapshot.packages[0]).toMatchObject({
      kind: "tool-package",
      name: "project-report",
      version: "1.2.3",
      manifest: {
        contentBase64: Buffer.from(manifest("project-report", "1.2.3")).toString("base64"),
      },
    });
  });

  it("does not execute package content while discovering, snapshotting, or inspecting it", async () => {
    const project = await temporaryProject();
    const marker = join(project, "executed");
    await writeManifest(
      project,
      "project-report",
      manifest("project-report", "1.2.3").replace("executable: reporter", `executable: ${marker}`),
    );

    const catalog = await discoverProjectToolPackages(project);
    await snapshotSelectedToolPackages(catalog, [{ name: "project-report", version: "1.2.3" }]);

    await expect(realpath(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects extra files, symlinks, duplicate package names, and invalid directory identity", async () => {
    const project = await temporaryProject();
    await writeManifest(project, "project-report", manifest("project-report", "1.2.3"));
    await writeFile(join(project, ".flow", "tools", "project-report", "run.js"), "bad\n");
    await expect(discoverProjectToolPackages(project)).rejects.toMatchObject({
      code: "unsafe_entry",
    });

    await rm(join(project, ".flow", "tools", "project-report", "run.js"));
    await writeManifest(project, "group/project-report", manifest("project-report", "1.2.3"));
    await expect(discoverProjectToolPackages(project)).rejects.toMatchObject({
      code: "duplicate_package",
    });

    await rm(join(project, ".flow", "tools", "group"), { recursive: true });
    const outside = join(project, "outside.yaml");
    await writeFile(outside, manifest("project-report", "1.2.3"));
    await rm(join(project, ".flow", "tools", "project-report", "TOOL.yaml"));
    await symlink(outside, join(project, ".flow", "tools", "project-report", "TOOL.yaml"));
    await expect(discoverProjectToolPackages(project)).rejects.toMatchObject({
      code: "unsafe_entry",
    });
  });

  it("rejects missing versions and manifest drift after discovery", async () => {
    const project = await temporaryProject();
    await writeManifest(project, "project-report", manifest("project-report", "1.2.3"));
    const catalog = await discoverProjectToolPackages(project);

    await expect(
      snapshotSelectedToolPackages(catalog, [{ name: "project-report", version: "2.0.0" }]),
    ).rejects.toMatchObject({ code: "version_mismatch" });

    await writeManifest(project, "project-report", manifest("project-report", "1.2.4"));
    await expect(
      snapshotSelectedToolPackages(catalog, [{ name: "project-report", version: "1.2.3" }]),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("rejects duplicate and empty selections", async () => {
    const project = await temporaryProject();
    await writeManifest(project, "project-report", manifest("project-report", "1.2.3"));
    const catalog = await discoverProjectToolPackages(project);

    await expect(snapshotSelectedToolPackages(catalog, [])).rejects.toMatchObject({
      code: "missing_package",
    });
    await expect(
      snapshotSelectedToolPackages(catalog, [
        { name: "project-report", version: "1.2.3" },
        { name: "project-report", version: "1.2.3" },
      ]),
    ).rejects.toMatchObject({ code: "invalid_package" });
  });
});

async function temporaryProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-tool-packages-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "tools"), { recursive: true });
  return project;
}

async function writeManifest(project: string, path: string, source: string): Promise<void> {
  const directory = join(project, ".flow", "tools", path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "TOOL.yaml"), source, "utf8");
}

function manifest(name: string, version: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: ${name}
  version: ${version}
  description: Produce a bounded project report.
  license: Apache-2.0
  compatibility: Requires reporter on PATH.
spec:
  tool:
    name: project_report
    description: Produce a report.
    inputs:
      - name: path
        description: Relative path to inspect.
        type: string
  driver:
    kind: command
    version: v1
    executable: reporter
    args: ["{input:path}"]
    timeoutMs: 10000
  permissions: [process.execute]
`;
}
