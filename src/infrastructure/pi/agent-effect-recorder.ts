import {
  EMPTY_DIRECTORY_STATE_SHA256,
  MAX_AGENT_EFFECT_RECEIPTS,
  type AgentEffectReceipt,
} from "../../domain/run/events.js";
import type { NodeEffectJournal, PreparedNodeEffect } from "../../application/ports.js";
import { MAX_POLICY_TARGET_BYTES } from "../../domain/policy/limits.js";
import type { PolicyAttribution } from "../../domain/policy/types.js";

export type AgentEffectIdentity =
  | {
      readonly kind: "filesystem.edit";
      readonly target: string;
      readonly operationDigest: string;
    }
  | {
      readonly kind: "filesystem.create";
      readonly target: string;
      readonly operationDigest: string;
    }
  | {
      readonly kind: "filesystem.mkdir";
      readonly target: string;
      readonly operationDigest: string;
    };

export interface AgentEffectPreparation {
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
  readonly mode: number;
}

export type AgentEffectSettlement =
  | { readonly outcome: "committed"; readonly reason: "directory_synced" }
  | { readonly outcome: "not_applied"; readonly reason: "commit_not_entered" }
  | { readonly outcome: "unknown"; readonly reason: "post_commit_failure" };

export interface AgentEffectReservation {
  prepare(preparation: AgentEffectPreparation): Promise<void>;
  settle(settlement: AgentEffectSettlement): Promise<AgentEffectReceipt | null>;
  cancel(): void;
}

export class AgentEffectRecorder {
  readonly attribution: PolicyAttribution;
  readonly #receipts: AgentEffectReceipt[] = [];
  readonly #reservations = new Set<symbol>();
  readonly #idleWaiters = new Set<() => void>();
  #preparedEffectCount = 0;
  #unpreparedReservationCount = 0;
  #closed = false;

  constructor(
    attribution: PolicyAttribution,
    readonly journal?: NodeEffectJournal,
  ) {
    this.attribution = Object.freeze({ ...attribution });
  }

  reserve(identity: AgentEffectIdentity): AgentEffectReservation {
    this.#requireOpen();
    validateIdentity(identity);
    if (this.#preparedEffectCount + this.#unpreparedReservationCount >= MAX_AGENT_EFFECT_RECEIPTS) {
      throw new AgentEffectAuditLimitError(MAX_AGENT_EFFECT_RECEIPTS);
    }

    const token = Symbol("agent-effect-reservation");
    this.#reservations.add(token);
    this.#unpreparedReservationCount += 1;
    let active = true;
    let preparing = false;
    let prepared: PreparedNodeEffect | undefined;
    let acceptedPreparation: AgentEffectPreparation | undefined;
    return Object.freeze({
      prepare: async (preparation: AgentEffectPreparation) => {
        this.#requireOpen();
        if (!active || !this.#reservations.has(token) || preparing || prepared !== undefined) {
          throw new AgentEffectReservationError();
        }
        if (this.journal === undefined) {
          throw new AgentEffectJournalUnavailableError();
        }
        validatePreparation(identity, preparation);
        const durablePreparation = Object.freeze(structuredClone(preparation));
        preparing = true;
        try {
          prepared = await this.journal.prepare(effectDescriptor(identity, durablePreparation));
          acceptedPreparation = durablePreparation;
          this.#unpreparedReservationCount -= 1;
          this.#preparedEffectCount += 1;
        } finally {
          preparing = false;
        }
      },
      settle: async (settlement: AgentEffectSettlement) => {
        this.#requireOpen();
        if (
          !active ||
          !this.#reservations.has(token) ||
          prepared === undefined ||
          acceptedPreparation === undefined ||
          preparing
        ) {
          throw new AgentEffectReservationError();
        }
        const receipt = await prepared.settle(settlement);
        active = false;
        this.#releaseReservation(token);
        if (settlement.outcome === "not_applied") {
          if (receipt !== null) {
            throw new AgentEffectReservationError();
          }
          return null;
        }
        if (receipt === null) {
          throw new AgentEffectReservationError();
        }
        validateJournalReceipt(
          receipt,
          this.attribution,
          identity,
          acceptedPreparation,
          prepared.effectSequence,
          settlement.outcome === "committed" ? "committed" : "uncertain",
        );
        const frozenReceipt = Object.freeze(structuredClone(receipt));
        this.#receipts.push(frozenReceipt);
        this.#receipts.sort((left, right) => left.sequence - right.sequence);
        return frozenReceipt;
      },
      cancel: () => {
        if (!active) {
          return;
        }
        if (prepared !== undefined || preparing) {
          throw new AgentEffectReservationError();
        }
        active = false;
        this.#unpreparedReservationCount -= 1;
        this.#releaseReservation(token);
      },
    });
  }

  snapshot(): readonly AgentEffectReceipt[] {
    return Object.freeze([...this.#receipts]);
  }

  whenIdle(): Promise<void> {
    if (this.#reservations.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#idleWaiters.add(resolve);
    });
  }

  close(): readonly AgentEffectReceipt[] {
    this.#closed = true;
    this.#reservations.clear();
    this.#notifyIdle();
    return this.snapshot();
  }

  #releaseReservation(token: symbol): void {
    this.#reservations.delete(token);
    this.#notifyIdle();
  }

  #notifyIdle(): void {
    if (this.#reservations.size > 0) {
      return;
    }
    for (const resolve of this.#idleWaiters) {
      resolve();
    }
    this.#idleWaiters.clear();
  }

  #requireOpen(): void {
    if (this.#closed) {
      throw new AgentEffectAuditClosedError();
    }
  }
}

export class AgentEffectAuditLimitError extends Error {
  override readonly name = "AgentEffectAuditLimitError";

  constructor(readonly limit: number) {
    super(`Agent effect audit limit of ${limit} receipts was reached`);
  }
}

export class AgentEffectAuditClosedError extends Error {
  override readonly name = "AgentEffectAuditClosedError";

  constructor() {
    super("Agent effect audit is closed; late effects are denied");
  }
}

export class AgentEffectReservationError extends Error {
  override readonly name = "AgentEffectReservationError";

  constructor() {
    super("Agent effect reservation is not active");
  }
}

export class AgentEffectJournalUnavailableError extends Error {
  override readonly name = "AgentEffectJournalUnavailableError";

  constructor() {
    super("Agent effect preparation requires an attempt-scoped durable journal");
  }
}

function validateIdentity(identity: AgentEffectIdentity): void {
  const targetBytes = Buffer.byteLength(identity.target, "utf8");
  if (targetBytes === 0 || targetBytes > MAX_POLICY_TARGET_BYTES) {
    throw new RangeError(
      `effect target must contain between 1 and ${MAX_POLICY_TARGET_BYTES} UTF-8 bytes`,
    );
  }
  validateSha256(identity.operationDigest, "effect operation digest");
}

function validateEffectHashes(effect: {
  readonly kind: AgentEffectIdentity["kind"];
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
}): void {
  validateSha256(effect.afterSha256, "effect after digest");
  if (effect.kind === "filesystem.edit") {
    if (effect.beforeSha256 === null) {
      throw new RangeError("filesystem.edit requires an effect before digest");
    }
    validateSha256(effect.beforeSha256, "effect before digest");
    if (effect.beforeSha256 === effect.afterSha256) {
      throw new RangeError("effect before and after digests must differ");
    }
  } else if (effect.beforeSha256 !== null) {
    throw new RangeError(`${effect.kind} requires an absent before state`);
  } else if (
    effect.kind === "filesystem.mkdir" &&
    effect.afterSha256 !== EMPTY_DIRECTORY_STATE_SHA256
  ) {
    throw new RangeError("filesystem.mkdir requires the empty-directory state digest");
  }
}

function validatePreparation(
  identity: AgentEffectIdentity,
  preparation: AgentEffectPreparation,
): void {
  validateEffectHashes({ kind: identity.kind, ...preparation });
  if (!Number.isInteger(preparation.mode) || preparation.mode < 0 || preparation.mode > 0o777) {
    throw new RangeError("effect mode must be an integer between 0 and 0777");
  }
  if (identity.kind === "filesystem.mkdir" && preparation.mode !== 0o755) {
    throw new RangeError("filesystem.mkdir requires mode 0755");
  }
}

function effectDescriptor(identity: AgentEffectIdentity, preparation: AgentEffectPreparation) {
  if (identity.kind === "filesystem.edit") {
    if (preparation.beforeSha256 === null) {
      throw new AgentEffectReservationError();
    }
    return {
      ...identity,
      beforeSha256: preparation.beforeSha256,
      afterSha256: preparation.afterSha256,
      mode: preparation.mode,
    } as const;
  }
  if (preparation.beforeSha256 !== null) {
    throw new AgentEffectReservationError();
  }
  if (identity.kind === "filesystem.mkdir") {
    if (preparation.afterSha256 !== EMPTY_DIRECTORY_STATE_SHA256 || preparation.mode !== 0o755) {
      throw new AgentEffectReservationError();
    }
    return {
      ...identity,
      beforeSha256: null,
      afterSha256: EMPTY_DIRECTORY_STATE_SHA256,
      mode: 0o755,
    } as const;
  }
  return {
    ...identity,
    beforeSha256: null,
    afterSha256: preparation.afterSha256,
    mode: preparation.mode,
  } as const;
}

function validateJournalReceipt(
  receipt: AgentEffectReceipt,
  attribution: PolicyAttribution,
  identity: AgentEffectIdentity,
  preparation: AgentEffectPreparation,
  expectedSequence: number,
  expectedOutcome: AgentEffectReceipt["outcome"],
): void {
  if (
    receipt.version !== 1 ||
    receipt.sequence !== expectedSequence ||
    receipt.runId !== attribution.runId ||
    receipt.workflowId !== attribution.workflowId ||
    receipt.nodeId !== attribution.nodeId ||
    receipt.attempt !== attribution.attempt ||
    receipt.kind !== identity.kind ||
    receipt.target !== identity.target ||
    receipt.operationDigest !== identity.operationDigest ||
    receipt.beforeSha256 !== preparation.beforeSha256 ||
    receipt.afterSha256 !== preparation.afterSha256 ||
    receipt.outcome !== expectedOutcome
  ) {
    throw new AgentEffectReservationError();
  }
  validateEffectHashes(receipt);
}

function validateSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 hex value`);
  }
}
