import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverProjectPolicyPackages,
  snapshotSelectedPolicyPackages,
} from "../../../src/infrastructure/fs/local-policy-package-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("local policy package catalog", () => {
  it("discovers and snapshots one exact inert policy manifest", async () => {
    const project = await temporaryProject();
    await writePolicy(project, "restricted-review", manifest("1.2.3"));

    const catalog = await discoverProjectPolicyPackages(project);
    const snapshot = await snapshotSelectedPolicyPackages(catalog, [
      { name: "restricted-review", version: "1.2.3" },
    ]);

    expect(catalog.packages).toMatchObject([
      {
        name: "restricted-review",
        version: "1.2.3",
        trust: "project-explicit",
        provenance: ".flow/policies/restricted-review",
      },
    ]);
    expect(snapshot.packages).toMatchObject([
      {
        kind: "policy-package",
        name: "restricted-review",
        version: "1.2.3",
        definition: { tools: { allowed: ["read"] } },
      },
    ]);
  });

  it("rejects version mismatch and manifest drift after discovery", async () => {
    const project = await temporaryProject();
    await writePolicy(project, "restricted-review", manifest("1.2.3"));
    const catalog = await discoverProjectPolicyPackages(project);

    await expect(
      snapshotSelectedPolicyPackages(catalog, [{ name: "restricted-review", version: "2.0.0" }]),
    ).rejects.toMatchObject({ code: "version_mismatch" });

    await writePolicy(project, "restricted-review", manifest("1.2.4"));
    await expect(
      snapshotSelectedPolicyPackages(catalog, [{ name: "restricted-review", version: "1.2.3" }]),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("rejects symlinks, extra files, and manifest-directory name disagreement", async () => {
    const symlinkProject = await temporaryProject();
    const outside = join(symlinkProject, "outside");
    await mkdir(outside);
    await symlink(outside, join(symlinkProject, ".flow", "policies", "linked"));
    await expect(discoverProjectPolicyPackages(symlinkProject)).rejects.toMatchObject({
      code: "unsafe_entry",
    });

    const extraProject = await temporaryProject();
    await writePolicy(extraProject, "restricted-review", manifest("1.2.3"));
    await writeFile(
      join(extraProject, ".flow", "policies", "restricted-review", "private.sh"),
      "exit 0\n",
    );
    await expect(discoverProjectPolicyPackages(extraProject)).rejects.toMatchObject({
      code: "unsafe_entry",
    });

    const mismatchProject = await temporaryProject();
    await writePolicy(mismatchProject, "directory-name", manifest("1.2.3"));
    await expect(discoverProjectPolicyPackages(mismatchProject)).rejects.toMatchObject({
      code: "invalid_package",
    });
  });

  it("rejects missing and duplicate exact selections", async () => {
    const project = await temporaryProject();
    await writePolicy(project, "restricted-review", manifest("1.2.3"));
    const catalog = await discoverProjectPolicyPackages(project);

    await expect(
      snapshotSelectedPolicyPackages(catalog, [{ name: "missing", version: "1.0.0" }]),
    ).rejects.toMatchObject({ code: "missing_package" });
    await expect(
      snapshotSelectedPolicyPackages(catalog, [
        { name: "restricted-review", version: "1.2.3" },
        { name: "restricted-review", version: "1.2.3" },
      ]),
    ).rejects.toMatchObject({ code: "invalid_package" });
  });
});

async function temporaryProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "flow-policy-packages-"));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "policies"), { recursive: true });
  return project;
}

async function writePolicy(project: string, name: string, source: string): Promise<void> {
  const directory = join(project, ".flow", "policies", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "POLICY.yaml"), source);
}

function manifest(version: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: restricted-review
  version: ${version}
  description: Restrict review execution.
spec:
  tools:
    allowed: [read]
`;
}
