import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CapabilityRepositoryStoredFile } from "../../../../src/application/capability-repository-store.js";
import {
  CapabilityRepositoryRefreshError,
  createLocalCapabilityRepositoryRefresher,
} from "../../../../src/infrastructure/tuf/local-capability-repository-refresher.js";
import type { StagedTufRepositorySession } from "../../../../src/infrastructure/tuf/staged-tuf-repository.js";

const repositoryBaseUrl = "https://updates.example.test/repository/";

describe("local capability repository refresher", () => {
  it("seeds disposable TUF staging from authenticated state and releases it exactly", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "flow-repository-refresh-root-"));
    const root = storedFile("root.json", Buffer.from("TRUSTED_ROOT"));
    const stateReader = {
      readTrustedState: vi.fn(async () => ({ repositoryBaseUrl, metadata: [root] })),
    };
    const read = vi.fn();
    let stagingDirectory = "";
    const stagedSession: StagedTufRepositorySession = {
      readTarget: vi.fn(async (path) => ({
        path,
        source: `${repositoryBaseUrl}targets/aa/package.json`,
        length: 7,
        hashes: { sha256: "a".repeat(64) },
        custom: {},
        bytes: () => Buffer.from("content"),
      })),
      complete: vi.fn(async () => ({ metadata: [root] })),
    };
    const refreshRepository = vi.fn(async (input) => {
      stagingDirectory = input.stagingDirectory;
      await expect(stat(stagingDirectory)).resolves.toBeDefined();
      expect(input).toMatchObject({
        metadataBaseUrl: `${repositoryBaseUrl}metadata/`,
        targetBaseUrl: `${repositoryBaseUrl}targets/`,
        trustedMetadata: { "root.json": root.bytes() },
        read,
      });
      return stagedSession;
    });
    const refresher = createLocalCapabilityRepositoryRefresher({
      stateReader,
      fetcher: { read },
      temporaryRoot,
      refreshRepository,
    });
    const signal = new AbortController().signal;

    const session = await refresher.refresh(signal);
    await expect(session.readTarget("flow/capability-index.json", signal)).resolves.toMatchObject({
      path: "flow/capability-index.json",
    });
    await expect(session.complete(signal)).resolves.toEqual({ metadata: [root] });
    await session.release();
    await session.release();

    await expect(stat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stateReader.readTrustedState).toHaveBeenCalledWith(signal);
  });

  it("removes owned staging and closes a private preparation failure", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "flow-repository-refresh-root-"));
    const root = storedFile("root.json", Buffer.from("TRUSTED_ROOT"));
    let stagingDirectory = "";
    const refresher = createLocalCapabilityRepositoryRefresher({
      stateReader: {
        readTrustedState: vi.fn(async () => ({ repositoryBaseUrl, metadata: [root] })),
      },
      fetcher: { read: vi.fn() },
      temporaryRoot,
      refreshRepository: vi.fn(async (input) => {
        stagingDirectory = input.stagingDirectory;
        throw new Error("PRIVATE_PREPARATION_FAILURE");
      }),
    });

    let caught: unknown;
    try {
      await refresher.refresh(new AbortController().signal);
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new CapabilityRepositoryRefreshError("prepare repository refresh"));
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
    await expect(stat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function storedFile(name: string, content: Buffer): CapabilityRepositoryStoredFile {
  const copy = Buffer.from(content);
  return Object.freeze({
    name,
    length: copy.byteLength,
    digest: `sha256:${"a".repeat(64)}`,
    bytes: () => Buffer.from(copy),
  });
}
