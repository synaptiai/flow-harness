import { describe, expect, it } from "vitest";

import {
  calculateCapabilitySnapshotDigest,
  combineCapabilitySnapshots,
  createCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  calculateAcpAgentRuntimeSnapshotDigest,
  createAcpAgentRuntimeSnapshot,
  MAX_ACP_AGENT_ARGUMENT_BYTES,
  MAX_ACP_AGENT_ARGS,
  MAX_ACP_AGENT_ARG_BYTES,
  MAX_ACP_AGENT_EXECUTABLE_BYTES,
  MAX_ACP_AGENT_MANIFEST_BYTES,
  MAX_ACP_AGENT_MODEL_MAPPINGS,
  MAX_ACP_AGENT_PACKAGE_BYTES,
  MAX_ACP_AGENT_PACKAGE_FILES,
  validateAcpAgentRuntimeSnapshot,
} from "../../../src/domain/capability/acp-agent.js";

describe("ACP agent runtime capability", () => {
  it("creates an immutable binary identity from exact manifest and artifact evidence", () => {
    const snapshot = createAcpAgentRuntimeSnapshot(validBinaryInput());

    expect(snapshot).toMatchObject({
      version: 1,
      kind: "acp-agent",
      name: "opencode",
      protocol: "acp-v1",
      compatibilityProfile: "prompt-only-v1",
      launch: {
        kind: "binary",
        executable: {
          path: "/opt/flow/acp/opencode",
          sha256: "a".repeat(64),
          bytes: 123_456,
          device: "16777234",
          inode: "9071",
        },
        args: ["--stdio"],
      },
      modelMappings: [
        {
          provider: "openai",
          model: "gpt-5.6-codex",
          agentModel: "gpt-5.6-codex",
        },
      ],
      providerAuthorities: [
        {
          provider: "openai",
          domain: "api.openai.com",
          credentialEnv: "OPENAI_API_KEY",
        },
      ],
      containmentProfile: "acp-prompt-only-v1",
      usage: { modelTokens: "complete", costUsd: "unavailable" },
      manifest: {
        provenance: ".flow/acp-agents/opencode.json",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bytes: expect.any(Number),
        contentBase64: expect.any(String),
      },
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(validateAcpAgentRuntimeSnapshot(structuredClone(snapshot))).toEqual(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.launch)).toBe(true);
    expect(Object.isFrozen(snapshot.modelMappings)).toBe(true);
  });

  it("creates an exact Node package-closure identity", () => {
    const snapshot = createAcpAgentRuntimeSnapshot(validNodePackageInput());

    expect(snapshot.launch).toEqual({
      kind: "node-package",
      nodeExecutable: {
        path: "/opt/flow/node/bin/node",
        sha256: "b".repeat(64),
        bytes: 98_765,
        device: "16777234",
        inode: "9072",
      },
      nodeVersion: "v26.7.0",
      package: {
        root: "/opt/flow/acp/codex-acp",
        resolutionRoot: "/opt/flow/acp",
        name: "@zed-industries/codex-acp",
        version: "1.6.2",
        sha256: "c".repeat(64),
        bytes: 345_678,
        files: 42,
        device: "16777234",
        inode: "9073",
        entrypoint: {
          path: "dist/cli.js",
          sha256: "d".repeat(64),
          bytes: 4_096,
          device: "16777234",
          inode: "9074",
        },
      },
      args: ["--stdio"],
    });
  });

  it("produces a stable digest for unchanged input", () => {
    const first = createAcpAgentRuntimeSnapshot(validBinaryInput());
    const second = createAcpAgentRuntimeSnapshot(validBinaryInput());

    expect(second).toEqual(first);
    expect(calculateAcpAgentRuntimeSnapshotDigest(first)).toBe(first.digest);
  });

  it("binds ordered exact model, reasoning, and literal configuration assignments", () => {
    const snapshot = createAcpAgentRuntimeSnapshot(validBinaryInput());

    expect(snapshot.configuration).toEqual({
      assignments: [
        { configId: "mode", source: "literal", value: "ask" },
        { configId: "model", source: "model" },
        {
          configId: "thinking",
          source: "thinking",
          mappings: [
            { thinking: "off", value: "off" },
            { thinking: "medium", value: "medium" },
            { thinking: "high", value: "high" },
          ],
        },
      ],
    });
  });

  it("requires one explicit model assignment before one explicit reasoning assignment", () => {
    for (const configuration of [
      null,
      { assignments: [{ configId: "thinking", source: "thinking", mappings: THINKING_MAPPINGS }] },
      { assignments: [{ configId: "model", source: "model" }] },
      {
        assignments: [
          { configId: "thinking", source: "thinking", mappings: THINKING_MAPPINGS },
          { configId: "model", source: "model" },
        ],
      },
    ]) {
      expect(() =>
        createAcpAgentRuntimeSnapshot({
          ...validBinaryInput(),
          manifest: binaryManifest({ configuration }),
        }),
      ).toThrow(/^ACP agent runtime snapshot is invalid$/);
    }
  });

  it("rejects ambiguous or open-ended configuration assignments", () => {
    for (const configuration of [
      { private: true },
      {
        assignments: [
          { configId: "model", source: "model" },
          { configId: "model", source: "thinking", mappings: THINKING_MAPPINGS },
        ],
      },
      {
        assignments: [
          { configId: "model", source: "model" },
          {
            configId: "thinking",
            source: "thinking",
            mappings: [
              { thinking: "off", value: "same" },
              { thinking: "medium", value: "same" },
            ],
          },
        ],
      },
      {
        assignments: [
          { configId: "model", source: "model", category: "model" },
          { configId: "thinking", source: "thinking", mappings: THINKING_MAPPINGS },
        ],
      },
    ]) {
      expect(() =>
        createAcpAgentRuntimeSnapshot({
          ...validBinaryInput(),
          manifest: binaryManifest({ configuration }),
        }),
      ).toThrow(/^ACP agent runtime snapshot is invalid$/);
    }
  });

  it("binds one ACP runtime into the existing capability digest", () => {
    const acpAgent = createAcpAgentRuntimeSnapshot(validBinaryInput());
    const capability = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      acpAgent,
      digest: calculateCapabilitySnapshotDigest([], [], undefined, undefined, undefined, acpAgent),
    });

    expect(capability.acpAgent).toEqual(acpAgent);
    expect(capability.digest).not.toBe(calculateCapabilitySnapshotDigest([]));
  });

  it("combines an identical ACP runtime with packages and rejects conflicts", () => {
    const acpAgent = createAcpAgentRuntimeSnapshot(validBinaryInput());
    const acpCapability = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      acpAgent,
      digest: calculateCapabilitySnapshotDigest([], [], undefined, undefined, undefined, acpAgent),
    });
    const packageCapability = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: "testing",
        description: "Test code.",
        metadata: {},
        requestedTools: [],
        trust: "project-explicit",
        provenance: ".flow/skills/testing",
        files: [{ path: "SKILL.md", content: Buffer.from("# Testing\n") }],
      },
    ]);

    const combined = combineCapabilitySnapshots([packageCapability, acpCapability, acpCapability]);
    expect(combined?.acpAgent).toEqual(acpAgent);
    expect(combined?.packages).toHaveLength(1);

    const conflictingAgent = createAcpAgentRuntimeSnapshot(validNodePackageInput());
    const conflictingCapability = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      acpAgent: conflictingAgent,
      digest: calculateCapabilitySnapshotDigest(
        [],
        [],
        undefined,
        undefined,
        undefined,
        conflictingAgent,
      ),
    });
    expect(() => combineCapabilitySnapshots([acpCapability, conflictingCapability])).toThrow(
      /conflicting ACP agent selections/i,
    );
  });

  it.each([
    {
      label: "manifest/executable digest mismatch",
      mutate: (input: ReturnType<typeof validBinaryInput>) => ({
        ...input,
        launch: {
          ...input.launch,
          executable: { ...input.launch.executable, sha256: "e".repeat(64) },
        },
      }),
    },
    {
      label: "relative executable",
      mutate: (input: ReturnType<typeof validBinaryInput>) => ({
        ...input,
        manifest: binaryManifest({ executable: "bin/opencode" }),
      }),
    },
    {
      label: "unsupported ACP major",
      mutate: (input: ReturnType<typeof validBinaryInput>) => ({
        ...input,
        manifest: binaryManifest({ protocol: "acp-v2" }),
      }),
    },
    {
      label: "ambient containment",
      mutate: (input: ReturnType<typeof validBinaryInput>) => ({
        ...input,
        manifest: binaryManifest({ containmentProfile: "ambient" }),
      }),
    },
    {
      label: "credential value in place of a variable name",
      mutate: (input: ReturnType<typeof validBinaryInput>) => ({
        ...input,
        manifest: binaryManifest({ credentialEnv: "sk-secret-value" }),
      }),
    },
    {
      label: "unmapped provider authority",
      mutate: (input: ReturnType<typeof validBinaryInput>) => ({
        ...input,
        manifest: binaryManifest({ authorityProvider: "anthropic" }),
      }),
    },
    {
      label: "duplicate JSON key",
      mutate: (input: ReturnType<typeof validBinaryInput>) => ({
        ...input,
        manifest: Buffer.from(
          binaryManifest()
            .toString("utf8")
            .replace('"kind":"AcpAgent"', '"kind":"AcpAgent","kind":"Private"'),
        ),
      }),
    },
    {
      label: "unknown observed identity field",
      mutate: (input: ReturnType<typeof validBinaryInput>) => ({
        ...input,
        launch: { ...input.launch, privateAuthority: true },
      }),
    },
  ])("rejects unsafe binary identity input: $label", ({ mutate }) => {
    expect(() => createAcpAgentRuntimeSnapshot(mutate(validBinaryInput()))).toThrow(
      /^ACP agent runtime snapshot is invalid$/,
    );
  });

  it.each([
    {
      label: "Node executable mismatch",
      mutate: (input: ReturnType<typeof validNodePackageInput>) => ({
        ...input,
        launch: {
          ...input.launch,
          nodeExecutable: { ...input.launch.nodeExecutable, sha256: "e".repeat(64) },
        },
      }),
    },
    {
      label: "Node version mismatch",
      mutate: (input: ReturnType<typeof validNodePackageInput>) => ({
        ...input,
        launch: { ...input.launch, nodeVersion: "v27.0.0" },
      }),
    },
    {
      label: "package name mismatch",
      mutate: (input: ReturnType<typeof validNodePackageInput>) => ({
        ...input,
        launch: {
          ...input.launch,
          package: { ...input.launch.package, name: "private-agent" },
        },
      }),
    },
    {
      label: "package version mismatch",
      mutate: (input: ReturnType<typeof validNodePackageInput>) => ({
        ...input,
        launch: {
          ...input.launch,
          package: { ...input.launch.package, version: "9.9.9" },
        },
      }),
    },
    {
      label: "package closure mismatch",
      mutate: (input: ReturnType<typeof validNodePackageInput>) => ({
        ...input,
        launch: {
          ...input.launch,
          package: { ...input.launch.package, sha256: "e".repeat(64) },
        },
      }),
    },
    {
      label: "entrypoint mismatch",
      mutate: (input: ReturnType<typeof validNodePackageInput>) => ({
        ...input,
        launch: {
          ...input.launch,
          package: {
            ...input.launch.package,
            entrypoint: { ...input.launch.package.entrypoint, path: "dist/private.js" },
          },
        },
      }),
    },
  ])("rejects inconsistent Node package identity: $label", ({ mutate }) => {
    expect(() => createAcpAgentRuntimeSnapshot(mutate(validNodePackageInput()))).toThrow(
      /^ACP agent runtime snapshot is invalid$/,
    );
  });

  it("accepts exact size/count bounds and rejects plus one", () => {
    expect(() =>
      createAcpAgentRuntimeSnapshot({
        ...validBinaryInput(),
        manifest: manifestAtBytes(MAX_ACP_AGENT_MANIFEST_BYTES),
        launch: {
          ...validBinaryInput().launch,
          executable: {
            ...validBinaryInput().launch.executable,
            bytes: MAX_ACP_AGENT_EXECUTABLE_BYTES,
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      createAcpAgentRuntimeSnapshot({
        ...validBinaryInput(),
        manifest: manifestAtBytes(MAX_ACP_AGENT_MANIFEST_BYTES + 1),
      }),
    ).toThrow(/^ACP agent runtime snapshot is invalid$/);
    expect(() =>
      createAcpAgentRuntimeSnapshot({
        ...validBinaryInput(),
        launch: {
          ...validBinaryInput().launch,
          executable: {
            ...validBinaryInput().launch.executable,
            bytes: MAX_ACP_AGENT_EXECUTABLE_BYTES + 1,
          },
        },
      }),
    ).toThrow(/^ACP agent runtime snapshot is invalid$/);

    const exactMappings = Array.from({ length: MAX_ACP_AGENT_MODEL_MAPPINGS }, (_, index) => ({
      provider: "openai",
      model: `model-${index.toString().padStart(2, "0")}`,
      agentModel: `agent-${index.toString().padStart(2, "0")}`,
    }));
    expect(() =>
      createAcpAgentRuntimeSnapshot({
        ...validBinaryInput(),
        manifest: binaryManifest({ modelMappings: exactMappings }),
      }),
    ).not.toThrow();
    expect(() =>
      createAcpAgentRuntimeSnapshot({
        ...validBinaryInput(),
        manifest: binaryManifest({
          modelMappings: [
            ...exactMappings,
            { provider: "openai", model: "model-32", agentModel: "agent-32" },
          ],
        }),
      }),
    ).toThrow(/^ACP agent runtime snapshot is invalid$/);

    expect(() =>
      createAcpAgentRuntimeSnapshot({
        ...validNodePackageInput(),
        launch: {
          ...validNodePackageInput().launch,
          package: {
            ...validNodePackageInput().launch.package,
            bytes: MAX_ACP_AGENT_PACKAGE_BYTES,
            files: MAX_ACP_AGENT_PACKAGE_FILES,
          },
        },
      }),
    ).not.toThrow();
    for (const packageIdentity of [
      {
        ...validNodePackageInput().launch.package,
        bytes: MAX_ACP_AGENT_PACKAGE_BYTES + 1,
        files: MAX_ACP_AGENT_PACKAGE_FILES,
      },
      {
        ...validNodePackageInput().launch.package,
        bytes: MAX_ACP_AGENT_PACKAGE_BYTES,
        files: MAX_ACP_AGENT_PACKAGE_FILES + 1,
      },
    ]) {
      expect(() =>
        createAcpAgentRuntimeSnapshot({
          ...validNodePackageInput(),
          launch: { ...validNodePackageInput().launch, package: packageIdentity },
        }),
      ).toThrow(/^ACP agent runtime snapshot is invalid$/);
    }
  });

  it("binds exact argument count, per-argument bytes, and aggregate bytes", () => {
    const exactCount = Array.from({ length: MAX_ACP_AGENT_ARGS }, () => "");
    const exactAggregate = [
      ...Array.from({ length: 8 }, () => "x".repeat(MAX_ACP_AGENT_ARG_BYTES - 1)),
      "x".repeat(8),
    ];
    expect(Buffer.byteLength(exactAggregate.join(""), "utf8")).toBe(MAX_ACP_AGENT_ARGUMENT_BYTES);

    for (const args of [exactCount, ["x".repeat(MAX_ACP_AGENT_ARG_BYTES)], exactAggregate]) {
      expect(() =>
        createAcpAgentRuntimeSnapshot({
          ...validBinaryInput(),
          manifest: binaryManifest({ args }),
        }),
      ).not.toThrow();
    }
    for (const args of [
      [...exactCount, ""],
      ["x".repeat(MAX_ACP_AGENT_ARG_BYTES + 1)],
      [...exactAggregate.slice(0, -1), "x".repeat(9)],
    ]) {
      expect(() =>
        createAcpAgentRuntimeSnapshot({
          ...validBinaryInput(),
          manifest: binaryManifest({ args }),
        }),
      ).toThrow(/^ACP agent runtime snapshot is invalid$/);
    }
  });

  it("rejects snapshot substitution even when the attacker recalculates its digest", () => {
    const snapshot = createAcpAgentRuntimeSnapshot(validBinaryInput());
    const substituted = {
      ...snapshot,
      providerAuthorities: [
        {
          provider: "openai",
          domain: "private.example.com",
          credentialEnv: "OPENAI_API_KEY",
        },
      ],
    };

    expect(() =>
      validateAcpAgentRuntimeSnapshot({
        ...substituted,
        digest: calculateAcpAgentRuntimeSnapshotDigest(substituted),
      }),
    ).toThrow(/^ACP agent runtime snapshot is invalid$/);
  });

  it("returns one bounded diagnostic without rejected values", () => {
    const secret = "sk-do-not-disclose";

    try {
      createAcpAgentRuntimeSnapshot({
        ...validBinaryInput(),
        manifest: binaryManifest({ credentialEnv: secret }),
      });
      throw new Error("expected invalid manifest");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("ACP agent runtime snapshot is invalid");
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message.length).toBeLessThanOrEqual(64);
    }
  });
});

function validBinaryInput() {
  return {
    provenance: ".flow/acp-agents/opencode.json",
    manifest: binaryManifest(),
    launch: {
      kind: "binary" as const,
      executable: {
        path: "/opt/flow/acp/opencode",
        sha256: "a".repeat(64),
        bytes: 123_456,
        device: "16777234",
        inode: "9071",
      },
    },
  };
}

function validNodePackageInput() {
  return {
    provenance: ".flow/acp-agents/codex-acp.json",
    manifest: nodePackageManifest(),
    launch: {
      kind: "node-package" as const,
      nodeExecutable: {
        path: "/opt/flow/node/bin/node",
        sha256: "b".repeat(64),
        bytes: 98_765,
        device: "16777234",
        inode: "9072",
      },
      nodeVersion: "v26.7.0",
      package: {
        root: "/opt/flow/acp/codex-acp",
        resolutionRoot: "/opt/flow/acp",
        name: "@zed-industries/codex-acp",
        version: "1.6.2",
        sha256: "c".repeat(64),
        bytes: 345_678,
        files: 42,
        device: "16777234",
        inode: "9073",
        entrypoint: {
          path: "dist/cli.js",
          sha256: "d".repeat(64),
          bytes: 4_096,
          device: "16777234",
          inode: "9074",
        },
      },
    },
  };
}

function binaryManifest(
  overrides: {
    executable?: string;
    protocol?: string;
    containmentProfile?: string;
    credentialEnv?: string;
    authorityProvider?: string;
    args?: readonly string[];
    modelMappings?: readonly {
      readonly provider: string;
      readonly model: string;
      readonly agentModel: string;
    }[];
    configuration?: unknown;
  } = {},
): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "AcpAgent",
      metadata: { name: "opencode" },
      spec: {
        protocol: overrides.protocol ?? "acp-v1",
        compatibilityProfile: "prompt-only-v1",
        launch: {
          kind: "binary",
          executable: overrides.executable ?? "/opt/flow/acp/opencode",
          executableSha256: "a".repeat(64),
          args: overrides.args ?? ["--stdio"],
        },
        modelMappings: overrides.modelMappings ?? [
          { provider: "openai", model: "gpt-5.6-codex", agentModel: "gpt-5.6-codex" },
        ],
        providerAuthorities: [
          {
            provider: overrides.authorityProvider ?? "openai",
            domain: "api.openai.com",
            credentialEnv: overrides.credentialEnv ?? "OPENAI_API_KEY",
          },
        ],
        containmentProfile: overrides.containmentProfile ?? "acp-prompt-only-v1",
        usage: { modelTokens: "complete", costUsd: "unavailable" },
        ...(overrides.configuration === null
          ? {}
          : { configuration: overrides.configuration ?? validConfiguration() }),
      },
    }),
  );
}

function nodePackageManifest(): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "AcpAgent",
      metadata: { name: "codex-acp" },
      spec: {
        protocol: "acp-v1",
        compatibilityProfile: "prompt-only-v1",
        launch: {
          kind: "node-package",
          nodeExecutable: "/opt/flow/node/bin/node",
          nodeExecutableSha256: "b".repeat(64),
          nodeVersion: "v26.7.0",
          packageRoot: "/opt/flow/acp/codex-acp",
          packageResolutionRoot: "/opt/flow/acp",
          packageName: "@zed-industries/codex-acp",
          packageVersion: "1.6.2",
          packageSha256: "c".repeat(64),
          packageEntrypoint: "dist/cli.js",
          args: ["--stdio"],
        },
        modelMappings: [
          { provider: "openai", model: "gpt-5.6-codex", agentModel: "gpt-5.6-codex" },
        ],
        providerAuthorities: [
          {
            provider: "openai",
            domain: "api.openai.com",
            credentialEnv: "OPENAI_API_KEY",
          },
        ],
        containmentProfile: "acp-prompt-only-v1",
        usage: { modelTokens: "unavailable", costUsd: "unavailable" },
        configuration: validConfiguration(),
      },
    }),
  );
}

function manifestAtBytes(targetBytes: number): Buffer {
  const manifest = binaryManifest();
  const result = Buffer.concat([manifest, Buffer.alloc(targetBytes - manifest.byteLength, 0x20)]);
  if (result.byteLength !== targetBytes) {
    throw new Error("cannot construct exact ACP agent manifest boundary");
  }
  return result;
}

const THINKING_MAPPINGS = [
  { thinking: "off", value: "off" },
  { thinking: "medium", value: "medium" },
  { thinking: "high", value: "high" },
] as const;

function validConfiguration() {
  return {
    assignments: [
      { configId: "mode", source: "literal", value: "ask" },
      { configId: "model", source: "model" },
      { configId: "thinking", source: "thinking", mappings: THINKING_MAPPINGS },
    ],
  };
}
