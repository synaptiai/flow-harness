import { randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  type PromptCandidateIdentity,
  parsePromptCandidateIdentity,
} from "../../domain/adaptation/prompt-candidate.js";
import {
  type EvaluationTrialAttempt,
  parseEvaluationTrialAttempt,
} from "../../domain/evaluation/attempt.js";
import { parseExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import {
  type EvaluationReportInput,
  validateCommittedEvaluationPrefix,
} from "../../domain/evaluation/aggregate.js";
import {
  calculateEvaluationPlanDigest,
  createEvaluationSchedule,
  EVALUATION_PLAN_API_VERSION,
  type EvaluationPlanIdentity,
  MAX_EVALUATION_TASKS,
  MAX_EVALUATION_TRIALS,
} from "../../domain/evaluation/plan.js";
import {
  type EvaluationTrialRecord,
  parseEvaluationTrialRecord,
} from "../../domain/evaluation/records.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import {
  type AdmittedEvaluationPlan,
  projectEvaluationCandidateIdentity,
} from "./local-evaluation-plan.js";

export const MAX_EVALUATION_HEADER_BYTES = 2 * 1024 * 1024;
export const MAX_EVALUATION_TRIAL_RECORD_BYTES = 64 * 1024;
export const MAX_EVALUATION_TRIAL_ATTEMPT_BYTES = 4 * 1024;
export const MAX_EVALUATION_LEDGER_BYTES =
  MAX_EVALUATION_TRIALS * MAX_EVALUATION_TRIAL_RECORD_BYTES;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_EVALUATION_ATTEMPT_TEMPORARIES = 16;
const attemptTemporaryNamePattern =
  /^\.active-attempt\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/;

export type EvaluationStoreErrorCode =
  | "complete"
  | "corrupt"
  | "evaluation_exists"
  | "identity_mismatch"
  | "invalid_evaluation_id"
  | "io"
  | "limit_exceeded"
  | "not_found"
  | "not_owner"
  | "sequence";

export class EvaluationStoreError extends Error {
  override readonly name = "EvaluationStoreError";

  constructor(
    readonly code: EvaluationStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const relativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isCanonicalRelativePath, "must be a canonical portable relative path");
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rateSchema = z.number().min(0).max(1);
const semanticVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );

const budgetSchema = z
  .object({
    maxNodeStarts: positiveSafeIntegerSchema,
    maxModelTokens: positiveSafeIntegerSchema,
    maxCostUsdMicros: positiveSafeIntegerSchema,
    maxExecutionMs: positiveSafeIntegerSchema,
    maxArtifactBytes: positiveSafeIntegerSchema,
  })
  .strict();

const taskSchema = z
  .object({
    id: identifierSchema,
    partition: z.enum(["tuning", "regression", "holdout"]),
    fixture: z
      .object({
        provenance: relativePathSchema,
        digest: sha256Schema,
        entryCount: nonNegativeSafeIntegerSchema.max(4_096),
        logicalBytes: nonNegativeSafeIntegerSchema.max(256 * 1024 * 1024),
        instructionPath: relativePathSchema,
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
  })
  .strict();

const candidateIdentitySchema = z
  .object({
    provenance: relativePathSchema,
    identity: z.custom<PromptCandidateIdentity>((value) => {
      try {
        parsePromptCandidateIdentity(value);
        return true;
      } catch {
        return false;
      }
    }, "candidate identity is invalid or internally inconsistent"),
  })
  .strict();

const flowProfileSchema = z
  .object({
    id: identifierSchema,
    adapter: z.literal("flow-workflow-v1"),
    workflow: z
      .object({
        sourceKind: z.literal("prompt-candidate-projection").optional(),
        provenance: relativePathSchema,
        sourceSha256: sha256Schema,
        workflowDigest: sha256Schema,
      })
      .strict(),
    candidate: candidateIdentitySchema.optional(),
  })
  .strict();

const externalProfileSchema = z
  .object({
    id: identifierSchema,
    adapter: z.literal("pi-native-v1"),
    harness: z.custom<ReturnType<typeof parseExternalHarnessIdentity>>((value) => {
      try {
        parseExternalHarnessIdentity(value);
        return true;
      } catch {
        return false;
      }
    }, "external harness identity is invalid"),
  })
  .strict();

const profileSchema = z.discriminatedUnion("adapter", [flowProfileSchema, externalProfileSchema]);

const scheduleItemSchema = z
  .object({
    version: z.literal(1),
    position: z.number().int().positive().max(MAX_EVALUATION_TRIALS),
    trialId: z.string().regex(/^trial-[a-f0-9]{48}$/),
    taskId: identifierSchema,
    profileId: identifierSchema,
    seed: nonNegativeSafeIntegerSchema,
    repetition: z.number().int().positive().max(32),
  })
  .strict();

const publicHeaderSchema = z
  .object({
    version: z.literal(1),
    evaluationId: identifierSchema,
    createdAt: z.iso.datetime({ offset: true }),
    planDigest: sha256Schema,
    apiVersion: z.literal(EVALUATION_PLAN_API_VERSION),
    planId: identifierSchema,
    suite: z
      .object({
        id: identifierSchema,
        version: semanticVersionSchema,
        tasks: z.array(taskSchema).min(1).max(MAX_EVALUATION_TASKS),
      })
      .strict(),
    profiles: z.array(profileSchema).length(2),
    controls: z
      .object({
        model: z
          .object({
            provider: z.string().min(1).max(96),
            id: z.string().min(1).max(256),
            thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
          })
          .strict(),
        budget: budgetSchema,
        network: z.literal("deny"),
        retry: z.object({ providerRetries: z.literal(0), harnessRetries: z.literal(0) }).strict(),
      })
      .strict(),
    seeds: z.array(nonNegativeSafeIntegerSchema).min(1).max(32),
    order: z.literal("paired-alternating-v1"),
    comparison: z
      .object({
        baselineProfileId: identifierSchema,
        candidateProfileId: identifierSchema,
        minimumPairedTrials: positiveSafeIntegerSchema,
        confidenceLevel: z.literal(0.95),
        minimumEffect: rateSchema,
        maxFalseCompletionRate: rateSchema,
        maxPolicyViolations: nonNegativeSafeIntegerSchema,
        maxVerifiedSuccessRegression: rateSchema,
      })
      .strict(),
    schedule: z.array(scheduleItemSchema).min(2).max(MAX_EVALUATION_TRIALS),
  })
  .strict()
  .superRefine((header, context) => {
    refineUnique(
      header.suite.tasks.map((task) => task.id),
      ["suite", "tasks"],
      "task ids",
      context,
    );
    refineUnique(
      header.profiles.map((profile) => profile.id),
      ["profiles"],
      "profile ids",
      context,
    );
    refineUnique(header.seeds, ["seeds"], "seeds", context);
    const profileIds = new Set(header.profiles.map((profile) => profile.id));
    if (
      !profileIds.has(header.comparison.baselineProfileId) ||
      !profileIds.has(header.comparison.candidateProfileId) ||
      header.comparison.baselineProfileId === header.comparison.candidateProfileId
    ) {
      context.addIssue({
        code: "custom",
        path: ["comparison"],
        message: "comparison must reference two different declared profiles",
      });
    }
    const baseline = header.profiles.find(
      (profile) => profile.id === header.comparison.baselineProfileId,
    );
    const candidate = header.profiles.find(
      (profile) => profile.id === header.comparison.candidateProfileId,
    );
    const flowProfiles = header.profiles.filter(
      (profile): profile is z.infer<typeof flowProfileSchema> =>
        profile.adapter === "flow-workflow-v1",
    );
    const candidateProfiles = flowProfiles.filter((profile) => profile.candidate !== undefined);
    const projectionProfiles = flowProfiles.filter(
      (profile) => profile.workflow.sourceKind === "prompt-candidate-projection",
    );
    if (candidateProfiles.length > 0 || projectionProfiles.length > 0) {
      if (
        candidateProfiles.length !== 1 ||
        projectionProfiles.length !== 1 ||
        baseline === undefined ||
        candidate === undefined ||
        baseline.adapter !== "flow-workflow-v1" ||
        candidate.adapter !== "flow-workflow-v1" ||
        baseline.candidate !== undefined ||
        baseline.workflow.sourceKind === "prompt-candidate-projection" ||
        candidate.candidate === undefined ||
        candidate.workflow.sourceKind !== "prompt-candidate-projection" ||
        candidate.candidate.provenance !== candidate.workflow.provenance ||
        candidate.candidate.identity.baseline.sourceSha256 !== baseline.workflow.sourceSha256 ||
        candidate.candidate.identity.baseline.workflowDigest !== baseline.workflow.workflowDigest ||
        candidate.candidate.identity.projectedWorkflow.sourceSha256 !==
          candidate.workflow.sourceSha256 ||
        candidate.candidate.identity.projectedWorkflow.workflowDigest !==
          candidate.workflow.workflowDigest
      ) {
        context.addIssue({
          code: "custom",
          path: ["profiles"],
          message:
            "candidate provenance must identify one projection on the comparison candidate over the exact comparison baseline",
        });
      }
    }
    const holdoutPairs =
      header.suite.tasks.filter((task) => task.partition === "holdout").length *
      header.seeds.length;
    if (header.comparison.minimumPairedTrials > holdoutPairs) {
      context.addIssue({
        code: "custom",
        path: ["comparison", "minimumPairedTrials"],
        message: "minimum paired trials cannot exceed the declared holdout pair schedule",
      });
    }
  });

const ownerRecordSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive().safe(),
    token: z.uuid(),
    acquiredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type PublicEvaluationHeader = z.infer<typeof publicHeaderSchema>;

export interface StoredEvaluation {
  readonly header: PublicEvaluationHeader;
  readonly records: readonly EvaluationTrialRecord[];
  readonly activeAttempt: EvaluationTrialAttempt | null;
}

interface LedgerRead {
  readonly records: readonly EvaluationTrialRecord[];
  readonly committedBytes: number;
  readonly observedBytes: number;
  readonly device: number;
  readonly inode: number;
  readonly mtimeMs: number;
}

interface OwnedEvaluation {
  readonly header: PublicEvaluationHeader;
  readonly records: readonly EvaluationTrialRecord[];
  readonly committedBytes: number;
  readonly observedBytes: number;
  readonly device: number;
  readonly inode: number;
  readonly mtimeMs: number;
  readonly token: string;
  readonly activeAttempt: EvaluationTrialAttempt | null;
}

interface AttemptRead {
  readonly attempt: EvaluationTrialAttempt | null;
  readonly completed: boolean;
}

interface BoundedFileSnapshot {
  readonly contents: Buffer;
  readonly device: number;
  readonly inode: number;
  readonly mtimeMs: number;
}

export function createPublicEvaluationHeader(
  admitted: AdmittedEvaluationPlan,
  evaluationId: string,
  createdAt = new Date().toISOString(),
): PublicEvaluationHeader {
  return parsePublicHeader({
    version: 1,
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
        partition: task.partition,
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
      })),
    },
    profiles: admitted.profiles.map((profile) =>
      profile.adapter === "pi-native-v1"
        ? { id: profile.id, adapter: profile.adapter, harness: profile.harness }
        : {
            id: profile.id,
            adapter: profile.adapter,
            workflow: {
              provenance: profile.workflow.provenance,
              sourceSha256: profile.workflow.sourceSha256,
              workflowDigest: profile.workflow.workflowDigest,
              ...(profile.workflow.sourceKind === "prompt-candidate-projection"
                ? { sourceKind: profile.workflow.sourceKind }
                : {}),
            },
            ...(profile.candidate === undefined
              ? {}
              : {
                  candidate: projectEvaluationCandidateIdentity(profile.candidate),
                }),
          },
    ),
    controls: admitted.controls,
    seeds: admitted.seeds,
    order: admitted.order,
    comparison: admitted.comparison,
    schedule: admitted.schedule,
  });
}

export function evaluationReportInput(header: PublicEvaluationHeader): EvaluationReportInput {
  const profileIds = header.profiles.map((profile) => profile.id) as [string, string];
  return Object.freeze({
    planDigest: header.planDigest,
    schedule: header.schedule,
    profileIds: Object.freeze(profileIds),
    tasks: Object.freeze(
      header.suite.tasks.map((task) =>
        Object.freeze({
          id: task.id,
          partition: task.partition,
          verifierDigest: task.verifier.digest,
          assertionCount: task.verifier.assertionCount,
        }),
      ),
    ),
    comparison: header.comparison,
  });
}

export class LocalEvaluationStore {
  #rootDirectory: string;
  readonly #owned = new Map<string, OwnedEvaluation>();
  readonly #appendTails = new Map<string, Promise<void>>();

  constructor(rootDirectory: string) {
    this.#rootDirectory = resolve(rootDirectory);
  }

  async create(rawHeader: PublicEvaluationHeader): Promise<void> {
    const header = parsePublicHeader(rawHeader);
    const root = await ensureCanonicalRoot(this.#rootDirectory);
    this.#rootDirectory = root;
    const target = join(root, header.evaluationId);
    const staging = join(root, `.${header.evaluationId}-${randomUUID()}.pending`);
    try {
      await mkdir(staging, { mode: 0o700 });
      await writeDurableFile(join(staging, "plan.json"), `${JSON.stringify(header)}\n`);
      await writeDurableFile(join(staging, "trials.jsonl"), "");
      await syncDirectory(staging);
      await rename(staging, target);
      await syncDirectory(root);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY")) {
        throw new EvaluationStoreError(
          "evaluation_exists",
          `evaluation "${header.evaluationId}" already exists`,
          { cause: error },
        );
      }
      if (error instanceof EvaluationStoreError) {
        throw error;
      }
      throw new EvaluationStoreError("io", `failed to create evaluation "${header.evaluationId}"`, {
        cause: error,
      });
    }
  }

  async read(evaluationIdInput: string): Promise<StoredEvaluation> {
    const evaluationId = validateEvaluationId(evaluationIdInput);
    await (this.#appendTails.get(evaluationId) ?? Promise.resolve());
    const header = await this.#readHeader(evaluationId);
    const ledger = await this.#readLedger(header);
    const active = await this.#readAttempt(header, ledger.records);
    return deepFreeze({
      header,
      records: [...ledger.records],
      activeAttempt: active.completed ? null : active.attempt,
    });
  }

  async claim(evaluationIdInput: string, planDigest: string): Promise<StoredEvaluation> {
    const evaluationId = validateEvaluationId(evaluationIdInput);
    if (this.#owned.has(evaluationId)) {
      throw new EvaluationStoreError(
        "not_owner",
        `evaluation "${evaluationId}" is already claimed by this store instance`,
      );
    }
    const header = await this.#readHeader(evaluationId);
    if (header.planDigest !== planDigest) {
      throw new EvaluationStoreError(
        "identity_mismatch",
        `evaluation "${evaluationId}" does not match plan digest "${planDigest}"`,
      );
    }
    const token = await this.#acquireOwner(evaluationId);
    try {
      await this.#recoverAttemptTemporaries(evaluationId);
      const ledger = await this.#readLedger(header);
      const active = await this.#readAttempt(header, ledger.records);
      if (active.completed && active.attempt !== null) {
        await this.#retireAttempt(evaluationId, active.attempt);
      }
      if (ledger.records.length === header.schedule.length) {
        throw new EvaluationStoreError("complete", `evaluation "${evaluationId}" is complete`);
      }
      const activeAttempt = active.completed ? null : active.attempt;
      this.#owned.set(evaluationId, { header, ...ledger, token, activeAttempt });
      return deepFreeze({ header, records: [...ledger.records], activeAttempt });
    } catch (error) {
      await this.#releaseOwner(evaluationId, token).catch(() => undefined);
      throw error;
    }
  }

  append(evaluationIdInput: string, rawRecord: EvaluationTrialRecord): Promise<void> {
    const evaluationId = validateEvaluationId(evaluationIdInput);
    const previous = this.#appendTails.get(evaluationId) ?? Promise.resolve();
    const next = previous.then(() => this.#appendNow(evaluationId, rawRecord));
    this.#appendTails.set(
      evaluationId,
      next.catch(() => undefined),
    );
    return next;
  }

  async beginAttempt(evaluationIdInput: string, rawAttempt: EvaluationTrialAttempt): Promise<void> {
    const evaluationId = validateEvaluationId(evaluationIdInput);
    await (this.#appendTails.get(evaluationId) ?? Promise.resolve());
    const owned = this.#owned.get(evaluationId);
    if (owned === undefined) {
      throw new EvaluationStoreError(
        "not_owner",
        `claim evaluation "${evaluationId}" before starting an adapter`,
      );
    }
    if (owned.activeAttempt !== null) {
      throw new EvaluationStoreError(
        "sequence",
        `evaluation "${evaluationId}" already has an active adapter attempt`,
      );
    }
    const attempt = parseAttemptForStore(rawAttempt, evaluationId);
    reconcileAttempt(owned.header, owned.records, attempt);
    const contents = `${JSON.stringify(attempt)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_EVALUATION_TRIAL_ATTEMPT_BYTES) {
      throw new EvaluationStoreError(
        "limit_exceeded",
        `evaluation adapter start exceeds ${MAX_EVALUATION_TRIAL_ATTEMPT_BYTES} bytes`,
      );
    }
    const directory = this.#evaluationDirectory(evaluationId);
    try {
      await this.#assertEvaluationDirectory(evaluationId);
      await writeDurableFileAtomicExclusive(directory, "active-attempt.json", contents);
      this.#owned.set(evaluationId, { ...owned, activeAttempt: attempt });
    } catch (error) {
      if (error instanceof EvaluationStoreError) {
        throw error;
      }
      throw new EvaluationStoreError(
        "io",
        `failed to store adapter start for evaluation "${evaluationId}"`,
        { cause: error },
      );
    }
  }

  async completeAttempt(
    evaluationIdInput: string,
    rawAttempt: EvaluationTrialAttempt,
  ): Promise<void> {
    const evaluationId = validateEvaluationId(evaluationIdInput);
    await (this.#appendTails.get(evaluationId) ?? Promise.resolve());
    const owned = this.#owned.get(evaluationId);
    if (owned === undefined) {
      throw new EvaluationStoreError(
        "not_owner",
        `claim evaluation "${evaluationId}" before completing an adapter`,
      );
    }
    const attempt = parseAttemptForStore(rawAttempt, evaluationId);
    if (
      owned.activeAttempt === null ||
      JSON.stringify(owned.activeAttempt) !== JSON.stringify(attempt)
    ) {
      throw new EvaluationStoreError(
        "sequence",
        `evaluation "${evaluationId}" adapter completion does not match its active attempt`,
      );
    }
    const terminal = owned.records.at(-1);
    if (terminal?.position !== attempt.position || terminal.trialId !== attempt.trialId) {
      throw new EvaluationStoreError(
        "sequence",
        `evaluation "${evaluationId}" adapter attempt has no durable terminal record`,
      );
    }
    await this.#retireAttempt(evaluationId, attempt);
    this.#owned.set(evaluationId, { ...owned, activeAttempt: null });
  }

  async release(evaluationIdInput: string): Promise<void> {
    const evaluationId = validateEvaluationId(evaluationIdInput);
    await (this.#appendTails.get(evaluationId) ?? Promise.resolve());
    const owned = this.#owned.get(evaluationId);
    if (owned === undefined) {
      return;
    }
    await this.#releaseOwner(evaluationId, owned.token);
    this.#owned.delete(evaluationId);
  }

  async #appendNow(evaluationId: string, rawRecord: EvaluationTrialRecord): Promise<void> {
    const owned = this.#owned.get(evaluationId);
    if (owned === undefined) {
      throw new EvaluationStoreError(
        "not_owner",
        `claim evaluation "${evaluationId}" before appending`,
      );
    }
    const record = parseEvaluationTrialRecord(rawRecord);
    let records: readonly EvaluationTrialRecord[];
    try {
      records = validateCommittedEvaluationPrefix(evaluationReportInput(owned.header), [
        ...owned.records,
        record,
      ]);
    } catch (error) {
      throw new EvaluationStoreError(
        "sequence",
        `record is not the exact next trial for evaluation "${evaluationId}"`,
        { cause: error },
      );
    }
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_EVALUATION_TRIAL_RECORD_BYTES) {
      throw new EvaluationStoreError(
        "limit_exceeded",
        `evaluation trial record exceeds ${MAX_EVALUATION_TRIAL_RECORD_BYTES} bytes`,
      );
    }
    const path = join(this.#evaluationDirectory(evaluationId), "trials.jsonl");
    try {
      await this.#assertEvaluationDirectory(evaluationId);
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      let after: Stats;
      try {
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.dev !== owned.device ||
          before.ino !== owned.inode ||
          before.size !== owned.observedBytes ||
          before.mtimeMs !== owned.mtimeMs
        ) {
          throw new EvaluationStoreError(
            "corrupt",
            `evaluation "${evaluationId}" ledger changed after ownership was acquired`,
          );
        }
        await handle.truncate(owned.committedBytes);
        await handle.writeFile(line, "utf8");
        await handle.sync();
        after = await handle.stat();
      } finally {
        await handle.close();
      }
      this.#owned.set(evaluationId, {
        ...owned,
        records,
        committedBytes: owned.committedBytes + Buffer.byteLength(line, "utf8"),
        observedBytes: after.size,
        device: after.dev,
        inode: after.ino,
        mtimeMs: after.mtimeMs,
      });
    } catch (error) {
      if (error instanceof EvaluationStoreError) {
        throw error;
      }
      throw new EvaluationStoreError("io", `failed to append evaluation "${evaluationId}"`, {
        cause: error,
      });
    }
  }

  async #readHeader(evaluationId: string): Promise<PublicEvaluationHeader> {
    let contents: Buffer;
    try {
      await this.#canonicalizeExistingRoot();
      await this.#assertEvaluationDirectory(evaluationId);
      contents = await readBoundedFile(
        join(this.#evaluationDirectory(evaluationId), "plan.json"),
        MAX_EVALUATION_HEADER_BYTES,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new EvaluationStoreError("not_found", `evaluation "${evaluationId}" does not exist`, {
          cause: error,
        });
      }
      if (error instanceof EvaluationStoreError) {
        throw error;
      }
      throw new EvaluationStoreError("io", `failed to read evaluation "${evaluationId}" header`, {
        cause: error,
      });
    }
    try {
      const header = parsePublicHeader(
        parseStrictJson(decodeStrictUtf8(contents, "evaluation public header"), {
          maxDepth: 64,
          maxNodes: 200_000,
          valueLabel: "evaluation public header",
        }),
      );
      if (header.evaluationId !== evaluationId) {
        throw new EvaluationStoreError(
          "identity_mismatch",
          `evaluation header id "${header.evaluationId}" does not match directory "${evaluationId}"`,
        );
      }
      return header;
    } catch (error) {
      if (error instanceof EvaluationStoreError) {
        throw error;
      }
      throw new EvaluationStoreError(
        "corrupt",
        `evaluation "${evaluationId}" has an invalid public header`,
        { cause: error },
      );
    }
  }

  async #readLedger(header: PublicEvaluationHeader): Promise<LedgerRead> {
    let snapshot: BoundedFileSnapshot;
    try {
      await this.#assertEvaluationDirectory(header.evaluationId);
      snapshot = await readBoundedFileSnapshot(
        join(this.#evaluationDirectory(header.evaluationId), "trials.jsonl"),
        MAX_EVALUATION_LEDGER_BYTES,
      );
    } catch (error) {
      if (error instanceof EvaluationStoreError) {
        throw error;
      }
      throw new EvaluationStoreError(
        "io",
        `failed to read evaluation "${header.evaluationId}" ledger`,
        { cause: error },
      );
    }
    const { contents } = snapshot;
    const hasTornTail = contents.length > 0 && contents.at(-1) !== 0x0a;
    const lastNewline = contents.lastIndexOf(0x0a);
    const committedBytes = hasTornTail ? lastNewline + 1 : contents.length;
    const committed = decodeStrictUtf8(
      contents.subarray(0, committedBytes),
      `evaluation "${header.evaluationId}" ledger`,
    );
    const lines = committed.length === 0 ? [] : committed.slice(0, -1).split("\n");
    const records: EvaluationTrialRecord[] = [];
    for (const [index, line] of lines.entries()) {
      if (
        line.length === 0 ||
        Buffer.byteLength(`${line}\n`, "utf8") > MAX_EVALUATION_TRIAL_RECORD_BYTES
      ) {
        throw new EvaluationStoreError(
          "corrupt",
          `evaluation "${header.evaluationId}" has an invalid record at line ${index + 1}`,
        );
      }
      try {
        records.push(
          parseEvaluationTrialRecord(
            parseStrictJson(line, {
              maxDepth: 32,
              maxNodes: 4_096,
              valueLabel: `evaluation trial record ${index + 1}`,
            }),
          ),
        );
      } catch (error) {
        throw new EvaluationStoreError(
          "corrupt",
          `evaluation "${header.evaluationId}" has an invalid record at line ${index + 1}`,
          { cause: error },
        );
      }
    }
    try {
      validateCommittedEvaluationPrefix(evaluationReportInput(header), records);
    } catch (error) {
      throw new EvaluationStoreError(
        "corrupt",
        `evaluation "${header.evaluationId}" ledger contradicts its public header`,
        { cause: error },
      );
    }
    return Object.freeze({
      records: Object.freeze(records),
      committedBytes,
      observedBytes: contents.length,
      device: snapshot.device,
      inode: snapshot.inode,
      mtimeMs: snapshot.mtimeMs,
    });
  }

  async #readAttempt(
    header: PublicEvaluationHeader,
    records: readonly EvaluationTrialRecord[],
  ): Promise<AttemptRead> {
    let contents: Buffer;
    try {
      contents = await readBoundedFile(
        join(this.#evaluationDirectory(header.evaluationId), "active-attempt.json"),
        MAX_EVALUATION_TRIAL_ATTEMPT_BYTES,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return Object.freeze({ attempt: null, completed: false });
      }
      if (error instanceof EvaluationStoreError) {
        throw error;
      }
      throw new EvaluationStoreError(
        "io",
        `failed to read adapter start for evaluation "${header.evaluationId}"`,
        { cause: error },
      );
    }
    let attempt: EvaluationTrialAttempt;
    try {
      attempt = parseAttemptForStore(
        parseStrictJson(decodeStrictUtf8(contents, "evaluation adapter start"), {
          maxDepth: 16,
          maxNodes: 64,
          valueLabel: "evaluation adapter start",
        }),
        header.evaluationId,
      );
    } catch (error) {
      if (error instanceof EvaluationStoreError) {
        throw error;
      }
      throw new EvaluationStoreError(
        "corrupt",
        `evaluation "${header.evaluationId}" has an invalid adapter start`,
        { cause: error },
      );
    }
    const completed = reconcileAttempt(header, records, attempt);
    return Object.freeze({ attempt, completed });
  }

  async #retireAttempt(evaluationId: string, expected: EvaluationTrialAttempt): Promise<void> {
    const path = join(this.#evaluationDirectory(evaluationId), "active-attempt.json");
    let observed: EvaluationTrialAttempt;
    try {
      observed = parseAttemptForStore(
        parseStrictJson(
          decodeStrictUtf8(
            await readBoundedFile(path, MAX_EVALUATION_TRIAL_ATTEMPT_BYTES),
            "evaluation adapter start",
          ),
          { maxDepth: 16, maxNodes: 64, valueLabel: "evaluation adapter start" },
        ),
        evaluationId,
      );
      if (JSON.stringify(observed) !== JSON.stringify(expected)) {
        throw new EvaluationStoreError(
          "corrupt",
          `evaluation "${evaluationId}" adapter start changed before retirement`,
        );
      }
      await rm(path);
      await syncDirectory(this.#evaluationDirectory(evaluationId));
    } catch (error) {
      if (error instanceof EvaluationStoreError) {
        throw error;
      }
      throw new EvaluationStoreError(
        "io",
        `failed to retire adapter start for evaluation "${evaluationId}"`,
        { cause: error },
      );
    }
  }

  async #recoverAttemptTemporaries(evaluationId: string): Promise<void> {
    const directory = this.#evaluationDirectory(evaluationId);
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      throw new EvaluationStoreError(
        "io",
        `failed to inspect adapter-start temporaries for evaluation "${evaluationId}"`,
        { cause: error },
      );
    }
    const temporaries = entries.filter((entry) => attemptTemporaryNamePattern.test(entry.name));
    if (temporaries.length > MAX_EVALUATION_ATTEMPT_TEMPORARIES) {
      throw new EvaluationStoreError(
        "limit_exceeded",
        `evaluation "${evaluationId}" has too many adapter-start temporaries`,
      );
    }
    try {
      for (const entry of temporaries) {
        const path = join(directory, entry.name);
        const observed = await lstat(path);
        if (observed.isSymbolicLink() || !observed.isFile()) {
          throw new EvaluationStoreError(
            "corrupt",
            `evaluation "${evaluationId}" has an invalid adapter-start temporary`,
          );
        }
        if (observed.size > MAX_EVALUATION_TRIAL_ATTEMPT_BYTES) {
          throw new EvaluationStoreError(
            "limit_exceeded",
            `evaluation "${evaluationId}" adapter-start temporary exceeds its byte limit`,
          );
        }
        await unlink(path);
      }
      if (temporaries.length > 0) {
        await syncDirectory(directory);
      }
    } catch (error) {
      if (error instanceof EvaluationStoreError) {
        throw error;
      }
      throw new EvaluationStoreError(
        "io",
        `failed to retire adapter-start temporaries for evaluation "${evaluationId}"`,
        { cause: error },
      );
    }
  }

  async #acquireOwner(evaluationId: string): Promise<string> {
    await this.#assertEvaluationDirectory(evaluationId);
    const directory = this.#evaluationDirectory(evaluationId);
    const ownerDirectory = join(directory, ".owner");
    const token = randomUUID();
    const candidate = join(directory, `.owner-${token}.pending`);
    await mkdir(candidate, { mode: 0o700 });
    await writeDurableFile(
      join(candidate, "owner.json"),
      `${JSON.stringify({ version: 1, pid: process.pid, token, acquiredAt: new Date().toISOString() })}\n`,
    );
    await syncDirectory(candidate);
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          await rename(candidate, ownerDirectory);
          await syncDirectory(directory);
          return token;
        } catch (error) {
          if (!(isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY"))) {
            throw error;
          }
        }
        const current = await this.#readOwner(evaluationId);
        if (current !== undefined && isProcessAlive(current.pid)) {
          throw new EvaluationStoreError(
            "not_owner",
            `evaluation "${evaluationId}" is owned by live process ${current.pid}`,
          );
        }
        const retired = join(directory, `.owner-${randomUUID()}.stale`);
        try {
          await rename(ownerDirectory, retired);
          await syncDirectory(directory);
          await rm(retired, { recursive: true });
        } catch (error) {
          if (!(isNodeError(error) && error.code === "ENOENT")) {
            throw error;
          }
        }
      }
      throw new EvaluationStoreError(
        "not_owner",
        `evaluation "${evaluationId}" ownership changed repeatedly`,
      );
    } catch (error) {
      if (error instanceof EvaluationStoreError) {
        throw error;
      }
      throw new EvaluationStoreError("io", `failed to claim evaluation "${evaluationId}"`, {
        cause: error,
      });
    } finally {
      await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #readOwner(evaluationId: string): Promise<z.infer<typeof ownerRecordSchema> | undefined> {
    try {
      const contents = await readBoundedFile(
        join(this.#evaluationDirectory(evaluationId), ".owner", "owner.json"),
        4_096,
      );
      const parsed = ownerRecordSchema.safeParse(
        parseStrictJson(decodeStrictUtf8(contents, "evaluation owner record"), {
          maxDepth: 8,
          maxNodes: 32,
          valueLabel: "evaluation owner record",
        }),
      );
      if (!parsed.success) {
        throw new EvaluationStoreError(
          "corrupt",
          `evaluation "${evaluationId}" has invalid owner metadata`,
          { cause: parsed.error },
        );
      }
      return parsed.data;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async #releaseOwner(evaluationId: string, token: string): Promise<void> {
    const owner = await this.#readOwner(evaluationId);
    if (owner === undefined || owner.token !== token) {
      throw new EvaluationStoreError(
        "not_owner",
        `evaluation "${evaluationId}" ownership no longer belongs to this store instance`,
      );
    }
    const directory = this.#evaluationDirectory(evaluationId);
    const released = join(directory, `.owner-${randomUUID()}.released`);
    try {
      await rename(join(directory, ".owner"), released);
      await syncDirectory(directory);
      await rm(released, { recursive: true });
      await syncDirectory(directory);
    } catch (error) {
      throw new EvaluationStoreError("io", `failed to release evaluation "${evaluationId}"`, {
        cause: error,
      });
    }
  }

  #evaluationDirectory(evaluationId: string): string {
    return join(this.#rootDirectory, evaluationId);
  }

  async #assertEvaluationDirectory(evaluationId: string): Promise<void> {
    const directory = this.#evaluationDirectory(evaluationId);
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new EvaluationStoreError(
        "corrupt",
        `evaluation "${evaluationId}" directory is not a direct regular directory`,
      );
    }
    const canonical = await realpath(directory);
    if (canonical !== directory) {
      throw new EvaluationStoreError(
        "corrupt",
        `evaluation "${evaluationId}" directory escapes its canonical store root`,
      );
    }
  }

  async #canonicalizeExistingRoot(): Promise<void> {
    const canonical = await realpath(this.#rootDirectory);
    if (!(await lstat(canonical)).isDirectory()) {
      throw new EvaluationStoreError(
        "io",
        `evaluation root "${this.#rootDirectory}" is not a directory`,
      );
    }
    this.#rootDirectory = canonical;
  }
}

function parsePublicHeader(input: unknown): PublicEvaluationHeader {
  const parsed = publicHeaderSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvaluationStoreError("corrupt", "invalid evaluation public header", {
      cause: parsed.error,
    });
  }
  const identity = headerIdentity(parsed.data);
  if (calculateEvaluationPlanDigest(identity) !== parsed.data.planDigest) {
    throw new EvaluationStoreError(
      "identity_mismatch",
      "evaluation public header plan digest does not match its identity fields",
    );
  }
  const expectedSchedule = createEvaluationSchedule(
    parsed.data.planDigest,
    parsed.data.suite.tasks.map((task) => task.id),
    parsed.data.profiles.map((profile) => profile.id),
    parsed.data.seeds,
  );
  if (JSON.stringify(expectedSchedule) !== JSON.stringify(parsed.data.schedule)) {
    throw new EvaluationStoreError(
      "identity_mismatch",
      "evaluation public header schedule does not match its plan identity",
    );
  }
  return deepFreeze(parsed.data);
}

function parseAttemptForStore(input: unknown, evaluationId: string): EvaluationTrialAttempt {
  try {
    return parseEvaluationTrialAttempt(input);
  } catch (error) {
    throw new EvaluationStoreError(
      "corrupt",
      `evaluation "${evaluationId}" has invalid adapter-start evidence`,
      { cause: error },
    );
  }
}

function reconcileAttempt(
  header: PublicEvaluationHeader,
  records: readonly EvaluationTrialRecord[],
  attempt: EvaluationTrialAttempt,
): boolean {
  const schedule = header.schedule[attempt.position - 1];
  const profile = header.profiles.find((item) => item.id === attempt.profileId);
  if (
    schedule === undefined ||
    profile === undefined ||
    attempt.planDigest !== header.planDigest ||
    attempt.position !== schedule.position ||
    attempt.trialId !== schedule.trialId ||
    attempt.taskId !== schedule.taskId ||
    attempt.profileId !== schedule.profileId ||
    attempt.adapter !== profile.adapter
  ) {
    throw new EvaluationStoreError(
      "corrupt",
      `evaluation "${header.evaluationId}" adapter start contradicts its public schedule`,
    );
  }
  if (attempt.position === records.length + 1) {
    return false;
  }
  const terminal = records.at(-1);
  if (
    attempt.position === records.length &&
    terminal?.position === attempt.position &&
    terminal.trialId === attempt.trialId
  ) {
    return true;
  }
  throw new EvaluationStoreError(
    "corrupt",
    `evaluation "${header.evaluationId}" adapter start contradicts its committed ledger`,
  );
}

function headerIdentity(header: PublicEvaluationHeader): EvaluationPlanIdentity {
  return {
    version: 1,
    apiVersion: header.apiVersion,
    id: header.planId,
    suite: header.suite,
    profiles: header.profiles.map((profile) =>
      profile.adapter === "pi-native-v1"
        ? { id: profile.id, adapter: profile.adapter, harness: profile.harness }
        : {
            id: profile.id,
            adapter: profile.adapter,
            workflow: {
              provenance: profile.workflow.provenance,
              sourceSha256: profile.workflow.sourceSha256,
              workflowDigest: profile.workflow.workflowDigest,
              ...(profile.workflow.sourceKind === undefined
                ? {}
                : { sourceKind: profile.workflow.sourceKind }),
            },
            ...(profile.candidate === undefined ? {} : { candidate: profile.candidate }),
          },
    ),
    controls: header.controls,
    seeds: header.seeds,
    order: header.order,
    comparison: header.comparison,
  };
}

async function ensureCanonicalRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) {
    throw new EvaluationStoreError("io", `evaluation root "${root}" is not a canonical directory`);
  }
  return canonical;
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  return (await readBoundedFileSnapshot(path, maxBytes)).contents;
}

async function readBoundedFileSnapshot(
  path: string,
  maxBytes: number,
): Promise<BoundedFileSnapshot> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new EvaluationStoreError("corrupt", `evaluation path "${path}" is not a regular file`);
    }
    if (before.size > maxBytes) {
      throw new EvaluationStoreError(
        "limit_exceeded",
        `evaluation path "${path}" exceeds ${maxBytes} bytes`,
      );
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (
      contents.byteLength !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new EvaluationStoreError("corrupt", `evaluation path "${path}" changed while read`);
    }
    return Object.freeze({
      contents,
      device: after.dev,
      inode: after.ino,
      mtimeMs: after.mtimeMs,
    });
  } finally {
    await handle.close();
  }
}

async function writeDurableFile(path: string, contents: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    throw new EvaluationStoreError("io", `failed to create durable file "${path}"`, {
      cause: error,
    });
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableFileAtomicExclusive(
  directory: string,
  finalName: string,
  contents: string,
): Promise<void> {
  const temporary = join(directory, `.active-attempt.${randomUUID()}.tmp`);
  try {
    await writeDurableFile(temporary, contents);
    await link(temporary, join(directory, finalName));
    await syncDirectory(directory);
    await unlink(temporary);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    await syncDirectory(directory).catch(() => undefined);
    throw error;
  }
}

function decodeStrictUtf8(contents: Buffer, label: string): string {
  try {
    return fatalUtf8Decoder.decode(contents);
  } catch (error) {
    throw new EvaluationStoreError("corrupt", `${label} contains invalid UTF-8`, {
      cause: error,
    });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateEvaluationId(evaluationId: string): string {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(evaluationId) || evaluationId.length > 64) {
    throw new EvaluationStoreError(
      "invalid_evaluation_id",
      `invalid evaluation id "${evaluationId.slice(0, 128)}"`,
    );
  }
  return evaluationId;
}

function isCanonicalRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function refineUnique(
  values: readonly unknown[],
  path: PropertyKey[],
  label: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: `${label} must be unique` });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return value;
}
