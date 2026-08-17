import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  refreshStagedTufRepository,
  StagedTufRepositoryError,
} from "../../../src/infrastructure/tuf/staged-tuf-repository.js";

const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/tuf-conformance/tuf-on-ci-0.11",
);
const METADATA_BASE = "https://tuf-conformance.example/metadata/";
const TARGET_BASE = "https://tuf-conformance.example/targets/";
const TARGET_PATH = "delegatedrole/artifact";
const TARGET_DIGEST = "45f337ee451b4c098d121d09cc224bacc7794503ac58a47a78cfe7ebefb7fab3";

describe("official TUF conformance fixture", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map(async (path) => await rm(path, { recursive: true, force: true })),
    );
  });

  it("resolves an independently signed delegated target through Flow staging", async () => {
    const stagingDirectory = await mkdtemp(join(tmpdir(), "flow-tuf-conformance-"));
    temporaryRoots.push(stagingDirectory);
    const trustedRoot = await readFile(join(FIXTURE_ROOT, "initial_root.json"));
    const expectedTarget = await readFile(
      join(FIXTURE_ROOT, "targets", "delegatedrole", `${TARGET_DIGEST}.artifact`),
    );
    const remote = new Map<string, Buffer>([
      [
        `${METADATA_BASE}timestamp.json`,
        await readFile(join(FIXTURE_ROOT, "metadata", "timestamp.json")),
      ],
      [
        `${METADATA_BASE}2.snapshot.json`,
        await readFile(join(FIXTURE_ROOT, "metadata", "2.snapshot.json")),
      ],
      [
        `${METADATA_BASE}1.targets.json`,
        await readFile(join(FIXTURE_ROOT, "metadata", "1.targets.json")),
      ],
      [
        `${METADATA_BASE}2.delegatedrole.json`,
        await readFile(join(FIXTURE_ROOT, "metadata", "2.delegatedrole.json")),
      ],
      [`${TARGET_BASE}delegatedrole/${TARGET_DIGEST}.artifact`, expectedTarget],
    ]);
    const requested: string[] = [];

    const session = await refreshStagedTufRepository({
      stagingDirectory,
      metadataBaseUrl: METADATA_BASE,
      targetBaseUrl: TARGET_BASE,
      trustedMetadata: { "root.json": trustedRoot },
      read: async (url, maximumBytes, signal) => {
        signal.throwIfAborted();
        requested.push(url);
        const content = remote.get(url);
        if (content === undefined) {
          return { statusCode: 404, bytes: Buffer.alloc(0) };
        }
        expect(content.byteLength).toBeLessThanOrEqual(maximumBytes);
        return { statusCode: 200, bytes: Buffer.from(content) };
      },
    });

    const target = await session.readTarget(TARGET_PATH);
    const completed = await session.complete();

    expect(target).toMatchObject({
      path: TARGET_PATH,
      source: `${TARGET_BASE}delegatedrole/${TARGET_DIGEST}.artifact`,
      length: expectedTarget.byteLength,
      hashes: { sha256: TARGET_DIGEST },
    });
    expect(target.bytes()).toEqual(expectedTarget);
    expect(sha256(target.bytes())).toBe(TARGET_DIGEST);
    expect(completed.metadata.map(({ name }) => name)).toEqual([
      "delegatedrole.json",
      "root.json",
      "snapshot.json",
      "targets.json",
      "timestamp.json",
    ]);
    expect(requested).toContain(`${METADATA_BASE}2.delegatedrole.json`);
    expect(requested).toContain(`${TARGET_BASE}delegatedrole/${TARGET_DIGEST}.artifact`);
  });

  it("keeps an out-of-scope delegated target unavailable", async () => {
    const stagingDirectory = await mkdtemp(join(tmpdir(), "flow-tuf-conformance-"));
    temporaryRoots.push(stagingDirectory);
    const trustedRoot = await readFile(join(FIXTURE_ROOT, "initial_root.json"));
    const remote = new Map<string, Buffer>([
      [
        `${METADATA_BASE}timestamp.json`,
        await readFile(join(FIXTURE_ROOT, "metadata", "timestamp.json")),
      ],
      [
        `${METADATA_BASE}2.snapshot.json`,
        await readFile(join(FIXTURE_ROOT, "metadata", "2.snapshot.json")),
      ],
      [
        `${METADATA_BASE}1.targets.json`,
        await readFile(join(FIXTURE_ROOT, "metadata", "1.targets.json")),
      ],
    ]);
    const session = await refreshStagedTufRepository({
      stagingDirectory,
      metadataBaseUrl: METADATA_BASE,
      targetBaseUrl: TARGET_BASE,
      trustedMetadata: { "root.json": trustedRoot },
      read: async (url) => {
        const content = remote.get(url);
        return content === undefined
          ? { statusCode: 404, bytes: Buffer.alloc(0) }
          : { statusCode: 200, bytes: Buffer.from(content) };
      },
    });

    await expect(session.readTarget("outside/artifact")).rejects.toEqual(
      new StagedTufRepositoryError("resolve target"),
    );
  });
});

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
