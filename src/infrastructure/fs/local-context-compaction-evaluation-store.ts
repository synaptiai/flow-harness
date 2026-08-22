import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";
import {
  type EvaluationTrialAttempt,
  parseEvaluationTrialAttempt,
} from "../../domain/evaluation/attempt.js";
import {
  aggregateContextCompactionEvaluation,
  calculateContextCompactionEvaluationPlanDigest,
  CONTEXT_COMPACTION_EVALUATION_API_VERSION,
  type ContextCompactionEvaluationReportInput,
  createContextCompactionEvaluationSchedule,
} from "../../domain/evaluation/context-compaction-evaluation.js";
import {
  type EvaluationTrialRecord,
  parseEvaluationTrialRecord,
} from "../../domain/evaluation/records.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import type { AdmittedContextCompactionEvaluationPlan } from "./local-context-compaction-evaluation-plan.js";

export const MAX_CONTEXT_COMPACTION_EVALUATION_HEADER_BYTES = 2 * 1024 * 1024;
export const MAX_CONTEXT_COMPACTION_EVALUATION_RECORD_BYTES = 64 * 1024;
export const MAX_CONTEXT_COMPACTION_EVALUATION_LEDGER_BYTES = 256 * 1024 * 1024;
const MAX_ACTIVE_ATTEMPT_BYTES = 8 * 1024;
const MAX_OWNER_BYTES = 4 * 1024;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const pathSchema = z.string().min(1).max(1_024);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scheduleSchema = z
  .object({
    version: z.literal(1),
    position: positiveSafeIntegerSchema.max(4_096),
    trialId: z.string().regex(/^trial-[a-f0-9]{48}$/),
    taskId: identifierSchema,
    profileId: z.enum(["none", "references", "references-and-summary"]),
    seed: nonNegativeSafeIntegerSchema,
    repetition: positiveSafeIntegerSchema.max(30),
  })
  .strict();
const headerSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("ContextCompactionEvaluation"),
    evaluationId: identifierSchema,
    createdAt: z.iso.datetime({ offset: true }),
    planDigest: sha256Schema,
    apiVersion: z.literal(CONTEXT_COMPACTION_EVALUATION_API_VERSION),
    planId: identifierSchema,
    suite: z
      .object({
        id: identifierSchema,
        version: z.string().min(1).max(128),
        tasks: z
          .array(
            z
              .object({
                id: identifierSchema,
                fixture: z
                  .object({
                    provenance: pathSchema,
                    digest: sha256Schema,
                    entryCount: nonNegativeSafeIntegerSchema.max(4_096),
                    logicalBytes: nonNegativeSafeIntegerSchema.max(256 * 1024 * 1024),
                    instructionPath: pathSchema,
                    instructionSha256: sha256Schema,
                  })
                  .strict(),
                verifier: z
                  .object({
                    kind: z.literal("filesystem-v1"),
                    digest: sha256Schema,
                    assertionCount: positiveSafeIntegerSchema.max(16),
                  })
                  .strict(),
                protectedConstraints: z
                  .array(z.string().min(1).max(4_096))
                  .min(1)
                  .max(32)
                  .readonly(),
                constraintAssertionIndexes: z
                  .array(nonNegativeSafeIntegerSchema.max(15))
                  .min(1)
                  .max(16)
                  .readonly(),
              })
              .strict(),
          )
          .min(1)
          .max(64)
          .readonly(),
      })
      .strict(),
    profile: z
      .object({
        adapter: z.literal("flow-workflow-v1"),
        workflow: z
          .object({
            provenance: pathSchema,
            sourceSha256: sha256Schema,
            workflowDigest: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    controls: z
      .object({
        model: z
          .object({
            provider: z.string().min(1).max(96),
            id: z.string().min(1).max(256),
            thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
          })
          .strict(),
        budget: z
          .object({
            maxNodeStarts: positiveSafeIntegerSchema,
            maxModelTokens: positiveSafeIntegerSchema,
            maxCostUsdMicros: positiveSafeIntegerSchema,
            maxExecutionMs: positiveSafeIntegerSchema,
            maxArtifactBytes: positiveSafeIntegerSchema,
          })
          .strict(),
        network: z.literal("deny"),
        retry: z.object({ providerRetries: z.literal(0), harnessRetries: z.literal(0) }).strict(),
        compaction: z
          .object({
            minimumReductionBytes: positiveSafeIntegerSchema.max(1_048_576),
            summaryOutputTokenLimits: z
              .tuple([positiveSafeIntegerSchema, positiveSafeIntegerSchema])
              .readonly(),
          })
          .strict(),
      })
      .strict(),
    seeds: z.array(nonNegativeSafeIntegerSchema).min(6).max(30).readonly(),
    modes: z.tuple([
      z.literal("none"),
      z.literal("references"),
      z.literal("references-and-summary"),
    ]),
    order: z.literal("six-order-balanced-v1"),
    comparison: z
      .object({
        minimumPairedTrials: positiveSafeIntegerSchema,
        maxVerifiedSuccessRegression: z.number().min(0).max(1),
        maxTotalTokenIncreaseRate: z.number().min(0).max(10),
        maxConstraintLosses: z.literal(0),
      })
      .strict(),
    schedule: z.array(scheduleSchema).min(18).max(4_096).readonly(),
  })
  .strict()
  .superRefine((header, context) => {
    const taskIds = header.suite.tasks.map((task) => task.id);
    if (new Set(taskIds).size !== taskIds.length) {
      context.addIssue({
        code: "custom",
        path: ["suite", "tasks"],
        message: "task ids must be unique",
      });
    }
    if (new Set(header.seeds).size !== header.seeds.length || header.seeds.length % 6 !== 0) {
      context.addIssue({
        code: "custom",
        path: ["seeds"],
        message: "seeds must form unique six-seed blocks",
      });
    }
    for (const [index, task] of header.suite.tasks.entries()) {
      if (
        task.protectedConstraints.length !== task.constraintAssertionIndexes.length ||
        new Set(task.constraintAssertionIndexes).size !== task.constraintAssertionIndexes.length ||
        task.constraintAssertionIndexes.some((item) => item >= task.verifier.assertionCount)
      ) {
        context.addIssue({
          code: "custom",
          path: ["suite", "tasks", index, "constraintAssertionIndexes"],
          message: "constraint assertion mapping is invalid",
        });
      }
    }
    const expected = createContextCompactionEvaluationSchedule(
      header.planDigest,
      taskIds,
      header.seeds,
    );
    if (JSON.stringify(expected) !== JSON.stringify(header.schedule)) {
      context.addIssue({
        code: "custom",
        path: ["schedule"],
        message: "schedule does not match the admitted plan",
      });
    }
  });
const ownerSchema = z
  .object({
    version: z.literal(1),
    pid: positiveSafeIntegerSchema,
    token: z.uuid(),
    acquiredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type PublicContextCompactionEvaluationHeader = z.infer<typeof headerSchema>;

export interface StoredContextCompactionEvaluation {
  readonly header: PublicContextCompactionEvaluationHeader;
  readonly records: readonly EvaluationTrialRecord[];
  readonly activeAttempt: EvaluationTrialAttempt | null;
}

export class ContextCompactionEvaluationStoreError extends Error {
  override readonly name = "ContextCompactionEvaluationStoreError";

  constructor(
    readonly code: "corrupt" | "exists" | "invalid_id" | "not_found" | "not_owner" | "sequence",
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export function createPublicContextCompactionEvaluationHeader(
  admitted: AdmittedContextCompactionEvaluationPlan,
  evaluationId: string,
  createdAt = new Date().toISOString(),
): PublicContextCompactionEvaluationHeader {
  return parseHeader({
    version: 1,
    kind: "ContextCompactionEvaluation",
    evaluationId,
    createdAt,
    planDigest: admitted.planDigest,
    apiVersion: admitted.apiVersion,
    planId: admitted.id,
    suite: {
      id: admitted.suite.id,
      version: admitted.suite.version,
      tasks: admitted.suite.tasks.map((task) => ({
        id: task.id,
        fixture: {
          provenance: task.fixture.provenance,
          digest: task.fixture.digest,
          entryCount: task.fixture.entryCount,
          logicalBytes: task.fixture.logicalBytes,
          instructionPath: task.fixture.instructionPath,
          instructionSha256: task.fixture.instructionSha256,
        },
        verifier: {
          kind: task.verifier.kind,
          digest: task.verifier.digest,
          assertionCount: task.verifier.assertions.length,
        },
        protectedConstraints: task.protectedConstraints,
        constraintAssertionIndexes: task.constraintAssertionIndexes,
      })),
    },
    profile: {
      adapter: admitted.profile.adapter,
      workflow: {
        provenance: admitted.profile.workflow.provenance,
        sourceSha256: admitted.profile.workflow.sourceSha256,
        workflowDigest: admitted.profile.workflow.workflowDigest,
      },
    },
    controls: admitted.controls,
    seeds: admitted.seeds,
    modes: admitted.modes,
    order: admitted.order,
    comparison: admitted.comparison,
    schedule: admitted.schedule,
  });
}

export function contextCompactionEvaluationReportInput(
  header: PublicContextCompactionEvaluationHeader,
): ContextCompactionEvaluationReportInput {
  return Object.freeze({
    planDigest: header.planDigest,
    schedule: header.schedule,
    tasks: Object.freeze(
      header.suite.tasks.map((task) =>
        Object.freeze({
          id: task.id,
          verifierDigest: task.verifier.digest,
          assertionCount: task.verifier.assertionCount,
          constraintAssertionIndexes: task.constraintAssertionIndexes,
        }),
      ),
    ),
    comparison: header.comparison,
  });
}

export class LocalContextCompactionEvaluationStore {
  #root: string;
  readonly #owners = new Map<string, string>();

  constructor(rootDirectory: string) {
    this.#root = resolve(rootDirectory);
  }

  async create(
    headerInput: PublicContextCompactionEvaluationHeader,
    options: {
      /** @internal Deterministic pre-commit interruption seam. */
      readonly afterStagingPrepared?: () => void | Promise<void>;
    } = {},
  ): Promise<void> {
    const header = parseHeader(headerInput);
    this.#root = await ensureCanonicalRoot(this.#root);
    const directory = this.directory(header.evaluationId);
    const staging = join(this.#root, `.${header.evaluationId}-${randomUUID()}.pending`);
    try {
      await mkdir(staging, { mode: 0o700 });
      await durableCreate(join(staging, "plan.json"), `${JSON.stringify(header)}\n`);
      await durableCreate(join(staging, "trials.jsonl"), "");
      await syncDirectory(staging);
      await options.afterStagingPrepared?.();
      await rename(staging, directory);
      await syncDirectory(this.#root);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY")) {
        throw new ContextCompactionEvaluationStoreError("exists", "evaluation already exists", {
          cause: error,
        });
      }
      throw error;
    }
  }

  async read(evaluationId: string): Promise<StoredContextCompactionEvaluation> {
    let directory: string;
    let headerSource: Buffer;
    let ledgerSource: Buffer;
    try {
      this.#root = await canonicalizeExistingRoot(this.#root);
      directory = this.directory(evaluationId);
      await assertEvaluationDirectory(directory);
      [headerSource, ledgerSource] = await Promise.all([
        boundedRead(join(directory, "plan.json"), MAX_CONTEXT_COMPACTION_EVALUATION_HEADER_BYTES),
        boundedRead(
          join(directory, "trials.jsonl"),
          MAX_CONTEXT_COMPACTION_EVALUATION_LEDGER_BYTES,
        ),
      ]);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new ContextCompactionEvaluationStoreError("not_found", "evaluation does not exist", {
          cause: error,
        });
      }
      throw error;
    }
    const header = parseHeader(
      parseStrictJson(decodeStrictUtf8(headerSource, "evaluation header"), {
        maxDepth: 24,
        maxNodes: 50_000,
        valueLabel: "context compaction evaluation header",
      }),
    );
    if (header.evaluationId !== evaluationId) {
      throw new ContextCompactionEvaluationStoreError("corrupt", "header identity is incorrect");
    }
    const records = parseLedger(ledgerSource);
    aggregateContextCompactionEvaluation(contextCompactionEvaluationReportInput(header), records);
    const persistedAttempt = await readAttempt(join(directory, "active-attempt.json"));
    const activeAttempt =
      persistedAttempt !== null && reconcileAttempt(header, records, persistedAttempt)
        ? null
        : persistedAttempt;
    return Object.freeze({ header, records, activeAttempt });
  }

  async claim(
    evaluationId: string,
    expectedPlanDigest: string,
  ): Promise<StoredContextCompactionEvaluation> {
    const stored = await this.read(evaluationId);
    if (stored.header.planDigest !== expectedPlanDigest) {
      throw new ContextCompactionEvaluationStoreError("corrupt", "plan digest does not match");
    }
    const token = randomUUID();
    const owner = {
      version: 1 as const,
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
    };
    const ownerPath = join(this.directory(evaluationId), "owner.json");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let ownerCreated = false;
      try {
        await assertEvaluationDirectory(this.directory(evaluationId));
        await durableCreate(ownerPath, `${JSON.stringify(owner)}\n`);
        await syncDirectory(this.directory(evaluationId));
        ownerCreated = true;
        this.#owners.set(evaluationId, token);
        const persistedAttempt = await readAttempt(
          join(this.directory(evaluationId), "active-attempt.json"),
        );
        if (
          persistedAttempt !== null &&
          reconcileAttempt(stored.header, stored.records, persistedAttempt)
        ) {
          await unlink(join(this.directory(evaluationId), "active-attempt.json"));
          await syncDirectory(this.directory(evaluationId));
        }
        return stored;
      } catch (error) {
        if (ownerCreated) {
          this.#owners.delete(evaluationId);
          await unlink(ownerPath).catch(() => undefined);
          throw error;
        }
        if (!isErrno(error, "EEXIST") || attempt === 2 || !(await reclaimStaleOwner(ownerPath))) {
          if (isErrno(error, "EEXIST")) {
            throw new ContextCompactionEvaluationStoreError(
              "not_owner",
              "evaluation is already claimed",
              { cause: error },
            );
          }
          throw error;
        }
      }
    }
    throw new ContextCompactionEvaluationStoreError("not_owner", "evaluation claim failed");
  }

  async append(evaluationId: string, record: EvaluationTrialRecord): Promise<void> {
    this.requireOwner(evaluationId);
    const stored = await this.read(evaluationId);
    const parsed = parseEvaluationTrialRecord(record);
    if (
      stored.activeAttempt === null ||
      !terminalRecordMatchesAttempt(stored.activeAttempt, parsed)
    ) {
      throw new ContextCompactionEvaluationStoreError(
        "sequence",
        stored.activeAttempt === null
          ? "trial record requires an active attempt"
          : "trial record does not match its active attempt",
      );
    }
    aggregateContextCompactionEvaluation(contextCompactionEvaluationReportInput(stored.header), [
      ...stored.records,
      parsed,
    ]);
    const line = `${JSON.stringify(parsed)}\n`;
    if (Buffer.byteLength(line) > MAX_CONTEXT_COMPACTION_EVALUATION_RECORD_BYTES) {
      throw new ContextCompactionEvaluationStoreError("corrupt", "trial record exceeds its limit");
    }
    await assertEvaluationDirectory(this.directory(evaluationId));
    const handle = await open(
      join(this.directory(evaluationId), "trials.jsonl"),
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async beginAttempt(evaluationId: string, attemptInput: EvaluationTrialAttempt): Promise<void> {
    this.requireOwner(evaluationId);
    const stored = await this.read(evaluationId);
    if (stored.activeAttempt !== null) {
      throw new ContextCompactionEvaluationStoreError("sequence", "an attempt is already active");
    }
    const attempt = parseEvaluationTrialAttempt(attemptInput);
    const scheduled = stored.header.schedule[stored.records.length];
    if (
      scheduled === undefined ||
      attempt.planDigest !== stored.header.planDigest ||
      attempt.position !== scheduled.position ||
      attempt.trialId !== scheduled.trialId ||
      attempt.taskId !== scheduled.taskId ||
      attempt.profileId !== scheduled.profileId ||
      attempt.adapter !== "flow-workflow-v1"
    ) {
      throw new ContextCompactionEvaluationStoreError("sequence", "attempt is not the next trial");
    }
    await assertEvaluationDirectory(this.directory(evaluationId));
    await durableCreate(
      join(this.directory(evaluationId), "active-attempt.json"),
      `${JSON.stringify(attempt)}\n`,
    );
    await syncDirectory(this.directory(evaluationId));
  }

  async completeAttempt(evaluationId: string, attemptInput: EvaluationTrialAttempt): Promise<void> {
    this.requireOwner(evaluationId);
    const expected = parseEvaluationTrialAttempt(attemptInput);
    const active = await readAttempt(join(this.directory(evaluationId), "active-attempt.json"));
    if (active === null || JSON.stringify(active) !== JSON.stringify(expected)) {
      throw new ContextCompactionEvaluationStoreError("sequence", "active attempt does not match");
    }
    const stored = await this.read(evaluationId);
    if (!terminalRecordMatchesAttempt(expected, stored.records.at(-1))) {
      throw new ContextCompactionEvaluationStoreError(
        "sequence",
        "active attempt has no durable terminal record",
      );
    }
    await assertEvaluationDirectory(this.directory(evaluationId));
    await unlink(join(this.directory(evaluationId), "active-attempt.json"));
    await syncDirectory(this.directory(evaluationId));
  }

  async release(evaluationId: string): Promise<void> {
    const token = this.requireOwner(evaluationId);
    const ownerPath = join(this.directory(evaluationId), "owner.json");
    const owner = ownerSchema.parse(
      parseStrictJson(
        decodeStrictUtf8(await boundedRead(ownerPath, MAX_OWNER_BYTES), "evaluation owner"),
        {
          maxDepth: 4,
          maxNodes: 16,
          valueLabel: "context compaction evaluation owner",
        },
      ),
    );
    if (owner.token !== token || owner.pid !== process.pid) {
      throw new ContextCompactionEvaluationStoreError("not_owner", "owner identity changed");
    }
    await assertEvaluationDirectory(this.directory(evaluationId));
    await unlink(ownerPath);
    await syncDirectory(this.directory(evaluationId));
    this.#owners.delete(evaluationId);
  }

  private directory(evaluationId: string): string {
    const parsed = identifierSchema.safeParse(evaluationId);
    if (!parsed.success) {
      throw new ContextCompactionEvaluationStoreError("invalid_id", "evaluation id is invalid");
    }
    return join(this.#root, parsed.data);
  }

  private requireOwner(evaluationId: string): string {
    const token = this.#owners.get(evaluationId);
    if (token === undefined) {
      throw new ContextCompactionEvaluationStoreError("not_owner", "evaluation is not claimed");
    }
    return token;
  }
}

function parseHeader(input: unknown): PublicContextCompactionEvaluationHeader {
  const parsed = headerSchema.safeParse(input);
  if (!parsed.success) {
    throw new ContextCompactionEvaluationStoreError("corrupt", "evaluation header is invalid", {
      cause: parsed.error,
    });
  }
  if (
    calculateContextCompactionEvaluationPlanDigest(headerPlanIdentity(parsed.data)) !==
    parsed.data.planDigest
  ) {
    throw new ContextCompactionEvaluationStoreError(
      "corrupt",
      "evaluation header plan digest does not match its identity fields",
    );
  }
  return deepFreeze(parsed.data);
}

function headerPlanIdentity(header: PublicContextCompactionEvaluationHeader): unknown {
  return {
    version: header.version,
    apiVersion: header.apiVersion,
    id: header.planId,
    suite: {
      id: header.suite.id,
      version: header.suite.version,
      tasks: header.suite.tasks.map((task) => ({
        id: task.id,
        partition: "holdout",
        fixture: task.fixture,
        verifier: task.verifier,
        protectedConstraints: task.protectedConstraints,
        constraintAssertionIndexes: task.constraintAssertionIndexes,
      })),
    },
    profile: header.profile,
    controls: header.controls,
    seeds: header.seeds,
    modes: header.modes,
    order: header.order,
    comparison: header.comparison,
  };
}

function parseLedger(source: Buffer): readonly EvaluationTrialRecord[] {
  const text = decodeStrictUtf8(source, "evaluation trial ledger");
  if (text.length === 0) return Object.freeze([]);
  if (!text.endsWith("\n")) {
    throw new ContextCompactionEvaluationStoreError("corrupt", "trial ledger has a torn tail");
  }
  const records = text
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      if (Buffer.byteLength(line) > MAX_CONTEXT_COMPACTION_EVALUATION_RECORD_BYTES) {
        throw new ContextCompactionEvaluationStoreError(
          "corrupt",
          `trial record ${index + 1} exceeds its limit`,
        );
      }
      return parseEvaluationTrialRecord(
        parseStrictJson(line, {
          maxDepth: 24,
          maxNodes: 10_000,
          valueLabel: `context compaction trial record ${index + 1}`,
        }),
      );
    });
  return Object.freeze(records);
}

function reconcileAttempt(
  header: PublicContextCompactionEvaluationHeader,
  records: readonly EvaluationTrialRecord[],
  attempt: EvaluationTrialAttempt,
): boolean {
  const scheduled = header.schedule[attempt.position - 1];
  if (
    scheduled === undefined ||
    attempt.planDigest !== header.planDigest ||
    attempt.position !== scheduled.position ||
    attempt.trialId !== scheduled.trialId ||
    attempt.taskId !== scheduled.taskId ||
    attempt.profileId !== scheduled.profileId ||
    attempt.adapter !== "flow-workflow-v1"
  ) {
    throw new ContextCompactionEvaluationStoreError(
      "corrupt",
      "active attempt contradicts the public schedule",
    );
  }
  if (attempt.position === records.length + 1) return false;
  if (
    attempt.position === records.length &&
    terminalRecordMatchesAttempt(attempt, records.at(-1))
  ) {
    return true;
  }
  throw new ContextCompactionEvaluationStoreError(
    "corrupt",
    "active attempt contradicts the committed ledger",
  );
}

function terminalRecordMatchesAttempt(
  attempt: EvaluationTrialAttempt,
  terminal: EvaluationTrialRecord | undefined,
): boolean {
  return (
    terminal?.planDigest === attempt.planDigest &&
    terminal.position === attempt.position &&
    terminal.trialId === attempt.trialId &&
    terminal.taskId === attempt.taskId &&
    terminal.profileId === attempt.profileId &&
    terminal.startedAt === attempt.startedAt &&
    terminal.environment.workspaceBackend === attempt.workspace.backend &&
    terminal.environment.workspaceSnapshotDigest === attempt.workspace.snapshotDigest
  );
}

async function readAttempt(path: string): Promise<EvaluationTrialAttempt | null> {
  let source: Buffer;
  try {
    source = await boundedRead(path, MAX_ACTIVE_ATTEMPT_BYTES);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  return parseEvaluationTrialAttempt(
    parseStrictJson(decodeStrictUtf8(source, "evaluation active attempt"), {
      maxDepth: 12,
      maxNodes: 1_000,
      valueLabel: "context compaction evaluation attempt",
    }),
  );
}

async function boundedRead(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new ContextCompactionEvaluationStoreError("corrupt", "stored file exceeds its limit");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function durableCreate(path: string, contents: string): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureCanonicalRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await canonicalizeExistingRoot(root);
}

async function canonicalizeExistingRoot(root: string): Promise<string> {
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) {
    throw new ContextCompactionEvaluationStoreError(
      "corrupt",
      "evaluation root is not a directory",
    );
  }
  return canonical;
}

async function assertEvaluationDirectory(directory: string): Promise<void> {
  const entry = await lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory() || (await realpath(directory)) !== directory) {
    throw new ContextCompactionEvaluationStoreError(
      "corrupt",
      "evaluation path is not a direct regular directory",
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function reclaimStaleOwner(path: string): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_OWNER_BYTES) {
      throw new ContextCompactionEvaluationStoreError("corrupt", "owner record is invalid");
    }
    const owner = ownerSchema.parse(
      parseStrictJson(decodeStrictUtf8(await handle.readFile(), "evaluation owner"), {
        maxDepth: 4,
        maxNodes: 16,
        valueLabel: "context compaction evaluation owner",
      }),
    );
    if (processIsAlive(owner.pid)) return false;
    const current = await lstat(path);
    if (current.dev !== before.dev || current.ino !== before.ino) return false;
    await unlink(path);
    return true;
  } finally {
    await handle.close();
  }
}

function decodeStrictUtf8(source: Buffer, label: string): string {
  try {
    return fatalUtf8Decoder.decode(source);
  } catch (error) {
    throw new ContextCompactionEvaluationStoreError("corrupt", `${label} is not valid UTF-8`, {
      cause: error,
    });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
