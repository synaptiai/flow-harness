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
    expect(calculateAgentCommandDigest(command)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      calculateAgentCommandDigest(
        normalizeAgentCommandRequest({ executable: "npm", args: ["test", "--", "other"] }),
      ),
    ).not.toBe(calculateAgentCommandDigest(command));
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
});
