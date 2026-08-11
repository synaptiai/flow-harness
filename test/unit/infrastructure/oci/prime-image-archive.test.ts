import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  inspectPrimeImageArchive,
  PrimeImageArchiveInspectionError,
} from "../../../../src/infrastructure/oci/prime-image-archive.js";
import {
  createTarArchive,
  createDockerImageArchive as dockerArchive,
  createDockerLayerTar as layerTar,
  writeDockerArchiveFixture as writeArchive,
} from "../../../fixtures/prime/docker-image-archive.js";

describe("Prime image archive", () => {
  it("creates an external package inventory from ordered image layers", async () => {
    const sbom = {
      node: [{ name: "selected-package", version: "1.2.3" }],
      python: [{ name: "selected-python", version: "4.5.6" }],
    };
    const archive = dockerArchive([
      layerTar(
        {
          "opt/flow/node/node_modules/selected/package.json": JSON.stringify({
            name: "selected-package",
            version: "1.2.3",
          }),
          "opt/flow/node/node_modules/removed/package.json": JSON.stringify({
            name: "removed-package",
            version: "9.9.9",
          }),
        },
        ["opt", "opt/flow", "opt/flow/node"],
      ),
      layerTar({
        "opt/flow/node/node_modules/removed/.wh.package.json": "",
        "opt/flow/python/lib/python3.11/site-packages/selected_python-4.5.6.dist-info/METADATA":
          "Name: selected-python\nVersion: 4.5.6\n",
      }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    const inspected = await inspectPrimeImageArchive({
      archivePath,
      imageId: archive.imageId,
    });

    expect(inspected.sbom).toEqual(sbom);
    expect(inspected.sbomSha256).toBe(sha256(canonicalize(sbom)));
    expect(inspected.layerSha256).toHaveLength(2);
  });

  it("rejects a secret that a later layer deletes", async () => {
    const archive = dockerArchive([
      layerTar({ "run/private-token": "-----BEGIN PRIVATE KEY-----\nprivate\n" }),
      layerTar({ "run/.wh.private-token": "" }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).rejects.toMatchObject({
      name: "PrimeImageArchiveInspectionError",
      stage: "scan image archive private keys",
      cause: expect.objectContaining({ message: expect.stringMatching(/secret/i) }),
    });
  });

  it.each([
    ["GitHub", `ghp_${"g".repeat(36)}`, "scan image archive GitHub tokens"],
    ["npm", `npm_${"n".repeat(36)}`, "scan image archive npm tokens"],
    [
      "synthetic sentinel",
      "FLOW_PRIME_FORBIDDEN_SECRET_fixture",
      "scan image archive synthetic secrets",
    ],
  ] as const)("classifies %s secret patterns", async (_label, token, stage) => {
    const archive = dockerArchive([layerTar({ "opt/flow/fixture.txt": token })]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).rejects.toMatchObject({ stage });
  });

  it("allows only the canonical AWS documentation access key example", async () => {
    const documentedExample = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/aws-example/index.d.ts": 'AccessKeyId: "AKIAIOSFODNN7EXAMPLE"',
      }),
    ]);
    const documentedExamplePath = await writeArchive(documentedExample.bytes);

    await expect(
      inspectPrimeImageArchive({
        archivePath: documentedExamplePath,
        imageId: documentedExample.imageId,
      }),
    ).resolves.toMatchObject({ archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const otherAccessKey = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/other-key/index.d.ts": 'AccessKeyId: "AKIA000000000EXAMPLE"',
      }),
    ]);
    const otherAccessKeyPath = await writeArchive(otherAccessKey.bytes);

    await expect(
      inspectPrimeImageArchive({
        archivePath: otherAccessKeyPath,
        imageId: otherAccessKey.imageId,
      }),
    ).rejects.toMatchObject({
      stage: "scan image archive AWS access keys",
      cause: expect.objectContaining({ message: expect.stringMatching(/secret/i) }),
    });

    const mixedBoundaryKeys = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/mixed-keys/index.d.ts": `AKIAIOSFODNN7EXAMPLE\n${"x".repeat(65_511)}AKIA1234567890ABCDEF`,
      }),
    ]);
    const mixedBoundaryKeysPath = await writeArchive(mixedBoundaryKeys.bytes);

    await expect(
      inspectPrimeImageArchive({
        archivePath: mixedBoundaryKeysPath,
        imageId: mixedBoundaryKeys.imageId,
      }),
    ).rejects.toMatchObject({ stage: "scan image archive AWS access keys" });
  });

  it("rejects an archive whose configuration bytes do not match the image ID", async () => {
    const archive = dockerArchive([layerTar({})]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: `sha256:${"f".repeat(64)}` }),
    ).rejects.toMatchObject({
      name: "PrimeImageArchiveInspectionError",
      stage: "verify image archive configuration",
      cause: expect.objectContaining({ message: expect.stringMatching(/configuration.*digest/i) }),
    });
  });

  it("classifies noncanonical archive input", async () => {
    const archive = dockerArchive([layerTar({})]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: "invalid" }),
    ).rejects.toMatchObject({ stage: "open image archive" });
  });

  it("classifies a missing Docker archive manifest", async () => {
    const archivePath = await writeArchive(createTarArchive({ "other.json": Buffer.from("{}\n") }));

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: `sha256:${"a".repeat(64)}` }),
    ).rejects.toMatchObject({ stage: "read image archive manifest" });
  });

  it("classifies invalid package inventory metadata", async () => {
    const archive = dockerArchive([
      layerTar({ "opt/flow/node/node_modules/invalid/package.json": "{" }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).rejects.toMatchObject({ stage: "inventory image archive packages" });
  });

  it("classifies archive mutation during the final stability observation", async () => {
    const archive = dockerArchive([layerTar({})]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive(
        { archivePath, imageId: archive.imageId },
        {
          beforeStabilityObservation: async () => {
            await appendFile(archivePath, Buffer.from("changed"));
          },
        },
      ),
    ).rejects.toMatchObject({
      stage: "verify image archive stability",
      cause: expect.objectContaining({ message: "Prime image archive changed while inspected" }),
    });
  });

  it("classifies a close failure as archive stability evidence", async () => {
    const archive = dockerArchive([layerTar({})]);
    const archivePath = await writeArchive(archive.bytes);
    const closeFailure = new Error("private delayed close failure");

    await expect(
      inspectPrimeImageArchive(
        { archivePath, imageId: archive.imageId },
        {
          closeArchive: async (handle) => {
            await handle.close();
            throw closeFailure;
          },
        },
      ),
    ).rejects.toMatchObject({
      stage: "verify image archive stability",
      cause: closeFailure,
    });
  });

  it("preserves a primary phase when archive close also fails", async () => {
    const archive = dockerArchive([
      layerTar({ "run/private-token": "-----BEGIN PRIVATE KEY-----\nprivate\n" }),
    ]);
    const archivePath = await writeArchive(archive.bytes);
    const closeFailure = new Error("private close failure after scan failure");

    await expect(
      inspectPrimeImageArchive(
        { archivePath, imageId: archive.imageId },
        {
          closeArchive: async (handle) => {
            await handle.close();
            throw closeFailure;
          },
        },
      ),
    ).rejects.toMatchObject({
      stage: "scan image archive private keys",
      cause: expect.objectContaining({
        errors: [
          expect.objectContaining({ stage: "scan image archive private keys" }),
          closeFailure,
        ],
      }),
    });
  });

  it("uses a closed public diagnostic for archive inspection failures", () => {
    expect(
      new PrimeImageArchiveInspectionError("read image archive manifest", new Error("private")),
    ).toMatchObject({
      message: "Prime image archive inspection failed during read image archive manifest",
      stage: "read image archive manifest",
    });
  });
});

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
