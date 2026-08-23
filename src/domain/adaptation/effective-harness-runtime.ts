import { createHash } from "node:crypto";

import { z } from "zod";
import { MAX_AGENT_SKILL_PACKAGES } from "../capability/agent-skill-contract.js";
import type { CapabilityPackageSnapshot } from "../capability/agent-skills.js";
import {
  type EffectiveHarnessHeadIdentity,
  type EffectiveHarnessState,
  MAX_EFFECTIVE_HARNESS_STATE_BYTES,
  parseEffectiveHarnessHeadIdentity,
  parseEffectiveHarnessState,
} from "./effective-harness-state.js";
import {
  MAX_SUPPLEMENTAL_MEMORY_ENTRIES,
  supplementalMemoryEntrySchema,
} from "./supplemental-memory.js";
import { supplementalMemoryRelationshipStateSchema } from "./supplemental-memory-relationships.js";

const RUNTIME_DIGEST_DOMAIN = "flow-effective-harness-runtime-v1";

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

const effectiveHarnessRuntimeSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("effective-harness-runtime"),
    scopeDigest: sha256Schema,
    workflowId: identifierSchema,
    head: z.unknown(),
    workflow: z
      .object({
        bytes: z.number().int().positive(),
        sha256: sha256Schema,
        workflowDigest: sha256Schema,
        contentBase64: z.string(),
      })
      .strict(),
    rootPackage: z
      .object({
        name: identifierSchema,
        version: semanticVersionSchema,
        digest: sha256Schema,
      })
      .strict()
      .optional(),
    packageDigests: z.array(sha256Schema).max(MAX_AGENT_SKILL_PACKAGES),
    supplementalMemory: z
      .array(supplementalMemoryEntrySchema)
      .min(1)
      .max(MAX_SUPPLEMENTAL_MEMORY_ENTRIES)
      .optional(),
    supplementalMemoryRelationships: supplementalMemoryRelationshipStateSchema.optional(),
    phaseRoutingProfile: z.unknown().optional(),
    runtimeDigest: sha256Schema,
  })
  .strict();

export interface EffectiveHarnessRuntimeSnapshot {
  readonly version: 1;
  readonly kind: "effective-harness-runtime";
  readonly scopeDigest: string;
  readonly workflowId: string;
  readonly head: EffectiveHarnessHeadIdentity;
  readonly workflow: EffectiveHarnessState["workflow"];
  readonly rootPackage?: EffectiveHarnessState["rootPackage"];
  readonly packageDigests: readonly string[];
  readonly supplementalMemory?: EffectiveHarnessState["supplementalMemory"];
  readonly supplementalMemoryRelationships?: EffectiveHarnessState["supplementalMemoryRelationships"];
  readonly phaseRoutingProfile?: EffectiveHarnessState["phaseRoutingProfile"];
  readonly runtimeDigest: string;
}

export interface CreateEffectiveHarnessRuntimeSnapshotInput {
  readonly state: EffectiveHarnessState;
  readonly head: EffectiveHarnessHeadIdentity;
}

export type EffectiveHarnessRuntimeErrorCode =
  | "closure_mismatch"
  | "identity_mismatch"
  | "invalid_schema"
  | "limit_exceeded";

export class EffectiveHarnessRuntimeError extends Error {
  override readonly name = "EffectiveHarnessRuntimeError";

  constructor(
    readonly code: EffectiveHarnessRuntimeErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function createEffectiveHarnessRuntimeSnapshot(
  input: CreateEffectiveHarnessRuntimeSnapshotInput,
): EffectiveHarnessRuntimeSnapshot {
  const state = parseEffectiveHarnessState(input.state, {
    scopeDigest: input.state.scopeDigest,
  });
  const head = parseEffectiveHarnessHeadIdentity(input.head, {
    scopeDigest: state.scopeDigest,
  });
  if (head.workflowId !== state.workflowId || head.stateDigest !== state.stateDigest) {
    throw new EffectiveHarnessRuntimeError(
      "identity_mismatch",
      "effective harness runtime head does not select its state",
    );
  }
  const content = {
    version: 1 as const,
    kind: "effective-harness-runtime" as const,
    scopeDigest: state.scopeDigest,
    workflowId: state.workflowId,
    head,
    workflow: state.workflow,
    ...(state.rootPackage === undefined ? {} : { rootPackage: state.rootPackage }),
    packageDigests: state.packages.map((item) => item.digest),
    ...(state.supplementalMemory === undefined
      ? {}
      : { supplementalMemory: state.supplementalMemory }),
    ...(state.supplementalMemoryRelationships === undefined
      ? {}
      : { supplementalMemoryRelationships: state.supplementalMemoryRelationships }),
    ...(state.phaseRoutingProfile === undefined
      ? {}
      : { phaseRoutingProfile: state.phaseRoutingProfile }),
  };
  return parseEffectiveHarnessRuntimeSnapshot(
    { ...content, runtimeDigest: calculateEffectiveHarnessRuntimeDigest(content) },
    state.packages,
  );
}

export function parseEffectiveHarnessRuntimeSnapshot(
  input: unknown,
  packages: readonly CapabilityPackageSnapshot[],
): EffectiveHarnessRuntimeSnapshot {
  const { runtime } = parseAndRestore(input, packages);
  return runtime;
}

export function restoreEffectiveHarnessRuntimeState(
  input: unknown,
  packages: readonly CapabilityPackageSnapshot[],
): EffectiveHarnessState {
  const { state } = parseAndRestore(input, packages);
  return state;
}

export function calculateEffectiveHarnessRuntimeDigest(
  runtime: Omit<EffectiveHarnessRuntimeSnapshot, "runtimeDigest"> | EffectiveHarnessRuntimeSnapshot,
): string {
  return sha256(
    canonicalize({
      domain: RUNTIME_DIGEST_DOMAIN,
      version: runtime.version,
      kind: runtime.kind,
      scopeDigest: runtime.scopeDigest,
      workflowId: runtime.workflowId,
      headDigest: runtime.head.headDigest,
      workflow: {
        bytes: runtime.workflow.bytes,
        sha256: runtime.workflow.sha256,
        workflowDigest: runtime.workflow.workflowDigest,
      },
      rootPackage: runtime.rootPackage ?? null,
      packageDigests: runtime.packageDigests,
      ...(runtime.supplementalMemory === undefined
        ? {}
        : {
            supplementalMemory: runtime.supplementalMemory.map((entry) => ({
              id: entry.id,
              target: entry.target,
              bytes: entry.bytes,
              sha256: entry.sha256,
            })),
          }),
      ...(runtime.supplementalMemoryRelationships === undefined
        ? {}
        : {
            supplementalMemoryRelationships: {
              relationshipSetDigest:
                runtime.supplementalMemoryRelationships.assessment.relationshipSetDigest,
              assessmentDigest: runtime.supplementalMemoryRelationships.assessment.digest,
            },
          }),
      ...(runtime.phaseRoutingProfile === undefined
        ? {}
        : { phaseRoutingProfileDigest: runtime.phaseRoutingProfile.profileDigest }),
    }),
  );
}

function parseAndRestore(
  input: unknown,
  packages: readonly CapabilityPackageSnapshot[],
): { readonly runtime: EffectiveHarnessRuntimeSnapshot; readonly state: EffectiveHarnessState } {
  const parsed = effectiveHarnessRuntimeSchema.safeParse(input);
  if (!parsed.success) {
    throw new EffectiveHarnessRuntimeError(
      "invalid_schema",
      "effective harness runtime snapshot is invalid",
    );
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > MAX_EFFECTIVE_HARNESS_STATE_BYTES) {
    throw new EffectiveHarnessRuntimeError(
      "limit_exceeded",
      "effective harness runtime snapshot exceeds its serialized limit",
    );
  }
  let head: EffectiveHarnessHeadIdentity;
  try {
    head = parseEffectiveHarnessHeadIdentity(parsed.data.head, {
      scopeDigest: parsed.data.scopeDigest,
    });
  } catch {
    throw new EffectiveHarnessRuntimeError(
      "identity_mismatch",
      "effective harness runtime head identity does not match",
    );
  }
  const nonPolicyPackages = packages.filter((item) => item.kind !== "policy-package");
  if (
    nonPolicyPackages.length !== parsed.data.packageDigests.length ||
    nonPolicyPackages.some((item, index) => item.digest !== parsed.data.packageDigests[index])
  ) {
    throw new EffectiveHarnessRuntimeError(
      "closure_mismatch",
      "effective harness runtime package closure does not match",
    );
  }
  const runtime: EffectiveHarnessRuntimeSnapshot = {
    version: parsed.data.version,
    kind: parsed.data.kind,
    scopeDigest: parsed.data.scopeDigest,
    workflowId: parsed.data.workflowId,
    head,
    workflow: parsed.data.workflow,
    ...(parsed.data.rootPackage === undefined ? {} : { rootPackage: parsed.data.rootPackage }),
    packageDigests: Object.freeze([...parsed.data.packageDigests]),
    ...(parsed.data.supplementalMemory === undefined
      ? {}
      : { supplementalMemory: parsed.data.supplementalMemory }),
    ...(parsed.data.supplementalMemoryRelationships === undefined
      ? {}
      : {
          supplementalMemoryRelationships: parsed.data.supplementalMemoryRelationships,
        }),
    ...(parsed.data.phaseRoutingProfile === undefined
      ? {}
      : {
          phaseRoutingProfile: parsed.data
            .phaseRoutingProfile as EffectiveHarnessState["phaseRoutingProfile"],
        }),
    runtimeDigest: parsed.data.runtimeDigest,
  };
  if (
    runtime.workflowId !== head.workflowId ||
    runtime.scopeDigest !== head.scopeDigest ||
    calculateEffectiveHarnessRuntimeDigest(runtime) !== runtime.runtimeDigest
  ) {
    throw new EffectiveHarnessRuntimeError(
      "identity_mismatch",
      "effective harness runtime identity does not match",
    );
  }
  let state: EffectiveHarnessState;
  try {
    state = parseEffectiveHarnessState(
      {
        version: 1,
        kind: "effective-harness-state",
        scopeDigest: runtime.scopeDigest,
        workflowId: runtime.workflowId,
        workflow: runtime.workflow,
        ...(runtime.rootPackage === undefined ? {} : { rootPackage: runtime.rootPackage }),
        packages: nonPolicyPackages,
        ...(runtime.supplementalMemory === undefined
          ? {}
          : { supplementalMemory: runtime.supplementalMemory }),
        ...(runtime.supplementalMemoryRelationships === undefined
          ? {}
          : {
              supplementalMemoryRelationships: runtime.supplementalMemoryRelationships,
            }),
        ...(runtime.phaseRoutingProfile === undefined
          ? {}
          : { phaseRoutingProfile: runtime.phaseRoutingProfile }),
        stateDigest: head.stateDigest,
      },
      { scopeDigest: runtime.scopeDigest },
    );
  } catch {
    throw new EffectiveHarnessRuntimeError(
      "closure_mismatch",
      "effective harness runtime state cannot be reconstructed",
    );
  }
  return deepFreeze({ runtime, state });
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
  throw new EffectiveHarnessRuntimeError(
    "invalid_schema",
    "effective harness runtime value is not canonical JSON",
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
