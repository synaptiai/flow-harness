import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RenderedPublicCapabilityReference } from "../../../../src/application/public-capability-reference.js";
import {
  PUBLIC_CAPABILITY_REFERENCE_PATHS,
  PublicCapabilityReferenceDriftError,
  verifyPublicCapabilityReferenceFiles,
  writePublicCapabilityReferenceFiles,
} from "../../../../src/infrastructure/fs/public-capability-reference-files.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("public capability reference files", () => {
  it("writes byte-identical artifacts on repeated generation", async () => {
    const root = await temporaryRoot();
    const rendered = reference("one");

    await writePublicCapabilityReferenceFiles(root, rendered);
    const first = await readArtifacts(root);
    await writePublicCapabilityReferenceFiles(root, rendered);

    expect(await readArtifacts(root)).toEqual(first);
  });

  it("verifies stale references without changing committed bytes or timestamps", async () => {
    const root = await temporaryRoot();
    await writePublicCapabilityReferenceFiles(root, reference("committed"));
    const before = await artifactState(root);

    await expect(
      verifyPublicCapabilityReferenceFiles(root, reference("changed")),
    ).rejects.toMatchObject({
      name: "PublicCapabilityReferenceDriftError",
      stalePaths: [
        PUBLIC_CAPABILITY_REFERENCE_PATHS.json,
        PUBLIC_CAPABILITY_REFERENCE_PATHS.markdown,
      ],
    });

    expect(await artifactState(root)).toEqual(before);
  });

  it.each(["tool", "schema", "limit", "capability-family", "provider-seam"])(
    "detects %s drift",
    async (driftClass) => {
      const root = await temporaryRoot();
      await writePublicCapabilityReferenceFiles(root, reference("committed"));

      await expect(
        verifyPublicCapabilityReferenceFiles(root, reference(`changed-${driftClass}`)),
      ).rejects.toBeInstanceOf(PublicCapabilityReferenceDriftError);
    },
  );

  it("restores the first artifact when the second replacement fails", async () => {
    const root = await temporaryRoot();
    await writePublicCapabilityReferenceFiles(root, reference("committed"));
    const before = await readArtifacts(root);
    let renameCalls = 0;

    await expect(
      writePublicCapabilityReferenceFiles(root, reference("changed"), {
        rename: async (source, destination) => {
          renameCalls += 1;
          if (renameCalls === 2) {
            throw new Error("injected second replacement failure");
          }
          const { rename } = await import("node:fs/promises");
          await rename(source, destination);
        },
      }),
    ).rejects.toThrow(/injected second replacement failure/u);

    expect(await readArtifacts(root)).toEqual(before);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-public-reference-"));
  temporaryDirectories.push(root);
  return root;
}

function reference(value: string): RenderedPublicCapabilityReference {
  return Object.freeze({
    json: `${JSON.stringify({ version: "flow.public-capabilities/v1", value }, null, 2)}\n`,
    markdown: `<!-- Generated file. Do not edit directly. -->\n\n# ${value}\n`,
  });
}

async function readArtifacts(root: string) {
  return {
    json: await readFile(join(root, PUBLIC_CAPABILITY_REFERENCE_PATHS.json), "utf8"),
    markdown: await readFile(join(root, PUBLIC_CAPABILITY_REFERENCE_PATHS.markdown), "utf8"),
  };
}

async function artifactState(root: string) {
  const paths = [
    join(root, PUBLIC_CAPABILITY_REFERENCE_PATHS.json),
    join(root, PUBLIC_CAPABILITY_REFERENCE_PATHS.markdown),
  ];
  const contents = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const metadata = await Promise.all(paths.map((path) => stat(path)));
  return paths.map((path, index) => ({
    path,
    content: contents[index],
    modifiedMilliseconds: metadata[index]?.mtimeMs,
  }));
}
