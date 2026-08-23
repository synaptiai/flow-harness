import { createHash } from "node:crypto";

import { z } from "zod";
import { MAX_AGENT_SKILL_PACKAGES } from "../capability/agent-skill-contract.js";
import {
  type CapabilityPackageSnapshot,
  type CapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../capability/agent-skills.js";
import { bindWorkflowCapabilities } from "../capability/workflow-capabilities.js";
import {
  type WorkflowPackageSnapshot,
  workflowPackageIdentityKey,
  workflowPackageSource,
} from "../capability/workflow-packages.js";
import {
  compileWorkflowText,
  type ResolvedWorkflowPackage,
  type WorkflowPackageReference,
} from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import type { CompiledWorkflowPackageReference } from "../workflow/types.js";
import { MAX_PROMPT_ACTIVATION_SOURCE_BYTES } from "./prompt-activation.js";
import {
  type PhaseRoutingProfile,
  parsePhaseRoutingProfile,
  validatePhaseRoutingProfileForWorkflow,
} from "./phase-routing-candidate.js";
import {
  createSupplementalMemoryRelationshipState,
  parseSupplementalMemoryRelationshipState,
  type SupplementalMemoryRelationshipInput,
  type SupplementalMemoryRelationshipState,
  SupplementalMemoryRelationshipError,
} from "./supplemental-memory-relationships.js";
import {
  createSupplementalMemoryEntries,
  parseSupplementalMemoryEntries,
  type SupplementalMemoryEntry,
  type SupplementalMemoryEntryInput,
  SupplementalMemoryError,
} from "./supplemental-memory.js";

export const MAX_EFFECTIVE_HARNESS_STATE_BYTES = 16 * 1024 * 1024;

const STATE_DIGEST_DOMAIN = "flow-effective-harness-state-v1";
const HEAD_DIGEST_DOMAIN = "flow-effective-harness-head-v1";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const semanticVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
const rootPackageSchema = z
  .object({
    name: identifierSchema,
    version: semanticVersionSchema,
    digest: sha256Schema,
  })
  .strict();

const effectiveHarnessStateSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("effective-harness-state"),
    scopeDigest: sha256Schema,
    workflowId: identifierSchema,
    workflow: z
      .object({
        bytes: z.number().int().positive().max(MAX_PROMPT_ACTIVATION_SOURCE_BYTES),
        sha256: sha256Schema,
        workflowDigest: sha256Schema,
        contentBase64: z.string().max(Math.ceil((MAX_PROMPT_ACTIVATION_SOURCE_BYTES * 4) / 3) + 4),
      })
      .strict(),
    rootPackage: rootPackageSchema.optional(),
    packages: z.array(z.unknown()).max(MAX_AGENT_SKILL_PACKAGES),
    supplementalMemory: z.array(z.unknown()).optional(),
    supplementalMemoryRelationships: z.unknown().optional(),
    phaseRoutingProfile: z.unknown().optional(),
    stateDigest: sha256Schema,
  })
  .strict();

const effectiveHarnessHeadIdentitySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("effective-harness-head"),
    scopeDigest: sha256Schema,
    workflowId: identifierSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    activationDigest: sha256Schema,
    transitionDigest: sha256Schema,
    stateDigest: sha256Schema,
    headDigest: sha256Schema,
  })
  .strict();

export interface EffectiveHarnessState {
  readonly version: 1;
  readonly kind: "effective-harness-state";
  readonly scopeDigest: string;
  readonly workflowId: string;
  readonly workflow: {
    readonly bytes: number;
    readonly sha256: string;
    readonly workflowDigest: string;
    readonly contentBase64: string;
  };
  readonly rootPackage?: CompiledWorkflowPackageReference | undefined;
  readonly packages: readonly CapabilityPackageSnapshot[];
  readonly supplementalMemory?: readonly SupplementalMemoryEntry[] | undefined;
  readonly supplementalMemoryRelationships?: SupplementalMemoryRelationshipState | undefined;
  readonly phaseRoutingProfile?: PhaseRoutingProfile | undefined;
  readonly stateDigest: string;
}

export interface EffectiveHarnessHeadIdentity {
  readonly version: 1;
  readonly kind: "effective-harness-head";
  readonly scopeDigest: string;
  readonly workflowId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly transitionDigest: string;
  readonly stateDigest: string;
  readonly headDigest: string;
}

export interface CreateEffectiveHarnessStateInput {
  readonly scopeDigest: string;
  readonly workflowSource: string;
  readonly rootPackage?: CompiledWorkflowPackageReference | undefined;
  readonly packages: readonly CapabilityPackageSnapshot[];
  readonly supplementalMemory?: readonly SupplementalMemoryEntryInput[] | undefined;
  readonly supplementalMemoryRelationships?:
    | readonly SupplementalMemoryRelationshipInput[]
    | undefined;
  readonly phaseRoutingProfile?: PhaseRoutingProfile | undefined;
}

export interface CreateEffectiveHarnessHeadIdentityInput {
  readonly scopeDigest: string;
  readonly workflowId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly transitionDigest: string;
  readonly stateDigest: string;
}

export interface EffectiveHarnessScope {
  readonly scopeDigest: string;
}

export type EffectiveHarnessStateErrorCode =
  | "identity_mismatch"
  | "invalid_closure"
  | "invalid_schema"
  | "invalid_workflow"
  | "limit_exceeded"
  | "scope_mismatch"
  | "stale_head"
  | "unexpected_policy";

export class EffectiveHarnessStateError extends Error {
  override readonly name = "EffectiveHarnessStateError";

  constructor(
    readonly code: EffectiveHarnessStateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function createEffectiveHarnessState(
  input: CreateEffectiveHarnessStateInput,
): EffectiveHarnessState {
  assertDigest(input.scopeDigest, "scope_mismatch", "effective harness scope is invalid");
  const workflowContent = Buffer.from(input.workflowSource, "utf8");
  if (
    workflowContent.byteLength === 0 ||
    workflowContent.byteLength > MAX_PROMPT_ACTIVATION_SOURCE_BYTES
  ) {
    throw new EffectiveHarnessStateError(
      "limit_exceeded",
      `effective harness workflow must be 1-${MAX_PROMPT_ACTIVATION_SOURCE_BYTES} UTF-8 bytes`,
    );
  }
  const packages = parsePackageClosure(input.packages);
  const rootPackage = parseRootPackage(input.rootPackage, packages, input.workflowSource);
  const compiled = compileEffectiveWorkflow(input.workflowSource, packages, rootPackage);
  bindEffectiveWorkflow(compiled, packages);
  const supplementalMemory = parseMemoryInput(input.supplementalMemory, compiled);
  const supplementalMemoryRelationships = parseMemoryRelationshipInput(
    input.supplementalMemoryRelationships,
    supplementalMemory,
  );
  const phaseRoutingProfile = parsePhaseProfile(input.phaseRoutingProfile, compiled);
  const content = {
    version: 1 as const,
    kind: "effective-harness-state" as const,
    scopeDigest: input.scopeDigest,
    workflowId: compiled.id,
    workflow: {
      bytes: workflowContent.byteLength,
      sha256: sha256(workflowContent),
      workflowDigest: calculateWorkflowDigest(compiled),
      contentBase64: workflowContent.toString("base64"),
    },
    ...(rootPackage === undefined ? {} : { rootPackage }),
    packages,
    ...(supplementalMemory.length === 0 ? {} : { supplementalMemory }),
    ...(supplementalMemoryRelationships === undefined ? {} : { supplementalMemoryRelationships }),
    ...(phaseRoutingProfile === undefined ? {} : { phaseRoutingProfile }),
  };
  return parseEffectiveHarnessState(
    { ...content, stateDigest: calculateEffectiveHarnessStateDigest(content) },
    { scopeDigest: input.scopeDigest },
  );
}

export function parseEffectiveHarnessState(
  input: unknown,
  expected: EffectiveHarnessScope,
): EffectiveHarnessState {
  assertDigest(expected.scopeDigest, "scope_mismatch", "effective harness scope is invalid");
  const parsed = effectiveHarnessStateSchema.safeParse(input);
  if (!parsed.success) {
    throw new EffectiveHarnessStateError("invalid_schema", "effective harness state is invalid");
  }
  if (parsed.data.scopeDigest !== expected.scopeDigest) {
    throw new EffectiveHarnessStateError(
      "scope_mismatch",
      "effective harness state belongs to a different scope",
    );
  }
  assertSerializedBound(parsed.data);
  const workflowContent = decodeCanonicalBase64(parsed.data.workflow.contentBase64);
  if (
    workflowContent.byteLength !== parsed.data.workflow.bytes ||
    sha256(workflowContent) !== parsed.data.workflow.sha256
  ) {
    throw new EffectiveHarnessStateError(
      "identity_mismatch",
      "effective harness workflow identity does not match",
    );
  }
  const packages = parsePackageClosure(parsed.data.packages);
  const source = decodeWorkflowSource(workflowContent);
  const rootPackage = parseRootPackage(parsed.data.rootPackage, packages, source);
  const compiled = compileEffectiveWorkflow(source, packages, rootPackage);
  bindEffectiveWorkflow(compiled, packages);
  const supplementalMemory = parseMemoryState(parsed.data.supplementalMemory, compiled);
  const supplementalMemoryRelationships = parseMemoryRelationshipState(
    parsed.data.supplementalMemoryRelationships,
    supplementalMemory,
  );
  const phaseRoutingProfile = parsePhaseProfile(parsed.data.phaseRoutingProfile, compiled);
  if (
    compiled.id !== parsed.data.workflowId ||
    calculateWorkflowDigest(compiled) !== parsed.data.workflow.workflowDigest
  ) {
    throw new EffectiveHarnessStateError(
      "identity_mismatch",
      "effective harness compiled workflow identity does not match",
    );
  }
  const state: EffectiveHarnessState = {
    version: parsed.data.version,
    kind: parsed.data.kind,
    scopeDigest: parsed.data.scopeDigest,
    workflowId: parsed.data.workflowId,
    workflow: parsed.data.workflow,
    ...(rootPackage === undefined ? {} : { rootPackage }),
    packages,
    ...(supplementalMemory.length === 0 ? {} : { supplementalMemory }),
    ...(supplementalMemoryRelationships === undefined ? {} : { supplementalMemoryRelationships }),
    ...(phaseRoutingProfile === undefined ? {} : { phaseRoutingProfile }),
    stateDigest: parsed.data.stateDigest,
  };
  if (calculateEffectiveHarnessStateDigest(state) !== state.stateDigest) {
    throw new EffectiveHarnessStateError(
      "identity_mismatch",
      "effective harness state digest does not match",
    );
  }
  return deepFreeze(state);
}

export function calculateEffectiveHarnessStateDigest(
  state: Omit<EffectiveHarnessState, "stateDigest"> | EffectiveHarnessState,
): string {
  return sha256(
    canonicalize({
      domain: STATE_DIGEST_DOMAIN,
      version: state.version,
      kind: state.kind,
      scopeDigest: state.scopeDigest,
      workflowId: state.workflowId,
      workflow: {
        bytes: state.workflow.bytes,
        sha256: state.workflow.sha256,
        workflowDigest: state.workflow.workflowDigest,
      },
      rootPackage: state.rootPackage ?? null,
      packages: state.packages.map(capabilityPackageIdentity),
      ...(state.supplementalMemory === undefined
        ? {}
        : {
            supplementalMemory: state.supplementalMemory.map((entry) => ({
              id: entry.id,
              target: entry.target,
              bytes: entry.bytes,
              sha256: entry.sha256,
            })),
          }),
      ...(state.supplementalMemoryRelationships === undefined
        ? {}
        : {
            supplementalMemoryRelationships: {
              relationshipSetDigest:
                state.supplementalMemoryRelationships.assessment.relationshipSetDigest,
              assessmentDigest: state.supplementalMemoryRelationships.assessment.digest,
            },
          }),
      ...(state.phaseRoutingProfile === undefined
        ? {}
        : { phaseRoutingProfileDigest: state.phaseRoutingProfile.profileDigest }),
    }),
  );
}

export function effectiveHarnessWorkflowSource(state: EffectiveHarnessState): string {
  return decodeWorkflowSource(decodeCanonicalBase64(state.workflow.contentBase64));
}

export function compileEffectiveHarnessState(state: EffectiveHarnessState) {
  const parsed = parseEffectiveHarnessState(state, { scopeDigest: state.scopeDigest });
  const compiled = compileEffectiveWorkflow(
    effectiveHarnessWorkflowSource(parsed),
    parsed.packages,
    parsed.rootPackage,
  );
  bindEffectiveWorkflow(compiled, parsed.packages);
  return compiled;
}

export function createEffectiveHarnessHeadIdentity(
  input: CreateEffectiveHarnessHeadIdentityInput,
): EffectiveHarnessHeadIdentity {
  const content = {
    version: 1 as const,
    kind: "effective-harness-head" as const,
    ...input,
  };
  return parseEffectiveHarnessHeadIdentity(
    { ...content, headDigest: calculateEffectiveHarnessHeadDigest(content) },
    { scopeDigest: input.scopeDigest },
  );
}

export function parseEffectiveHarnessHeadIdentity(
  input: unknown,
  expected: EffectiveHarnessScope,
): EffectiveHarnessHeadIdentity {
  assertDigest(expected.scopeDigest, "scope_mismatch", "effective harness scope is invalid");
  const parsed = effectiveHarnessHeadIdentitySchema.safeParse(input);
  if (!parsed.success) {
    throw new EffectiveHarnessStateError(
      "invalid_schema",
      "effective harness head identity is invalid",
    );
  }
  if (parsed.data.scopeDigest !== expected.scopeDigest) {
    throw new EffectiveHarnessStateError(
      "scope_mismatch",
      "effective harness head belongs to a different scope",
    );
  }
  if (calculateEffectiveHarnessHeadDigest(parsed.data) !== parsed.data.headDigest) {
    throw new EffectiveHarnessStateError(
      "identity_mismatch",
      "effective harness head digest does not match",
    );
  }
  return deepFreeze(parsed.data);
}

export function calculateEffectiveHarnessHeadDigest(
  head: Omit<EffectiveHarnessHeadIdentity, "headDigest"> | EffectiveHarnessHeadIdentity,
): string {
  return sha256(
    canonicalize({
      domain: HEAD_DIGEST_DOMAIN,
      version: head.version,
      kind: head.kind,
      scopeDigest: head.scopeDigest,
      workflowId: head.workflowId,
      generation: head.generation,
      activationDigest: head.activationDigest,
      transitionDigest: head.transitionDigest,
      stateDigest: head.stateDigest,
    }),
  );
}

function parsePackageClosure(input: readonly unknown[]): readonly CapabilityPackageSnapshot[] {
  if (input.some((item) => packageKind(item) === "policy-package")) {
    throw new EffectiveHarnessStateError(
      "unexpected_policy",
      "effective harness state cannot contain policy packages",
    );
  }
  if (input.length === 0) {
    return Object.freeze([]);
  }
  try {
    const packages = structuredClone(input) as CapabilityPackageSnapshot[];
    return validateCapabilitySnapshot({
      version: 1,
      packages,
      digest: calculateCapabilitySnapshotDigest(packages),
    }).packages;
  } catch {
    throw new EffectiveHarnessStateError(
      "invalid_closure",
      "effective harness package closure is invalid",
    );
  }
}

function parseMemoryInput(
  input: readonly SupplementalMemoryEntryInput[] | undefined,
  workflow: ReturnType<typeof compileWorkflowText>,
): readonly SupplementalMemoryEntry[] {
  if (input === undefined || input.length === 0) return Object.freeze([]);
  try {
    return createSupplementalMemoryEntries(input, workflow);
  } catch (error) {
    throw mapSupplementalMemoryError(error);
  }
}

function parseMemoryState(
  input: readonly unknown[] | undefined,
  workflow: ReturnType<typeof compileWorkflowText>,
): readonly SupplementalMemoryEntry[] {
  if (input === undefined || input.length === 0) return Object.freeze([]);
  try {
    return parseSupplementalMemoryEntries(input, workflow);
  } catch (error) {
    throw mapSupplementalMemoryError(error);
  }
}

function parseMemoryRelationshipInput(
  input: readonly SupplementalMemoryRelationshipInput[] | undefined,
  entries: readonly SupplementalMemoryEntry[],
): SupplementalMemoryRelationshipState | undefined {
  if (input === undefined || input.length === 0) return undefined;
  try {
    return createSupplementalMemoryRelationshipState(input, entries);
  } catch (error) {
    throw mapSupplementalMemoryRelationshipError(error);
  }
}

function parseMemoryRelationshipState(
  input: unknown,
  entries: readonly SupplementalMemoryEntry[],
): SupplementalMemoryRelationshipState | undefined {
  if (input === undefined) return undefined;
  try {
    return parseSupplementalMemoryRelationshipState(input, entries);
  } catch (error) {
    throw mapSupplementalMemoryRelationshipError(error);
  }
}

function parsePhaseProfile(
  input: unknown,
  workflow: ReturnType<typeof compileWorkflowText>,
): PhaseRoutingProfile | undefined {
  if (input === undefined) return undefined;
  try {
    return validatePhaseRoutingProfileForWorkflow(parsePhaseRoutingProfile(input), workflow);
  } catch {
    throw new EffectiveHarnessStateError(
      "identity_mismatch",
      "effective harness phase-routing profile does not match its workflow",
    );
  }
}

function mapSupplementalMemoryRelationshipError(error: unknown): EffectiveHarnessStateError {
  if (error instanceof SupplementalMemoryRelationshipError) {
    const code =
      error.code === "limit_exceeded"
        ? "limit_exceeded"
        : error.code === "identity_mismatch" || error.code === "stale_endpoint"
          ? "identity_mismatch"
          : "invalid_schema";
    return new EffectiveHarnessStateError(
      code,
      "effective harness supplemental memory relationships are invalid",
    );
  }
  return new EffectiveHarnessStateError(
    "invalid_schema",
    "effective harness supplemental memory relationships are invalid",
  );
}

function mapSupplementalMemoryError(error: unknown): EffectiveHarnessStateError {
  if (error instanceof SupplementalMemoryError) {
    const code =
      error.code === "limit_exceeded"
        ? "limit_exceeded"
        : error.code === "invalid_target"
          ? "invalid_workflow"
          : error.code === "identity_mismatch"
            ? "identity_mismatch"
            : "invalid_schema";
    return new EffectiveHarnessStateError(code, "effective harness supplemental memory is invalid");
  }
  return new EffectiveHarnessStateError(
    "invalid_schema",
    "effective harness supplemental memory is invalid",
  );
}

function compileEffectiveWorkflow(
  source: string,
  packages: readonly CapabilityPackageSnapshot[],
  rootPackage: CompiledWorkflowPackageReference | undefined,
) {
  const workflowPackages = packages.filter(
    (item): item is WorkflowPackageSnapshot => item.kind === "workflow-package",
  );
  const byIdentity = new Map(
    workflowPackages.map((item) => [
      workflowPackageIdentityKey(item),
      resolveWorkflowPackage(item),
    ]),
  );
  try {
    return compileWorkflowText(source, "effective harness workflow", {
      packageResolver: {
        resolve(reference: WorkflowPackageReference): ResolvedWorkflowPackage {
          const resolved = byIdentity.get(workflowPackageIdentityKey(reference));
          if (resolved === undefined) {
            throw new Error("effective harness workflow package is missing");
          }
          return resolved;
        },
      },
      ...(rootPackage === undefined ? {} : { sourcePackage: rootPackage }),
    });
  } catch {
    throw new EffectiveHarnessStateError(
      "invalid_workflow",
      "effective harness workflow is invalid",
    );
  }
}

function parseRootPackage(
  input: unknown,
  packages: readonly CapabilityPackageSnapshot[],
  source: string,
): CompiledWorkflowPackageReference | undefined {
  if (input === undefined) {
    return undefined;
  }
  const parsed = rootPackageSchema.safeParse(input);
  if (!parsed.success) {
    throw new EffectiveHarnessStateError(
      "invalid_closure",
      "effective harness root package identity is invalid",
    );
  }
  const selected = packages.find(
    (item): item is WorkflowPackageSnapshot =>
      item.kind === "workflow-package" &&
      item.name === parsed.data.name &&
      item.version === parsed.data.version &&
      item.digest === parsed.data.digest,
  );
  if (selected === undefined || workflowPackageSource(selected) !== source) {
    throw new EffectiveHarnessStateError(
      "invalid_closure",
      "effective harness root package does not match its source",
    );
  }
  return deepFreeze(parsed.data);
}

function bindEffectiveWorkflow(
  workflow: ReturnType<typeof compileWorkflowText>,
  packages: readonly CapabilityPackageSnapshot[],
): void {
  const snapshot: CapabilitySnapshot | undefined =
    packages.length === 0
      ? undefined
      : {
          version: 1,
          packages,
          digest: calculateCapabilitySnapshotDigest(packages),
        };
  try {
    bindWorkflowCapabilities(workflow, snapshot);
  } catch {
    throw new EffectiveHarnessStateError(
      "invalid_closure",
      "effective harness package closure does not match its workflow",
    );
  }
}

function resolveWorkflowPackage(snapshot: WorkflowPackageSnapshot): ResolvedWorkflowPackage {
  return Object.freeze({
    name: snapshot.name,
    version: snapshot.version,
    digest: snapshot.digest,
    source: workflowPackageSource(snapshot),
  });
}

function capabilityPackageIdentity(value: CapabilityPackageSnapshot) {
  return value.kind === "agent-skill"
    ? { kind: value.kind, name: value.name, digest: value.digest }
    : {
        kind: value.kind,
        name: value.name,
        version: value.version,
        digest: value.digest,
      };
}

function packageKind(value: unknown): unknown {
  return typeof value === "object" && value !== null && "kind" in value
    ? (value as { readonly kind?: unknown }).kind
    : undefined;
}

function assertSerializedBound(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_EFFECTIVE_HARNESS_STATE_BYTES) {
    throw new EffectiveHarnessStateError(
      "limit_exceeded",
      `effective harness state exceeds ${MAX_EFFECTIVE_HARNESS_STATE_BYTES} UTF-8 bytes`,
    );
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new EffectiveHarnessStateError(
      "identity_mismatch",
      "effective harness content is not canonical base64",
    );
  }
  return content;
}

function decodeWorkflowSource(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new EffectiveHarnessStateError(
      "invalid_workflow",
      "effective harness workflow is not valid UTF-8",
    );
  }
}

function assertDigest(value: string, code: EffectiveHarnessStateErrorCode, message: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new EffectiveHarnessStateError(code, message);
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
  throw new EffectiveHarnessStateError(
    "invalid_schema",
    "effective harness value is not canonical JSON",
  );
}

function sha256(value: string | Uint8Array): string {
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
