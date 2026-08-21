import { describe, expect, it } from "vitest";

import {
  calculateCapabilitySnapshotDigest,
  combineCapabilitySnapshots,
  createCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  createLanguageServerSnapshot,
  MAX_LANGUAGE_SERVER_ARG_BYTES,
  MAX_LANGUAGE_SERVER_ARGS,
  MAX_LANGUAGE_SERVER_ARGUMENT_BYTES,
  MAX_LANGUAGE_SERVER_EXECUTABLE_BYTES,
  MAX_LANGUAGE_SERVER_LANGUAGES,
  MAX_LANGUAGE_SERVER_MANIFEST_BYTES,
  MAX_LANGUAGE_SERVER_REQUEST_TIMEOUT_MS,
  MAX_LANGUAGE_SERVER_SUFFIXES,
  validateLanguageServerSnapshot,
} from "../../../src/domain/capability/language-server.js";

describe("language-server capability", () => {
  it("creates an immutable identity from exact manifest bytes and executable evidence", () => {
    const snapshot = createLanguageServerSnapshot(validInput());

    expect(snapshot).toMatchObject({
      version: 1,
      kind: "language-server",
      name: "typescript",
      protocol: "lsp-3.18",
      executable: {
        path: "/opt/flow/bin/typescript-language-server",
        sha256: "a".repeat(64),
        bytes: 123_456,
        device: "16777234",
        inode: "9071",
      },
      args: ["--stdio"],
      languages: [{ id: "typescript", suffixes: [".ts", ".tsx"] }],
      initializationOptions: { preferences: { includeCompletionsForModuleExports: false } },
      containmentProfile: "default",
      requestTimeoutMs: 5_000,
      manifest: {
        provenance: ".flow/language-servers/typescript.json",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bytes: expect.any(Number),
        contentBase64: expect.any(String),
      },
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(validateLanguageServerSnapshot(structuredClone(snapshot))).toEqual(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.languages)).toBe(true);
  });

  it("binds the language server into the existing capability digest", () => {
    const languageServer = createLanguageServerSnapshot(validInput());
    const capability = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      languageServer,
      digest: calculateCapabilitySnapshotDigest([], [], undefined, languageServer),
    });

    expect(capability.languageServer).toEqual(languageServer);
    expect(capability.digest).not.toBe(calculateCapabilitySnapshotDigest([]));
  });

  it("combines one language server with package capabilities without losing identity", () => {
    const languageServer = createLanguageServerSnapshot(validInput());
    const semanticCapability = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      languageServer,
      digest: calculateCapabilitySnapshotDigest([], [], undefined, languageServer),
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

    const combined = combineCapabilitySnapshots([packageCapability, semanticCapability]);

    expect(combined?.languageServer).toEqual(languageServer);
    expect(combined?.packages).toHaveLength(1);
  });

  it.each([
    {
      label: "manifest/executable digest mismatch",
      mutate: (input: ReturnType<typeof validInput>) => ({
        ...input,
        executable: { ...input.executable, sha256: "b".repeat(64) },
      }),
    },
    {
      label: "relative executable",
      mutate: (input: ReturnType<typeof validInput>) => ({
        ...input,
        manifest: manifest({ executable: "bin/typescript-language-server" }),
      }),
    },
    {
      label: "unsorted suffixes",
      mutate: (input: ReturnType<typeof validInput>) => ({
        ...input,
        manifest: manifest({ suffixes: [".tsx", ".ts"] }),
      }),
    },
    {
      label: "ambient containment",
      mutate: (input: ReturnType<typeof validInput>) => ({
        ...input,
        manifest: manifest({ containmentProfile: "ambient" }),
      }),
    },
    {
      label: "unsupported protocol",
      mutate: (input: ReturnType<typeof validInput>) => ({
        ...input,
        manifest: manifest({ protocol: "lsp-3.17" }),
      }),
    },
    {
      label: "duplicate JSON key",
      mutate: (input: ReturnType<typeof validInput>) => ({
        ...input,
        manifest: Buffer.from(
          manifest()
            .toString("utf8")
            .replace('"kind":"LanguageServer"', '"kind":"LanguageServer","kind":"PRIVATE"'),
        ),
      }),
    },
  ])("rejects unsafe identity input: $label", ({ mutate }) => {
    expect(() => createLanguageServerSnapshot(mutate(validInput()))).toThrow(
      /language server snapshot is invalid/i,
    );
  });

  it("accepts an exact-size manifest and rejects a valid plus-one manifest", () => {
    expect(() =>
      createLanguageServerSnapshot({
        ...validInput(),
        manifest: manifestAtBytes(MAX_LANGUAGE_SERVER_MANIFEST_BYTES),
      }),
    ).not.toThrow();
    expect(() =>
      createLanguageServerSnapshot({
        ...validInput(),
        manifest: manifestAtBytes(MAX_LANGUAGE_SERVER_MANIFEST_BYTES + 1),
      }),
    ).toThrow(/language server snapshot is invalid/i);
  });

  it("binds exact executable and timeout bounds", () => {
    expect(() =>
      createLanguageServerSnapshot({
        ...validInput(),
        executable: { ...validInput().executable, bytes: MAX_LANGUAGE_SERVER_EXECUTABLE_BYTES },
        manifest: manifest({ requestTimeoutMs: MAX_LANGUAGE_SERVER_REQUEST_TIMEOUT_MS }),
      }),
    ).not.toThrow();
    expect(() =>
      createLanguageServerSnapshot({
        ...validInput(),
        executable: {
          ...validInput().executable,
          bytes: MAX_LANGUAGE_SERVER_EXECUTABLE_BYTES + 1,
        },
      }),
    ).toThrow(/language server snapshot is invalid/i);
    expect(() =>
      createLanguageServerSnapshot({
        ...validInput(),
        manifest: manifest({ requestTimeoutMs: MAX_LANGUAGE_SERVER_REQUEST_TIMEOUT_MS + 1 }),
      }),
    ).toThrow(/language server snapshot is invalid/i);
  });

  it("binds exact argument count, per-argument bytes, and aggregate bytes", () => {
    const exactCount = Array.from({ length: MAX_LANGUAGE_SERVER_ARGS }, () => "");
    const exactAggregate = [
      ...Array.from({ length: 8 }, () => "x".repeat(MAX_LANGUAGE_SERVER_ARG_BYTES - 1)),
      "x".repeat(8),
    ];
    expect(Buffer.byteLength(exactAggregate.join(""), "utf8")).toBe(
      MAX_LANGUAGE_SERVER_ARGUMENT_BYTES,
    );

    for (const args of [exactCount, ["x".repeat(MAX_LANGUAGE_SERVER_ARG_BYTES)], exactAggregate]) {
      expect(() =>
        createLanguageServerSnapshot({ ...validInput(), manifest: manifest({ args }) }),
      ).not.toThrow();
    }
    for (const args of [
      [...exactCount, ""],
      ["x".repeat(MAX_LANGUAGE_SERVER_ARG_BYTES + 1)],
      [...exactAggregate.slice(0, -1), "x".repeat(9)],
    ]) {
      expect(() =>
        createLanguageServerSnapshot({ ...validInput(), manifest: manifest({ args }) }),
      ).toThrow(/language server snapshot is invalid/i);
    }
  });

  it("binds exact language and suffix counts", () => {
    const exactLanguages = Array.from({ length: MAX_LANGUAGE_SERVER_LANGUAGES }, (_, index) => ({
      id: `language-${index.toString().padStart(2, "0")}`,
      suffixes: [`.s${index.toString().padStart(2, "0")}`],
    }));
    const exactSuffixes = Array.from(
      { length: MAX_LANGUAGE_SERVER_SUFFIXES },
      (_, index) => `.s${index.toString().padStart(2, "0")}`,
    );
    expect(() =>
      createLanguageServerSnapshot({
        ...validInput(),
        manifest: manifest({ languages: exactLanguages }),
      }),
    ).not.toThrow();
    expect(() =>
      createLanguageServerSnapshot({
        ...validInput(),
        manifest: manifest({
          languages: [...exactLanguages, { id: "language-16", suffixes: [".s16"] }],
        }),
      }),
    ).toThrow(/language server snapshot is invalid/i);
    expect(() =>
      createLanguageServerSnapshot({
        ...validInput(),
        manifest: manifest({ suffixes: exactSuffixes }),
      }),
    ).not.toThrow();
    expect(() =>
      createLanguageServerSnapshot({
        ...validInput(),
        manifest: manifest({ suffixes: [...exactSuffixes, ".s32"] }),
      }),
    ).toThrow(/language server snapshot is invalid/i);
  });

  it("rejects a digest-valid top-level capability after language-server substitution", () => {
    const languageServer = createLanguageServerSnapshot(validInput());
    const capability = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      languageServer,
      digest: calculateCapabilitySnapshotDigest([], [], undefined, languageServer),
    });
    const substituted = {
      ...languageServer,
      executable: { ...languageServer.executable, path: "/opt/flow/bin/private-server" },
    };

    expect(() =>
      validateCapabilitySnapshot({
        ...capability,
        languageServer: substituted,
        digest: calculateCapabilitySnapshotDigest([], [], undefined, substituted),
      }),
    ).toThrow(/language server snapshot is invalid/i);
  });
});

function validInput() {
  return {
    provenance: ".flow/language-servers/typescript.json",
    manifest: manifest(),
    executable: {
      path: "/opt/flow/bin/typescript-language-server",
      sha256: "a".repeat(64),
      bytes: 123_456,
      device: "16777234",
      inode: "9071",
    },
  };
}

function manifest(
  overrides: {
    executable?: string;
    suffixes?: readonly string[];
    args?: readonly string[];
    languages?: readonly { readonly id: string; readonly suffixes: readonly string[] }[];
    initializationOptions?: unknown;
    containmentProfile?: string;
    protocol?: string;
    requestTimeoutMs?: number;
  } = {},
): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "LanguageServer",
      metadata: { name: "typescript" },
      spec: {
        protocol: overrides.protocol ?? "lsp-3.18",
        executable: overrides.executable ?? "/opt/flow/bin/typescript-language-server",
        executableSha256: "a".repeat(64),
        args: overrides.args ?? ["--stdio"],
        languages: overrides.languages ?? [
          { id: "typescript", suffixes: overrides.suffixes ?? [".ts", ".tsx"] },
        ],
        initializationOptions: overrides.initializationOptions ?? {
          preferences: { includeCompletionsForModuleExports: false },
        },
        containmentProfile: overrides.containmentProfile ?? "default",
        requestTimeoutMs: overrides.requestTimeoutMs ?? 5_000,
      },
    }),
  );
}

function manifestAtBytes(targetBytes: number): Buffer {
  const empty = manifest({ initializationOptions: { padding: "" } });
  const result = manifest({
    initializationOptions: { padding: "x".repeat(targetBytes - empty.byteLength) },
  });
  if (result.byteLength !== targetBytes) {
    throw new Error("cannot construct exact language-server manifest boundary");
  }
  return result;
}
