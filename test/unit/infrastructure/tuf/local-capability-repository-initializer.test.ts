import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  CapabilityRepositoryStoredFile,
  PublicCapabilityRepositoryState,
} from "../../../../src/application/capability-repository-store.js";
import { CapabilityRepositoryStoreError } from "../../../../src/application/capability-repository-store.js";
import {
  CapabilityRepositoryInitializationError,
  createLocalCapabilityRepositoryInitializer,
} from "../../../../src/infrastructure/tuf/local-capability-repository-initializer.js";

const repositoryBaseUrl = "https://updates.example.test/repository/";

describe("local capability repository initializer", () => {
  it("validates an explicit root offline and publishes the reopened root", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "flow-repository-init-root-"));
    const trustedRoot = Buffer.from("EXPLICIT_TRUSTED_ROOT");
    const reopened = storedFile("root.json", trustedRoot);
    let stagingDirectory = "";
    const validateTrustedRoot = vi.fn(async (input) => {
      stagingDirectory = input.stagingDirectory;
      expect(input.trustedRoot).toEqual(trustedRoot);
      await expect(stat(stagingDirectory)).resolves.toBeDefined();
      return reopened;
    });
    const initializedState = publicState();
    const store = {
      initialize: vi.fn(async () => initializedState),
    };
    const initializer = createLocalCapabilityRepositoryInitializer({
      store,
      temporaryRoot,
      now: () => new Date("2026-08-17T01:02:03.004Z"),
      validateTrustedRoot,
    });
    const signal = new AbortController().signal;

    await expect(
      initializer.initialize({ repositoryBaseUrl, trustedRoot, signal }),
    ).resolves.toEqual(initializedState);

    expect(validateTrustedRoot).toHaveBeenCalledTimes(1);
    expect(store.initialize).toHaveBeenCalledWith({
      repositoryBaseUrl,
      initializedAt: "2026-08-17T01:02:03.004Z",
      trustedRoot: reopened,
      signal,
    });
    await expect(stat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish and removes staging after private root-validation failure", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "flow-repository-init-root-"));
    let stagingDirectory = "";
    const store = { initialize: vi.fn() };
    const initializer = createLocalCapabilityRepositoryInitializer({
      store,
      temporaryRoot,
      now: () => new Date("2026-08-17T01:02:03.004Z"),
      validateTrustedRoot: vi.fn(async (input) => {
        stagingDirectory = input.stagingDirectory;
        throw new Error("PRIVATE_ROOT_FAILURE");
      }),
    });

    let caught: unknown;
    try {
      await initializer.initialize({
        repositoryBaseUrl,
        trustedRoot: Buffer.from("PRIVATE_ROOT_BYTES"),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new CapabilityRepositoryInitializationError("validate trusted root"));
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
    expect(store.initialize).not.toHaveBeenCalled();
    await expect(stat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves durable-store settlement uncertainty after validation", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "flow-repository-init-root-"));
    const settlement = new CapabilityRepositoryStoreError("settle repository store commit");
    const initializer = createLocalCapabilityRepositoryInitializer({
      store: {
        initialize: vi.fn(async () => {
          throw settlement;
        }),
      },
      temporaryRoot,
      now: () => new Date("2026-08-17T01:02:03.004Z"),
      validateTrustedRoot: vi.fn(async () => storedFile("root.json", Buffer.from("TRUSTED_ROOT"))),
    });

    await expect(
      initializer.initialize({ repositoryBaseUrl, trustedRoot: Buffer.from("TRUSTED_ROOT") }),
    ).rejects.toBe(settlement);
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

function publicState(): PublicCapabilityRepositoryState {
  return Object.freeze({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "CapabilityRepositoryState",
    status: "initialized",
    generationDigest: `sha256:${"b".repeat(64)}`,
    repositoryStateDigest: `sha256:${"c".repeat(64)}`,
    initializedAt: "2026-08-17T01:02:03.004Z",
    metadata: Object.freeze([]),
    candidates: Object.freeze([]),
  });
}
