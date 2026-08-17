import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  type AdaptiveActivationSnapshot,
  type CapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  parseAdaptiveActivationSnapshot,
  validateCapabilitySnapshot,
} from "../../domain/capability/agent-skills.js";
import { parseStrictJson } from "../../domain/strict-json.js";

export const MAX_PROMPT_ACTIVATION_INDEX_BYTES = 4 * 1024 * 1024;
export const MAX_PROMPT_ACTIVATION_ARTIFACTS = 128;
export const MAX_PROMPT_ACTIVATION_HEADS = 128;
export const MAX_PROMPT_ACTIVATION_TRANSITIONS = 2_048;
export const MAX_PROMPT_ACTIVATION_STORED_BYTES = 256 * 1024 * 1024;
export const MAX_PROMPT_ACTIVATION_TEMPORARY_FILES = 128;
export const MAX_PROMPT_ACTIVATION_TEMPORARY_BYTES = 8 * 1024 * 1024;
export const MAX_PROMPT_ACTIVATION_BLOB_TEMPORARY_BYTES = MAX_PROMPT_ACTIVATION_STORED_BYTES;
const MAX_PROMPT_ACTIVATION_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_PROMPT_ACTIVATION_STORE_ERROR_BYTES = 16 * 1024;
const mutationTemporaryNamePattern =
  /^\.activations\.mutation\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const ownedMutationTemporaryNamePattern =
  /^\.activations\.mutation\.([1-9]\d{0,9})\.([a-f0-9]{16})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const indexTemporaryNamePattern =
  /^\.index\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const blobTemporaryNamePattern =
  /^\.[a-f0-9]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
const actorSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !containsControlCharacter(value), "must not contain control characters");
const reasonSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !containsControlCharacter(value), "must not contain control characters");

const artifactEntrySchema = z
  .object({
    kind: z.enum(["agent-skill-activation", "agent-skill-package-activation"]).optional(),
    workflowId: identifierSchema,
    candidateId: identifierSchema,
    candidateVersion: semverSchema,
    selection: z.enum(["baseline", "candidate"]),
    activationDigest: sha256Schema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
  })
  .strict();

const headSchema = z
  .object({
    workflowId: identifierSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    activationDigest: sha256Schema.nullable(),
    lastTransitionDigest: sha256Schema,
  })
  .strict();

const transitionSchema = z
  .object({
    sequence: z.number().int().positive().max(MAX_PROMPT_ACTIVATION_TRANSITIONS),
    workflowId: identifierSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    fromActivationDigest: sha256Schema.nullable(),
    toActivationDigest: sha256Schema.nullable(),
    actor: actorSchema,
    reason: reasonSchema.optional(),
    changedAt: z.iso.datetime({ offset: true }),
    previousDigest: sha256Schema.nullable(),
    transitionDigest: sha256Schema,
  })
  .strict();

const mutationLockOwnerSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive().max(2_147_483_647),
    hostname: z.string().min(1).max(255),
    token: z.uuid(),
  })
  .strict();

const indexSchema = z
  .object({
    version: z.literal(1),
    activations: z.array(artifactEntrySchema).max(MAX_PROMPT_ACTIVATION_ARTIFACTS),
    heads: z.array(headSchema).max(MAX_PROMPT_ACTIVATION_HEADS),
    history: z.array(transitionSchema).max(MAX_PROMPT_ACTIVATION_TRANSITIONS),
    digest: sha256Schema,
  })
  .strict();

export interface PromptActivationArtifactEntry {
  readonly kind?: "agent-skill-activation" | "agent-skill-package-activation" | undefined;
  readonly workflowId: string;
  readonly candidateId: string;
  readonly candidateVersion: string;
  readonly selection: "baseline" | "candidate";
  readonly activationDigest: string;
  readonly bytes: number;
}

export interface PromptActivationHead {
  readonly workflowId: string;
  readonly generation: number;
  readonly activationDigest: string | null;
  readonly lastTransitionDigest: string;
}

export interface PromptActivationTransition {
  readonly sequence: number;
  readonly workflowId: string;
  readonly generation: number;
  readonly fromActivationDigest: string | null;
  readonly toActivationDigest: string | null;
  readonly actor: string;
  readonly reason?: string | undefined;
  readonly changedAt: string;
  readonly previousDigest: string | null;
  readonly transitionDigest: string;
}

interface PromptActivationIndex {
  readonly version: 1;
  readonly activations: readonly PromptActivationArtifactEntry[];
  readonly heads: readonly PromptActivationHead[];
  readonly history: readonly PromptActivationTransition[];
  readonly digest: string;
}

export interface PromptActivationIndexView {
  readonly version: 1;
  readonly activations: readonly PromptActivationArtifactEntry[];
  readonly heads: readonly PromptActivationHead[];
  readonly history: readonly PromptActivationTransition[];
}

export interface PromptActivationProposal {
  readonly version: 1;
  readonly action: "activate" | "rollback";
  readonly workflowId: string;
  readonly current: {
    readonly generation: number;
    readonly activationDigest: string | null;
  };
  readonly target: {
    readonly kind?: "agent-skill-activation" | "agent-skill-package-activation" | undefined;
    readonly candidateId: string;
    readonly candidateVersion: string;
    readonly selection: "baseline" | "candidate";
    readonly activationDigest: string;
    readonly baselineActivationDigest?: string | undefined;
  } | null;
  readonly actor: string;
  readonly reason?: string;
  readonly proposalDigest: string;
}

export interface PreviewPromptActivationInput {
  readonly snapshot: AdaptiveActivationSnapshot;
  readonly baselineSnapshot: AdaptiveActivationSnapshot;
  readonly actor: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

export interface ApplyPromptActivationInput extends PreviewPromptActivationInput {
  readonly expectedDigest: string;
}

export interface PromptActivationApplyResult {
  readonly status: "activated" | "already_active";
  readonly activation: PromptActivationArtifactEntry;
  readonly head: PromptActivationHead;
  readonly transition: PromptActivationTransition;
}

export interface PromptActivationRollbackTarget {
  readonly kind?: "agent-skill-activation" | "agent-skill-package-activation" | undefined;
  readonly candidateId: string;
  readonly candidateVersion: string;
}

export interface PreviewPromptActivationRollbackInput {
  readonly workflowId: string;
  readonly target: PromptActivationRollbackTarget | null;
  readonly actor: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

export interface ApplyPromptActivationRollbackInput extends PreviewPromptActivationRollbackInput {
  readonly expectedDigest: string;
}

export interface PromptActivationRollbackResult {
  readonly status: "rolled_back" | "already_selected";
  readonly head: PromptActivationHead;
  readonly transition: PromptActivationTransition;
}

export interface LoadedPromptActivation {
  readonly snapshot: AdaptiveActivationSnapshot;
  readonly capabilitySnapshot: CapabilitySnapshot;
}

export interface PromptActivationStoreHooks {
  readonly afterBlobLinked?: () => Promise<void>;
  readonly beforeIndexRenamed?: () => Promise<void>;
  readonly afterIndexRenamed?: () => Promise<void>;
  readonly beforeMutationTemporaryObserved?: () => Promise<void>;
  readonly beforeMutationLockLinked?: () => Promise<void>;
  readonly beforeMutationLockRelease?: () => Promise<void>;
}

export interface PromptActivationStoreOptions {
  readonly hooks?: PromptActivationStoreHooks;
  readonly now?: () => Date;
}

export type PromptActivationStoreErrorCode =
  | "identity_conflict"
  | "busy"
  | "commit_uncertain"
  | "corrupt_blob"
  | "invalid_index"
  | "invalid_input"
  | "io"
  | "limit_exceeded"
  | "not_found"
  | "stale_proposal"
  | "unsafe_state";

export class PromptActivationStoreError extends Error {
  override readonly name = "PromptActivationStoreError";

  constructor(
    readonly code: PromptActivationStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(boundedText(message, MAX_PROMPT_ACTIVATION_STORE_ERROR_BYTES), options);
  }
}

export class LocalPromptActivationStore {
  readonly #hooks: PromptActivationStoreHooks;
  readonly #now: () => Date;

  constructor(
    readonly projectRoot: string,
    options: PromptActivationStoreOptions = {},
  ) {
    this.#hooks = options.hooks ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  async previewActivate(input: PreviewPromptActivationInput): Promise<PromptActivationProposal> {
    input.signal?.throwIfAborted();
    const { snapshot, baselineSnapshot } = parseActivationSelections(input);
    const actor = parseActor(input.actor);
    const reason = parseReason(input.reason);
    const index = await awaitBeforeMutationOwnership(this.#readIndex(), input.signal);
    return createActivationProposal(index, snapshot, baselineSnapshot, actor, reason);
  }

  async applyActivate(input: ApplyPromptActivationInput): Promise<PromptActivationApplyResult> {
    input.signal?.throwIfAborted();
    const { snapshot, baselineSnapshot } = parseActivationSelections(input);
    const actor = parseActor(input.actor);
    const reason = parseReason(input.reason);
    const expectedDigest = parseDigest(input.expectedDigest, "activation proposal digest");
    const paths = await awaitBeforeMutationOwnership(storePaths(this.projectRoot), input.signal);
    const lock = await acquireMutationLock(paths.flowDirectory, this.#hooks, input.signal);
    return await withMutationLock(lock, this.#hooks, async () => {
      await ensureRealDirectory(paths.activationDirectory, paths.flowDirectory);
      await recoverIndexTemporaryFiles(paths);
      await recoverBlobTemporaryFiles(paths);
      const index = await this.#readIndex();
      const proposal = createActivationProposal(index, snapshot, baselineSnapshot, actor, reason);
      const existing = matchingArtifact(index, snapshot);
      const existingBaseline = matchingArtifact(index, baselineSnapshot);
      const currentHead = index.heads.find((item) => item.workflowId === snapshot.workflowId);
      if (
        existing !== undefined &&
        existingBaseline !== undefined &&
        currentHead?.activationDigest === snapshot.activationDigest
      ) {
        const transition = index.history.find(
          (item) => item.transitionDigest === currentHead.lastTransitionDigest,
        );
        if (transition === undefined) {
          throw new PromptActivationStoreError(
            "invalid_index",
            `prompt activation head "${snapshot.workflowId}" has no transition`,
          );
        }
        const retryProposal = createActivationProposalForCurrent(
          snapshot,
          baselineSnapshot,
          actor,
          reason,
          {
            generation: transition.generation - 1,
            activationDigest: transition.fromActivationDigest,
          },
        );
        if (
          proposal.proposalDigest !== expectedDigest &&
          (!sameOperatorInput(transition, actor, reason) ||
            retryProposal.proposalDigest !== expectedDigest)
        ) {
          throw new PromptActivationStoreError(
            "stale_proposal",
            "prompt activation proposal does not match current state",
          );
        }
        await requireExactBlob(paths, existing, snapshot);
        await requireExactBlob(paths, existingBaseline, baselineSnapshot);
        return deepFreeze({
          status: "already_active" as const,
          activation: existing,
          head: currentHead,
          transition,
        });
      }
      if (proposal.proposalDigest !== expectedDigest) {
        throw new PromptActivationStoreError(
          "stale_proposal",
          "prompt activation proposal does not match current state",
        );
      }
      const previousDigest = index.history.at(-1)?.transitionDigest ?? null;
      const transitionWithoutDigest = {
        sequence: index.history.length + 1,
        workflowId: snapshot.workflowId,
        generation: (currentHead?.generation ?? 0) + 1,
        fromActivationDigest: currentHead?.activationDigest ?? null,
        toActivationDigest: snapshot.activationDigest,
        actor,
        ...(reason === undefined ? {} : { reason }),
        changedAt: this.#now().toISOString(),
        previousDigest,
      };
      const transition: PromptActivationTransition = Object.freeze({
        ...transitionWithoutDigest,
        transitionDigest: sha256(canonicalize(transitionWithoutDigest)),
      });
      const head: PromptActivationHead = Object.freeze({
        workflowId: snapshot.workflowId,
        generation: transition.generation,
        activationDigest: snapshot.activationDigest,
        lastTransitionDigest: transition.transitionDigest,
      });
      const prepared = [prepareBlob(snapshot), prepareBlob(baselineSnapshot)] as const;
      const activation = prepared[0].entry;
      const additions = prepared
        .map((item) => item.entry)
        .filter(
          (item) =>
            !index.activations.some(
              (existingItem) => artifactKey(existingItem) === artifactKey(item),
            ),
        );
      const activations = [...index.activations, ...additions].sort((left, right) =>
        compareStrings(artifactKey(left), artifactKey(right)),
      );
      const heads = [
        ...index.heads.filter((item) => item.workflowId !== snapshot.workflowId),
        head,
      ].sort((left, right) => compareStrings(left.workflowId, right.workflowId));
      const history = [...index.history, transition];
      const content = { version: 1 as const, activations, heads, history };
      const next = deepFreeze({ ...content, digest: calculateIndexDigest(content) });
      validateIndex(next);
      validateIndexPublicationSize(next);
      await ensureActivationDirectories(paths);
      await assertPhysicalBlobCapacity(paths, prepared);
      const publications: PublishedPromptActivationBlob[] = [];
      try {
        publications.push(await publishBlob(paths, snapshot, prepared[0], this.#hooks));
        publications.push(await publishBlob(paths, baselineSnapshot, prepared[1], this.#hooks));
        await publishIndex(paths, next, this.#hooks);
      } catch (error) {
        if (!(error instanceof PromptActivationStoreError && error.code === "commit_uncertain")) {
          for (const publication of publications.toReversed()) {
            if (publication.created) {
              const publishedSnapshot =
                publication.entry.selection === "candidate" ? snapshot : baselineSnapshot;
              await removePublishedBlob(paths, publication.entry, publishedSnapshot);
            }
          }
        }
        throw error;
      }
      return deepFreeze({ status: "activated" as const, activation, head, transition });
    });
  }

  async previewRollback(
    input: PreviewPromptActivationRollbackInput,
  ): Promise<PromptActivationProposal> {
    input.signal?.throwIfAborted();
    const workflowId = parseIdentifier(input.workflowId, "rollback workflow id");
    const target = parseRollbackTarget(input.target);
    const actor = parseActor(input.actor);
    const reason = parseReason(input.reason);
    return createRollbackProposal(
      await awaitBeforeMutationOwnership(this.#readIndex(), input.signal),
      workflowId,
      target,
      actor,
      reason,
    );
  }

  async applyRollback(
    input: ApplyPromptActivationRollbackInput,
  ): Promise<PromptActivationRollbackResult> {
    input.signal?.throwIfAborted();
    const workflowId = parseIdentifier(input.workflowId, "rollback workflow id");
    const target = parseRollbackTarget(input.target);
    const actor = parseActor(input.actor);
    const reason = parseReason(input.reason);
    const expectedDigest = parseDigest(input.expectedDigest, "rollback proposal digest");
    const paths = await awaitBeforeMutationOwnership(storePaths(this.projectRoot), input.signal);
    const lock = await acquireMutationLock(paths.flowDirectory, this.#hooks, input.signal);
    return await withMutationLock(lock, this.#hooks, async () => {
      await ensureRealDirectory(paths.activationDirectory, paths.flowDirectory);
      await recoverIndexTemporaryFiles(paths);
      await recoverBlobTemporaryFiles(paths);
      const index = await this.#readIndex();
      const proposal = createRollbackProposal(index, workflowId, target, actor, reason);
      const currentHead = index.heads.find((item) => item.workflowId === workflowId);
      if (currentHead === undefined) {
        throw new PromptActivationStoreError(
          "not_found",
          `workflow "${workflowId}" has no activation history`,
        );
      }
      const targetDigest = proposal.target?.activationDigest ?? null;
      if (targetDigest !== null) {
        const targetEntry = index.activations.find(
          (item) => item.workflowId === workflowId && item.activationDigest === targetDigest,
        );
        if (targetEntry === undefined) {
          throw new PromptActivationStoreError(
            "invalid_index",
            `workflow "${workflowId}" selects a missing rollback artifact`,
          );
        }
        await readVerifiedBlob(paths, targetEntry);
      }
      if (currentHead.activationDigest === targetDigest) {
        const transition = index.history.find(
          (item) => item.transitionDigest === currentHead.lastTransitionDigest,
        );
        if (transition === undefined) {
          throw new PromptActivationStoreError(
            "invalid_index",
            `prompt activation head "${workflowId}" has no transition`,
          );
        }
        const retryProposal = createRollbackProposalForCurrent(
          workflowId,
          proposal.target,
          actor,
          reason,
          {
            generation: transition.generation - 1,
            activationDigest: transition.fromActivationDigest,
          },
        );
        if (
          proposal.proposalDigest !== expectedDigest &&
          (!sameOperatorInput(transition, actor, reason) ||
            retryProposal.proposalDigest !== expectedDigest)
        ) {
          throw new PromptActivationStoreError(
            "stale_proposal",
            "prompt rollback proposal does not match current state",
          );
        }
        return deepFreeze({ status: "already_selected" as const, head: currentHead, transition });
      }
      if (proposal.proposalDigest !== expectedDigest) {
        throw new PromptActivationStoreError(
          "stale_proposal",
          "prompt rollback proposal does not match current state",
        );
      }
      const previousDigest = index.history.at(-1)?.transitionDigest ?? null;
      const transitionWithoutDigest = {
        sequence: index.history.length + 1,
        workflowId,
        generation: currentHead.generation + 1,
        fromActivationDigest: currentHead.activationDigest,
        toActivationDigest: targetDigest,
        actor,
        ...(reason === undefined ? {} : { reason }),
        changedAt: this.#now().toISOString(),
        previousDigest,
      };
      const transition: PromptActivationTransition = Object.freeze({
        ...transitionWithoutDigest,
        transitionDigest: sha256(canonicalize(transitionWithoutDigest)),
      });
      const head: PromptActivationHead = Object.freeze({
        workflowId,
        generation: transition.generation,
        activationDigest: targetDigest,
        lastTransitionDigest: transition.transitionDigest,
      });
      const heads = [...index.heads.filter((item) => item.workflowId !== workflowId), head].sort(
        (left, right) => compareStrings(left.workflowId, right.workflowId),
      );
      const content = {
        version: 1 as const,
        activations: index.activations,
        heads,
        history: [...index.history, transition],
      };
      const next = deepFreeze({ ...content, digest: calculateIndexDigest(content) });
      validateIndex(next);
      await publishIndex(paths, next, this.#hooks);
      return deepFreeze({ status: "rolled_back" as const, head, transition });
    });
  }

  async list(): Promise<PromptActivationIndexView> {
    const index = await this.#readIndex();
    return deepFreeze({
      version: index.version,
      activations: index.activations,
      heads: index.heads,
      history: index.history,
    });
  }

  async loadActive(workflowIdInput: string): Promise<LoadedPromptActivation> {
    const workflowId = parseIdentifier(workflowIdInput, "activation workflow id");
    const index = await this.#readIndex();
    const head = index.heads.find((item) => item.workflowId === workflowId);
    if (head === undefined || head.activationDigest === null) {
      throw new PromptActivationStoreError(
        "not_found",
        `workflow "${workflowId}" has no active prompt candidate`,
      );
    }
    const entry = index.activations.find(
      (item) => item.workflowId === workflowId && item.activationDigest === head.activationDigest,
    );
    if (entry === undefined) {
      throw new PromptActivationStoreError(
        "invalid_index",
        `workflow "${workflowId}" selects a missing activation artifact`,
      );
    }
    const paths = await storePaths(this.projectRoot);
    const snapshot = await readVerifiedBlob(paths, entry);
    const packages =
      snapshot.kind === "agent-skill-activation"
        ? [snapshot.skill]
        : snapshot.kind === "agent-skill-package-activation" && snapshot.skill !== undefined
          ? [snapshot.skill]
          : ([] as const);
    const activations = [snapshot];
    const capabilitySnapshot = validateCapabilitySnapshot({
      version: 1,
      packages,
      activations,
      digest: calculateCapabilitySnapshotDigest(packages, activations),
    });
    return deepFreeze({ snapshot, capabilitySnapshot });
  }

  async #readIndex(): Promise<PromptActivationIndex> {
    const paths = await storePaths(this.projectRoot);
    if (!(await requireActivationDirectory(paths, false))) {
      return emptyIndex();
    }
    let content: Buffer;
    try {
      content = await readBoundedRegularFile(paths.indexPath, MAX_PROMPT_ACTIVATION_INDEX_BYTES);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyIndex();
      }
      if (isNodeError(error) && error.code === "ELOOP") {
        throw new PromptActivationStoreError(
          "unsafe_state",
          "prompt activation index must not be a symbolic link",
          { cause: error },
        );
      }
      if (error instanceof PromptActivationStoreError) {
        throw error;
      }
      throw new PromptActivationStoreError("io", "could not read prompt activation index", {
        cause: error,
      });
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      const parsed = indexSchema.parse(
        parseStrictJson(text, {
          maxDepth: 16,
          maxNodes: 100_000,
          valueLabel: "prompt activation index",
        }),
      );
      validateIndex(parsed);
      return deepFreeze(parsed);
    } catch (error) {
      if (error instanceof PromptActivationStoreError) {
        throw error;
      }
      throw new PromptActivationStoreError("invalid_index", "prompt activation index is invalid", {
        cause: error,
      });
    }
  }
}

interface PromptActivationStorePaths {
  readonly flowDirectory: string;
  readonly activationDirectory: string;
  readonly indexPath: string;
  readonly blobDirectory: string;
  readonly mutationLockPath: string;
}

async function storePaths(projectRoot: string): Promise<PromptActivationStorePaths> {
  const requestedRoot = resolve(projectRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(requestedRoot);
  } catch (error) {
    throw new PromptActivationStoreError("io", "could not resolve prompt activation project root", {
      cause: error,
    });
  }
  const flowDirectory = join(canonicalRoot, ".flow");
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(flowDirectory);
  } catch (error) {
    throw new PromptActivationStoreError(
      "io",
      "prompt activation store requires an existing .flow directory",
      { cause: error },
    );
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PromptActivationStoreError(
      "unsafe_state",
      "prompt activation .flow path must be a real directory",
    );
  }
  const canonicalFlow = await realpath(flowDirectory).catch((error: unknown) => {
    throw new PromptActivationStoreError("io", "could not resolve prompt activation .flow path", {
      cause: error,
    });
  });
  if (canonicalFlow !== flowDirectory) {
    throw new PromptActivationStoreError(
      "unsafe_state",
      "prompt activation .flow path must not traverse symbolic links",
    );
  }
  const activationDirectory = join(flowDirectory, "activations");
  return Object.freeze({
    flowDirectory,
    activationDirectory,
    indexPath: join(activationDirectory, "index.json"),
    blobDirectory: join(activationDirectory, "sha256"),
    mutationLockPath: join(flowDirectory, "activations.mutation.lock"),
  });
}

function emptyIndex(): PromptActivationIndex {
  const content = { version: 1 as const, activations: [], heads: [], history: [] };
  return deepFreeze({ ...content, digest: calculateIndexDigest(content) });
}

function validateIndex(index: PromptActivationIndex): void {
  if (index.activations.length > MAX_PROMPT_ACTIVATION_ARTIFACTS) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      `prompt activation index exceeds ${MAX_PROMPT_ACTIVATION_ARTIFACTS} artifacts`,
    );
  }
  if (index.heads.length > MAX_PROMPT_ACTIVATION_HEADS) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      `prompt activation index exceeds ${MAX_PROMPT_ACTIVATION_HEADS} workflow heads`,
    );
  }
  if (index.history.length > MAX_PROMPT_ACTIVATION_TRANSITIONS) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      `prompt activation index exceeds ${MAX_PROMPT_ACTIVATION_TRANSITIONS} transitions`,
    );
  }
  assertSortedUnique(index.activations.map(artifactKey), "activation entries");
  assertSortedUnique(
    index.activations.map((item) => item.activationDigest).sort(compareStrings),
    "activation digests",
  );
  assertSortedUnique(
    index.heads.map((item) => item.workflowId),
    "activation heads",
  );
  if (index.digest !== calculateIndexDigest(index)) {
    throw new PromptActivationStoreError(
      "invalid_index",
      "prompt activation index digest does not match",
    );
  }
  const totalBytes = index.activations.reduce((total, item) => total + item.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PROMPT_ACTIVATION_STORED_BYTES) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      `stored activation blobs exceed ${MAX_PROMPT_ACTIVATION_STORED_BYTES} bytes`,
    );
  }
  let previousDigest: string | null = null;
  const workflowStates = new Map<
    string,
    {
      readonly generation: number;
      readonly activationDigest: string | null;
      readonly transitionDigest: string;
    }
  >();
  for (const [indexPosition, transition] of index.history.entries()) {
    const workflowState = workflowStates.get(transition.workflowId);
    if (
      transition.sequence !== indexPosition + 1 ||
      transition.previousDigest !== previousDigest ||
      transition.transitionDigest !== calculateTransitionDigest(transition) ||
      transition.generation !== (workflowState?.generation ?? 0) + 1 ||
      transition.fromActivationDigest !== (workflowState?.activationDigest ?? null) ||
      transition.fromActivationDigest === transition.toActivationDigest
    ) {
      throw new PromptActivationStoreError(
        "invalid_index",
        "prompt activation transition history is inconsistent",
      );
    }
    if (
      transition.toActivationDigest !== null &&
      !index.activations.some(
        (item) =>
          item.workflowId === transition.workflowId &&
          item.activationDigest === transition.toActivationDigest,
      )
    ) {
      throw new PromptActivationStoreError(
        "invalid_index",
        `prompt activation transition ${transition.sequence} selects a missing workflow artifact`,
      );
    }
    workflowStates.set(transition.workflowId, {
      generation: transition.generation,
      activationDigest: transition.toActivationDigest,
      transitionDigest: transition.transitionDigest,
    });
    previousDigest = transition.transitionDigest;
  }
  if (workflowStates.size !== index.heads.length) {
    throw new PromptActivationStoreError(
      "invalid_index",
      "prompt activation heads do not cover transition history",
    );
  }
  for (const head of index.heads) {
    const workflowState = workflowStates.get(head.workflowId);
    if (
      workflowState === undefined ||
      workflowState.generation !== head.generation ||
      workflowState.activationDigest !== head.activationDigest ||
      workflowState.transitionDigest !== head.lastTransitionDigest
    ) {
      throw new PromptActivationStoreError(
        "invalid_index",
        `prompt activation head "${head.workflowId}" is inconsistent`,
      );
    }
    if (
      head.activationDigest !== null &&
      !index.activations.some(
        (item) =>
          item.workflowId === head.workflowId && item.activationDigest === head.activationDigest,
      )
    ) {
      throw new PromptActivationStoreError(
        "invalid_index",
        `prompt activation head "${head.workflowId}" selects a missing artifact`,
      );
    }
  }
}

function createActivationProposal(
  index: PromptActivationIndex,
  snapshot: AdaptiveActivationSnapshot,
  baselineSnapshot: AdaptiveActivationSnapshot,
  actor: string,
  reason: string | undefined,
): PromptActivationProposal {
  const existing = matchingArtifact(index, snapshot);
  const existingBaseline = matchingArtifact(index, baselineSnapshot);
  if (existing !== undefined && existing.activationDigest !== snapshot.activationDigest) {
    throw new PromptActivationStoreError(
      "identity_conflict",
      `candidate ${snapshot.candidateId}@${snapshot.candidateVersion} already identifies another activation`,
    );
  }
  if (
    existingBaseline !== undefined &&
    existingBaseline.activationDigest !== baselineSnapshot.activationDigest
  ) {
    throw new PromptActivationStoreError(
      "identity_conflict",
      `candidate ${snapshot.candidateId}@${snapshot.candidateVersion} already identifies another baseline activation`,
    );
  }
  const head = index.heads.find((item) => item.workflowId === snapshot.workflowId);
  return createActivationProposalForCurrent(snapshot, baselineSnapshot, actor, reason, {
    generation: head?.generation ?? 0,
    activationDigest: head?.activationDigest ?? null,
  });
}

function createActivationProposalForCurrent(
  snapshot: AdaptiveActivationSnapshot,
  baselineSnapshot: AdaptiveActivationSnapshot,
  actor: string,
  reason: string | undefined,
  current: PromptActivationProposal["current"],
): PromptActivationProposal {
  const proposalWithoutDigest = {
    version: 1 as const,
    action: "activate" as const,
    workflowId: snapshot.workflowId,
    current,
    target: {
      ...(snapshot.kind === "prompt-activation" ? {} : { kind: snapshot.kind }),
      candidateId: snapshot.candidateId,
      candidateVersion: snapshot.candidateVersion,
      selection: "candidate" as const,
      activationDigest: snapshot.activationDigest,
      baselineActivationDigest: baselineSnapshot.activationDigest,
    },
    actor,
    ...(reason === undefined ? {} : { reason }),
  };
  return deepFreeze({
    ...proposalWithoutDigest,
    proposalDigest: sha256(canonicalize(proposalWithoutDigest)),
  });
}

function sameOperatorInput(
  transition: PromptActivationTransition,
  actor: string,
  reason: string | undefined,
): boolean {
  return transition.actor === actor && transition.reason === reason;
}

function createRollbackProposal(
  index: PromptActivationIndex,
  workflowId: string,
  target: PromptActivationRollbackTarget | null,
  actor: string,
  reason: string | undefined,
): PromptActivationProposal {
  const head = index.heads.find((item) => item.workflowId === workflowId);
  if (head === undefined) {
    throw new PromptActivationStoreError(
      "not_found",
      `workflow "${workflowId}" has no activation history`,
    );
  }
  if (head.activationDigest === null) {
    throw new PromptActivationStoreError(
      "invalid_index",
      `workflow "${workflowId}" has no selected activation artifact`,
    );
  }
  const currentArtifact = index.activations.find(
    (item) => item.workflowId === workflowId && item.activationDigest === head.activationDigest,
  );
  if (currentArtifact === undefined) {
    throw new PromptActivationStoreError(
      "invalid_index",
      `workflow "${workflowId}" selects a missing activation artifact`,
    );
  }
  const targetKind =
    target === null
      ? artifactActivationKind(currentArtifact)
      : (target.kind ?? "prompt-activation");
  const targetArtifact = index.activations.find(
    (item) =>
      artifactActivationKind(item) === targetKind &&
      item.workflowId === workflowId &&
      item.candidateId === (target?.candidateId ?? currentArtifact.candidateId) &&
      item.candidateVersion === (target?.candidateVersion ?? currentArtifact.candidateVersion) &&
      item.selection === (target === null ? "baseline" : "candidate"),
  );
  if (targetArtifact === undefined) {
    throw new PromptActivationStoreError(
      "not_found",
      target === null
        ? `workflow "${workflowId}" has no baseline activation for ${currentArtifact.candidateId}@${currentArtifact.candidateVersion}`
        : `workflow "${workflowId}" has no activation for ${target.candidateId}@${target.candidateVersion}`,
    );
  }
  return createRollbackProposalForCurrent(
    workflowId,
    {
      ...(targetArtifact.kind === undefined ? {} : { kind: targetArtifact.kind }),
      candidateId: targetArtifact.candidateId,
      candidateVersion: targetArtifact.candidateVersion,
      selection: targetArtifact.selection,
      activationDigest: targetArtifact.activationDigest,
    },
    actor,
    reason,
    { generation: head.generation, activationDigest: head.activationDigest },
  );
}

function createRollbackProposalForCurrent(
  workflowId: string,
  target: PromptActivationProposal["target"],
  actor: string,
  reason: string | undefined,
  current: PromptActivationProposal["current"],
): PromptActivationProposal {
  const proposalWithoutDigest = {
    version: 1 as const,
    action: "rollback" as const,
    workflowId,
    current,
    target,
    actor,
    ...(reason === undefined ? {} : { reason }),
  };
  return deepFreeze({
    ...proposalWithoutDigest,
    proposalDigest: sha256(canonicalize(proposalWithoutDigest)),
  });
}

function matchingArtifact(
  index: PromptActivationIndex,
  snapshot: AdaptiveActivationSnapshot,
): PromptActivationArtifactEntry | undefined {
  return index.activations.find(
    (item) =>
      artifactActivationKind(item) === snapshot.kind &&
      item.workflowId === snapshot.workflowId &&
      item.candidateId === snapshot.candidateId &&
      item.candidateVersion === snapshot.candidateVersion &&
      item.selection === snapshot.selection,
  );
}

async function publishBlob(
  paths: PromptActivationStorePaths,
  snapshot: AdaptiveActivationSnapshot,
  prepared: PreparedPromptActivationBlob,
  hooks: PromptActivationStoreHooks,
): Promise<PublishedPromptActivationBlob> {
  await ensureActivationDirectories(paths);
  const { content, entry } = prepared;
  const target = activationBlobPath(paths, snapshot.activationDigest);
  try {
    await lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await publishNewBlob(paths, snapshot, entry, target, content, hooks);
      return Object.freeze({ entry, created: true });
    }
    if (error instanceof PromptActivationStoreError) {
      throw error;
    }
    throw new PromptActivationStoreError("io", "could not inspect prompt activation blob", {
      cause: error,
    });
  }
  await requireExactBlob(paths, entry, snapshot);
  return Object.freeze({ entry, created: false });
}

interface PreparedPromptActivationBlob {
  readonly content: Buffer;
  readonly entry: PromptActivationArtifactEntry;
}

interface PublishedPromptActivationBlob {
  readonly entry: PromptActivationArtifactEntry;
  readonly created: boolean;
}

function prepareBlob(snapshot: AdaptiveActivationSnapshot): PreparedPromptActivationBlob {
  const content = Buffer.from(`${canonicalize(snapshot)}\n`, "utf8");
  return Object.freeze({
    content,
    entry: Object.freeze({
      ...(snapshot.kind === "prompt-activation" ? {} : { kind: snapshot.kind }),
      workflowId: snapshot.workflowId,
      candidateId: snapshot.candidateId,
      candidateVersion: snapshot.candidateVersion,
      selection: snapshot.selection,
      activationDigest: snapshot.activationDigest,
      bytes: content.byteLength,
    }),
  });
}

async function assertPhysicalBlobCapacity(
  paths: PromptActivationStorePaths,
  prepared: readonly PreparedPromptActivationBlob[],
): Promise<void> {
  const entries = await readdir(paths.blobDirectory, { withFileTypes: true });
  let storedBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new PromptActivationStoreError(
        "unsafe_state",
        "prompt activation blob directory contains an unsafe entry",
      );
    }
    const metadata = await lstat(join(paths.blobDirectory, entry.name));
    storedBytes += metadata.size;
  }
  const names = new Set(entries.map((entry) => entry.name));
  const additions = prepared.filter((item) => !names.has(`${item.entry.activationDigest}.json`));
  const addedBytes = additions.reduce((total, item) => total + item.entry.bytes, 0);
  if (
    entries.length + additions.length > MAX_PROMPT_ACTIVATION_ARTIFACTS ||
    !Number.isSafeInteger(storedBytes + addedBytes) ||
    storedBytes + addedBytes > MAX_PROMPT_ACTIVATION_STORED_BYTES
  ) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      "prompt activation blob store has reached its physical limit",
    );
  }
}

async function removePublishedBlob(
  paths: PromptActivationStorePaths,
  entry: PromptActivationArtifactEntry,
  snapshot: AdaptiveActivationSnapshot,
): Promise<void> {
  await requireExactBlob(paths, entry, snapshot);
  await unlink(activationBlobPath(paths, entry.activationDigest));
  await syncDirectory(paths.blobDirectory);
}

async function publishNewBlob(
  paths: PromptActivationStorePaths,
  snapshot: AdaptiveActivationSnapshot,
  entry: PromptActivationArtifactEntry,
  target: string,
  content: Buffer,
  hooks: PromptActivationStoreHooks,
): Promise<PromptActivationArtifactEntry> {
  const temporary = join(paths.blobDirectory, `.${snapshot.activationDigest}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let createdTarget = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
      createdTarget = true;
      await hooks.afterBlobLinked?.();
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) {
        throw error;
      }
      await requireExactBlob(paths, entry, snapshot);
    }
    await unlink(temporary);
    await syncDirectory(paths.blobDirectory);
    return entry;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (createdTarget) {
      try {
        await removePublishedBlob(paths, entry, snapshot);
      } catch (cleanupError) {
        throw new PromptActivationStoreError(
          "unsafe_state",
          "prompt activation blob publication failed and its new link could not be removed",
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
    }
    if (error instanceof PromptActivationStoreError) {
      throw error;
    }
    throw new PromptActivationStoreError("io", "could not publish prompt activation blob", {
      cause: error,
    });
  }
}

async function requireExactBlob(
  paths: PromptActivationStorePaths,
  entry: PromptActivationArtifactEntry,
  snapshot: AdaptiveActivationSnapshot,
): Promise<void> {
  const parsed = await readVerifiedBlob(paths, entry);
  if (canonicalize(parsed) !== canonicalize(snapshot)) {
    throw new PromptActivationStoreError(
      "corrupt_blob",
      `prompt activation blob ${entry.activationDigest} does not contain the expected snapshot`,
    );
  }
}

async function readVerifiedBlob(
  paths: PromptActivationStorePaths,
  entry: PromptActivationArtifactEntry,
): Promise<AdaptiveActivationSnapshot> {
  let content: Buffer;
  try {
    await requireActivationDirectory(paths, true);
    await requireRealDirectory(paths.blobDirectory);
    content = await readBoundedRegularFile(
      activationBlobPath(paths, entry.activationDigest),
      16 * 1024 * 1024,
    );
  } catch (error) {
    throw new PromptActivationStoreError(
      "corrupt_blob",
      `prompt activation blob ${entry.activationDigest} could not be read`,
      { cause: error },
    );
  }
  if (content.byteLength !== entry.bytes) {
    throw new PromptActivationStoreError(
      "corrupt_blob",
      `prompt activation blob ${entry.activationDigest} has the wrong byte count`,
    );
  }
  let parsed: AdaptiveActivationSnapshot;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    parsed = parseAdaptiveActivationSnapshot(
      parseStrictJson(text, {
        maxDepth: 64,
        maxNodes: 300_000,
        valueLabel: "prompt activation blob",
      }),
    );
  } catch (error) {
    throw new PromptActivationStoreError(
      "corrupt_blob",
      `prompt activation blob ${entry.activationDigest} is invalid`,
      { cause: error },
    );
  }
  if (
    parsed.activationDigest !== entry.activationDigest ||
    parsed.kind !== artifactActivationKind(entry) ||
    parsed.workflowId !== entry.workflowId ||
    parsed.candidateId !== entry.candidateId ||
    parsed.candidateVersion !== entry.candidateVersion ||
    parsed.selection !== entry.selection
  ) {
    throw new PromptActivationStoreError(
      "corrupt_blob",
      `prompt activation blob ${entry.activationDigest} contradicts its index entry`,
    );
  }
  return parsed;
}

async function publishIndex(
  paths: PromptActivationStorePaths,
  index: PromptActivationIndex,
  hooks: PromptActivationStoreHooks,
): Promise<void> {
  await ensureActivationDirectories(paths);
  const content = Buffer.from(`${JSON.stringify(index)}\n`, "utf8");
  if (content.byteLength > MAX_PROMPT_ACTIVATION_INDEX_BYTES) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      `prompt activation index exceeds ${MAX_PROMPT_ACTIVATION_INDEX_BYTES} bytes`,
    );
  }
  const temporary = join(paths.activationDirectory, `.index.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeIndexRenamed?.();
    await rename(temporary, paths.indexPath);
    renamed = true;
    await hooks.afterIndexRenamed?.();
    await syncDirectory(paths.activationDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (renamed) {
      throw new PromptActivationStoreError(
        "commit_uncertain",
        "prompt activation index changed but directory sync failed",
        { cause: error },
      );
    }
    if (error instanceof PromptActivationStoreError) {
      throw error;
    }
    throw new PromptActivationStoreError("io", "could not publish prompt activation index", {
      cause: error,
    });
  }
}

function validateIndexPublicationSize(index: PromptActivationIndex): void {
  if (Buffer.byteLength(`${JSON.stringify(index)}\n`, "utf8") > MAX_PROMPT_ACTIVATION_INDEX_BYTES) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      `prompt activation index exceeds ${MAX_PROMPT_ACTIVATION_INDEX_BYTES} bytes`,
    );
  }
}

interface ObservedTemporaryFile {
  readonly path: string;
  readonly identity: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly ctimeNs: bigint;
    readonly mtimeNs: bigint;
  };
}

async function recoverIndexTemporaryFiles(paths: PromptActivationStorePaths): Promise<void> {
  const entries = (await readdir(paths.activationDirectory, { withFileTypes: true })).filter(
    (entry) => entry.name.startsWith(".index."),
  );
  if (entries.length > MAX_PROMPT_ACTIVATION_TEMPORARY_FILES) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      "prompt activation index temporary-file count exceeds its limit",
    );
  }
  const observed: ObservedTemporaryFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!indexTemporaryNamePattern.test(entry.name) || !entry.isFile()) {
      throw new PromptActivationStoreError(
        "unsafe_state",
        "prompt activation index temporary path is unsafe",
      );
    }
    const path = join(paths.activationDirectory, entry.name);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(path, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (!metadata.isFile() || metadata.size > BigInt(MAX_PROMPT_ACTIVATION_INDEX_BYTES)) {
      throw new PromptActivationStoreError(
        "unsafe_state",
        "prompt activation index temporary file is not a bounded regular file",
      );
    }
    totalBytes += Number(metadata.size);
    if (totalBytes > MAX_PROMPT_ACTIVATION_TEMPORARY_BYTES) {
      throw new PromptActivationStoreError(
        "limit_exceeded",
        "prompt activation index temporary bytes exceed their limit",
      );
    }
    observed.push({
      path,
      identity: {
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        ctimeNs: metadata.ctimeNs,
        mtimeNs: metadata.mtimeNs,
      },
    });
  }
  for (const item of observed) {
    await removeObservedTemporaryFile(item);
  }
  if (observed.length > 0) {
    await syncDirectory(paths.activationDirectory);
  }
}

async function recoverBlobTemporaryFiles(paths: PromptActivationStorePaths): Promise<void> {
  try {
    await requireRealDirectory(paths.blobDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const entries = (await readdir(paths.blobDirectory, { withFileTypes: true })).filter((entry) =>
    entry.name.startsWith("."),
  );
  if (entries.length > MAX_PROMPT_ACTIVATION_TEMPORARY_FILES) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      "prompt activation blob temporary-file count exceeds its limit",
    );
  }
  const observed: ObservedTemporaryFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!blobTemporaryNamePattern.test(entry.name) || !entry.isFile()) {
      throw new PromptActivationStoreError(
        "unsafe_state",
        "prompt activation blob temporary path is unsafe",
      );
    }
    const item = await observeTemporaryFile(
      join(paths.blobDirectory, entry.name),
      MAX_PROMPT_ACTIVATION_BLOB_BYTES,
      "prompt activation blob temporary file",
    );
    if (item === null) {
      continue;
    }
    totalBytes += Number(item.identity.size);
    if (totalBytes > MAX_PROMPT_ACTIVATION_BLOB_TEMPORARY_BYTES) {
      throw new PromptActivationStoreError(
        "limit_exceeded",
        "prompt activation blob temporary bytes exceed their limit",
      );
    }
    observed.push(item);
  }
  for (const item of observed) {
    await removeObservedTemporaryFile(item);
  }
  if (observed.length > 0) {
    await syncDirectory(paths.blobDirectory);
  }
}

async function recoverMutationLockTemporaryFiles(
  flowDirectory: string,
  reservedBytes: number,
  hooks: PromptActivationStoreHooks,
): Promise<void> {
  const entries = (await readdir(flowDirectory, { withFileTypes: true })).filter((entry) =>
    entry.name.startsWith(".activations.mutation."),
  );
  if (entries.length > MAX_PROMPT_ACTIVATION_TEMPORARY_FILES) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      "prompt activation mutation temporary-file count exceeds its limit",
    );
  }
  let retainedBytes = reservedBytes;
  let retainedCount = 1;
  await hooks.beforeMutationTemporaryObserved?.();
  for (const entry of entries) {
    const ownedName = ownedMutationTemporaryNamePattern.exec(entry.name);
    if ((ownedName === null && !mutationTemporaryNamePattern.test(entry.name)) || !entry.isFile()) {
      throw new PromptActivationStoreError(
        "unsafe_state",
        "prompt activation mutation temporary path is unsafe",
      );
    }
    const path = join(flowDirectory, entry.name);
    const temporary = await observeTemporaryFile(
      path,
      4_096,
      "prompt activation mutation temporary file",
    );
    if (temporary === null) {
      continue;
    }
    let observed: ObservedMutationLock;
    try {
      observed = await readMutationLock(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      if (ownedName === null || !(error instanceof PromptActivationStoreError)) {
        throw error;
      }
      const pid = Number(ownedName[1]);
      const hostIdentity = ownedName[2];
      if (
        Number.isSafeInteger(pid) &&
        pid <= 2_147_483_647 &&
        hostIdentity === mutationHostIdentity(hostname()) &&
        !isProcessAlive(pid)
      ) {
        await removeObservedTemporaryFile(temporary);
        await syncDirectory(flowDirectory);
        continue;
      }
      retainedCount += 1;
      retainedBytes += Number(temporary.identity.size);
      assertMutationTemporaryCapacity(retainedCount, retainedBytes);
      continue;
    }
    if (
      ownedName !== null &&
      (Number(ownedName[1]) !== observed.owner.pid ||
        ownedName[2] !== mutationHostIdentity(observed.owner.hostname))
    ) {
      throw new PromptActivationStoreError(
        "unsafe_state",
        "prompt activation mutation temporary owner contradicts its file name",
      );
    }
    if (observed.owner.hostname === hostname() && !isProcessAlive(observed.owner.pid)) {
      try {
        await retireObservedMutationLock(path, observed, flowDirectory);
      } catch (error) {
        if (!(isNodeError(error) && error.code === "ENOENT")) {
          throw error;
        }
      }
      continue;
    }
    retainedCount += 1;
    retainedBytes += Number(observed.identity.size);
    assertMutationTemporaryCapacity(retainedCount, retainedBytes);
  }
}

function assertMutationTemporaryCapacity(count: number, bytes: number): void {
  if (count > MAX_PROMPT_ACTIVATION_TEMPORARY_FILES) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      "prompt activation mutation temporary-file count exceeds its limit",
    );
  }
  if (bytes > MAX_PROMPT_ACTIVATION_TEMPORARY_BYTES) {
    throw new PromptActivationStoreError(
      "limit_exceeded",
      "prompt activation mutation temporary bytes exceed their limit",
    );
  }
}

async function observeTemporaryFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<ObservedTemporaryFile | null> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.size > BigInt(maxBytes)) {
    throw new PromptActivationStoreError("unsafe_state", `${label} is not a bounded regular file`);
  }
  return Object.freeze({
    path,
    identity: Object.freeze({
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      ctimeNs: metadata.ctimeNs,
      mtimeNs: metadata.mtimeNs,
    }),
  });
}

async function removeObservedTemporaryFile(observed: ObservedTemporaryFile): Promise<void> {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(observed.path, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    current.dev !== observed.identity.dev ||
    current.ino !== observed.identity.ino ||
    current.size !== observed.identity.size ||
    current.ctimeNs !== observed.identity.ctimeNs ||
    current.mtimeNs !== observed.identity.mtimeNs
  ) {
    throw new PromptActivationStoreError(
      "unsafe_state",
      "prompt activation temporary file changed during recovery",
    );
  }
  await unlink(observed.path);
}

interface MutationLock {
  readonly release: () => Promise<void>;
}

async function acquireMutationLock(
  flowDirectory: string,
  hooks: PromptActivationStoreHooks,
  signal?: AbortSignal,
): Promise<MutationLock> {
  signal?.throwIfAborted();
  const path = join(flowDirectory, "activations.mutation.lock");
  const ownerValue = Object.freeze({
    version: 1 as const,
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
  });
  const owner = `${JSON.stringify(ownerValue)}\n`;
  await awaitBeforeMutationOwnership(
    recoverMutationLockTemporaryFiles(flowDirectory, Buffer.byteLength(owner, "utf8"), hooks),
    signal,
  );
  const temporary = join(
    flowDirectory,
    `.activations.mutation.${ownerValue.pid}.${mutationHostIdentity(ownerValue.hostname)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    signal?.throwIfAborted();
    await handle.writeFile(owner, "utf8");
    signal?.throwIfAborted();
    await handle.sync();
    signal?.throwIfAborted();
    await handle.close();
    handle = undefined;
    signal?.throwIfAborted();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    signal?.throwIfAborted();
    throw new PromptActivationStoreError(
      "io",
      "could not prepare prompt activation mutation lock",
      {
        cause: error,
      },
    );
  }
  let published = false;
  try {
    await awaitBeforeMutationOwnership(
      hooks.beforeMutationLockLinked?.() ?? Promise.resolve(),
      signal,
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      signal?.throwIfAborted();
      try {
        await link(temporary, path);
        published = true;
        break;
      } catch (error) {
        signal?.throwIfAborted();
        if (!(isNodeError(error) && error.code === "EEXIST")) {
          throw error;
        }
        let observed: ObservedMutationLock;
        try {
          observed = await awaitBeforeMutationOwnership(readMutationLock(path), signal);
        } catch (readError) {
          if (isNodeError(readError) && readError.code === "ENOENT") {
            continue;
          }
          throw readError;
        }
        if (
          observed.owner.hostname === ownerValue.hostname &&
          !isProcessAlive(observed.owner.pid)
        ) {
          try {
            await awaitBeforeMutationOwnership(
              retireObservedMutationLock(path, observed, flowDirectory),
              signal,
            );
          } catch (retireError) {
            if (!(isNodeError(retireError) && retireError.code === "ENOENT")) {
              throw retireError;
            }
          }
          continue;
        }
        throw new PromptActivationStoreError(
          "busy",
          `prompt activation mutation lock is held by pid ${observed.owner.pid} on ${observed.owner.hostname}`,
        );
      }
    }
    if (!published) {
      throw new PromptActivationStoreError(
        "busy",
        "prompt activation mutation lock changed repeatedly during acquisition",
      );
    }
    await unlink(temporary);
    await syncDirectory(flowDirectory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (published) {
      await removeOwnedMutationLock(path, owner, flowDirectory).catch(() => undefined);
    } else {
      signal?.throwIfAborted();
    }
    if (error instanceof PromptActivationStoreError) {
      throw error;
    }
    throw new PromptActivationStoreError(
      "io",
      "could not publish prompt activation mutation lock",
      { cause: error },
    );
  }
  return Object.freeze({
    async release(): Promise<void> {
      const current = await readBoundedRegularFile(path, 4_096);
      if (current.toString("utf8") !== owner) {
        throw new PromptActivationStoreError(
          "unsafe_state",
          "prompt activation mutation lock owner changed",
        );
      }
      await unlink(path);
      await syncDirectory(flowDirectory);
    },
  });
}

async function awaitBeforeMutationOwnership<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const result = await operation;
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}

function mutationHostIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function removeOwnedMutationLock(
  path: string,
  owner: string,
  flowDirectory: string,
): Promise<void> {
  const current = await readBoundedRegularFile(path, 4_096);
  if (current.toString("utf8") !== owner) {
    throw new PromptActivationStoreError(
      "unsafe_state",
      "prompt activation mutation lock owner changed during cleanup",
    );
  }
  await unlink(path);
  await syncDirectory(flowDirectory);
}

interface ObservedMutationLock {
  readonly owner: z.infer<typeof mutationLockOwnerSchema>;
  readonly identity: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly ctimeNs: bigint;
    readonly mtimeNs: bigint;
  };
}

async function readMutationLock(path: string): Promise<ObservedMutationLock> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw error;
    }
    throw new PromptActivationStoreError(
      "unsafe_state",
      "prompt activation mutation lock is unsafe or unreadable",
      { cause: error },
    );
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size > 4_096n) {
      throw new PromptActivationStoreError(
        "unsafe_state",
        "prompt activation mutation lock is not a bounded regular file",
      );
    }
    const content = await handle.readFile();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const owner = mutationLockOwnerSchema.parse(
      parseStrictJson(text, {
        maxDepth: 4,
        maxNodes: 16,
        valueLabel: "prompt activation mutation lock",
      }),
    );
    return Object.freeze({
      owner,
      identity: Object.freeze({
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        ctimeNs: metadata.ctimeNs,
        mtimeNs: metadata.mtimeNs,
      }),
    });
  } catch (error) {
    if (error instanceof PromptActivationStoreError) {
      throw error;
    }
    throw new PromptActivationStoreError(
      "unsafe_state",
      "prompt activation mutation lock owner is invalid",
      { cause: error },
    );
  } finally {
    await handle.close();
  }
}

async function retireObservedMutationLock(
  path: string,
  observed: ObservedMutationLock,
  flowDirectory: string,
): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (
    current.dev !== observed.identity.dev ||
    current.ino !== observed.identity.ino ||
    current.size !== observed.identity.size ||
    current.ctimeNs !== observed.identity.ctimeNs ||
    current.mtimeNs !== observed.identity.mtimeNs
  ) {
    throw new PromptActivationStoreError(
      "busy",
      "prompt activation mutation lock changed during stale-owner recovery",
    );
  }
  await unlink(path);
  await syncDirectory(flowDirectory);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

async function withMutationLock<Value>(
  lock: MutationLock,
  hooks: PromptActivationStoreHooks,
  operation: () => Promise<Value>,
): Promise<Value> {
  let result: Value | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await hooks.beforeMutationLockRelease?.();
    await lock.release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined) {
    if (releaseError !== undefined) {
      throw new PromptActivationStoreError(
        "unsafe_state",
        "prompt activation mutation and lock release both failed",
        { cause: new AggregateError([operationError, releaseError]) },
      );
    }
    throw operationError;
  }
  if (releaseError !== undefined) {
    throw new PromptActivationStoreError(
      "commit_uncertain",
      "prompt activation changed but its mutation lock was not released",
      { cause: releaseError },
    );
  }
  return result as Value;
}

async function ensureActivationDirectories(paths: PromptActivationStorePaths): Promise<void> {
  await ensureRealDirectory(paths.activationDirectory, paths.flowDirectory);
  await ensureRealDirectory(paths.blobDirectory, paths.activationDirectory);
}

async function ensureRealDirectory(path: string, parent?: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(parent ?? join(path, ".."));
  } catch (error) {
    if (!(isNodeError(error) && error.code === "EEXIST")) {
      throw new PromptActivationStoreError("io", `could not create directory "${path}"`, {
        cause: error,
      });
    }
  }
  await requireRealDirectory(path);
}

async function requireRealDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new PromptActivationStoreError(
      "unsafe_state",
      `prompt activation path "${path}" must be a real directory`,
    );
  }
}

async function requireActivationDirectory(
  paths: PromptActivationStorePaths,
  required: boolean,
): Promise<boolean> {
  try {
    await requireRealDirectory(paths.activationDirectory);
    return true;
  } catch (error) {
    if (!required && isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function activationBlobPath(paths: PromptActivationStorePaths, digest: string): string {
  return join(paths.blobDirectory, `${digest}.json`);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function calculateIndexDigest(
  index: Omit<PromptActivationIndex, "digest"> | PromptActivationIndex,
): string {
  return sha256(
    canonicalize({
      version: index.version,
      activations: index.activations,
      heads: index.heads,
      history: index.history,
    }),
  );
}

function calculateTransitionDigest(transition: PromptActivationTransition): string {
  const { transitionDigest: _transitionDigest, ...content } = transition;
  return sha256(canonicalize(content));
}

function artifactKey(entry: PromptActivationArtifactEntry): string {
  if (entry.kind !== undefined) {
    return `${entry.workflowId}\0${entry.kind}\0${entry.candidateId}\0${entry.candidateVersion}\0${entry.selection}`;
  }
  return `${entry.workflowId}\0${entry.candidateId}\0${entry.candidateVersion}\0${entry.selection}`;
}

function artifactActivationKind(
  entry: PromptActivationArtifactEntry,
): AdaptiveActivationSnapshot["kind"] {
  return entry.kind ?? "prompt-activation";
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new PromptActivationStoreError(
        "unsafe_state",
        "prompt activation index must be a real regular file",
      );
    }
    if (metadata.size > maxBytes) {
      throw new PromptActivationStoreError(
        "invalid_index",
        `prompt activation index exceeds ${maxBytes} bytes`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseActor(value: string): string {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    throw new PromptActivationStoreError("invalid_input", "activation actor label is invalid");
  }
  return parsed.data;
}

function parseActivationSelections(input: PreviewPromptActivationInput): {
  readonly snapshot: AdaptiveActivationSnapshot;
  readonly baselineSnapshot: AdaptiveActivationSnapshot;
} {
  const snapshot = parseAdaptiveActivationSnapshot(input.snapshot);
  const baselineSnapshot = parseAdaptiveActivationSnapshot(input.baselineSnapshot);
  if (
    snapshot.kind !== baselineSnapshot.kind ||
    snapshot.selection !== "candidate" ||
    baselineSnapshot.selection !== "baseline" ||
    snapshot.workflowId !== baselineSnapshot.workflowId ||
    snapshot.candidateId !== baselineSnapshot.candidateId ||
    snapshot.candidateVersion !== baselineSnapshot.candidateVersion ||
    canonicalize(snapshot.candidate) !== canonicalize(baselineSnapshot.candidate) ||
    canonicalize(snapshot.evaluation) !== canonicalize(baselineSnapshot.evaluation)
  ) {
    throw new PromptActivationStoreError(
      "identity_conflict",
      "candidate and baseline activation selections do not match",
    );
  }
  return Object.freeze({ snapshot, baselineSnapshot });
}

function parseReason(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = reasonSchema.safeParse(value);
  if (!parsed.success) {
    throw new PromptActivationStoreError("invalid_input", "activation reason is invalid");
  }
  return parsed.data;
}

function parseDigest(value: string, label: string): string {
  const parsed = sha256Schema.safeParse(value);
  if (!parsed.success) {
    throw new PromptActivationStoreError("invalid_input", `${label} is invalid`);
  }
  return parsed.data;
}

function parseIdentifier(value: string, label: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new PromptActivationStoreError("invalid_input", `${label} is invalid`);
  }
  return parsed.data;
}

function parseRollbackTarget(
  value: PromptActivationRollbackTarget | null,
): PromptActivationRollbackTarget | null {
  if (value === null) {
    return null;
  }
  return Object.freeze({
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    candidateId: parseIdentifier(value.candidateId, "rollback candidate id"),
    candidateVersion: parseSemanticVersion(value.candidateVersion, "rollback candidate version"),
  });
}

function parseSemanticVersion(value: string, label: string): string {
  const parsed = semverSchema.safeParse(value);
  if (!parsed.success) {
    throw new PromptActivationStoreError("invalid_input", `${label} is invalid`);
  }
  return parsed.data;
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareStrings(values[index - 1] ?? "", values[index] ?? "") >= 0) {
      throw new PromptActivationStoreError(
        "invalid_index",
        `${label} must be strictly sorted and unique`,
      );
    }
  }
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new PromptActivationStoreError("invalid_input", "value is not canonical JSON");
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedText(value: string, bytes: number): string {
  const content = Buffer.from(value, "utf8");
  if (content.byteLength <= bytes) {
    return value;
  }
  return `${content.subarray(0, Math.max(0, bytes - 3)).toString("utf8")}...`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
