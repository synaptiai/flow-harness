import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  calculatePolicyPackageDigest,
  createPolicyPackageSnapshot,
  parsePolicyPackageManifest,
  validatePolicyPackageSnapshot,
} from "../../../src/domain/capability/policy-packages.js";

describe("policy packages", () => {
  it("parses one strict inert narrowing manifest", () => {
    const parsed = parsePolicyPackageManifest(manifest(), "policy package fixture");

    expect(parsed).toEqual({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "PolicyPackage",
      metadata: {
        name: "restricted-review",
        version: "1.2.3",
        description: "Restrict review workflows to the approved execution envelope.",
        license: "Apache-2.0",
        compatibility: "flow.synapti.ai/v1alpha1",
      },
      spec: {
        models: {
          allowed: [
            { provider: "anthropic", model: "claude-sonnet-4-20250514" },
            { provider: "openai", model: "gpt-5.4" },
          ],
        },
        tools: {
          allowed: ["edit", "project_report", "read"],
          allowedPermissions: ["filesystem.read", "filesystem.write", "process.execute"],
        },
        commands: { requireApproval: true },
        sandbox: { allowedProfiles: ["container"] },
        budget: {
          maxNodeStarts: 8,
          maxModelTokens: 32_000,
          maxCostUsdMicros: 2_000_000,
          maxExecutionMs: 120_000,
          maxArtifactBytes: 4_194_304,
        },
      },
    });
    expect(Object.isFrozen(parsed.spec.models?.allowed)).toBe(true);
  });

  it("creates and validates an immutable byte-exact policy snapshot", () => {
    const source = manifest();
    const snapshot = createPolicyPackageSnapshot({
      kind: "policy-package",
      trust: "project-explicit",
      provenance: ".flow/policies/restricted-review",
      manifest: { content: source },
    });

    expect(snapshot).toMatchObject({
      kind: "policy-package",
      apiVersion: "flow.synapti.ai/v1alpha1",
      name: "restricted-review",
      version: "1.2.3",
      trust: "project-explicit",
      provenance: ".flow/policies/restricted-review",
      definition: parsePolicyPackageManifest(source).spec,
      manifest: {
        bytes: source.byteLength,
        sha256: createHash("sha256").update(source).digest("hex"),
        contentBase64: source.toString("base64"),
      },
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(snapshot.digest).toBe(calculatePolicyPackageDigest(snapshot));
    expect(validatePolicyPackageSnapshot(structuredClone(snapshot))).toEqual(snapshot);
    expect(Object.isFrozen(snapshot.definition.tools?.allowed)).toBe(true);
  });

  it("participates in the shared immutable capability snapshot", () => {
    const snapshot = createCapabilitySnapshot(
      [],
      [],
      [],
      [],
      [
        {
          kind: "policy-package",
          trust: "project-explicit",
          provenance: ".flow/policies/restricted-review",
          manifest: { content: manifest() },
        },
      ],
    );

    expect(snapshot.packages).toEqual([
      expect.objectContaining({
        kind: "policy-package",
        name: "restricted-review",
        version: "1.2.3",
      }),
    ]);
    expect(validateCapabilitySnapshot(structuredClone(snapshot))).toEqual(snapshot);
  });

  it.each([
    ["mutable version", manifest().toString().replace("version: 1.2.3", "version: latest")],
    ["unknown field", `${manifest().toString()}unknown: true\n`],
    [
      "executable field",
      manifest().toString().replace("spec:\n", "spec:\n  executable: /bin/private\n"),
    ],
    [
      "duplicate tool",
      manifest()
        .toString()
        .replace("allowed: [edit, project_report, read]", "allowed: [edit, read, read]"),
    ],
    [
      "unsorted model",
      manifest()
        .toString()
        .replace(
          "      - { provider: anthropic, model: claude-sonnet-4-20250514 }\n      - { provider: openai, model: gpt-5.4 }",
          "      - { provider: openai, model: gpt-5.4 }\n      - { provider: anthropic, model: claude-sonnet-4-20250514 }",
        ),
    ],
    [
      "approval disabling",
      manifest().toString().replace("requireApproval: true", "requireApproval: false"),
    ],
    [
      "unsupported permission",
      manifest()
        .toString()
        .replace("filesystem.write, process.execute", "filesystem.write, host.admin"),
    ],
    [
      "unsupported sandbox",
      manifest().toString().replace("allowedProfiles: [container]", "allowedProfiles: [remote]"),
    ],
  ])("rejects an unsafe or ambiguous manifest: %s", (_case, source) => {
    expect(() => parsePolicyPackageManifest(Buffer.from(source))).toThrow();
  });

  it("rejects aliases, invalid UTF-8, empty input, and the byte above the manifest bound", () => {
    expect(() =>
      parsePolicyPackageManifest(
        Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata: &metadata
  name: restricted-review
  version: 1.2.3
  description: Policy fixture.
spec:
  models: *metadata
`),
      ),
    ).toThrow(/alias/i);
    expect(() => parsePolicyPackageManifest(Uint8Array.from([0xff]))).toThrow(/utf-8/i);
    expect(() => parsePolicyPackageManifest(Buffer.alloc(0))).toThrow(/1-65536 bytes/i);
    expect(() => parsePolicyPackageManifest(Buffer.alloc(65_537, 0x20))).toThrow(/1-65536 bytes/i);
  });

  it("rejects a snapshot when any byte-exact evidence leaf changes", () => {
    const snapshot = createPolicyPackageSnapshot({
      kind: "policy-package",
      trust: "project-explicit",
      provenance: ".flow/policies/restricted-review",
      manifest: { content: manifest() },
    });

    for (const changed of [
      { ...structuredClone(snapshot), digest: "f".repeat(64) },
      {
        ...structuredClone(snapshot),
        manifest: { ...snapshot.manifest, sha256: "f".repeat(64) },
      },
      { ...structuredClone(snapshot), provenance: ".flow/policies/substituted" },
      {
        ...structuredClone(snapshot),
        definition: { ...snapshot.definition, commands: undefined },
      },
    ]) {
      expect(() => validatePolicyPackageSnapshot(changed)).toThrow();
    }
  });
});

function manifest(): Buffer {
  return Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: restricted-review
  version: 1.2.3
  description: Restrict review workflows to the approved execution envelope.
  license: Apache-2.0
  compatibility: flow.synapti.ai/v1alpha1
spec:
  models:
    allowed:
      - { provider: anthropic, model: claude-sonnet-4-20250514 }
      - { provider: openai, model: gpt-5.4 }
  tools:
    allowed: [edit, project_report, read]
    allowedPermissions: [filesystem.read, filesystem.write, process.execute]
  commands:
    requireApproval: true
  sandbox:
    allowedProfiles: [container]
  budget:
    maxNodeStarts: 8
    maxModelTokens: 32000
    maxCostUsdMicros: 2000000
    maxExecutionMs: 120000
    maxArtifactBytes: 4194304
`);
}
