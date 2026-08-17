import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityRepositoryStore,
  PublicCapabilityRepositoryState,
} from "../../application/capability-repository-store.js";
import {
  type ValidateStagedTufTrustedRootInput,
  validateStagedTufTrustedRoot,
} from "./staged-tuf-repository.js";

export type CapabilityRepositoryInitializationStage =
  | "validate trusted root"
  | "capture initialization time"
  | "release trusted root staging";

export class CapabilityRepositoryInitializationError extends Error {
  override readonly name = "CapabilityRepositoryInitializationError";
  readonly code = "capability_repository_initialization_failed" as const;

  constructor(readonly stage: CapabilityRepositoryInitializationStage) {
    super(`Capability repository initialization failed during ${stage}`);
  }
}

export interface InitializeLocalCapabilityRepositoryInput {
  readonly repositoryBaseUrl: string;
  readonly trustedRoot: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface LocalCapabilityRepositoryInitializer {
  initialize(
    input: InitializeLocalCapabilityRepositoryInput,
  ): Promise<PublicCapabilityRepositoryState>;
}

export interface LocalCapabilityRepositoryInitializerOptions {
  readonly store: Pick<CapabilityRepositoryStore, "initialize">;
  readonly now: () => Date;
  readonly temporaryRoot?: string;
  readonly validateTrustedRoot?: (
    input: ValidateStagedTufTrustedRootInput,
  ) => ReturnType<typeof validateStagedTufTrustedRoot>;
}

export function createLocalCapabilityRepositoryInitializer(
  options: LocalCapabilityRepositoryInitializerOptions,
): LocalCapabilityRepositoryInitializer {
  const validateTrustedRoot = options.validateTrustedRoot ?? validateStagedTufTrustedRoot;

  return Object.freeze({
    async initialize(
      input: InitializeLocalCapabilityRepositoryInput,
    ): Promise<PublicCapabilityRepositoryState> {
      throwIfAborted(input.signal);
      const initializedAt = captureInitializationTime(options.now);
      let stagingDirectory: string | undefined;
      let validationComplete = false;
      let outcome:
        | { readonly ok: true; readonly value: PublicCapabilityRepositoryState }
        | { readonly ok: false; readonly error: unknown };
      try {
        stagingDirectory = await mkdtemp(
          join(options.temporaryRoot ?? tmpdir(), "flow-repository-init-"),
        );
        throwIfAborted(input.signal);
        const trustedRoot = await validateTrustedRoot({
          stagingDirectory,
          trustedRoot: input.trustedRoot,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        validationComplete = true;
        throwIfAborted(input.signal);
        outcome = {
          ok: true,
          value: await options.store.initialize({
            repositoryBaseUrl: input.repositoryBaseUrl,
            initializedAt,
            trustedRoot,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }),
        };
      } catch (error) {
        if (input.signal?.aborted === true && error === input.signal.reason) {
          outcome = { ok: false, error };
        } else if (!validationComplete) {
          outcome = {
            ok: false,
            error: new CapabilityRepositoryInitializationError("validate trusted root"),
          };
        } else {
          outcome = { ok: false, error };
        }
      }

      if (stagingDirectory !== undefined) {
        try {
          await rm(stagingDirectory, { recursive: true, force: true });
        } catch {
          if (outcome.ok) {
            throw new CapabilityRepositoryInitializationError("release trusted root staging");
          }
        }
      }
      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.value;
    },
  });
}

function captureInitializationTime(now: () => Date): string {
  try {
    const captured = new Date(now().getTime());
    if (Number.isNaN(captured.getTime())) {
      throw new Error("initialization clock is invalid");
    }
    return captured.toISOString();
  } catch {
    throw new CapabilityRepositoryInitializationError("capture initialization time");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
