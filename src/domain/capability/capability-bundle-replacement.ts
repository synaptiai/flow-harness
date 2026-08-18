import type { CapabilityBundle, CapabilityBundlePackage } from "./capability-bundles.js";

export type CapabilityBundleReplacementStage =
  | "validate bundle version"
  | "validate capability surface"
  | "reject policy packages";

export class CapabilityBundleReplacementError extends Error {
  override readonly name = "CapabilityBundleReplacementError";
  readonly code = "capability_bundle_replacement_failed" as const;

  constructor(readonly stage: CapabilityBundleReplacementStage) {
    super(`Capability bundle replacement failed during ${stage}`);
  }
}

export function assertCapabilityBundleReplacement(
  current: CapabilityBundle,
  candidate: CapabilityBundle,
): void {
  if (
    current.packages.some((item) => item.kind === "policy-package") ||
    candidate.packages.some((item) => item.kind === "policy-package")
  ) {
    throw new CapabilityBundleReplacementError("reject policy packages");
  }
  if (compareExactSemanticVersions(candidate.version, current.version) <= 0) {
    throw new CapabilityBundleReplacementError("validate bundle version");
  }
  if (
    candidate.name !== current.name ||
    candidate.packages.length !== current.packages.length ||
    candidate.packages.some(
      (item, index) => replacementIdentity(item) !== replacementIdentity(current.packages[index]),
    )
  ) {
    throw new CapabilityBundleReplacementError("validate capability surface");
  }
}

function replacementIdentity(item: CapabilityBundlePackage | undefined): string | undefined {
  if (item === undefined) {
    return undefined;
  }
  if (item.kind === "agent-skill") {
    return `${item.kind}\0${item.name}\0${JSON.stringify(item.requestedTools)}`;
  }
  if (item.kind === "tool-package") {
    return `${item.kind}\0${item.name}\0${item.version}\0${item.toolName}`;
  }
  return `${item.kind}\0${item.name}\0${item.version}`;
}

function compareExactSemanticVersions(left: string, right: string): number {
  const leftVersion = semanticVersionParts(left);
  const rightVersion = semanticVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifier(
      leftVersion.core[index] ?? "0",
      rightVersion.core[index] ?? "0",
    );
    if (comparison !== 0) {
      return comparison;
    }
  }
  if (leftVersion.prerelease === undefined || rightVersion.prerelease === undefined) {
    return leftVersion.prerelease === rightVersion.prerelease
      ? 0
      : leftVersion.prerelease === undefined
        ? 1
        : -1;
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function semanticVersionParts(value: string): {
  readonly core: readonly string[];
  readonly prerelease?: readonly string[];
} {
  const withoutBuild = value.split("+", 1)[0] ?? "";
  const separator = withoutBuild.indexOf("-");
  if (separator === -1) {
    return { core: withoutBuild.split(".") };
  }
  return {
    core: withoutBuild.slice(0, separator).split("."),
    prerelease: withoutBuild.slice(separator + 1).split("."),
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return compareNumericIdentifier(left, right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return compareStrings(left, right);
}

function compareNumericIdentifier(left: string, right: string): number {
  return left.length === right.length
    ? compareStrings(left, right)
    : left.length < right.length
      ? -1
      : 1;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
