import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalPrimeOciFixtureSource,
  StagedPrimeOciResultSink,
} from "../../../../src/infrastructure/oci/local-prime-workspace-transfer.js";
import {
  createPrimeContainerManifestSha256,
  type PrimeContainerManifestEntry,
} from "../../../../src/infrastructure/prime/prime-container-protocol.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local Prime workspace fixture source", () => {
  it("streams one stable no-follow fixture with normalized modes", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src"), { mode: 0o755 });
    await writeFile(join(root, "TASK.md"), "Task\n", { mode: 0o640 });
    await writeFile(join(root, "src", "a.txt"), "abc", { mode: 0o600 });
    await chmod(join(root, "TASK.md"), 0o640);
    await chmod(join(root, "src"), 0o755);
    await chmod(join(root, "src", "a.txt"), 0o600);
    const expectedEntries: PrimeContainerManifestEntry[] = [
      fileEntry("TASK.md", "Task\n", 0o640),
      { path: "src", type: "directory", mode: 0o755 },
      fileEntry("src/a.txt", "abc", 0o600),
    ];

    const source = await createLocalPrimeOciFixtureSource({
      root,
      instructionPath: "TASK.md",
      expectedSnapshotDigest: createPrimeContainerManifestSha256(expectedEntries),
    });
    const parts = [];
    for await (const part of source.parts()) {
      parts.push(part);
    }

    expect(source.instructionText).toBe("Task\n");
    expect(source.start).toEqual({
      entryCount: 3,
      totalBytes: 8,
      manifestSha256: createPrimeContainerManifestSha256(expectedEntries),
    });
    expect(parts.filter((part) => part.type === "entry").map((part) => part.entry)).toEqual(
      expectedEntries,
    );
    expect(
      Buffer.concat(
        parts.flatMap((part) => (part.type === "chunk" ? [Buffer.from(part.bytes)] : [])),
      ).toString("utf8"),
    ).toBe("Task\nabc");
  });

  it("rejects links and source changes before it sends changed bytes", async () => {
    const linkedRoot = await temporaryDirectory();
    await writeFile(join(linkedRoot, "outside.txt"), "secret");
    await symlink(join(linkedRoot, "outside.txt"), join(linkedRoot, "TASK.md"));
    await expect(
      createLocalPrimeOciFixtureSource({
        root: linkedRoot,
        instructionPath: "TASK.md",
        expectedSnapshotDigest: "0".repeat(64),
      }),
    ).rejects.toThrow(/symbolic link/i);

    const changedRoot = await temporaryDirectory();
    await writeFile(join(changedRoot, "TASK.md"), "Task\n");
    const entries = [
      fileEntry("TASK.md", "Task\n", (await lstat(join(changedRoot, "TASK.md"))).mode & 0o777),
    ];
    const source = await createLocalPrimeOciFixtureSource({
      root: changedRoot,
      instructionPath: "TASK.md",
      expectedSnapshotDigest: createPrimeContainerManifestSha256(entries),
    });
    await writeFile(join(changedRoot, "TASK.md"), "Changed\n");

    await expect(collect(source.parts())).rejects.toThrow(/changed/i);
  });
});

describe("staged Prime workspace result sink", () => {
  it("publishes only one complete validated staging tree", async () => {
    const parent = await temporaryDirectory();
    const targetRoot = join(parent, "workspace");
    await mkdir(targetRoot);
    const entry = fileEntry("RESULT.md", "DONE\n", 0o640);
    const prepareStaging = vi.fn(async (input) => {
      await expect(lstat(input.stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
    const publish = vi.fn(async (input) => {
      expect(input.targetRoot).toBe(targetRoot);
      expect(await readFile(join(input.stagingRoot, "RESULT.md"), "utf8")).toBe("DONE\n");
      expect((await lstat(join(input.stagingRoot, "RESULT.md"))).mode & 0o777).toBe(0o600);
    });
    const sink = new StagedPrimeOciResultSink({ targetRoot, prepareStaging, publish });

    await sink.begin({
      entryCount: 1,
      totalBytes: 5,
      manifestSha256: createPrimeContainerManifestSha256([entry]),
    });
    expect(prepareStaging).toHaveBeenCalledOnce();
    await sink.addEntry(entry);
    await sink.addChunk(Buffer.from("DONE\n"));
    await sink.endFile();
    expect(publish).not.toHaveBeenCalled();

    await sink.commit([entry]);

    expect(publish).not.toHaveBeenCalled();
    await sink.publishResult();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("removes private staging data after an aborted transfer", async () => {
    const parent = await temporaryDirectory();
    const targetRoot = join(parent, "workspace");
    await mkdir(targetRoot);
    const entry = fileEntry("RESULT.md", "DONE\n", 0o640);
    const publish = vi.fn();
    const sink = new StagedPrimeOciResultSink({ targetRoot, publish });
    await sink.begin({
      entryCount: 1,
      totalBytes: 5,
      manifestSha256: createPrimeContainerManifestSha256([entry]),
    });
    await sink.addEntry(entry);
    await sink.addChunk(Buffer.from("DO"));
    const stagingRoot = sink.stagingRoot;

    await sink.abort(new Error("transfer failed"));

    expect(stagingRoot).toBeDefined();
    await expect(lstat(stagingRoot ?? "")).rejects.toMatchObject({ code: "ENOENT" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("treats a successful publisher return as a committed result", async () => {
    const parent = await temporaryDirectory();
    const targetRoot = join(parent, "workspace");
    await mkdir(targetRoot);
    const entry = fileEntry("RESULT.md", "DONE\n", 0o640);
    const controller = new AbortController();
    const publish = vi.fn(async () => {
      controller.abort(new Error("cleanup grace expired after durable publication"));
    });
    const sink = new StagedPrimeOciResultSink({ targetRoot, publish });
    await sink.begin({
      entryCount: 1,
      totalBytes: 5,
      manifestSha256: createPrimeContainerManifestSha256([entry]),
    });
    await sink.addEntry(entry);
    await sink.addChunk(Buffer.from("DONE\n"));
    await sink.endFile();
    await sink.commit([entry]);

    await expect(sink.publishResult(controller.signal)).resolves.toBeUndefined();

    expect(publish).toHaveBeenCalledOnce();
    expect(sink.stagingRoot).toBeUndefined();
    await expect(sink.publishResult()).rejects.toThrow(/no complete staging tree/i);
  });

  it("does not commit a staging tree after cancellation", async () => {
    const parent = await temporaryDirectory();
    const targetRoot = join(parent, "workspace");
    await mkdir(targetRoot);
    const entry = fileEntry("RESULT.md", "DONE\n", 0o640);
    const sink = new StagedPrimeOciResultSink({ targetRoot, publish: vi.fn() });
    await sink.begin({
      entryCount: 1,
      totalBytes: 5,
      manifestSha256: createPrimeContainerManifestSha256([entry]),
    });
    await sink.addEntry(entry);
    await sink.addChunk(Buffer.from("DONE\n"));
    await sink.endFile();
    const controller = new AbortController();
    controller.abort(new Error("result commit cancelled"));

    await expect(sink.commit([entry], controller.signal)).rejects.toThrow(/commit cancelled/i);
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-prime-transfer-"));
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

async function collect(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _part of iterable) {
    // Consume all parts to trigger the complete stability check.
  }
}
