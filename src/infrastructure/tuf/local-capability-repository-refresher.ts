import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityRepositoryTrustedState,
  CapabilityRepositoryTrustedStateReader,
} from "../../application/capability-repository-store.js";
import type {
  CapabilityRepositoryCheckSession,
  CapabilityRepositoryRefresher,
} from "../../application/check-capability-repository.js";
import type { StrictCapabilityRepositoryFetcher } from "../http/strict-capability-repository-fetcher.js";
import {
  type RefreshStagedTufRepositoryInput,
  refreshStagedTufRepository,
} from "./staged-tuf-repository.js";

export type CapabilityRepositoryRefreshStage =
  | "read trusted repository state"
  | "prepare repository refresh"
  | "release repository refresh";

export class CapabilityRepositoryRefreshError extends Error {
  override readonly name = "CapabilityRepositoryRefreshError";
  readonly code = "capability_repository_refresh_failed" as const;

  constructor(readonly stage: CapabilityRepositoryRefreshStage) {
    super(`Capability repository refresh failed during ${stage}`);
  }
}

export interface LocalCapabilityRepositoryRefresherOptions {
  readonly stateReader: CapabilityRepositoryTrustedStateReader;
  readonly fetcher: StrictCapabilityRepositoryFetcher;
  readonly temporaryRoot?: string;
  readonly refreshRepository?: (
    input: RefreshStagedTufRepositoryInput,
  ) => ReturnType<typeof refreshStagedTufRepository>;
}

export function createLocalCapabilityRepositoryRefresher(
  options: LocalCapabilityRepositoryRefresherOptions,
): CapabilityRepositoryRefresher {
  const refreshRepository = options.refreshRepository ?? refreshStagedTufRepository;

  return Object.freeze({
    async refresh(signal: AbortSignal): Promise<CapabilityRepositoryCheckSession> {
      signal.throwIfAborted();
      const trustedState = await readTrustedState(options.stateReader, signal);
      signal.throwIfAborted();

      let stagingDirectory: string | undefined;
      try {
        stagingDirectory = await mkdtemp(
          join(options.temporaryRoot ?? tmpdir(), "flow-repository-refresh-"),
        );
        signal.throwIfAborted();
        const staged = await refreshRepository({
          stagingDirectory,
          metadataBaseUrl: new URL("metadata/", trustedState.repositoryBaseUrl).toString(),
          targetBaseUrl: new URL("targets/", trustedState.repositoryBaseUrl).toString(),
          trustedMetadata: toTrustedMetadata(trustedState),
          read: options.fetcher.read,
          signal,
        });
        signal.throwIfAborted();
        return createRefreshSession(staged, stagingDirectory);
      } catch (error) {
        if (stagingDirectory !== undefined) {
          await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
        if (signal.aborted) {
          throw signal.reason;
        }
        if (error instanceof CapabilityRepositoryRefreshError) {
          throw error;
        }
        throw new CapabilityRepositoryRefreshError("prepare repository refresh");
      }
    },
  });
}

async function readTrustedState(
  stateReader: CapabilityRepositoryTrustedStateReader,
  signal: AbortSignal,
): Promise<CapabilityRepositoryTrustedState> {
  try {
    const state = await stateReader.readTrustedState(signal);
    signal.throwIfAborted();
    return state;
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason;
    }
    if (error instanceof CapabilityRepositoryRefreshError) {
      throw error;
    }
    throw new CapabilityRepositoryRefreshError("read trusted repository state");
  }
}

function toTrustedMetadata(
  state: CapabilityRepositoryTrustedState,
): Readonly<Record<string, Uint8Array>> {
  return Object.freeze(
    Object.fromEntries(state.metadata.map((file) => [file.name, file.bytes()] as const)),
  );
}

function createRefreshSession(
  staged: Awaited<ReturnType<typeof refreshStagedTufRepository>>,
  stagingDirectory: string,
): CapabilityRepositoryCheckSession {
  let released = false;
  let releasePromise: Promise<void> | undefined;

  function requireActive(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (released) {
      throw new CapabilityRepositoryRefreshError("release repository refresh");
    }
  }

  return Object.freeze({
    async readTarget(path: string, signal: AbortSignal) {
      requireActive(signal);
      const target = await staged.readTarget(path);
      requireActive(signal);
      return target;
    },

    async complete(signal: AbortSignal) {
      requireActive(signal);
      const completed = await staged.complete();
      requireActive(signal);
      return completed;
    },

    async release(): Promise<void> {
      if (releasePromise === undefined) {
        released = true;
        releasePromise = rm(stagingDirectory, { recursive: true, force: true }).catch(() => {
          throw new CapabilityRepositoryRefreshError("release repository refresh");
        });
      }
      await releasePromise;
    },
  });
}
