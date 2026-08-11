import { createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectPrimeImageArchive } from "../../../../src/infrastructure/oci/prime-image-archive.js";

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
    ).rejects.toThrow(/secret/i);
  });

  it("rejects an archive whose configuration bytes do not match the image ID", async () => {
    const archive = dockerArchive([layerTar({})]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: `sha256:${"f".repeat(64)}` }),
    ).rejects.toThrow(/configuration.*digest/i);
  });
});

async function writeArchive(bytes: Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-prime-image-archive-"));
  const path = join(root, "image.tar");
  await writeFile(path, bytes);
  return realpath(path);
}

function dockerArchive(layers: readonly Buffer[]): { bytes: Buffer; imageId: string } {
  const configuration = Buffer.from('{"architecture":"amd64","os":"linux"}\n');
  const configurationSha256 = sha256(configuration);
  const layerEntries = Object.fromEntries(
    layers.map((layer, index) => [`layer-${index}/layer.tar`, layer]),
  );
  const manifest = Buffer.from(
    `${JSON.stringify([
      {
        Config: `${configurationSha256}.json`,
        RepoTags: null,
        Layers: Object.keys(layerEntries),
      },
    ])}\n`,
  );
  return {
    bytes: tar({
      [`${configurationSha256}.json`]: configuration,
      "manifest.json": manifest,
      ...layerEntries,
    }),
    imageId: `sha256:${configurationSha256}`,
  };
}

function layerTar(
  entries: Readonly<Record<string, string>>,
  directories: readonly string[] = [],
): Buffer {
  return tar(
    Object.fromEntries([
      ...directories.map((path) => [`${path}/`, { content: Buffer.alloc(0), type: "5" }] as const),
      ...Object.entries(entries).map(([path, value]) => [path, Buffer.from(value)] as const),
    ]),
  );
}

function tar(
  entries: Readonly<Record<string, Buffer | { readonly content: Buffer; readonly type: string }>>,
): Buffer {
  const parts: Buffer[] = [];
  for (const [path, fixture] of Object.entries(entries)) {
    const content = Buffer.isBuffer(fixture) ? fixture : fixture.content;
    const type = Buffer.isBuffer(fixture) ? "0" : fixture.type;
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, content.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(type, 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "binary");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    parts.push(header, content, Buffer.alloc((512 - (content.byteLength % 512)) % 512));
  }
  parts.push(Buffer.alloc(1_024));
  return Buffer.concat(parts);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  target.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

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
