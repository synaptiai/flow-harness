import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type {
  CandidateDelta,
  CandidatePromotionLifecycle,
  CandidatePromotionRequest,
  CandidatePromotionSettlement,
  WorkspaceEntryIdentity,
} from "../../application/ports.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const promotionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const entryIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }).strict(),
  z
    .object({
      kind: z.literal("directory"),
      mode: z.number().int().min(0).max(0o777),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      mode: z.number().int().min(0).max(0o777),
      size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("symlink"),
      target: z.string().max(4096),
    })
    .strict(),
]);
const deltaSchema = z
  .object({
    version: z.literal(1),
    workspaceId: promotionIdSchema,
    baselineSnapshotDigest: sha256Schema,
    candidateSnapshotDigest: sha256Schema,
    entryCount: z.number().int().positive().max(20_000),
    logicalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    entries: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            before: entryIdentitySchema,
            after: entryIdentitySchema,
          })
          .strict(),
      )
      .min(1)
      .max(20_000),
    deltaDigest: sha256Schema,
  })
  .strict();

const promotionJournalSchema = z
  .object({
    version: z.literal(1),
    promotionId: promotionIdSchema,
    deltaDigest: sha256Schema,
    status: z.enum(["prepared", "applying", "rolling_back", "rolled_back", "committed", "unknown"]),
    stepCount: z.number().int().nonnegative().max(60_000),
    nextStep: z.number().int().nonnegative().max(60_000),
    appliedSteps: z.number().int().nonnegative().max(60_000),
    rollbackIndex: z.number().int().nonnegative().max(60_000),
  })
  .strict();

type PromotionJournal = z.infer<typeof promotionJournalSchema>;

export type CandidatePromotionErrorCode =
  | "candidate_promotion_invalid"
  | "candidate_promotion_missing"
  | "candidate_promotion_rolled_back"
  | "candidate_promotion_stale"
  | "candidate_promotion_uncertain";

export class CandidatePromotionError extends Error {
  override readonly name = "CandidatePromotionError";

  constructor(
    readonly code: CandidatePromotionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class CandidatePromotionInterruptedError extends Error {
  override readonly name = "CandidatePromotionInterruptedError";

  constructor(
    readonly boundary: "after_apply_step" | "after_temporary_durable" | "after_local_commit",
  ) {
    super(`simulated process interruption ${boundary}`);
  }
}

export interface CandidatePromotionTestHooks {
  readonly afterStep?: (completedSteps: number) => void | Promise<void>;
  readonly afterTemporaryDurable?: () => void | Promise<void>;
  readonly afterLocalCommit?: () => void | Promise<void>;
}

interface PromotionContext {
  readonly identityDirectory: string;
  readonly sourceCwd: string;
  readonly request: CandidatePromotionRequest;
}

interface PromotionStep {
  readonly path: string;
  readonly before: WorkspaceEntryIdentity;
  readonly after: WorkspaceEntryIdentity;
}

const promotionQueues = new Map<string, Promise<void>>();

export async function promoteCapturedCandidate(
  context: PromotionContext,
  lifecycle: CandidatePromotionLifecycle,
  hooks: CandidatePromotionTestHooks = {},
): Promise<CandidatePromotionSettlement> {
  validatePromotionRequest(context.request);
  return await withPromotionLock(context, async () => {
    const delta = await loadCandidateDelta(context);
    const steps = buildPromotionSteps(delta);
    await requireRemovedDirectoryClosures(context.sourceCwd, delta);
    await requireAffectedState(
      context.sourceCwd,
      delta,
      delta.entries.map((entry) => entry.before),
    );
    const paths = promotionPaths(context);
    await preparePromotionArtifacts(context, delta, steps, paths);
    const boundary = Object.freeze({
      promotionId: context.request.promotionId,
      workspaceId: context.request.workspaceId,
      deltaDigest: delta.deltaDigest,
      baselineSnapshotDigest: delta.baselineSnapshotDigest,
      candidateSnapshotDigest: delta.candidateSnapshotDigest,
      entryCount: delta.entryCount,
      logicalBytes: delta.logicalBytes,
    });

    try {
      await lifecycle.prepare(boundary);
    } catch (error) {
      await writeJournal(paths, journal(context, steps.length, "rolled_back"));
      throw new CandidatePromotionError(
        "candidate_promotion_rolled_back",
        `promotion "${context.request.promotionId}" was not entered because prepare failed`,
        { cause: error },
      );
    }

    let current = journal(context, steps.length, "applying");
    await writeJournal(paths, current);
    try {
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (step === undefined) {
          throw new Error("promotion step invariant failed");
        }
        await applyIdentityStep(
          context.sourceCwd,
          step,
          step.after,
          join(paths.candidateDirectory, "blobs"),
          context.request.promotionId,
          `${index}-forward`,
          hooks.afterTemporaryDurable,
        );
        await hooks.afterStep?.(index + 1);
        current = { ...current, nextStep: index + 1, appliedSteps: index + 1 };
        await writeJournal(paths, current);
      }
      await requireAffectedState(
        context.sourceCwd,
        delta,
        delta.entries.map((entry) => entry.after),
      );
      current = {
        ...current,
        status: "committed",
        nextStep: steps.length,
        appliedSteps: steps.length,
      };
      await writeJournal(paths, current);
      await hooks.afterLocalCommit?.();
    } catch (error) {
      if (error instanceof CandidatePromotionInterruptedError) {
        throw error;
      }
      const settlement = await compensateForwardFailure(context, delta, steps, paths, current);
      await lifecycle.settle(settlement);
      throw new CandidatePromotionError(
        settlement.outcome === "unknown"
          ? "candidate_promotion_uncertain"
          : "candidate_promotion_rolled_back",
        settlement.outcome === "unknown"
          ? `promotion "${context.request.promotionId}" could not prove its affected paths`
          : `promotion "${context.request.promotionId}" failed and was compensated`,
        { cause: error },
      );
    }

    const settlement = Object.freeze({
      outcome: "committed" as const,
      reason: "local_commit_durable" as const,
    });
    try {
      await lifecycle.settle(settlement);
    } catch (error) {
      throw new CandidatePromotionError(
        "candidate_promotion_uncertain",
        `promotion "${context.request.promotionId}" committed locally but settlement failed`,
        { cause: error },
      );
    }
    return settlement;
  });
}

export async function reconcileCapturedCandidatePromotion(
  context: PromotionContext,
): Promise<CandidatePromotionSettlement> {
  validatePromotionRequest(context.request);
  return await withPromotionLock(context, async () => {
    const delta = await loadCandidateDelta(context);
    const steps = buildPromotionSteps(delta);
    const paths = promotionPaths(context);
    let current = await readJournal(paths, context.request);
    if (current.stepCount !== steps.length) {
      throw invalidPromotion(
        context.request.promotionId,
        "journal step count does not match delta",
      );
    }
    await cleanupPromotionTemporaries(context.sourceCwd, context.request.promotionId, steps);
    if (current.status === "unknown") {
      return Object.freeze({ outcome: "unknown", reason: "affected_path_diverged" });
    }
    if (current.status === "committed") {
      return await settledObservation(context, delta, paths, current, "committed");
    }
    if (current.status === "rolled_back") {
      return await settledObservation(context, delta, paths, current, "rolled_back");
    }
    if (current.status === "rolling_back") {
      const rollbackProgress = await detectRollbackProgress(
        context.sourceCwd,
        delta,
        steps,
        current.appliedSteps,
        current.rollbackIndex,
      );
      if (rollbackProgress === undefined) {
        return await markUnknown(paths, current);
      }
      current = { ...current, rollbackIndex: rollbackProgress };
      await writeJournal(paths, current);
      return await finishRollback(context, delta, steps, paths, current, "reconciled_incomplete");
    }

    const appliedSteps = await detectForwardProgress(
      context.sourceCwd,
      delta,
      steps,
      current.nextStep,
    );
    if (appliedSteps === undefined) {
      return await markUnknown(paths, current);
    }
    current = {
      ...current,
      status: "rolling_back",
      appliedSteps,
      rollbackIndex: 0,
    };
    await writeJournal(paths, current);
    return await finishRollback(context, delta, steps, paths, current, "reconciled_incomplete");
  });
}

async function compensateForwardFailure(
  context: PromotionContext,
  delta: CandidateDelta,
  steps: readonly PromotionStep[],
  paths: ReturnType<typeof promotionPaths>,
  current: PromotionJournal,
): Promise<CandidatePromotionSettlement> {
  await cleanupPromotionTemporaries(context.sourceCwd, context.request.promotionId, steps);
  const appliedSteps = await detectForwardProgress(
    context.sourceCwd,
    delta,
    steps,
    current.nextStep,
  );
  if (appliedSteps === undefined) {
    return await markUnknown(paths, current);
  }
  const rollingBack: PromotionJournal = {
    ...current,
    status: "rolling_back",
    appliedSteps,
    rollbackIndex: 0,
  };
  await writeJournal(paths, rollingBack);
  return await finishRollback(
    context,
    delta,
    steps,
    paths,
    rollingBack,
    "compensated_after_failure",
  );
}

async function finishRollback(
  context: PromotionContext,
  delta: CandidateDelta,
  steps: readonly PromotionStep[],
  paths: ReturnType<typeof promotionPaths>,
  input: PromotionJournal,
  reason: "compensated_after_failure" | "reconciled_incomplete",
): Promise<CandidatePromotionSettlement> {
  let current = input;
  const inverse = steps.slice(0, current.appliedSteps).reverse();
  try {
    for (let index = current.rollbackIndex; index < inverse.length; index += 1) {
      const step = inverse[index];
      if (step === undefined) {
        throw new Error("promotion rollback step invariant failed");
      }
      await applyIdentityStep(
        context.sourceCwd,
        { path: step.path, before: step.after, after: step.before },
        step.before,
        join(paths.rollbackDirectory, "blobs"),
        context.request.promotionId,
        `${current.appliedSteps - index - 1}-rollback`,
        undefined,
      );
      current = { ...current, rollbackIndex: index + 1 };
      await writeJournal(paths, current);
    }
    await requireAffectedState(
      context.sourceCwd,
      delta,
      delta.entries.map((entry) => entry.before),
    );
  } catch {
    return await markUnknown(paths, current);
  }
  current = { ...current, status: "rolled_back" };
  await writeJournal(paths, current);
  return Object.freeze({ outcome: "rolled_back", reason });
}

async function settledObservation(
  context: PromotionContext,
  delta: CandidateDelta,
  paths: ReturnType<typeof promotionPaths>,
  journalInput: PromotionJournal,
  status: "committed" | "rolled_back",
): Promise<CandidatePromotionSettlement> {
  const expected = delta.entries.map((entry) =>
    status === "committed" ? entry.after : entry.before,
  );
  if (!(await affectedStateMatches(context.sourceCwd, delta, expected))) {
    return await markUnknown(paths, journalInput);
  }
  return status === "committed"
    ? Object.freeze({ outcome: "committed", reason: "local_commit_durable" })
    : Object.freeze({ outcome: "rolled_back", reason: "reconciled_incomplete" });
}

async function markUnknown(
  paths: ReturnType<typeof promotionPaths>,
  current: PromotionJournal,
): Promise<CandidatePromotionSettlement> {
  await writeJournal(paths, { ...current, status: "unknown" });
  return Object.freeze({ outcome: "unknown", reason: "affected_path_diverged" });
}

function buildPromotionSteps(delta: CandidateDelta): readonly PromotionStep[] {
  const state = new Map(delta.entries.map((entry) => [entry.path, entry.before]));
  const steps: PromotionStep[] = [];
  const addStep = (path: string, after: WorkspaceEntryIdentity): void => {
    const before = state.get(path);
    if (before === undefined) {
      throw invalidPromotion(delta.workspaceId, `delta path ${JSON.stringify(path)} is missing`);
    }
    steps.push(Object.freeze({ path, before, after }));
    state.set(path, after);
  };
  const removals = delta.entries
    .filter(
      (entry) =>
        entry.before.kind !== "missing" &&
        (entry.after.kind === "missing" || entry.after.kind !== entry.before.kind),
    )
    .sort(deepestPathFirst);
  for (const entry of removals) {
    addStep(entry.path, Object.freeze({ kind: "missing" }));
  }
  const directories = delta.entries
    .filter((entry) => entry.after.kind === "directory")
    .sort(shallowestPathFirst);
  for (const entry of directories) {
    if (!sameIdentity(state.get(entry.path) ?? Object.freeze({ kind: "missing" }), entry.after)) {
      addStep(entry.path, entry.after);
    }
  }
  const leaves = delta.entries
    .filter((entry) => entry.after.kind === "file" || entry.after.kind === "symlink")
    .sort(shallowestPathFirst);
  for (const entry of leaves) {
    if (!sameIdentity(state.get(entry.path) ?? Object.freeze({ kind: "missing" }), entry.after)) {
      addStep(entry.path, entry.after);
    }
  }
  return Object.freeze(steps);
}

async function preparePromotionArtifacts(
  context: PromotionContext,
  delta: CandidateDelta,
  steps: readonly PromotionStep[],
  paths: ReturnType<typeof promotionPaths>,
): Promise<void> {
  await mkdir(paths.promotionsDirectory, { recursive: true, mode: 0o700 });
  try {
    await mkdir(paths.promotionDirectory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw invalidPromotion(context.request.promotionId, "promotion journal already exists");
    }
    throw error;
  }
  try {
    await mkdir(join(paths.rollbackDirectory, "blobs"), { recursive: true, mode: 0o700 });
    for (const entry of delta.entries) {
      if (entry.before.kind !== "file") {
        continue;
      }
      await copyVerifiedBlob(
        workspacePath(context.sourceCwd, entry.path),
        join(paths.rollbackDirectory, "blobs", entry.before.sha256),
        entry.before,
      );
    }
    await syncDirectory(join(paths.rollbackDirectory, "blobs"));
    await writeJournal(paths, journal(context, steps.length, "prepared"));
  } catch (error) {
    await rm(paths.promotionDirectory, { recursive: true, force: true });
    throw error;
  }
}

function journal(
  context: PromotionContext,
  stepCount: number,
  status: PromotionJournal["status"],
): PromotionJournal {
  return {
    version: 1,
    promotionId: context.request.promotionId,
    deltaDigest: context.request.deltaDigest,
    status,
    stepCount,
    nextStep: 0,
    appliedSteps: 0,
    rollbackIndex: 0,
  };
}

async function applyIdentityStep(
  sourceCwd: string,
  step: PromotionStep,
  desired: WorkspaceEntryIdentity,
  blobDirectory: string,
  promotionId: string,
  stepKey: string,
  afterTemporaryDurable: (() => void | Promise<void>) | undefined,
): Promise<void> {
  await requireDirectoryAncestors(sourceCwd, step.path);
  const target = workspacePath(sourceCwd, step.path);
  const current = await observeEntry(target);
  if (!sameIdentity(current, step.before)) {
    throw new CandidatePromotionError(
      "candidate_promotion_stale",
      `promotion affected path ${JSON.stringify(step.path)} changed before its step`,
    );
  }
  if (desired.kind === "missing") {
    await requireDirectoryAncestors(sourceCwd, step.path);
    if (current.kind === "directory") {
      await rmdir(target);
    } else if (current.kind !== "missing") {
      await unlink(target);
    }
    await syncDirectory(dirname(target));
    return;
  }
  if (desired.kind === "directory") {
    await requireDirectoryAncestors(sourceCwd, step.path);
    if (current.kind === "missing") {
      await mkdir(target, { mode: desired.mode });
    }
    await chmod(target, desired.mode);
    await syncDirectory(dirname(target));
    return;
  }
  const temporary = promotionTemporaryPath(sourceCwd, promotionId, step, stepKey);
  await requireDirectoryAncestors(sourceCwd, step.path);
  await requireTemporaryMissing(temporary);
  try {
    if (desired.kind === "file") {
      await cloneOrCopyFile(join(blobDirectory, desired.sha256), temporary);
      await chmod(temporary, desired.mode);
      const copied = await observeEntry(temporary);
      if (!sameIdentity(copied, desired)) {
        throw invalidPromotion(promotionId, `blob ${desired.sha256} failed verification`);
      }
      await syncFile(temporary);
    } else {
      await symlink(desired.target, temporary);
    }
    await afterTemporaryDurable?.();
    await requireDirectoryAncestors(sourceCwd, step.path);
    await rename(temporary, target);
    await syncDirectory(dirname(target));
  } catch (error) {
    if (error instanceof CandidatePromotionInterruptedError) {
      throw error;
    }
    await removePromotionTemporaryIfContained(sourceCwd, step.path, temporary);
    throw error;
  }
}

function promotionTemporaryPath(
  sourceCwd: string,
  promotionId: string,
  step: PromotionStep,
  stepKey: string,
): string {
  const target = workspacePath(sourceCwd, step.path);
  return join(
    dirname(target),
    `.flow-promote-${sha256(`${promotionId}\0${stepKey}\0${step.path}`).slice(0, 24)}.tmp`,
  );
}

async function cleanupPromotionTemporaries(
  sourceCwd: string,
  promotionId: string,
  steps: readonly PromotionStep[],
): Promise<void> {
  for (const [index, step] of steps.entries()) {
    if (
      step.after.kind !== "file" &&
      step.after.kind !== "symlink" &&
      step.before.kind !== "file" &&
      step.before.kind !== "symlink"
    ) {
      continue;
    }
    for (const stepKey of [`${index}-forward`, `${index}-rollback`]) {
      const temporary = promotionTemporaryPath(sourceCwd, promotionId, step, stepKey);
      await removePromotionTemporaryIfContained(sourceCwd, step.path, temporary);
    }
  }
}

async function removePromotionTemporaryIfContained(
  sourceCwd: string,
  relativePath: string,
  temporary: string,
): Promise<boolean> {
  if (!(await directoryAncestorsAreDirectories(sourceCwd, relativePath))) {
    return false;
  }
  let metadata: Stats;
  try {
    metadata = await lstat(temporary);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return false;
    }
    throw error;
  }
  if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new CandidatePromotionError(
      "candidate_promotion_uncertain",
      `promotion temporary ${JSON.stringify(temporary)} is not a supported entry`,
    );
  }
  if (!(await directoryAncestorsAreDirectories(sourceCwd, relativePath))) {
    return false;
  }
  try {
    await unlink(temporary);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return false;
    }
    throw error;
  }
  await syncDirectory(dirname(temporary));
  return true;
}

async function detectForwardProgress(
  sourceCwd: string,
  delta: CandidateDelta,
  steps: readonly PromotionStep[],
  journaled: number,
): Promise<number | undefined> {
  for (const count of [journaled, journaled + 1]) {
    if (count <= steps.length && (await stateMatches(sourceCwd, delta, steps, count, 0))) {
      return count;
    }
  }
  return undefined;
}

async function detectRollbackProgress(
  sourceCwd: string,
  delta: CandidateDelta,
  steps: readonly PromotionStep[],
  appliedSteps: number,
  journaled: number,
): Promise<number | undefined> {
  for (const count of [journaled, journaled + 1]) {
    if (
      count <= appliedSteps &&
      (await stateMatches(sourceCwd, delta, steps, appliedSteps, count))
    ) {
      return count;
    }
  }
  return undefined;
}

async function stateMatches(
  sourceCwd: string,
  delta: CandidateDelta,
  steps: readonly PromotionStep[],
  appliedSteps: number,
  rollbackSteps: number,
): Promise<boolean> {
  const expected = new Map(delta.entries.map((entry) => [entry.path, entry.before]));
  for (const step of steps.slice(0, appliedSteps)) {
    expected.set(step.path, step.after);
  }
  const inverse = steps.slice(0, appliedSteps).reverse().slice(0, rollbackSteps);
  for (const step of inverse) {
    expected.set(step.path, step.before);
  }
  return await affectedStateMatches(
    sourceCwd,
    delta,
    delta.entries.map((entry) => expected.get(entry.path) ?? entry.before),
  );
}

async function requireAffectedState(
  sourceCwd: string,
  delta: CandidateDelta,
  expected: readonly WorkspaceEntryIdentity[],
): Promise<void> {
  if (!(await affectedStateMatches(sourceCwd, delta, expected))) {
    throw new CandidatePromotionError(
      "candidate_promotion_stale",
      "one or more affected parent paths do not match their captured preimages",
    );
  }
}

async function requireRemovedDirectoryClosures(
  sourceCwd: string,
  delta: CandidateDelta,
): Promise<void> {
  const removedDirectories = delta.entries.filter(
    (entry) => entry.before.kind === "directory" && entry.after.kind !== "directory",
  );
  for (const directory of removedDirectories) {
    const prefix = `${directory.path}/`;
    const expected = delta.entries
      .filter((entry) => entry.path.startsWith(prefix) && entry.before.kind !== "missing")
      .map((entry) => entry.path)
      .sort((left, right) => left.localeCompare(right, "en"));
    let actual: readonly string[];
    try {
      await requireDirectoryAncestors(sourceCwd, directory.path);
      const absoluteDirectory = workspacePath(sourceCwd, directory.path);
      if (!(await lstat(absoluteDirectory)).isDirectory()) {
        throw new Error("affected path is no longer a directory");
      }
      actual = await listSubtreePaths(absoluteDirectory, directory.path);
    } catch (error) {
      throw new CandidatePromotionError(
        "candidate_promotion_stale",
        `affected directory ${JSON.stringify(directory.path)} changed during freshness validation`,
        { cause: error },
      );
    }
    if (
      actual.length !== expected.length ||
      actual.some((path, index) => path !== expected[index])
    ) {
      throw new CandidatePromotionError(
        "candidate_promotion_stale",
        `affected directory ${JSON.stringify(directory.path)} contains paths outside its captured preimage`,
      );
    }
  }
}

async function listSubtreePaths(
  absoluteDirectory: string,
  relativeDirectory: string,
): Promise<readonly string[]> {
  const directory = await opendir(absoluteDirectory);
  const names: string[] = [];
  for await (const entry of directory) {
    names.push(entry.name);
  }
  names.sort((left, right) => left.localeCompare(right, "en"));
  const paths: string[] = [];
  for (const name of names) {
    const absolutePath = join(absoluteDirectory, name);
    const relativePath = `${relativeDirectory}/${name}`;
    const metadata = await lstat(absolutePath);
    paths.push(relativePath);
    if (metadata.isDirectory()) {
      paths.push(...(await listSubtreePaths(absolutePath, relativePath)));
    }
  }
  return Object.freeze(paths);
}

async function affectedStateMatches(
  sourceCwd: string,
  delta: CandidateDelta,
  expected: readonly WorkspaceEntryIdentity[],
): Promise<boolean> {
  const affectedPaths = new Set(delta.entries.map((entry) => entry.path));
  for (const [index, entry] of delta.entries.entries()) {
    if (!(await directoryAncestorsAreDirectories(sourceCwd, entry.path, affectedPaths))) {
      return false;
    }
    const identity = await observeEntry(workspacePath(sourceCwd, entry.path));
    const expectedIdentity = expected[index];
    if (expectedIdentity === undefined || !sameIdentity(identity, expectedIdentity)) {
      return false;
    }
  }
  return true;
}

async function requireDirectoryAncestors(sourceCwd: string, relativePath: string): Promise<void> {
  if (!(await directoryAncestorsAreDirectories(sourceCwd, relativePath))) {
    throw new CandidatePromotionError(
      "candidate_promotion_stale",
      `promotion ancestor for ${JSON.stringify(relativePath)} is not a directory`,
    );
  }
}

async function directoryAncestorsAreDirectories(
  sourceCwd: string,
  relativePath: string,
  excludedRelativePaths: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  const segments = relativePath.split("/");
  let current = resolve(sourceCwd);
  let currentRelative = "";
  for (const segment of ["", ...segments.slice(0, -1)]) {
    if (segment !== "") {
      current = join(current, segment);
      currentRelative = currentRelative === "" ? segment : `${currentRelative}/${segment}`;
      if (excludedRelativePaths.has(currentRelative)) {
        continue;
      }
    }
    try {
      if (!(await lstat(current)).isDirectory()) {
        return false;
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        return false;
      }
      throw error;
    }
  }
  return true;
}

async function observeEntry(path: string): Promise<WorkspaceEntryIdentity> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return Object.freeze({ kind: "missing" });
    }
    throw error;
  }
  if (before.isDirectory()) {
    const after = await lstat(path);
    if (!sameObservation(before, after)) {
      throw new CandidatePromotionError(
        "candidate_promotion_uncertain",
        `directory ${JSON.stringify(path)} changed during observation`,
      );
    }
    return Object.freeze({ kind: "directory", mode: Number(after.mode & 0o777) });
  }
  if (before.isSymbolicLink()) {
    const target = await readlink(path);
    const after = await lstat(path);
    if (!sameObservation(before, after)) {
      throw new CandidatePromotionError(
        "candidate_promotion_uncertain",
        `symlink ${JSON.stringify(path)} changed during observation`,
      );
    }
    return Object.freeze({ kind: "symlink", target });
  }
  if (!before.isFile()) {
    throw new CandidatePromotionError(
      "candidate_promotion_uncertain",
      `affected path ${JSON.stringify(path)} is not a supported entry`,
    );
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameObservation(before, opened)) {
      throw new CandidatePromotionError(
        "candidate_promotion_uncertain",
        `file ${JSON.stringify(path)} changed before observation`,
      );
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(64 * 1024, opened.size)));
    let position = 0;
    while (position < opened.size) {
      const requested = Math.min(buffer.length, opened.size - position);
      const result = await handle.read(buffer, 0, requested, position);
      if (result.bytesRead === 0) {
        break;
      }
      digest.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      position !== opened.size ||
      !sameObservation(opened, after) ||
      !sameObservation(after, current)
    ) {
      throw new CandidatePromotionError(
        "candidate_promotion_uncertain",
        `file ${JSON.stringify(path)} changed during observation`,
      );
    }
    return Object.freeze({
      kind: "file",
      mode: Number(after.mode & 0o777),
      size: after.size,
      sha256: digest.digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

async function copyVerifiedBlob(
  source: string,
  target: string,
  expected: Extract<WorkspaceEntryIdentity, { readonly kind: "file" }>,
): Promise<void> {
  const existing = await observeEntry(target);
  if (existing.kind !== "missing") {
    if (
      existing.kind !== "file" ||
      existing.mode !== 0o600 ||
      existing.size !== expected.size ||
      existing.sha256 !== expected.sha256
    ) {
      throw invalidPromotion(expected.sha256, "rollback blob identity mismatch");
    }
    return;
  }
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await sourceHandle.stat();
    if (
      !before.isFile() ||
      before.size !== expected.size ||
      Number(before.mode & 0o777) !== expected.mode
    ) {
      throw new CandidatePromotionError(
        "candidate_promotion_stale",
        `rollback source for blob ${expected.sha256} changed before capture`,
      );
    }
    targetHandle = await open(temporary, "wx", 0o600);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(64 * 1024, expected.size)));
    let position = 0;
    while (position < expected.size) {
      const requested = Math.min(buffer.length, expected.size - position);
      const result = await sourceHandle.read(buffer, 0, requested, position);
      if (result.bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, result.bytesRead);
      digest.update(chunk);
      await targetHandle.write(chunk, 0, chunk.length, position);
      position += chunk.length;
    }
    const after = await sourceHandle.stat();
    if (
      position !== expected.size ||
      digest.digest("hex") !== expected.sha256 ||
      !sameObservation(before, after)
    ) {
      throw new CandidatePromotionError(
        "candidate_promotion_stale",
        `rollback source for blob ${expected.sha256} changed during capture`,
      );
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    await rename(temporary, target);
  } catch (error) {
    await targetHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

async function loadCandidateDelta(context: PromotionContext): Promise<CandidateDelta> {
  let parsed: z.infer<typeof deltaSchema>;
  try {
    parsed = deltaSchema.parse(
      JSON.parse(
        await readFile(join(context.identityDirectory, "candidate", "delta.json"), "utf8"),
      ) as unknown,
    );
  } catch (error) {
    throw new CandidatePromotionError(
      "candidate_promotion_missing",
      `candidate delta for workspace "${context.request.workspaceId}" is unavailable`,
      { cause: error },
    );
  }
  const { deltaDigest, ...manifest } = parsed;
  const logicalBytes = parsed.entries.reduce(
    (total, entry) =>
      total +
      (entry.before.kind === "file" ? entry.before.size : 0) +
      (entry.after.kind === "file" ? entry.after.size : 0),
    0,
  );
  if (
    parsed.workspaceId !== context.request.workspaceId ||
    deltaDigest !== context.request.deltaDigest ||
    parsed.entryCount !== parsed.entries.length ||
    parsed.logicalBytes !== logicalBytes ||
    sha256(JSON.stringify(manifest)) !== deltaDigest ||
    !isSortedUnique(parsed.entries.map((entry) => entry.path)) ||
    parsed.entries.some(
      (entry) => !validRelativePath(entry.path) || sameIdentity(entry.before, entry.after),
    )
  ) {
    throw invalidPromotion(context.request.promotionId, "candidate delta manifest is invalid");
  }
  return deepFreeze(parsed) as CandidateDelta;
}

async function readJournal(
  paths: ReturnType<typeof promotionPaths>,
  request: CandidatePromotionRequest,
): Promise<PromotionJournal> {
  try {
    const parsed = promotionJournalSchema.parse(
      JSON.parse(await readFile(paths.journal, "utf8")) as unknown,
    );
    if (parsed.promotionId !== request.promotionId || parsed.deltaDigest !== request.deltaDigest) {
      throw new Error("journal identity mismatch");
    }
    return parsed;
  } catch (error) {
    throw new CandidatePromotionError(
      "candidate_promotion_missing",
      `promotion journal "${request.promotionId}" is unavailable`,
      { cause: error },
    );
  }
}

async function writeJournal(
  paths: ReturnType<typeof promotionPaths>,
  input: PromotionJournal,
): Promise<void> {
  const parsed = promotionJournalSchema.parse(input);
  const temporary = join(paths.promotionDirectory, `journal-${process.pid}-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, paths.journal);
  await syncDirectory(paths.promotionDirectory);
}

function promotionPaths(context: PromotionContext) {
  const candidateDirectory = join(context.identityDirectory, "candidate");
  const promotionsDirectory = join(candidateDirectory, "promotions");
  const promotionDirectory = join(promotionsDirectory, context.request.promotionId);
  return {
    candidateDirectory,
    promotionsDirectory,
    promotionDirectory,
    rollbackDirectory: join(promotionDirectory, "rollback"),
    journal: join(promotionDirectory, "journal.json"),
  } as const;
}

async function withPromotionLock<T>(
  context: PromotionContext,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${dirname(context.identityDirectory)}\0${context.sourceCwd}`;
  const previous = promotionQueues.get(key) ?? Promise.resolve();
  let releaseQueue: () => void = () => undefined;
  const current = new Promise<void>((resolvePromise) => {
    releaseQueue = resolvePromise;
  });
  const queued = previous.then(() => current);
  promotionQueues.set(key, queued);
  await previous;
  const locksDirectory = join(dirname(context.identityDirectory), ".promotion-locks");
  const lockPath = join(locksDirectory, `${sha256(context.sourceCwd)}.lock`);
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let operationOutcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  try {
    await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
    lock = await acquireLock(lockPath);
    operationOutcome = { ok: true, value: await operation() };
  } catch (error) {
    operationOutcome = { ok: false, error };
  }

  let releaseError: unknown;
  if (lock !== undefined) {
    try {
      await lock.close();
      await unlink(lockPath).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") {
          throw error;
        }
      });
      await syncDirectory(locksDirectory);
    } catch (error) {
      releaseError = error;
    }
  }
  releaseQueue();
  if (promotionQueues.get(key) === queued) {
    promotionQueues.delete(key);
  }

  if (!operationOutcome.ok) {
    if (releaseError !== undefined) {
      throw new AggregateError(
        [operationOutcome.error, releaseError],
        "candidate promotion failed and its workspace lock could not be released",
      );
    }
    throw operationOutcome.error;
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
  return operationOutcome.value;
}

async function acquireLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, hostname: hostname() })}\n`);
      await handle.sync();
      return handle;
    } catch (error) {
      if (errorCode(error) !== "EEXIST" || !(await removeStaleLock(path))) {
        throw new CandidatePromotionError(
          "candidate_promotion_uncertain",
          `workspace promotion lock ${JSON.stringify(path)} is busy`,
          { cause: error },
        );
      }
    }
  }
  throw new CandidatePromotionError(
    "candidate_promotion_uncertain",
    `workspace promotion lock ${JSON.stringify(path)} could not be acquired`,
  );
}

async function removeStaleLock(path: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path, "utf8")) as {
      readonly pid?: unknown;
      readonly hostname?: unknown;
    };
    if (
      owner.hostname === hostname() &&
      typeof owner.pid === "number" &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0
    ) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        if (errorCode(error) !== "ESRCH") {
          return false;
        }
      }
    } else if (owner.hostname !== hostname()) {
      return false;
    }
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

function workspacePath(root: string, relativePath: string): string {
  if (!validRelativePath(relativePath)) {
    throw invalidPromotion(relativePath, "affected path is not a safe relative path");
  }
  const target = resolve(root, ...relativePath.split("/"));
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw invalidPromotion(relativePath, "affected path escapes the workspace");
  }
  return target;
}

function validRelativePath(path: string): boolean {
  const segments = path.split("/");
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function validatePromotionRequest(request: CandidatePromotionRequest): void {
  if (
    !promotionIdSchema.safeParse(request.promotionId).success ||
    !promotionIdSchema.safeParse(request.workspaceId).success ||
    !sha256Schema.safeParse(request.deltaDigest).success ||
    !isAbsolute(request.sourceCwd)
  ) {
    throw invalidPromotion(request.promotionId, "promotion request identity is invalid");
  }
}

function sameIdentity(left: WorkspaceEntryIdentity, right: WorkspaceEntryIdentity): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "missing" || right.kind === "missing") {
    return true;
  }
  if (left.kind === "directory" && right.kind === "directory") {
    return left.mode === right.mode;
  }
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  return (
    left.kind === "file" &&
    right.kind === "file" &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.sha256 === right.sha256
  );
}

function sameObservation(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function deepestPathFirst(
  left: { readonly path: string },
  right: { readonly path: string },
): number {
  return pathDepth(right.path) - pathDepth(left.path) || right.path.localeCompare(left.path, "en");
}

function shallowestPathFirst(
  left: { readonly path: string },
  right: { readonly path: string },
): number {
  return pathDepth(left.path) - pathDepth(right.path) || left.path.localeCompare(right.path, "en");
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function isSortedUnique(paths: readonly string[]): boolean {
  return paths.every(
    (path, index) => index === 0 || (paths[index - 1]?.localeCompare(path, "en") ?? 0) < 0,
  );
}

async function requireTemporaryMissing(path: string): Promise<void> {
  try {
    await lstat(path);
    throw invalidPromotion(basename(path), "promotion temporary path already exists");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function cloneOrCopyFile(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target, constants.COPYFILE_FICLONE);
  } catch (error) {
    if (!["ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL", "ENOSYS"].includes(errorCode(error) ?? "")) {
      throw error;
    }
    await copyFile(source, target);
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function invalidPromotion(identity: string, detail: string): CandidatePromotionError {
  return new CandidatePromotionError(
    "candidate_promotion_invalid",
    `candidate promotion ${JSON.stringify(identity)} is invalid: ${detail}`,
  );
}
