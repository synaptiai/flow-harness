import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants, type Dir } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { PreparedEffectiveHarnessActivation } from "../../application/prepare-effective-harness-activation.js";
import {
  type EffectiveHarnessCandidateArtifact,
  encodeEffectiveHarnessCandidateArtifact,
  MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES,
  parseEffectiveHarnessCandidateArtifact,
} from "../../domain/adaptation/effective-harness-candidate.js";
import {
  calculateEffectiveHarnessStateDigest,
  createEffectiveHarnessHeadIdentity,
  type EffectiveHarnessHeadIdentity,
  type EffectiveHarnessState,
  MAX_EFFECTIVE_HARNESS_STATE_BYTES,
  parseEffectiveHarnessHeadIdentity,
  parseEffectiveHarnessState,
} from "../../domain/adaptation/effective-harness-state.js";
import {
  createEffectiveHarnessRollbackTransition,
  createEffectiveHarnessTransition,
  type EffectiveHarnessTransition,
  effectiveHarnessHeadFromTransition,
  parseEffectiveHarnessTransition,
} from "../../domain/adaptation/effective-harness-transition.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import {
  LocalPromptActivationStore,
  withLocalActivationMutationOwnership,
} from "./local-prompt-activation-store.js";

const MAX_EFFECTIVE_HARNESS_STATES = 256;
const MAX_EFFECTIVE_HARNESS_ARTIFACTS = 256;
const MAX_EFFECTIVE_HARNESS_TRANSITIONS = 4_096;
const MAX_EFFECTIVE_HARNESS_INDEX_BYTES = 4 * 1024 * 1024;
const LOCAL_EFFECTIVE_HARNESS_SCOPE_DOMAIN = "flow-local-effective-harness-scope-v1";
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const publicTextSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !Array.from(value).some((item) => (item.codePointAt(0) ?? 0) <= 31));

const stateEntrySchema = z
  .object({
    scopeDigest: sha256Schema,
    workflowId: identifierSchema,
    stateDigest: sha256Schema,
    bytes: z.number().int().positive().max(MAX_EFFECTIVE_HARNESS_STATE_BYTES),
  })
  .strict();
const artifactEntrySchema = z
  .object({
    scopeDigest: sha256Schema,
    workflowId: identifierSchema,
    artifactDigest: sha256Schema,
    baselineHeadDigest: sha256Schema,
    stateDigest: sha256Schema,
    candidateDigest: sha256Schema,
    bytes: z.number().int().positive().max(MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES),
  })
  .strict();
const indexSchema = z
  .object({
    version: z.literal(1),
    origins: z.array(z.unknown()).max(128),
    states: z.array(stateEntrySchema).max(MAX_EFFECTIVE_HARNESS_STATES),
    artifacts: z.array(artifactEntrySchema).max(MAX_EFFECTIVE_HARNESS_ARTIFACTS),
    heads: z.array(z.unknown()).max(128),
    history: z.array(z.unknown()).max(MAX_EFFECTIVE_HARNESS_TRANSITIONS),
    digest: sha256Schema,
  })
  .strict();

interface EffectiveHarnessStateEntry {
  readonly scopeDigest: string;
  readonly workflowId: string;
  readonly stateDigest: string;
  readonly bytes: number;
}

interface EffectiveHarnessArtifactEntry {
  readonly scopeDigest: string;
  readonly workflowId: string;
  readonly artifactDigest: string;
  readonly baselineHeadDigest: string;
  readonly stateDigest: string;
  readonly candidateDigest: string;
  readonly bytes: number;
}

interface EffectiveHarnessIndex {
  readonly version: 1;
  readonly origins: readonly EffectiveHarnessHeadIdentity[];
  readonly states: readonly EffectiveHarnessStateEntry[];
  readonly artifacts: readonly EffectiveHarnessArtifactEntry[];
  readonly heads: readonly EffectiveHarnessHeadIdentity[];
  readonly history: readonly EffectiveHarnessTransition[];
  readonly digest: string;
}

export interface EffectiveHarnessStoreHooks {
  readonly afterBlobPublished?: (
    kind: "baseline-state" | "candidate-state" | "candidate-artifact",
  ) => void | Promise<void>;
  readonly beforeIndexRenamed?: () => void | Promise<void>;
  /** @internal Deterministic rename-visible, pre-directory-sync settlement seam. */
  readonly beforeIndexDirectorySynced?: () => void | Promise<void>;
  readonly afterIndexRenamed?: () => void | Promise<void>;
  /** @internal Deterministic stable-read race seam. */
  readonly afterFileObserved?: (kind: "index" | "state" | "artifact") => void | Promise<void>;
}

export interface LocalEffectiveHarnessStoreOptions {
  readonly hooks?: EffectiveHarnessStoreHooks;
  readonly now?: () => Date;
  /** @internal Deterministic synthetic scope seam for domain fixtures. */
  readonly scopeDigest?: string;
  readonly readInitialHead?: (
    artifact: EffectiveHarnessCandidateArtifact,
  ) => Promise<EffectiveHarnessHeadIdentity>;
}

export interface EffectiveHarnessActivationProposal {
  readonly version: 1;
  readonly action: "activate";
  readonly workflowId: string;
  readonly currentHeadDigest: string;
  readonly artifactDigest: string;
  readonly candidateStateDigest: string;
  readonly evaluationReportDigest: string;
  readonly actor: string;
  readonly reason?: string | undefined;
  readonly proposalDigest: string;
}

export interface EffectiveHarnessRollbackProposal {
  readonly version: 1;
  readonly action: "rollback";
  readonly workflowId: string;
  readonly currentHeadDigest: string;
  readonly targetStateDigest: string;
  readonly targetTransitionDigest: string;
  readonly actor: string;
  readonly reason?: string | undefined;
  readonly proposalDigest: string;
}

export type EffectiveHarnessStoreErrorCode =
  | "busy"
  | "commit_uncertain"
  | "corrupt"
  | "invalid_input"
  | "io"
  | "not_found"
  | "stale_proposal"
  | "unsafe_state";

export class EffectiveHarnessStoreError extends Error {
  override readonly name = "EffectiveHarnessStoreError";

  constructor(
    readonly code: EffectiveHarnessStoreErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export class LocalEffectiveHarnessStore {
  readonly #hooks: EffectiveHarnessStoreHooks;
  readonly #now: () => Date;
  readonly #scopeDigest: Promise<string>;
  readonly #readInitialHead: (
    artifact: EffectiveHarnessCandidateArtifact,
  ) => Promise<EffectiveHarnessHeadIdentity>;

  constructor(
    readonly projectRoot: string,
    options: LocalEffectiveHarnessStoreOptions = {},
  ) {
    this.#hooks = options.hooks ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#scopeDigest =
      options.scopeDigest === undefined
        ? calculateLocalEffectiveHarnessScopeDigest(this.projectRoot)
        : Promise.resolve(parseDigest(options.scopeDigest));
    this.#readInitialHead =
      options.readInitialHead ??
      (async (artifact) => {
        const legacy = await new LocalPromptActivationStore(this.projectRoot).list();
        const head = legacy.heads.find((item) => item.workflowId === artifact.workflowId);
        if (
          head === undefined ||
          head.activationDigest === null ||
          head.generation !== artifact.baselineHead.generation ||
          head.activationDigest !== artifact.baselineHead.activationDigest ||
          head.lastTransitionDigest !== artifact.baselineHead.transitionDigest
        ) {
          throw new EffectiveHarnessStoreError(
            "stale_proposal",
            "effective harness legacy origin changed",
          );
        }
        return artifact.baselineHead;
      });
  }

  async stageCandidate(
    input: EffectiveHarnessCandidateArtifact,
    signal?: AbortSignal,
  ): Promise<{
    readonly path: string;
    readonly artifactDigest: string;
    readonly stateDigest: string;
  }> {
    signal?.throwIfAborted();
    const artifact = parseEffectiveHarnessCandidateArtifact(input);
    await this.#assertArtifactScope(artifact);
    signal?.throwIfAborted();
    return await withLocalActivationMutationOwnership(
      this.projectRoot,
      signal,
      async (flowDirectory) => {
        const paths = await ensureStorePaths(flowDirectory);
        const index = await this.#readIndexFrom(paths);
        await this.#currentHead(index, artifact);
        await assertBlobInventoryCapacity(paths, artifact);
        await publishState(paths, artifact.baselineState, "baseline-state", this.#hooks);
        await publishState(paths, artifact.candidateState, "candidate-state", this.#hooks);
        await publishArtifact(paths, artifact, this.#hooks);
        return deepFreeze({
          path: join(paths.artifacts, `${artifact.artifactDigest}.json`),
          artifactDigest: artifact.artifactDigest,
          stateDigest: artifact.candidateState.stateDigest,
        });
      },
    );
  }

  async previewActivate(input: {
    readonly prepared: PreparedEffectiveHarnessActivation;
    readonly actor: string;
    readonly reason?: string | undefined;
    readonly signal?: AbortSignal;
  }): Promise<EffectiveHarnessActivationProposal> {
    input.signal?.throwIfAborted();
    const artifact = parseEffectiveHarnessCandidateArtifact(input.prepared.artifact);
    await this.#assertArtifactScope(artifact);
    input.signal?.throwIfAborted();
    const actor = parsePublicText(input.actor, "actor", 128);
    const reason = parseOptionalReason(input.reason);
    const index = await this.#readIndex();
    input.signal?.throwIfAborted();
    const prior = await this.#currentHead(index, artifact);
    input.signal?.throwIfAborted();
    return activationProposal(prior, input.prepared, actor, reason);
  }

  async applyActivate(input: {
    readonly prepared: PreparedEffectiveHarnessActivation;
    readonly actor: string;
    readonly reason?: string | undefined;
    readonly expectedDigest: string;
    readonly signal?: AbortSignal;
  }) {
    input.signal?.throwIfAborted();
    const artifact = parseEffectiveHarnessCandidateArtifact(input.prepared.artifact);
    await this.#assertArtifactScope(artifact);
    input.signal?.throwIfAborted();
    const actor = parsePublicText(input.actor, "actor", 128);
    const reason = parseOptionalReason(input.reason);
    const expectedDigest = parseDigest(input.expectedDigest);
    return await withLocalActivationMutationOwnership(
      this.projectRoot,
      input.signal,
      async (flowDirectory) => {
        const paths = await ensureStorePaths(flowDirectory);
        const index = await this.#readIndexFrom(paths);
        const settled = settledActivation(index, input.prepared, actor, reason, expectedDigest);
        if (settled !== undefined) {
          return deepFreeze({ status: "already_active" as const, ...settled });
        }
        const prior = await this.#currentHead(index, artifact);
        const proposal = activationProposal(prior, input.prepared, actor, reason);
        if (proposal.proposalDigest !== expectedDigest) {
          throw new EffectiveHarnessStoreError(
            "stale_proposal",
            "effective harness activation proposal is stale",
          );
        }
        await assertBlobInventoryCapacity(paths, artifact);
        const transition = createEffectiveHarnessTransition({
          prior,
          toActivationDigest: artifact.artifactDigest,
          toStateDigest: artifact.candidateState.stateDigest,
          surface: artifact.surface,
          candidate: {
            kind: candidateKind(artifact),
            digest: artifact.candidate.candidateDigest,
          },
          evaluation: input.prepared.evaluation,
          actor,
          ...(reason === undefined ? {} : { reason }),
          changedAt: this.#now().toISOString(),
        });
        const head = effectiveHarnessHeadFromTransition(transition);
        const next = nextActivationIndex(index, artifact, transition, head);
        await publishState(paths, artifact.baselineState, "baseline-state", this.#hooks);
        await publishState(paths, artifact.candidateState, "candidate-state", this.#hooks);
        await publishArtifact(paths, artifact, this.#hooks);
        await publishIndex(paths, next, this.#hooks);
        return deepFreeze({ status: "activated" as const, head, transition });
      },
    );
  }

  async previewRollback(input: {
    readonly workflowId: string;
    readonly targetStateDigest: string;
    readonly actor: string;
    readonly reason?: string | undefined;
    readonly signal?: AbortSignal;
  }): Promise<EffectiveHarnessRollbackProposal> {
    input.signal?.throwIfAborted();
    const workflowId = parseIdentifier(input.workflowId);
    const targetStateDigest = parseDigest(input.targetStateDigest);
    const actor = parsePublicText(input.actor, "actor", 128);
    const reason = parseOptionalReason(input.reason);
    const index = await this.#readIndex();
    input.signal?.throwIfAborted();
    return rollbackProposal(index, workflowId, targetStateDigest, actor, reason);
  }

  async applyRollback(input: {
    readonly workflowId: string;
    readonly targetStateDigest: string;
    readonly actor: string;
    readonly reason?: string | undefined;
    readonly expectedDigest: string;
    readonly signal?: AbortSignal;
  }) {
    input.signal?.throwIfAborted();
    const workflowId = parseIdentifier(input.workflowId);
    const targetStateDigest = parseDigest(input.targetStateDigest);
    const actor = parsePublicText(input.actor, "actor", 128);
    const reason = parseOptionalReason(input.reason);
    const expectedDigest = parseDigest(input.expectedDigest);
    return await withLocalActivationMutationOwnership(
      this.projectRoot,
      input.signal,
      async (flowDirectory) => {
        const paths = await ensureStorePaths(flowDirectory);
        const index = await this.#readIndexFrom(paths);
        const settled = settledRollback(
          index,
          workflowId,
          targetStateDigest,
          actor,
          reason,
          expectedDigest,
        );
        if (settled !== undefined) {
          return deepFreeze({ status: "already_rolled_back" as const, ...settled });
        }
        const proposal = rollbackProposal(index, workflowId, targetStateDigest, actor, reason);
        if (proposal.proposalDigest !== expectedDigest) {
          throw new EffectiveHarnessStoreError(
            "stale_proposal",
            "effective harness rollback proposal is stale",
          );
        }
        const prior = requiredHead(index, workflowId);
        const target = rollbackTarget(index, workflowId, targetStateDigest);
        const transition = createEffectiveHarnessRollbackTransition({
          prior,
          toActivationDigest: target.activationDigest,
          toStateDigest: targetStateDigest,
          targetTransitionDigest: target.transitionDigest,
          actor,
          ...(reason === undefined ? {} : { reason }),
          changedAt: this.#now().toISOString(),
        });
        const head = effectiveHarnessHeadFromTransition(transition);
        const content = {
          version: 1 as const,
          origins: index.origins,
          states: index.states,
          artifacts: index.artifacts,
          heads: replaceHead(index.heads, head),
          history: [...index.history, transition],
        };
        const next = parseIndex({ ...content, digest: calculateIndexDigest(content) });
        await publishIndex(paths, next, this.#hooks);
        return deepFreeze({ status: "rolled_back" as const, head, transition });
      },
    );
  }

  async loadActive(workflowIdInput: string): Promise<{
    readonly head: EffectiveHarnessHeadIdentity;
    readonly state: EffectiveHarnessState;
  }> {
    const workflowId = parseIdentifier(workflowIdInput);
    const paths = await storePaths(this.projectRoot);
    const index = await this.#readIndexFrom(paths);
    const head = requiredHead(index, workflowId);
    const entry = index.states.find(
      (item) => item.workflowId === workflowId && item.stateDigest === head.stateDigest,
    );
    if (entry === undefined) {
      throw new EffectiveHarnessStoreError("corrupt", "effective harness head has no state");
    }
    return deepFreeze({ head, state: await readState(paths, entry) });
  }

  async list(): Promise<EffectiveHarnessIndex> {
    return await this.#readIndex();
  }

  async #readIndex(): Promise<EffectiveHarnessIndex> {
    return await this.#readIndexFrom(await storePaths(this.projectRoot));
  }

  async #readIndexFrom(paths: EffectiveHarnessStorePaths): Promise<EffectiveHarnessIndex> {
    let content: Buffer;
    try {
      content = await readBounded(
        paths.indexPath,
        MAX_EFFECTIVE_HARNESS_INDEX_BYTES,
        this.#hooks,
        "index",
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        const empty = emptyIndex();
        await validateBlobInventory(paths, empty, await this.#scopeDigest, this.#hooks);
        return empty;
      }
      if (error instanceof EffectiveHarnessStoreError) throw error;
      throw new EffectiveHarnessStoreError("io", "effective harness index cannot be read");
    }
    let parsed: EffectiveHarnessIndex;
    try {
      parsed = parseIndex(
        parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(content), {
          maxDepth: 32,
          maxNodes: 200_000,
          valueLabel: "effective harness index",
        }),
      );
    } catch {
      throw new EffectiveHarnessStoreError("corrupt", "effective harness index is invalid");
    }
    if (!indexHasOnlyScope(parsed, await this.#scopeDigest)) {
      throw new EffectiveHarnessStoreError(
        "corrupt",
        "effective harness index belongs to a different project scope",
      );
    }
    await validateBlobInventory(paths, parsed, await this.#scopeDigest, this.#hooks);
    return parsed;
  }

  async #currentHead(
    index: EffectiveHarnessIndex,
    artifact: EffectiveHarnessCandidateArtifact,
  ): Promise<EffectiveHarnessHeadIdentity> {
    const existing = index.heads.find((item) => item.workflowId === artifact.workflowId);
    const prior = existing ?? (await this.#readInitialHead(artifact));
    if (prior.headDigest !== artifact.baselineHead.headDigest) {
      throw new EffectiveHarnessStoreError(
        "stale_proposal",
        "effective harness candidate baseline is stale",
      );
    }
    return prior;
  }

  async #assertArtifactScope(artifact: EffectiveHarnessCandidateArtifact): Promise<void> {
    if (artifact.scopeDigest !== (await this.#scopeDigest)) {
      throw new EffectiveHarnessStoreError(
        "invalid_input",
        "effective harness candidate belongs to a different project scope",
      );
    }
  }
}

export async function calculateLocalEffectiveHarnessScopeDigest(
  projectRoot: string,
): Promise<string> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(projectRoot);
  } catch {
    throw new EffectiveHarnessStoreError(
      "unsafe_state",
      "effective harness project root is unavailable",
    );
  }
  return sha256(`${LOCAL_EFFECTIVE_HARNESS_SCOPE_DOMAIN}\0${canonicalRoot}`);
}

export async function hasEffectiveHarnessHead(
  projectRoot: string,
  workflowId: string,
): Promise<boolean> {
  const parsedWorkflowId = parseIdentifier(workflowId);
  const index = await new LocalEffectiveHarnessStore(projectRoot).list();
  return index.heads.some((item) => item.workflowId === parsedWorkflowId);
}

interface EffectiveHarnessStorePaths {
  readonly root: string;
  readonly states: string;
  readonly artifacts: string;
  readonly indexPath: string;
}

async function storePaths(projectRoot: string): Promise<EffectiveHarnessStorePaths> {
  const flowDirectory = join(await realpath(projectRoot), ".flow");
  const paths = {
    root: join(flowDirectory, "effective-harness"),
    states: join(flowDirectory, "effective-harness", "states"),
    artifacts: join(flowDirectory, "effective-harness", "artifacts"),
    indexPath: join(flowDirectory, "effective-harness", "index.json"),
  };
  for (const path of [flowDirectory, paths.root, paths.states, paths.artifacts]) {
    await assertSafeExistingDirectory(path);
  }
  return paths;
}

async function assertSafeExistingDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || (await realpath(path)) !== path) {
      throw new EffectiveHarnessStoreError("unsafe_state", "effective harness path is unsafe");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    if (error instanceof EffectiveHarnessStoreError) throw error;
    throw new EffectiveHarnessStoreError("unsafe_state", "effective harness path is unsafe");
  }
}

async function ensureStorePaths(flowDirectory: string): Promise<EffectiveHarnessStorePaths> {
  const paths = {
    root: join(flowDirectory, "effective-harness"),
    states: join(flowDirectory, "effective-harness", "states"),
    artifacts: join(flowDirectory, "effective-harness", "artifacts"),
    indexPath: join(flowDirectory, "effective-harness", "index.json"),
  };
  for (const path of [paths.root, paths.states, paths.artifacts]) {
    await mkdir(path, { mode: 0o700, recursive: true });
    if ((await realpath(path)) !== path) {
      throw new EffectiveHarnessStoreError("unsafe_state", "effective harness path is unsafe");
    }
  }
  return paths;
}

function emptyIndex(): EffectiveHarnessIndex {
  const content = {
    version: 1 as const,
    origins: [],
    states: [],
    artifacts: [],
    heads: [],
    history: [],
  };
  return deepFreeze({ ...content, digest: calculateIndexDigest(content) });
}

function indexHasOnlyScope(index: EffectiveHarnessIndex, scopeDigest: string): boolean {
  return [
    ...index.origins,
    ...index.states,
    ...index.artifacts,
    ...index.heads,
    ...index.history,
  ].every((item) => item.scopeDigest === scopeDigest);
}

function parseIndex(input: unknown): EffectiveHarnessIndex {
  const raw = indexSchema.parse(input);
  if (calculateIndexDigest(raw) !== raw.digest) throw new Error("index digest mismatch");
  const origins = raw.origins.map((item) =>
    parseEffectiveHarnessHeadIdentity(item as EffectiveHarnessHeadIdentity, {
      scopeDigest: (item as EffectiveHarnessHeadIdentity).scopeDigest,
    }),
  );
  const states = new Map(
    raw.states.map((item) => [
      storeIdentityKey(item.scopeDigest, item.workflowId, item.stateDigest),
      item,
    ]),
  );
  const artifacts = new Map(
    raw.artifacts.map((item) => [
      storeIdentityKey(item.scopeDigest, item.workflowId, item.artifactDigest),
      item,
    ]),
  );
  if (
    new Set(origins.map((item) => item.workflowId)).size !== origins.length ||
    new Set(origins.map((item) => item.transitionDigest)).size !== origins.length ||
    states.size !== raw.states.length ||
    artifacts.size !== raw.artifacts.length
  ) {
    throw new Error("index identity duplicate");
  }
  const retained = new Map<
    string,
    { readonly workflowId: string; readonly stateDigest: string; readonly activationDigest: string }
  >();
  for (const origin of origins) {
    if (
      !states.has(storeIdentityKey(origin.scopeDigest, origin.workflowId, origin.stateDigest)) ||
      retained.has(origin.transitionDigest)
    ) {
      throw new Error("origin dependency missing");
    }
    retained.set(origin.transitionDigest, {
      workflowId: origin.workflowId,
      stateDigest: origin.stateDigest,
      activationDigest: origin.activationDigest,
    });
  }
  const history: EffectiveHarnessTransition[] = [];
  const current = new Map(origins.map((item) => [item.workflowId, item]));
  for (const rawTransition of raw.history) {
    const workflowId = (rawTransition as EffectiveHarnessTransition).workflowId;
    const prior = current.get(workflowId);
    if (prior === undefined) throw new Error("transition origin missing");
    const transition = parseEffectiveHarnessTransition(rawTransition, {
      scopeDigest: prior.scopeDigest,
      prior,
    });
    if (
      !states.has(
        storeIdentityKey(transition.scopeDigest, transition.workflowId, transition.toStateDigest),
      ) ||
      retained.has(transition.transitionDigest)
    ) {
      throw new Error("transition dependency missing");
    }
    if (transition.action === "activate") {
      const artifact = artifacts.get(
        storeIdentityKey(
          transition.scopeDigest,
          transition.workflowId,
          transition.toActivationDigest,
        ),
      );
      if (
        artifact?.baselineHeadDigest !== prior.headDigest ||
        artifact?.stateDigest !== transition.toStateDigest ||
        artifact.candidateDigest !== transition.candidate.digest
      ) {
        throw new Error("activation artifact missing");
      }
    } else {
      const target = retained.get(transition.targetTransitionDigest);
      if (
        target?.workflowId !== transition.workflowId ||
        target.stateDigest !== transition.toStateDigest ||
        target.activationDigest !== transition.toActivationDigest
      ) {
        throw new Error("rollback target mismatch");
      }
    }
    history.push(transition);
    retained.set(transition.transitionDigest, {
      workflowId: transition.workflowId,
      stateDigest: transition.toStateDigest,
      activationDigest: transition.toActivationDigest,
    });
    current.set(workflowId, effectiveHarnessHeadFromTransition(transition));
  }
  const heads = raw.heads.map((item) =>
    parseEffectiveHarnessHeadIdentity(item as EffectiveHarnessHeadIdentity, {
      scopeDigest: (item as EffectiveHarnessHeadIdentity).scopeDigest,
    }),
  );
  if (
    heads.length !== current.size ||
    new Set(heads.map((head) => head.workflowId)).size !== heads.length ||
    heads.some((head) => current.get(head.workflowId)?.headDigest !== head.headDigest) ||
    new Set(raw.states.map((item) => item.stateDigest)).size !== raw.states.length ||
    new Set(raw.artifacts.map((item) => item.artifactDigest)).size !== raw.artifacts.length
  ) {
    throw new Error("index history mismatch");
  }
  for (const head of heads) {
    if (!states.has(storeIdentityKey(head.scopeDigest, head.workflowId, head.stateDigest))) {
      throw new Error("head state missing");
    }
  }
  return deepFreeze({ ...raw, origins, heads, history });
}

async function validateBlobInventory(
  paths: EffectiveHarnessStorePaths,
  index: EffectiveHarnessIndex,
  scopeDigest: string,
  hooks: EffectiveHarnessStoreHooks,
): Promise<void> {
  const stateNames = await boundedBlobNames(paths.states, MAX_EFFECTIVE_HARNESS_STATES);
  const artifactNames = await boundedBlobNames(paths.artifacts, MAX_EFFECTIVE_HARNESS_ARTIFACTS);
  const indexedStates = new Map(index.states.map((entry) => [`${entry.stateDigest}.json`, entry]));
  const indexedArtifacts = new Map(
    index.artifacts.map((entry) => [`${entry.artifactDigest}.json`, entry]),
  );
  if (
    [...indexedStates.keys()].some((name) => !stateNames.includes(name)) ||
    [...indexedArtifacts.keys()].some((name) => !artifactNames.includes(name))
  ) {
    throw new EffectiveHarnessStoreError("corrupt", "effective harness inventory is incomplete");
  }
  for (const name of stateNames) {
    const indexed = indexedStates.get(name);
    if (indexed === undefined) {
      await readUnindexedState(paths, name, scopeDigest, hooks);
    } else {
      await readState(paths, indexed, hooks);
    }
  }
  for (const name of artifactNames) {
    const indexed = indexedArtifacts.get(name);
    if (indexed === undefined) {
      await readUnindexedArtifact(paths, name, scopeDigest, hooks);
    } else {
      await readArtifact(paths, indexed, hooks);
    }
  }
}

async function assertBlobInventoryCapacity(
  paths: EffectiveHarnessStorePaths,
  artifact: EffectiveHarnessCandidateArtifact,
): Promise<void> {
  const states = new Set(await boundedBlobNames(paths.states, MAX_EFFECTIVE_HARNESS_STATES));
  states.add(`${artifact.baselineState.stateDigest}.json`);
  states.add(`${artifact.candidateState.stateDigest}.json`);
  const artifacts = new Set(
    await boundedBlobNames(paths.artifacts, MAX_EFFECTIVE_HARNESS_ARTIFACTS),
  );
  artifacts.add(`${artifact.artifactDigest}.json`);
  if (
    states.size > MAX_EFFECTIVE_HARNESS_STATES ||
    artifacts.size > MAX_EFFECTIVE_HARNESS_ARTIFACTS
  ) {
    throw new EffectiveHarnessStoreError(
      "invalid_input",
      "effective harness inventory exceeds its entry limit",
    );
  }
}

async function boundedBlobNames(directory: string, maximum: number): Promise<string[]> {
  let opened: Dir;
  try {
    opened = await opendir(directory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw new EffectiveHarnessStoreError("corrupt", "effective harness inventory is invalid");
  }
  const names: string[] = [];
  try {
    for await (const entry of opened) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
        throw new EffectiveHarnessStoreError("corrupt", "effective harness inventory is invalid");
      }
      names.push(entry.name);
      if (names.length > maximum) {
        throw new EffectiveHarnessStoreError(
          "corrupt",
          "effective harness inventory exceeds its entry limit",
        );
      }
    }
  } catch (error) {
    await opened.close().catch(() => undefined);
    if (error instanceof EffectiveHarnessStoreError) throw error;
    throw new EffectiveHarnessStoreError("corrupt", "effective harness inventory is invalid");
  }
  return names.sort();
}

async function readUnindexedState(
  paths: EffectiveHarnessStorePaths,
  name: string,
  scopeDigest: string,
  hooks: EffectiveHarnessStoreHooks,
): Promise<void> {
  try {
    const digest = name.slice(0, -".json".length);
    const content = await readBounded(
      join(paths.states, name),
      MAX_EFFECTIVE_HARNESS_STATE_BYTES,
      hooks,
      "state",
    );
    const state = parseEffectiveHarnessState(
      parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(content), {
        maxDepth: 32,
        maxNodes: 500_000,
        valueLabel: "effective harness state",
      }),
      { scopeDigest },
    );
    if (state.stateDigest !== digest || calculateEffectiveHarnessStateDigest(state) !== digest) {
      throw new Error("state identity mismatch");
    }
  } catch {
    throw new EffectiveHarnessStoreError("corrupt", "effective harness state is invalid");
  }
}

async function readUnindexedArtifact(
  paths: EffectiveHarnessStorePaths,
  name: string,
  scopeDigest: string,
  hooks: EffectiveHarnessStoreHooks,
): Promise<void> {
  try {
    const digest = name.slice(0, -".json".length);
    const content = await readBounded(
      join(paths.artifacts, name),
      MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES,
      hooks,
      "artifact",
    );
    const artifact = parseEffectiveHarnessCandidateArtifact(
      parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(content), {
        maxDepth: 32,
        maxNodes: 500_000,
        valueLabel: "effective harness candidate",
      }),
      { scopeDigest },
    );
    if (artifact.artifactDigest !== digest) throw new Error("artifact identity mismatch");
  } catch {
    throw new EffectiveHarnessStoreError("corrupt", "effective harness candidate is invalid");
  }
}

function nextActivationIndex(
  index: EffectiveHarnessIndex,
  artifact: EffectiveHarnessCandidateArtifact,
  transition: EffectiveHarnessTransition,
  head: EffectiveHarnessHeadIdentity,
): EffectiveHarnessIndex {
  const stateEntries = [artifact.baselineState, artifact.candidateState].map(stateEntry);
  const states = uniqueBy([...index.states, ...stateEntries], (item) => item.stateDigest).sort(
    (a, b) => a.stateDigest.localeCompare(b.stateDigest),
  );
  const artifactContent = encodeEffectiveHarnessCandidateArtifact(artifact);
  const artifactEntry: EffectiveHarnessArtifactEntry = {
    scopeDigest: artifact.scopeDigest,
    workflowId: artifact.workflowId,
    artifactDigest: artifact.artifactDigest,
    baselineHeadDigest: artifact.baselineHead.headDigest,
    stateDigest: artifact.candidateState.stateDigest,
    candidateDigest: artifact.candidate.candidateDigest,
    bytes: artifactContent.byteLength,
  };
  const content = {
    version: 1 as const,
    origins: index.origins.some((item) => item.workflowId === artifact.workflowId)
      ? index.origins
      : [...index.origins, artifact.baselineHead].sort((a, b) =>
          a.workflowId.localeCompare(b.workflowId),
        ),
    states,
    artifacts: uniqueBy([...index.artifacts, artifactEntry], (item) => item.artifactDigest).sort(
      (a, b) => a.artifactDigest.localeCompare(b.artifactDigest),
    ),
    heads: replaceHead(index.heads, head),
    history: [...index.history, transition],
  };
  return parseIndex({ ...content, digest: calculateIndexDigest(content) });
}

function stateEntry(state: EffectiveHarnessState): EffectiveHarnessStateEntry {
  const content = encodeState(state);
  return {
    scopeDigest: state.scopeDigest,
    workflowId: state.workflowId,
    stateDigest: state.stateDigest,
    bytes: content.byteLength,
  };
}

function activationProposal(
  prior: EffectiveHarnessHeadIdentity,
  prepared: PreparedEffectiveHarnessActivation,
  actor: string,
  reason: string | undefined,
): EffectiveHarnessActivationProposal {
  const content = {
    version: 1 as const,
    action: "activate" as const,
    workflowId: prepared.artifact.workflowId,
    currentHeadDigest: prior.headDigest,
    artifactDigest: prepared.artifact.artifactDigest,
    candidateStateDigest: prepared.artifact.candidateState.stateDigest,
    evaluationReportDigest: prepared.evaluation.reportDigest,
    actor,
    ...(reason === undefined ? {} : { reason }),
  };
  return deepFreeze({ ...content, proposalDigest: sha256(canonicalize(content)) });
}

function settledActivation(
  index: EffectiveHarnessIndex,
  prepared: PreparedEffectiveHarnessActivation,
  actor: string,
  reason: string | undefined,
  expectedDigest: string,
):
  | {
      readonly head: EffectiveHarnessHeadIdentity;
      readonly transition: EffectiveHarnessTransition;
    }
  | undefined {
  const artifact = prepared.artifact;
  const head = index.heads.find((item) => item.workflowId === artifact.workflowId);
  const transition =
    head === undefined
      ? undefined
      : index.history.find((item) => item.transitionDigest === head.transitionDigest);
  if (
    head === undefined ||
    transition?.action !== "activate" ||
    head.activationDigest !== artifact.artifactDigest ||
    head.stateDigest !== artifact.candidateState.stateDigest ||
    transition.toActivationDigest !== artifact.artifactDigest ||
    transition.toStateDigest !== artifact.candidateState.stateDigest ||
    transition.surface !== artifact.surface ||
    transition.candidate.kind !== candidateKind(artifact) ||
    transition.candidate.digest !== artifact.candidate.candidateDigest ||
    transition.evaluation.id !== prepared.evaluation.id ||
    transition.evaluation.planDigest !== prepared.evaluation.planDigest ||
    transition.evaluation.terminalRecordDigest !== prepared.evaluation.terminalRecordDigest ||
    transition.evaluation.reportDigest !== prepared.evaluation.reportDigest ||
    transition.actor !== actor ||
    transition.reason !== reason
  ) {
    return undefined;
  }
  const prior = createEffectiveHarnessHeadIdentity({
    scopeDigest: transition.scopeDigest,
    workflowId: transition.workflowId,
    generation: transition.generation - 1,
    activationDigest: transition.fromActivationDigest,
    transitionDigest: transition.previousTransitionDigest,
    stateDigest: transition.fromStateDigest,
  });
  if (
    prior.headDigest !== artifact.baselineHead.headDigest ||
    activationProposal(prior, prepared, actor, reason).proposalDigest !== expectedDigest
  ) {
    return undefined;
  }
  return { head, transition };
}

function rollbackProposal(
  index: EffectiveHarnessIndex,
  workflowId: string,
  targetStateDigest: string,
  actor: string,
  reason: string | undefined,
): EffectiveHarnessRollbackProposal {
  const head = requiredHead(index, workflowId);
  const target = rollbackTarget(index, workflowId, targetStateDigest);
  if (head.stateDigest === targetStateDigest) {
    throw new EffectiveHarnessStoreError("invalid_input", "effective harness rollback is a no-op");
  }
  return rollbackProposalFromHead(
    head,
    workflowId,
    targetStateDigest,
    target.transitionDigest,
    actor,
    reason,
  );
}

function rollbackProposalFromHead(
  head: EffectiveHarnessHeadIdentity,
  workflowId: string,
  targetStateDigest: string,
  targetTransitionDigest: string,
  actor: string,
  reason: string | undefined,
): EffectiveHarnessRollbackProposal {
  const content = {
    version: 1 as const,
    action: "rollback" as const,
    workflowId,
    currentHeadDigest: head.headDigest,
    targetStateDigest,
    targetTransitionDigest,
    actor,
    ...(reason === undefined ? {} : { reason }),
  };
  return deepFreeze({ ...content, proposalDigest: sha256(canonicalize(content)) });
}

function settledRollback(
  index: EffectiveHarnessIndex,
  workflowId: string,
  targetStateDigest: string,
  actor: string,
  reason: string | undefined,
  expectedDigest: string,
):
  | {
      readonly head: EffectiveHarnessHeadIdentity;
      readonly transition: EffectiveHarnessTransition;
    }
  | undefined {
  const head = index.heads.find((item) => item.workflowId === workflowId);
  const transition =
    head === undefined
      ? undefined
      : index.history.find((item) => item.transitionDigest === head.transitionDigest);
  if (
    head === undefined ||
    transition?.action !== "rollback" ||
    transition.toStateDigest !== targetStateDigest ||
    head.stateDigest !== targetStateDigest ||
    head.activationDigest !== transition.toActivationDigest ||
    transition.actor !== actor ||
    transition.reason !== reason
  ) {
    return undefined;
  }
  const targetOrigin = index.origins.find(
    (item) =>
      item.workflowId === workflowId &&
      item.stateDigest === targetStateDigest &&
      item.transitionDigest === transition.targetTransitionDigest,
  );
  const targetTransition = index.history.find(
    (item) =>
      item.workflowId === workflowId &&
      item.toStateDigest === targetStateDigest &&
      item.transitionDigest === transition.targetTransitionDigest,
  );
  const targetActivationDigest =
    targetOrigin?.activationDigest ?? targetTransition?.toActivationDigest;
  if (
    targetActivationDigest === undefined ||
    targetActivationDigest !== transition.toActivationDigest
  ) {
    return undefined;
  }
  const prior = createEffectiveHarnessHeadIdentity({
    scopeDigest: transition.scopeDigest,
    workflowId: transition.workflowId,
    generation: transition.generation - 1,
    activationDigest: transition.fromActivationDigest,
    transitionDigest: transition.previousTransitionDigest,
    stateDigest: transition.fromStateDigest,
  });
  if (
    rollbackProposalFromHead(
      prior,
      workflowId,
      targetStateDigest,
      transition.targetTransitionDigest,
      actor,
      reason,
    ).proposalDigest !== expectedDigest
  ) {
    return undefined;
  }
  return { head, transition };
}

function rollbackTarget(index: EffectiveHarnessIndex, workflowId: string, stateDigest: string) {
  const origin = index.origins.find(
    (item) => item.workflowId === workflowId && item.stateDigest === stateDigest,
  );
  if (origin !== undefined) {
    return { activationDigest: origin.activationDigest, transitionDigest: origin.transitionDigest };
  }
  const transition = index.history
    .toReversed()
    .find((item) => item.workflowId === workflowId && item.toStateDigest === stateDigest);
  if (transition === undefined) {
    throw new EffectiveHarnessStoreError(
      "not_found",
      "effective harness rollback state is missing",
    );
  }
  return {
    activationDigest: transition.toActivationDigest,
    transitionDigest: transition.transitionDigest,
  };
}

function requiredHead(index: EffectiveHarnessIndex, workflowId: string) {
  const head = index.heads.find((item) => item.workflowId === workflowId);
  if (head === undefined)
    throw new EffectiveHarnessStoreError("not_found", "effective harness head is missing");
  return head;
}

function replaceHead(
  heads: readonly EffectiveHarnessHeadIdentity[],
  head: EffectiveHarnessHeadIdentity,
) {
  return [...heads.filter((item) => item.workflowId !== head.workflowId), head].sort((a, b) =>
    a.workflowId.localeCompare(b.workflowId),
  );
}

async function publishState(
  paths: EffectiveHarnessStorePaths,
  state: EffectiveHarnessState,
  kind: "baseline-state" | "candidate-state",
  hooks: EffectiveHarnessStoreHooks,
): Promise<void> {
  await publishBlob(
    join(paths.states, `${state.stateDigest}.json`),
    encodeState(state),
    async () => {
      await hooks.afterBlobPublished?.(kind);
    },
  );
}

async function publishArtifact(
  paths: EffectiveHarnessStorePaths,
  artifact: EffectiveHarnessCandidateArtifact,
  hooks: EffectiveHarnessStoreHooks,
): Promise<void> {
  await publishBlob(
    join(paths.artifacts, `${artifact.artifactDigest}.json`),
    encodeEffectiveHarnessCandidateArtifact(artifact),
    async () => {
      await hooks.afterBlobPublished?.("candidate-artifact");
    },
  );
}

async function publishBlob(
  target: string,
  content: Buffer,
  afterPublished: () => Promise<void>,
): Promise<void> {
  try {
    const existing = await readBounded(target, content.byteLength);
    if (!existing.equals(content))
      throw new EffectiveHarnessStoreError("corrupt", "effective harness blob changed");
    return;
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      if (error instanceof EffectiveHarnessStoreError) throw error;
      throw new EffectiveHarnessStoreError("io", "effective harness blob cannot be inspected");
    }
  }
  const temporary = join(join(target, ".."), `.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
    await afterPublished();
    await unlink(temporary);
    await syncDirectory(join(target, ".."));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (isNodeError(error) && error.code === "EEXIST") {
      const existing = await readBounded(target, content.byteLength);
      if (existing.equals(content)) return;
    }
    if (error instanceof EffectiveHarnessStoreError) throw error;
    throw new EffectiveHarnessStoreError("io", "effective harness blob cannot be published");
  }
}

async function publishIndex(
  paths: EffectiveHarnessStorePaths,
  index: EffectiveHarnessIndex,
  hooks: EffectiveHarnessStoreHooks,
): Promise<void> {
  const content = Buffer.from(`${JSON.stringify(index)}\n`, "utf8");
  if (content.byteLength > MAX_EFFECTIVE_HARNESS_INDEX_BYTES) {
    throw new EffectiveHarnessStoreError("invalid_input", "effective harness index is too large");
  }
  const temporary = join(paths.root, `.index.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let renamed = false;
  let directorySynced = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeIndexRenamed?.();
    await rename(temporary, paths.indexPath);
    renamed = true;
    await hooks.beforeIndexDirectorySynced?.();
    await syncDirectory(paths.root);
    directorySynced = true;
    await hooks.afterIndexRenamed?.();
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (renamed && directorySynced) {
      const reopened = await readBounded(
        paths.indexPath,
        MAX_EFFECTIVE_HARNESS_INDEX_BYTES,
        hooks,
        "index",
      ).catch(() => undefined);
      if (reopened?.equals(content)) return;
      throw new EffectiveHarnessStoreError(
        "commit_uncertain",
        "effective harness index settlement is uncertain",
      );
    }
    if (renamed) {
      throw new EffectiveHarnessStoreError(
        "commit_uncertain",
        "effective harness index settlement is uncertain",
      );
    }
    throw new EffectiveHarnessStoreError("io", "effective harness index cannot be published");
  }
}

async function readState(
  paths: EffectiveHarnessStorePaths,
  entry: EffectiveHarnessStateEntry,
  hooks: EffectiveHarnessStoreHooks = {},
) {
  try {
    const content = await readBounded(
      join(paths.states, `${entry.stateDigest}.json`),
      entry.bytes,
      hooks,
      "state",
    );
    if (content.byteLength !== entry.bytes) throw new Error("state size mismatch");
    const state = parseEffectiveHarnessState(
      parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(content), {
        maxDepth: 32,
        maxNodes: 500_000,
        valueLabel: "effective harness state",
      }),
      { scopeDigest: entry.scopeDigest },
    );
    if (
      state.workflowId !== entry.workflowId ||
      state.stateDigest !== entry.stateDigest ||
      calculateEffectiveHarnessStateDigest(state) !== entry.stateDigest
    ) {
      throw new Error("state identity mismatch");
    }
    return state;
  } catch {
    throw new EffectiveHarnessStoreError("corrupt", "effective harness state is invalid");
  }
}

async function readArtifact(
  paths: EffectiveHarnessStorePaths,
  entry: EffectiveHarnessArtifactEntry,
  hooks: EffectiveHarnessStoreHooks = {},
) {
  try {
    const content = await readBounded(
      join(paths.artifacts, `${entry.artifactDigest}.json`),
      entry.bytes,
      hooks,
      "artifact",
    );
    if (content.byteLength !== entry.bytes) throw new Error("artifact size mismatch");
    const artifact = parseEffectiveHarnessCandidateArtifact(
      parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(content), {
        maxDepth: 32,
        maxNodes: 500_000,
        valueLabel: "effective harness candidate",
      }),
      { scopeDigest: entry.scopeDigest },
    );
    if (
      artifact.workflowId !== entry.workflowId ||
      artifact.artifactDigest !== entry.artifactDigest ||
      artifact.baselineHead.headDigest !== entry.baselineHeadDigest ||
      artifact.candidateState.stateDigest !== entry.stateDigest ||
      artifact.candidate.candidateDigest !== entry.candidateDigest
    ) {
      throw new Error("artifact identity mismatch");
    }
    return artifact;
  } catch {
    throw new EffectiveHarnessStoreError("corrupt", "effective harness candidate is invalid");
  }
}

function encodeState(state: EffectiveHarnessState): Buffer {
  const parsed = parseEffectiveHarnessState(state, { scopeDigest: state.scopeDigest });
  const content = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
  if (content.byteLength > MAX_EFFECTIVE_HARNESS_STATE_BYTES) {
    throw new EffectiveHarnessStoreError("invalid_input", "effective harness state is too large");
  }
  return content;
}

async function readBounded(
  path: string,
  maximum: number,
  hooks: EffectiveHarnessStoreHooks = {},
  kind?: "index" | "state" | "artifact",
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size > maximum) {
      throw new EffectiveHarnessStoreError("unsafe_state", "effective harness file is unsafe");
    }
    if (kind !== undefined) await hooks.afterFileObserved?.(kind);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximum) {
        throw new EffectiveHarnessStoreError("unsafe_state", "effective harness file is unsafe");
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const settled = await handle.stat({ bigint: true });
    if (!sameFileObservation(metadata, settled) || settled.size !== BigInt(total)) {
      throw new EffectiveHarnessStoreError("unsafe_state", "effective harness file is unsafe");
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function sameFileObservation(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function calculateIndexDigest(index: {
  readonly version: 1;
  readonly origins: readonly unknown[];
  readonly states: readonly unknown[];
  readonly artifacts: readonly unknown[];
  readonly heads: readonly unknown[];
  readonly history: readonly unknown[];
}) {
  return sha256(
    canonicalize({
      domain: "flow-effective-harness-index-v1",
      version: index.version,
      origins: index.origins,
      states: index.states,
      artifacts: index.artifacts,
      heads: index.heads,
      history: index.history,
    }),
  );
}

function storeIdentityKey(scopeDigest: string, workflowId: string, digest: string): string {
  return `${scopeDigest}\0${workflowId}\0${digest}`;
}

function candidateKind(artifact: EffectiveHarnessCandidateArtifact) {
  if ("kind" in artifact.candidate) return artifact.candidate.kind;
  return "prompt-candidate" as const;
}

function parseIdentifier(value: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success)
    throw new EffectiveHarnessStoreError(
      "invalid_input",
      "effective harness workflow id is invalid",
    );
  return parsed.data;
}

function parseDigest(value: string): string {
  const parsed = sha256Schema.safeParse(value);
  if (!parsed.success)
    throw new EffectiveHarnessStoreError("invalid_input", "effective harness digest is invalid");
  return parsed.data;
}

function parsePublicText(value: string, label: string, maximum: number): string {
  const parsed = publicTextSchema.max(maximum).safeParse(value);
  if (!parsed.success)
    throw new EffectiveHarnessStoreError("invalid_input", `effective harness ${label} is invalid`);
  return parsed.data;
}

function parseOptionalReason(value: string | undefined): string | undefined {
  return value === undefined ? undefined : parsePublicText(value, "reason", 1_024);
}

function uniqueBy<Value>(values: readonly Value[], key: (value: Value) => string): Value[] {
  const result = new Map<string, Value>();
  for (const value of values) result.set(key(value), value);
  return [...result.values()];
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
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new EffectiveHarnessStoreError("invalid_input", "effective harness value is invalid");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
