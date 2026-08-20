import { createHash } from "node:crypto";

import { z } from "zod";

import {
  createEffectiveHarnessHeadIdentity,
  type EffectiveHarnessHeadIdentity,
  type EffectiveHarnessScope,
  EffectiveHarnessStateError,
  parseEffectiveHarnessHeadIdentity,
} from "./effective-harness-state.js";

const TRANSITION_DIGEST_DOMAIN = "flow-effective-harness-transition-v1";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const boundedPublicTextSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !containsControlCharacter(value), "must not contain control characters");

const candidateSchema = z
  .object({
    kind: z.enum([
      "prompt-candidate",
      "agent-skill-candidate",
      "agent-skill-package-candidate",
      "model-routing-candidate",
      "child-specialist-candidate",
    ]),
    digest: sha256Schema,
  })
  .strict();

const evaluationSchema = z
  .object({
    id: identifierSchema,
    planDigest: sha256Schema,
    terminalRecordDigest: sha256Schema,
    reportDigest: sha256Schema,
  })
  .strict();

const effectiveHarnessTransitionCommonSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("effective-harness-transition"),
    scopeDigest: sha256Schema,
    workflowId: identifierSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    fromActivationDigest: sha256Schema,
    fromStateDigest: sha256Schema,
    previousTransitionDigest: sha256Schema,
    toActivationDigest: sha256Schema,
    toStateDigest: sha256Schema,
    actor: boundedPublicTextSchema.max(128),
    reason: boundedPublicTextSchema.optional(),
    changedAt: z
      .string()
      .datetime({ offset: true })
      .refine(isCanonicalTimestamp, "must be a canonical timestamp"),
  })
  .strict();

const effectiveHarnessActivationTransitionSchema = effectiveHarnessTransitionCommonSchema.extend({
  action: z.literal("activate"),
  surface: z.enum([
    "prompt",
    "agent-skill-resource",
    "agent-skill-package",
    "model-routing",
    "child-specialist",
  ]),
  candidate: candidateSchema,
  evaluation: evaluationSchema,
  transitionDigest: sha256Schema,
});

const effectiveHarnessRollbackTransitionSchema = effectiveHarnessTransitionCommonSchema.extend({
  action: z.literal("rollback"),
  surface: z.literal("rollback"),
  targetTransitionDigest: sha256Schema,
  transitionDigest: sha256Schema,
});

const effectiveHarnessTransitionSchema = z.discriminatedUnion("action", [
  effectiveHarnessActivationTransitionSchema,
  effectiveHarnessRollbackTransitionSchema,
]);

export type EffectiveHarnessSurface =
  | "prompt"
  | "agent-skill-resource"
  | "agent-skill-package"
  | "model-routing"
  | "child-specialist";

export type EffectiveHarnessCandidateKind =
  | "prompt-candidate"
  | "agent-skill-candidate"
  | "agent-skill-package-candidate"
  | "model-routing-candidate"
  | "child-specialist-candidate";

export interface EffectiveHarnessTransitionBase {
  readonly version: 1;
  readonly kind: "effective-harness-transition";
  readonly scopeDigest: string;
  readonly workflowId: string;
  readonly generation: number;
  readonly fromActivationDigest: string;
  readonly fromStateDigest: string;
  readonly previousTransitionDigest: string;
  readonly toActivationDigest: string;
  readonly toStateDigest: string;
  readonly actor: string;
  readonly reason?: string | undefined;
  readonly changedAt: string;
  readonly transitionDigest: string;
}

export interface EffectiveHarnessActivationTransition extends EffectiveHarnessTransitionBase {
  readonly action: "activate";
  readonly surface: EffectiveHarnessSurface;
  readonly candidate: {
    readonly kind: EffectiveHarnessCandidateKind;
    readonly digest: string;
  };
  readonly evaluation: {
    readonly id: string;
    readonly planDigest: string;
    readonly terminalRecordDigest: string;
    readonly reportDigest: string;
  };
}

export interface EffectiveHarnessRollbackTransition extends EffectiveHarnessTransitionBase {
  readonly action: "rollback";
  readonly surface: "rollback";
  readonly targetTransitionDigest: string;
}

export type EffectiveHarnessTransition =
  | EffectiveHarnessActivationTransition
  | EffectiveHarnessRollbackTransition;

export interface CreateEffectiveHarnessTransitionInput {
  readonly prior: EffectiveHarnessHeadIdentity;
  readonly toActivationDigest: string;
  readonly toStateDigest: string;
  readonly surface: EffectiveHarnessSurface;
  readonly candidate: EffectiveHarnessActivationTransition["candidate"];
  readonly evaluation: EffectiveHarnessActivationTransition["evaluation"];
  readonly actor: string;
  readonly reason?: string | undefined;
  readonly changedAt: string;
}

export interface CreateEffectiveHarnessRollbackTransitionInput {
  readonly prior: EffectiveHarnessHeadIdentity;
  readonly toActivationDigest: string;
  readonly toStateDigest: string;
  readonly targetTransitionDigest: string;
  readonly actor: string;
  readonly reason?: string | undefined;
  readonly changedAt: string;
}

export interface EffectiveHarnessTransitionContext extends EffectiveHarnessScope {
  readonly prior: EffectiveHarnessHeadIdentity;
}

export function createEffectiveHarnessTransition(
  input: CreateEffectiveHarnessTransitionInput,
): EffectiveHarnessActivationTransition {
  const prior = parseEffectiveHarnessHeadIdentity(input.prior, {
    scopeDigest: input.prior.scopeDigest,
  });
  const content = {
    version: 1 as const,
    kind: "effective-harness-transition" as const,
    action: "activate" as const,
    scopeDigest: prior.scopeDigest,
    workflowId: prior.workflowId,
    generation: prior.generation + 1,
    fromActivationDigest: prior.activationDigest,
    fromStateDigest: prior.stateDigest,
    previousTransitionDigest: prior.transitionDigest,
    toActivationDigest: input.toActivationDigest,
    toStateDigest: input.toStateDigest,
    surface: input.surface,
    candidate: input.candidate,
    evaluation: input.evaluation,
    actor: input.actor,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    changedAt: input.changedAt,
  };
  return parseEffectiveHarnessTransition(
    { ...content, transitionDigest: calculateEffectiveHarnessTransitionDigest(content) },
    { scopeDigest: prior.scopeDigest, prior },
  ) as EffectiveHarnessActivationTransition;
}

export function createEffectiveHarnessRollbackTransition(
  input: CreateEffectiveHarnessRollbackTransitionInput,
): EffectiveHarnessRollbackTransition {
  const prior = parseEffectiveHarnessHeadIdentity(input.prior, {
    scopeDigest: input.prior.scopeDigest,
  });
  const content = {
    version: 1 as const,
    kind: "effective-harness-transition" as const,
    action: "rollback" as const,
    scopeDigest: prior.scopeDigest,
    workflowId: prior.workflowId,
    generation: prior.generation + 1,
    fromActivationDigest: prior.activationDigest,
    fromStateDigest: prior.stateDigest,
    previousTransitionDigest: prior.transitionDigest,
    toActivationDigest: input.toActivationDigest,
    toStateDigest: input.toStateDigest,
    surface: "rollback" as const,
    targetTransitionDigest: input.targetTransitionDigest,
    actor: input.actor,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    changedAt: input.changedAt,
  };
  return parseEffectiveHarnessTransition(
    { ...content, transitionDigest: calculateEffectiveHarnessTransitionDigest(content) },
    { scopeDigest: prior.scopeDigest, prior },
  ) as EffectiveHarnessRollbackTransition;
}

export function parseEffectiveHarnessTransition(
  input: unknown,
  context: EffectiveHarnessTransitionContext,
): EffectiveHarnessTransition {
  const prior = parseEffectiveHarnessHeadIdentity(context.prior, {
    scopeDigest: context.scopeDigest,
  });
  const parsed = effectiveHarnessTransitionSchema.safeParse(input);
  if (!parsed.success) {
    throw new EffectiveHarnessStateError(
      "invalid_schema",
      "effective harness transition is invalid",
    );
  }
  const transition: EffectiveHarnessTransition = parsed.data;
  if (
    transition.scopeDigest !== context.scopeDigest ||
    transition.scopeDigest !== prior.scopeDigest ||
    transition.workflowId !== prior.workflowId ||
    transition.generation !== prior.generation + 1 ||
    transition.fromActivationDigest !== prior.activationDigest ||
    transition.fromStateDigest !== prior.stateDigest ||
    transition.previousTransitionDigest !== prior.transitionDigest
  ) {
    throw new EffectiveHarnessStateError(
      "stale_head",
      "effective harness transition does not match the current head",
    );
  }
  assertTransitionSemantics(transition);
  if (calculateEffectiveHarnessTransitionDigest(transition) !== transition.transitionDigest) {
    throw new EffectiveHarnessStateError(
      "identity_mismatch",
      "effective harness transition digest does not match",
    );
  }
  return deepFreeze(transition);
}

export function calculateEffectiveHarnessTransitionDigest(
  transition: EffectiveHarnessTransitionContent | EffectiveHarnessTransition,
): string {
  return sha256(
    canonicalize({
      domain: TRANSITION_DIGEST_DOMAIN,
      version: transition.version,
      kind: transition.kind,
      scopeDigest: transition.scopeDigest,
      workflowId: transition.workflowId,
      generation: transition.generation,
      fromActivationDigest: transition.fromActivationDigest,
      fromStateDigest: transition.fromStateDigest,
      previousTransitionDigest: transition.previousTransitionDigest,
      toActivationDigest: transition.toActivationDigest,
      toStateDigest: transition.toStateDigest,
      action: transition.action,
      surface: transition.surface,
      candidate: transition.action === "activate" ? transition.candidate : null,
      evaluation: transition.action === "activate" ? transition.evaluation : null,
      targetTransitionDigest:
        transition.action === "rollback" ? transition.targetTransitionDigest : null,
      actor: transition.actor,
      reason: transition.reason ?? null,
      changedAt: transition.changedAt,
    }),
  );
}

type EffectiveHarnessTransitionContent =
  | Omit<EffectiveHarnessActivationTransition, "transitionDigest">
  | Omit<EffectiveHarnessRollbackTransition, "transitionDigest">;

export function effectiveHarnessHeadFromTransition(
  transition: EffectiveHarnessTransition,
): EffectiveHarnessHeadIdentity {
  const parsed = effectiveHarnessTransitionSchema.safeParse(transition);
  if (
    !parsed.success ||
    calculateEffectiveHarnessTransitionDigest(parsed.data) !== parsed.data.transitionDigest
  ) {
    throw new EffectiveHarnessStateError(
      "identity_mismatch",
      "effective harness transition cannot select a head",
    );
  }
  assertTransitionSemantics(parsed.data);
  return createEffectiveHarnessHeadIdentity({
    scopeDigest: parsed.data.scopeDigest,
    workflowId: parsed.data.workflowId,
    generation: parsed.data.generation,
    activationDigest: parsed.data.toActivationDigest,
    transitionDigest: parsed.data.transitionDigest,
    stateDigest: parsed.data.toStateDigest,
  });
}

function assertTransitionSemantics(transition: EffectiveHarnessTransition): void {
  if (transition.toStateDigest === transition.fromStateDigest) {
    throw new EffectiveHarnessStateError(
      "identity_mismatch",
      "effective harness transition does not change its state",
    );
  }
  if (
    transition.action === "activate" &&
    !surfaceMatchesCandidate(transition.surface, transition.candidate.kind)
  ) {
    throw new EffectiveHarnessStateError(
      "identity_mismatch",
      "effective harness surface does not match its candidate",
    );
  }
}

function surfaceMatchesCandidate(
  surface: EffectiveHarnessSurface,
  kind: EffectiveHarnessCandidateKind,
): boolean {
  return (
    (surface === "prompt" && kind === "prompt-candidate") ||
    (surface === "agent-skill-resource" && kind === "agent-skill-candidate") ||
    (surface === "agent-skill-package" && kind === "agent-skill-package-candidate") ||
    (surface === "model-routing" && kind === "model-routing-candidate") ||
    (surface === "child-specialist" && kind === "child-specialist-candidate")
  );
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
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
  throw new EffectiveHarnessStateError(
    "invalid_schema",
    "effective harness transition is not canonical JSON",
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
