import { MAX_AGENT_EFFECT_RECEIPTS, type AgentEffectReceipt } from "../../domain/run/events.js";
import { MAX_POLICY_TARGET_BYTES } from "../../domain/policy/broker.js";
import type { PolicyAttribution } from "../../domain/policy/types.js";

export interface AgentEffectIdentity {
  readonly kind: "filesystem.edit";
  readonly target: string;
  readonly operationDigest: string;
}

export interface AgentEffectOutcome {
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly outcome: "committed" | "uncertain";
}

export interface AgentEffectReservation {
  commit(outcome: AgentEffectOutcome): AgentEffectReceipt;
  cancel(): void;
}

export class AgentEffectRecorder {
  readonly attribution: PolicyAttribution;
  readonly #receipts: AgentEffectReceipt[] = [];
  readonly #reservations = new Set<symbol>();
  readonly #idleWaiters = new Set<() => void>();
  #closed = false;

  constructor(attribution: PolicyAttribution) {
    this.attribution = Object.freeze({ ...attribution });
  }

  reserve(identity: AgentEffectIdentity): AgentEffectReservation {
    this.#requireOpen();
    validateIdentity(identity);
    if (this.#receipts.length + this.#reservations.size >= MAX_AGENT_EFFECT_RECEIPTS) {
      throw new AgentEffectAuditLimitError(MAX_AGENT_EFFECT_RECEIPTS);
    }

    const token = Symbol("agent-effect-reservation");
    this.#reservations.add(token);
    let active = true;
    return Object.freeze({
      commit: (outcome: AgentEffectOutcome) => {
        this.#requireOpen();
        if (!active || !this.#reservations.has(token)) {
          throw new AgentEffectReservationError();
        }
        validateOutcome(outcome);
        active = false;
        this.#releaseReservation(token);
        const receipt: AgentEffectReceipt = Object.freeze({
          version: 1,
          sequence: this.#receipts.length + 1,
          ...this.attribution,
          ...identity,
          ...outcome,
        });
        this.#receipts.push(receipt);
        return receipt;
      },
      cancel: () => {
        if (!active) {
          return;
        }
        active = false;
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

function validateIdentity(identity: AgentEffectIdentity): void {
  const targetBytes = Buffer.byteLength(identity.target, "utf8");
  if (targetBytes === 0 || targetBytes > MAX_POLICY_TARGET_BYTES) {
    throw new RangeError(
      `effect target must contain between 1 and ${MAX_POLICY_TARGET_BYTES} UTF-8 bytes`,
    );
  }
  validateSha256(identity.operationDigest, "effect operation digest");
}

function validateOutcome(outcome: AgentEffectOutcome): void {
  validateSha256(outcome.beforeSha256, "effect before digest");
  validateSha256(outcome.afterSha256, "effect after digest");
  if (outcome.beforeSha256 === outcome.afterSha256) {
    throw new RangeError("effect before and after digests must differ");
  }
}

function validateSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 hex value`);
  }
}
