import { describe, expect, it } from "vitest";

import {
  assertCapabilityBundleReplacement,
  CapabilityBundleReplacementError,
} from "../../../src/domain/capability/capability-bundle-replacement.js";
import { createCapabilityBundleSource } from "../../../src/domain/capability/capability-bundles.js";

describe("capability bundle replacement", () => {
  it.each([
    ["1.0.0", "1.0.1"],
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-1", "1.0.0-alpha"],
    ["999999999999999999999999999999.0.0", "1000000000000000000000000000000.0.0"],
  ])("accepts the strictly newer version %s -> %s", (currentVersion, candidateVersion) => {
    expect(() =>
      assertCapabilityBundleReplacement(
        verifierBundle(currentVersion),
        verifierBundle(candidateVersion, { prompt: "Review updated evidence." }),
      ),
    ).not.toThrow();
  });

  it.each([
    ["1.0.0", "1.0.0"],
    ["1.0.0+old", "1.0.0+new"],
    ["1.0.1", "1.0.0"],
    ["1.0.0", "1.0.0-rc.1"],
  ])("rejects a non-increasing version %s -> %s", (currentVersion, candidateVersion) => {
    expect(() =>
      assertCapabilityBundleReplacement(
        verifierBundle(currentVersion),
        verifierBundle(candidateVersion),
      ),
    ).toThrow(new CapabilityBundleReplacementError("validate bundle version"));
  });

  it.each([
    ["bundle name", { bundleName: "private-suite" }],
    ["package name", { packageName: "private-review" }],
    ["package version", { packageVersion: "2.0.0" }],
  ] as const)("rejects changed %s authority", (_label, mutation) => {
    expect(() =>
      assertCapabilityBundleReplacement(verifierBundle("1.0.0"), verifierBundle("1.0.1", mutation)),
    ).toThrow(new CapabilityBundleReplacementError("validate capability surface"));
  });

  it("rejects a changed Agent Skill requested-tool surface", () => {
    expect(() =>
      assertCapabilityBundleReplacement(
        agentSkillBundle("1.0.0", "Read"),
        agentSkillBundle("1.0.1", "Read Write"),
      ),
    ).toThrow(new CapabilityBundleReplacementError("validate capability surface"));
  });

  it("rejects a changed provider-facing packaged tool name", () => {
    expect(() =>
      assertCapabilityBundleReplacement(
        toolBundle("1.0.0", "project_git_status"),
        toolBundle("1.0.1", "project_git_diff"),
      ),
    ).toThrow(new CapabilityBundleReplacementError("validate capability surface"));
  });

  it("rejects replacement when either generation contains a policy package", () => {
    expect(() =>
      assertCapabilityBundleReplacement(policyBundle("1.0.0"), policyBundle("1.0.1")),
    ).toThrow(new CapabilityBundleReplacementError("reject policy packages"));
  });
});

function verifierBundle(
  version: string,
  options: {
    readonly bundleName?: string;
    readonly packageName?: string;
    readonly packageVersion?: string;
    readonly prompt?: string;
  } = {},
) {
  const bundleName = options.bundleName ?? "review-suite";
  const packageName = options.packageName ?? "evidence-review";
  const packageVersion = options.packageVersion ?? "1.0.0";
  return createCapabilityBundleSource({
    name: bundleName,
    version,
    description: "Review capabilities.",
    packages: [
      {
        kind: "verifier-package",
        manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: ${packageName}
  version: ${packageVersion}
  description: Review declared evidence.
spec:
  kind: model
  prompt: ${options.prompt ?? "Review evidence."}
`),
      },
    ],
  }).bundle;
}

function agentSkillBundle(version: string, requestedTools: string) {
  return createCapabilityBundleSource({
    name: "review-suite",
    version,
    description: "Review capabilities.",
    packages: [
      {
        kind: "agent-skill",
        files: [
          {
            path: "SKILL.md",
            content: Buffer.from(`---
name: evidence-review
description: Review declared evidence.
allowed-tools: ${requestedTools}
---
Review evidence.
`),
          },
        ],
      },
    ],
  }).bundle;
}

function toolBundle(version: string, toolName: string) {
  return createCapabilityBundleSource({
    name: "review-suite",
    version,
    description: "Review capabilities.",
    packages: [
      {
        kind: "tool-package",
        manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: git-status
  version: 1.0.0
  description: Show a bounded project status.
spec:
  tool:
    name: ${toolName}
    description: Return the current project status.
    inputs: []
  driver:
    kind: command
    version: v1
    profile: git-status-v1
    executable: /usr/bin/git
    args: [--no-optional-locks, -c, core.fsmonitor=false, -c, core.untrackedCache=false, status, --short, --untracked-files=normal, --ignore-submodules=all]
    timeoutMs: 10000
  permissions: [process.execute]
`),
      },
    ],
  }).bundle;
}

function policyBundle(version: string) {
  return createCapabilityBundleSource({
    name: "review-suite",
    version,
    description: "Review capabilities.",
    packages: [
      {
        kind: "policy-package",
        manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: restricted-review
  version: 1.0.0
  description: Restrict review execution.
spec:
  tools:
    allowed: [read]
  commands:
    requireApproval: true
`),
      },
    ],
  }).bundle;
}
