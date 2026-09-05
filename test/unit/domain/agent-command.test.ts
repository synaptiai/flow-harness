import { describe, expect, it } from "vitest";

import {
  agentCommandAuthoritySchema,
  calculateAgentCommandDigest,
  MAX_AGENT_COMMAND_CATALOG_BYTES,
  normalizeAgentCommandAuthority,
  normalizeAgentCommandRequest,
} from "../../../src/domain/agent-command.js";
import { createFrozenVerificationAgentCommandAuthority } from "../../../src/application/frozen-issue-command.js";

describe("discoverable frozen command authority", () => {
  const first = normalizeAgentCommandRequest({
    executable: "python3",
    args: ["-m", "pytest"],
    timeoutMs: 300_000,
  });
  const second = normalizeAgentCommandRequest({
    executable: "ruff",
    args: ["check", "."],
    timeoutMs: 60_000,
  });
  const commands = [first, second].sort((left, right) =>
    calculateAgentCommandDigest(left).localeCompare(calculateAgentCommandDigest(right)),
  );
  const digests = commands.map(calculateAgentCommandDigest);

  it("retains an unchanged legacy authority without a catalog", () => {
    const authority = normalizeAgentCommandAuthority([...digests].reverse());
    expect(JSON.stringify(authority)).toBe(
      JSON.stringify({ version: 1, kind: "frozen-verification", requestDigests: digests }),
    );
    expect(agentCommandAuthoritySchema.parse(authority)).toEqual(authority);
  });

  it("derives a complete canonical immutable catalog from frozen verification commands", () => {
    const args = ["-m", "pytest"];
    const authority = createFrozenVerificationAgentCommandAuthority([
      { ...first, args },
      second,
      first,
    ]);
    expect(authority).toEqual({
      version: 1,
      kind: "frozen-verification",
      requestDigests: digests,
      requests: commands,
    });
    args.push("--help");
    const parsed = agentCommandAuthoritySchema.parse(authority);
    expect(parsed).toEqual(authority);
    expect(Object.isFrozen(authority.requests)).toBe(true);
    for (const request of authority.requests ?? []) {
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.args)).toBe(true);
    }
  });

  it("rejects duplicate input catalog entries instead of silently discarding them", () => {
    expect(() => normalizeAgentCommandAuthority(digests, [...commands, first])).toThrow(/catalog/i);
  });

  it.each([
    ["missing command", [commands[0]]],
    [
      "extra command",
      [...commands, normalizeAgentCommandRequest({ executable: "node", args: [] })],
    ],
    ["duplicate command", [commands[0], commands[0]]],
    ["noncanonical order", [...commands].reverse()],
    [
      "changed timeout",
      commands.map((command) => ({ ...command, timeoutMs: command.timeoutMs + 1 })),
    ],
    ["extra command field", commands.map((command) => ({ ...command, shell: true }))],
  ])("rejects a catalog with %s", (_label, requests) => {
    expect(() =>
      agentCommandAuthoritySchema.parse({
        version: 1,
        kind: "frozen-verification",
        requestDigests: digests,
        requests,
      }),
    ).toThrow();
  });

  it("rejects catalogs above the serialized byte ceiling before execution", () => {
    const commands = [0, 1, 2].map((index) =>
      normalizeAgentCommandRequest({
        executable: "node",
        args: [String(index), ...Array(4).fill("x".repeat(8_000))],
      }),
    );
    expect(() => createFrozenVerificationAgentCommandAuthority(commands)).toThrow(
      /catalog.*65536.*bytes/i,
    );
  });

  it("accepts the exact serialized catalog byte boundary and rejects one byte more", () => {
    const commands = [0, 1].map((index) =>
      normalizeAgentCommandRequest({
        executable: `node${index}`,
        args: Array(4).fill("x".repeat(8_192)),
      }),
    );
    const overflow =
      Buffer.byteLength(JSON.stringify(commands), "utf8") - MAX_AGENT_COMMAND_CATALOG_BYTES;
    const second = commands[1];
    if (second === undefined || overflow <= 0) throw new Error("boundary setup invalid");
    commands[1] = normalizeAgentCommandRequest({
      ...second,
      args: second.args.map((argument, index) =>
        index === 3 ? argument.slice(overflow) : argument,
      ),
    });
    const exact = createFrozenVerificationAgentCommandAuthority(commands);
    expect(Buffer.byteLength(JSON.stringify(exact.requests), "utf8")).toBe(
      MAX_AGENT_COMMAND_CATALOG_BYTES,
    );
    const last = commands[1];
    commands[1] = normalizeAgentCommandRequest({
      ...last,
      args: last.args.map((argument, index) => (index === 3 ? `${argument}x` : argument)),
    });
    expect(() => createFrozenVerificationAgentCommandAuthority(commands)).toThrow(
      /catalog.*65536.*bytes/i,
    );
  });

  it("bounds JSON escape expansion rather than only raw argument bytes", () => {
    const command = normalizeAgentCommandRequest({
      executable: "node",
      args: Array(4).fill("\u0001".repeat(8_192)),
    });
    expect(command.args.reduce((bytes, argument) => bytes + Buffer.byteLength(argument), 0)).toBe(
      32_768,
    );
    expect(() => createFrozenVerificationAgentCommandAuthority([command])).toThrow(
      /catalog.*65536.*bytes/i,
    );
  });

  it("rejects tool-package provenance in a public frozen command catalog", () => {
    const command = normalizeAgentCommandRequest({
      executable: "node",
      args: [],
      source: {
        kind: "tool-package",
        name: "test-tool",
        version: "1.0.0",
        digest: "a".repeat(64),
        toolName: "test_command",
        input: {},
        inputDigest: "b".repeat(64),
      },
    });
    expect(() =>
      normalizeAgentCommandAuthority([calculateAgentCommandDigest(command)], [command]),
    ).toThrow();
  });

  it("binds an optional explicit refusal limit only to a discoverable authority", () => {
    expect(
      agentCommandAuthoritySchema.parse({
        version: 1,
        kind: "frozen-verification",
        requestDigests: digests,
        requests: commands,
        rejectionLimit: 3,
      }),
    ).toMatchObject({ rejectionLimit: 3 });
    expect(() =>
      agentCommandAuthoritySchema.parse({
        version: 1,
        kind: "frozen-verification",
        requestDigests: digests,
        rejectionLimit: 3,
      }),
    ).toThrow(/catalog/i);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid refusal limit %s",
    (rejectionLimit) => {
      expect(() =>
        agentCommandAuthoritySchema.parse({
          version: 1,
          kind: "frozen-verification",
          requestDigests: digests,
          requests: commands,
          rejectionLimit,
        }),
      ).toThrow();
    },
  );
});

describe("agent command contract", () => {
  it("normalizes, freezes, and digest-binds an argv-only request", () => {
    const command = normalizeAgentCommandRequest({
      executable: "npm",
      args: ["test", "--", "test/unit/example.test.ts"],
    });

    expect(command).toEqual({
      version: 1,
      executable: "npm",
      args: ["test", "--", "test/unit/example.test.ts"],
      timeoutMs: 120_000,
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.args)).toBe(true);
    expect(calculateAgentCommandDigest(command)).toBe(
      "ae08971fe36f9b9b78b0b484f5fbe322f4efbf6a088d4e922597f3a6f3e3e436",
    );
    expect(
      calculateAgentCommandDigest(
        normalizeAgentCommandRequest({ executable: "npm", args: ["test", "--", "other"] }),
      ),
    ).not.toBe(calculateAgentCommandDigest(command));
  });

  it("normalizes and digest-binds immutable tool-package source provenance", () => {
    const command = normalizeAgentCommandRequest({
      executable: "reporter",
      args: ["src", "12", "false"],
      timeoutMs: 10_000,
      source: {
        kind: "tool-package",
        name: "project-report",
        version: "1.2.3",
        digest: "a".repeat(64),
        toolName: "project_report",
        input: { verbose: false, limit: 12, path: "src" },
        inputDigest: "b".repeat(64),
      },
    });

    expect(command.source).toEqual({
      kind: "tool-package",
      name: "project-report",
      version: "1.2.3",
      digest: "a".repeat(64),
      toolName: "project_report",
      input: { limit: 12, path: "src", verbose: false },
      inputDigest: "b".repeat(64),
    });
    expect(Object.isFrozen(command.source)).toBe(true);
    expect(Object.isFrozen(command.source?.input)).toBe(true);
    expect(calculateAgentCommandDigest(command)).not.toBe(
      calculateAgentCommandDigest(
        normalizeAgentCommandRequest({
          executable: "reporter",
          args: ["src", "12", "false"],
          timeoutMs: 10_000,
        }),
      ),
    );

    const changedInput = normalizeAgentCommandRequest({
      ...command,
      source: { ...command.source, input: { limit: 13, path: "src", verbose: false } },
    });
    expect(calculateAgentCommandDigest(changedInput)).not.toBe(
      calculateAgentCommandDigest(command),
    );
  });

  it("calculates one source digest regardless of durable input key insertion order", () => {
    const source = {
      kind: "tool-package" as const,
      name: "project-report",
      version: "1.2.3",
      digest: "a".repeat(64),
      toolName: "project_report",
      inputDigest: "b".repeat(64),
    };
    const first = {
      version: 1 as const,
      executable: "/usr/bin/printf",
      args: ["src", "12"],
      timeoutMs: 10_000,
      source: { ...source, input: { path: "src", limit: 12 } },
    };
    const reordered = {
      ...first,
      source: { ...source, input: { limit: 12, path: "src" } },
    };

    expect(calculateAgentCommandDigest(first)).toBe(calculateAgentCommandDigest(reordered));
  });

  it.each([
    { label: "unknown source kind", mutate: { kind: "plugin" } },
    { label: "invalid package name", mutate: { name: "ProjectReport" } },
    { label: "mutable package version", mutate: { version: "latest" } },
    { label: "invalid package digest", mutate: { digest: "short" } },
    { label: "reserved model tool name", mutate: { toolName: "flow_exec" } },
    { label: "invalid input digest", mutate: { inputDigest: "short" } },
    { label: "nested input", mutate: { input: { path: { nested: true } } } },
  ])("rejects $label provenance", ({ mutate }) => {
    expect(() =>
      normalizeAgentCommandRequest({
        executable: "reporter",
        args: ["src"],
        source: {
          kind: "tool-package",
          name: "project-report",
          version: "1.2.3",
          digest: "a".repeat(64),
          toolName: "project_report",
          input: { path: "src" },
          inputDigest: "b".repeat(64),
          ...mutate,
        },
      }),
    ).toThrow();
  });

  it.each([
    ["empty executable", { executable: "", args: [] }],
    ["NUL executable", { executable: "node\0sh", args: [] }],
    ["oversized executable", { executable: "x".repeat(1_025), args: [] }],
    ["too many arguments", { executable: "node", args: Array(65).fill("x") }],
    ["oversized argument", { executable: "node", args: ["x".repeat(8_193)] }],
    ["NUL argument", { executable: "node", args: ["x\0y"] }],
    ["oversized argument vector", { executable: "node", args: Array(5).fill("x".repeat(7_000)) }],
    ["zero timeout", { executable: "node", args: [], timeoutMs: 0 }],
    ["excessive timeout", { executable: "node", args: [], timeoutMs: 600_001 }],
    ["fractional timeout", { executable: "node", args: [], timeoutMs: 1.5 }],
    ["unknown field", { executable: "node", args: [], shell: true }],
  ])("rejects a %s", (_label, input) => {
    expect(() => normalizeAgentCommandRequest(input)).toThrow();
  });

  it("does not retain mutable caller input", () => {
    const args = ["--version"];
    const command = normalizeAgentCommandRequest({ executable: "node", args });

    args[0] = "--help";

    expect(command.args).toEqual(["--version"]);
  });

  it("accepts every exact public input boundary", () => {
    const command = normalizeAgentCommandRequest({
      executable: "é".repeat(512),
      args: Array(64).fill("🙂".repeat(128)),
      timeoutMs: 600_000,
    });

    expect(Buffer.byteLength(command.executable, "utf8")).toBe(1_024);
    expect(command.args).toHaveLength(64);
    expect(
      command.args.reduce((total, argument) => total + Buffer.byteLength(argument, "utf8"), 0),
    ).toBe(32_768);
    expect(command.timeoutMs).toBe(600_000);
  });
});
