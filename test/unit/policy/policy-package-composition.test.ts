import { describe, expect, it } from "vitest";

import type {
  PolicyPackageDefinition,
  PolicyPackageSnapshot,
} from "../../../src/domain/capability/policy-packages.js";
import { createPolicyPackageSnapshot } from "../../../src/domain/capability/policy-packages.js";
import {
  composePolicyPackageDefinitions,
  composePolicyPackages,
  PolicyPackageCompositionError,
} from "../../../src/domain/policy/policy-package-composition.js";

describe("policy package composition", () => {
  it("composes constraints deterministically and can only narrow", () => {
    const broad = policy("broad", {
      models: {
        allowed: [
          { provider: "anthropic", model: "claude-sonnet-4-20250514" },
          { provider: "openai", model: "gpt-5.4" },
        ],
      },
      tools: {
        allowed: ["edit", "read"],
        allowedPermissions: ["filesystem.read", "filesystem.write"],
      },
      sandbox: { allowedProfiles: ["container", "native"] },
      budget: { maxModelTokens: 20_000, maxExecutionMs: 60_000 },
    });
    const narrow = policy("narrow", {
      models: { allowed: [{ provider: "openai", model: "gpt-5.4" }] },
      tools: { allowed: ["read"], allowedPermissions: ["filesystem.read"] },
      commands: { requireApproval: true },
      sandbox: { allowedProfiles: ["container"] },
      budget: { maxModelTokens: 10_000, maxArtifactBytes: 1_024 },
    });

    const forward = composePolicyPackages([broad, narrow]);
    const reverse = composePolicyPackages([narrow, broad]);

    expect(forward).toBeDefined();
    expect(reverse).toBeDefined();
    if (forward === undefined || reverse === undefined) {
      throw new Error("non-empty policy package inputs must compose");
    }

    expect(forward).toEqual(reverse);
    expect(forward.packages.map(({ name }) => name)).toEqual(["broad", "narrow"]);
    expect(forward.constraints).toEqual({
      models: { allowed: [{ provider: "openai", model: "gpt-5.4" }] },
      tools: { allowed: ["read"], allowedPermissions: ["filesystem.read"] },
      commands: { requireApproval: true },
      sandbox: { allowedProfiles: ["container"] },
      budget: {
        maxModelTokens: 10_000,
        maxExecutionMs: 60_000,
        maxArtifactBytes: 1_024,
      },
    });
    expect(forward.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(forward.constraints.tools?.allowed)).toBe(true);
  });

  it("rejects duplicate identities and contradictory allowed sets", () => {
    const first = policy("one", {
      models: { allowed: [{ provider: "openai", model: "gpt-5.4" }] },
    });
    const contradictory = policy("two", {
      models: { allowed: [{ provider: "anthropic", model: "claude-sonnet-4-20250514" }] },
    });

    expect(() => composePolicyPackages([first, first])).toThrow(PolicyPackageCompositionError);
    expect(() => composePolicyPackages([first, contradictory])).toThrowError(
      /models\.allowed.*no admissible value/i,
    );
  });

  it("is associative and idempotent at the narrowing-definition layer", () => {
    const first: PolicyPackageDefinition = {
      tools: { allowed: ["edit", "read"] },
      budget: { maxNodeStarts: 12 },
    };
    const second: PolicyPackageDefinition = {
      tools: { allowed: ["read"] },
      commands: { requireApproval: true },
    };
    const third: PolicyPackageDefinition = {
      budget: { maxNodeStarts: 8, maxExecutionMs: 60_000 },
    };

    expect(composePolicyPackageDefinitions(first, first)).toEqual(first);
    expect(
      composePolicyPackageDefinitions(composePolicyPackageDefinitions(first, second), third),
    ).toEqual(
      composePolicyPackageDefinitions(first, composePolicyPackageDefinitions(second, third)),
    );
    expect(composePolicyPackages([])).toBeUndefined();
  });
});

function policy(name: string, definition: PolicyPackageDefinition): PolicyPackageSnapshot {
  return createPolicyPackageSnapshot({
    kind: "policy-package",
    trust: "project-explicit",
    provenance: `.flow/policies/${name}`,
    manifest: {
      content: Buffer.from(
        JSON.stringify({
          apiVersion: "flow.synapti.ai/v1alpha1",
          kind: "PolicyPackage",
          metadata: { name, version: "1.0.0", description: `${name} policy` },
          spec: definition,
        }),
      ),
    },
  });
}
