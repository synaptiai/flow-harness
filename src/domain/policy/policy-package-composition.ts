import { createHash } from "node:crypto";

import {
  type PolicyPackageDefinition,
  type PolicyPackageSnapshot,
  policyPackageIdentityKey,
  validatePolicyPackageSnapshot,
} from "../capability/policy-packages.js";

export interface EffectivePolicyPackageIdentity {
  readonly kind: "policy-package";
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly trust: "project-explicit";
  readonly provenance: string;
}

export interface EffectivePolicyPackages {
  readonly version: 1;
  readonly packages: readonly EffectivePolicyPackageIdentity[];
  readonly constraints: PolicyPackageDefinition;
  readonly digest: string;
}

export class PolicyPackageCompositionError extends Error {
  override readonly name = "PolicyPackageCompositionError";
}

export function composePolicyPackages(
  inputs: readonly PolicyPackageSnapshot[],
): EffectivePolicyPackages | undefined {
  if (inputs.length === 0) {
    return undefined;
  }
  const packages = inputs
    .map((input) => validatePolicyPackageSnapshot(input))
    .sort((left, right) =>
      compareStrings(policyPackageIdentityKey(left), policyPackageIdentityKey(right)),
    );
  assertUniquePackageNames(packages);
  const constraints = packages
    .map((item) => item.definition)
    .reduce<PolicyPackageDefinition>(
      (effective, definition) => composePolicyPackageDefinitions(effective, definition),
      {},
    );
  const identities = Object.freeze(
    packages.map((item) =>
      Object.freeze({
        kind: item.kind,
        name: item.name,
        version: item.version,
        digest: item.digest,
        trust: item.trust,
        provenance: item.provenance,
      }),
    ),
  );
  const candidate = {
    version: 1 as const,
    packages: identities,
    constraints,
  };
  return deepFreeze({ ...candidate, digest: sha256(JSON.stringify(candidate)) });
}

export function composePolicyPackageDefinitions(
  left: PolicyPackageDefinition,
  right: PolicyPackageDefinition,
): PolicyPackageDefinition {
  const models = intersectOptionalDomain(
    left.models?.allowed,
    right.models?.allowed,
    (item) => `${item.provider}\0${item.model}`,
    "models.allowed",
  );
  const tools = intersectOptionalDomain(
    left.tools?.allowed,
    right.tools?.allowed,
    (item) => item,
    "tools.allowed",
  );
  const permissions = intersectOptionalDomain(
    left.tools?.allowedPermissions,
    right.tools?.allowedPermissions,
    (item) => item,
    "tools.allowedPermissions",
  );
  const sandbox = intersectOptionalDomain(
    left.sandbox?.allowedProfiles,
    right.sandbox?.allowedProfiles,
    (item) => item,
    "sandbox.allowedProfiles",
  );
  const budget = composeBudget(left.budget, right.budget);

  return deepFreeze({
    ...(models === undefined ? {} : { models: { allowed: models } }),
    ...(tools === undefined && permissions === undefined
      ? {}
      : {
          tools: {
            ...(tools === undefined ? {} : { allowed: tools }),
            ...(permissions === undefined ? {} : { allowedPermissions: permissions }),
          },
        }),
    ...(left.commands === undefined && right.commands === undefined
      ? {}
      : { commands: { requireApproval: true as const } }),
    ...(sandbox === undefined ? {} : { sandbox: { allowedProfiles: sandbox } }),
    ...(budget === undefined ? {} : { budget }),
  });
}

function assertUniquePackageNames(packages: readonly PolicyPackageSnapshot[]): void {
  for (let index = 1; index < packages.length; index += 1) {
    const previous = packages[index - 1];
    const current = packages[index];
    if (previous?.name === current?.name) {
      throw new PolicyPackageCompositionError(
        `duplicate policy package name "${current?.name ?? "<unknown>"}"`,
      );
    }
  }
}

function intersectOptionalDomain<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
  key: (value: T) => string,
  field: string,
): T[] | undefined {
  if (left === undefined) {
    return right === undefined ? undefined : [...right];
  }
  if (right === undefined) {
    return [...left];
  }
  const rightKeys = new Set(right.map(key));
  const intersection = left.filter((item) => rightKeys.has(key(item)));
  if (intersection.length === 0) {
    throw new PolicyPackageCompositionError(`${field} has no admissible value after composition`);
  }
  return intersection;
}

function composeBudget(
  left: PolicyPackageDefinition["budget"],
  right: PolicyPackageDefinition["budget"],
): PolicyPackageDefinition["budget"] {
  if (left === undefined) {
    return right === undefined ? undefined : Object.freeze({ ...right });
  }
  if (right === undefined) {
    return Object.freeze({ ...left });
  }
  const maxNodeStarts = minimum(left.maxNodeStarts, right.maxNodeStarts);
  const maxModelTokens = minimum(left.maxModelTokens, right.maxModelTokens);
  const maxCostUsdMicros = minimum(left.maxCostUsdMicros, right.maxCostUsdMicros);
  const maxExecutionMs = minimum(left.maxExecutionMs, right.maxExecutionMs);
  const maxArtifactBytes = minimum(left.maxArtifactBytes, right.maxArtifactBytes);
  return Object.freeze({
    ...(maxNodeStarts === undefined ? {} : { maxNodeStarts }),
    ...(maxModelTokens === undefined ? {} : { maxModelTokens }),
    ...(maxCostUsdMicros === undefined ? {} : { maxCostUsdMicros }),
    ...(maxExecutionMs === undefined ? {} : { maxExecutionMs }),
    ...(maxArtifactBytes === undefined ? {} : { maxArtifactBytes }),
  });
}

function minimum(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
