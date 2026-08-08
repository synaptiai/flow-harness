import { describe, expect, it } from "vitest";

import {
  calculateAgentCommandDigest,
  normalizeAgentCommandRequest,
} from "../../../src/domain/agent-command.js";

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
