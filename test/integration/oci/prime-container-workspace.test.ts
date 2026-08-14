import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DurablePrimeWorkspacePublisher } from "../../../src/infrastructure/oci/durable-prime-workspace-publisher.js";
import { StagedPrimeOciResultSink } from "../../../src/infrastructure/oci/local-prime-workspace-transfer.js";
import {
  createPrimeContainerManifestSha256,
  type PrimeContainerManifestEntry,
} from "../../../src/infrastructure/prime/prime-container-protocol.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Prime container workspace replacement", () => {
  it("applies one exact result tree with modes, deletions, renames, and type changes", async () => {
    const parent = await temporaryDirectory();
    const targetRoot = join(parent, "workspace");
    await mkdir(join(targetRoot, "old-directory"), { recursive: true });
    await writeFile(join(targetRoot, "DELETE.md"), "remove me\n");
    await writeFile(join(targetRoot, "old-directory", "old.txt"), "old\n");
    await writeFile(join(targetRoot, "changed-type"), "old file\n");

    const entries: readonly PrimeContainerManifestEntry[] = [
      { path: "changed-type", type: "directory", mode: 0o750 },
      fileEntry("changed-type/child.txt", "child\n", 0o640),
      { path: "locked", type: "directory", mode: 0o000 },
      fileEntry("locked/value.txt", "private\n", 0o400),
      fileEntry("renamed.txt", "old\n", 0o600),
    ];
    const publisher = new DurablePrimeWorkspacePublisher();
    const sink = new StagedPrimeOciResultSink({
      targetRoot,
      publish: (input) => publisher.publish(input),
    });

    await sink.begin({
      entryCount: entries.length,
      totalBytes: entries.reduce(
        (total, entry) => total + (entry.type === "file" ? entry.size : 0),
        0,
      ),
      manifestSha256: createPrimeContainerManifestSha256(entries),
    });
    for (const entry of entries) {
      await sink.addEntry(entry);
      if (entry.type === "file") {
        await sink.addChunk(contentFor(entry.path));
        await sink.endFile();
      }
    }
    await sink.commit(entries);
    await sink.publishResult();

    await expect(readFile(join(targetRoot, "DELETE.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(targetRoot, "old-directory", "old.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(join(targetRoot, "changed-type"))).isDirectory()).toBe(true);
    await expect(readFile(join(targetRoot, "changed-type", "child.txt"), "utf8")).resolves.toBe(
      "child\n",
    );
    await expect(readFile(join(targetRoot, "renamed.txt"), "utf8")).resolves.toBe("old\n");
    expect((await lstat(join(targetRoot, "changed-type"))).mode & 0o777).toBe(0o750);
    expect((await lstat(join(targetRoot, "renamed.txt"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(targetRoot, "locked"))).mode & 0o777).toBe(0o000);

    await chmod(join(targetRoot, "locked"), 0o700);
    expect((await lstat(join(targetRoot, "locked", "value.txt"))).mode & 0o777).toBe(0o400);
    await expect(readFile(join(targetRoot, "locked", "value.txt"), "utf8")).resolves.toBe(
      "private\n",
    );
    const published = await lstat(join(targetRoot, "renamed.txt"));
    expect(published.uid).toBe(process.getuid?.());
    expect(published.gid).toBe(process.getgid?.());
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-prime-workspace-integration-"));
  temporaryDirectories.push(root);
  return root;
}

function fileEntry(path: string, content: string, mode: number): PrimeContainerManifestEntry {
  const bytes = Buffer.from(content);
  return {
    path,
    type: "file",
    mode,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function contentFor(path: string): Buffer {
  switch (path) {
    case "changed-type/child.txt":
      return Buffer.from("child\n");
    case "locked/value.txt":
      return Buffer.from("private\n");
    case "renamed.txt":
      return Buffer.from("old\n");
    default:
      throw new Error(`missing integration content for ${path}`);
  }
}
