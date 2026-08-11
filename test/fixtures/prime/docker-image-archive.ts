import { createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function writeDockerArchiveFixture(bytes: Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-prime-image-archive-"));
  const path = join(root, "image.tar");
  await writeFile(path, bytes);
  return realpath(path);
}

export function createDockerImageArchive(layers: readonly Buffer[]): {
  readonly bytes: Buffer;
  readonly imageId: string;
} {
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

export function createDockerLayerTar(
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

export function createTarArchive(entries: Readonly<Record<string, Buffer>>): Buffer {
  return tar(entries);
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

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
