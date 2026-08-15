import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_POLICY_PACKAGE_MANIFEST_BYTES } from "../../../src/domain/capability/policy-packages.js";
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

  it("preserves exact cancellation before discovery or snapshot I/O", async () => {
    const project = await temporaryProject();
    await writePolicy(project, "restricted-review", manifest("1.2.3"));
    const catalog = await discoverProjectPolicyPackages(project);
    const controller = new AbortController();
    const reason = new Error("operator cancelled policy capture");
    controller.abort(reason);

    await expect(
      discoverProjectPolicyPackages(join(project, "missing"), { signal: controller.signal }),
    ).rejects.toBe(reason);
    await expect(
      snapshotSelectedPolicyPackages(catalog, [{ name: "restricted-review", version: "1.2.3" }], {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("accepts an exact-size manifest and rejects the first excess byte", async () => {
    const exactProject = await temporaryProject();
    const exactSource = manifest("1.2.3").padEnd(MAX_POLICY_PACKAGE_MANIFEST_BYTES, " ");
    await writePolicy(exactProject, "restricted-review", exactSource);
    const exactCatalog = await discoverProjectPolicyPackages(exactProject);

    await expect(
      snapshotSelectedPolicyPackages(exactCatalog, [
        { name: "restricted-review", version: "1.2.3" },
      ]),
    ).resolves.toMatchObject({ packages: [{ name: "restricted-review", version: "1.2.3" }] });

    const oversizedProject = await temporaryProject();
    await writePolicy(oversizedProject, "restricted-review", `${exactSource} `);
    await expect(discoverProjectPolicyPackages(oversizedProject)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  });

  it("accepts the exact discovery depth and rejects the next nested directory", async () => {
    const exactProject = await temporaryProject();
    await writeNestedPolicy(exactProject, 5);
    await expect(discoverProjectPolicyPackages(exactProject)).resolves.toMatchObject({
      packages: [{ name: "restricted-review" }],
    });

    const deepProject = await temporaryProject();
    await writeNestedPolicy(deepProject, 6);
    await expect(discoverProjectPolicyPackages(deepProject)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  });

  it("accepts 2,000 discovery entries and rejects the next entry", async () => {
    const project = await temporaryProject();
    const root = join(project, ".flow", "policies");
    for (let index = 0; index < 2_000; index += 1) {
      await mkdir(join(root, `entry-${index.toString().padStart(4, "0")}`));
    }
    await expect(discoverProjectPolicyPackages(project)).resolves.toMatchObject({ packages: [] });

    await mkdir(join(root, "entry-2000"));
    await expect(discoverProjectPolicyPackages(project)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  }, 15_000);

  it("stops streaming directory traversal at the first excess entry", async () => {
    const project = await temporaryProject();
    let yielded = 0;

    await expect(
      discoverProjectPolicyPackages(project, {
        openDirectory: async () => ({
          async *[Symbol.asyncIterator]() {
            while (true) {
              yielded += 1;
              yield {
                name: `entry-${yielded}`,
                isBlockDevice: () => false,
                isCharacterDevice: () => false,
                isDirectory: () => true,
                isFIFO: () => false,
                isFile: () => false,
                isSocket: () => false,
                isSymbolicLink: () => false,
                parentPath: join(project, ".flow", "policies"),
                path: join(project, ".flow", "policies"),
              };
            }
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(yielded).toBe(2_001);
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

async function writeNestedPolicy(project: string, parentDepth: number): Promise<void> {
  const parents = Array.from({ length: parentDepth }, (_, index) => `group-${index}`);
  const directory = join(project, ".flow", "policies", ...parents, "restricted-review");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "POLICY.yaml"), manifest("1.2.3"));
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
