import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverProjectVerifierPackages,
  snapshotSelectedVerifierPackages,
} from "../../../src/infrastructure/fs/local-verifier-package-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local verifier package catalog", () => {
  it("discovers strict versioned command and model manifests and snapshots exact bytes", async () => {
    const project = await temporaryProject();
    await writeManifest(project, "release-tests", commandManifest("release-tests", "1.0.0"));
    await writeManifest(
      project,
      "groups/evidence-review",
      modelManifest("evidence-review", "1.2.0"),
    );

    const catalog = await discoverProjectVerifierPackages(project);

    expect(catalog.packages.map((item) => item.name)).toEqual(["evidence-review", "release-tests"]);
    expect(catalog.packages[0]).toMatchObject({
      name: "evidence-review",
      version: "1.2.0",
      definition: { kind: "model", prompt: "Reject unsupported claims." },
      provenance: ".flow/verifiers/groups/evidence-review",
      trust: "project-explicit",
    });

    const snapshot = await snapshotSelectedVerifierPackages(catalog, [
      { name: "release-tests", version: "1.0.0" },
      { name: "evidence-review", version: "1.2.0" },
    ]);

    expect(snapshot.packages.map((item) => `${item.kind}:${item.name}`)).toEqual([
      "verifier-package:evidence-review",
      "verifier-package:release-tests",
    ]);
    expect(snapshot.packages[0]).toMatchObject({
      kind: "verifier-package",
      manifest: {
        contentBase64: Buffer.from(modelManifest("evidence-review", "1.2.0")).toString("base64"),
      },
    });
  });

  it.each([
    {
      label: "unknown field",
      source: `${modelManifest("review", "1.0.0")}hooks: [run]
`,
    },
    {
      label: "non-exact version",
      source: modelManifest("review", "latest"),
    },
    {
      label: "numeric prerelease with a leading zero",
      source: modelManifest("review", "1.0.0-01"),
    },
    {
      label: "name mismatch",
      source: modelManifest("different", "1.0.0"),
    },
  ])("rejects an invalid manifest: $label", async ({ source }) => {
    const project = await temporaryProject();
    await writeManifest(project, "review", source);

    await expect(discoverProjectVerifierPackages(project)).rejects.toMatchObject({
      code: "invalid_package",
    });
  });

  it("rejects executable or symlinked package entries", async () => {
    const project = await temporaryProject();
    await writeManifest(project, "review", modelManifest("review", "1.0.0"));
    await writeFile(join(project, ".flow", "verifiers", "review", "run.js"), "process.exit(0)\n");

    await expect(discoverProjectVerifierPackages(project)).rejects.toMatchObject({
      code: "unsafe_entry",
    });

    await rm(join(project, ".flow", "verifiers", "review", "run.js"));
    const outside = join(project, "outside.yaml");
    await writeFile(outside, modelManifest("review", "1.0.0"));
    await rm(join(project, ".flow", "verifiers", "review", "VERIFIER.yaml"));
    await symlink(outside, join(project, ".flow", "verifiers", "review", "VERIFIER.yaml"));

    await expect(discoverProjectVerifierPackages(project)).rejects.toMatchObject({
      code: "unsafe_entry",
    });
  });

  it("rejects missing versions and manifests changed after discovery", async () => {
    const project = await temporaryProject();
    await writeManifest(project, "review", modelManifest("review", "1.0.0"));
    const catalog = await discoverProjectVerifierPackages(project);

    await expect(
      snapshotSelectedVerifierPackages(catalog, [{ name: "review", version: "2.0.0" }]),
    ).rejects.toMatchObject({ code: "version_mismatch" });

    await writeManifest(project, "review", modelManifest("review", "1.0.1"));
    await expect(
      snapshotSelectedVerifierPackages(catalog, [{ name: "review", version: "1.0.0" }]),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("normalizes an aggregate snapshot bound failure into a typed catalog error", async () => {
    const project = await temporaryProject();
    const references: Array<{ readonly name: string; readonly version: string }> = [];
    for (let index = 0; index < 24; index += 1) {
      const name = `review-${index}`;
      references.push({ name, version: "1.0.0" });
      await writeManifest(project, name, modelManifest(name, "1.0.0", "x".repeat(16_000)));
    }
    const catalog = await discoverProjectVerifierPackages(project);

    await expect(snapshotSelectedVerifierPackages(catalog, references)).rejects.toMatchObject({
      code: "invalid_package",
      message: expect.stringMatching(/snapshot|serialized/i),
    });
  });
});

async function temporaryProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-verifier-packages-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "verifiers"), { recursive: true });
  return project;
}

async function writeManifest(project: string, path: string, source: string): Promise<void> {
  const directory = join(project, ".flow", "verifiers", path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "VERIFIER.yaml"), source, "utf8");
}

function commandManifest(name: string, version: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: ${name}
  version: ${version}
  description: Run release tests.
  license: Apache-2.0
  compatibility: Requires Node.js.
spec:
  kind: command
  command:
    executable: npm
    args: [test]
    timeoutMs: 120000
`;
}

function modelManifest(
  name: string,
  version: string,
  prompt = "Reject unsupported claims.",
): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: ${name}
  version: ${version}
  description: Review declared evidence.
spec:
  kind: model
  prompt: ${prompt}
`;
}
